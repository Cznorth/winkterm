"""多终端会话管理器"""

from __future__ import annotations

import asyncio
import logging
import threading
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime
from typing import Callable

from backend.terminal.pty_manager import PtyManager

logger = logging.getLogger("session_manager")


@dataclass
class TerminalSession:
    """终端会话"""

    id: str
    pty: PtyManager = field(default_factory=PtyManager)
    created_at: datetime = field(default_factory=datetime.now)
    last_active: datetime = field(default_factory=datetime.now)
    # WebSocket 相关
    ws_queue: asyncio.Queue[str | None] = field(default_factory=asyncio.Queue)
    ws_callbacks: list[Callable[[str], None]] = field(default_factory=list)
    # 状态
    is_connected: bool = False


class SessionManager:
    """终端会话管理器（单例）"""

    _instance: SessionManager | None = None
    _lock = threading.Lock()

    def __new__(cls) -> SessionManager:
        if cls._instance is None:
            with cls._lock:
                if cls._instance is None:
                    cls._instance = super().__new__(cls)
                    cls._instance._sessions: dict[str, TerminalSession] = {}
                    cls._instance._sessions_lock = threading.Lock()
                    cls._instance._active_session_id: str | None = None
        return cls._instance

    def create_session(self, session_id: str) -> TerminalSession:
        """创建新会话"""
        with self._sessions_lock:
            if session_id in self._sessions:
                logger.warning(f"[create_session] 会话 {session_id} 已存在，返回现有会话")
                return self._sessions[session_id]

            session = TerminalSession(id=session_id)
            self._sessions[session_id] = session
            self._active_session_id = session_id  # 新建会话自动激活
            logger.info(f"[create_session] 创建会话: {session_id}")
            return session

    def get_session(self, session_id: str) -> TerminalSession | None:
        """获取会话"""
        with self._sessions_lock:
            return self._sessions.get(session_id)

    def get_active_session(self) -> TerminalSession | None:
        """获取当前激活的会话"""
        with self._sessions_lock:
            if self._active_session_id:
                return self._sessions.get(self._active_session_id)
            # 如果没有激活会话，返回第一个存在的会话
            if self._sessions:
                return next(iter(self._sessions.values()))
            return None

    def set_active_session(self, session_id: str) -> bool:
        """设置激活会话"""
        with self._sessions_lock:
            if session_id in self._sessions:
                self._active_session_id = session_id
                logger.info(f"[set_active_session] 激活会话: {session_id}")
                return True
            return False

    def close_session(self, session_id: str) -> bool:
        """关闭会话"""
        with self._sessions_lock:
            session = self._sessions.pop(session_id, None)
            if session:
                # 终止 PTY 进程
                session.pty.terminate()
                # 如果关闭的是激活会话，切换到其他会话
                if self._active_session_id == session_id:
                    self._active_session_id = next(iter(self._sessions.keys()), None)
                logger.info(f"[close_session] 关闭会话: {session_id}")
                return True
            return False

    def list_sessions(self) -> list[str]:
        """列出所有会话 ID"""
        with self._sessions_lock:
            return list(self._sessions.keys())

    def session_count(self) -> int:
        """获取会话数量"""
        with self._sessions_lock:
            return len(self._sessions)


def get_session_manager() -> SessionManager:
    """获取 SessionManager 单例"""
    return SessionManager()
