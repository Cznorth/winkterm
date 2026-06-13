"""External agent HTTP API.

Allows external agents to operate terminals, list SSH connections, and transfer files
via HTTP with a static token. All endpoints use the /api/agent prefix and require
Bearer token auth (AGENT_API_TOKEN).
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
from backend.ssh.command_exec import build_command, run_command
from backend.ssh.run_jobs import RunJob, RunJobManager
from backend.terminal._term_utils import UnknownKeyError
from backend.terminal.agent_events import get_event_log, make_request_id, short_text
from backend.terminal.session_manager import get_session_manager

logger = logging.getLogger("agent_routes")


# -----------------------------------------------------------
# Authentication
# -----------------------------------------------------------

def _resolve_agent_token() -> str:
    """Prefer the token persisted on the settings page, then env var AGENT_API_TOKEN."""
    return UserConfig.load().get("agent_api_token") or settings.agent_api_token


def require_agent_token(
    authorization: Optional[str] = Header(default=None),
    token: Optional[str] = Query(default=None, description="Fallback token param when SSE/EventSource cannot send custom headers"),
) -> None:
    """Validate Bearer token.

    Supports two entry points:
    1. `Authorization: Bearer <token>` header (preferred)
    2. `?token=<token>` query param (EventSource and other clients without custom headers)
    """
    expected = _resolve_agent_token()
    if not expected:
        raise HTTPException(status_code=503, detail="Agent API 未启用：请在设置页配置 token 或设环境变量 AGENT_API_TOKEN")
    provided = None
    if authorization and authorization.startswith("Bearer "):
        provided = authorization[len("Bearer "):]
    elif token:
        provided = token
    if provided != expected:
        raise HTTPException(status_code=401, detail="无效或缺失的 token")


router = APIRouter(
    prefix="/api/agent",
    tags=["agent"],
    dependencies=[Depends(require_agent_token)],
)

# Public routes (no auth): skill file download + localhost handshake only
public_router = APIRouter(tags=["agent"])


def _skill_dir_file(filename: str) -> Optional[Path]:
    """Locate a file under agent-skill/ (dev mode and PyInstaller bundle)."""
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
    """Serve the winkterm-remote skill file for external agents to download and install."""
    path = _skill_dir_file("SKILL.md")
    if not path:
        raise HTTPException(status_code=404, detail="SKILL.md 未找到")
    return Response(
        content=path.read_text(encoding="utf-8"),
        media_type="text/markdown; charset=utf-8",
    )


@public_router.get("/api/agent/http.md")
async def download_http_api() -> Response:
    """Serve the HTTP-fallback reference so agents fetch it only when they truly need HTTP."""
    path = _skill_dir_file("HTTP_API.md")
    if not path:
        raise HTTPException(status_code=404, detail="HTTP_API.md 未找到")
    return Response(
        content=path.read_text(encoding="utf-8"),
        media_type="text/markdown; charset=utf-8",
    )


@public_router.get("/api/agent/handshake")
async def agent_handshake(request: Request) -> dict:
    """Return the current agent token for trusted clients to connect automatically."""
    from backend.api.auth_routes import (
        is_local_request,
        resolve_web_key,
        verify_web_key,
    )

    authorized = is_local_request(request)
    if not authorized:
        web_key = resolve_web_key()
        if web_key and verify_web_key(request.headers.get("X-Access-Key", "")):
            authorized = True

    if not authorized:
        raise HTTPException(
            status_code=403,
            detail="handshake 需在 localhost 调用，或携带有效的 X-Access-Key 头",
        )

    token = _resolve_agent_token()
    if not token:
        raise HTTPException(
            status_code=503,
            detail="Agent API 未启用：请在 WinkTerm 设置页配置 token 或设环境变量 AGENT_API_TOKEN",
        )
    return {"token": token, "base_url": str(request.base_url).rstrip("/")}


@public_router.get("/api/agent/install.md")
async def install_guide(request: Request) -> Response:
    """Serve external agent onboarding guide; {BASE_URL} is replaced with the current backend URL."""
    path = _skill_dir_file("INSTALL.md")
    if not path:
        raise HTTPException(status_code=404, detail="INSTALL.md 未找到")
    base_url = str(request.base_url).rstrip("/")
    content = path.read_text(encoding="utf-8").replace("{BASE_URL}", base_url)
    return Response(content=content, media_type="text/plain; charset=utf-8")


# -----------------------------------------------------------
# Request models
# -----------------------------------------------------------

class TerminalCreate(BaseModel):
    type: Literal["local", "ssh"] = "local"
    connection_id: Optional[str] = None
    cols: int = 120
    rows: int = 40
    name: str = ""
    ttl_seconds: float = 1800.0
    user_visible: bool = True
    transient: bool = False
    created_by: str = "agent:external"


class TerminalInput(BaseModel):
    data: str = ""
    data_b64: Optional[str] = None
    keys: Optional[list[str]] = None
    enter: bool = True
    wait: bool = False
    timeout: float = 10.0
    idle: float = 0.6
    strip_echo: bool = False


class TerminalExec(BaseModel):
    command: str = ""
    command_b64: Optional[str] = None
    timeout: float = 30.0
    idle: float = 0.3
    cwd: Optional[str] = None
    env: Optional[dict[str, str]] = None


class SSHRun(BaseModel):
    command: str = ""
    command_b64: Optional[str] = None
    timeout: float = 60.0
    cols: int = 200
    rows: int = 50
    initial_wait: float = 12.0  # upper bound for banner+login; idle detection may return earlier
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


class SSHConnectionCreate(BaseModel):
    """Create an SSH connection. Secrets are stored as given."""
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


class SSHConnectionUpdate(BaseModel):
    """Update an SSH connection. Omitted/empty/masked secrets are left unchanged."""
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


class ElectermImport(BaseModel):
    """Bulk-import electerm bookmarks (deduped by host+port+username)."""
    bookmarks: list[dict]


# -----------------------------------------------------------
# Helpers
# -----------------------------------------------------------

def _get_session_or_404(terminal_id: str):
    session = get_session_manager().get_session(terminal_id)
    if not session:
        raise HTTPException(status_code=404, detail="终端不存在")
    return session


def _session_info(session) -> dict:
    sm = get_session_manager()
    return session.info(is_user_active=session.id == sm.get_active_session_id())


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
    lines: list[str] = []
    if event_id is not None:
        lines.append(f"id: {event_id}")
    lines.append(f"event: {event_name}")
    lines.append(f"data: {json.dumps(data, ensure_ascii=False)}")
    lines.append("")
    lines.append("")
    return "\n".join(lines).encode("utf-8")


# -----------------------------------------------------------
# SSH connection management (CRUD)
# -----------------------------------------------------------

@router.get("/ssh/connections")
async def list_ssh_connections() -> dict:
    return SSHConnectionManager.list_connections()


@router.post("/ssh/connections")
async def create_ssh_connection(req: SSHConnectionCreate) -> dict:
    """Create an SSH connection; returns the new connection id."""
    if not req.host:
        raise HTTPException(status_code=400, detail="主机地址不能为空")
    if not req.username:
        raise HTTPException(status_code=400, detail="用户名不能为空")
    result = SSHConnectionManager.create_connection(req.model_dump())
    get_event_log().emit(
        "ssh_connection_create",
        connection_id=result.get("id"),
        host=req.host,
        title=req.title,
    )
    return result


@router.get("/ssh/connections/{conn_id}")
async def get_ssh_connection(conn_id: str, secrets: bool = Query(default=False)) -> dict:
    """Get one connection; secrets=true returns plaintext password/key (use sparingly)."""
    data = SSHConnectionManager.get_connection_dict(conn_id, include_secrets=secrets)
    if not data:
        raise HTTPException(status_code=404, detail="SSH 连接不存在")
    return {"connection": data}


@router.put("/ssh/connections/{conn_id}")
async def update_ssh_connection(conn_id: str, req: SSHConnectionUpdate) -> dict:
    """Update a connection. Omitted fields and masked/empty secrets are left unchanged."""
    if not SSHConnectionManager.get_connection_dict(conn_id):
        raise HTTPException(status_code=404, detail="SSH 连接不存在")
    result = SSHConnectionManager.update_connection(conn_id, req.model_dump(exclude_none=True))
    get_event_log().emit("ssh_connection_update", connection_id=conn_id)
    return result


@router.delete("/ssh/connections/{conn_id}")
async def delete_ssh_connection(conn_id: str) -> dict:
    """Delete a connection."""
    if not SSHConnectionManager.get_connection_dict(conn_id):
        raise HTTPException(status_code=404, detail="SSH 连接不存在")
    result = SSHConnectionManager.delete_connection(conn_id)
    get_event_log().emit("ssh_connection_delete", connection_id=conn_id)
    return result


@router.post("/ssh/import/electerm")
async def import_electerm(req: ElectermImport) -> dict:
    """Bulk-import electerm bookmarks (skips entries that already exist)."""
    if not req.bookmarks:
        raise HTTPException(status_code=400, detail="没有可导入的配置")
    result = SSHConnectionManager.import_from_electerm(req.bookmarks)
    get_event_log().emit("ssh_import_electerm", imported=result.get("imported"))
    return result


# -----------------------------------------------------------
# Terminals
# -----------------------------------------------------------

@router.post("/terminals")
async def create_terminal(req: TerminalCreate) -> dict:
    """Create a terminal (local or ssh).

    ``user_visible=true`` (default) adds it to the user's tab bar for collaboration.
    One-off background tasks should use ``transient=true`` + ``user_visible=false``.
    """
    sm = get_session_manager()
    try:
        session = await sm.create(
            terminal_type=req.type,
            connection_id=req.connection_id,
            cols=req.cols,
            rows=req.rows,
            name=req.name,
            ttl_seconds=req.ttl_seconds,
            created_by=req.created_by,
            user_visible=req.user_visible,
            transient=req.transient,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("创建终端失败")
        raise HTTPException(status_code=500, detail=f"创建终端失败: {exc}") from exc
    info = _session_info(session)
    get_event_log().emit(
        "terminal_create",
        terminal_id=session.id,
        terminal_type=req.type,
        name=req.name,
        title=info.get("title", ""),
        connection_id=req.connection_id,
        created_by=req.created_by,
    )
    return info


@router.get("/terminals")
async def list_terminals() -> dict:
    return {"terminals": get_session_manager().list_terminals()}


@router.get("/terminals/{terminal_id}")
async def get_terminal(terminal_id: str) -> dict:
    return _session_info(_get_session_or_404(terminal_id))


@router.delete("/terminals/{terminal_id}")
async def delete_terminal(terminal_id: str) -> dict:
    if not get_session_manager().close(terminal_id):
        raise HTTPException(status_code=404, detail="终端不存在")
    get_event_log().emit("terminal_close", terminal_id=terminal_id)
    return {"success": True}


@router.get("/terminals/{terminal_id}/snapshot")
async def terminal_snapshot(
    terminal_id: str,
    since: Optional[int] = Query(default=None, description="Absolute byte offset"),
    strip_ansi: bool = Query(default=True),
    pattern: Optional[str] = Query(default=None),
    context: int = Query(default=0, ge=0, le=20),
    case_insensitive: bool = Query(default=False),
) -> dict:
    session = _get_session_or_404(terminal_id)
    try:
        return session.snapshot(
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
    session = _get_session_or_404(terminal_id)
    try:
        result = await session.send(
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
    session = _get_session_or_404(terminal_id)
    try:
        result = await session.exec(
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
    session = _get_session_or_404(terminal_id)

    async def gen():
        snap = session.snapshot(since=since, strip=strip_ansi)
        if snap["output"]:
            yield _sse_format(
                "output",
                {"text": snap["output"], "size": snap["size"]},
                event_id=str(snap["size"]),
            )
        cur = snap["size"]
        try:
            async for evt in session.stream(since=cur, strip=strip_ansi):
                yield _sse_format(
                    evt["event"],
                    {"text": evt["data"], "size": evt["id"]},
                    event_id=str(evt["id"]),
                )
        except asyncio.CancelledError:
            return

    headers = {"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}
    return StreamingResponse(gen(), media_type="text/event-stream", headers=headers)


# -----------------------------------------------------------
# One-shot SSH commands
# -----------------------------------------------------------

@router.post("/ssh/{conn_id}/run")
async def ssh_run(conn_id: str, req: SSHRun) -> dict:
    """Create a temporary SSH terminal, run a command, then close — three steps in one."""
    _get_connection_or_404(conn_id)
    sm = get_session_manager()
    rid = make_request_id()
    get_event_log().emit(
        "ssh_run_start",
        request_id=rid,
        connection_id=conn_id,
        command=short_text(req.command or "(b64)"),
    )

    try:
        session = await sm.create(
            terminal_type="ssh",
            connection_id=conn_id,
            cols=req.cols,
            rows=req.rows,
            name=f"oneshot:{rid}",
            ttl_seconds=max(req.timeout + 30, 120),
            created_by="agent:ssh_run",
            user_visible=False,
            transient=True,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    try:
        # idle + prompt dual signals; initial_wait is the upper bound
        await session.wait_until_idle(idle=2.0, max_wait=max(req.initial_wait, 5.0))
        result = await session.exec(
            command=req.command,
            command_b64=req.command_b64,
            timeout=req.timeout,
            cwd=req.cwd,
            env=req.env,
        )
    except ValueError as exc:
        sm.close(session.id)
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    finally:
        sm.close(session.id)

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
# Async one-shot SSH commands (job-based, survives gateway timeouts)
# -----------------------------------------------------------

@router.post("/ssh/{conn_id}/run_async")
async def ssh_run_async(conn_id: str, req: SSHRun) -> dict:
    """Submit a command without waiting for it to finish.

    Returns a ``job_id`` immediately; poll ``GET /api/agent/jobs/{job_id}`` for
    status and output. Use this instead of ``/run`` for anything that may exceed
    the reverse-proxy timeout (installs, dumps, builds, large transfers).

    The command runs over a dedicated SSH channel inside a worker thread
    (``asyncio.to_thread``), so neither the submit response nor other requests are
    blocked by the connect/run, and a hung host stalls only its own job.
    """
    conn = _get_connection_or_404(conn_id)
    # Validate/assemble up front so a bad command/env fails the submit, not the job.
    try:
        final_command = build_command(req.command, req.command_b64, req.cwd, req.env)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    preview = short_text(req.command or "(b64)")

    async def worker(job: RunJob) -> None:
        result = await asyncio.to_thread(run_command, conn, final_command, req.timeout)
        job.finish(result)
        get_event_log().emit(
            "ssh_run_async_done",
            job_id=job.id,
            connection_id=conn_id,
            exit_code=job.exit_code,
            ok=job.ok,
        )

    job = RunJobManager.submit(conn_id, preview, worker)
    get_event_log().emit(
        "ssh_run_async_start",
        job_id=job["job_id"],
        connection_id=conn_id,
        command=preview,
    )
    return job


@router.get("/jobs")
async def list_run_jobs() -> dict:
    return {"jobs": RunJobManager.list()}


@router.get("/jobs/{job_id}")
async def get_run_job(job_id: str) -> dict:
    job = RunJobManager.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="任务不存在")
    return job


@router.delete("/jobs/{job_id}")
async def cancel_run_job(job_id: str) -> dict:
    job = RunJobManager.cancel(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="任务不存在")
    get_event_log().emit("ssh_run_async_cancel", job_id=job_id)
    return job


# -----------------------------------------------------------
# Operation event stream
# -----------------------------------------------------------

@router.get("/events/recent")
async def events_recent(
    since_id: Optional[int] = Query(default=None),
    limit: int = Query(default=100, ge=1, le=500),
) -> dict:
    return {"events": get_event_log().recent(since_id=since_id, limit=limit)}


@router.get("/events/stream")
async def events_stream(
    since_id: int = Query(default=0, ge=0),
) -> StreamingResponse:
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
# File transfer
# -----------------------------------------------------------

@router.get("/ssh/{conn_id}/files")
def list_remote_files(conn_id: str, path: Optional[str] = Query(default=None)) -> dict:
    conn = _get_connection_or_404(conn_id)
    try:
        return SSHFileTransfer.list_directory(conn, path)
    except Exception as exc:
        _raise_transfer_error(exc)


@router.get("/ssh/{conn_id}/files/content")
def read_remote_file(conn_id: str, path: str = Query(...)) -> dict:
    conn = _get_connection_or_404(conn_id)
    try:
        return SSHFileTransfer.read_text_file(conn, path)
    except Exception as exc:
        _raise_transfer_error(exc)


@router.put("/ssh/{conn_id}/files/content")
def write_remote_file(conn_id: str, req: FileWriteRequest) -> dict:
    conn = _get_connection_or_404(conn_id)
    try:
        result = SSHFileTransfer.write_text_file(conn, req.path, req.content, req.encoding)
        get_event_log().emit("ssh_file_write", connection_id=conn_id, path=req.path, bytes=len(req.content))
        return result
    except Exception as exc:
        _raise_transfer_error(exc)


@router.post("/ssh/{conn_id}/upload")
def upload_file(conn_id: str, req: FileUploadRequest) -> dict:
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
    conn = _get_connection_or_404(conn_id)
    try:
        source = SSHFileTransfer.download_to_local_file(conn, req.remote_path, req.local_path)
        get_event_log().emit("ssh_file_download", connection_id=conn_id, remote_path=source)
        return {"success": True, "remote_path": source, "local_path": req.local_path}
    except Exception as exc:
        _raise_transfer_error(exc)


@router.post("/ssh/{conn_id}/directories")
def create_remote_directory(conn_id: str, req: DirectoryCreateRequest) -> dict:
    conn = _get_connection_or_404(conn_id)
    try:
        created = SSHFileTransfer.create_directory(conn, req.path)
        return {"success": True, "path": created}
    except Exception as exc:
        _raise_transfer_error(exc)


@router.delete("/ssh/{conn_id}/paths")
def delete_remote_paths(conn_id: str, req: DeletePathsRequest) -> dict:
    conn = _get_connection_or_404(conn_id)
    try:
        result = SSHFileTransfer.delete_paths(conn, req.paths)
        get_event_log().emit("ssh_paths_delete", connection_id=conn_id, paths=req.paths[:5])
        return {"success": True, **result}
    except Exception as exc:
        _raise_transfer_error(exc)
