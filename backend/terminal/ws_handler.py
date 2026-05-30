from __future__ import annotations

import asyncio
import logging
import re
import time

from fastapi import WebSocket, WebSocketDisconnect

from backend.terminal.pty_manager import PtyManager
from backend.terminal.session_manager import get_session_manager, TerminalSession
from backend.agent.graph import get_graph
from backend.agent.tools import set_has_ai_output
from backend.agent.state import AgentState
from backend.config import settings
from langchain_core.messages import HumanMessage

# Configure logging
logger = logging.getLogger("ws_handler")
logging.basicConfig(
    level=logging.DEBUG,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)

# resize event format: ESC[8;rows;colst
_RESIZE_PATTERN = re.compile(r"\x1b\[8;(\d+);(\d+)t")
# Terminal query ANSI (DA/DA2/DSR/Window report, etc.): must be stripped before sending to xterm,
# otherwise xterm parses and replies again → the shell shows the reply as input in the prompt.
# Windows ConPTY/PSReadLine also often eats the ESC, leaving orphan fragments like [?1;2c.
_ESC = "\x1b"
_TERM_QUERY_PATTERN = re.compile(re.escape(_ESC) + r"\[[\?>=]?[\d;]*[cn]")
# PSReadLine splits the DA into colored [?1 + … + 2c; the inline SGR must be stripped along with it.
_ORPHAN_DA_PATTERN = re.compile(
    r"\[\?(?:(?:" + re.escape(_ESC) + r"\[[0-9;]*m)|[0-9;])+c"
)
# DA/mode queries emitted during xterm init should not be written to the PTY (Windows shell wrongly echoes them as [?1;2c).
_XTERM_TERM_QUERY_INPUT = re.compile(
    r"^" + re.escape(_ESC) + r"(?:\[[\?>=]?[\d;]*c|O)$"
)


def _sanitize_pty_output(text: str) -> str:
    """Strip terminal capability query responses to avoid showing them as visible text in xterm."""
    text = _TERM_QUERY_PATTERN.sub("", text)
    text = _ORPHAN_DA_PATTERN.sub("", text)
    return text


# Screen content response format: ESC[?9999;screen;<encoded_content>h
_SCREEN_CONTENT_PATTERN = re.compile(r"\x1b\[\?9999;screen;([^\x1b]*)h")
# Activate session: ESC[?9999;activateh
_ACTIVATE_PATTERN = re.compile(r"\x1b\[\?9999;activateh")


def _truncate(data: str, max_len: int = 100) -> str:
    """Truncate and escape control characters for log display."""
    escaped = data.encode("unicode_escape").decode("ascii")
    if len(escaped) > max_len:
        return escaped[:max_len] + "..."
    return escaped


_ANSI_ESCAPE = re.compile(
    r"\x1b\[[\?0-9;]*[A-Za-z]"
    r"|\x1b\].*?(?:\x07|\x1b\\)"
    r"|\x1b[()][AB012]"
    r"|\x1b[78]"
    r"|\x1b[=>]"
)


def _clean_terminal_line(line: str) -> str:
    clean = _ANSI_ESCAPE.sub("", line)
    clean = "".join(c for c in clean if c.isprintable() or c in " \t")
    return clean.strip()


def _line_to_hash_command(clean_line: str) -> str | None:
    if not clean_line:
        return None
    # Case 1: "# hi" - # is the first character
    # Case 2: "root@host:~# # hi" - bash root prompt (#) followed by # command
    # Case 3: "PS D:\path> # hi" - PowerShell prompt (>) followed by # command
    # Case 4: "user@host:~$ # hi" - bash user prompt ($) followed by # command
    if clean_line.startswith("#") or re.search(r"[#\$>%]\s*#\s*\S", clean_line):
        command = clean_line[clean_line.rfind("#") + 1 :].strip()
        return command or None
    return None


def _extract_hash_command_from_screen(screen: str, lookback: int = 6) -> str | None:
    """Scan the last few screen lines for a # AI command.

    bash treats `# xxx` as a comment; after Enter the new prompt occupies the last
    line and the # command is on the previous line; SSH remote echo latency also
    puts the # command on a non-last line. So scan lookback lines and return on the
    first hit.
    """
    if not screen:
        return None

    scanned = 0
    for line in reversed(screen.split("\n")):
        stripped = line.strip()
        if not stripped:
            continue
        clean = _clean_terminal_line(stripped)
        cmd = _line_to_hash_command(clean)
        if cmd:
            return cmd
        scanned += 1
        if scanned >= lookback:
            break
    return None


