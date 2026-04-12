from __future__ import annotations

import asyncio
import os
import sys
from collections import deque
from typing import Callable, Deque

import ptyprocess


class PtyManager:
    """管理单个 pty 进程，封装 spawn / read / write / resize。"""

    BUFFER_LINES = 500  # 滚动缓冲区保留行数

    def __init__(self) -> None:
        self._proc: ptyprocess.PtyProcess | None = None
        self._output_buffer: Deque[str] = deque(maxlen=self.BUFFER_LINES)
        self._read_callbacks: list[Callable[[bytes], None]] = []
        self._read_task: asyncio.Task | None = None
        self._loop: asyncio.AbstractEventLoop | None = None

    # ------------------------------------------------------------------
    # 生命周期
    # ------------------------------------------------------------------

    def spawn(self, shell: str | None = None, cols: int = 80, rows: int = 24) -> None:
        """启动 pty 进程。"""
        if shell is None:
            shell = os.environ.get("SHELL", "/bin/bash")
            if sys.platform == "win32":
                shell = os.environ.get("COMSPEC", "cmd.exe")

        self._proc = ptyprocess.PtyProcess.spawn(
            [shell],
            dimensions=(rows, cols),
            env={**os.environ, "TERM": "xterm-256color"},
        )

    def is_alive(self) -> bool:
        return self._proc is not None and self._proc.isalive()

    def terminate(self) -> None:
        if self._proc and self._proc.isalive():
            self._proc.terminate(force=True)

    # ------------------------------------------------------------------
    # 读写
    # ------------------------------------------------------------------

    def write(self, data: bytes) -> None:
        """向 pty 写入原始字节（用户键盘输入）。"""
        if self._proc and self._proc.isalive():
            self._proc.write(data)

    def write_command(self, command: str) -> None:
        """将命令写入终端输入行，不发送回车（模拟用户正在输入）。"""
        if self._proc and self._proc.isalive():
            self._proc.write(command.encode())

    def write_message(self, message: str) -> None:
        """在终端打印 AI 消息，使用青色 ANSI 颜色，不影响 shell 输入行。"""
        if self._proc and self._proc.isalive():
            formatted = f"\r\n\033[36m[WinkTerm] {message}\033[0m\r\n"
            self._proc.write(formatted.encode())

    def resize(self, cols: int, rows: int) -> None:
        """调整终端尺寸。"""
        if self._proc and self._proc.isalive():
            self._proc.setwinsize(rows, cols)

    # ------------------------------------------------------------------
    # 异步读取循环
    # ------------------------------------------------------------------

    def add_output_callback(self, cb: Callable[[bytes], None]) -> None:
        self._read_callbacks.append(cb)

    def remove_output_callback(self, cb: Callable[[bytes], None]) -> None:
        self._read_callbacks = [c for c in self._read_callbacks if c is not cb]

    async def start_read_loop(self) -> None:
        """在后台循环读取 pty 输出并回调。"""
        self._loop = asyncio.get_event_loop()
        while self.is_alive():
            try:
                data = await self._loop.run_in_executor(None, self._blocking_read)
                if data:
                    # 追加到缓冲区（按行分割）
                    text = data.decode(errors="replace")
                    for line in text.splitlines():
                        self._output_buffer.append(line)
                    for cb in list(self._read_callbacks):
                        cb(data)
            except EOFError:
                break
            except Exception:
                break

    def _blocking_read(self) -> bytes:
        if self._proc and self._proc.isalive():
            return self._proc.read(4096)
        return b""

    # ------------------------------------------------------------------
    # 上下文
    # ------------------------------------------------------------------

    def get_context(self, lines: int = 50) -> str:
        """返回最近 N 行终端内容，供 Agent 分析。"""
        recent = list(self._output_buffer)[-lines:]
        return "\n".join(recent)
