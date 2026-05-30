"""Agent operation event log.

Ring buffer plus asyncio broadcast for frontend real-time subscription. Not persisted.
"""

from __future__ import annotations

import asyncio
import threading
import time
import uuid
from collections import deque
from typing import AsyncIterator, Optional

_MAX_EVENTS = 500


class AgentEventLog:
    """In-memory ring buffer of events with multi-subscriber real-time delivery."""

    _instance: Optional[AgentEventLog] = None
    _singleton_lock = threading.Lock()

    def __new__(cls) -> AgentEventLog:
        if cls._instance is None:
            with cls._singleton_lock:
                if cls._instance is None:
                    cls._instance = super().__new__(cls)
                    cls._instance._events: deque[dict] = deque(maxlen=_MAX_EVENTS)
                    cls._instance._seq = 0
                    cls._instance._lock = threading.Lock()
                    cls._instance._subscribers: set[asyncio.Event] = set()
        return cls._instance

    def emit(self, action: str, **fields) -> dict:
        """Record one event and broadcast it to subscribers."""
        with self._lock:
            self._seq += 1
            event = {
                "id": self._seq,
                "ts": time.time(),
                "action": action,
                **fields,
            }
            self._events.append(event)
            subscribers = list(self._subscribers)

        for ev in subscribers:
            try:
                loop = ev._loop  # type: ignore[attr-defined]
                loop.call_soon_threadsafe(ev.set)
            except Exception:
                pass
        return event

    def recent(self, since_id: Optional[int] = None, limit: int = 100) -> list[dict]:
        """Return the most recent ``limit`` events. When ``since_id`` is set, only id > since_id."""
        with self._lock:
            events = list(self._events)
        if since_id is not None:
            events = [e for e in events if e["id"] > since_id]
        return events[-limit:]

    async def stream(self, since_id: int = 0) -> AsyncIterator[dict]:
        """Async generator: yield one event whenever a new one arrives.

        First replays buffered events with id > since_id, then pushes new events in real time.
        """
        wake = asyncio.Event()
        with self._lock:
            self._subscribers.add(wake)

        try:
            # Replay history first
            for ev in self.recent(since_id=since_id, limit=_MAX_EVENTS):
                yield ev
                since_id = ev["id"]

            # Real-time push
            while True:
                try:
                    await asyncio.wait_for(wake.wait(), timeout=15.0)
                    wake.clear()
                    fresh = self.recent(since_id=since_id, limit=_MAX_EVENTS)
                    for ev in fresh:
                        yield ev
                        since_id = ev["id"]
                except asyncio.TimeoutError:
                    yield {"id": since_id, "action": "heartbeat", "ts": time.time()}
        finally:
            with self._lock:
                self._subscribers.discard(wake)


def get_event_log() -> AgentEventLog:
    return AgentEventLog()


def short_text(s: str, n: int = 120) -> str:
    """Truncate a string for display in the event log."""
    if not s:
        return ""
    s = s.replace("\n", "\\n").replace("\r", "")
    return s if len(s) <= n else s[: n - 1] + "…"


def make_request_id() -> str:
    return uuid.uuid4().hex[:8]
