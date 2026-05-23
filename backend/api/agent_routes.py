"""外部 agent HTTP 接口。

供外部 agent 通过 HTTP + 静态 token 操作终端、查看 SSH 列表、传输文件。
所有端点统一前缀 /api/agent，需 Bearer token 鉴权（AGENT_API_TOKEN）。
"""

from __future__ import annotations

import asyncio
import json
import logging
import sys
from pathlib import Path
from typing import Literal, Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request
from fastapi.responses import Response, StreamingResponse
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
from backend.terminal.agent_events import get_event_log, make_request_id, short_text
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

# 无需鉴权的公开路由（仅用于下发 skill 文件 + localhost handshake）
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
    """Localhost-only：返回当前 agent token，供本地 agent 自动接入。"""
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
    name: str = ""
    ttl_seconds: float = 1800.0  # 0 / 负数 = 永不超时


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
    """一次性命令执行请求（带 exit code + cwd 跟踪）。"""

    command: str = ""
    command_b64: Optional[str] = None
    timeout: float = 30.0
    idle: float = 0.3
    cwd: Optional[str] = None  # 临时切目录（subshell，不污染终端持久 cwd）
    env: Optional[dict[str, str]] = None  # 临时环境变量


class SSHRun(BaseModel):
    """一次性 SSH 执行请求：自动新建终端 → exec → 关闭。"""

    command: str = ""
    command_b64: Optional[str] = None
    timeout: float = 60.0
    cols: int = 200
    rows: int = 50
    initial_wait: float = 2.5  # 等 SSH 登录横幅落定再执行
    cwd: Optional[str] = None
    env: Optional[dict[str, str]] = None


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


