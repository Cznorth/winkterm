"""侧边栏 AI 对话 WebSocket 处理器。"""

from __future__ import annotations

import json
import logging
import re
from typing import TYPE_CHECKING

from fastapi import WebSocket, WebSocketDisconnect
from langchain_core.messages import AIMessageChunk, HumanMessage, SystemMessage

from backend.agent.factory import get_agent
from backend.agent.core.state import AgentState

if TYPE_CHECKING:
    from langgraph.graph import CompiledGraph

logger = logging.getLogger("ws_chat")


class ChatWSHandler:
    """侧边栏对话 WebSocket 处理器，使用 analysis agent。"""

    def __init__(self, websocket: WebSocket):
        self.ws = websocket
        self.agent: CompiledGraph | None = None

    async def handle(self) -> None:
        await self.ws.accept()
        logger.info("[ACCEPT] Chat WebSocket 已连接")

        # 编译 agent
        try:
            self.agent = get_agent("analysis")
            logger.info("[AGENT] Analysis agent 已加载")
        except Exception as e:
            logger.error(f"[AGENT] 加载失败: {e}")
            await self._send_error("Agent 加载失败")
            return

        try:
            while True:
                # 接收消息
                data = await self.ws.receive_text()
                logger.debug(f"[RECV] {data[:100]}")

                try:
                    msg = json.loads(data)
                except json.JSONDecodeError:
                    await self._send_error("无效的 JSON 格式")
                    continue

                msg_type = msg.get("type")

                if msg_type == "chat":
                    await self._handle_chat(msg.get("content", ""))
                else:
                    logger.warning(f"[MSG] 未知消息类型: {msg_type}")

        except WebSocketDisconnect:
            logger.info("[DISCONNECT] 客户端断开")
        except Exception as e:
            logger.exception(f"[ERROR] {e}")
        finally:
            logger.info("[CLEANUP] Chat WebSocket 关闭")

    async def _handle_chat(self, content: str) -> None:
        """处理对话消息，流式输出。"""
        if not content.strip():
            return

        logger.info(f"[CHAT] 用户: {content[:50]}")

        # 初始状态
        state: AgentState = {
            "messages": [HumanMessage(content=content)],
            "terminal_output": "",
            "analysis_result": "",
            "llm_calls": 0,
            "waiting_user": False,
        }

        # 发送开始标记
        await self._send({"type": "start"})

        # 流式处理
        collected_content = ""
        try:
            async for event in self.agent.astream_events(state, version="v2"):
                event_type = event.get("event", "")

                # LLM 流式输出
                if event_type == "on_chat_model_stream":
                    chunk = event.get("data", {}).get("chunk")
                    if chunk and hasattr(chunk, "content"):
                        token = chunk.content
                        if token:
                            collected_content += token
                            await self._send({
                                "type": "token",
                                "content": token
                            })

                # 工具调用（暂时忽略，先实现对话）
                elif event_type == "on_tool_start":
                    tool_name = event.get("name", "unknown")
                    await self._send({
                        "type": "tool_start",
                        "tool": tool_name
                    })

                elif event_type == "on_tool_end":
                    tool_name = event.get("name", "unknown")
                    await self._send({
                        "type": "tool_end",
                        "tool": tool_name
                    })

            # 发送结束标记
            await self._send({
                "type": "end",
                "content": collected_content
            })

        except Exception as e:
            logger.exception(f"[CHAT] 处理失败: {e}")
            await self._send_error(str(e))

    async def _send(self, data: dict) -> None:
        """发送 JSON 消息。"""
        try:
            await self.ws.send_text(json.dumps(data, ensure_ascii=False))
        except Exception as e:
            logger.warning(f"[SEND] 发送失败: {e}")

    async def _send_error(self, message: str) -> None:
        """发送错误消息。"""
        await self._send({"type": "error", "message": message})
