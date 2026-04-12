from __future__ import annotations

import asyncio
import os
import sys
import subprocess
from collections import deque
from typing import Callable, Deque

# ptyprocess 只能在 Unix 上用（依赖 fcntl），Windows 需要 fallback
try:
    import ptyprocess
    _HAS_PTY = True
except (ImportError, OSError):
    _HAS_PTY = False


class PtyManager:
    """管理单个 pty 进程，封装 spawn / read / write / resize。

    Unix: 使用真实的 ptyprocess
    Windows: 使用 subprocess + dummy 实现（终端交互不可用，但 API 可正常启动测试）
    """

    BUFFER_LINES = 500

    def __init__(self) -> None:
        self._is_windows = sys.platform == "win32"
        self._proc: ptyprocess.PtyProcess | subprocess.Popen | None = None
        self._output_buffer: Deque[str] = deque(maxlen=self.BUFFER_LINES)
        self._read_callbacks: list[Callable[[bytes], None]] = []
        self._loop: asyncio.AbstractEventLoop | None = None
        self._alive = False

    # ------------------------------------------------------------------
    # 生命周期
    # ------------------------------------------------------------------

    def spawn(self, shell: str | None = None, cols: int = 80, rows: int = 24) -> None:
        if shell is None:
            if self._is_windows:
                shell = os.environ.get("COMSPEC", "cmd.exe")
            else:
                shell = os.environ.get("SHELL", "/bin/bash")

        if _HAS_PTY and not self._is_windows:
            self._proc = ptyprocess.PtyProcess.spawn(
                [shell],
                dimensions=(rows, cols),
                env={**os.environ, "TERM": "xterm-256color"},
            )
        else:
            # Windows fallback：使用普通 subprocess（无真正 pty）
            self._proc = subprocess.Popen(
                [shell],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                env={**os.environ, "TERM": "xterm-256color"},
            )
        self._alive = True

    def is_alive(self) -> bool:
        if self._is_windows and isinstance(self._proc, subprocess.Popen):
            return self._proc.poll() is None
        if _HAS_PTY and isinstance(self._proc, ptyprocess.PtyProcess):
            return self._proc.isalive()
        return self._alive and self._proc is not None

    def terminate(self) -> None:
        self._alive = False
        if isinstance(self._proc, subprocess.Popen):
            self._proc.terminate()
        elif hasattr(self._proc, "terminate"):
            self._proc.terminate(force=True)

    # ------------------------------------------------------------------
    # 读写
    # ------------------------------------------------------------------

    def write(self, data: bytes) -> None:
        if not self.is_alive():
            return
        if isinstance(self._proc, subprocess.Popen) and self._proc.stdin:
            try:
                self._proc.stdin.write(data)
                self._proc.stdin.flush()
            except BrokenPipeError:
                self._alive = False
        elif hasattr(self._proc, "write"):
            self._proc.write(data)

    def write_command(self, command: str) -> None:
        """将命令写入终端输入行，不发送回车。"""
        if isinstance(self._proc, subprocess.Popen):
            # subprocess 没有 pty，回显到 buffer 模拟
            self._output_buffer.append(f"$ {command}")
            self._notify_callbacks(f"$ {command}\r\n".encode())
        else:
            self.write(command.encode())

    def write_message(self, message: str) -> None:
        """打印 AI 消息到终端（青色 ANSI）。"""
        formatted = f"\r\n\033[36m[WinkTerm] {message}\033[0m\r\n"
        if isinstance(self._proc, subprocess.Popen):
            self._notify_callbacks(formatted.encode())
        else:
            self.write(formatted.encode())

    def resize(self, cols: int, rows: int) -> None:
        if hasattr(self._proc, "setwinsize"):
            self._proc.setwinsize(rows, cols)

    # ------------------------------------------------------------------
    # 异步读取循环
    # ------------------------------------------------------------------

    def add_output_callback(self, cb: Callable[[bytes], None]) -> None:
        self._read_callbacks.append(cb)

    def remove_output_callback(self, cb: Callable[[bytes], None]) -> None:
        self._read_callbacks = [c for c in self._read_callbacks if c is not cb]

    async def start_read_loop(self) -> None:
        self._loop = asyncio.get_event_loop()
        while self.is_alive():
            try:
                if isinstance(self._proc, subprocess.Popen) and self._proc.stdout:
                    data = await self._loop.run_in_executor(
                        None, self._proc.stdout.readline
                    )
                    if not data:
                        break
                else:
                    data = await self._loop.run_in_executor(None, self._blocking_read)
            except (EOFError, BrokenPipeError, OSError):
                break
            except Exception:
                break
            else:
                if data:
                    text = data.decode(errors="replace")
                    for line in text.splitlines():
                        self._output_buffer.append(line)
                    self._notify_callbacks(data.encode() if isinstance(data, str) else data)

    def _blocking_read(self) -> bytes:
        if hasattr(self._proc, "read"):
            return self._proc.read(4096)  # type: ignore[union-attr]
        return b""

    def _notify_callbacks(self, data: bytes) -> None:
        for cb in list(self._read_callbacks):
            try:
                cb(data)
            except Exception:
                pass

    # ------------------------------------------------------------------
    # 上下文
    # ------------------------------------------------------------------

    def get_context(self, lines: int = 50) -> str:
        recent = list(self._output_buffer)[-lines:]
        return "\n".join(recent)
