"""SSH 连接 API 路由。"""

from __future__ import annotations

from typing import Annotated, Optional
from urllib.parse import quote

from fastapi import APIRouter, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from backend.ssh.connection_manager import SSHConnectionManager
from backend.ssh.file_transfer import (
    SSHFileExistsError,
    SSHFileNotFoundError,
    SSHFileTransfer,
    SSHFileTransferError,
    SSHInvalidPathError,
)
from backend.ssh.transfer_jobs import TransferJobManager

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


class SSHLocalUploadRequest(BaseModel):
    """桌面模式：本地路径上传请求。"""

    local_path: str
    remote_path: str
    overwrite: bool = False


class SSHLocalDownloadRequest(BaseModel):
    """桌面模式：下载到本地路径请求。"""

    remote_path: str
    local_path: str


class SSHDirectoryCreateRequest(BaseModel):
    """远端目录创建请求。"""

    path: str


class SSHFileContentUpdateRequest(BaseModel):
    """文本文件内容更新请求。"""

    path: str
    content: str
    encoding: str = "utf-8"


class SSHDeletePathsRequest(BaseModel):
    """批量删除远端路径请求。"""

    paths: list[str]


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


def _get_connection_or_404(conn_id: str):
    conn = SSHConnectionManager.get_connection(conn_id)
    if not conn:
        raise HTTPException(status_code=404, detail="SSH 连接不存在")
    return conn


def _raise_transfer_error(exc: Exception) -> None:
    if isinstance(exc, SSHFileExistsError):
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    if isinstance(exc, SSHFileNotFoundError):
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    if isinstance(exc, SSHInvalidPathError):
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if isinstance(exc, SSHFileTransferError):
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    raise HTTPException(status_code=500, detail="文件传输失败") from exc


@router.post("/connections/{conn_id}/transfer/upload")
def upload_file(
    conn_id: str,
    remote_path: Annotated[str, Form(...)],
    overwrite: Annotated[bool, Form()] = False,
    file: UploadFile = File(...),
) -> dict:
    """浏览器模式：上传文件到远端。"""
    conn = _get_connection_or_404(conn_id)

    if not file.filename:
        raise HTTPException(status_code=400, detail="请选择要上传的文件")

    try:
        destination = SSHFileTransfer.upload_file_obj(
            conn,
            file.file,
            remote_path,
            file.filename,
            overwrite=overwrite,
        )
        return {
            "success": True,
            "file_name": file.filename,
            "remote_path": destination,
        }
    except Exception as exc:
        _raise_transfer_error(exc)
    finally:
        file.file.close()


@router.get("/connections/{conn_id}/files")
def list_remote_files(
    conn_id: str,
    path: Annotated[str | None, Query()] = None,
) -> dict:
    """列出远端目录。"""
    conn = _get_connection_or_404(conn_id)

    try:
        return SSHFileTransfer.list_directory(conn, path)
    except Exception as exc:
        _raise_transfer_error(exc)


@router.get("/connections/{conn_id}/files/content")
def get_file_content(
    conn_id: str,
    path: Annotated[str, Query(...)],
) -> dict:
    """读取文本文件内容。"""
    conn = _get_connection_or_404(conn_id)

    try:
        return SSHFileTransfer.read_text_file(conn, path)
    except Exception as exc:
        _raise_transfer_error(exc)


@router.put("/connections/{conn_id}/files/content")
def update_file_content(conn_id: str, data: SSHFileContentUpdateRequest) -> dict:
    """保存文本文件内容。"""
    conn = _get_connection_or_404(conn_id)

    try:
        return SSHFileTransfer.write_text_file(conn, data.path, data.content, data.encoding)
    except Exception as exc:
        _raise_transfer_error(exc)


@router.post("/connections/{conn_id}/directories")
def create_remote_directory(conn_id: str, data: SSHDirectoryCreateRequest) -> dict:
    """创建远端目录。"""
    conn = _get_connection_or_404(conn_id)

    try:
        created_path = SSHFileTransfer.create_directory(conn, data.path)
        return {
            "success": True,
            "path": created_path,
        }
    except Exception as exc:
        _raise_transfer_error(exc)


@router.delete("/connections/{conn_id}/paths")
def delete_remote_paths(conn_id: str, data: SSHDeletePathsRequest) -> dict:
    """批量删除远端文件或目录。"""
    conn = _get_connection_or_404(conn_id)

    try:
        result = SSHFileTransfer.delete_paths(conn, data.paths)
        return {
            "success": True,
            **result,
        }
    except Exception as exc:
        _raise_transfer_error(exc)


@router.post("/connections/{conn_id}/transfer/jobs/upload-local")
def upload_local_file_job(conn_id: str, data: SSHLocalUploadRequest) -> dict:
    """桌面模式：创建本地上传任务。"""
    conn = _get_connection_or_404(conn_id)

    try:
        job = TransferJobManager.start_upload_job(conn, data.local_path, data.remote_path, overwrite=data.overwrite)
        return {
            "success": True,
            "job": job,
        }
    except Exception as exc:
        _raise_transfer_error(exc)


@router.post("/connections/{conn_id}/transfer/upload-local")
def upload_local_file(conn_id: str, data: SSHLocalUploadRequest) -> dict:
    """桌面模式：直接从本地路径上传。"""
    conn = _get_connection_or_404(conn_id)

    try:
        destination = SSHFileTransfer.upload_local_file(
            conn,
            data.local_path,
            data.remote_path,
            overwrite=data.overwrite,
        )
        return {
            "success": True,
            "local_path": data.local_path,
            "remote_path": destination,
        }
    except Exception as exc:
        _raise_transfer_error(exc)


@router.get("/connections/{conn_id}/transfer/jobs/{job_id}")
def get_transfer_job(conn_id: str, job_id: str) -> dict:
    """获取传输任务状态。"""
    _get_connection_or_404(conn_id)
    job = TransferJobManager.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="传输任务不存在")
    return {"job": job}


@router.get("/connections/{conn_id}/transfer/download")
def download_file(
    conn_id: str,
    remote_path: Annotated[str, Query(...)],
):
    """浏览器模式：下载远端文件。"""
    conn = _get_connection_or_404(conn_id)

    try:
        iterator, file_name, file_size = SSHFileTransfer.create_download_stream(conn, remote_path)
    except Exception as exc:
        _raise_transfer_error(exc)

    headers = {
        "Content-Disposition": f"attachment; filename*=UTF-8''{quote(file_name)}",
    }
    if file_size is not None:
        headers["Content-Length"] = str(file_size)

    return StreamingResponse(
        iterator,
        media_type="application/octet-stream",
        headers=headers,
    )


@router.post("/connections/{conn_id}/transfer/jobs/download-local")
def download_local_file_job(conn_id: str, data: SSHLocalDownloadRequest) -> dict:
    """桌面模式：创建本地下载任务。"""
    conn = _get_connection_or_404(conn_id)

    try:
        job = TransferJobManager.start_download_job(conn, data.remote_path, data.local_path)
        return {
            "success": True,
            "job": job,
        }
    except Exception as exc:
        _raise_transfer_error(exc)


@router.post("/connections/{conn_id}/transfer/download-local")
def download_local_file(conn_id: str, data: SSHLocalDownloadRequest) -> dict:
    """桌面模式：直接下载到本地路径。"""
    conn = _get_connection_or_404(conn_id)

    try:
        source = SSHFileTransfer.download_to_local_file(conn, data.remote_path, data.local_path)
        return {
            "success": True,
            "remote_path": source,
            "local_path": data.local_path,
        }
    except Exception as exc:
        _raise_transfer_error(exc)