class TerminalWSHandler:
    """WebSocket terminal handling: supports multiple sessions."""

    def __init__(
        self,
        websocket: WebSocket,
        session_id: str = "default",
        terminal_type: str = "local",
        ssh_connection_id: str | None = None,
    ) -> None:
        self.ws = websocket
        self.session_id = session_id
        self.terminal_type = terminal_type
        self.ssh_connection_id = ssh_connection_id
        self.session_manager = get_session_manager()
        self.session: TerminalSession | None = None
        self.pty: PtyManager | None = None
        self._start_time = time.time()
        self._msg_count = 0
        self._bytes_sent = 0
        self._bytes_received = 0
        self._last_hash_command: str | None = None
        client = websocket.client or "unknown"
        logger.info(f"[INIT] 客户端连接: {client}, session_id: {session_id}, type: {terminal_type}")

    async def hookinput(self, data: str) -> None:
        """Hook user input for custom operations."""
        logger.debug(f"[HOOKINPUT] len={len(data)} data={_truncate(data)}")

        # Detect the Enter key
        if data in ("\r", "\n", "\r\n"):
            # The frontend serializes the screen before Enter; snapshot immediately here to
            # avoid the post-Enter 200ms debounced screen sync overwriting the # command input line.
            screen_snapshot = self.pty.get_screen_content()
            if self.terminal_type == "ssh":
                # SSH remote echo is delayed: after a short wait, if the latest screen still has
                # the # command use it (more complete), otherwise fall back to the Enter-moment snapshot.
                await asyncio.sleep(0.4)
                latest = self.pty.get_screen_content()
                latest_cmd = _extract_hash_command_from_screen(latest)
                if latest_cmd:
                    screen_snapshot = latest
            logger.debug("[COMMAND] 检测到回车，解析屏幕内容中的命令")
            await self._parse_last_command_from_screen(screen_snapshot)

    async def handle(self) -> None:
        await self.ws.accept()
        logger.info(f"[ACCEPT] WebSocket 已接受连接, session_id: {self.session_id}")

        # Create or get the session
        self.session = self.session_manager.create_session(self.session_id)
        self.pty = self.session.pty

        # Prefetch SSH connection config (return immediately if validation fails)
        ssh_config: dict | None = None
        if self.terminal_type == "ssh" and self.ssh_connection_id:
            from backend.ssh.connection_manager import SSHConnectionManager
            conn = SSHConnectionManager.get_connection(self.ssh_connection_id)
            if not conn:
                logger.error(f"[SPAWN SSH] SSH 连接不存在: {self.ssh_connection_id}")
                await self._send(f"\r\n\033[31m❌ SSH 连接不存在: {self.ssh_connection_id}\033[0m\r\n")
                return
            ssh_config = conn.to_dict()
            SSHConnectionManager.update_last_connected(self.ssh_connection_id)

        # pty spawn is deferred until resize events settle, starting with the final
        # cols/rows → the shell prompt renders at the correct width from the start.
        # debounce reason: early frontend fit first triggers sendResize with a transient small
        # cols (xterm css not fully laid out yet), then settles to the real width. Using the
        # first resize directly would make PowerShell PSReadLine draw the prompt at ~8 cols → "PS D:\Cz" truncation.
        self._pending_spawn: bool = not self.pty.is_alive()
        self._pending_ssh_config: dict | None = ssh_config if self._pending_spawn else None
        self._pending_replay: bytes | str | None = None
        self._spawn_dims: tuple[int, int] | None = None
        self._spawn_task: asyncio.Task | None = None
        if not self._pending_spawn:
            # pty already alive: reconnect / first open of an agent-created terminal.
            # Prefer the frontend-serialized screen_content (reconnect case); otherwise fall
            # back to the session-accumulated _raw (first open of agent terminal → show history).
            screen_replay = self.pty.get_screen_content()
            if screen_replay:
                self._pending_replay = screen_replay
            else:
                snap = self.session.snapshot(strip=False)
                raw_text = snap.get("output", "") if isinstance(snap, dict) else ""
                self._pending_replay = raw_text if raw_text else "__REDRAW__"
            # Attach the callback immediately so subsequent pty output is forwarded in real time
            self.pty.add_output_callback(self._on_pty_output)
            self.session.ensure_read_loop()

        # Activate this session (agent tools use the active session's PTY)
        self.session_manager.set_active_session(self.session_id)

        try:
            while True:
                # Receive text directly and pass through to the PTY
                data = await self.ws.receive_text()
                self._msg_count += 1
                self._bytes_received += len(data.encode("utf-8"))

                # Check whether this is a screen content response
                screen_match = _SCREEN_CONTENT_PATTERN.fullmatch(data)
                if screen_match:
                    from urllib.parse import unquote
                    content = unquote(screen_match.group(1))
                    self.pty.set_screen_content(content)
                    logger.debug(f"[SCREEN_CONTENT] 收到屏幕内容, 长度={len(content)}")
                    continue

                # Check whether this is an activate message
                if _ACTIVATE_PATTERN.fullmatch(data):
                    self.session_manager.set_active_session(self.session_id)
                    logger.debug(f"[ACTIVATE] 激活会话: {self.session_id}")
                    continue

                # Check whether this is a resize event
                match = _RESIZE_PATTERN.fullmatch(data)
                if match:
                    rows, cols = int(match.group(1)), int(match.group(2))
                    logger.debug(f"[RESIZE] rows={rows}, cols={cols}")
                    # Ignore abnormal transient small sizes (frontend transition state)
                    if cols < 20 or rows < 5:
                        logger.debug(f"[RESIZE] 忽略异常 size cols={cols} rows={rows}")
                        continue
                    if self._pending_spawn:
                        # debounce: each resize resets the spawn timer; spawn with the final value once settled
                        self._spawn_dims = (cols, rows)
                        if self._spawn_task and not self._spawn_task.done():
                            self._spawn_task.cancel()
                        self._spawn_task = asyncio.create_task(self._spawn_after_settle(0.25))
                    else:
                        self.pty.resize(cols, rows)
                        # First resize arrived = xterm finished fit; now replay/redraw
                        if self._pending_replay is not None:
                            pending = self._pending_replay
                            self._pending_replay = None
                            if pending == "__REDRAW__":
                                # No screen snapshot; nudge the shell to redraw the prompt
                                self.pty.write(b"\r")
                            elif isinstance(pending, str):
                                await self._send(pending)
                else:
                    # Normal input; pass through to the PTY
                    if self._pending_spawn:
                        # pty not started yet (resize not settled); drop input to avoid NPE
                        logger.warning(f"[INPUT] pty 未启动,丢弃输入 len={len(data)}")
                        continue
                    logger.debug(f"[INPUT] len={len(data)} data={_truncate(data)}")
                    if _XTERM_TERM_QUERY_INPUT.fullmatch(data):
                        logger.debug("[INPUT] 忽略 xterm 终端能力查询")
                        continue
                    self.pty.write(data.encode("utf-8"))
                await self.hookinput(data) # custom operation

        except WebSocketDisconnect:
            logger.info(f"[DISCONNECT] 客户端断开, session_id={self.session_id}, 统计: msgs={self._msg_count}, "
                        f"rx={self._bytes_received}B, tx={self._bytes_sent}B, "
                        f"duration={time.time() - self._start_time:.1f}s")
        except Exception as exc:
            logger.exception(f"[ERROR] 异常: {exc}")
        finally:
            # WS disconnect does not close the session; keep the pty + read loop alive (held by the session).
            # The session is reclaimed when the user explicitly deletes the tab (DELETE /api/sessions/{id}) or by TTL.
            if self._spawn_task and not self._spawn_task.done():
                self._spawn_task.cancel()
            if self.pty:
                self.pty.remove_output_callback(self._on_pty_output)
            logger.debug(f"[CLEANUP] WS 断开但 session {self.session_id} 保活")

    async def _spawn_after_settle(self, delay: float) -> None:
        """Start the pty with the final cols/rows after resize events settle. Each new
        resize cancels and recreates this task, so only the last one reaches spawn, avoiding early transient small cols.
        """
        try:
            await asyncio.sleep(delay)
        except asyncio.CancelledError:
            return
        if not self._pending_spawn or self._spawn_dims is None:
            return
        cols, rows = self._spawn_dims
        self._pending_spawn = False
        try:
            self.pty.spawn(cols=cols, rows=rows, ssh_config=self._pending_ssh_config)
            logger.info(f"[SPAWN] pty 启动 cols={cols} rows={rows} pid={getattr(self.pty, '_pid', 'N/A')}")
        except Exception as e:
            logger.exception(f"[SPAWN] 启动失败: {e}")
            await self._send(f"\r\n\033[31m❌ 终端启动失败: {e}\033[0m\r\n")
            return
        self.pty.add_output_callback(self._on_pty_output)
        self.session.ensure_read_loop()

    async def _parse_last_command_from_screen(self, screen: str | None = None) -> None:
        """Parse the last command line from the screen content."""
        screen = screen if screen is not None else self.pty.get_screen_content()

        if not screen:
            logger.debug("[COMMAND] 屏幕内容为空，跳过解析")
            return

        command = _extract_hash_command_from_screen(screen)
        if not command:
            return

        # dedupe: lookback scans history lines; the # command stays on screen after Enter → prevent re-triggering on the next Enter
        if command == self._last_hash_command:
            logger.debug(f"[COMMAND] 命令与上次相同,跳过: {command}")
            return
        self._last_hash_command = command

        logger.info(f"[COMMAND] 解析到 AI 命令: {command}")
        await self.agent_invoke(command)

    async def agent_invoke(self, user_input: str) -> None:
        """Invoke the AI Agent and stream output to the terminal."""
        logger.info(f"[AGENT] 开始处理: {user_input}")

        try:
            graph = get_graph()

            terminal_output = self.pty.get_context(lines=50)
            initial_state: AgentState = {
                "messages": [HumanMessage(content=user_input)],
                "terminal_output": terminal_output,
                "analysis_result": "",
                "llm_calls": 0,
                "waiting_user": False,
            }
            logger.info(f"[AGENT] 终端上下文长度: {len(terminal_output)}, 前200字符: {repr(terminal_output[:200])}")

            # Reset the AI output flag
            set_has_ai_output(False)

            # Use astream_events to get streaming output
            collected_content = ""
            final_state = None
            has_output = False  # whether there is any text output

            config = {"recursion_limit": settings.agent_recursion_limit}
            logger.info(f"[AGENT] recursion_limit={settings.agent_recursion_limit}")
            async for event in graph.astream_events(initial_state, config=config, version="v2"):
                event_type = event.get("event", "")
                event_name = event.get("name", "")
                logger.debug(f"[AGENT] 事件: {event_type} | {event_name}")

                # Listen for LLM streaming output
                if event_type == "on_chat_model_stream":
                    chunk = event.get("data", {}).get("chunk")
                    if chunk and hasattr(chunk, "content"):
                        content = chunk.content
                        if content:
                            # content may be a string or a list
                            if isinstance(content, list):
                                content = "".join(
                                    part if isinstance(part, str) else part.get("text", "")
                                    for part in content
                                )
                            if not content:
                                continue
                            if not has_output:
                                has_output = True
                                set_has_ai_output(True)  # mark that there is AI output
                                self.pty.write("# winkterm: ".encode("utf-8"))

                            logger.debug(f"[AGENT] AI 输出: {repr(content)}")
                            ansi_escape = re.compile(
                                r"\x1b\[[\?0-9;]*[A-Za-z]"
                                r"|\x1b\].*?(?:\x07|\x1b\\)"
                                r"|\x1b[()][AB012]"
                                r"|\x1b[78]"
                                r"|\x1b[=>]"
                            )
                            clean_content = ansi_escape.sub("", content)
                            clean_content = clean_content.replace("\r", "").replace("\n", "")
                            collected_content += clean_content
                            self.pty.write(clean_content.encode("utf-8"))

                # Listen for tool call completion
                elif event_type == "on_tool_end":
                    tool_name = event.get("name", "unknown")
                    logger.debug(f"[AGENT] 工具完成: {tool_name}")

                # Get the final state
                elif event_type == "on_chain_end" and event_name == "LangGraph":
                    final_state = event.get("data", {}).get("output")

            # Decide whether to send Ctrl+C based on the state
            waiting_user = final_state.get("waiting_user", False) if final_state else False
            logger.info(f"[AGENT] 处理完成, waiting_user={waiting_user}")
            if has_output and not waiting_user:
                self.pty.write(b"\x03")  # Ctrl+C

        except Exception as e:
            logger.exception(f"[AGENT] 调用失败: {e}")
            await self._send(f"\r\n\033[31m❌ AI 调用出错: {e}\033[0m\r\n")

    def _on_pty_output(self, data: bytes) -> None:
        """PTY output callback: send directly to the WebSocket."""
        text = data.decode(errors="replace")
        self._bytes_sent += len(data)
        # logger.debug(f"[OUTPUT] len={len(data)} data={_truncate(text)}")
        asyncio.create_task(self._send(text))

    async def _send(self, text: str) -> None:
        text = _sanitize_pty_output(text)
        try:
            await self.ws.send_text(text)
        except Exception as e:
            logger.warning(f"[SEND_FAIL] 发送失败: {e}")
