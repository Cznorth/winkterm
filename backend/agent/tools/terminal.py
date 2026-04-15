"""终端交互工具模块。"""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING

from langchain_core.tools import tool

if TYPE_CHECKING:
    from backend.terminal.pty_manager import PtyManager

# pty_manager 由外部注入
_pty_manager: "PtyManager | None" = None
_has_ai_output: bool = False


def set_pty_manager(manager: "PtyManager") -> None:
    """注入 pty_manager 实例。"""
    global _pty_manager
    _pty_manager = manager


def set_has_ai_output(value: bool) -> None:
    """设置 AI 是否有文本输出的标志。"""
    global _has_ai_output
    _has_ai_output = value


def _require_pty() -> "PtyManager | None":
    return _pty_manager


def get_terminal_context_raw(lines: int = 50) -> str:
    """获取终端上下文的普通函数（非工具），供其他模块直接调用。"""
    pty = _require_pty()
    if pty is None:
        return ""

    context = pty.get_context(lines)
    return context if context else ""


# ---------------------------------------------------------------------------
# 工具定义
# ---------------------------------------------------------------------------

# 控制键映射
CONTROL_KEYS = {
    "Ctrl+C": b"\x03",
    "Ctrl+D": b"\x04",
    "Ctrl+Z": b"\x1a",
    "Ctrl+L": b"\x0c",
    "Ctrl+A": b"\x01",
    "Ctrl+E": b"\x05",
    "Ctrl+K": b"\x0b",
    "Ctrl+U": b"\x15",
    "Ctrl+W": b"\x17",
    "Ctrl+R": b"\x12",
    "Enter": b"\r",
    "Tab": b"\t",
    "Backspace": b"\x7f",
    "Up": b"\x1b[A",
    "Down": b"\x1b[B",
    "Right": b"\x1b[C",
    "Left": b"\x1b[D",
    "Home": b"\x1b[H",
    "End": b"\x1b[F",
    "Escape": b"\x1b",
}


@tool
async def terminal_input(input: str) -> str:
    """在终端执行输入并返回结果。

    Args:
        input: 要输入的内容
            - 命令: "ls -la", "npm install"
            - 控制键: "Ctrl+C", "Ctrl+D", "Up", "Down", "Enter"
            - 文本: 直接输入的字符串

    Returns:
        执行后的终端上下文（最近50行）
    """
    import logging

    logger = logging.getLogger("tools")
    pty = _require_pty()
    logger.info(f"[terminal_input] pty={pty}, input={input}")

    if pty is None:
        return "[无终端会话]"

    # 检查是否是控制键
    if input in CONTROL_KEYS:
        logger.info(f"[terminal_input] 发送控制键: {input}")
        pty.write(CONTROL_KEYS[input])
    else:
        # 普通命令：写入并执行
        logger.info(f"[terminal_input] 执行命令: {input}")
        pty.write_command(input)
        pty.write(b"\r\n")

    # 异步等待输出（不阻塞事件循环）
    await asyncio.sleep(0.3)

    # 返回终端上下文
    context = pty.get_context(50)
    return context if context else "[终端无内容]"


@tool
def write_command(command: str) -> str:
    """把命令写入终端输入行（不执行），然后终止等待用户操作。

    这是最终操作：调用此工具后 agent 会停止，等待用户决定是否执行命令。

    Args:
        command: 要写入输入行的 shell 命令
    """
    import logging

    logger = logging.getLogger("tools")
    pty = _require_pty()
    logger.info(f"[write_command] pty={pty}, command={command}")
    if pty is None:
        return "[无终端会话] 无法写入命令"

    # 如果之前有 AI 输出，先发送 Ctrl+C 清除当前行
    if _has_ai_output:
        logger.info("[write_command] 发送 Ctrl+C 清除 AI 输出行")
        pty.write(b"\x03")  # Ctrl+C

    pty.write_command(command)
    logger.info(f"[write_command] 命令已写入")
    return f"[WAIT_FOR_USER] 命令已写入终端，等待用户执行：{command}"


@tool
def get_terminal_context(lines: int = 50) -> str:
    """获取最近的终端输出内容（只读）。

    Args:
        lines: 获取的行数，默认50行
    """
    pty = _require_pty()
    if pty is None:
        return "[无终端会话]"

    context = pty.get_context(lines)
    if not context:
        return "[终端无内容]"

    return context


# 模块导出的工具列表
TERMINAL_TOOLS = [terminal_input, write_command, get_terminal_context]

# 按名称导出，供精细化配置
TOOLS_BY_NAME = {
    "terminal_input": terminal_input,
    "write_command": write_command,
    "get_terminal_context": get_terminal_context,
}
