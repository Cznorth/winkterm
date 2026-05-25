"""轻量终端工具(供 terminal agent 用)。

terminal agent 是用户在终端里输入 `# ...` 触发的快速对话:
只操作当前激活终端,工具集刻意保持精简,降低 token 消耗与延迟。
对应"人机合一"场景。

跨终端编排走 craft agent + tools/terminal.py 的完整工具集。
"""

from __future__ import annotations

from langchain_core.tools import tool

from backend.terminal.session_manager import get_session_manager

# 是否有 AI 输出过的标志(供 ws_handler 决定写命令前是否清行)
_has_ai_output: bool = False


def set_has_ai_output(value: bool) -> None:
    global _has_ai_output
    _has_ai_output = value


def _get_active_pty():
    """获取当前激活会话的 pty。"""
    session = get_session_manager().get_active_session()
    return session.pty if session else None


def get_terminal_context_raw(lines: int = 50) -> str:
    """从激活会话拿终端上下文(供 ws_chat 直接调用)。"""
    pty = _get_active_pty()
    if pty is None:
        return ""
    return pty.get_context(lines) or ""


@tool
async def write_command(command: str) -> str:
    """把命令写入终端输入行(不执行),然后终止等待用户操作。

    这是最终操作:agent 会停止,等用户决定是否执行。
    """
    pty = _get_active_pty()
    if pty is None:
        return "[无终端会话] 无法写入命令"

    if _has_ai_output:
        pty.write(b"\r")  # 换行清除 AI 输出残留

    pty.write_command(command)
    return f"[WAIT_FOR_USER] 命令已写入终端,等待用户执行: {command}"


@tool
def get_terminal_context(lines: int = 50) -> str:
    """获取最近的终端输出(只读)。"""
    pty = _get_active_pty()
    if pty is None:
        return "[无终端会话]"
    return pty.get_context(lines) or "[终端无内容]"


LEGACY_TERMINAL_TOOLS = [write_command, get_terminal_context]
LEGACY_TOOLS_BY_NAME = {t.name: t for t in LEGACY_TERMINAL_TOOLS}
