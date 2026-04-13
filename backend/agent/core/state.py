"""共享状态定义。"""

from __future__ import annotations

from typing import Annotated, Sequence
from typing_extensions import TypedDict
from langchain_core.messages import BaseMessage
import operator


class AgentState(TypedDict):
    """Agent 状态，所有 Agent 共享。"""
    messages: Annotated[Sequence[BaseMessage], operator.add]
    terminal_output: str          # 最近 N 行终端内容
    analysis_result: str          # 本轮分析结论摘要
    llm_calls: int                # 本轮 LLM 调用次数
    waiting_user: bool            # 是否已写入命令等待用户操作
