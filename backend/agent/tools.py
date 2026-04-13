from __future__ import annotations

from typing import TYPE_CHECKING

from langchain_core.tools import tool

if TYPE_CHECKING:
    from backend.terminal.pty_manager import PtyManager

# pty_manager 由外部注入，避免循环导入
_pty_manager: "PtyManager | None" = None
_has_ai_output: bool = False  # 标记 AI 是否有文本输出


def set_pty_manager(manager: "PtyManager") -> None:
    global _pty_manager
    _pty_manager = manager


def set_has_ai_output(value: bool) -> None:
    """设置 AI 是否有文本输出的标志。"""
    global _has_ai_output
    _has_ai_output = value


def _require_pty() -> "PtyManager":
    return _pty_manager


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


ALL_TOOLS = [write_command]
