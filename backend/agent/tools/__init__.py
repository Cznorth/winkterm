"""Agent tool registration."""

from backend.agent.tools.terminal import TERMINAL_TOOLS, TOOLS_BY_NAME
from backend.agent.tools.terminal_legacy import (
    LEGACY_TERMINAL_TOOLS,
    LEGACY_TOOLS_BY_NAME,
    set_has_ai_output,
    get_terminal_context_raw,
)
from backend.agent.tools.monitoring import MONITORING_TOOLS
from backend.agent.tools.memory import MEMORY_TOOLS, MEMORY_TOOLS_BY_NAME

TOOL_MODULES = {
    "terminal": TERMINAL_TOOLS,
    "terminal_legacy": LEGACY_TERMINAL_TOOLS,
    "monitoring": MONITORING_TOOLS,
    "memory": MEMORY_TOOLS,
}

ALL_TOOLS_BY_NAME = {**TOOLS_BY_NAME, **LEGACY_TOOLS_BY_NAME, **MEMORY_TOOLS_BY_NAME}


def get_tools(tool_specs: list[str]) -> list:
    """Get tools from a spec list; supports module names or individual tool names."""
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
