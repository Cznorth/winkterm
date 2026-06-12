"""SSH connection API routes."""

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
# Request models
# -----------------------------------------------------------

class SSHConnectionCreate(BaseModel):
    """Create SSH connection request."""
    title: str = ""
    host: str
    port: int = 22
    username: str
    auth_type: str = "password"
    password: Optional[str] = None
    private_key_path: Optional[str] = None
    passphrase: Optional[str] = None
    vnc_port: int = 5901
    vnc_password: Optional[str] = None
    color: Optional[str] = None
    group: Optional[str] = None
    runbook: str = ""


class SSHConnectionUpdate(BaseModel):
    """Update SSH connection request."""
    title: Optional[str] = None
    host: Optional[str] = None
    port: Optional[int] = None
    username: Optional[str] = None
    auth_type: Optional[str] = None
    password: Optional[str] = None
    private_key_path: Optional[str] = None
    passphrase: Optional[str] = None
    vnc_port: Optional[int] = None
    vnc_password: Optional[str] = None
    color: Optional[str] = None
    group: Optional[str] = None
    runbook: Optional[str] = None


class RunbookUpdate(BaseModel):
    """Update ops runbook request."""
    runbook: str = ""


class ElectermImport(BaseModel):
    """electerm import request."""
    bookmarks: list[dict]


class SSHLocalUploadRequest(BaseModel):
    """Desktop mode: local path upload request."""

    local_path: str
    remote_path: str
    overwrite: bool = False


class SSHLocalDownloadRequest(BaseModel):
    """Desktop mode: download to local path request."""

    remote_path: str
    local_path: str


class SSHDirectoryCreateRequest(BaseModel):
    """Remote directory creation request."""

    path: str


class SSHFileContentUpdateRequest(BaseModel):
    """Text file content update request."""

    path: str
    content: str
    encoding: str = "utf-8"


class SSHDeletePathsRequest(BaseModel):
    """Batch delete remote paths request."""

    paths: list[str]


# -----------------------------------------------------------
# API endpoints
# -----------------------------------------------------------

@router.get("/connections")
async def list_connections() -> dict:
    """List all SSH connections (passwords masked)."""
    return SSHConnectionManager.list_connections()


@router.post("/connections")
async def create_connection(conn: SSHConnectionCreate) -> dict:
    """Create a new SSH connection."""
    if not conn.host:
        raise HTTPException(status_code=400, detail="主机地址不能为空")
    if not conn.username:
        raise HTTPException(status_code=400, detail="用户名不能为空")

    return SSHConnectionManager.create_connection(conn.model_dump())


@router.get("/connections/{conn_id}")
async def get_connection(conn_id: str, secrets: bool = Query(default=False)) -> dict:
    """Get a single connection; when secrets=true return plaintext keys (used for VNC connections, etc.)."""
    data = SSHConnectionManager.get_connection_dict(conn_id, include_secrets=secrets)
    if not data:
        raise HTTPException(status_code=404, detail="连接不存在")
    return {"connection": data}


@router.put("/connections/{conn_id}")
async def update_connection(conn_id: str, conn: SSHConnectionUpdate) -> dict:
    """Update SSH connection."""
    result = SSHConnectionManager.update_connection(conn_id, conn.model_dump(exclude_none=True))
    if not result.get("success"):
        raise HTTPException(status_code=404, detail="连接不存在")
    return result


@router.delete("/connections/{conn_id}")
async def delete_connection(conn_id: str) -> dict:
    """Delete SSH connection."""
    return SSHConnectionManager.delete_connection(conn_id)


@router.get("/connections/{conn_id}/runbook")
async def get_runbook(conn_id: str) -> dict:
    """Get the ops runbook (markdown) for a connection."""
    data = SSHConnectionManager.get_runbook(conn_id)
    if data is None:
        raise HTTPException(status_code=404, detail="连接不存在")
    return data


@router.put("/connections/{conn_id}/runbook")
async def update_runbook(conn_id: str, body: RunbookUpdate) -> dict:
    """Replace the ops runbook (markdown) for a connection."""
    result = SSHConnectionManager.update_runbook(conn_id, body.runbook)
    if not result.get("success"):
        raise HTTPException(status_code=404, detail="连接不存在")
    return result


@router.post("/import/electerm")
async def import_electerm(data: ElectermImport) -> dict:
    """Import electerm configuration."""
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
    """Browser mode: upload a file to the remote host."""
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
    """List a remote directory."""
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
    """Read text file content."""
    conn = _get_connection_or_404(conn_id)

    try:
        return SSHFileTransfer.read_text_file(conn, path)
    except Exception as exc:
        _raise_transfer_error(exc)


@router.put("/connections/{conn_id}/files/content")
def update_file_content(conn_id: str, data: SSHFileContentUpdateRequest) -> dict:
    """Save text file content."""
    conn = _get_connection_or_404(conn_id)

    try:
        return SSHFileTransfer.write_text_file(conn, data.path, data.content, data.encoding)
    except Exception as exc:
        _raise_transfer_error(exc)


@router.post("/connections/{conn_id}/directories")
def create_remote_directory(conn_id: str, data: SSHDirectoryCreateRequest) -> dict:
    """Create a remote directory."""
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
    """Batch delete remote files or directories."""
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
    """Desktop mode: create a local upload job."""
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
    """Desktop mode: upload directly from a local path."""
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
    """Get transfer job status."""
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
    """Browser mode: download a remote file."""
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
    """Desktop mode: create a local download job."""
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
    """Desktop mode: download directly to a local path."""
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
