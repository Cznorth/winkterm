"""外部 agent HTTP 接口。

供外部 agent 通过 HTTP + 静态 token 操作终端、查看 SSH 列表、传输文件。
所有端点统一前缀 /api/agent，需 Bearer token 鉴权（AGENT_API_TOKEN）。
"""

from __future__ import annotations

import logging
import sys
from pathlib import Path
from typing import Literal, Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request
from fastapi.responses import Response
from pydantic import BaseModel

from backend.config import UserConfig, settings
from backend.ssh.connection_manager import SSHConnectionManager
from backend.ssh.file_transfer import (
    SSHFileExistsError,
    SSHFileNotFoundError,
    SSHFileTransfer,
    SSHFileTransferError,
    SSHInvalidPathError,
)
from backend.terminal.agent_terminal import UnknownKeyError, get_terminal_pool

logger = logging.getLogger("agent_routes")


# -----------------------------------------------------------
# 鉴权
# -----------------------------------------------------------

def _resolve_agent_token() -> str:
    """优先用设置页持久化的 token，其次用环境变量 AGENT_API_TOKEN。"""
    return UserConfig.load().get("agent_api_token") or settings.agent_api_token


def require_agent_token(authorization: Optional[str] = Header(default=None)) -> None:
    """校验 Bearer token。"""
    token = _resolve_agent_token()
    if not token:
        raise HTTPException(status_code=503, detail="Agent API 未启用：请在设置页配置 token 或设环境变量 AGENT_API_TOKEN")
    if authorization != f"Bearer {token}":
        raise HTTPException(status_code=401, detail="无效或缺失的 token")


router = APIRouter(
    prefix="/api/agent",
    tags=["agent"],
    dependencies=[Depends(require_agent_token)],
)

# 无需鉴权的公开路由（仅用于下发 skill 文件）
public_router = APIRouter(tags=["agent"])


def _skill_dir_file(filename: str) -> Optional[Path]:
    """定位 agent-skill/ 下的文件（兼容开发模式与 PyInstaller 打包）。"""
    candidates: list[Path] = []
    if getattr(sys, "frozen", False):
        candidates.append(Path(sys._MEIPASS) / "agent-skill" / filename)  # type: ignore[attr-defined]
    candidates.append(Path(__file__).resolve().parents[2] / "agent-skill" / filename)
    for path in candidates:
        if path.exists():
            return path
    return None


@public_router.get("/api/agent/skill.md")
async def download_skill() -> Response:
    """下发 winkterm-remote skill 文件，供外部 agent 下载安装。"""
    path = _skill_dir_file("SKILL.md")
    if not path:
        raise HTTPException(status_code=404, detail="SKILL.md 未找到")
    return Response(
        content=path.read_text(encoding="utf-8"),
        media_type="text/markdown; charset=utf-8",
    )


def _is_localhost(request: Request) -> bool:
    """判断请求是否来自本机 loopback。"""
    client = request.client.host if request.client else ""
    return client in ("127.0.0.1", "::1", "localhost")


@public_router.get("/api/agent/handshake")
async def agent_handshake(request: Request) -> dict:
    """Localhost-only：返回当前 agent token，供本地 agent 自动接入。

    安全模型：与 WinkTerm 桌面客户端一致 —— 本机 loopback 视为可信边界。
    远程访问者拿不到 token（403），仍需手动配置或通过其他渠道获得。
    """
    if not _is_localhost(request):
        raise HTTPException(status_code=403, detail="仅 localhost 可调用 handshake")
    token = _resolve_agent_token()
    if not token:
        raise HTTPException(
            status_code=503,
            detail="Agent API 未启用：请在 WinkTerm 设置页配置 token 或设环境变量 AGENT_API_TOKEN",
        )
    return {"token": token, "base_url": str(request.base_url).rstrip("/")}


@public_router.get("/api/agent/install.md")
async def install_guide(request: Request) -> Response:
    """下发外部 agent 接入指导，{BASE_URL} 替换为当前后端地址。"""
    path = _skill_dir_file("INSTALL.md")
    if not path:
        raise HTTPException(status_code=404, detail="INSTALL.md 未找到")
    base_url = str(request.base_url).rstrip("/")
    content = path.read_text(encoding="utf-8").replace("{BASE_URL}", base_url)
    return Response(content=content, media_type="text/plain; charset=utf-8")


