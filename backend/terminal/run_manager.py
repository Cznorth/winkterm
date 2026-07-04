"""Managed terminal runs for agent-friendly long command execution.

The classic ``TerminalSession.exec`` waits for completion in one request. That is
fine for short commands, but agents need a start -> wait/status -> cancel protocol
for long-running work because many agent runtimes do not surface streaming stderr
while a tool call is still active.
"""

from __future__ import annotations

import asyncio
import re
import shlex
import sys
import time
import uuid
from dataclasses import dataclass, field
from typing import Optional

from backend.terminal._term_utils import decode_b64, decode_terminal_text, strip_ansi, strip_command_echo
from backend.terminal.session_manager import TerminalSession, get_session_manager


def _ps_quote(value: str) -> str:
    return "'" + str(value).replace("'", "''") + "'"


@dataclass
class ManagedRun:
    id: str
    terminal_id: str
    command: str
    start_offset: int
    sentinel: str
    timeout: float
    cancel_on_timeout: bool
    cwd_arg: Optional[str] = None
    env_arg: Optional[dict[str, str]] = None
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)
    status: str = "running"
    exit_code: Optional[int] = None
    cwd: Optional[str] = None
    reason: Optional[str] = None
    error: Optional[str] = None
    size: int = 0
    done_offset: Optional[int] = None
    event: asyncio.Event = field(default_factory=asyncio.Event)
    task: Optional[asyncio.Task] = None

    @property
    def done(self) -> bool:
        return self.status != "running"


