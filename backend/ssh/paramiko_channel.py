"""Paramiko-backed interactive shell channel.

Adapts a paramiko interactive shell channel to the duck-typed interface that
PtyManager expects from a winpty/ptyprocess process object: ``read``,
``write``, ``setwinsize``, ``isalive`` and ``terminate``.

Using paramiko's native authentication (password passed directly as a
parameter) removes the fragile "watch the pty output for a password prompt,
then type the password after a fixed delay" screen-scraping path, which raced
prompt arrival and broke on buffering/localized prompts.
"""

from __future__ import annotations

import logging
from pathlib import Path

import paramiko

from backend.ssh.models import SSHConnection

logger = logging.getLogger("ssh_paramiko")


class ParamikoAuthError(RuntimeError):
    """Authentication or connection failure (carries a user-facing message)."""


class ParamikoShellChannel:
    """A paramiko shell channel that quacks like a pty process."""

    def __init__(self, conn: SSHConnection, cols: int = 80, rows: int = 24) -> None:
        self._client = paramiko.SSHClient()
        self._client.load_system_host_keys()
        self._client.set_missing_host_key_policy(paramiko.AutoAddPolicy())

        connect_kwargs: dict = {
            "hostname": conn.host,
            "port": conn.port,
            "username": conn.username,
            "timeout": 15,
            "banner_timeout": 15,
            "auth_timeout": 15,
            "allow_agent": False,
            "look_for_keys": False,
        }

        if conn.auth_type == "password":
            connect_kwargs["password"] = conn.password or ""
        else:
            if conn.private_key_path:
                connect_kwargs["key_filename"] = str(Path(conn.private_key_path).expanduser())
            if conn.passphrase:
                connect_kwargs["passphrase"] = conn.passphrase
            if not conn.private_key_path:
                connect_kwargs["allow_agent"] = True
                connect_kwargs["look_for_keys"] = True

        try:
            self._client.connect(**connect_kwargs)
        except paramiko.AuthenticationException as exc:
            self._client.close()
            raise ParamikoAuthError("SSH 认证失败：用户名或密码错误") from exc
        except Exception as exc:
            self._client.close()
            raise ParamikoAuthError(f"SSH 连接失败：{exc}") from exc

        self._channel = self._client.invoke_shell(
            term="xterm-256color", width=cols, height=rows
        )
        # Blocking recv: the read thread waits on data and stops on channel EOF.
        self._channel.settimeout(None)
        self.pid = "paramiko"
        logger.info(
            f"[PARAMIKO] shell channel opened {conn.username}@{conn.host}:{conn.port}"
        )

    def read(self, size: int = 4096) -> bytes:
        """Blocking read; returns b'' when the channel is closed (signals EOF)."""
        try:
            return self._channel.recv(size)
        except Exception:
            return b""

    def write(self, data) -> None:
        if isinstance(data, str):
            data = data.encode("utf-8")
        try:
            self._channel.sendall(data)
        except Exception as exc:
            logger.error(f"[PARAMIKO] send failed: {exc}")

    def setwinsize(self, rows: int, cols: int) -> None:
        try:
            self._channel.resize_pty(width=cols, height=rows)
        except Exception:
            pass

    def isalive(self) -> bool:
        chan = getattr(self, "_channel", None)
        if chan is None or chan.exit_status_ready():
            return False
        transport = self._client.get_transport()
        return bool(transport and transport.is_active())

    def terminate(self, force: bool = False) -> None:
        try:
            if getattr(self, "_channel", None):
                self._channel.close()
        except Exception:
            pass
        try:
            self._client.close()
        except Exception:
            pass
