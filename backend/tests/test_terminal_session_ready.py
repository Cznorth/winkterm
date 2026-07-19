from __future__ import annotations

import asyncio
import threading

import pytest

from backend.terminal.session_manager import SessionManager, TerminalSession


def _isolated_session_manager() -> SessionManager:
    manager = object.__new__(SessionManager)
    manager._sessions = {}
    manager._sessions_lock = threading.Lock()
    manager._active_session_id = None
    manager._janitor_task = None
    manager._subscribers = []
    manager._shutting_down = False
    return manager


@pytest.mark.asyncio
async def test_agent_terminal_create_waits_for_shell_prompt(monkeypatch) -> None:
    manager = _isolated_session_manager()
    calls: list[tuple] = []

    async def fake_start(self, ssh_config=None) -> None:
        calls.append(("start", ssh_config))

    async def fake_wait_until_idle(
        self,
        idle: float,
        max_wait: float,
        require_prompt: bool,
    ) -> None:
        calls.append(("ready", idle, max_wait, require_prompt))

    monkeypatch.setattr(TerminalSession, "start", fake_start)
    monkeypatch.setattr(TerminalSession, "wait_until_idle", fake_wait_until_idle)
    monkeypatch.setattr(manager, "_ensure_janitor", lambda: None)
    monkeypatch.setattr(manager, "_broadcast", lambda event: None)

    session = await manager.create(ready_timeout=7.5)

    assert calls == [
        ("start", None),
        ("ready", 0.5, 7.5, True),
    ]
    assert manager.get_session(session.id) is session


@pytest.mark.asyncio
async def test_agent_terminal_create_can_skip_ready_wait(monkeypatch) -> None:
    manager = _isolated_session_manager()
    ready_called = asyncio.Event()

    async def fake_start(self, ssh_config=None) -> None:
        return None

    async def fake_wait_until_idle(self, **kwargs) -> None:
        ready_called.set()

    monkeypatch.setattr(TerminalSession, "start", fake_start)
    monkeypatch.setattr(TerminalSession, "wait_until_idle", fake_wait_until_idle)
    monkeypatch.setattr(manager, "_ensure_janitor", lambda: None)
    monkeypatch.setattr(manager, "_broadcast", lambda event: None)

    await manager.create(ready_timeout=0)

    assert not ready_called.is_set()
