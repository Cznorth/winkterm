"""Web remote access authentication.

Desktop client (pywebview loading 127.0.0.1) comes from localhost and is exempt.
Remote browser access requires an access key (X-Access-Key header / WebSocket key query param).
On first remote access without a configured key, setup is required.
"""

from __future__ import annotations

import secrets

from fastapi import APIRouter, HTTPException, Request, WebSocket
from pydantic import BaseModel

from backend.config import UserConfig, settings

_LOCAL_HOSTS = {"127.0.0.1", "::1", "localhost"}


def _normalize_host(host: str | None) -> str:
    """Normalize client host; strip IPv4-mapped IPv6 prefix."""
    if not host:
        return ""
    if host.startswith("::ffff:"):
        return host[7:]
    return host


def is_local_request(request: Request) -> bool:
    """Return whether the HTTP request is from localhost."""
    host = request.client.host if request.client else None
    return _normalize_host(host) in _LOCAL_HOSTS


def is_local_ws(websocket: WebSocket) -> bool:
    """Return whether the WebSocket connection is from localhost."""
    host = websocket.client.host if websocket.client else None
    return _normalize_host(host) in _LOCAL_HOSTS


def resolve_web_key() -> str:
    """Prefer the key persisted on the settings page, then env var WEB_ACCESS_KEY."""
    return UserConfig.load().get("web_access_key") or settings.web_access_key


def verify_web_key(provided: str) -> bool:
    """Constant-time comparison of the access key."""
    key = resolve_web_key()
    if not key or not provided:
        return False
    return secrets.compare_digest(str(provided), str(key))


def require_web_auth(request: Request) -> None:
    """HTTP route auth dependency: localhost allowed, remote requires key."""
    if is_local_request(request):
        return
    if not resolve_web_key():
        # No key configured: frontend uses this to prompt key setup
        raise HTTPException(status_code=401, detail="SETUP_REQUIRED")
    if not verify_web_key(request.headers.get("X-Access-Key", "")):
        raise HTTPException(status_code=401, detail="AUTH_REQUIRED")


def ws_authorized(websocket: WebSocket, key: str | None) -> bool:
    """WebSocket auth: localhost allowed, remote requires key."""
    if is_local_ws(websocket):
        return True
    return verify_web_key(key or "")


# -----------------------------------------------------------
# Auth routes (these endpoints do not require auth themselves)
# -----------------------------------------------------------

router = APIRouter(prefix="/api/auth", tags=["auth"])


class KeyBody(BaseModel):
    key: str


@router.get("/status")
async def auth_status(request: Request) -> dict:
    """Return auth status for the current client; frontend uses this to show the auth overlay."""
    local = is_local_request(request)
    configured = bool(resolve_web_key())
    authenticated = local or (
        configured and verify_web_key(request.headers.get("X-Access-Key", ""))
    )
    return {"local": local, "configured": configured, "authenticated": authenticated}


@router.post("/setup")
async def auth_setup(body: KeyBody) -> dict:
    """Set the access key for the first time. Only allowed when no key is configured yet."""
    if resolve_web_key():
        raise HTTPException(status_code=400, detail="访问密钥已设置")
    key = body.key.strip()
    if len(key) < 4:
        raise HTTPException(status_code=400, detail="密钥至少 4 个字符")
    UserConfig.merge_save({"web_access_key": key})
    return {"success": True}


@router.post("/login")
async def auth_login(body: KeyBody) -> dict:
    """Verify the access key."""
    if not resolve_web_key():
        raise HTTPException(status_code=400, detail="尚未设置访问密钥")
    if not verify_web_key(body.key):
        raise HTTPException(status_code=401, detail="密钥错误")
    return {"success": True}
