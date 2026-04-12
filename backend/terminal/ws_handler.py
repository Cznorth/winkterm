from __future__ import annotations

import asyncio
import logging
import re
import sys
import time

from fastapi import WebSocket, WebSocketDisconnect

from backend.terminal.pty_manager import PtyManager
from backend.agent.graph import get_graph
from backend.agent.tools import set_pty_manager
from backend.agent.state import AgentState
from langchain_core.messages import HumanMessage

# 配置日志
logger = logging.getLogger("ws_handler")
logging.basicConfig(
    level=logging.DEBUG,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)

# resize 事件格式: ESC[8;rows;colst
_RESIZE_PATTERN = re.compile(r"\x1b\[8;(\d+);(\d+)t")


def _truncate(data: str, max_len: int = 100) -> str:
    """截断并转义控制字符用于日志显示。"""
    escaped = data.encode("unicode_escape").decode("ascii")
    if len(escaped) > max_len:
        return escaped[:max_len] + "..."
    return escaped


class TerminalWSHandler:
    """WebSocket 终端处理：纯透传字节。"""

    def __init__(self, websocket: WebSocket) -> None:
        self.ws = websocket
        self.pty = PtyManager()
        self._start_time = time.time()
        self._msg_count = 0
        self._bytes_sent = 0
        self._bytes_received = 0
        self._capturing_history = False  # 是否正在捕获历史命令
        self._history_buffer: list[str] = []  # 历史命令缓冲区
        client = websocket.client or "unknown"
        logger.info(f"[INIT] 客户端连接: {client}")

        # 设置 pty_manager 给 agent tools 使用
        set_pty_manager(self.pty)

    async def hookinput(self, data: str) -> None:
        """hook用户输入，用于自定义操作"""
        logger.debug(f"[HOOKINPUT] len={len(data)} data={_truncate(data)}")

        # 检测回车键
        if data in ("\r", "\n", "\r\n"):
            logger.debug("[HISTORY] 检测到回车，开始获取上一条命令")
            await asyncio.sleep(0.1)
            await self._fetch_last_command()

    async def handle(self) -> None:
        await self.ws.accept()
        logger.info("[ACCEPT] WebSocket 已接受连接")

        self.pty.spawn()
        self.pty.add_output_callback(self._on_pty_output)
        logger.info(f"[SPAWN] PTY 已启动: pid={getattr(self.pty, '_pid', 'N/A')}")

        read_task = asyncio.create_task(self.pty.start_read_loop())

        try:
            while True:
                # 直接接收文本，透传给 PTY
                data = await self.ws.receive_text()
                self._msg_count += 1
                self._bytes_received += len(data.encode("utf-8"))

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
            logger.info(f"[DISCONNECT] 客户端断开, 统计: msgs={self._msg_count}, "
                        f"rx={self._bytes_received}B, tx={self._bytes_sent}B, "
                        f"duration={time.time() - self._start_time:.1f}s")
        except Exception as exc:
            logger.exception(f"[ERROR] 异常: {exc}")
        finally:
            read_task.cancel()
            self.pty.terminate()
            self.pty.remove_output_callback(self._on_pty_output)
            logger.debug("[CLEANUP] 资源已释放")

    async def _fetch_last_command(self) -> None:
        """发送上键和下键来获取上一条命令"""
        # 开始捕获
        self._capturing_history = True
        self._history_buffer = []

        # 发送上键
        logger.debug("[HISTORY] 发送上键序列")
        self.pty.write(b"\x1b[A")

        # 等待终端响应
        # await asyncio.sleep(0.3)

        # 发送下键
        logger.debug("[HISTORY] 发送下键序列")
        self.pty.write(b"\x1b[B")

        # 等待下键响应
        await asyncio.sleep(0.1)

        # 停止捕获并解析
        self._capturing_history = False
        await self._parse_last_command()

    async def _parse_last_command(self) -> None:
        """解析捕获的历史命令"""
        if not self._history_buffer:
            logger.debug("[HISTORY] 未捕获到任何输出")
            return

        # 合并缓冲区内容
        full_output = "".join(self._history_buffer)
        logger.debug(f"[HISTORY] 捕获的原始输出: {repr(full_output[:200])}")

        # 更全面的 ANSI 转义序列正则
        # 包括：CSI序列 (ESC[...字母)、OSC序列 (ESC]...BEL/ST)、其他转义
        ansi_escape = re.compile(
            r"\x1b\[[\?0-9;]*[A-Za-z]"  # CSI 序列（包括私有模式 ?）
            r"|\x1b\].*?(?:\x07|\x1b\\)"  # OSC 序列
            r"|\x1b[()][AB012]"  # 字符集选择
            r"|\x1b[78]"  # 保存/恢复光标
            r"|\x1b[=>]"  # 键盘模式
        )

        # 去除所有 ANSI 转义序列
        clean_output = ansi_escape.sub("", full_output)

        # 去除控制字符（保留可打印字符、空格、制表符）
        clean_output = "".join(c for c in clean_output if c.isprintable() or c in " \t")

        # 清理多余空白
        clean_output = " ".join(clean_output.split())

        if clean_output:
            logger.info(f"[HISTORY] 上一条命令: {clean_output}")
            if clean_output.startswith("#"):
                await self.agent_invoke(clean_output[1:])
        else:
            logger.debug("[HISTORY] 未能解析出有效命令")
    async def agent_invoke(self, user_input: str) -> None:
        """调用 AI Agent 并流式输出到终端。"""
        logger.info(f"[AGENT] 开始处理: {user_input}")

        # 先打印提示，让用户知道 AI 正在思考
        self.pty.write("🤖 思考中...".encode("utf-8"))

        try:
            graph = get_graph()

            initial_state: AgentState = {
                "messages": [HumanMessage(content=user_input)],
                "terminal_output": self.pty.get_context(lines=50),
                "analysis_result": "",
                "llm_calls": 0,
            }

            # 使用 astream_events 获取流式输出
            collected_content = ""
            async for event in graph.astream_events(initial_state, version="v2"):
                event_type = event.get("event", "")
                event_name = event.get("name", "")
                logger.debug(f"[AGENT] 事件: {event_type} | {event_name}")

                # 监听 LLM 流式输出
                if event_type == "on_chat_model_stream":
                    chunk = event.get("data", {}).get("chunk")
                    if chunk and hasattr(chunk, "content"):
                        content = chunk.content
                        if content:
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

                # 监听工具调用开始
                elif event_type == "on_tool_start":
                    tool_name = event.get("name", "unknown")
                    logger.debug(f"[AGENT] 工具调用: {tool_name}")
                    self.pty.write(f"🔧 调用工具: {tool_name}".encode("utf-8"))

                # 监听工具调用结束
                elif event_type == "on_tool_end":
                    tool_name = event.get("name", "unknown")
                    logger.debug(f"[AGENT] 工具完成: {tool_name}")

            # 完成后发送 Ctrl+C 重置命令行
            logger.info(f"[AGENT] 处理完成")
            self.pty.write(b"\x03")  # Ctrl+C

        except Exception as e:
            logger.exception(f"[AGENT] 调用失败: {e}")
            await self._send(f"\r\n\033[31m❌ AI 调用出错: {e}\033[0m\r\n")
        
    def _on_pty_output(self, data: bytes) -> None:
        """PTY 输出回调：直接发送给 WebSocket。"""
        text = data.decode(errors="replace")
        self._bytes_sent += len(data)
        logger.debug(f"[OUTPUT] len={len(data)} data={_truncate(text)}")

        # 如果正在捕获历史命令，保存到缓冲区
        if self._capturing_history:
            self._history_buffer.append(text)
        asyncio.create_task(self._send(text))

    async def _send(self, text: str) -> None:
        try:
            await self.ws.send_text(text)
        except Exception as e:
            logger.warning(f"[SEND_FAIL] 发送失败: {e}")
