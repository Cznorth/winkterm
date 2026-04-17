"""SSH 连接 API 路由。"""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from backend.ssh.connection_manager import SSHConnectionManager

router = APIRouter(prefix="/api/ssh", tags=["ssh"])


# -----------------------------------------------------------
# 请求模型
# -----------------------------------------------------------

class SSHConnectionCreate(BaseModel):
    """创建 SSH 连接请求。"""
    title: str = ""
    host: str
    port: int = 22
    username: str
    auth_type: str = "password"
    password: Optional[str] = None
    private_key_path: Optional[str] = None
    passphrase: Optional[str] = None
    color: Optional[str] = None
    group: Optional[str] = None


class SSHConnectionUpdate(BaseModel):
    """更新 SSH 连接请求。"""
    title: Optional[str] = None
    host: Optional[str] = None
    port: Optional[int] = None
    username: Optional[str] = None
    auth_type: Optional[str] = None
    password: Optional[str] = None
    private_key_path: Optional[str] = None
    passphrase: Optional[str] = None
    color: Optional[str] = None
    group: Optional[str] = None


class ElectermImport(BaseModel):
    """electerm 导入请求。"""
    bookmarks: list[dict]


# -----------------------------------------------------------
# API 端点
# -----------------------------------------------------------

@router.get("/connections")
async def list_connections() -> dict:
    """列出所有 SSH 连接（密码脱敏）。"""
    return SSHConnectionManager.list_connections()


@router.post("/connections")
async def create_connection(conn: SSHConnectionCreate) -> dict:
    """创建新的 SSH 连接。"""
    if not conn.host:
        raise HTTPException(status_code=400, detail="主机地址不能为空")
    if not conn.username:
        raise HTTPException(status_code=400, detail="用户名不能为空")

    return SSHConnectionManager.create_connection(conn.model_dump())


@router.put("/connections/{conn_id}")
async def update_connection(conn_id: str, conn: SSHConnectionUpdate) -> dict:
    """更新 SSH 连接。"""
    result = SSHConnectionManager.update_connection(conn_id, conn.model_dump(exclude_none=True))
    if not result.get("success"):
        raise HTTPException(status_code=404, detail="连接不存在")
    return result


@router.delete("/connections/{conn_id}")
async def delete_connection(conn_id: str) -> dict:
    """删除 SSH 连接。"""
    return SSHConnectionManager.delete_connection(conn_id)


@router.post("/import/electerm")
async def import_electerm(data: ElectermImport) -> dict:
    """导入 electerm 配置。"""
    if not data.bookmarks:
        raise HTTPException(status_code=400, detail="没有可导入的配置")

    return SSHConnectionManager.import_from_electerm(data.bookmarks)
