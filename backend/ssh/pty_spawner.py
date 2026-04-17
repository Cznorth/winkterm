"""SSH PTY 启动器。"""

from __future__ import annotations

import asyncio
import logging
import re
import sys
from typing import Callable, Optional

from backend.ssh.models import SSHConnection

logger = logging.getLogger("ssh_spawner")


class SSHPtySpawner:
    """SSH PTY 启动器。"""

    # 密码提示模式
    PASSWORD_PROMPT_PATTERNS = [
        rb"[Pp]assword:",
        rb"[Pp]assphrase for key",
    ]

    @staticmethod
    def build_ssh_command(conn: SSHConnection) -> list[str]:
        """构建 SSH 命令。

        Args:
            conn: SSH 连接配置

        Returns:
            SSH 命令参数列表
        """
        cmd = ["ssh"]

        # 端口
        cmd.extend(["-p", str(conn.port)])

        # 禁用主机密钥检查（适合内网/首次连接）
        cmd.extend(["-o", "StrictHostKeyChecking=no"])
        cmd.extend(["-o", "UserKnownHostsFile=/dev/null"])

        # 禁用密码缓存提示
        cmd.extend(["-o", "NumberOfPasswordPrompts=1"])

        # 密钥认证
        if conn.auth_type == "key" and conn.private_key_path:
            cmd.extend(["-i", conn.private_key_path])

        # 用户名@主机
        cmd.append(f"{conn.username}@{conn.host}")

        logger.info(f"构建 SSH 命令: {' '.join(cmd)}")
        return cmd

    @staticmethod
    def build_ssh_command_str(conn: SSHConnection) -> str:
        """构建 SSH 命令字符串（用于 winpty）。"""
        cmd = SSHPtySpawner.build_ssh_command(conn)
        return " ".join(cmd)

    @staticmethod
    def is_password_prompt(data: bytes) -> bool:
        """检测是否是密码提示。

        Args:
            data: PTY 输出数据

        Returns:
            是否是密码提示
        """
        for pattern in SSHPtySpawner.PASSWORD_PROMPT_PATTERNS:
            if re.search(pattern, data):
                return True
        return False


class PasswordAutoInput:
    """密码自动输入处理器（作为回调注册到 PtyManager）。"""

    def __init__(self, password: str, write_func: Callable[[bytes], None]):
        """初始化密码自动输入处理器。

        Args:
            password: SSH 密码
            write_func: 写入 PTY 的函数（PtyManager.write）
        """
        self.password = password
        self._write = write_func
        self._password_sent = False
        self._buffer = b""

    def __call__(self, data: bytes) -> None:
        """作为回调被 PtyManager 调用。

        Args:
            data: PTY 输出数据
        """
        if self._password_sent:
            return

        # 累积缓冲区
        self._buffer += data

        # 检测密码提示
        if SSHPtySpawner.is_password_prompt(self._buffer):
            logger.info("[SSH] 检测到密码提示，准备自动发送密码")
            self._password_sent = True
            self._buffer = b""

            # 延迟发送密码
            import threading
            import time

            def _delayed_send():
                time.sleep(0.3)  # 延迟让用户看到提示
                password_input = (self.password + "\n").encode("utf-8")
                self._write(password_input)
                logger.info("[SSH] 自动发送密码完成")

            threading.Thread(target=_delayed_send, daemon=True).start()

        # 缓冲区过大时清空
        if len(self._buffer) > 4096:
            self._buffer = self._buffer[-1024:]

    @property
    def password_sent(self) -> bool:
        """密码是否已发送。"""
        return self._password_sent
