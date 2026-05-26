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

# 配置日志
logger = logging.getLogger("ws_handler")
logging.basicConfig(
    level=logging.DEBUG,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)

# resize 事件格式: ESC[8;rows;colst
_RESIZE_PATTERN = re.compile(r"\x1b\[8;(\d+);(\d+)t")
# 终端查询类 ANSI(DA/DA2/DSR/Window report 等):发往 xterm 前必须剥掉,
# 否则 xterm 解析后会再次回复 → shell 把回复当输入显示在 prompt。
# Windows ConPTY/PSReadLine 还常把 ESC 吃掉,只剩 [?1;2c 之类孤儿片段。
_ESC = "\x1b"
_TERM_QUERY_PATTERN = re.compile(re.escape(_ESC) + r"\[[\?>=]?[\d;]*[cn]")
# PSReadLine 会把 DA 拆成带颜色的 [?1 + … + 2c,需连同中间的 SGR 一并剥掉。
_ORPHAN_DA_PATTERN = re.compile(
    r"\[\?(?:(?:" + re.escape(_ESC) + r"\[[0-9;]*m)|[0-9;])+c"
)
# xterm 初始化时发出的 DA/模式查询,不应写入 PTY(Windows shell 会误回显为 [?1;2c)。
_XTERM_TERM_QUERY_INPUT = re.compile(
    r"^" + re.escape(_ESC) + r"(?:\[[\?>=]?[\d;]*c|O)$"
)


def _sanitize_pty_output(text: str) -> str:
    """剥离终端能力查询响应，避免在 xterm 中显示为可见文本。"""
    text = _TERM_QUERY_PATTERN.sub("", text)
    text = _ORPHAN_DA_PATTERN.sub("", text)
    return text


# 屏幕内容响应格式: ESC[?9999;screen;<encoded_content>h
_SCREEN_CONTENT_PATTERN = re.compile(r"\x1b\[\?9999;screen;([^\x1b]*)h")
# 激活会话: ESC[?9999;activateh
_ACTIVATE_PATTERN = re.compile(r"\x1b\[\?9999;activateh")


def _truncate(data: str, max_len: int = 100) -> str:
    """截断并转义控制字符用于日志显示。"""
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


def _extract_hash_command_from_screen(screen: str) -> str | None:
    """从屏幕内容解析 # AI 命令,未命中返回 None。"""
    if not screen:
        return None

    last_line = None
    for line in reversed(screen.split("\n")):
        stripped = line.strip()
        if stripped:
            last_line = stripped
            break
    if not last_line:
        return None

    clean_line = _clean_terminal_line(last_line)
    if not clean_line:
        return None

    # 场景1: "# 你好" - # 是第一个字符
    # 场景2: "root@host:~# # 你好" - bash root prompt (#) 后跟 # 命令
    # 场景3: "PS D:\path> # 你好" - PowerShell prompt (>) 后跟 # 命令
    # 场景4: "user@host:~$ # 你好" - bash user prompt ($) 后跟 # 命令
    if clean_line.startswith("#") or re.search(r"[#\$>%]\s*#", clean_line):
        command = clean_line[clean_line.rfind("#") + 1 :].strip()
        return command or None
    return None


