from __future__ import annotations

from fastapi import APIRouter, WebSocket

from backend.terminal.ws_handler import TerminalWSHandler
from backend.api.ws_chat import ChatWSHandler

router = APIRouter()


@router.websocket("/terminal")
async def terminal_ws(websocket: WebSocket) -> None:
    """WebSocket 终端连接入口。"""
    handler = TerminalWSHandler(websocket)
    await handler.handle()


@router.websocket("/chat")
async def chat_ws(websocket: WebSocket) -> None:
    """WebSocket 侧边栏对话入口。"""
    handler = ChatWSHandler(websocket)
    await handler.handle()
