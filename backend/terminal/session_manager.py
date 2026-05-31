"""Unified terminal session manager.

Merges the former SessionManager (WebSocket user terminals) and AgentTerminalPool
(external agent HTTP terminals): all terminals are TerminalSession instances; internal
agents, external agents, and users share the same session pool.
"""

from __future__ import annotations

import asyncio
import logging
import re
import shlex
import threading
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime
from typing import AsyncIterator, Optional

from backend.terminal._term_utils import (
    decode_b64,
    decode_terminal_text,
    grep_lines,
    resolve_keys,
    strip_ansi,
    strip_command_echo,
)
from backend.terminal.pty_manager import PtyManager

logger = logging.getLogger("session_manager")

_MAX_RAW = 256 * 1024
DEFAULT_TTL_SECONDS = 1800.0
_JANITOR_INTERVAL = 60.0


@dataclass
class TerminalSession:
    """Single terminal session: wraps PtyManager, output accumulation, and metadata."""

    id: str
    type: str = "local"  # "local" | "ssh"
    connection_id: Optional[str] = None
    title: str = ""
    name: str = ""
    host: Optional[str] = None
    port: Optional[int] = None
    username: Optional[str] = None
    cols: int = 80
    rows: int = 24
    cwd: Optional[str] = None
    created_by: str = "user"  # "user" | "agent:<client>"
    user_visible: bool = True
    transient: bool = False  # Hidden temporary session; not shown in the user tab bar
    ttl_seconds: float = 0.0  # 0/negative = no expiry (default for user sessions); agent sessions use DEFAULT_TTL_SECONDS
    created_at: datetime = field(default_factory=datetime.now)

    pty: PtyManager = field(default_factory=PtyManager)
    _raw: bytearray = field(default_factory=bytearray)
    _total: int = 0
    _lock: threading.Lock = field(default_factory=threading.Lock)
    _read_task: Optional[asyncio.Task] = None
    _wake_event: Optional[asyncio.Event] = None
    _capture_attached: bool = False

    last_activity_mono: float = field(default_factory=time.monotonic)
    last_user_input_at: Optional[datetime] = None
    last_command: str = ""

    # ------------------------------------------------------------------
    # Internal
    # ------------------------------------------------------------------

    def _on_output(self, data: bytes) -> None:
        with self._lock:
            self._raw.extend(data)
            self._total += len(data)
            if len(self._raw) > _MAX_RAW:
                del self._raw[: len(self._raw) - _MAX_RAW]
        ev = self._wake_event
        if ev is not None:
            try:
                loop = ev._loop  # type: ignore[attr-defined]
                loop.call_soon_threadsafe(ev.set)
            except Exception:
                pass

    def touch(self) -> None:
        self.last_activity_mono = time.monotonic()

    def mark_user_input(self, command: str = "") -> None:
        self.last_user_input_at = datetime.now()
        self.touch()
        if command:
            self.last_command = command

    def idle_seconds(self) -> float:
        return time.monotonic() - self.last_activity_mono

    def is_alive(self) -> bool:
        return self.pty.is_alive()

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def attach_output_capture(self) -> None:
        """Register an output callback to accumulate the buffer. Idempotent on repeat calls."""
        if self._capture_attached:
            return
        self.pty.add_output_callback(self._on_output)
        self._capture_attached = True
        if self._wake_event is None:
            try:
                self._wake_event = asyncio.Event()
            except RuntimeError:
                # No running event loop; defer
                pass

    # Typical shell prompt tail (end of line): $ / # / > / % followed by optional space
    _PROMPT_TAIL_RE = re.compile(rb"[\$#>%]\s?$")

    def _looks_like_prompt(self, tail_bytes: int = 16) -> bool:
        with self._lock:
            tail = bytes(self._raw[-tail_bytes:]) if self._raw else b""
        # Strip ANSI from the tail and check whether the cursor sits on a prompt character
        try:
            text = strip_ansi(decode_terminal_text(tail)).rstrip("\n\r ")
        except Exception:
            return False
        return bool(text) and text[-1] in "$#>%"

    async def wait_until_idle(
        self,
        idle: float = 3.0,
        max_wait: float = 15.0,
        require_prompt: bool = True,
    ) -> None:
        """Wait until PTY output settles.

        Prefer shell prompt (trailing $/#/>/%) plus idle: return only when both are satisfied.
        Idle alone can be fooled by pauses mid-login banner, causing commands to land in the login flow.
        """
        loop = asyncio.get_event_loop()
        deadline = loop.time() + max_wait
        last_size = self._total
        last_change = loop.time()
        while True:
            await asyncio.sleep(0.2)
            now = loop.time()
            cur = self._total
            if cur != last_size:
                last_size = cur
                last_change = now
            quiet = now - last_change >= idle
            if quiet:
                if not require_prompt or self._looks_like_prompt():
                    return
            if now >= deadline:
                return

    def ensure_read_loop(self) -> None:
        """Ensure the session-owned read loop task is running. Idempotent.

        WS disconnect/reconnect does not affect this task. It stops only when the pty dies or session.close runs.
        """
        if self._read_task is not None and not self._read_task.done():
            return
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        if self._wake_event is None:
            self._wake_event = asyncio.Event()
        self._read_task = loop.create_task(self.pty.start_read_loop())

    async def start(self, ssh_config: Optional[dict] = None) -> None:
        """Start the pty, output capture, and read loop (for async contexts)."""
        self.pty.spawn(cols=self.cols, rows=self.rows, ssh_config=ssh_config)
        self.attach_output_capture()
        if self._wake_event is None:
            self._wake_event = asyncio.Event()
        if self._read_task is None or self._read_task.done():
            self._read_task = asyncio.create_task(self.pty.start_read_loop())
        self.touch()

    def close(self) -> None:
        self.pty.terminate()
        if self._read_task and not self._read_task.done():
            self._read_task.cancel()
        if self._wake_event is not None:
            try:
                self._wake_event._loop.call_soon_threadsafe(self._wake_event.set)  # type: ignore[attr-defined]
            except Exception:
                pass

    # ------------------------------------------------------------------
    # Metadata
    # ------------------------------------------------------------------

    def info(self, is_user_active: bool = False) -> dict:
        return {
            "id": self.id,
            "type": self.type,
            "connection_id": self.connection_id,
            "title": self.title,
            "name": self.name,
            "host": self.host,
            "port": self.port,
            "username": self.username,
            "cwd": self.cwd,
            "cols": self.cols,
            "rows": self.rows,
            "alive": self.is_alive(),
            "created_at": self.created_at.isoformat(),
            "created_by": self.created_by,
            "user_visible": self.user_visible,
            "transient": self.transient,
            "is_user_active": is_user_active,
            "size": self._total,
            "idle_seconds": round(self.idle_seconds(), 1),
            "ttl_seconds": self.ttl_seconds,
            "last_user_input_at": (
                self.last_user_input_at.isoformat() if self.last_user_input_at else None
            ),
            "last_command": self.last_command,
        }

    # ------------------------------------------------------------------
    # Snapshot
    # ------------------------------------------------------------------

    def snapshot(
        self,
        since: Optional[int] = None,
        strip: bool = True,
        pattern: Optional[str] = None,
        context: int = 0,
        case_insensitive: bool = False,
    ) -> dict:
        self.touch()
        with self._lock:
            total = self._total
            buf_start = total - len(self._raw)
            if since is None:
                chunk = bytes(self._raw)
            else:
                idx = max(0, since - buf_start)
                chunk = bytes(self._raw[idx:])
        text = decode_terminal_text(chunk)
        if strip:
            text = strip_ansi(text)

        result = {
            "output": text,
            "size": total,
            "truncated": since is not None and since < buf_start,
            "alive": self.is_alive(),
        }
        if pattern:
            result["grep"] = grep_lines(
                text, pattern, context=context, case_insensitive=case_insensitive
            )
        return result

    # ------------------------------------------------------------------
    # Input
    # ------------------------------------------------------------------

    @staticmethod
    def _compose_payload(
        data: str = "",
        data_b64: Optional[str] = None,
        keys: Optional[list[str]] = None,
    ) -> str:
        chunks: list[str] = []
        if keys:
            chunks.append(resolve_keys(keys))
        if data:
            chunks.append(data)
        if data_b64:
            chunks.append(decode_b64(data_b64))
        return "".join(chunks)

    async def send(
        self,
        data: str = "",
        data_b64: Optional[str] = None,
        keys: Optional[list[str]] = None,
        enter: bool = True,
        wait: bool = False,
        timeout: float = 10.0,
        idle: float = 0.6,
        strip_echo: bool = False,
    ) -> dict:
        self.touch()
        payload = self._compose_payload(data, data_b64, keys)

        with self._lock:
            start_offset = self._total

        wire = payload + ("\r" if enter else "")
        if wire:
            self.pty.write(wire.encode("utf-8"))

        if not wait:
            return {"ok": True, "since": start_offset}

        loop = asyncio.get_event_loop()
        deadline = loop.time() + timeout
        last_total = start_offset
        last_change = loop.time()
        reason = "no_output"

        while True:
            await asyncio.sleep(0.15)
            now = loop.time()
            with self._lock:
                cur = self._total
            if cur != last_total:
                last_total = cur
                last_change = now
            if cur != start_offset and now - last_change >= idle:
                reason = "idle"
                break
            if now >= deadline:
                reason = "timeout" if cur != start_offset else "no_output"
                break

        snap = self.snapshot(since=start_offset)
        output = snap["output"]
        if strip_echo and payload:
            output = strip_command_echo(output, payload)
        self.touch()
        return {
            "ok": True,
            "since": start_offset,
            "output": output,
            "size": snap["size"],
            "alive": snap["alive"],
            "reason": reason,
        }

    # ------------------------------------------------------------------
    # Atomic exec
    # ------------------------------------------------------------------

    async def exec(
        self,
        command: str = "",
        command_b64: Optional[str] = None,
        timeout: float = 30.0,
        idle: float = 0.3,
        cwd: Optional[str] = None,
        env: Optional[dict[str, str]] = None,
    ) -> dict:
        self.touch()
        if command_b64:
            command = (command or "") + decode_b64(command_b64)
        command = command.rstrip("\n")
        if not command:
            return {"ok": False, "reason": "empty_command"}

        export_clause = ""
        if env:
            exports: list[str] = []
            for k, v in env.items():
                if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", k):
                    raise ValueError(f"非法环境变量名: {k!r}")
                exports.append(f"export {k}={shlex.quote(v)}")
            export_clause = "; ".join(exports) + "; "

        if cwd or env:
            user_cmd = command.replace("\n", "; ")
            cd_clause = f"cd {shlex.quote(cwd)}; " if cwd else ""
            core = f"( {cd_clause}{export_clause}{user_cmd} )"
        else:
            core = command

        sentinel = f"__WT_EXEC_{uuid.uuid4().hex[:12]}__"
        wrapped = (
            f"{core}; "
            f"printf '\\n{sentinel}%d:%s\\n' \"$?\" \"$PWD\"\r"
        )

        with self._lock:
            start_offset = self._total

        self.pty.write(wrapped.encode("utf-8"))

        pattern = re.compile(
            rf"{re.escape(sentinel)}(\d+):([^\r\n]*)\r?\n"
        )

        loop = asyncio.get_event_loop()
        deadline = loop.time() + timeout

        while True:
            await asyncio.sleep(0.1)
            now = loop.time()

            with self._lock:
                total = self._total
                buf_start = total - len(self._raw)
                chunk_offset = max(0, start_offset - buf_start)
                chunk = bytes(self._raw[chunk_offset:])

            text = strip_ansi(decode_terminal_text(chunk))
            match = pattern.search(text)
            if match:
                exit_code = int(match.group(1))
                self.cwd = match.group(2) or self.cwd
                stdout = text[: match.start()]
                stdout = strip_command_echo(stdout, command)
                stdout = stdout.rstrip("\n")
                self.touch()
                return {
                    "ok": True,
                    "exit_code": exit_code,
                    "stdout": stdout,
                    "cwd": self.cwd,
                    "size": total,
                    "alive": self.is_alive(),
                }

            if now >= deadline:
                stdout = strip_command_echo(text, command).rstrip("\n")
                return {
                    "ok": False,
                    "reason": "timeout",
                    "stdout": stdout,
                    "cwd": self.cwd,
                    "size": total,
                    "alive": self.is_alive(),
                }

    # ------------------------------------------------------------------
    # SSE stream
    # ------------------------------------------------------------------

    async def stream(self, since: int = 0, strip: bool = True) -> AsyncIterator[dict]:
        self.touch()
        cur = since
        if self._wake_event is None:
            self._wake_event = asyncio.Event()

        while self.is_alive():
            with self._lock:
                total = self._total
            if total > cur:
                snap = self.snapshot(since=cur, strip=strip)
                cur = snap["size"]
                yield {"id": cur, "event": "output", "data": snap["output"]}
                self.touch()
            else:
                try:
                    await asyncio.wait_for(self._wake_event.wait(), timeout=15.0)
                    self._wake_event.clear()
                except asyncio.TimeoutError:
                    yield {"id": cur, "event": "heartbeat", "data": ""}

        with self._lock:
            total = self._total
        if total > cur:
            snap = self.snapshot(since=cur, strip=strip)
            yield {"id": snap["size"], "event": "output", "data": snap["output"]}
        yield {"id": total, "event": "end", "data": "terminal closed"}


