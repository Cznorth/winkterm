"""HTTP 驱动的终端池。

与 WebSocket 终端不同，这里的终端由外部 agent 通过 HTTP 创建和操作，
后台读循环独立运行并累积输出，供快照查询。
"""

from __future__ import annotations

import asyncio
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


def strip_ansi(text: str) -> str:
    """去除 ANSI 转义序列，并把 \\r\\n / \\r 归一为 \\n。"""
    text = _ANSI_RE.sub("", text)
    return text.replace("\r\n", "\n").replace("\r", "\n")


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

    async def send(
        self,
        data: str,
        enter: bool = True,
        wait: bool = False,
        timeout: float = 10.0,
        idle: float = 0.6,
    ) -> dict:
        """向终端写入数据。

        Args:
            data: 要写入的文本（控制键直接传原始字符，如 "\\u0003" 表示 Ctrl+C）。
            enter: 是否追加回车执行。
            wait: 是否同步等待输出稳定后返回新增输出。
            timeout: wait 模式下的最长等待秒数。
            idle: wait 模式下连续多少秒无新增输出视为稳定。
        """
        with self._lock:
            start_offset = self._total

        payload = data + ("\r" if enter else "")
        self.pty.write(payload.encode("utf-8"))

        if not wait:
            return {"ok": True, "since": start_offset}

        loop = asyncio.get_event_loop()
        deadline = loop.time() + timeout
        last_total = start_offset
        last_change = loop.time()

        while True:
            await asyncio.sleep(0.15)
            now = loop.time()
            with self._lock:
                cur = self._total
            if cur != last_total:
                last_total = cur
                last_change = now
            if cur != start_offset and now - last_change >= idle:
                break
            if now >= deadline:
                break

        snap = self.snapshot(since=start_offset)
        return {
            "ok": True,
            "since": start_offset,
            "output": snap["output"],
            "size": snap["size"],
            "alive": snap["alive"],
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
