"""Helpers for translating LangChain messages to Codex Responses input."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any

from langchain_core.messages import (
    AIMessage,
    BaseMessage,
    HumanMessage,
    SystemMessage,
    ToolMessage,
)
from langchain_openai.chat_models.base import _construct_responses_api_input


def codex_input_from_messages(messages: list[BaseMessage]) -> list[dict[str, Any]]:
    """Convert LangChain messages to Codex Responses API input items.

    Uses LangChain's Responses API converter so role/content mapping matches
    OpenAI's expected schema (user text, assistant output_text, top-level
    function_call / function_call_output).
    """
    non_system = [m for m in messages if not isinstance(m, SystemMessage)]
    return list(_construct_responses_api_input(non_system))


def function_call_output_item(call_id: str, output: str) -> dict[str, Any]:
    """Build a Responses API function_call_output item."""
    return {
        "type": "function_call_output",
        "call_id": call_id,
        "output": output,
    }


def normalize_function_call_item(item: dict[str, Any]) -> dict[str, Any]:
    """Normalize a Codex function_call output item for re-submission in input."""
    raw_args = item.get("arguments") or "{}"
    if not isinstance(raw_args, str):
        raw_args = json.dumps(raw_args, ensure_ascii=False)
    return {
        "type": "function_call",
        "call_id": item.get("call_id", ""),
        "name": item.get("name", ""),
        "arguments": raw_args,
        "status": item.get("status", "completed"),
    }


@dataclass
class CodexStreamResult:
    """Accumulated result from a Codex Responses websocket stream."""

    text: str = ""
    tool_calls: list[dict[str, Any]] = field(default_factory=list)


class CodexStreamParser:
    """Parse Codex Responses websocket events into text and tool calls.

    Mirrors openai-oauth's chat-stream tool delta handling: accumulate argument
    deltas when present, otherwise fall back to the completed function_call item.
    """

    def __init__(self) -> None:
        self._text_parts: list[str] = []
        self._pending_calls: dict[str, dict[str, Any]] = {}
        self._calls_with_deltas: set[str] = set()
        self._completed_calls: list[dict[str, Any]] = []

    def feed(self, event: dict[str, Any]) -> None:
        kind = event.get("type")
        if kind == "response.output_text.delta":
            self._text_parts.append(str(event.get("delta") or ""))
        elif kind == "response.refusal.delta":
            self._text_parts.append(str(event.get("delta") or ""))
        elif kind in ("response.output_item.added", "response.output_item.created"):
            item = event.get("item") or {}
            if item.get("type") != "function_call":
                return
            call_id = str(item.get("call_id") or item.get("id") or "")
            if not call_id:
                return
            self._pending_calls[call_id] = normalize_function_call_item(item)
        elif kind == "response.function_call_arguments.delta":
            call_id = str(event.get("call_id") or event.get("item_id") or "")
            if not call_id:
                return
            self._calls_with_deltas.add(call_id)
            pending = self._pending_calls.setdefault(
                call_id,
                {
                    "type": "function_call",
                    "call_id": call_id,
                    "name": str(event.get("name") or ""),
                    "arguments": "",
                    "status": "completed",
                },
            )
            pending["arguments"] = str(pending.get("arguments") or "") + str(
                event.get("delta") or ""
            )
        elif kind == "response.output_item.done":
            item = event.get("item") or {}
            if item.get("type") != "function_call":
                return
            call_id = str(item.get("call_id") or item.get("id") or "")
            normalized = normalize_function_call_item(item)
            if call_id and call_id in self._calls_with_deltas:
                self._pending_calls.pop(call_id, None)
                self._completed_calls.append(normalized)
                return
            if call_id and call_id in self._pending_calls:
                self._pending_calls.pop(call_id, None)
            self._completed_calls.append(normalized)

    def result(self) -> CodexStreamResult:
        tool_calls = list(self._completed_calls)
        for call_id, pending in self._pending_calls.items():
            if call_id not in self._calls_with_deltas:
                tool_calls.append(pending)
        return CodexStreamResult(text="".join(self._text_parts), tool_calls=tool_calls)


def append_tool_round_trip(
    input_items: list[dict[str, Any]],
    *,
    function_call: dict[str, Any],
    output: str,
) -> None:
    """Append a function_call and its function_call_output to stateless input."""
    input_items.append(normalize_function_call_item(function_call))
    input_items.append(
        function_call_output_item(
            str(function_call.get("call_id") or ""),
            output,
        )
    )


def tool_calls_to_ai_message(text: str, tool_calls: list[dict[str, Any]]) -> AIMessage:
    """Map Codex function_call items to a LangChain AIMessage."""
    lc_tool_calls: list[dict[str, Any]] = []
    for call in tool_calls:
        raw_args = call.get("arguments") or "{}"
        try:
            args = json.loads(raw_args) if isinstance(raw_args, str) else raw_args
        except Exception:
            args = {}
        lc_tool_calls.append({
            "name": call.get("name", ""),
            "args": args if isinstance(args, dict) else {},
            "id": call.get("call_id", ""),
            "type": "tool_call",
        })
    return AIMessage(content=text, tool_calls=lc_tool_calls)