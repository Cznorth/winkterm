from __future__ import annotations

import asyncio

import pytest

from backend.terminal.pty_manager import PtyManager
from backend.terminal.ws_handler import TerminalWSHandler


class _OutputSink:
    def __init__(self) -> None:
        self.received: list[bytes] = []

    def on_output(self, data: bytes) -> None:
        self.received.append(data)


class _FakeWebSocket:
    client = ("test", 1234)

    def __init__(self) -> None:
        self.sent: list[str] = []

    async def send_text(self, text: str) -> None:
        self.sent.append(text)


def test_bound_output_callback_is_deduplicated_and_removed() -> None:
    pty = PtyManager()
    sink = _OutputSink()

    pty.add_output_callback(sink.on_output)
    pty.add_output_callback(sink.on_output)

    assert len(pty._read_callbacks) == 1
    pty.remove_output_callback(sink.on_output)
    assert pty._read_callbacks == []


def test_reconnect_only_delivers_output_to_current_callback() -> None:
    pty = PtyManager()
    disconnected = _OutputSink()
    current = _OutputSink()

    pty.add_output_callback(disconnected.on_output)
    pty.remove_output_callback(disconnected.on_output)
    pty.add_output_callback(current.on_output)
    pty._notify_callbacks(b"AI reply")

    assert disconnected.received == []
    assert current.received == [b"AI reply"]


@pytest.mark.asyncio
async def test_closed_websocket_handler_ignores_late_pty_output() -> None:
    websocket = _FakeWebSocket()
    handler = TerminalWSHandler(websocket)  # type: ignore[arg-type]
    handler._closed = True

    handler._on_pty_output(b"late output")
    await asyncio.sleep(0)

    assert websocket.sent == []
    assert handler._send_tasks == set()