class TerminalWSHandler:
    """WebSocket 终端处理：支持多会话。"""

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
        client = websocket.client or "unknown"
        logger.info(f"[INIT] 客户端连接: {client}, session_id: {session_id}, type: {terminal_type}")

    async def hookinput(self, data: str) -> None:
        """hook用户输入，用于自定义操作"""
        logger.debug(f"[HOOKINPUT] len={len(data)} data={_truncate(data)}")

        # 检测回车键
        if data in ("\r", "\n", "\r\n"):
            # 前端在 Enter 前会先发送 screen 序列化;此处立即快照,避免 Enter
            # 后 200ms 防抖 screen sync 把含 # 命令的输入行覆盖掉。
            screen_snapshot = self.pty.get_screen_content()
            if self.terminal_type == "ssh":
                # SSH 远端回显有延迟:稍等后若最新屏仍含 # 命令则用之(更完整),
                # 否则回退 Enter 瞬间快照(Enter 后 sync 常已清掉输入行)。
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

        # 创建或获取会话
        self.session = self.session_manager.create_session(self.session_id)
        self.pty = self.session.pty

        # SSH 连接配置预取(校验失败立即返回)
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

        # pty 启动推迟到 resize 事件稳定后,用最终 cols/rows 启动 → shell prompt
        # 从一开始就在正确宽度渲染。
        # debounce 原因:前端 fit 早期会先用瞬时小 cols 触发 sendResize(xterm
        # css 还没完全 layout),然后才稳定到真实宽度。直接用首个 resize 会让
        # PowerShell PSReadLine 在 8 cols 之类的宽度画 prompt → "PS D:\Cz" 截断。
        self._pending_spawn: bool = not self.pty.is_alive()
        self._pending_ssh_config: dict | None = ssh_config if self._pending_spawn else None
        self._pending_replay: bytes | str | None = None
        self._spawn_dims: tuple[int, int] | None = None
        self._spawn_task: asyncio.Task | None = None
        if not self._pending_spawn:
            # pty 已存活: 重连 / agent 创建的终端用户首次打开。
            # 首选 frontend 序列化的 screen_content (重连场景);否则回退到
            # session 累积的 _raw (agent 终端首次打开 → 让用户看到历史输出)。
            screen_replay = self.pty.get_screen_content()
            if screen_replay:
                self._pending_replay = screen_replay
            else:
                snap = self.session.snapshot(strip=False)
                raw_text = snap.get("output", "") if isinstance(snap, dict) else ""
                self._pending_replay = raw_text if raw_text else "__REDRAW__"
            # callback 立即挂,后续 pty 输出实时转发
            self.pty.add_output_callback(self._on_pty_output)
            self.session.ensure_read_loop()

        # 激活此会话（agent tools 会使用激活会话的 PTY）
        self.session_manager.set_active_session(self.session_id)

        try:
            while True:
                # 直接接收文本，透传给 PTY
                data = await self.ws.receive_text()
                self._msg_count += 1
                self._bytes_received += len(data.encode("utf-8"))

                # 检查是否是屏幕内容响应
                screen_match = _SCREEN_CONTENT_PATTERN.fullmatch(data)
                if screen_match:
                    from urllib.parse import unquote
                    content = unquote(screen_match.group(1))
                    self.pty.set_screen_content(content)
                    logger.debug(f"[SCREEN_CONTENT] 收到屏幕内容, 长度={len(content)}")
                    continue

                # 检查是否是激活消息
                if _ACTIVATE_PATTERN.fullmatch(data):
                    self.session_manager.set_active_session(self.session_id)
                    logger.debug(f"[ACTIVATE] 激活会话: {self.session_id}")
                    continue

                # 检查是否是 resize 事件
                match = _RESIZE_PATTERN.fullmatch(data)
                if match:
                    rows, cols = int(match.group(1)), int(match.group(2))
                    logger.debug(f"[RESIZE] rows={rows}, cols={cols}")
                    # 异常瞬时小 size 直接忽略(前端过渡态)
                    if cols < 20 or rows < 5:
                        logger.debug(f"[RESIZE] 忽略异常 size cols={cols} rows={rows}")
                        continue
                    if self._pending_spawn:
                        # debounce: 收一个 resize 重置 spawn 计时,稳定后用最终值 spawn
                        self._spawn_dims = (cols, rows)
                        if self._spawn_task and not self._spawn_task.done():
                            self._spawn_task.cancel()
                        self._spawn_task = asyncio.create_task(self._spawn_after_settle(0.25))
                    else:
                        self.pty.resize(cols, rows)
                        # 首个 resize 到达 = xterm 已 fit 完毕,这时再 replay/redraw
                        if self._pending_replay is not None:
                            pending = self._pending_replay
                            self._pending_replay = None
                            if pending == "__REDRAW__":
                                # 无 screen 快照,踢一下 shell 重打 prompt
                                self.pty.write(b"\r")
                            elif isinstance(pending, str):
                                await self._send(pending)
                else:
                    # 普通输入，透传给 PTY
                    if self._pending_spawn:
                        # pty 还没启动(resize 未稳定),丢弃输入避免 NPE
                        logger.warning(f"[INPUT] pty 未启动,丢弃输入 len={len(data)}")
                        continue
                    logger.debug(f"[INPUT] len={len(data)} data={_truncate(data)}")
                    if _XTERM_TERM_QUERY_INPUT.fullmatch(data):
                        logger.debug("[INPUT] 忽略 xterm 终端能力查询")
                        continue
                    self.pty.write(data.encode("utf-8"))
                await self.hookinput(data) # 自定义操作

        except WebSocketDisconnect:
            logger.info(f"[DISCONNECT] 客户端断开, session_id={self.session_id}, 统计: msgs={self._msg_count}, "
                        f"rx={self._bytes_received}B, tx={self._bytes_sent}B, "
                        f"duration={time.time() - self._start_time:.1f}s")
        except Exception as exc:
            logger.exception(f"[ERROR] 异常: {exc}")
        finally:
            # WS 断开不关 session,保活 pty + 读循环(session 持有)。
            # session 由用户显式删 tab(DELETE /api/sessions/{id})或 TTL 回收。
            if self._spawn_task and not self._spawn_task.done():
                self._spawn_task.cancel()
            if self.pty:
                self.pty.remove_output_callback(self._on_pty_output)
            logger.debug(f"[CLEANUP] WS 断开但 session {self.session_id} 保活")

    async def _spawn_after_settle(self, delay: float) -> None:
        """resize 事件稳定后用最终 cols/rows 启动 pty。每次新 resize 都会
        cancel 重建本 task,只有最后一次能跑到 spawn,从而避开早期瞬时小 cols。
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
        """从屏幕内容解析最后一行命令"""
        screen = screen if screen is not None else self.pty.get_screen_content()

        if not screen:
            logger.debug("[COMMAND] 屏幕内容为空，跳过解析")
            return

        command = _extract_hash_command_from_screen(screen)
        if not command:
            return

        logger.info(f"[COMMAND] 解析到 AI 命令: {command}")
        await self.agent_invoke(command)

    async def agent_invoke(self, user_input: str) -> None:
        """调用 AI Agent 并流式输出到终端。"""
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

            # 重置 AI 输出标志
            set_has_ai_output(False)

            # 使用 astream_events 获取流式输出
            collected_content = ""
            final_state = None
            has_output = False  # 是否有文本输出

            config = {"recursion_limit": settings.agent_recursion_limit}
            logger.info(f"[AGENT] recursion_limit={settings.agent_recursion_limit}")
            async for event in graph.astream_events(initial_state, config=config, version="v2"):
                event_type = event.get("event", "")
                event_name = event.get("name", "")
                logger.debug(f"[AGENT] 事件: {event_type} | {event_name}")

                # 监听 LLM 流式输出
                if event_type == "on_chat_model_stream":
                    chunk = event.get("data", {}).get("chunk")
                    if chunk and hasattr(chunk, "content"):
                        content = chunk.content
                        if content:
                            # content 可能是 string 或 list
                            if isinstance(content, list):
                                content = "".join(
                                    part if isinstance(part, str) else part.get("text", "")
                                    for part in content
                                )
                            if not content:
                                continue
                            if not has_output:
                                has_output = True
                                set_has_ai_output(True)  # 标记有 AI 输出
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

                # 监听工具调用结束
                elif event_type == "on_tool_end":
                    tool_name = event.get("name", "unknown")
                    logger.debug(f"[AGENT] 工具完成: {tool_name}")

                # 获取最终状态
                elif event_type == "on_chain_end" and event_name == "LangGraph":
                    final_state = event.get("data", {}).get("output")

            # 根据状态决定是否发送 Ctrl+C
            waiting_user = final_state.get("waiting_user", False) if final_state else False
            logger.info(f"[AGENT] 处理完成, waiting_user={waiting_user}")
            if has_output and not waiting_user:
                self.pty.write(b"\x03")  # Ctrl+C

        except Exception as e:
            logger.exception(f"[AGENT] 调用失败: {e}")
            await self._send(f"\r\n\033[31m❌ AI 调用出错: {e}\033[0m\r\n")

    def _on_pty_output(self, data: bytes) -> None:
        """PTY 输出回调：直接发送给 WebSocket。"""
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
