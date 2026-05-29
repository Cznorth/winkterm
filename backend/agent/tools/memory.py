"""AI 长期记忆工具。"""

from __future__ import annotations

from langchain_core.tools import tool

from backend.config import AgentDocs


@tool
def save_memory(content: str) -> str:
    """更新你的长期记忆（memory.md），传入整篇新内容（Markdown）会覆盖旧记忆。

    用于记住跨会话有用的事实：用户偏好、主机/环境信息、已验证的操作方法等。
    调用前请基于 <memory> 块里的现有内容做增删改，保留仍然有用的条目，避免丢失。
    """
    AgentDocs.write_memory(content)
    return "记忆已更新"


MEMORY_TOOLS = [save_memory]
MEMORY_TOOLS_BY_NAME = {t.name: t for t in MEMORY_TOOLS}