def _sse_format(event_name: str, data: dict, event_id: Optional[str] = None) -> bytes:
    """格式化一条 SSE 事件。"""
    lines: list[str] = []
    if event_id is not None:
        lines.append(f"id: {event_id}")
    lines.append(f"event: {event_name}")
    lines.append(f"data: {json.dumps(data, ensure_ascii=False)}")
    lines.append("")
    lines.append("")
    return "\n".join(lines).encode("utf-8")


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
    """新建终端（local 或 ssh）。

    可选 ``name`` 自定义标签，``ttl_seconds`` 指定空闲超时（默认 1800，0/负数 = 永不过期）。
    """
    pool = get_terminal_pool()
    try:
        terminal = await pool.create(
            req.type, req.connection_id, req.cols, req.rows,
            name=req.name, ttl_seconds=req.ttl_seconds,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("创建终端失败")
        raise HTTPException(status_code=500, detail=f"创建终端失败: {exc}") from exc
    info = terminal.info()
    get_event_log().emit(
        "terminal_create",
        terminal_id=terminal.id,
        terminal_type=req.type,
        name=req.name,
        title=info.get("title", ""),
        connection_id=req.connection_id,
    )
    return info


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
    get_event_log().emit("terminal_close", terminal_id=terminal_id)
    return {"success": True}


@router.get("/terminals/{terminal_id}/snapshot")
async def terminal_snapshot(
    terminal_id: str,
    since: Optional[int] = Query(default=None, description="绝对字节偏移"),
    strip_ansi: bool = Query(default=True, description="是否清理 ANSI 转义序列"),
    pattern: Optional[str] = Query(default=None, description="正则过滤匹配行"),
    context: int = Query(default=0, ge=0, le=20, description="grep 上下文行数"),
    case_insensitive: bool = Query(default=False),
) -> dict:
    """获取终端输出快照。

    ``pattern`` 给定时附带 ``grep`` 字段返回匹配行 + 上下文。
    """
    terminal = _get_terminal_or_404(terminal_id)
    try:
        return terminal.snapshot(
            since=since,
            strip=strip_ansi,
            pattern=pattern,
            context=context,
            case_insensitive=case_insensitive,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/terminals/{terminal_id}/input")
async def terminal_input(terminal_id: str, req: TerminalInput) -> dict:
    """向终端发送命令或控制键。"""
    terminal = _get_terminal_or_404(terminal_id)
    try:
        result = await terminal.send(
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

    get_event_log().emit(
        "terminal_input",
        terminal_id=terminal_id,
        data=short_text(req.data),
        keys=req.keys,
        wait=req.wait,
        reason=result.get("reason"),
    )
    return result


@router.post("/terminals/{terminal_id}/exec")
async def terminal_exec(terminal_id: str, req: TerminalExec) -> dict:
    """原子执行 POSIX shell 命令，返回 stdout + exit_code + 当前 cwd。

    ``cwd`` / ``env`` 用 subshell 注入，不影响终端持久状态。
    """
    terminal = _get_terminal_or_404(terminal_id)
    try:
        result = await terminal.exec(
            command=req.command,
            command_b64=req.command_b64,
            timeout=req.timeout,
            idle=req.idle,
            cwd=req.cwd,
            env=req.env,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    get_event_log().emit(
        "terminal_exec",
        terminal_id=terminal_id,
        command=short_text(req.command or "(b64)"),
        exit_code=result.get("exit_code"),
        ok=result.get("ok"),
        cwd=result.get("cwd"),
    )
    return result


@router.get("/terminals/{terminal_id}/stream")
async def terminal_stream(
    terminal_id: str,
    since: int = Query(default=0, ge=0),
    strip_ansi: bool = Query(default=True),
) -> StreamingResponse:
    """SSE 实时流：订阅终端新输出。

    事件名：``output`` / ``heartbeat`` / ``end``。每个事件附 ``id`` 为累计字节偏移，
    断线重连时把上次的 id 当 ``Last-Event-ID`` 头或 ``since`` 查询参数即可续传。
    """
    terminal = _get_terminal_or_404(terminal_id)

    async def gen():
        # 首屏：先把已有缓冲推一波，再进入实时模式
        snap = terminal.snapshot(since=since, strip=strip_ansi)
        if snap["output"]:
            yield _sse_format(
                "output",
                {"text": snap["output"], "size": snap["size"]},
                event_id=str(snap["size"]),
            )
        cur = snap["size"]
        try:
            async for evt in terminal.stream(since=cur, strip=strip_ansi):
                yield _sse_format(
                    evt["event"],
                    {"text": evt["data"], "size": evt["id"]},
                    event_id=str(evt["id"]),
                )
        except asyncio.CancelledError:
            return

    headers = {
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
    }
    return StreamingResponse(gen(), media_type="text/event-stream", headers=headers)


# -----------------------------------------------------------
# 一次性 SSH 命令
# -----------------------------------------------------------

@router.post("/ssh/{conn_id}/run")
async def ssh_run(conn_id: str, req: SSHRun) -> dict:
    """新建临时 SSH 终端 → 执行命令 → 关闭，三步合一。

    简单命令首选此端点，省去 create/exec/delete 三次 HTTP 调用。
    适合一次性诊断、巡检脚本。如果要复用 shell 状态（cd、环境变量）请走
    ``/terminals`` + ``/exec`` 两步流程。
    """
    _get_connection_or_404(conn_id)
    pool = get_terminal_pool()
    rid = make_request_id()
    get_event_log().emit(
        "ssh_run_start",
        request_id=rid,
        connection_id=conn_id,
        command=short_text(req.command or "(b64)"),
    )

    try:
        terminal = await pool.create(
            "ssh", conn_id, req.cols, req.rows,
            name=f"oneshot:{rid}", ttl_seconds=max(req.timeout + 30, 120),
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    try:
        # 等 SSH 登录横幅 / shell prompt 就绪
        if req.initial_wait > 0:
            await asyncio.sleep(req.initial_wait)
        result = await terminal.exec(
            command=req.command,
            command_b64=req.command_b64,
            timeout=req.timeout,
            cwd=req.cwd,
            env=req.env,
        )
    except ValueError as exc:
        pool.close(terminal.id)
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    finally:
        pool.close(terminal.id)

    get_event_log().emit(
        "ssh_run_done",
        request_id=rid,
        connection_id=conn_id,
        exit_code=result.get("exit_code"),
        ok=result.get("ok"),
    )
    result["request_id"] = rid
    return result


# -----------------------------------------------------------
# 操作事件流（前端实时查看 agent 干了啥）
# -----------------------------------------------------------

@router.get("/events/recent")
async def events_recent(
    since_id: Optional[int] = Query(default=None),
    limit: int = Query(default=100, ge=1, le=500),
) -> dict:
    """拉最近事件（一次性 HTTP）。"""
    return {"events": get_event_log().recent(since_id=since_id, limit=limit)}


@router.get("/events/stream")
async def events_stream(
    since_id: int = Query(default=0, ge=0),
) -> StreamingResponse:
    """SSE 实时事件流。事件名总为 ``agent_event``，data 为整条事件 JSON。"""
    log = get_event_log()

    async def gen():
        try:
            async for evt in log.stream(since_id=since_id):
                name = "heartbeat" if evt.get("action") == "heartbeat" else "agent_event"
                yield _sse_format(name, evt, event_id=str(evt.get("id", "")))
        except asyncio.CancelledError:
            return

    headers = {"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}
    return StreamingResponse(gen(), media_type="text/event-stream", headers=headers)


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
        result = SSHFileTransfer.write_text_file(conn, req.path, req.content, req.encoding)
        get_event_log().emit("ssh_file_write", connection_id=conn_id, path=req.path, bytes=len(req.content))
        return result
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
        get_event_log().emit("ssh_file_upload", connection_id=conn_id, remote_path=destination)
        return {"success": True, "local_path": req.local_path, "remote_path": destination}
    except Exception as exc:
        _raise_transfer_error(exc)


@router.post("/ssh/{conn_id}/download")
def download_file(conn_id: str, req: FileDownloadRequest) -> dict:
    """下载远端文件到后端本地路径。"""
    conn = _get_connection_or_404(conn_id)
    try:
        source = SSHFileTransfer.download_to_local_file(conn, req.remote_path, req.local_path)
        get_event_log().emit("ssh_file_download", connection_id=conn_id, remote_path=source)
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
        get_event_log().emit("ssh_paths_delete", connection_id=conn_id, paths=req.paths[:5])
        return {"success": True, **result}
    except Exception as exc:
        _raise_transfer_error(exc)
