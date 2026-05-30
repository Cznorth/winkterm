"""Session lifecycle API.

Lets the frontend observe agent-created/closed terminals and sync the tab bar in real time.
Auth: reuses web access key (X-Access-Key header, or ?key= for SSE).
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import StreamingResponse

from backend.api.auth_routes import (
    is_local_request,
    resolve_web_key,
    verify_web_key,
)
from backend.terminal.session_manager import get_session_manager

logger = logging.getLogger("sessions_routes")

router = APIRouter(prefix="/api/sessions", tags=["sessions"])


def _require_auth(request: Request, key: Optional[str] = None) -> None:
    """Shared HTTP/SSE auth: localhost allowed, remote requires web access key."""
    if is_local_request(request):
        return
    web_key = resolve_web_key()
    if not web_key:
        raise HTTPException(status_code=401, detail="SETUP_REQUIRED")
    provided = key or request.headers.get("X-Access-Key", "")
    if not verify_web_key(provided):
        raise HTTPException(status_code=401, detail="AUTH_REQUIRED")


def _sse_format(event_name: str, data: dict, event_id: Optional[str] = None) -> bytes:
    lines: list[str] = []
    if event_id is not None:
        lines.append(f"id: {event_id}")
    lines.append(f"event: {event_name}")
    lines.append(f"data: {json.dumps(data, ensure_ascii=False)}")
    lines.append("")
    lines.append("")
    return "\n".join(lines).encode("utf-8")


@router.delete("/{session_id}")
async def close_session(
    session_id: str,
    request: Request,
    key: Optional[str] = Query(default=None),
) -> dict:
    """User explicitly closes a terminal (tab X button)."""
    _require_auth(request, key)
    ok = get_session_manager().close_session(session_id)
    if not ok:
        raise HTTPException(status_code=404, detail="session not found")
    return {"ok": True, "session_id": session_id}


@router.get("")
async def list_sessions(request: Request, key: Optional[str] = Query(default=None)) -> dict:
    """List all user-visible sessions (for frontend tab bar rebuild on startup)."""
    _require_auth(request, key)
    sm = get_session_manager()
    sessions = [s for s in sm.list_terminals() if s.get("user_visible")]
    return {"sessions": sessions}


@router.get("/stream")
async def stream_sessions(
    request: Request,
    key: Optional[str] = Query(default=None, description="EventSource fallback auth param"),
) -> StreamingResponse:
    """SSE stream of session lifecycle events: session_created / session_closed."""
    _require_auth(request, key)
    sm = get_session_manager()
    queue = sm.subscribe()

    async def gen():
        # Initial snapshot: push current visible session list once
        snapshot = [s for s in sm.list_terminals() if s.get("user_visible")]
        yield _sse_format("snapshot", {"sessions": snapshot})

        try:
            while True:
                try:
                    evt = await asyncio.wait_for(queue.get(), timeout=15.0)
                except asyncio.TimeoutError:
                    yield _sse_format("heartbeat", {})
                    continue
                event_name = evt.get("type", "event")
                yield _sse_format(event_name, evt)
        except asyncio.CancelledError:
            return
        finally:
            sm.unsubscribe(queue)

    headers = {"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}
    return StreamingResponse(gen(), media_type="text/event-stream", headers=headers)
