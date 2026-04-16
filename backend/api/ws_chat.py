"""侧边栏 AI 对话 WebSocket 处理器。"""

from __future__ import annotations

import json
import logging
import re
from typing import TYPE_CHECKING

from fastapi import WebSocket, WebSocketDisconnect
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage

from backend.agent.factory import get_agent
from backend.agent.core.state import AgentState
from backend.agent.tools.terminal import get_terminal_context_raw
from backend.config import UserConfig

if TYPE_CHECKING:
    from langgraph.graph import CompiledGraph

logger = logging.getLogger("ws_chat")


class ChatWSHandler:
    """侧边栏对话 WebSocket 处理器，支持多种模式。"""

    def __init__(self, websocket: WebSocket):
        self.ws = websocket
        self.agents: dict[str, CompiledGraph] = {}
        self.current_mode = "craft"  # 默认 craft 模式
        self.history: list[HumanMessage | AIMessage] = []  # 会话历史

    async def handle(self) -> None:
        await self.ws.accept()
        logger.info("[ACCEPT] Chat WebSocket 已连接")

        # 发送当前模型
        config = UserConfig.load()
        current_model = config.get("selected_model", "")
        if current_model:
            await self._send({"type": "model_changed", "model": current_model})

        # 预加载常用 agent
        try:
            self.agents["chat"] = get_agent("chat")
            self.agents["craft"] = get_agent("craft")
            logger.info(f"[AGENT] 已加载: {list(self.agents.keys())}")
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
                elif msg_type == "clear":
                    # 清空历史
                    self.history = []
                    logger.info("[CLEAR] 会话历史已清空")
                elif msg_type == "switch_mode":
                    mode = msg.get("mode", "craft")
                    if mode in self.agents:
                        self.current_mode = mode
                        logger.info(f"[MODE] 切换到: {mode}")
                        await self._send({"type": "mode_changed", "mode": mode})
                    else:
                        await self._send_error(f"未知模式: {mode}")
                elif msg_type == "switch_model":
                    model = msg.get("model", "")
                    # 保存到配置
                    config = UserConfig.load()
                    config["selected_model"] = model
                    UserConfig.save(config)
                    logger.info(f"[MODEL] 切换到: {model}")
                    await self._send({"type": "model_changed", "model": model})
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

        agent = self.agents.get(self.current_mode)
        if not agent:
            await self._send_error(f"Agent 未加载: {self.current_mode}")
            return

        logger.info(f"[CHAT] 用户 ({self.current_mode}): {content[:50]}")

        # 添加用户消息到历史
        user_msg = HumanMessage(content=content)
        self.history.append(user_msg)

        # 获取终端上下文
        terminal_output = get_terminal_context_raw(50)
        if terminal_output:
            # 清理 ANSI 转义序列
            ansi_escape = re.compile(
                r"\x1b\[[\?0-9;]*[A-Za-z]"
                r"|\x1b\].*?(?:\x07|\x1b\\)"
                r"|\x1b[()][AB012]"
                r"|\x1b[78]"
                r"|\x1b[=>]"
            )
            terminal_output = ansi_escape.sub("", terminal_output)
            terminal_output = "".join(c for c in terminal_output if c.isprintable() or c in "\n\t")
            if len(terminal_output) > 4000:
                terminal_output = "...(省略前面内容)...\n" + terminal_output[-4000:]
            logger.debug(f"[CHAT] 终端上下文: {len(terminal_output)} 字符")

        # 构建消息：历史 + 当前用户消息
        # 注意：history 已包含当前用户消息，所以直接使用
        messages = list(self.history)

        # 初始状态
        state: AgentState = {
            "messages": messages,
            "terminal_output": terminal_output,
            "analysis_result": "",
            "llm_calls": 0,
            "waiting_user": False,
        }

        # 发送开始标记
        await self._send({"type": "start"})

        # 流式处理
        collected_content = ""
        try:
            async for event in agent.astream_events(state, version="v2"):
                event_type = event.get("event", "")

                # LLM 流式输出
                if event_type == "on_chat_model_stream":
                    chunk = event.get("data", {}).get("chunk")
                    if chunk and hasattr(chunk, "content"):
                        token = chunk.content
                        # Anthropic 返回 list[dict]，需要转换
                        if isinstance(token, list):
                            token = "".join(t.get("text", "") if isinstance(t, dict) else str(t) for t in token)
                        if token:
                            collected_content += token
                            await self._send({"type": "token", "content": token})

                # 工具调用
                elif event_type == "on_tool_start":
                    tool_name = event.get("name", "unknown")
                    # LangGraph 的参数在 data.input 中
                    tool_args = event.get("data", {}).get("input", {})
                    logger.debug(f"[TOOL_START] {tool_name}, args: {tool_args}")
                    await self._send({
                        "type": "tool_start",
                        "tool": tool_name,
                        "args": tool_args
                    })

                elif event_type == "on_tool_end":
                    tool_name = event.get("name", "unknown")
                    tool_result = event.get("data", {}).get("output", "")
                    # 截断过长的结果
                    if isinstance(tool_result, str) and len(tool_result) > 500:
                        tool_result = tool_result[:500] + "...(已截断)"
                    await self._send({
                        "type": "tool_end",
                        "tool": tool_name,
                        "result": tool_result
                    })

            # 添加 AI 回复到历史
            if collected_content:
                self.history.append(AIMessage(content=collected_content))

            # 发送结束标记
            await self._send({
                "type": "end",
                "content": collected_content
            })

        except Exception as e:
            # 出错时移除已添加的用户消息
            if self.history and self.history[-1] == user_msg:
                self.history.pop()
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
