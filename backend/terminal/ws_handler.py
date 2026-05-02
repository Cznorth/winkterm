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
            logger.debug("[COMMAND] 检测到回车，解析屏幕内容中的命令")
            await self._parse_last_command_from_screen()

    async def handle(self) -> None:
        await self.ws.accept()
        logger.info(f"[ACCEPT] WebSocket 已接受连接, session_id: {self.session_id}")

        # 创建或获取会话
        self.session = self.session_manager.create_session(self.session_id)
        self.pty = self.session.pty

        # 如果 PTY 未启动，则启动
        if not self.pty.is_alive():
            if self.terminal_type == "ssh" and self.ssh_connection_id:
                # SSH 连接
                from backend.ssh.connection_manager import SSHConnectionManager
                conn = SSHConnectionManager.get_connection(self.ssh_connection_id)
                if conn:
                    ssh_config = conn.to_dict()
                    self.pty.spawn(ssh_config=ssh_config)
                    # 更新最后连接时间
                    SSHConnectionManager.update_last_connected(self.ssh_connection_id)
                    logger.info(f"[SPAWN SSH] SSH 已启动: {conn.username}@{conn.host}:{conn.port}")
                else:
                    logger.error(f"[SPAWN SSH] SSH 连接不存在: {self.ssh_connection_id}")
                    await self._send(f"\r\n\033[31m❌ SSH 连接不存在: {self.ssh_connection_id}\033[0m\r\n")
                    return
            else:
                # 本地 shell
                self.pty.spawn()
                logger.info(f"[SPAWN] PTY 已启动: pid={getattr(self.pty, '_pid', 'N/A')}")

        self.pty.add_output_callback(self._on_pty_output)

        # 激活此会话（agent tools 会使用激活会话的 PTY）
        self.session_manager.set_active_session(self.session_id)

        read_task = asyncio.create_task(self.pty.start_read_loop())

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
                    self.pty.resize(cols, rows)
                else:
                    # 普通输入，透传给 PTY
                    logger.debug(f"[INPUT] len={len(data)} data={_truncate(data)}")
                    self.pty.write(data.encode("utf-8"))
                await self.hookinput(data) # 自定义操作

        except WebSocketDisconnect:
            logger.info(f"[DISCONNECT] 客户端断开, session_id={self.session_id}, 统计: msgs={self._msg_count}, "
                        f"rx={self._bytes_received}B, tx={self._bytes_sent}B, "
                        f"duration={time.time() - self._start_time:.1f}s")
        except Exception as exc:
            logger.exception(f"[ERROR] 异常: {exc}")
        finally:
            read_task.cancel()
            if self.pty:
                self.pty.remove_output_callback(self._on_pty_output)
            if self.session:
                self.session_manager.close_session(self.session_id)
            logger.debug(f"[CLEANUP] 会话 {self.session_id} 资源已释放")

    async def _parse_last_command_from_screen(self) -> None:
        """从屏幕内容解析最后一行命令"""
        screen = self.pty.get_screen_content()

        if not screen:
            logger.debug("[COMMAND] 屏幕内容为空，跳过解析")
            return

        # 解析最后一行非空内容
        lines = screen.split('\n')
        last_line = None
        for line in reversed(lines):
            stripped = line.strip()
            if stripped:
                last_line = stripped
                break

        if not last_line:
            logger.debug("[COMMAND] 未找到有效行")
            return

        # 清理 ANSI 转义序列和控制字符
        ansi_escape = re.compile(
            r"\x1b\[[\?0-9;]*[A-Za-z]"
            r"|\x1b\].*?(?:\x07|\x1b\\)"
            r"|\x1b[()][AB012]"
            r"|\x1b[78]"
            r"|\x1b[=>]"
        )
        clean_line = ansi_escape.sub("", last_line)
        clean_line = "".join(c for c in clean_line if c.isprintable() or c in " \t")
        clean_line = clean_line.strip()

        logger.info(f"[COMMAND] 解析到命令: {clean_line}")

        # 检测 # 命令
        # 场景1: "# 你好" - # 是第一个字符
        # 场景2: "root@host:~# # 你好" - bash root prompt (#) 后跟 # 命令
        # 场景3: "PS D:\path> # 你好" - PowerShell prompt (>) 后跟 # 命令
        # 场景4: "user@host:~$ # 你好" - bash user prompt ($) 后跟 # 命令
        # 不触发: "root@host:~#" - 只有 prompt
        # 不触发: "root@host:~# ls" - 普通命令

        # 正则匹配：# 开头，或 prompt 符号 (# $ > %) 后跟 #
        if clean_line.startswith('#') or re.search(r'[#\$>%]\s*#', clean_line):
            # 找到最后一个 # 后面的内容
            last_hash = clean_line.rfind('#')
            command = clean_line[last_hash + 1:].strip()
            if command:
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
        try:
            await self.ws.send_text(text)
        except Exception as e:
            logger.warning(f"[SEND_FAIL] 发送失败: {e}")
