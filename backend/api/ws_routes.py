from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, WebSocket, Query

from backend.terminal.ws_handler import TerminalWSHandler
from backend.api.ws_chat import ChatWSHandler

router = APIRouter()


@router.websocket("/terminal/{session_id}")
async def terminal_ws(
    websocket: WebSocket,
    session_id: str,
    type: str = Query(default="local"),
    connection_id: Optional[str] = Query(default=None),
) -> None:
    """WebSocket 终端连接入口。

    Args:
        session_id: 会话 ID
        type: 连接类型，"local" 或 "ssh"
        connection_id: SSH 连接 ID（仅 type="ssh" 时有效）
    """
    handler = TerminalWSHandler(
        websocket,
        session_id,
        terminal_type=type,
        ssh_connection_id=connection_id,
    )
    await handler.handle()


@router.websocket("/chat")
async def chat_ws(websocket: WebSocket) -> None:
    """WebSocket 侧边栏对话入口。"""
    handler = ChatWSHandler(websocket)
    await handler.handle()
