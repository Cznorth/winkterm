"""Lightweight terminal tools (for the terminal agent).

The terminal agent is the quick conversation triggered when the user types
`# ...` in the terminal: it only operates on the currently active terminal,
and the toolset is deliberately kept minimal to reduce token usage and latency.
This corresponds to the "human-machine fusion" scenario.

Cross-terminal orchestration uses the full toolset of craft agent + tools/terminal.py.
"""

from __future__ import annotations

from langchain_core.tools import tool

from backend.terminal.session_manager import get_session_manager

# Flag for whether the AI has produced output (used by ws_handler to decide whether to clear the line before writing a command)
_has_ai_output: bool = False


def set_has_ai_output(value: bool) -> None:
    global _has_ai_output
    _has_ai_output = value


def _get_active_pty():
    """Get the pty of the currently active session."""
    session = get_session_manager().get_active_session()
    return session.pty if session else None


def get_terminal_context_raw(lines: int = 50) -> str:
    """Get the terminal context from the active session (called directly by ws_chat)."""
    pty = _get_active_pty()
    if pty is None:
        return ""
    return pty.get_context(lines) or ""


@tool
async def write_command(command: str) -> str:
    """Write the command into the terminal input line (without running it), then stop and wait for the user.

    This is a terminal action: the agent stops and waits for the user to decide whether to execute it.
    """
    pty = _get_active_pty()
    if pty is None:
        return "[无终端会话] 无法写入命令"

    if _has_ai_output:
        pty.write(b"\r")  # Newline to clear leftover AI output

    pty.write_command(command)
    return f"[WAIT_FOR_USER] 命令已写入终端,等待用户执行: {command}"


@tool
def get_terminal_context(lines: int = 50) -> str:
    """Get the most recent terminal output (read-only)."""
    pty = _get_active_pty()
    if pty is None:
        return "[无终端会话]"
    return pty.get_context(lines) or "[终端无内容]"


LEGACY_TERMINAL_TOOLS = [write_command, get_terminal_context]
LEGACY_TOOLS_BY_NAME = {t.name: t for t in LEGACY_TERMINAL_TOOLS}
