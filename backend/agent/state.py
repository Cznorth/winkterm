from __future__ import annotations

from typing import Annotated, Sequence
from typing_extensions import TypedDict
from langchain_core.messages import BaseMessage
import operator


class AgentState(TypedDict):
    messages: Annotated[Sequence[BaseMessage], operator.add]
    terminal_output: str          # 最近 N 行终端内容（来自 pty_manager.get_context）
    analysis_result: str          # 本轮分析结论摘要
    llm_calls: int                # 本轮 LLM 调用次数，防止无限循环
    waiting_user: bool            # 是否已写入命令等待用户操作，agent 应终止
