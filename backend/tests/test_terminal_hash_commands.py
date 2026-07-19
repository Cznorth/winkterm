from __future__ import annotations

from unittest.mock import AsyncMock

import pytest
from langchain_core.messages import AIMessage

from backend.terminal import ws_handler
from backend.terminal.ws_handler import TerminalWSHandler


class _FakeWebSocket:
    client = ("test", 1234)


class _FakePty:
    def __init__(self, screen: str = "") -> None:
        self.screen = screen

    def get_screen_content(self) -> str:
        return self.screen


class _AgentPty(_FakePty):
    def __init__(self) -> None:
        super().__init__()
        self.writes: list[bytes] = []

    def get_context(self, lines: int = 50) -> str:
        return "PS D:\\repo>"

    def write(self, data: bytes) -> None:
        self.writes.append(data)


class _FinalMessageGraph:
    async def astream_events(self, state, config, version):
        yield {"event": "on_chain_start", "name": "LangGraph"}
        yield {
            "event": "on_chain_end",
            "name": "LangGraph",
            "data": {
                "output": {
                    "messages": [AIMessage(content="fallback reply")],
                    "waiting_user": False,
                }
            },
        }


def _handler(screen: str = "") -> TerminalWSHandler:
    handler = TerminalWSHandler(_FakeWebSocket())  # type: ignore[arg-type]
    handler.pty = _FakePty(screen)  # type: ignore[assignment]
    handler.agent_invoke = AsyncMock()  # type: ignore[method-assign]
    return handler


@pytest.mark.asyncio
async def test_hash_command_prefers_raw_keyboard_input() -> None:
    handler = _handler(screen="serialized content without the command")

    for char in "# hello":
        await handler.hookinput(char)
    await handler.hookinput("\r")

    handler.agent_invoke.assert_awaited_once_with("hello")  # type: ignore[attr-defined]


@pytest.mark.asyncio
async def test_hash_command_input_handles_backspace() -> None:
    handler = _handler()

    for char in "# hellp":
        await handler.hookinput(char)
    await handler.hookinput("\x7f")
    await handler.hookinput("o")
    await handler.hookinput("\r")

    handler.agent_invoke.assert_awaited_once_with("hello")  # type: ignore[attr-defined]


@pytest.mark.asyncio
async def test_plain_command_does_not_invoke_agent() -> None:
    handler = _handler(screen="PS D:\\repo> echo hello")

    for char in "echo hello":
        await handler.hookinput(char)
    await handler.hookinput("\r")

    handler.agent_invoke.assert_not_awaited()  # type: ignore[attr-defined]


@pytest.mark.asyncio
async def test_plain_command_does_not_reuse_prior_ai_output() -> None:
    handler = _handler(
        screen=(
            "PS D:\\repo> # hello\n"
            "PS D:\\repo> # winkterm: hello, how can I help?\n"
            "PS D:\\repo> ifconfig"
        )
    )

    await handler.hookinput("ifconfig")
    await handler.hookinput("\r")

    handler.agent_invoke.assert_not_awaited()  # type: ignore[attr-defined]


@pytest.mark.asyncio
async def test_agent_output_is_never_parsed_as_a_hash_command() -> None:
    handler = _handler(screen="PS D:\\repo> # winkterm: previous reply")

    await handler.hookinput("\r")

    handler.agent_invoke.assert_not_awaited()  # type: ignore[attr-defined]


@pytest.mark.asyncio
async def test_local_screen_fallback_does_not_scan_stale_history() -> None:
    handler = _handler(screen="PS D:\\repo> # stale\nPS D:\\repo>")

    await handler.hookinput("\r")

    handler.agent_invoke.assert_not_awaited()  # type: ignore[attr-defined]


@pytest.mark.asyncio
async def test_screen_snapshot_remains_a_fallback() -> None:
    handler = _handler(screen="PS D:\\repo> # fallback")

    await handler.hookinput("\r")

    handler.agent_invoke.assert_awaited_once_with("fallback")  # type: ignore[attr-defined]


@pytest.mark.asyncio
async def test_final_ai_message_is_written_when_provider_has_no_stream_events(monkeypatch) -> None:
    handler = TerminalWSHandler(_FakeWebSocket())  # type: ignore[arg-type]
    pty = _AgentPty()
    handler.pty = pty  # type: ignore[assignment]
    monkeypatch.setattr(ws_handler, "get_graph", lambda: _FinalMessageGraph())

    await handler.agent_invoke("hello")

    assert pty.writes == [b"# winkterm: ", b"fallback reply", b"\x03"]
