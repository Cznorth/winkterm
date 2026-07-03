"""Unit tests for Codex Responses protocol conversion."""

from __future__ import annotations

import json

from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

from backend.agent.codex_protocol import (
    CodexStreamParser,
    append_tool_round_trip,
    codex_input_from_messages,
    tool_calls_to_ai_message,
)


def test_multi_turn_conversation_uses_output_text_for_assistant() -> None:
    items = codex_input_from_messages([
        HumanMessage(content="hi"),
        AIMessage(content="hello"),
        HumanMessage(content="how are you"),
    ])

    assert len(items) == 3
    assert items[0]["role"] == "user"
    assert items[1]["role"] == "assistant"
    assert items[1]["content"][0]["type"] == "output_text"
    assert items[1]["content"][0]["text"] == "hello"
    assert "input_text" not in json.dumps(items[1])
    assert items[2]["role"] == "user"


def test_tool_calls_map_to_function_call_and_output() -> None:
    items = codex_input_from_messages([
        HumanMessage(content="list files"),
        AIMessage(
            content="",
            tool_calls=[{
                "name": "ls",
                "args": {"path": "/tmp"},
                "id": "call_1",
                "type": "tool_call",
            }],
        ),
        ToolMessage(content="a.txt", tool_call_id="call_1"),
    ])

    assert items[0]["role"] == "user"
    assert items[1] == {
        "type": "function_call",
        "name": "ls",
        "arguments": '{"path": "/tmp"}',
        "call_id": "call_1",
    }
    assert items[2] == {
        "type": "function_call_output",
        "output": "a.txt",
        "call_id": "call_1",
    }


def test_stream_parser_handles_tool_argument_deltas() -> None:
    parser = CodexStreamParser()
    parser.feed({
        "type": "response.output_item.added",
        "item": {
            "type": "function_call",
            "call_id": "call_2",
            "name": "Read",
            "arguments": "",
        },
    })
    parser.feed({
        "type": "response.function_call_arguments.delta",
        "call_id": "call_2",
        "delta": '{"file',
    })
    parser.feed({
        "type": "response.function_call_arguments.delta",
        "call_id": "call_2",
        "delta": '_path":"/etc/hosts"}',
    })
    parser.feed({
        "type": "response.output_item.done",
        "item": {
            "type": "function_call",
            "call_id": "call_2",
            "name": "Read",
            "arguments": '{"file_path":"/etc/hosts"}',
        },
    })

    result = parser.result()
    assert result.text == ""
    assert len(result.tool_calls) == 1
    assert result.tool_calls[0]["name"] == "Read"
    assert json.loads(result.tool_calls[0]["arguments"]) == {
        "file_path": "/etc/hosts",
    }


def test_append_tool_round_trip_extends_stateless_input() -> None:
    input_items = codex_input_from_messages([HumanMessage(content="run ls")])
    append_tool_round_trip(
        input_items,
        function_call={
            "type": "function_call",
            "call_id": "call_3",
            "name": "ls",
            "arguments": "{}",
        },
        output="done",
    )

    assert input_items[-2]["type"] == "function_call"
    assert input_items[-1] == {
        "type": "function_call_output",
        "call_id": "call_3",
        "output": "done",
    }


def test_tool_calls_to_ai_message() -> None:
    message = tool_calls_to_ai_message("", [{
        "type": "function_call",
        "call_id": "call_4",
        "name": "pwd",
        "arguments": "{}",
    }])
    assert message.tool_calls[0]["name"] == "pwd"
    assert message.tool_calls[0]["id"] == "call_4"