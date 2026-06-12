"""Unified terminal toolset.

Called by the LangGraph agent; backed by SessionManager (same source as the
external HTTP API). All tools take an explicit terminal_id; the agent decides
which terminal to operate on based on the terminal list injected into each
round's system prompt.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Optional

from langchain_core.tools import tool

from backend.terminal._term_utils import UnknownKeyError
from backend.terminal.session_manager import get_session_manager

logger = logging.getLogger("agent.tools.terminal")


def _truncate(value: object, limit: int = 4000) -> object:
    """Truncate tool results to avoid flooding the LLM context in one return."""
    if isinstance(value, str) and len(value) > limit:
        return value[:limit] + f"...(已截断,原长 {len(value)})"
    if isinstance(value, dict):
        out = dict(value)
        for k in ("output", "stdout"):
            if isinstance(out.get(k), str) and len(out[k]) > limit:
                out[k] = out[k][:limit] + f"...(已截断,原长 {len(out[k])})"
        return out
    return value


# ---------------------------------------------------------------------------
# Terminal management
# ---------------------------------------------------------------------------

@tool
def list_terminals() -> dict:
    """List all terminal sessions (including the user-active flag).

    Key returned fields: id / type / title / is_user_active / user_visible /
    created_by / idle_seconds / cwd / last_command.

    The terminal list is usually injected into each round's prompt; use this
    tool to refresh it or when more detailed fields are needed.
    """
    return {"terminals": get_session_manager().list_terminals()}


@tool
async def create_terminal(
    terminal_type: str = "local",
    connection_id: Optional[str] = None,
    name: str = "",
    cols: int = 120,
    rows: int = 40,
    ttl_seconds: float = 1800.0,
) -> dict:
    """Create a new terminal session (always shown in the user's tab bar).

    Args:
        terminal_type: "local" for a local shell / "ssh" for an SSH connection
            (requires connection_id).
        connection_id: Required for the SSH type, from list_ssh_connections.
        name: Terminal display name (optional, shown on the tab).
        ttl_seconds: Idle reclaim time; 0/negative = never expires.

    All agent-created terminals are visible to the user (transparent and
    auditable). Remember to close_terminal when done to avoid cluttering the
    tab bar.
    """
    try:
        session = await get_session_manager().create(
            terminal_type=terminal_type,
            connection_id=connection_id,
            cols=cols,
            rows=rows,
            name=name,
            ttl_seconds=ttl_seconds,
            created_by="agent:internal",
            user_visible=True,
            transient=False,
        )
    except ValueError as exc:
        return {"ok": False, "error": str(exc)}
    return session.info(is_user_active=False)


@tool
def close_terminal(terminal_id: str) -> dict:
    """Close and delete the specified terminal."""
    ok = get_session_manager().close(terminal_id)
    return {"ok": ok, "terminal_id": terminal_id}


# ---------------------------------------------------------------------------
# Terminal interaction
# ---------------------------------------------------------------------------

@tool
def terminal_snapshot(
    terminal_id: str,
    since: Optional[int] = None,
    strip_ansi: bool = True,
    pattern: Optional[str] = None,
    context: int = 0,
    case_insensitive: bool = False,
) -> dict:
    """Read a snapshot of terminal output (read-only).

    Args:
        terminal_id: Terminal id.
        since: Absolute byte offset; pass None first to fetch everything, then
            pass the size returned last time.
        pattern: When given, returns matching lines via a grep field.
        context: Number of grep context lines (0-20).
    """
    session = get_session_manager().get_session(terminal_id)
    if not session:
        return {"ok": False, "error": f"终端不存在: {terminal_id}"}
    try:
        result = session.snapshot(
            since=since,
            strip=strip_ansi,
            pattern=pattern,
            context=context,
            case_insensitive=case_insensitive,
        )
    except ValueError as exc:
        return {"ok": False, "error": str(exc)}
    return _truncate(result)  # type: ignore[return-value]


@tool
async def terminal_input(
    terminal_id: str,
    data: str = "",
    keys: Optional[list[str]] = None,
    enter: bool = True,
    wait: bool = False,
    timeout: float = 10.0,
    idle: float = 0.6,
    strip_echo: bool = False,
    halt_for_user: bool = False,
) -> dict:
    """Send input to a terminal (command / control keys / raw text).

    Args:
        terminal_id: Target terminal id.
        data: Text content (the command itself).
        keys: Array of named control keys, e.g. ["ctrl+c"], ["up","enter"].
        enter: Whether to append a carriage return at the end (default true).
        wait: Whether to wait for output to settle before returning.
        halt_for_user: Set true to write without executing and wait for the
            user's decision (use together with enter=false). The agent ends
            this round and hands control back to the user. Suitable for the
            "suggest a command but let the user confirm execution" scenario.
    """
    session = get_session_manager().get_session(terminal_id)
    if not session:
        return {"ok": False, "error": f"终端不存在: {terminal_id}"}
    try:
        result = await session.send(
            data=data,
            keys=keys,
            enter=enter,
            wait=wait,
            timeout=timeout,
            idle=idle,
            strip_echo=strip_echo,
        )
    except UnknownKeyError as exc:
        return {"ok": False, "error": str(exc)}
    except ValueError as exc:
        return {"ok": False, "error": str(exc)}
    if halt_for_user:
        result["_halt_for_user"] = True
    return _truncate(result)  # type: ignore[return-value]


@tool
async def terminal_exec(
    terminal_id: str,
    command: str,
    timeout: float = 30.0,
    cwd: Optional[str] = None,
    env: Optional[dict[str, str]] = None,
) -> dict:
    """Atomically run a POSIX shell command; returns stdout + exit_code + cwd.

    cwd / env are injected via a subshell so the terminal's persistent state
    is not polluted. The command includes a sentinel to track the exit code,
    suitable for cases needing a reliable success/failure determination.

    Args:
        terminal_id: Target terminal id.
        command: Command string.
        timeout: Timeout in seconds.
    """
    session = get_session_manager().get_session(terminal_id)
    if not session:
        return {"ok": False, "error": f"终端不存在: {terminal_id}"}
    try:
        result = await session.exec(
            command=command,
            timeout=timeout,
            cwd=cwd,
            env=env,
        )
    except ValueError as exc:
        return {"ok": False, "error": str(exc)}
    return _truncate(result)  # type: ignore[return-value]


# ---------------------------------------------------------------------------
# SSH helpers
# ---------------------------------------------------------------------------

@tool
def list_ssh_connections() -> dict:
    """List all configured SSH connections (passwords redacted).

    Each entry includes has_runbook; use get_ssh_runbook to read the full
    ops runbook for a server.
    """
    from backend.ssh.connection_manager import SSHConnectionManager

    return SSHConnectionManager.list_connections()


@tool
def get_ssh_runbook(connection_id: str) -> dict:
    """Read the ops runbook (markdown notes) for an SSH connection.

    The runbook holds server-specific ops knowledge: service layout, deploy
    steps, restart commands, gotchas, credentials hints. Read it before
    operating on an unfamiliar server.
    """
    from backend.ssh.connection_manager import SSHConnectionManager

    data = SSHConnectionManager.get_runbook(connection_id)
    if data is None:
        return {"ok": False, "error": f"SSH 连接不存在: {connection_id}"}
    return {"ok": True, **data}


@tool
def update_ssh_runbook(connection_id: str, runbook: str) -> dict:
    """Replace the ops runbook (markdown) for an SSH connection.

    This overwrites the whole runbook, so pass the full new content (read the
    current text with get_ssh_runbook first, then edit and write it back).
    Record durable ops knowledge you discover: topology, fixes, pitfalls.
    """
    from backend.ssh.connection_manager import SSHConnectionManager

    result = SSHConnectionManager.update_runbook(connection_id, runbook)
    if not result.get("success"):
        return {"ok": False, "error": f"SSH 连接不存在: {connection_id}"}
    return {"ok": True, "connection_id": connection_id}


@tool
async def ssh_run(
    connection_id: str,
    command: str,
    timeout: float = 60.0,
    initial_wait: float = 12.0,
    cwd: Optional[str] = None,
    env: Optional[dict[str, str]] = None,
) -> dict:
    """One-shot SSH command: create a hidden terminal -> exec -> close.

    Suitable for one-off diagnostics/inspections without entering the user's
    tab bar. To reuse shell state (cd/env), use the two-step flow of
    create_terminal + terminal_exec.
    """
    from backend.ssh.connection_manager import SSHConnectionManager

    if not SSHConnectionManager.get_connection(connection_id):
        return {"ok": False, "error": f"SSH 连接不存在: {connection_id}"}

    sm = get_session_manager()
    try:
        session = await sm.create(
            terminal_type="ssh",
            connection_id=connection_id,
            cols=200,
            rows=50,
            name=f"oneshot:{connection_id}",
            ttl_seconds=max(timeout + 30, 120),
            created_by="agent:internal",
            user_visible=True,
            transient=False,
        )
    except ValueError as exc:
        return {"ok": False, "error": str(exc)}

    try:
        await session.wait_until_idle(idle=2.0, max_wait=max(initial_wait, 5.0))
        result = await session.exec(
            command=command,
            timeout=timeout,
            cwd=cwd,
            env=env,
        )
    finally:
        sm.close(session.id)
    return _truncate(result)  # type: ignore[return-value]


# ---------------------------------------------------------------------------
# General
# ---------------------------------------------------------------------------

@tool
async def wait(seconds: float) -> str:
    """Wait the given number of seconds, to let long tasks finish or observe log changes. Range 0-60."""
    seconds = min(max(seconds, 0), 60)
    await asyncio.sleep(seconds)
    return f"[等待完成] {seconds} 秒"


# ---------------------------------------------------------------------------
# Exports
# ---------------------------------------------------------------------------

TERMINAL_TOOLS = [
    list_terminals,
    create_terminal,
    close_terminal,
    terminal_snapshot,
    terminal_input,
    terminal_exec,
    list_ssh_connections,
    get_ssh_runbook,
    update_ssh_runbook,
    ssh_run,
    wait,
]

TOOLS_BY_NAME = {t.name: t for t in TERMINAL_TOOLS}
