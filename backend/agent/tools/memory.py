"""AI long-term memory tools."""

from __future__ import annotations

from langchain_core.tools import tool

from backend.config import AgentDocs


@tool
def save_memory(content: str) -> str:
    """Update your long-term memory (memory.md); passing full new Markdown content replaces the old memory.

    Use this to remember facts useful across sessions: user preferences, host/environment info,
    verified procedures, etc. Before calling, edit the existing content from the <memory> block:
    add, remove, or change entries while keeping still-useful ones to avoid losing information.
    """
    AgentDocs.write_memory(content)
    return "记忆已更新"


MEMORY_TOOLS = [save_memory]
MEMORY_TOOLS_BY_NAME = {t.name: t for t in MEMORY_TOOLS}
