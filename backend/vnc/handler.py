from __future__ import annotations

import asyncio
import json
import logging
from pathlib import Path
from typing import Optional

import paramiko
from fastapi import WebSocket, WebSocketDisconnect

from backend.ssh.connection_manager import SSHConnectionManager
from backend.vnc.proxy import VNCProxy, VNCProxyError

logger = logging.getLogger("vnc_handler")


def _connect_ssh(conn) -> paramiko.SSHClient:
    """Connect SSH (runs in executor thread). Reuses paramiko patterns
    from backend.ssh.file_transfer."""
    client = paramiko.SSHClient()
    client.load_system_host_keys()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())

    kwargs: dict = {
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
        kwargs["password"] = conn.password or ""
    else:
        if conn.private_key_path:
            kwargs["key_filename"] = str(
                Path(conn.private_key_path).expanduser()
            )
        if conn.passphrase:
            kwargs["passphrase"] = conn.passphrase
        if not conn.private_key_path:
            kwargs["allow_agent"] = True
            kwargs["look_for_keys"] = True

    client.connect(**kwargs)
    return client


class VNCWSHandler:
    """WebSocket handler for VNC over SSH tunnel.

    On connect:
      1. Sends JSON metadata (VNC password if provided) to frontend.
      2. Opens SSH connection using stored credentials.
      3. Starts bidirectional VNC proxy via SSH direct-tcpip tunnel.
    """

    def __init__(
        self,
        websocket: WebSocket,
        connection_id: str,
        port: int = 5901,
        password: str | None = None,
    ) -> None:
        self.ws = websocket
        self.connection_id = connection_id
        self.port = port
        self.password = password
        self._ssh_client: paramiko.SSHClient | None = None

    async def handle(self) -> None:
        await self.ws.accept()
        logger.info(
            "VNC WS accepted: connection_id=%s port=%d",
            self.connection_id, self.port,
        )

        # Load SSH connection
        conn = SSHConnectionManager.get_connection(self.connection_id)
        if not conn:
            logger.error("SSH connection not found: %s", self.connection_id)
            await self._send_error(
                f"SSH connection not found: {self.connection_id}"
            )
            return

        # Connect SSH (blocking I/O in executor)
        try:
            self._ssh_client = await asyncio.to_thread(_connect_ssh, conn)
            logger.info("SSH connected: %s@%s", conn.username, conn.host)
        except Exception as e:
            logger.error("SSH connection failed: %s", e)
            await self._send_error(f"SSH connection failed: {e}")
            return

        # Start bidirectional VNC proxy
        proxy = VNCProxy(self.ws, self._ssh_client, vnc_port=self.port)
        try:
            await proxy.proxy()
        except WebSocketDisconnect:
            logger.info("VNC WebSocket disconnected")
        except VNCProxyError as e:
            logger.error("VNC proxy error: %s", e)
            await self._send_error(str(e))
        except Exception as e:
            logger.exception("VNC unexpected error: %s", e)
        finally:
            await self._cleanup()

    async def _send_error(self, message: str) -> None:
        try:
            await self.ws.send_text(json.dumps({
                "type": "error",
                "message": message,
            }))
        except Exception:
            pass
        try:
            await self.ws.close(code=4000)
        except Exception:
            pass

    async def _cleanup(self) -> None:
        if self._ssh_client is not None:
            try:
                self._ssh_client.close()
            except Exception:
                pass
            self._ssh_client = None
        logger.info("VNC handler cleaned up")
