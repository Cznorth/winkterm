# 工具模块
from backend.agent.tools.terminal import TERMINAL_TOOLS, get_terminal_context
from backend.agent.tools.terminal import set_pty_manager, set_has_ai_output
from backend.agent.tools.monitoring import MONITORING_TOOLS

# 工具注册表：模块名 -> 工具列表
TOOL_MODULES = {
    "terminal": TERMINAL_TOOLS,
    "monitoring": MONITORING_TOOLS,
}


def get_tools(module_names: list[str]) -> list:
    """根据模块名列表获取工具。"""
    tools = []
    for name in module_names:
        if name in TOOL_MODULES:
            tools.extend(TOOL_MODULES[name])
    return tools
