"""Agent graph entry point (kept for backward compatibility).

This file is now just a convenience entry point; the actual graph
construction is done by factory.py.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from backend.agent.factory import get_agent

if TYPE_CHECKING:
    from langgraph.graph import CompiledGraph

logger = logging.getLogger("agent.graph")

# Cache
_graph: CompiledGraph | None = None


def get_graph() -> CompiledGraph:
    """Get the compiled graph for the in-terminal Agent (backward compatible).

    This function keeps the original API unchanged, but internally uses
    the new factory pattern.
    """
    global _graph
    if _graph is None:
        _graph = get_agent("terminal")
        logger.info("[graph] 已编译 terminal agent")
    return _graph
