from __future__ import annotations

import asyncio
import logging
import sys
import threading
from collections import deque
from typing import Callable, Optional

logger = logging.getLogger("pty_manager")

# Windows: pywinpty | Unix: ptyprocess
if sys.platform == "win32":
    try:
        import winpty

        _HAS_PTY = True
    except ImportError:
        _HAS_PTY = False
        logger.warning("pywinpty 未安装，PTY 功能不可用")
else:
    try:
        import ptyprocess

        _HAS_PTY = True
    except ImportError:
        _HAS_PTY = False
        logger.warning("ptyprocess 未安装，PTY 功能不可用")


class PtyManager:
    """PTY manager: passes through raw bytes without any parsing.

    Windows: uses pywinpty (a real PTY)
    Unix:    uses ptyprocess
    """

    BUFFER_LINES = 500

    def __init__(self) -> None:
        self._proc = None  # winpty.PtyProcess | ptyprocess.PtyProcess
        self._output_buffer: deque[str] = deque(maxlen=self.BUFFER_LINES)
        self._screen_content: str = ""  # screen content serialized by the frontend
        self._read_callbacks: list[Callable[[bytes], None]] = []
        self._queue: asyncio.Queue[bytes | None] | None = None
        self._read_thread: threading.Thread | None = None
        self._alive = False
        self._loop: asyncio.AbstractEventLoop | None = None
        # SSH-related
        self._ssh_password_handler = None
        self._ssh_connection_id: Optional[str] = None

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def spawn(
        self,
        shell: str | None = None,
        cols: int = 80,
        rows: int = 24,
        ssh_config: dict | None = None,
    ) -> None:
        """Start the PTY process.

        Args:
            shell: local shell path
            cols: number of columns
            rows: number of rows
            ssh_config: SSH connection config, including host, port, username, password, etc.
        """
        if not _HAS_PTY:
            raise RuntimeError("PTY not available: install pywinpty (Windows) or ptyprocess (Unix)")

        # SSH mode
        if ssh_config:
            self._spawn_ssh(ssh_config, cols, rows)
            return

        # Local shell mode
        if sys.platform == "win32":
            # Windows: pywinpty
            shell = shell or "powershell.exe"
            logger.info(f"[SPAWN] Windows: 启动 {shell}, dimensions=({rows}, {cols})")
            self._proc = winpty.PtyProcess.spawn(
                shell,
                dimensions=(rows, cols),
            )
            self._pid = getattr(self._proc, "pid", "N/A")
            logger.info(f"[SPAWN] PTY 进程已启动, pid={self._pid}")
        else:
            # Unix: ptyprocess
            import os
            shell = shell or os.environ.get("SHELL", "/bin/bash")
            # Set the necessary environment variables
            env = os.environ.copy()
            env.setdefault("TERM", "xterm-256color")
            env.setdefault("LANG", "en_US.UTF-8")
            env.setdefault("LC_ALL", "en_US.UTF-8")
            logger.info(f"[SPAWN] Unix: 启动 {shell}, dimensions=({rows}, {cols})")
            self._proc = ptyprocess.PtyProcess.spawn(
                [shell],
                dimensions=(rows, cols),
                env=env,
            )
            self._pid = getattr(self._proc, "pid", "N/A")
            logger.info(f"[SPAWN] PTY 进程已启动, pid={self._pid}")

        self._alive = True

    def _spawn_ssh(self, ssh_config: dict, cols: int, rows: int) -> None:
        """Start an SSH connection.

        Uses paramiko's native authentication (password/key passed as a
        parameter) instead of spawning the ``ssh`` CLI and screen-scraping the
        password prompt. The old CLI path remains as a fallback.
        """
        from backend.ssh.models import SSHConnection
        from backend.ssh.paramiko_channel import ParamikoShellChannel

        # Build the SSHConnection object
        conn = SSHConnection(
            host=ssh_config.get("host", ""),
            port=ssh_config.get("port", 22),
            username=ssh_config.get("username", ""),
            auth_type=ssh_config.get("auth_type", "password"),
            password=ssh_config.get("password"),
            private_key_path=ssh_config.get("private_key_path"),
            passphrase=ssh_config.get("passphrase"),
        )

        # Store the SSH connection ID
        self._ssh_connection_id = ssh_config.get("id")

        # Preferred path: paramiko native auth (no prompt scraping).
        logger.info(
            f"[SPAWN SSH] paramiko 原生认证 {conn.username}@{conn.host}:{conn.port}"
        )
        self._proc = ParamikoShellChannel(conn, cols=cols, rows=rows)
        self._pid = getattr(self._proc, "pid", "paramiko")
        self._alive = True
        logger.info(f"[SPAWN SSH] paramiko channel 已建立, pid={self._pid}")
        return

    def _spawn_ssh_cli(self, ssh_config: dict, cols: int, rows: int) -> None:
        """Fallback SSH path: spawn the ``ssh`` CLI and auto-type the password.

        Kept for environments where paramiko is unavailable.
        """
        from backend.ssh.pty_spawner import SSHPtySpawner, PasswordAutoInput
        from backend.ssh.models import SSHConnection

        conn = SSHConnection(
            host=ssh_config.get("host", ""),
            port=ssh_config.get("port", 22),
            username=ssh_config.get("username", ""),
            auth_type=ssh_config.get("auth_type", "password"),
            password=ssh_config.get("password"),
            private_key_path=ssh_config.get("private_key_path"),
        )

        self._ssh_connection_id = ssh_config.get("id")

        # Build the SSH command
        if sys.platform == "win32":
            # Windows: winpty needs a string
            ssh_cmd = SSHPtySpawner.build_ssh_command_str(conn)
            logger.info(f"[SPAWN SSH] Windows: 启动 SSH {conn.username}@{conn.host}:{conn.port}")
            self._proc = winpty.PtyProcess.spawn(
                ssh_cmd,
                dimensions=(rows, cols),
            )
        else:
            # Unix: ptyprocess needs a list
            import os
            ssh_cmd = SSHPtySpawner.build_ssh_command(conn)
            # Set the necessary environment variables
            env = os.environ.copy()
            env.setdefault("TERM", "xterm-256color")
            env.setdefault("LANG", "en_US.UTF-8")
            env.setdefault("LC_ALL", "en_US.UTF-8")
            logger.info(f"[SPAWN SSH] Unix: 启动 SSH {conn.username}@{conn.host}:{conn.port}")
            self._proc = ptyprocess.PtyProcess.spawn(
                ssh_cmd,
                dimensions=(rows, cols),
                env=env,
            )

        self._pid = getattr(self._proc, "pid", "N/A")
        logger.info(f"[SPAWN SSH] PTY 进程已启动, pid={self._pid}")

        # Set up the password auto-input handler (registered as a callback)
        if conn.auth_type == "password" and conn.password:
            self._ssh_password_handler = PasswordAutoInput(
                password=conn.password,
                write_func=self.write,
            )
            self.add_output_callback(self._ssh_password_handler)
            logger.info("[SPAWN SSH] 密码自动输入处理器已启用")

        self._alive = True

    def is_alive(self) -> bool:
        if self._proc is None:
            return False
        if hasattr(self._proc, "isalive"):
            return self._proc.isalive()
        return self._alive

    def terminate(self) -> None:
        self._alive = False
        if self._proc:
            try:
                if hasattr(self._proc, "terminate"):
                    self._proc.terminate(force=True)
                elif hasattr(self._proc, "close"):
                    self._proc.close()
            except Exception:
                pass
        self._proc = None

    # ------------------------------------------------------------------
    # Write operations (passing through bytes)
    # ------------------------------------------------------------------

    def write(self, data: bytes) -> None:
        """Pass raw bytes through to the PTY."""
        if self._proc is None:
            logger.warning("[WRITE] PTY 进程未启动，忽略写入")
            return
        if not hasattr(self._proc, "write"):
            logger.warning("[WRITE] PTY 没有 write 方法")
            return
        try:
            # winpty needs str, ptyprocess needs bytes
            if sys.platform == "win32":
                text = data.decode("utf-8", errors="replace")
                # logger.debug(f"[WRITE] Windows: write {len(text)} chars: {repr(text[:50])}")
                self._proc.write(text)
            else:
                # logger.debug(f"[WRITE] Unix: write {len(data)} bytes: {repr(data[:50])}")
                self._proc.write(data)
        except Exception as e:
            logger.error(f"[WRITE] 写入失败: {e}")

    def write_command(self, command: str) -> None:
        """Write a command into the input line (without running it or sending Enter)."""
        self.write(command.encode("utf-8"))

    def resize(self, cols: int, rows: int) -> None:
        """Adjust the PTY size."""
        if self._proc and hasattr(self._proc, "setwinsize"):
            try:
                self._proc.setwinsize(rows, cols)
            except Exception:
                pass

    # ------------------------------------------------------------------
    # Async reading (background thread + asyncio queue)
    # ------------------------------------------------------------------

    def add_output_callback(self, cb: Callable[[bytes], None]) -> None:
        self._read_callbacks.append(cb)

    def remove_output_callback(self, cb: Callable[[bytes], None]) -> None:
        self._read_callbacks = [c for c in self._read_callbacks if c is not cb]

    async def start_read_loop(self) -> None:
        """Start the read loop: a background thread reads the PTY and puts data into the asyncio queue.

        Idempotent: if a read thread is already running, just await the existing task (prevents duplicate triggers from multiple agents/WS).
        """
        if self._proc is None or not hasattr(self._proc, "read"):
            return

        if self._read_thread is not None and self._read_thread.is_alive():
            logger.debug("[READ_LOOP] 读线程已在跑,跳过重启")
            return

        self._loop = asyncio.get_event_loop()
        self._queue = asyncio.Queue()

        def _reader():
            while self.is_alive():
                try:
                    data = self._proc.read(4096)
                    if not data:
                        break
                    raw = data.encode("utf-8") if isinstance(data, str) else data
                    if self._loop:
                        self._loop.call_soon_threadsafe(self._queue.put_nowait, raw)
                except EOFError:
                    break
                except Exception:
                    break
            # Termination signal
            if self._loop:
                self._loop.call_soon_threadsafe(self._queue.put_nowait, None)

        self._read_thread = threading.Thread(target=_reader, daemon=True)
        self._read_thread.start()

        # Main loop: take data from the queue and dispatch to callbacks
        while True:
            data = await self._queue.get()
            if data is None:
                break
            self._output_buffer.append(data.decode("utf-8", errors="replace"))
            self._notify_callbacks(data)

    def _notify_callbacks(self, data: bytes) -> None:
        """Notify all output callbacks."""
        for cb in list(self._read_callbacks):
            try:
                cb(data)
            except Exception:
                pass

    # ------------------------------------------------------------------
    # Screen content (serialized from the frontend xterm.js)
    # ------------------------------------------------------------------

    def set_screen_content(self, content: str) -> None:
        """Update the screen content cache (called by ws_handler)."""
        self._screen_content = content

    def get_screen_content(self) -> str:
        """Get the current screen content."""
        return self._screen_content

    # ------------------------------------------------------------------
    # Context (used for AI analysis)
    # ------------------------------------------------------------------

    def get_context(self, lines: int = 500) -> str:
        """Get the terminal context, preferring the screen content.

        If frontend-serialized screen content is available, return it directly (this is the most accurate rendered result).
        Otherwise fall back to the output buffer (the raw ANSI stream).
        """
        if self._screen_content:
            return self._screen_content[-5000:]  # take only the last part of the screen content to avoid it getting too large
        recent = list(self._output_buffer)[-lines:]
        return "\n".join(recent)
