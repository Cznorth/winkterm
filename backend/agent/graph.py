"""Agent 图入口（保持向后兼容）。

这个文件现在只是一个便捷入口，实际的图构建由 factory.py 完成。
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from backend.agent.factory import get_agent

if TYPE_CHECKING:
    from langgraph.graph import CompiledGraph

logger = logging.getLogger("agent.graph")

# 缓存
_graph: CompiledGraph | None = None


def get_graph() -> CompiledGraph:
    """获取终端内 Agent 的编译图（向后兼容）。

    这个函数保持原有的 API 不变，但内部使用新的工厂模式。
    """
    global _graph
    if _graph is None:
        _graph = get_agent("terminal")
        logger.info("[graph] 已编译 terminal agent")
    return _graph