class SessionManager:
    """Unified terminal session manager (singleton) with TTL janitor."""

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
                    cls._instance._janitor_task: Optional[asyncio.Task] = None
                    cls._instance._subscribers: list[asyncio.Queue] = []
        return cls._instance

    # ------------------------------------------------------------------
    # pubsub (session lifecycle event broadcast)
    # ------------------------------------------------------------------

    def subscribe(self) -> asyncio.Queue:
        """Subscribe to the session event stream. Returns a new Queue; caller must consume and unsubscribe."""
        q: asyncio.Queue = asyncio.Queue(maxsize=256)
        with self._sessions_lock:
            self._subscribers.append(q)
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        with self._sessions_lock:
            try:
                self._subscribers.remove(q)
            except ValueError:
                pass

    def _broadcast(self, event: dict) -> None:
        """Synchronously deliver an event to all subscribers (non-blocking even without a loop)."""
        with self._sessions_lock:
            subs = list(self._subscribers)
        for q in subs:
            try:
                q.put_nowait(event)
            except asyncio.QueueFull:
                logger.warning("[broadcast] 订阅者队列满,丢弃事件")

    # ------------------------------------------------------------------
    # User (WebSocket) entry
    # ------------------------------------------------------------------

    def create_session(self, session_id: str) -> TerminalSession:
        """Legacy API: WebSocket user terminal entry (bare session; caller spawns the pty)."""
        with self._sessions_lock:
            if session_id in self._sessions:
                logger.warning(f"[create_session] 会话 {session_id} 已存在,返回现有")
                return self._sessions[session_id]

            session = TerminalSession(
                id=session_id,
                created_by="user",
                user_visible=True,
                ttl_seconds=0,
            )
            # Critical: attach the output callback early for agent snapshot/exec/stream
            # so all output after pty.spawn goes into the buffer.
            session.attach_output_capture()
            self._sessions[session_id] = session
            self._active_session_id = session_id
            logger.info(f"[create_session] 用户会话: {session_id}")
        self._broadcast({
            "type": "session_created",
            "session": session.info(is_user_active=True),
        })
        return session

    def get_session(self, session_id: str) -> TerminalSession | None:
        with self._sessions_lock:
            return self._sessions.get(session_id)

    def get_active_session(self) -> TerminalSession | None:
        with self._sessions_lock:
            if self._active_session_id:
                s = self._sessions.get(self._active_session_id)
                if s:
                    return s
            if self._sessions:
                return next(iter(self._sessions.values()))
            return None

    def get_active_session_id(self) -> Optional[str]:
        with self._sessions_lock:
            return self._active_session_id

    def set_active_session(self, session_id: str) -> bool:
        with self._sessions_lock:
            if session_id in self._sessions:
                self._active_session_id = session_id
                logger.info(f"[set_active_session] 激活: {session_id}")
                return True
            return False

    def close_session(self, session_id: str) -> bool:
        with self._sessions_lock:
            session = self._sessions.pop(session_id, None)
            if session:
                if self._active_session_id == session_id:
                    self._active_session_id = next(iter(self._sessions.keys()), None)
        if session:
            session.close()
            logger.info(f"[close_session] 关闭: {session_id}")
            self._broadcast({
                "type": "session_closed",
                "session_id": session_id,
            })
            return True
        return False

    def list_session_ids(self) -> list[str]:
        with self._sessions_lock:
            return list(self._sessions.keys())

    def session_count(self) -> int:
        with self._sessions_lock:
            return len(self._sessions)

    # ------------------------------------------------------------------
    # Agent (HTTP / internal tool) entry
    # ------------------------------------------------------------------

    async def create(
        self,
        terminal_type: str = "local",
        connection_id: Optional[str] = None,
        cols: int = 120,
        rows: int = 40,
        name: str = "",
        ttl_seconds: float = DEFAULT_TTL_SECONDS,
        created_by: str = "agent",
        user_visible: bool = True,
        transient: bool = False,
    ) -> TerminalSession:
        """Agent creates a terminal: automatically spawns the pty and read loop."""
        ssh_config: Optional[dict] = None
        title = ""
        host = port = username = None

        if terminal_type == "ssh":
            if not connection_id:
                raise ValueError("ssh 类型必须提供 connection_id")
            from backend.ssh.connection_manager import SSHConnectionManager

            conn = SSHConnectionManager.get_connection(connection_id)
            if not conn:
                raise ValueError(f"SSH 连接不存在: {connection_id}")
            ssh_config = conn.to_dict()
            title = conn.title or f"{conn.username}@{conn.host}"
            host = ssh_config.get("host")
            port = ssh_config.get("port")
            username = ssh_config.get("username")
            SSHConnectionManager.update_last_connected(connection_id)

        session_id = uuid.uuid4().hex[:12]
        session = TerminalSession(
            id=session_id,
            type=terminal_type,
            connection_id=connection_id,
            title=title,
            name=name,
            host=host,
            port=port,
            username=username,
            cols=cols,
            rows=rows,
            created_by=created_by,
            user_visible=user_visible,
            transient=transient,
            ttl_seconds=ttl_seconds,
        )
        await session.start(ssh_config=ssh_config)

        with self._sessions_lock:
            self._sessions[session_id] = session
        self._ensure_janitor()
        logger.info(
            f"[create] {terminal_type} 会话: {session_id} "
            f"(name={name!r}, by={created_by}, visible={user_visible}, transient={transient}, ttl={ttl_seconds})"
        )
        self._broadcast({
            "type": "session_created",
            "session": session.info(is_user_active=False),
        })
        return session

    def list_terminals(self) -> list[dict]:
        """List rich info for all terminals, including the is_user_active flag."""
        with self._sessions_lock:
            active = self._active_session_id
            return [s.info(is_user_active=s.id == active) for s in self._sessions.values()]

    def close(self, session_id: str) -> bool:
        return self.close_session(session_id)

    # ------------------------------------------------------------------
    # TTL janitor
    # ------------------------------------------------------------------

    def _ensure_janitor(self) -> None:
        if self._janitor_task is None or self._janitor_task.done():
            try:
                loop = asyncio.get_running_loop()
            except RuntimeError:
                return
            self._janitor_task = loop.create_task(self._janitor_loop())

    async def _janitor_loop(self) -> None:
        while True:
            try:
                await asyncio.sleep(_JANITOR_INTERVAL)
                victims: list[str] = []
                with self._sessions_lock:
                    for sid, s in self._sessions.items():
                        if s.ttl_seconds <= 0:
                            continue
                        if not s.is_alive() or s.idle_seconds() > s.ttl_seconds:
                            victims.append(sid)
                for sid in victims:
                    if self.close_session(sid):
                        logger.info(f"[janitor] 回收: {sid}")
            except asyncio.CancelledError:
                break
            except Exception:
                logger.exception("[janitor] 异常")


def get_session_manager() -> SessionManager:
    return SessionManager()
