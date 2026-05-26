from __future__ import annotations

import asyncio
import logging
import socket
from typing import Optional

import paramiko
from fastapi import WebSocket, WebSocketDisconnect

logger = logging.getLogger("vnc_proxy")


class VNCProxyError(Exception):
    """VNC proxy error."""


class VNCProxy:
    """Bidirectional proxy: WebSocket ↔ VNC port via SSH direct-tcpip tunnel."""

    CHUNK_SIZE = 65536
    RECV_TIMEOUT = 1.0

    def __init__(
        self,
        websocket: WebSocket,
        ssh_client: paramiko.SSHClient,
        vnc_port: int = 5901,
    ) -> None:
        self.ws = websocket
        self.ssh_client = ssh_client
        self.vnc_port = vnc_port
        self._channel: Optional[paramiko.Channel] = None
        self._closed = False

    def _open_tunnel(self) -> paramiko.Channel:
        transport = self.ssh_client.get_transport()
        if not transport or not transport.is_active():
            raise VNCProxyError("SSH transport is not active")
        channel: Optional[paramiko.Channel] = transport.open_channel(
            "direct-tcpip",
            ("127.0.0.1", self.vnc_port),
            ("127.0.0.1", 0),
            timeout=10,
        )
        if not channel:
            raise VNCProxyError(
                f"SSH tunnel to 127.0.0.1:{self.vnc_port} was rejected"
            )
        channel.settimeout(self.RECV_TIMEOUT)
        logger.info("VNC tunnel established: 127.0.0.1:%d", self.vnc_port)
        return channel

    def _send_all(self, data: bytes) -> None:
        if not self._channel:
            raise EOFError("SSH channel not available")
        while data:
            sent = self._channel.send(data)
            if sent == 0:
                raise EOFError("SSH channel closed while sending")
            data = data[sent:]

    async def proxy(self) -> None:
        """Run bidirectional proxy until either side disconnects."""
        logger.info("Opening VNC tunnel to 127.0.0.1:%d", self.vnc_port)
        self._channel = await asyncio.to_thread(self._open_tunnel)

        t1 = asyncio.create_task(self._pump_ws_to_ssh())
        t2 = asyncio.create_task(self._pump_ssh_to_ws())

        try:
            done, pending = await asyncio.wait(
                [t1, t2], return_when=asyncio.FIRST_COMPLETED
            )
            for task in pending:
                task.cancel()
        finally:
            await self._close()

    async def _pump_ws_to_ssh(self) -> None:
        while not self._closed:
            try:
                data = await self.ws.receive_bytes()
                if self._closed:
                    break
                await asyncio.to_thread(self._send_all, data)
            except WebSocketDisconnect:
                break
            except Exception:
                logger.exception("WS→SSH pump error")
                break

    async def _pump_ssh_to_ws(self) -> None:
        while not self._closed:
            try:
                data = await asyncio.to_thread(self._channel.recv, self.CHUNK_SIZE)
                if not data:
                    break
                await self.ws.send_bytes(data)
            except socket.timeout:
                continue
            except WebSocketDisconnect:
                break
            except (EOFError, OSError):
                break
            except Exception:
                logger.exception("SSH→WS pump error")
                break

    async def _close(self) -> None:
        if self._closed:
            return
        self._closed = True
        if self._channel is not None and self._channel.active:
            try:
                self._channel.close()
            except Exception:
                pass
        logger.info("VNC proxy cleaned up")
