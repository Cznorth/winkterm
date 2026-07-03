#!/usr/bin/env python3
"""Smoke tests for Codex /ws/chat: multi-turn chat and live tool calls."""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
import uuid

import websockets


async def _chat_round(
    ws,
    conv_id: str,
    content: str,
    *,
    expect_tools: bool = False,
) -> dict[str, list]:
    await ws.send(json.dumps({
        "type": "chat",
        "conv_id": conv_id,
        "content": content,
    }))

    saw_start = False
    saw_end = False
    tool_start: list[dict] = []
    tool_end: list[dict] = []

    while True:
        raw = await asyncio.wait_for(ws.recv(), timeout=240)
        msg = json.loads(raw)
        msg_type = msg.get("type")

        if msg_type == "start":
            saw_start = True
        elif msg_type == "tool_start":
            tool_start.append(msg)
        elif msg_type == "tool_end":
            tool_end.append(msg)
        elif msg_type == "error":
            error_message = str(msg.get("message") or "")
            if "invalid_enum_value" in error_message:
                raise RuntimeError(f"Codex protocol error: {error_message}")
            raise RuntimeError(error_message or "unknown websocket error")
        elif msg_type in ("end", "stopped"):
            saw_end = True
            break

    if not saw_start or not saw_end:
        raise RuntimeError(f"incomplete chat round: start={saw_start}, end={saw_end}")

    tools = [event.get("tool") for event in tool_start]
    if expect_tools:
        if not tool_start:
            raise RuntimeError("expected tool_start event, got none")
        if not tool_end:
            raise RuntimeError("expected tool_end event, got none")
        if "list_terminals" not in tools:
            raise RuntimeError(f"expected list_terminals tool call, got: {tools}")

    return {
        "tool_start": tool_start,
        "tool_end": tool_end,
        "tools": tools,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--ws-url",
        default="ws://127.0.0.1:8000/ws/chat",
        help="Chat websocket endpoint",
    )
    parser.add_argument("--conv-id", default=f"codex-smoke-{uuid.uuid4().hex[:8]}")
    parser.add_argument(
        "--with-tools",
        action="store_true",
        help="Also run a live list_terminals tool-call round and a follow-up turn",
    )
    parser.add_argument(
        "--tools-only",
        action="store_true",
        help="Run only the tool-call smoke (skip plain two-turn chat)",
    )
    args = parser.parse_args()

    async def _run() -> None:
        async with websockets.connect(args.ws_url) as ws:
            if not args.tools_only:
                await _chat_round(ws, args.conv_id, "Say hi in one short sentence.")
                await _chat_round(ws, args.conv_id, "Now say bye in one short sentence.")
                if not args.with_tools:
                    print("OK: two-round Codex conversation smoke passed")
                    return

            tool_events = await _chat_round(
                ws,
                args.conv_id,
                (
                    "You must call the list_terminals tool exactly once, "
                    "then reply with a single sentence that includes the number "
                    "of terminals returned. Do not guess."
                ),
                expect_tools=True,
            )
            print(
                "OK: tool round "
                f"tool_start={len(tool_events['tool_start'])}, "
                f"tool_end={len(tool_events['tool_end'])}, "
                f"tools={tool_events['tools']}"
            )

            await _chat_round(
                ws,
                args.conv_id,
                "Thanks. In one short sentence, confirm you already called list_terminals.",
            )
            print("OK: Codex conversation + tool-call smoke passed")

    try:
        asyncio.run(_run())
    except Exception as exc:
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())