# -----------------------------------------------------------
# 请求模型
# -----------------------------------------------------------

class TerminalCreate(BaseModel):
    """创建终端请求。"""

    type: Literal["local", "ssh"] = "local"
    connection_id: Optional[str] = None
    cols: int = 120
    rows: int = 40


class TerminalInput(BaseModel):
    """终端输入请求。

    三种输入方式可组合使用：
    - ``data``: 直接文本。
    - ``data_b64``: base64 编码文本，遇到多层引号嵌套首选此方式。
    - ``keys``: 命名控制键列表，例如 ``["ctrl+c"]``、``["up","enter"]``。
    """

    data: str = ""
    data_b64: Optional[str] = None
    keys: Optional[list[str]] = None
    enter: bool = True
    wait: bool = False
    timeout: float = 10.0
    idle: float = 0.6
    strip_echo: bool = False


class TerminalExec(BaseModel):
    """一次性命令执行请求（带 exit code）。"""

    command: str = ""
    command_b64: Optional[str] = None
    timeout: float = 30.0
    idle: float = 0.3


class FileWriteRequest(BaseModel):
    path: str
    content: str
    encoding: str = "utf-8"


class FileUploadRequest(BaseModel):
    local_path: str
    remote_path: str
    overwrite: bool = False


class FileDownloadRequest(BaseModel):
    remote_path: str
    local_path: str


class DirectoryCreateRequest(BaseModel):
    path: str


class DeletePathsRequest(BaseModel):
    paths: list[str]


# -----------------------------------------------------------
# 辅助
# -----------------------------------------------------------

def _get_terminal_or_404(terminal_id: str):
    terminal = get_terminal_pool().get(terminal_id)
    if not terminal:
        raise HTTPException(status_code=404, detail="终端不存在")
    return terminal


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


# -----------------------------------------------------------
# SSH 列表
# -----------------------------------------------------------

@router.get("/ssh/connections")
async def list_ssh_connections() -> dict:
    """列出所有 SSH 连接（密码脱敏）。"""
    return SSHConnectionManager.list_connections()


# -----------------------------------------------------------
# 终端
# -----------------------------------------------------------

@router.post("/terminals")
async def create_terminal(req: TerminalCreate) -> dict:
    """新建终端（local 或 ssh）。"""
    pool = get_terminal_pool()
    try:
        terminal = await pool.create(req.type, req.connection_id, req.cols, req.rows)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("创建终端失败")
        raise HTTPException(status_code=500, detail=f"创建终端失败: {exc}") from exc
    return terminal.info()


@router.get("/terminals")
async def list_terminals() -> dict:
    """列出所有 HTTP 终端。"""
    return {"terminals": get_terminal_pool().list()}


@router.get("/terminals/{terminal_id}")
async def get_terminal(terminal_id: str) -> dict:
    """获取终端信息。"""
    return _get_terminal_or_404(terminal_id).info()


@router.delete("/terminals/{terminal_id}")
async def delete_terminal(terminal_id: str) -> dict:
    """关闭并删除终端。"""
    if not get_terminal_pool().close(terminal_id):
        raise HTTPException(status_code=404, detail="终端不存在")
    return {"success": True}


@router.get("/terminals/{terminal_id}/snapshot")
async def terminal_snapshot(
    terminal_id: str,
    since: Optional[int] = Query(default=None, description="绝对字节偏移，仅返回该偏移后的新增输出"),
    strip_ansi: bool = Query(default=True, description="是否清理 ANSI 转义序列"),
) -> dict:
    """获取终端输出快照。"""
    terminal = _get_terminal_or_404(terminal_id)
    return terminal.snapshot(since=since, strip=strip_ansi)


