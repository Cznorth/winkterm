# 工具模块
from backend.agent.tools.terminal import TERMINAL_TOOLS, TOOLS_BY_NAME, get_terminal_context
from backend.agent.tools.terminal import set_pty_manager, set_has_ai_output
from backend.agent.tools.monitoring import MONITORING_TOOLS

# 工具注册表：模块名 -> 工具列表
TOOL_MODULES = {
    "terminal": TERMINAL_TOOLS,
    "monitoring": MONITORING_TOOLS,
}

# 所有可用工具（按名称）
ALL_TOOLS_BY_NAME = {
    **TOOLS_BY_NAME,
}


def get_tools(tool_specs: list[str]) -> list:
    """根据工具规格列表获取工具。

    Args:
        tool_specs: 工具规格列表，支持两种格式：
            - "terminal" - 加载整个模块的工具
            - "terminal_input" - 加载指定工具

    Returns:
        工具列表
    """
    tools = []
    for spec in tool_specs:
        # 先检查是否是完整工具名
        if spec in ALL_TOOLS_BY_NAME:
            tools.append(ALL_TOOLS_BY_NAME[spec])
        # 再检查是否是模块名
        elif spec in TOOL_MODULES:
            tools.extend(TOOL_MODULES[spec])
        else:
            import logging
            logging.getLogger("tools").warning(f"未知工具或模块: {spec}")
    return tools
