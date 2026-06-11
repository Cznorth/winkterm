from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, WebSocket, Query

from backend.terminal.ws_handler import TerminalWSHandler
from backend.api.ws_chat import ChatWSHandler
from backend.api.ws_agent import AgentWSHandler
from backend.api.auth_routes import ws_authorized
from backend.vnc.handler import VNCWSHandler

router = APIRouter()

# WebSocket close code for auth failure (custom 4xxx range)
_WS_AUTH_FAILED = 4401


@router.websocket("/terminal/{session_id}")
async def terminal_ws(
    websocket: WebSocket,
    session_id: str,
    type: str = Query(default="local"),
    connection_id: Optional[str] = Query(default=None),
    key: Optional[str] = Query(default=None),
) -> None:
    """WebSocket terminal connection entry.

    Args:
        session_id: Session ID
        type: Connection type, "local" or "ssh"
        connection_id: SSH connection ID (only when type="ssh")
        key: Web access key (required for remote access; localhost exempt)
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
    """WebSocket sidebar chat entry."""
    if not ws_authorized(websocket, key):
        await websocket.accept()
        await websocket.close(code=_WS_AUTH_FAILED)
        return

    handler = ChatWSHandler(websocket)
    await handler.handle()


@router.websocket("/agent")
async def agent_ws(
    websocket: WebSocket,
    token: Optional[str] = Query(default=None),
) -> None:
    """External agent WebSocket entry.

    Carries the full agent surface (terminals, SSH, files, jobs, events) as JSON
    messages, with application-level heartbeats so long-running commands survive a
    reverse-proxy idle timeout. Auth is the agent token (``?token=``); the handler
    validates it after accept and closes with 4401 on failure.
    """
    handler = AgentWSHandler(websocket, token)
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
