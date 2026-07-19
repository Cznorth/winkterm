from __future__ import annotations

import asyncio
import threading

import pytest

from backend.terminal.session_manager import SessionManager
from backend.terminal.ws_handler import TerminalWSHandler


class _FakeWebSocket:
    client = ("test", 1234)


class _RacePty:
    def __init__(self) -> None:
        self.spawn_calls = 0
        self.terminate_calls = 0
        self.callbacks = []

    def spawn(self, **kwargs) -> None:
        self.spawn_calls += 1

    def terminate(self) -> None:
        self.terminate_calls += 1

    def is_alive(self) -> bool:
        return False

    def add_output_callback(self, callback) -> None:
        if callback not in self.callbacks:
            self.callbacks.append(callback)

    def remove_output_callback(self, callback) -> None:
        self.callbacks = [current for current in self.callbacks if current != callback]


def _manager() -> SessionManager:
    manager = object.__new__(SessionManager)
    manager._sessions = {}
    manager._sessions_lock = threading.Lock()
    manager._active_session_id = None
    manager._janitor_task = None
    manager._subscribers = []
    manager._shutting_down = False
    return manager


def _delayed_handler(manager: SessionManager, session_id: str, pty: _RacePty):
    session = manager.create_session(session_id)
    session.pty = pty  # type: ignore[assignment]
    handler = TerminalWSHandler(_FakeWebSocket(), session_id=session_id)  # type: ignore[arg-type]
    handler.session_manager = manager
    handler.session = session
    handler.pty = pty  # type: ignore[assignment]
    handler._pending_spawn = True
    handler._pending_ssh_config = None
    handler._spawn_dims = (120, 40)
    return handler, session


@pytest.mark.asyncio
async def test_reload_shutdown_closes_pty_and_cancels_delayed_spawn() -> None:
    manager = _manager()
    pty = _RacePty()
    handler, old_session = _delayed_handler(manager, "reload-terminal", pty)

    delayed_spawn = asyncio.create_task(handler._spawn_after_settle(0.05))
    await asyncio.sleep(0.01)
    await manager.shutdown()
    await delayed_spawn

    assert pty.terminate_calls == 1
    assert pty.spawn_calls == 0
    assert manager.session_count() == 0

    manager.begin_startup()
    reconnected = manager.create_session("reload-terminal")
    assert reconnected is not old_session
    await manager.shutdown()


@pytest.mark.asyncio
async def test_deleted_session_cannot_spawn_after_debounce() -> None:
    manager = _manager()
    pty = _RacePty()
    handler, _ = _delayed_handler(manager, "deleted-terminal", pty)

    delayed_spawn = asyncio.create_task(handler._spawn_after_settle(0.05))
    await asyncio.sleep(0.01)
    assert manager.close_session("deleted-terminal") is True
    await delayed_spawn

    assert pty.terminate_calls == 1
    assert pty.spawn_calls == 0
    await manager.shutdown()


@pytest.mark.asyncio
async def test_shutdown_rejects_new_terminal_sessions() -> None:
    manager = _manager()
    await manager.shutdown()

    with pytest.raises(RuntimeError, match="shutting down"):
        manager.create_session("too-late")
