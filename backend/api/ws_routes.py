from __future__ import annotations

from fastapi import APIRouter, WebSocket

from backend.terminal.ws_handler import TerminalWSHandler
from backend.api.ws_chat import ChatWSHandler

router = APIRouter()


@router.websocket("/terminal/{session_id}")
async def terminal_ws(websocket: WebSocket, session_id: str) -> None:
    """WebSocket 终端连接入口（支持多会话）。"""
    handler = TerminalWSHandler(websocket, session_id)
    await handler.handle()


@router.websocket("/chat")
async def chat_ws(websocket: WebSocket) -> None:
    """WebSocket 侧边栏对话入口。"""
    handler = ChatWSHandler(websocket)
    await handler.handle()
