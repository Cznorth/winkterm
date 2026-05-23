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
import threading
import uuid
from datetime import datetime
from typing import Optional

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

# 命名控制键 → 实际字节序列。
# 用户在 JSON 里发 "ctrl+c" 比塞 "" 友好得多。
KEY_MAP: dict[str, str] = {
    # 控制字符
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
    # 方向键 / 编辑键 (xterm 序列)
    "up": "\x1b[A", "down": "\x1b[B", "right": "\x1b[C", "left": "\x1b[D",
    "home": "\x1b[H", "end": "\x1b[F",
    "pageup": "\x1b[5~", "pagedown": "\x1b[6~",
    "insert": "\x1b[2~", "delete": "\x1b[3~",
    # 功能键
    "f1": "\x1bOP", "f2": "\x1bOQ", "f3": "\x1bOR", "f4": "\x1bOS",
    "f5": "\x1b[15~", "f6": "\x1b[17~", "f7": "\x1b[18~", "f8": "\x1b[19~",
    "f9": "\x1b[20~", "f10": "\x1b[21~", "f11": "\x1b[23~", "f12": "\x1b[24~",
}


class UnknownKeyError(ValueError):
    """请求里出现 KEY_MAP 不认识的命名键。"""


def resolve_keys(keys: list[str]) -> str:
    """把命名键数组翻译成实际控制字节序列。

    大小写不敏感，空格被忽略。未知键名抛 UnknownKeyError，调用方负责返回 400。
    """
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
    """从 PTY 输出里剥离命令回显行。

    PTY 总会把用户输入回显一遍，包含 prompt 和换行。
    我们按行扫，丢掉首行包含 ``command`` 子串的那一行（最多丢一行），
    避免把后续真实输出里恰好出现该子串的内容也删掉。
    """
    if not command:
        return output
    # 命令本身可能是多行，取第一行作为匹配锚点
    first_line = command.splitlines()[0].strip()
    if not first_line:
        return output
    lines = output.split("\n")
    for i, line in enumerate(lines):
        if first_line in line:
            return "\n".join(lines[i + 1:])
    return output