@router.post("/terminals/{terminal_id}/input")
async def terminal_input(terminal_id: str, req: TerminalInput) -> dict:
    """向终端发送命令或控制键。

    输入方式：
    - ``data``: 直接文本；
    - ``data_b64``: base64 编码文本（避开 JSON / shell 多层转义）；
    - ``keys``: 命名控制键列表，如 ``["ctrl+c"]``、``["up","enter"]``。

    wait=true 时同步等待输出稳定后返回新增输出，并附带 ``reason`` 字段
    （``idle`` / ``timeout`` / ``no_output``）让调用方区分三种结束情况。
    ``strip_echo=true`` 会剥离命令回显行。
    """
    terminal = _get_terminal_or_404(terminal_id)
    try:
        return await terminal.send(
            data=req.data,
            data_b64=req.data_b64,
            keys=req.keys,
            enter=req.enter,
            wait=req.wait,
            timeout=req.timeout,
            idle=req.idle,
            strip_echo=req.strip_echo,
        )
    except UnknownKeyError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/terminals/{terminal_id}/exec")
async def terminal_exec(terminal_id: str, req: TerminalExec) -> dict:
    """原子执行 POSIX shell 命令，返回 stdout + exit_code。

    实现细节：命令后追加 sentinel 标记 ``echo <ID>$?``，读循环扫到标记
    即刻返回，stdout 已剥离命令回显。仅适用于 bash / zsh / sh / dash
    等 POSIX shell。Windows cmd.exe 请走 ``/input``。
    """
    terminal = _get_terminal_or_404(terminal_id)
    try:
        return await terminal.exec(
            command=req.command,
            command_b64=req.command_b64,
            timeout=req.timeout,
            idle=req.idle,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


# -----------------------------------------------------------
# 文件传输（复用 SSHFileTransfer）
# -----------------------------------------------------------

@router.get("/ssh/{conn_id}/files")
def list_remote_files(conn_id: str, path: Optional[str] = Query(default=None)) -> dict:
    """列出远端目录。"""
    conn = _get_connection_or_404(conn_id)
    try:
        return SSHFileTransfer.list_directory(conn, path)
    except Exception as exc:
        _raise_transfer_error(exc)


@router.get("/ssh/{conn_id}/files/content")
def read_remote_file(conn_id: str, path: str = Query(...)) -> dict:
    """读取远端文本文件内容。"""
    conn = _get_connection_or_404(conn_id)
    try:
        return SSHFileTransfer.read_text_file(conn, path)
    except Exception as exc:
        _raise_transfer_error(exc)


@router.put("/ssh/{conn_id}/files/content")
def write_remote_file(conn_id: str, req: FileWriteRequest) -> dict:
    """写入远端文本文件。"""
    conn = _get_connection_or_404(conn_id)
    try:
        return SSHFileTransfer.write_text_file(conn, req.path, req.content, req.encoding)
    except Exception as exc:
        _raise_transfer_error(exc)


@router.post("/ssh/{conn_id}/upload")
def upload_file(conn_id: str, req: FileUploadRequest) -> dict:
    """从后端本地路径上传文件到远端。"""
    conn = _get_connection_or_404(conn_id)
    try:
        destination = SSHFileTransfer.upload_local_file(
            conn, req.local_path, req.remote_path, overwrite=req.overwrite
        )
        return {"success": True, "local_path": req.local_path, "remote_path": destination}
    except Exception as exc:
        _raise_transfer_error(exc)


@router.post("/ssh/{conn_id}/download")
def download_file(conn_id: str, req: FileDownloadRequest) -> dict:
    """下载远端文件到后端本地路径。"""
    conn = _get_connection_or_404(conn_id)
    try:
        source = SSHFileTransfer.download_to_local_file(conn, req.remote_path, req.local_path)
        return {"success": True, "remote_path": source, "local_path": req.local_path}
    except Exception as exc:
        _raise_transfer_error(exc)


@router.post("/ssh/{conn_id}/directories")
def create_remote_directory(conn_id: str, req: DirectoryCreateRequest) -> dict:
    """创建远端目录。"""
    conn = _get_connection_or_404(conn_id)
    try:
        created = SSHFileTransfer.create_directory(conn, req.path)
        return {"success": True, "path": created}
    except Exception as exc:
        _raise_transfer_error(exc)


@router.delete("/ssh/{conn_id}/paths")
def delete_remote_paths(conn_id: str, req: DeletePathsRequest) -> dict:
    """批量删除远端文件或目录。"""
    conn = _get_connection_or_404(conn_id)
    try:
        result = SSHFileTransfer.delete_paths(conn, req.paths)
        return {"success": True, **result}
    except Exception as exc:
        _raise_transfer_error(exc)
