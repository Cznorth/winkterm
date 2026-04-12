from __future__ import annotations

from fastapi import APIRouter, WebSocket

from backend.terminal.ws_handler import TerminalWSHandler

router = APIRouter()


@router.websocket("/terminal")
async def terminal_ws(websocket: WebSocket) -> None:
    """WebSocket 终端连接入口。"""
    handler = TerminalWSHandler(websocket)
    await handler.handle()
