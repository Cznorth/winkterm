"""Agent 工具注册。"""

from backend.agent.tools.terminal import TERMINAL_TOOLS, TOOLS_BY_NAME
from backend.agent.tools.terminal_legacy import (
    LEGACY_TERMINAL_TOOLS,
    LEGACY_TOOLS_BY_NAME,
    set_has_ai_output,
    get_terminal_context_raw,
)
from backend.agent.tools.monitoring import MONITORING_TOOLS

TOOL_MODULES = {
    "terminal": TERMINAL_TOOLS,
    "terminal_legacy": LEGACY_TERMINAL_TOOLS,
    "monitoring": MONITORING_TOOLS,
}

ALL_TOOLS_BY_NAME = {**TOOLS_BY_NAME, **LEGACY_TOOLS_BY_NAME}


def get_tools(tool_specs: list[str]) -> list:
    """根据规格列表获取工具,支持模块名或单个工具名。"""
    tools = []
    for spec in tool_specs:
        if spec in ALL_TOOLS_BY_NAME:
            tools.append(ALL_TOOLS_BY_NAME[spec])
        elif spec in TOOL_MODULES:
            tools.extend(TOOL_MODULES[spec])
        else:
            import logging
            logging.getLogger("agent.tools").warning(f"未知工具或模块: {spec}")
    return tools
