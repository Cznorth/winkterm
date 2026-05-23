"""Agent 操作事件日志。

环形缓冲 + asyncio 广播，供前端实时订阅。无持久化。
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
    """内存里的事件环形缓冲，支持多订阅者实时拉取。"""

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
        """记录一条事件并广播给订阅者。"""
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
        """返回最近 limit 条事件。``since_id`` 给定则只返回 id > since_id 的。"""
        with self._lock:
            events = list(self._events)
        if since_id is not None:
            events = [e for e in events if e["id"] > since_id]
        return events[-limit:]

    async def stream(self, since_id: int = 0) -> AsyncIterator[dict]:
        """异步生成器：每当有新事件 yield 一条。

        首先一次性返回缓冲里 id > since_id 的历史事件，然后实时推送新事件。
        """
        wake = asyncio.Event()
        with self._lock:
            self._subscribers.add(wake)

        try:
            # 先回放历史
            for ev in self.recent(since_id=since_id, limit=_MAX_EVENTS):
                yield ev
                since_id = ev["id"]

            # 实时推送
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
    """截断字符串供事件日志显示。"""
    if not s:
        return ""
    s = s.replace("\n", "\\n").replace("\r", "")
    return s if len(s) <= n else s[: n - 1] + "…"


def make_request_id() -> str:
    return uuid.uuid4().hex[:8]
