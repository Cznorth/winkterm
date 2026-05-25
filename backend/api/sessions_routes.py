"""会话生命周期接口。

供前端实时感知 agent 创建/关闭的终端,自动同步标签栏。
鉴权:复用 web access key(X-Access-Key 头,或 SSE 用 ?key= 查询参数)。
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
    """HTTP/SSE 共用:localhost 放行,远程需 web access key。"""
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
    """用户显式关闭终端(tab X 按钮触发)。"""
    _require_auth(request, key)
    ok = get_session_manager().close_session(session_id)
    if not ok:
        raise HTTPException(status_code=404, detail="session not found")
    return {"ok": True, "session_id": session_id}


@router.get("")
async def list_sessions(request: Request, key: Optional[str] = Query(default=None)) -> dict:
    """列出全部用户可见的 session(供前端启动时重建标签栏)。"""
    _require_auth(request, key)
    sm = get_session_manager()
    sessions = [s for s in sm.list_terminals() if s.get("user_visible")]
    return {"sessions": sessions}


@router.get("/stream")
async def stream_sessions(
    request: Request,
    key: Optional[str] = Query(default=None, description="EventSource 兜底鉴权参数"),
) -> StreamingResponse:
    """SSE 推送 session 生命周期事件:session_created / session_closed。"""
    _require_auth(request, key)
    sm = get_session_manager()
    queue = sm.subscribe()

    async def gen():
        # 首屏:把现有可见 session 列表打包一次推下去
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
