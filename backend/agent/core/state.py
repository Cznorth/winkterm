"""Shared state definitions."""

from __future__ import annotations

from typing import Annotated, Any, Callable, Optional, Sequence
from typing_extensions import TypedDict
from langchain_core.messages import BaseMessage
import operator


class AgentState(TypedDict, total=False):
    """Agent state, shared by all agents."""
    messages: Annotated[Sequence[BaseMessage], operator.add]
    terminal_output: str          # Last N lines of terminal content
    analysis_result: str          # Summary of this round's analysis conclusion
    llm_calls: int                # Number of LLM calls this round
    waiting_user: bool            # Whether a command has been written and is awaiting user action
    ask_mode: bool                # ask mode: each tool needs user confirmation before running
    approval_emit: Optional[Callable[[dict], Any]]  # async broadcaster, pushes approval requests to the frontend
