"""External agent WebSocket API.

A single long-lived WebSocket carries the full agent surface (the same operations
exposed over HTTP in ``agent_routes.py``), framed as JSON messages. Unlike the
blocking HTTP ``/exec`` call, long-running commands stream ``progress`` frames and
the connection is kept alive by application-level heartbeats, so a reverse proxy's
idle read-timeout (nginx default 60s) never tears the request down mid-command.

Protocol (JSON text frames)
---------------------------
Client -> server:
  {"id": "<req-id>", "method": "<method>", "params": {...}}   # a request
  {"type": "cancel", "id": "<req-id>"}                          # cancel an in-flight request
  {"type": "ping"} / {"type": "pong"}                          # heartbeat

Server -> client:
  {"type": "ready", "protocol": 1}                             # sent right after accept
  {"id": "<req-id>", "type": "result", "data": {...}}          # terminal success
  {"id": "<req-id>", "type": "progress", "data": {...}}        # streaming output (0+ frames)
  {"id": "<req-id>", "type": "error", "error": {"code": int, "message": str}}
  {"type": "ping"} / {"type": "pong"}                          # heartbeat

Auth: ``?token=<agent_token>`` query param, validated against the same token as the
HTTP agent API. On failure the socket is closed with code 4401.

This module deliberately does NOT touch ``agent_routes.py``: it calls the same
underlying managers directly, so the legacy HTTP/SSE surface stays a zero-risk
fallback while the WebSocket path matures.
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, Awaitable, Callable, Optional

from fastapi import WebSocket, WebSocketDisconnect

from backend.api.agent_routes import _resolve_agent_token
from backend.ssh.command_exec import build_command, run_command
from backend.ssh.connection_manager import SSHConnectionManager
from backend.ssh.file_transfer import (
    SSHFileExistsError,
    SSHFileNotFoundError,
    SSHFileTransfer,
    SSHFileTransferError,
    SSHInvalidPathError,
)
from backend.ssh.run_jobs import RunJob, RunJobManager
from backend.terminal._term_utils import UnknownKeyError
from backend.terminal.agent_events import get_event_log, make_request_id, short_text
from backend.terminal.session_manager import get_session_manager

logger = logging.getLogger("ws_agent")

PROTOCOL_VERSION = 1
_HEARTBEAT_INTERVAL = 15.0
_WS_AUTH_FAILED = 4401


class AgentError(Exception):
    """An operation error carrying an HTTP-equivalent status code.

    Mirrors the ``HTTPException`` codes the HTTP handlers raise so the two
    surfaces report failures identically.
    """

    def __init__(self, code: int, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def _agent_token_valid(token: Optional[str]) -> bool:
    expected = _resolve_agent_token()
    if not expected:
        return False
    return token == expected


def _map_transfer_error(exc: Exception) -> AgentError:
    if isinstance(exc, SSHFileExistsError):
        return AgentError(409, str(exc))
    if isinstance(exc, SSHFileNotFoundError):
        return AgentError(404, str(exc))
    if isinstance(exc, SSHInvalidPathError):
        return AgentError(400, str(exc))
    if isinstance(exc, SSHFileTransferError):
        return AgentError(500, str(exc))
    return AgentError(500, "文件传输失败")


class AgentWSHandler:
    """Drives one agent WebSocket connection: auth, heartbeat, request dispatch."""

    def __init__(self, websocket: WebSocket, token: Optional[str]) -> None:
        self.ws = websocket
        self.token = token
        self._send_lock = asyncio.Lock()
        self._tasks: dict[str, asyncio.Task] = {}
        self._heartbeat_task: Optional[asyncio.Task] = None
        self._closed = False

    # ------------------------------------------------------------------
    # Connection lifecycle
    # ------------------------------------------------------------------

    async def handle(self) -> None:
        await self.ws.accept()
        if not _agent_token_valid(self.token):
            logger.info("[ws_agent] auth failed, closing")
            await self.ws.close(code=_WS_AUTH_FAILED)
            return

        logger.info("[ws_agent] connected")
        await self._send({"type": "ready", "protocol": PROTOCOL_VERSION})
        self._heartbeat_task = asyncio.create_task(self._heartbeat_loop())

        try:
            while True:
                raw = await self.ws.receive_text()
                try:
                    msg = json.loads(raw)
                except json.JSONDecodeError:
                    await self._send({"type": "error", "error": {"code": 400, "message": "无效的 JSON"}})
                    continue
                self._on_message(msg)
        except WebSocketDisconnect:
            logger.info("[ws_agent] disconnected")
        except Exception:
            logger.exception("[ws_agent] loop error")
        finally:
            await self._cleanup()

    def _on_message(self, msg: dict) -> None:
        mtype = msg.get("type")
        if mtype == "ping":
            asyncio.create_task(self._send({"type": "pong"}))
            return
        if mtype == "pong":
            return
        if mtype == "cancel":
            self._cancel_request(str(msg.get("id", "")))
            return

        req_id = msg.get("id")
        method = msg.get("method")
        if not req_id or not method:
            asyncio.create_task(
                self._send({"type": "error", "error": {"code": 400, "message": "缺少 id 或 method"}})
            )
            return
        req_id = str(req_id)
        # Each request runs in its own task so a long command never blocks others.
        task = asyncio.create_task(self._run_request(req_id, method, msg.get("params") or {}))
        self._tasks[req_id] = task
        task.add_done_callback(lambda _t, rid=req_id: self._tasks.pop(rid, None))

    def _cancel_request(self, req_id: str) -> None:
        task = self._tasks.get(req_id)
        if task and not task.done():
            task.cancel()

    async def _cleanup(self) -> None:
        self._closed = True
        if self._heartbeat_task:
            self._heartbeat_task.cancel()
        for task in list(self._tasks.values()):
            if not task.done():
                task.cancel()
        self._tasks.clear()
        logger.info("[ws_agent] cleaned up")

    async def _heartbeat_loop(self) -> None:
        try:
            while not self._closed:
                await asyncio.sleep(_HEARTBEAT_INTERVAL)
                await self._send({"type": "ping"})
        except asyncio.CancelledError:
            return
        except Exception:
            return

    # ------------------------------------------------------------------
    # Sending
    # ------------------------------------------------------------------

    async def _send(self, data: dict) -> None:
        if self._closed:
            return
        try:
            async with self._send_lock:
                await self.ws.send_text(json.dumps(data, ensure_ascii=False, default=str))
        except Exception as exc:
            logger.debug("[ws_agent] send failed: %s", exc)

    async def _result(self, req_id: str, data: Any) -> None:
        await self._send({"id": req_id, "type": "result", "data": data})

    async def _progress(self, req_id: str, data: Any) -> None:
        await self._send({"id": req_id, "type": "progress", "data": data})

    async def _error(self, req_id: str, code: int, message: str) -> None:
        await self._send({"id": req_id, "type": "error", "error": {"code": code, "message": message}})

    # ------------------------------------------------------------------
    # Dispatch
    # ------------------------------------------------------------------

    async def _run_request(self, req_id: str, method: str, params: dict) -> None:
        handler = self._METHODS.get(method)
        if handler is None:
            await self._error(req_id, 404, f"未知方法: {method}")
            return
        try:
            await handler(self, req_id, params)
        except asyncio.CancelledError:
            await self._send({"id": req_id, "type": "cancelled"})
            raise
        except AgentError as exc:
            await self._error(req_id, exc.code, exc.message)
        except UnknownKeyError as exc:
            await self._error(req_id, 400, str(exc))
        except ValueError as exc:
            await self._error(req_id, 400, str(exc))
        except Exception as exc:
            logger.exception("[ws_agent] method %s failed", method)
            await self._error(req_id, 500, str(exc))

    # ------------------------------------------------------------------
    # Helpers (parallel to agent_routes._get_* helpers)
    # ------------------------------------------------------------------

    @staticmethod
    def _session_or_raise(terminal_id: str):
        session = get_session_manager().get_session(terminal_id)
        if not session:
            raise AgentError(404, "终端不存在")
        return session

    @staticmethod
    def _session_info(session) -> dict:
        sm = get_session_manager()
        return session.info(is_user_active=session.id == sm.get_active_session_id())

    @staticmethod
    def _connection_or_raise(conn_id: str):
        conn = SSHConnectionManager.get_connection(conn_id)
        if not conn:
            raise AgentError(404, "SSH 连接不存在")
        return conn

    # ------------------------------------------------------------------
    # Terminal methods
    # ------------------------------------------------------------------

    async def _m_terminal_create(self, req_id: str, p: dict) -> None:
        sm = get_session_manager()
        try:
            session = await sm.create(
                terminal_type=p.get("type", "local"),
                connection_id=p.get("connection_id"),
                cols=int(p.get("cols", 120)),
                rows=int(p.get("rows", 40)),
                name=p.get("name", ""),
                ttl_seconds=float(p.get("ttl_seconds", 1800.0)),
                created_by=p.get("created_by", "agent:ws"),
                user_visible=bool(p.get("user_visible", True)),
                transient=bool(p.get("transient", False)),
            )
        except ValueError as exc:
            raise AgentError(400, str(exc)) from exc
        except Exception as exc:
            logger.exception("创建终端失败")
            raise AgentError(500, f"创建终端失败: {exc}") from exc
        info = self._session_info(session)
        get_event_log().emit(
            "terminal_create",
            terminal_id=session.id,
            terminal_type=p.get("type", "local"),
            name=p.get("name", ""),
            title=info.get("title", ""),
            connection_id=p.get("connection_id"),
            created_by=p.get("created_by", "agent:ws"),
        )
        await self._result(req_id, info)

    async def _m_terminal_list(self, req_id: str, p: dict) -> None:
        await self._result(req_id, {"terminals": get_session_manager().list_terminals()})

    async def _m_terminal_get(self, req_id: str, p: dict) -> None:
        session = self._session_or_raise(p.get("terminal_id", ""))
        await self._result(req_id, self._session_info(session))

    async def _m_terminal_delete(self, req_id: str, p: dict) -> None:
        terminal_id = p.get("terminal_id", "")
        if not get_session_manager().close(terminal_id):
            raise AgentError(404, "终端不存在")
        get_event_log().emit("terminal_close", terminal_id=terminal_id)
        await self._result(req_id, {"success": True})

    async def _m_terminal_snapshot(self, req_id: str, p: dict) -> None:
        session = self._session_or_raise(p.get("terminal_id", ""))
        try:
            data = session.snapshot(
                since=p.get("since"),
                strip=bool(p.get("strip_ansi", True)),
                pattern=p.get("pattern"),
                context=int(p.get("context", 0)),
                case_insensitive=bool(p.get("case_insensitive", False)),
            )
        except ValueError as exc:
            raise AgentError(400, str(exc)) from exc
        await self._result(req_id, data)

    async def _m_terminal_input(self, req_id: str, p: dict) -> None:
        session = self._session_or_raise(p.get("terminal_id", ""))
        result = await session.send(
            data=p.get("data", ""),
            data_b64=p.get("data_b64"),
            keys=p.get("keys"),
            enter=bool(p.get("enter", True)),
            wait=bool(p.get("wait", False)),
            timeout=float(p.get("timeout", 10.0)),
            idle=float(p.get("idle", 0.6)),
            strip_echo=bool(p.get("strip_echo", False)),
        )
        get_event_log().emit(
            "terminal_input",
            terminal_id=p.get("terminal_id", ""),
            data=short_text(p.get("data", "")),
            keys=p.get("keys"),
            wait=bool(p.get("wait", False)),
            reason=result.get("reason"),
        )
        await self._result(req_id, result)

    async def _m_terminal_exec(self, req_id: str, p: dict) -> None:
        """Run a command, streaming live output as ``progress`` frames.

        A background pump tails the terminal buffer and emits progress while the
        command runs; the blocking ``session.exec`` resolves the real exit code.
        The connection-level heartbeat keeps the socket alive regardless of how
        long the command takes.
        """
        session = self._session_or_raise(p.get("terminal_id", ""))
        with session._lock:
            start_offset = session._total

        pump_stop = asyncio.Event()

        async def pump() -> None:
            cur = start_offset
            try:
                while not pump_stop.is_set():
                    with session._lock:
                        total = session._total
                    if total > cur:
                        snap = session.snapshot(since=cur, strip=True)
                        cur = snap["size"]
                        if snap["output"]:
                            await self._progress(req_id, {"output": snap["output"], "size": cur})
                    else:
                        await asyncio.sleep(0.2)
            except asyncio.CancelledError:
                return

        pump_task = asyncio.create_task(pump())
        try:
            result = await session.exec(
                command=p.get("command", ""),
                command_b64=p.get("command_b64"),
                timeout=float(p.get("timeout", 30.0)),
                idle=float(p.get("idle", 0.3)),
                cwd=p.get("cwd"),
                env=p.get("env"),
            )
        finally:
            pump_stop.set()
            pump_task.cancel()
        get_event_log().emit(
            "terminal_exec",
            terminal_id=p.get("terminal_id", ""),
            command=short_text(p.get("command") or "(b64)"),
            exit_code=result.get("exit_code"),
            ok=result.get("ok"),
            cwd=result.get("cwd"),
        )
        await self._result(req_id, result)

    async def _m_terminal_stream(self, req_id: str, p: dict) -> None:
        """Subscribe to live terminal output. Emits ``progress`` frames until the
        terminal closes or the request is cancelled."""
        session = self._session_or_raise(p.get("terminal_id", ""))
        since = int(p.get("since", 0))
        strip = bool(p.get("strip_ansi", True))
        snap = session.snapshot(since=since, strip=strip)
        if snap["output"]:
            await self._progress(req_id, {"event": "output", "text": snap["output"], "size": snap["size"]})
        cur = snap["size"]
        async for evt in session.stream(since=cur, strip=strip):
            await self._progress(req_id, {"event": evt["event"], "text": evt["data"], "size": evt["id"]})
        await self._result(req_id, {"event": "end"})

    # ------------------------------------------------------------------
    # SSH connection CRUD
    # ------------------------------------------------------------------

    async def _m_ssh_connections_list(self, req_id: str, p: dict) -> None:
        await self._result(req_id, SSHConnectionManager.list_connections())

    async def _m_ssh_connections_create(self, req_id: str, p: dict) -> None:
        if not p.get("host"):
            raise AgentError(400, "主机地址不能为空")
        if not p.get("username"):
            raise AgentError(400, "用户名不能为空")
        result = SSHConnectionManager.create_connection(p)
        get_event_log().emit(
            "ssh_connection_create",
            connection_id=result.get("id"),
            host=p.get("host"),
            title=p.get("title", ""),
        )
        await self._result(req_id, result)

    async def _m_ssh_connections_get(self, req_id: str, p: dict) -> None:
        data = SSHConnectionManager.get_connection_dict(
            p.get("conn_id", ""), include_secrets=bool(p.get("secrets", False))
        )
        if not data:
            raise AgentError(404, "SSH 连接不存在")
        await self._result(req_id, {"connection": data})

    async def _m_ssh_connections_update(self, req_id: str, p: dict) -> None:
        conn_id = p.get("conn_id", "")
        if not SSHConnectionManager.get_connection_dict(conn_id):
            raise AgentError(404, "SSH 连接不存在")
        patch = {k: v for k, v in p.items() if k != "conn_id" and v is not None}
        result = SSHConnectionManager.update_connection(conn_id, patch)
        get_event_log().emit("ssh_connection_update", connection_id=conn_id)
        await self._result(req_id, result)

    async def _m_ssh_connections_delete(self, req_id: str, p: dict) -> None:
        conn_id = p.get("conn_id", "")
        if not SSHConnectionManager.get_connection_dict(conn_id):
            raise AgentError(404, "SSH 连接不存在")
        result = SSHConnectionManager.delete_connection(conn_id)
        get_event_log().emit("ssh_connection_delete", connection_id=conn_id)
        await self._result(req_id, result)

    async def _m_ssh_import_electerm(self, req_id: str, p: dict) -> None:
        bookmarks = p.get("bookmarks") or []
        if not bookmarks:
            raise AgentError(400, "没有可导入的配置")
        result = SSHConnectionManager.import_from_electerm(bookmarks)
        get_event_log().emit("ssh_import_electerm", imported=result.get("imported"))
        await self._result(req_id, result)

    # ------------------------------------------------------------------
    # One-shot SSH commands
    # ------------------------------------------------------------------

    async def _m_ssh_run(self, req_id: str, p: dict) -> None:
        conn_id = p.get("conn_id", "")
        self._connection_or_raise(conn_id)
        sm = get_session_manager()
        rid = make_request_id()
        timeout = float(p.get("timeout", 60.0))
        get_event_log().emit(
            "ssh_run_start",
            request_id=rid,
            connection_id=conn_id,
            command=short_text(p.get("command") or "(b64)"),
        )
        try:
            session = await sm.create(
                terminal_type="ssh",
                connection_id=conn_id,
                cols=int(p.get("cols", 200)),
                rows=int(p.get("rows", 50)),
                name=f"oneshot:{rid}",
                ttl_seconds=max(timeout + 30, 120),
                created_by="agent:ssh_run",
                user_visible=False,
                transient=True,
            )
        except ValueError as exc:
            raise AgentError(400, str(exc)) from exc
        try:
            await session.wait_until_idle(idle=2.0, max_wait=max(float(p.get("initial_wait", 12.0)), 5.0))
            result = await session.exec(
                command=p.get("command", ""),
                command_b64=p.get("command_b64"),
                timeout=timeout,
                cwd=p.get("cwd"),
                env=p.get("env"),
            )
        except ValueError as exc:
            sm.close(session.id)
            raise AgentError(400, str(exc)) from exc
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
        await self._result(req_id, result)

    async def _m_ssh_run_async(self, req_id: str, p: dict) -> None:
        conn_id = p.get("conn_id", "")
        conn = self._connection_or_raise(conn_id)
        timeout = float(p.get("timeout", 60.0))
        try:
            final_command = build_command(p.get("command", ""), p.get("command_b64"), p.get("cwd"), p.get("env"))
        except ValueError as exc:
            raise AgentError(400, str(exc)) from exc
        preview = short_text(p.get("command") or "(b64)")

        async def worker(job: RunJob) -> None:
            result = await asyncio.to_thread(run_command, conn, final_command, timeout)
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
        await self._result(req_id, job)

    async def _m_job_list(self, req_id: str, p: dict) -> None:
        await self._result(req_id, {"jobs": RunJobManager.list()})

    async def _m_job_get(self, req_id: str, p: dict) -> None:
        job = RunJobManager.get(p.get("job_id", ""))
        if not job:
            raise AgentError(404, "任务不存在")
        await self._result(req_id, job)

    async def _m_job_cancel(self, req_id: str, p: dict) -> None:
        job = RunJobManager.cancel(p.get("job_id", ""))
        if not job:
            raise AgentError(404, "任务不存在")
        get_event_log().emit("ssh_run_async_cancel", job_id=p.get("job_id", ""))
        await self._result(req_id, job)

    # ------------------------------------------------------------------
    # Events
    # ------------------------------------------------------------------

    async def _m_events_recent(self, req_id: str, p: dict) -> None:
        await self._result(
            req_id,
            {"events": get_event_log().recent(since_id=p.get("since_id"), limit=int(p.get("limit", 100)))},
        )

    async def _m_events_stream(self, req_id: str, p: dict) -> None:
        """Subscribe to the operation event log. Emits ``progress`` frames until cancelled."""
        log = get_event_log()
        async for evt in log.stream(since_id=int(p.get("since_id", 0))):
            name = "heartbeat" if evt.get("action") == "heartbeat" else "agent_event"
            await self._progress(req_id, {"event": name, **evt})
        await self._result(req_id, {"event": "end"})

    # ------------------------------------------------------------------
    # File transfer (SFTP) — blocking calls offloaded to threads
    # ------------------------------------------------------------------

    async def _m_ssh_files_list(self, req_id: str, p: dict) -> None:
        conn = self._connection_or_raise(p.get("conn_id", ""))
        try:
            data = await asyncio.to_thread(SSHFileTransfer.list_directory, conn, p.get("path"))
        except Exception as exc:
            raise _map_transfer_error(exc) from exc
        await self._result(req_id, data)

    async def _m_ssh_files_read(self, req_id: str, p: dict) -> None:
        conn = self._connection_or_raise(p.get("conn_id", ""))
        if not p.get("path"):
            raise AgentError(400, "缺少 path")
        try:
            data = await asyncio.to_thread(SSHFileTransfer.read_text_file, conn, p.get("path"))
        except Exception as exc:
            raise _map_transfer_error(exc) from exc
        await self._result(req_id, data)

    async def _m_ssh_files_write(self, req_id: str, p: dict) -> None:
        conn = self._connection_or_raise(p.get("conn_id", ""))
        path = p.get("path")
        content = p.get("content", "")
        if not path:
            raise AgentError(400, "缺少 path")
        try:
            result = await asyncio.to_thread(
                SSHFileTransfer.write_text_file, conn, path, content, p.get("encoding", "utf-8")
            )
        except Exception as exc:
            raise _map_transfer_error(exc) from exc
        get_event_log().emit("ssh_file_write", connection_id=p.get("conn_id"), path=path, bytes=len(content))
        await self._result(req_id, result)

    async def _m_ssh_upload(self, req_id: str, p: dict) -> None:
        conn = self._connection_or_raise(p.get("conn_id", ""))
        try:
            destination = await asyncio.to_thread(
                SSHFileTransfer.upload_local_file,
                conn,
                p.get("local_path"),
                p.get("remote_path"),
                bool(p.get("overwrite", False)),
            )
        except Exception as exc:
            raise _map_transfer_error(exc) from exc
        get_event_log().emit("ssh_file_upload", connection_id=p.get("conn_id"), remote_path=destination)
        await self._result(req_id, {"success": True, "local_path": p.get("local_path"), "remote_path": destination})

    async def _m_ssh_download(self, req_id: str, p: dict) -> None:
        conn = self._connection_or_raise(p.get("conn_id", ""))
        try:
            source = await asyncio.to_thread(
                SSHFileTransfer.download_to_local_file, conn, p.get("remote_path"), p.get("local_path")
            )
        except Exception as exc:
            raise _map_transfer_error(exc) from exc
        get_event_log().emit("ssh_file_download", connection_id=p.get("conn_id"), remote_path=source)
        await self._result(req_id, {"success": True, "remote_path": source, "local_path": p.get("local_path")})

    async def _m_ssh_mkdir(self, req_id: str, p: dict) -> None:
        conn = self._connection_or_raise(p.get("conn_id", ""))
        try:
            created = await asyncio.to_thread(SSHFileTransfer.create_directory, conn, p.get("path"))
        except Exception as exc:
            raise _map_transfer_error(exc) from exc
        await self._result(req_id, {"success": True, "path": created})

    async def _m_ssh_delete_paths(self, req_id: str, p: dict) -> None:
        conn = self._connection_or_raise(p.get("conn_id", ""))
        paths = p.get("paths") or []
        try:
            result = await asyncio.to_thread(SSHFileTransfer.delete_paths, conn, paths)
        except Exception as exc:
            raise _map_transfer_error(exc) from exc
        get_event_log().emit("ssh_paths_delete", connection_id=p.get("conn_id"), paths=paths[:5])
        await self._result(req_id, {"success": True, **result})

    # ------------------------------------------------------------------
    # Method table
    # ------------------------------------------------------------------

    _METHODS: dict[str, Callable[["AgentWSHandler", str, dict], Awaitable[None]]] = {
        "terminal.create": _m_terminal_create,
        "terminal.list": _m_terminal_list,
        "terminal.get": _m_terminal_get,
        "terminal.delete": _m_terminal_delete,
        "terminal.snapshot": _m_terminal_snapshot,
        "terminal.input": _m_terminal_input,
        "terminal.exec": _m_terminal_exec,
        "terminal.stream": _m_terminal_stream,
        "ssh.connections.list": _m_ssh_connections_list,
        "ssh.connections.create": _m_ssh_connections_create,
        "ssh.connections.get": _m_ssh_connections_get,
        "ssh.connections.update": _m_ssh_connections_update,
        "ssh.connections.delete": _m_ssh_connections_delete,
        "ssh.import_electerm": _m_ssh_import_electerm,
        "ssh.run": _m_ssh_run,
        "ssh.run_async": _m_ssh_run_async,
        "job.list": _m_job_list,
        "job.get": _m_job_get,
        "job.cancel": _m_job_cancel,
        "events.recent": _m_events_recent,
        "events.stream": _m_events_stream,
        "ssh.files.list": _m_ssh_files_list,
        "ssh.files.read": _m_ssh_files_read,
        "ssh.files.write": _m_ssh_files_write,
        "ssh.upload": _m_ssh_upload,
        "ssh.download": _m_ssh_download,
        "ssh.mkdir": _m_ssh_mkdir,
        "ssh.delete_paths": _m_ssh_delete_paths,
    }
