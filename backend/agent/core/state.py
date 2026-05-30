"""共享状态定义。"""

from __future__ import annotations

from typing import Annotated, Any, Callable, Optional, Sequence
from typing_extensions import TypedDict
from langchain_core.messages import BaseMessage
import operator


class AgentState(TypedDict, total=False):
    """Agent 状态，所有 Agent 共享。"""
    messages: Annotated[Sequence[BaseMessage], operator.add]
    terminal_output: str          # 最近 N 行终端内容
    analysis_result: str          # 本轮分析结论摘要
    llm_calls: int                # 本轮 LLM 调用次数
    waiting_user: bool            # 是否已写入命令等待用户操作
    ask_mode: bool                # ask mode: each tool needs user confirmation before running
    approval_emit: Optional[Callable[[dict], Any]]  # async broadcaster, pushes approval requests to the frontend
