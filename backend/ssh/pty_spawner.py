"""SSH PTY spawner."""

from __future__ import annotations

import asyncio
import logging
import re
import sys
from typing import Callable, Optional

from backend.ssh.models import SSHConnection

logger = logging.getLogger("ssh_spawner")


class SSHPtySpawner:
    """SSH PTY spawner."""

    # Password prompt patterns
    PASSWORD_PROMPT_PATTERNS = [
        rb"[Pp]assword:",
        rb"[Pp]assphrase for key",
    ]

    @staticmethod
    def build_ssh_command(conn: SSHConnection) -> list[str]:
        """Build the SSH command.

        Args:
            conn: SSH connection config

        Returns:
            List of SSH command arguments
        """
        cmd = ["ssh"]

        # Port
        cmd.extend(["-p", str(conn.port)])

        # Disable host key checking (suitable for intranet/first connection)
        cmd.extend(["-o", "StrictHostKeyChecking=no"])
        cmd.extend(["-o", "UserKnownHostsFile=/dev/null"])

        # Disable password cache prompt
        cmd.extend(["-o", "NumberOfPasswordPrompts=1"])

        # Key authentication
        if conn.auth_type == "key" and conn.private_key_path:
            cmd.extend(["-i", conn.private_key_path])

        # username@host
        cmd.append(f"{conn.username}@{conn.host}")

        logger.info(f"构建 SSH 命令: {' '.join(cmd)}")
        return cmd

    @staticmethod
    def build_ssh_command_str(conn: SSHConnection) -> str:
        """Build the SSH command string (for winpty)."""
        cmd = SSHPtySpawner.build_ssh_command(conn)
        return " ".join(cmd)

    @staticmethod
    def is_password_prompt(data: bytes) -> bool:
        """Detect whether this is a password prompt.

        Args:
            data: PTY output data

        Returns:
            Whether this is a password prompt
        """
        for pattern in SSHPtySpawner.PASSWORD_PROMPT_PATTERNS:
            if re.search(pattern, data):
                return True
        return False


class PasswordAutoInput:
    """Password auto-input handler (registered as a callback on PtyManager)."""

    def __init__(self, password: str, write_func: Callable[[bytes], None]):
        """Initialize the password auto-input handler.

        Args:
            password: SSH password
            write_func: Function to write to the PTY (PtyManager.write)
        """
        self.password = password
        self._write = write_func
        self._password_sent = False
        self._buffer = b""

    def __call__(self, data: bytes) -> None:
        """Called by PtyManager as a callback.

        Args:
            data: PTY output data
        """
        if self._password_sent:
            return

        # Accumulate buffer
        self._buffer += data

        # Detect password prompt
        if SSHPtySpawner.is_password_prompt(self._buffer):
            logger.info("[SSH] 检测到密码提示，准备自动发送密码")
            self._password_sent = True
            self._buffer = b""

            # Send the password after a delay
            import threading
            import time

            def _delayed_send():
                time.sleep(0.3)  # Delay so the user can see the prompt
                password_input = (self.password + "\n").encode("utf-8")
                self._write(password_input)
                logger.info("[SSH] 自动发送密码完成")

            threading.Thread(target=_delayed_send, daemon=True).start()

        # Clear the buffer when it grows too large
        if len(self._buffer) > 4096:
            self._buffer = self._buffer[-1024:]

    @property
    def password_sent(self) -> bool:
        """Whether the password has been sent."""
        return self._password_sent
