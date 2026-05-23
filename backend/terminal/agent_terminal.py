"""HTTP 驱动的终端池。

与 WebSocket 终端不同，这里的终端由外部 agent 通过 HTTP 创建和操作，
后台读循环独立运行并累积输出，供快照查询。
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import logging
import re
import shlex
import threading
import time
import uuid
from datetime import datetime
from typing import AsyncIterator, Optional

from backend.terminal.pty_manager import PtyManager

logger = logging.getLogger("agent_terminal")

# 与 ws_handler 中一致的 ANSI 转义清理规则
_ANSI_RE = re.compile(
    r"\x1b\[[\?0-9;]*[A-Za-z]"
    r"|\x1b\].*?(?:\x07|\x1b\\)"
    r"|\x1b[()][AB012]"
    r"|\x1b[78]"
    r"|\x1b[=>]"
)

# 单个终端保留的原始输出上限
_MAX_RAW = 256 * 1024

# 默认终端 TTL（秒）。超过此时长无活动则被回收。
DEFAULT_TTL_SECONDS = 1800

# Janitor 扫描间隔
_JANITOR_INTERVAL = 60.0

# 命名控制键 → 实际字节序列。
KEY_MAP: dict[str, str] = {
    "ctrl+a": "\x01", "ctrl+b": "\x02", "ctrl+c": "\x03", "ctrl+d": "\x04",
    "ctrl+e": "\x05", "ctrl+f": "\x06", "ctrl+g": "\x07",
    "ctrl+h": "\x08", "backspace": "\x7f",
    "ctrl+i": "\x09", "tab": "\x09",
    "ctrl+j": "\x0a", "ctrl+k": "\x0b", "ctrl+l": "\x0c",
    "ctrl+m": "\x0d", "enter": "\x0d", "return": "\x0d",
    "ctrl+n": "\x0e", "ctrl+o": "\x0f", "ctrl+p": "\x10",
    "ctrl+q": "\x11", "ctrl+r": "\x12", "ctrl+s": "\x13",
    "ctrl+t": "\x14", "ctrl+u": "\x15", "ctrl+v": "\x16",
    "ctrl+w": "\x17", "ctrl+x": "\x18", "ctrl+y": "\x19",
    "ctrl+z": "\x1a",
    "esc": "\x1b", "escape": "\x1b",
    "ctrl+\\": "\x1c", "ctrl+]": "\x1d", "ctrl+^": "\x1e", "ctrl+_": "\x1f",
    "space": " ", "del": "\x7f",
    "up": "\x1b[A", "down": "\x1b[B", "right": "\x1b[C", "left": "\x1b[D",
    "home": "\x1b[H", "end": "\x1b[F",
    "pageup": "\x1b[5~", "pagedown": "\x1b[6~",
    "insert": "\x1b[2~", "delete": "\x1b[3~",
    "f1": "\x1bOP", "f2": "\x1bOQ", "f3": "\x1bOR", "f4": "\x1bOS",
    "f5": "\x1b[15~", "f6": "\x1b[17~", "f7": "\x1b[18~", "f8": "\x1b[19~",
    "f9": "\x1b[20~", "f10": "\x1b[21~", "f11": "\x1b[23~", "f12": "\x1b[24~",
}


class UnknownKeyError(ValueError):
    """请求里出现 KEY_MAP 不认识的命名键。"""


def resolve_keys(keys: list[str]) -> str:
    """把命名键数组翻译成实际控制字节序列。"""
    out: list[str] = []
    for raw in keys:
        if not raw:
            continue
        norm = raw.strip().lower().replace(" ", "")
        seq = KEY_MAP.get(norm)
        if seq is None:
            raise UnknownKeyError(f"未知命名键: {raw!r}（支持列表见 KEY_MAP）")
        out.append(seq)
    return "".join(out)


def strip_ansi(text: str) -> str:
    """去除 ANSI 转义序列，并把 \\r\\n / \\r 归一为 \\n。"""
    text = _ANSI_RE.sub("", text)
    return text.replace("\r\n", "\n").replace("\r", "\n")


def _strip_command_echo(output: str, command: str) -> str:
    """从 PTY 输出里剥离命令回显行。"""
    if not command:
        return output
    first_line = command.splitlines()[0].strip()
    if not first_line:
        return output
    lines = output.split("\n")
    for i, line in enumerate(lines):
        if first_line in line:
            return "\n".join(lines[i + 1:])
    return output


def _grep_lines(text: str, pattern: str, context: int = 0, case_insensitive: bool = False) -> dict:
    """对文本做行级 grep，可选返回上下文。"""
    flags = re.IGNORECASE if case_insensitive else 0
    try:
        regex = re.compile(pattern, flags)
    except re.error as exc:
        raise ValueError(f"非法正则: {exc}") from exc

    lines = text.split("\n")
    matches: list[dict] = []
    matched_idx: set[int] = set()
    for i, line in enumerate(lines):
        if regex.search(line):
            matched_idx.add(i)

    if not matched_idx:
        return {"matches": [], "match_count": 0, "total_lines": len(lines)}

    if context <= 0:
        for i in sorted(matched_idx):
            matches.append({"line_no": i + 1, "line": lines[i]})
    else:
        # 合并重叠的上下文区间，输出连续片段
        wanted: set[int] = set()
        for i in matched_idx:
            for j in range(max(0, i - context), min(len(lines), i + context + 1)):
                wanted.add(j)
        for i in sorted(wanted):
            matches.append({
                "line_no": i + 1,
                "line": lines[i],
                "match": i in matched_idx,
            })

    return {
        "matches": matches,
        "match_count": len(matched_idx),
        "total_lines": len(lines),
    }


class AgentTerminal:
    """单个 HTTP 终端：封装 PtyManager + 输出累积 + 活动跟踪。"""

    def __init__(
        self,
        terminal_type: str,
        connection_id: Optional[str],
        cols: int,
        rows: int,
        title: str = "",
        name: str = "",
        ttl_seconds: float = DEFAULT_TTL_SECONDS,
    ) -> None:
        self.id = uuid.uuid4().hex[:12]
        self.type = terminal_type
        self.connection_id = connection_id
        self.title = title
        self.name = name
        self.host: Optional[str] = None
        self.port: Optional[int] = None
        self.username: Optional[str] = None
        self.cols = cols
        self.rows = rows
        self.created_at = datetime.now()
        self.ttl_seconds = ttl_seconds
        self.pty = PtyManager()
        self._raw = bytearray()
        self._total = 0
        self._lock = threading.Lock()
        self._read_task: Optional[asyncio.Task] = None
        # 通过 exec() 解析 sentinel 时更新；info() / exec 响应里返回。
        self.cwd: Optional[str] = None
        self._last_activity = time.monotonic()
        # SSE 订阅唤醒
        self._wake_event: Optional[asyncio.Event] = None

    # ------------------------------------------------------------------
    # 内部
    # ------------------------------------------------------------------

    def _on_output(self, data: bytes) -> None:
        with self._lock:
            self._raw.extend(data)
            self._total += len(data)
            if len(self._raw) > _MAX_RAW:
                del self._raw[: len(self._raw) - _MAX_RAW]
        # 通知 SSE 订阅者
        ev = self._wake_event
        if ev is not None:
            try:
                loop = ev._loop  # type: ignore[attr-defined]
                loop.call_soon_threadsafe(ev.set)
            except Exception:
                pass

    def _touch(self) -> None:
        self._last_activity = time.monotonic()

    def idle_seconds(self) -> float:
        return time.monotonic() - self._last_activity

    # ------------------------------------------------------------------
    # 生命周期
    # ------------------------------------------------------------------

    async def start(self, ssh_config: Optional[dict]) -> None:
        self.pty.spawn(cols=self.cols, rows=self.rows, ssh_config=ssh_config)
        self.pty.add_output_callback(self._on_output)
        self._read_task = asyncio.create_task(self.pty.start_read_loop())
        self._wake_event = asyncio.Event()
        self._touch()

    def is_alive(self) -> bool:
        return self.pty.is_alive()

    def close(self) -> None:
        self.pty.terminate()
        if self._read_task and not self._read_task.done():
            self._read_task.cancel()
        # 唤醒所有 SSE 订阅，让其退出
        if self._wake_event is not None:
            try:
                self._wake_event._loop.call_soon_threadsafe(self._wake_event.set)  # type: ignore[attr-defined]
            except Exception:
                pass

    def info(self) -> dict:
        return {
            "id": self.id,
            "type": self.type,
            "connection_id": self.connection_id,
            "title": self.title,
            "name": self.name,
            "host": self.host,
            "port": self.port,
            "username": self.username,
            "cwd": self.cwd,
            "cols": self.cols,
            "rows": self.rows,
            "alive": self.is_alive(),
            "created_at": self.created_at.isoformat(),
            "size": self._total,
            "idle_seconds": round(self.idle_seconds(), 1),
            "ttl_seconds": self.ttl_seconds,
        }

    # ------------------------------------------------------------------
    # 快照
    # ------------------------------------------------------------------

    def snapshot(
        self,
        since: Optional[int] = None,
        strip: bool = True,
        pattern: Optional[str] = None,
        context: int = 0,
        case_insensitive: bool = False,
    ) -> dict:
        """获取终端输出快照。

        ``pattern`` 提供时，仅返回匹配行（``context`` 控制上下文行数）。
        """
        self._touch()
        with self._lock:
            total = self._total
            buf_start = total - len(self._raw)
            if since is None:
                chunk = bytes(self._raw)
            else:
                idx = max(0, since - buf_start)
                chunk = bytes(self._raw[idx:])
        text = chunk.decode("utf-8", errors="replace")
        if strip:
            text = strip_ansi(text)

        result = {
            "output": text,
            "size": total,
            "truncated": since is not None and since < buf_start,
            "alive": self.is_alive(),
        }
        if pattern:
            grep = _grep_lines(text, pattern, context=context, case_insensitive=case_insensitive)
            result["grep"] = grep
            # output 字段保持原样供调用方需要时再用；grep 返回结构化匹配。
        return result

    # ------------------------------------------------------------------
    # 输入辅助
    # ------------------------------------------------------------------

    @staticmethod
    def _decode_b64(value: str) -> str:
        try:
            return base64.b64decode(value, validate=True).decode("utf-8")
        except (binascii.Error, UnicodeDecodeError) as exc:
            raise ValueError(f"base64 解码失败: {exc}") from exc

    @staticmethod
    def _compose_payload(
        data: str = "",
        data_b64: Optional[str] = None,
        keys: Optional[list[str]] = None,
    ) -> str:
        chunks: list[str] = []
        if keys:
            chunks.append(resolve_keys(keys))
        if data:
            chunks.append(data)
        if data_b64:
            chunks.append(AgentTerminal._decode_b64(data_b64))
        return "".join(chunks)

    async def send(
        self,
        data: str = "",
        data_b64: Optional[str] = None,
        keys: Optional[list[str]] = None,
        enter: bool = True,
        wait: bool = False,
        timeout: float = 10.0,
        idle: float = 0.6,
        strip_echo: bool = False,
    ) -> dict:
        """向终端写入数据。"""
        self._touch()
        payload = self._compose_payload(data, data_b64, keys)

        with self._lock:
            start_offset = self._total

        wire = payload + ("\r" if enter else "")
        if wire:
            self.pty.write(wire.encode("utf-8"))

        if not wait:
            return {"ok": True, "since": start_offset}

        loop = asyncio.get_event_loop()
        deadline = loop.time() + timeout
        last_total = start_offset
        last_change = loop.time()
        reason = "no_output"

        while True:
            await asyncio.sleep(0.15)
            now = loop.time()
            with self._lock:
                cur = self._total
            if cur != last_total:
                last_total = cur
                last_change = now
            if cur != start_offset and now - last_change >= idle:
                reason = "idle"
                break
            if now >= deadline:
                reason = "timeout" if cur != start_offset else "no_output"
                break

        snap = self.snapshot(since=start_offset)
        output = snap["output"]
        if strip_echo and payload:
            output = _strip_command_echo(output, payload)
        self._touch()
        return {
            "ok": True,
            "since": start_offset,
            "output": output,
            "size": snap["size"],
            "alive": snap["alive"],
            "reason": reason,
        }

    # ------------------------------------------------------------------
    # 原子执行（带 exit code + cwd 跟踪 + env/cwd 注入）
    # ------------------------------------------------------------------

    async def exec(
        self,
        command: str = "",
        command_b64: Optional[str] = None,
        timeout: float = 30.0,
        idle: float = 0.3,
        cwd: Optional[str] = None,
        env: Optional[dict[str, str]] = None,
    ) -> dict:
        """运行 POSIX shell 命令并返回 stdout + exit_code + 当前 cwd。

        Args:
            command / command_b64: 命令内容（二选一或拼接，b64 避开转义）。
            timeout: 等待 sentinel 出现的最大秒数。
            idle: 保留字段。
            cwd: 临时切到该目录运行（用 subshell，不污染终端持久 cwd）。
            env: 临时环境变量字典（用 subshell 注入，不污染终端持久 env）。

        Returns:
            {"ok": True, "exit_code": int, "stdout": str, "cwd": str, "size": ..., "alive": ...}
            超时: {"ok": False, "reason": "timeout", "stdout": str, ...}
        """
        self._touch()
        if command_b64:
            command = (command or "") + self._decode_b64(command_b64)
        command = command.rstrip("\n")
        if not command:
            return {"ok": False, "reason": "empty_command"}

        # 只有传了 cwd/env 才需要用 subshell 包，避免污染终端的持久 cwd / env。
        # 否则直接跑用户命令，最大化兼容多行 / heredoc 场景，且避免 PS2 噪音。
        # 校验环境变量名，构造 export 序列
        export_clause = ""
        if env:
            exports: list[str] = []
            for k, v in env.items():
                if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", k):
                    raise ValueError(f"非法环境变量名: {k!r}")
                exports.append(f"export {k}={shlex.quote(v)}")
            export_clause = "; ".join(exports) + "; "

        if cwd or env:
            # 单行 subshell。把 env export 进 subshell 内部，对整段命令生效；
            # 用 ; 把用户命令的换行连成单行，避免 PTY 看到中间换行就提前回车。
            user_cmd = command.replace("\n", "; ")
            cd_clause = f"cd {shlex.quote(cwd)}; " if cwd else ""
            core = f"( {cd_clause}{export_clause}{user_cmd} )"
        else:
            core = command

        sentinel = f"__WT_EXEC_{uuid.uuid4().hex[:12]}__"
        # sentinel 含 exit code 和 PWD。printf 而非 echo 规避 -e/-n 歧义。
        # 用 ; 把 printf 接在命令后面：单行结构，PTY 看到完整一行命令后回车执行。
        wrapped = (
            f"{core}; "
            f"printf '\\n{sentinel}%d:%s\\n' \"$?\" \"$PWD\"\r"
        )

        with self._lock:
            start_offset = self._total

        self.pty.write(wrapped.encode("utf-8"))

        pattern = re.compile(
            rf"{re.escape(sentinel)}(\d+):([^\r\n]*)\r?\n"
        )

        loop = asyncio.get_event_loop()
        deadline = loop.time() + timeout

        while True:
            await asyncio.sleep(0.1)
            now = loop.time()

            with self._lock:
                total = self._total
                buf_start = total - len(self._raw)
                chunk_offset = max(0, start_offset - buf_start)
                chunk = bytes(self._raw[chunk_offset:])

            text = strip_ansi(chunk.decode("utf-8", errors="replace"))
            match = pattern.search(text)
            if match:
                exit_code = int(match.group(1))
                self.cwd = match.group(2) or self.cwd
                stdout = text[: match.start()]
                stdout = _strip_command_echo(stdout, command)
                stdout = stdout.rstrip("\n")
                self._touch()
                return {
                    "ok": True,
                    "exit_code": exit_code,
                    "stdout": stdout,
                    "cwd": self.cwd,
                    "size": total,
                    "alive": self.is_alive(),
                }

            if now >= deadline:
                stdout = _strip_command_echo(text, command).rstrip("\n")
                return {
                    "ok": False,
                    "reason": "timeout",
                    "stdout": stdout,
                    "cwd": self.cwd,
                    "size": total,
                    "alive": self.is_alive(),
                }

    # ------------------------------------------------------------------
    # SSE 流式输出
    # ------------------------------------------------------------------

    async def stream(self, since: int = 0, strip: bool = True) -> AsyncIterator[dict]:
        """异步生成器：每当有新输出 yield 一条事件。

        事件格式: {"id": <累计字节数>, "event": "output"|"heartbeat"|"end", "data": <text>}
        调用方负责把它格式化为 text/event-stream 字节流。
        """
        self._touch()
        cur = since
        if self._wake_event is None:
            return
        last_heartbeat = time.monotonic()

        while self.is_alive():
            with self._lock:
                total = self._total
            if total > cur:
                snap = self.snapshot(since=cur, strip=strip)
                cur = snap["size"]
                yield {"id": cur, "event": "output", "data": snap["output"]}
                last_heartbeat = time.monotonic()
                self._touch()
            else:
                # 等新输出或超时心跳
                try:
                    await asyncio.wait_for(self._wake_event.wait(), timeout=15.0)
                    self._wake_event.clear()
                except asyncio.TimeoutError:
                    yield {"id": cur, "event": "heartbeat", "data": ""}
                    last_heartbeat = time.monotonic()

        # 终端结束，发送 end 事件
        with self._lock:
            total = self._total
        if total > cur:
            snap = self.snapshot(since=cur, strip=strip)
            yield {"id": snap["size"], "event": "output", "data": snap["output"]}
        yield {"id": total, "event": "end", "data": "terminal closed"}


class AgentTerminalPool:
    """HTTP 终端池（单例）+ TTL janitor。"""

    _instance: Optional[AgentTerminalPool] = None
    _singleton_lock = threading.Lock()

    def __new__(cls) -> AgentTerminalPool:
        if cls._instance is None:
            with cls._singleton_lock:
                if cls._instance is None:
                    cls._instance = super().__new__(cls)
                    cls._instance._terminals = {}
                    cls._instance._lock = threading.Lock()
                    cls._instance._janitor_task = None
        return cls._instance

    def _ensure_janitor(self) -> None:
        """首次有终端时启动 TTL 回收协程。"""
        if self._janitor_task is None or self._janitor_task.done():
            try:
                loop = asyncio.get_running_loop()
            except RuntimeError:
                return
            self._janitor_task = loop.create_task(self._janitor_loop())

    async def _janitor_loop(self) -> None:
        """周期性扫描，关闭超时空闲终端。"""
        while True:
            try:
                await asyncio.sleep(_JANITOR_INTERVAL)
                victims: list[str] = []
                with self._lock:
                    for tid, term in self._terminals.items():
                        if term.ttl_seconds <= 0:
                            continue  # 0 / 负数 = 永不过期
                        if not term.is_alive() or term.idle_seconds() > term.ttl_seconds:
                            victims.append(tid)
                for tid in victims:
                    if self.close(tid):
                        logger.info(f"[janitor] 回收空闲/已死终端: {tid}")
            except asyncio.CancelledError:
                break
            except Exception:
                logger.exception("[janitor] 循环异常")

    async def create(
        self,
        terminal_type: str,
        connection_id: Optional[str],
        cols: int,
        rows: int,
        name: str = "",
        ttl_seconds: float = DEFAULT_TTL_SECONDS,
    ) -> AgentTerminal:
        title = ""
        ssh_config: Optional[dict] = None

        if terminal_type == "ssh":
            if not connection_id:
                raise ValueError("ssh 类型必须提供 connection_id")
            from backend.ssh.connection_manager import SSHConnectionManager

            conn = SSHConnectionManager.get_connection(connection_id)
            if not conn:
                raise ValueError(f"SSH 连接不存在: {connection_id}")
            ssh_config = conn.to_dict()
            title = conn.title or f"{conn.username}@{conn.host}"
            SSHConnectionManager.update_last_connected(connection_id)

        terminal = AgentTerminal(
            terminal_type, connection_id, cols, rows, title,
            name=name, ttl_seconds=ttl_seconds,
        )
        if ssh_config:
            terminal.host = ssh_config.get("host")
            terminal.port = ssh_config.get("port")
            terminal.username = ssh_config.get("username")
        await terminal.start(ssh_config)

        with self._lock:
            self._terminals[terminal.id] = terminal
        self._ensure_janitor()
        logger.info(f"[create] HTTP 终端已创建: {terminal.id} ({terminal_type}, name={name!r}, ttl={ttl_seconds})")
        return terminal

    def get(self, terminal_id: str) -> Optional[AgentTerminal]:
        with self._lock:
            return self._terminals.get(terminal_id)

    def list(self) -> list[dict]:
        with self._lock:
            return [t.info() for t in self._terminals.values()]

    def close(self, terminal_id: str) -> bool:
        with self._lock:
            terminal = self._terminals.pop(terminal_id, None)
        if terminal:
            terminal.close()
            logger.info(f"[close] HTTP 终端已关闭: {terminal_id}")
            return True
        return False


def get_terminal_pool() -> AgentTerminalPool:
    return AgentTerminalPool()
