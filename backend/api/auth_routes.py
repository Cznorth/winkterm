"""Web 远程访问鉴权。

桌面客户端（pywebview 加载 127.0.0.1）来自 localhost，免鉴权。
远程浏览器访问需携带访问密钥（X-Access-Key 头 / WebSocket key 查询参数）。
首次远程访问且未配置密钥时，强制要求设置密钥。
"""

from __future__ import annotations

import secrets

from fastapi import APIRouter, HTTPException, Request, WebSocket
from pydantic import BaseModel

from backend.config import UserConfig, settings

_LOCAL_HOSTS = {"127.0.0.1", "::1", "localhost"}


def _normalize_host(host: str | None) -> str:
    """归一化客户端 host，去除 IPv4-mapped IPv6 前缀。"""
    if not host:
        return ""
    if host.startswith("::ffff:"):
        return host[7:]
    return host


def is_local_request(request: Request) -> bool:
    """判断 HTTP 请求是否来自本机。"""
    host = request.client.host if request.client else None
    return _normalize_host(host) in _LOCAL_HOSTS


def is_local_ws(websocket: WebSocket) -> bool:
    """判断 WebSocket 连接是否来自本机。"""
    host = websocket.client.host if websocket.client else None
    return _normalize_host(host) in _LOCAL_HOSTS


def resolve_web_key() -> str:
    """优先用设置页持久化的密钥，其次用环境变量 WEB_ACCESS_KEY。"""
    return UserConfig.load().get("web_access_key") or settings.web_access_key


def verify_web_key(provided: str) -> bool:
    """常量时间比较访问密钥。"""
    key = resolve_web_key()
    if not key or not provided:
        return False
    return secrets.compare_digest(str(provided), str(key))


def require_web_auth(request: Request) -> None:
    """HTTP 路由鉴权依赖：localhost 放行，远程需密钥。"""
    if is_local_request(request):
        return
    if not resolve_web_key():
        # 未配置密钥：前端据此引导用户设置密钥
        raise HTTPException(status_code=401, detail="SETUP_REQUIRED")
    if not verify_web_key(request.headers.get("X-Access-Key", "")):
        raise HTTPException(status_code=401, detail="AUTH_REQUIRED")


def ws_authorized(websocket: WebSocket, key: str | None) -> bool:
    """WebSocket 鉴权：localhost 放行，远程需密钥。"""
    if is_local_ws(websocket):
        return True
    return verify_web_key(key or "")


# -----------------------------------------------------------
# 鉴权路由（自身不需要鉴权）
# -----------------------------------------------------------

router = APIRouter(prefix="/api/auth", tags=["auth"])


class KeyBody(BaseModel):
    key: str


@router.get("/status")
async def auth_status(request: Request) -> dict:
    """返回当前访问端的鉴权状态，供前端决定是否弹出鉴权浮层。"""
    local = is_local_request(request)
    configured = bool(resolve_web_key())
    authenticated = local or (
        configured and verify_web_key(request.headers.get("X-Access-Key", ""))
    )
    return {"local": local, "configured": configured, "authenticated": authenticated}


@router.post("/setup")
async def auth_setup(body: KeyBody) -> dict:
    """首次设置访问密钥。仅在尚未配置密钥时允许。"""
    if resolve_web_key():
        raise HTTPException(status_code=400, detail="访问密钥已设置")
    key = body.key.strip()
    if len(key) < 4:
        raise HTTPException(status_code=400, detail="密钥至少 4 个字符")
    UserConfig.merge_save({"web_access_key": key})
    return {"success": True}


@router.post("/login")
async def auth_login(body: KeyBody) -> dict:
    """校验访问密钥。"""
    if not resolve_web_key():
        raise HTTPException(status_code=400, detail="尚未设置访问密钥")
    if not verify_web_key(body.key):
        raise HTTPException(status_code=401, detail="密钥错误")
    return {"success": True}