class TerminalRunManager:
    """In-memory manager for background runs.

    Runs are intentionally process-local and survive client disconnects, but not a
    backend restart. Terminal output itself remains in the session buffer.
    """

    _instance: "TerminalRunManager | None" = None

    def __new__(cls) -> "TerminalRunManager":
        if cls._instance is None:
            cls._instance = super().__new__(cls)
            cls._instance._runs = {}
            cls._instance._active_by_terminal = {}
            cls._instance._lock = asyncio.Lock()
        return cls._instance

    async def start(
        self,
        terminal_id: str,
        command: str = "",
        command_b64: Optional[str] = None,
        timeout: float = 3600.0,
        cancel_on_timeout: bool = False,
        cwd: Optional[str] = None,
        env: Optional[dict[str, str]] = None,
    ) -> dict:
        session = get_session_manager().get_session(terminal_id)
        if not session:
            raise ValueError("终端不存在")
        if not session.is_alive():
            raise ValueError("终端已关闭")

        final_command = self._final_command(command, command_b64)
        wrapped, sentinel = self._wrap_command(
            final_command,
            cwd,
            env,
            powershell=sys.platform == "win32" and session.type == "local",
        )

        async with self._lock:
            existing = self._active_by_terminal.get(terminal_id)
            if existing:
                run = self._runs.get(existing)
                if run and not run.done:
                    raise ValueError(f"终端已有运行中的任务: {existing}")

            with session._lock:
                start_offset = session._total
            run_id = uuid.uuid4().hex[:12]
            run = ManagedRun(
                id=run_id,
                terminal_id=terminal_id,
                command=final_command,
                start_offset=start_offset,
                sentinel=sentinel,
                timeout=float(timeout),
                cancel_on_timeout=bool(cancel_on_timeout),
                cwd_arg=cwd,
                env_arg=env,
                cwd=session.cwd,
                size=start_offset,
            )
            self._runs[run_id] = run
            self._active_by_terminal[terminal_id] = run_id

        session.pty.write(wrapped.encode("utf-8"))
        run.task = asyncio.create_task(self._monitor(run))
        return self._response(run, since=start_offset)

    async def status(self, run_id: str, since: Optional[int] = None) -> dict:
        run = self._get(run_id)
        return self._response(run, since=since)

    async def wait(self, run_id: str, since: Optional[int] = None, timeout: float = 30.0) -> dict:
        run = self._get(run_id)
        if self._has_update(run, since):
            return self._response(run, since=since)

        run.event.clear()
        if self._has_update(run, since):
            return self._response(run, since=since)

        try:
            await asyncio.wait_for(run.event.wait(), timeout=max(0.0, float(timeout)))
        except asyncio.TimeoutError:
            data = self._response(run, since=since)
            data["event"] = "wait_timeout" if data.get("status") == "running" and not data.get("output") else data.get("event")
            return data
        finally:
            run.event.clear()
        return self._response(run, since=since)

    async def cancel(self, run_id: str, mode: str = "ctrl_c") -> dict:
        run = self._get(run_id)
        if run.done:
            return self._response(run)
        session = self._session(run)
        if mode == "close":
            get_session_manager().close(run.terminal_id)
        else:
            session.pty.write(b"\x03")
        run.status = "cancelled"
        run.reason = "cancelled"
        run.updated_at = time.time()
        run.event.set()
        async with self._lock:
            self._active_by_terminal.pop(run.terminal_id, None)
        return self._response(run)

    def _get(self, run_id: str) -> ManagedRun:
        run = self._runs.get(run_id)
        if not run:
            raise ValueError("任务不存在")
        return run

    def _session(self, run: ManagedRun) -> TerminalSession:
        session = get_session_manager().get_session(run.terminal_id)
        if not session:
            raise ValueError("终端不存在")
        return session

    @staticmethod
    def _final_command(command: str = "", command_b64: Optional[str] = None) -> str:
        if command_b64:
            command = (command or "") + decode_b64(command_b64)
        command = (command or "").rstrip("\n")
        if not command:
            raise ValueError("命令为空")
        return command

    @staticmethod
    def _wrap_command(
        command: str,
        cwd: Optional[str],
        env: Optional[dict[str, str]],
        powershell: bool = False,
    ) -> tuple[str, str]:
        sentinel = f"__WT_RUN_{uuid.uuid4().hex[:12]}__"
        if powershell:
            env_clause = ""
            if env:
                exports: list[str] = []
                for k, v in env.items():
                    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", k):
                        raise ValueError(f"非法环境变量名: {k!r}")
                    exports.append(f"$env:{k}={_ps_quote(v)}")
                env_clause = "; ".join(exports) + "; "
            cd_clause = f"Set-Location {_ps_quote(cwd)}; " if cwd else ""
            core = f"{cd_clause}{env_clause}{command}"
            wrapped = (
                f"{core}; "
                "$__wt_ec = if ($?) { 0 } elseif ($null -ne $LASTEXITCODE) { $LASTEXITCODE } else { 1 }; "
                f"Write-Output ''; Write-Output \"{sentinel}${{__wt_ec}}:$((Get-Location).Path)\"\r"
            )
            return wrapped, sentinel

        export_clause = ""
        if env:
            exports: list[str] = []
            for k, v in env.items():
                if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", k):
                    raise ValueError(f"非法环境变量名: {k!r}")
                exports.append(f"export {k}={shlex.quote(v)}")
            export_clause = "; ".join(exports) + "; "

        if cwd or env:
            user_cmd = command.replace("\n", "; ")
            cd_clause = f"cd {shlex.quote(cwd)}; " if cwd else ""
            core = f"( {cd_clause}{export_clause}{user_cmd} )"
        else:
            core = command
        wrapped = f"{core}; printf '\\n{sentinel}%d:%s\\n' \"$?\" \"$PWD\"\r"
        return wrapped, sentinel

    async def _monitor(self, run: ManagedRun) -> None:
        pattern = re.compile(rf"{re.escape(run.sentinel)}(\d+):([^\r\n]*)(?:\r?\n|$)")
        deadline = time.monotonic() + run.timeout if run.timeout > 0 else None
        last_size = run.start_offset
        try:
            while run.status == "running":
                await asyncio.sleep(0.2)
                session = self._session(run)
                with session._lock:
                    total = session._total
                    buf_start = total - len(session._raw)
                    chunk_offset = max(0, run.start_offset - buf_start)
                    chunk = bytes(session._raw[chunk_offset:])
                if total != last_size:
                    last_size = total
                    run.size = total
                    run.updated_at = time.time()
                    run.event.set()

                text = strip_ansi(decode_terminal_text(chunk))
                match = pattern.search(text)
                if match:
                    exit_code = int(match.group(1))
                    run.exit_code = exit_code
                    run.cwd = self._clean_cwd(match.group(2)) or run.cwd
                    session.cwd = run.cwd or session.cwd
                    run.status = "success" if exit_code == 0 else "failed"
                    run.reason = None
                    run.done_offset = total
                    run.size = total
                    run.updated_at = time.time()
                    run.event.set()
                    break

                if deadline is not None and time.monotonic() >= deadline:
                    run.status = "timeout"
                    run.reason = "timeout"
                    if run.cancel_on_timeout:
                        session.pty.write(b"\x03")
                        run.status = "timeout_cancelled"
                        run.reason = "timeout_cancelled"
                    run.size = total
                    run.updated_at = time.time()
                    run.event.set()
                    break
        except Exception as exc:
            run.status = "error"
            run.error = str(exc)
            run.reason = "error"
            run.updated_at = time.time()
            run.event.set()
        finally:
            async with self._lock:
                if self._active_by_terminal.get(run.terminal_id) == run.id:
                    self._active_by_terminal.pop(run.terminal_id, None)

    def _has_update(self, run: ManagedRun, since: Optional[int]) -> bool:
        if run.done:
            return True
        if since is None:
            since = run.start_offset
        return run.size > since

    @staticmethod
    def _clean_cwd(value: str) -> str:
        """Clean cwd captured from a sentinel line.

        POSIX shells print a newline after the sentinel. PowerShell-compatible
        shims may render the prompt immediately after the path, so strip a
        glued ``PS ...>`` prompt tail when present.
        """
        cwd = (value or "").strip()
        if "PS " in cwd:
            cwd = cwd.split("PS ", 1)[0].rstrip()
        return cwd

    def _response(self, run: ManagedRun, since: Optional[int] = None) -> dict:
        session = get_session_manager().get_session(run.terminal_id)
        output = ""
        size = run.size
        alive = False
        if session:
            if since is None:
                since = run.start_offset
            snap = session.snapshot(since=since, strip=True)
            output = snap["output"]
            size = snap["size"]
            alive = snap["alive"]

            if run.done and output:
                idx = output.find(run.sentinel)
                if idx >= 0:
                    output = output[:idx]
                output = strip_command_echo(output, run.command).rstrip("\n")

        event = "done" if run.done else ("output" if output else "status")
        return {
            "run_id": run.id,
            "terminal_id": run.terminal_id,
            "status": run.status,
            "done": run.done,
            "event": event,
            "output": output,
            "size": size,
            "since": since,
            "exit_code": run.exit_code,
            "cwd": run.cwd,
            "reason": run.reason,
            "error": run.error,
            "alive": alive,
            "created_at": run.created_at,
            "updated_at": run.updated_at,
        }


def get_run_manager() -> TerminalRunManager:
    return TerminalRunManager()