class AgentTerminal:
    """单个 HTTP 终端：封装 PtyManager + 输出累积。"""

    def __init__(
        self,
        terminal_type: str,
        connection_id: Optional[str],
        cols: int,
        rows: int,
        title: str = "",
    ) -> None:
        self.id = uuid.uuid4().hex[:12]
        self.type = terminal_type
        self.connection_id = connection_id
        self.title = title
        self.cols = cols
        self.rows = rows
        self.created_at = datetime.now()
        self.pty = PtyManager()
        self._raw = bytearray()
        self._total = 0  # 累计写入字节数（绝对偏移，用于增量快照）
        self._lock = threading.Lock()
        self._read_task: Optional[asyncio.Task] = None

    def _on_output(self, data: bytes) -> None:
        with self._lock:
            self._raw.extend(data)
            self._total += len(data)
            if len(self._raw) > _MAX_RAW:
                del self._raw[: len(self._raw) - _MAX_RAW]

    async def start(self, ssh_config: Optional[dict]) -> None:
        """启动 PTY 并在后台运行读循环。"""
        self.pty.spawn(cols=self.cols, rows=self.rows, ssh_config=ssh_config)
        self.pty.add_output_callback(self._on_output)
        self._read_task = asyncio.create_task(self.pty.start_read_loop())

    def is_alive(self) -> bool:
        return self.pty.is_alive()

    def snapshot(self, since: Optional[int] = None, strip: bool = True) -> dict:
        """获取终端输出快照。

        Args:
            since: 绝对字节偏移，仅返回该偏移之后的新增输出；None 返回全部缓冲。
            strip: 是否清理 ANSI 转义序列。
        """
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
        return {
            "output": text,
            "size": total,
            "truncated": since is not None and since < buf_start,
            "alive": self.is_alive(),
        }

    # ------------------------------------------------------------------
    # 输入辅助
    # ------------------------------------------------------------------

    @staticmethod
    def _decode_b64(value: str) -> str:
        """解码 base64 输入，失败抛 ValueError。"""
        try:
            return base64.b64decode(value, validate=True).decode("utf-8")
        except (binascii.Error, UnicodeDecodeError) as exc:
            raise ValueError(f"data_b64 解码失败: {exc}") from exc

    @staticmethod
    def _compose_payload(
        data: str = "",
        data_b64: Optional[str] = None,
        keys: Optional[list[str]] = None,
    ) -> str:
        """根据 data / data_b64 / keys 三种输入合成最终要写入的字符串。

        三者可同时使用：先 keys，再 data，再 data_b64，按顺序拼接。
        最常见的用法是单独使用其中一种。
        """
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
        """向终端写入数据。

        Args:
            data: 直接文本。
            data_b64: base64 编码文本，避开 JSON 字符串转义噩梦（多层引号场景必备）。
            keys: 命名控制键列表，如 ["ctrl+c"]、["up","enter"]。详见 KEY_MAP。
            enter: 是否追加回车执行。若只是发控制键，通常设 false。
            wait: 是否同步等待输出稳定后返回新增输出。
            timeout: wait 模式下的最长等待秒数。
            idle: wait 模式下连续多少秒无新增输出视为稳定。
            strip_echo: 是否从返回输出里剥离命令回显行（仅 wait=true 生效）。

        Returns:
            wait=false: {"ok": True, "since": <起始偏移>}
            wait=true:  {"ok": True, "since": ..., "output": ..., "size": ...,
                         "alive": ..., "reason": "idle"|"timeout"|"no_output"}
        """
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
        return {
            "ok": True,
            "since": start_offset,
            "output": output,
            "size": snap["size"],
            "alive": snap["alive"],
            "reason": reason,
        }

    # ------------------------------------------------------------------
    # 高级：原子执行（带 exit code）
    # ------------------------------------------------------------------

    async def exec(
        self,
        command: str = "",
        command_b64: Optional[str] = None,
        timeout: float = 30.0,
        idle: float = 0.3,
    ) -> dict:
        """运行 POSIX shell 命令并返回 stdout + exit_code。

        实现：在命令后附加 ``echo <SENTINEL>$?`` 标记行，
        读循环里扫到标记 → 解析出 exit code 并切出 stdout。
        命令回显行和最后的 prompt 都被剥离。

        仅适用于类 sh 的 shell（bash/zsh/sh/dash 等），Windows cmd.exe 不可用。

        Args:
            command: 命令文本。
            command_b64: base64 编码的命令，避免 JSON / shell 多层转义。
            timeout: 等待 sentinel 出现的最大秒数。
            idle: 看到 sentinel 后多等多少秒确保后续 prompt 也被吃掉（实际只用于保底）。

        Returns:
            成功: {"ok": True, "exit_code": int, "stdout": str, "size": int, "alive": bool}
            超时: {"ok": False, "reason": "timeout", "stdout": str(已收到的), "size", "alive"}
        """
        if command_b64:
            command = (command or "") + self._decode_b64(command_b64)
        command = command.rstrip("\n")
        if not command:
            return {"ok": False, "reason": "empty_command"}

        sentinel = f"__WT_EXEC_{uuid.uuid4().hex[:12]}__"
        # 用 printf 而非 echo：避免 echo 在不同 shell 下对 -e/-n 的歧义。
        # 用 ; 不用换行：保证 $? 拿到的是命令本身的退出码，
        # 否则用户传入的多行命令会让换行语义复杂化。
        # 用 \r 触发执行（PTY 行为）。
        wrapped = f"{command}; printf '\\n{sentinel}%d\\n' \"$?\"\r"

        with self._lock:
            start_offset = self._total

        self.pty.write(wrapped.encode("utf-8"))

        # 用一个能识别 sentinel + 退出码的正则。
        # 仅匹配 "sentinel紧跟数字+换行" 的真实标记行，
        # 命令回显里的 sentinel 后面跟的是引号或 % 字符，不会误伤。
        pattern = re.compile(rf"{re.escape(sentinel)}(\d+)\r?\n")

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
                stdout = text[: match.start()]
                # 剥离命令回显（第一行）
                stdout = _strip_command_echo(stdout, command)
                # 去掉尾部的孤立空行
                stdout = stdout.rstrip("\n")
                return {
                    "ok": True,
                    "exit_code": exit_code,
                    "stdout": stdout,
                    "size": total,
                    "alive": self.is_alive(),
                }

            if now >= deadline:
                # 超时：返回已收到的内容，让调用方诊断
                stdout = _strip_command_echo(text, command).rstrip("\n")
                return {
                    "ok": False,
                    "reason": "timeout",
                    "stdout": stdout,
                    "size": total,
                    "alive": self.is_alive(),
                }

    def close(self) -> None:
        self.pty.terminate()
        if self._read_task and not self._read_task.done():
            self._read_task.cancel()

    def info(self) -> dict:
        return {
            "id": self.id,
            "type": self.type,
            "connection_id": self.connection_id,
            "title": self.title,
            "cols": self.cols,
            "rows": self.rows,
            "alive": self.is_alive(),
            "created_at": self.created_at.isoformat(),
            "size": self._total,
        }


class AgentTerminalPool:
    """HTTP 终端池（单例）。"""

    _instance: Optional[AgentTerminalPool] = None
    _singleton_lock = threading.Lock()

    def __new__(cls) -> AgentTerminalPool:
        if cls._instance is None:
            with cls._singleton_lock:
                if cls._instance is None:
                    cls._instance = super().__new__(cls)
                    cls._instance._terminals = {}
                    cls._instance._lock = threading.Lock()
        return cls._instance

    async def create(
        self,
        terminal_type: str,
        connection_id: Optional[str],
        cols: int,
        rows: int,
    ) -> AgentTerminal:
        """创建并启动一个终端。"""
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

        terminal = AgentTerminal(terminal_type, connection_id, cols, rows, title)
        await terminal.start(ssh_config)

        with self._lock:
            self._terminals[terminal.id] = terminal
        logger.info(f"[create] HTTP 终端已创建: {terminal.id} ({terminal_type})")
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
