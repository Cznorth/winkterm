from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, WebSocket, Query

from backend.terminal.ws_handler import TerminalWSHandler
from backend.api.ws_chat import ChatWSHandler
from backend.api.auth_routes import ws_authorized
from backend.vnc.handler import VNCWSHandler

router = APIRouter()

# WebSocket 鉴权失败的关闭码（自定义 4xxx 区间）
_WS_AUTH_FAILED = 4401


@router.websocket("/terminal/{session_id}")
async def terminal_ws(
    websocket: WebSocket,
    session_id: str,
    type: str = Query(default="local"),
    connection_id: Optional[str] = Query(default=None),
    key: Optional[str] = Query(default=None),
) -> None:
    """WebSocket 终端连接入口。

    Args:
        session_id: 会话 ID
        type: 连接类型，"local" 或 "ssh"
        connection_id: SSH 连接 ID（仅 type="ssh" 时有效）
        key: Web 访问密钥（远程访问时必填，localhost 免鉴权）
    """
    if not ws_authorized(websocket, key):
        await websocket.accept()
        await websocket.close(code=_WS_AUTH_FAILED)
        return

    handler = TerminalWSHandler(
        websocket,
        session_id,
        terminal_type=type,
        ssh_connection_id=connection_id,
    )
    await handler.handle()


@router.websocket("/chat")
async def chat_ws(
    websocket: WebSocket,
    key: Optional[str] = Query(default=None),
) -> None:
    """WebSocket 侧边栏对话入口。"""
    if not ws_authorized(websocket, key):
        await websocket.accept()
        await websocket.close(code=_WS_AUTH_FAILED)
        return

    handler = ChatWSHandler(websocket)
    await handler.handle()


@router.websocket("/vnc/{session_id}")
async def vnc_ws(
    websocket: WebSocket,
    session_id: str,
    connection_id: str = Query(...),
    port: int = Query(default=5901),
    password: Optional[str] = Query(default=None),
    key: Optional[str] = Query(default=None),
) -> None:
    """WebSocket VNC over SSH tunnel.

    Args:
        session_id: client-assigned session identifier
        connection_id: SSH connection ID (stored in config.json)
        port: VNC server port on the remote host (default 5901)
        password: optional VNC password, forwarded to the frontend/noVNC
                  client as JSON metadata before binary proxy starts
        key: Web access key (remote auth, localhost exempt)
    """
    if not ws_authorized(websocket, key):
        await websocket.accept()
        await websocket.close(code=_WS_AUTH_FAILED)
        return

    handler = VNCWSHandler(
        websocket,
        connection_id=connection_id,
        port=port,
        password=password,
    )
    await handler.handle()
