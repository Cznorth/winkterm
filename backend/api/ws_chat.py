"""侧边栏 AI 对话 WebSocket 处理器。"""

from __future__ import annotations

import asyncio
import json
import logging
import re
from typing import TYPE_CHECKING

from fastapi import WebSocket, WebSocketDisconnect
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage

from backend.agent.factory import get_agent
from backend.agent.core.state import AgentState
from backend.agent.tools.terminal_legacy import get_terminal_context_raw
from backend.config import UserConfig, settings
from backend.utils.token_utils import count_tokens, count_history_tokens, fetch_model_context_length

if TYPE_CHECKING:
    from langgraph.graph import CompiledGraph

logger = logging.getLogger("ws_chat")


class ChatWSHandler:
    """侧边栏对话 WebSocket 处理器，支持多种模式。"""

    def __init__(self, websocket: WebSocket):
        self.ws = websocket
        self.agents: dict[str, CompiledGraph] = {}
        self.current_mode = "craft"  # 默认 craft 模式
        # 按 conv_id 隔离会话状态
        self.histories: dict[str, list[HumanMessage | AIMessage]] = {}
        self.tokens: dict[str, dict[str, int]] = {}  # conv_id -> {input, output}
        self._stop_requested = False  # 停止生成标志
        self._current_task: asyncio.Task | None = None  # 当前处理任务

    def _get_history(self, conv_id: str) -> list[HumanMessage | AIMessage]:
        if conv_id not in self.histories:
            self.histories[conv_id] = []
        return self.histories[conv_id]

    def _get_tokens(self, conv_id: str) -> dict[str, int]:
        if conv_id not in self.tokens:
            self.tokens[conv_id] = {"input": 0, "output": 0}
        return self.tokens[conv_id]

    async def handle(self) -> None:
        await self.ws.accept()
        logger.info("[ACCEPT] Chat WebSocket 已连接")

        # 发送当前模型
        config = UserConfig.load()
        current_model = config.get("selected_model", "")
        if current_model:
            await self._send({"type": "model_changed", "model": current_model})

        # 初始无 conv 上下文，不发 usage（前端切到具体 conv 时按需获取）

        # 预加载常用 agent
        try:
            self.agents["chat"] = get_agent("chat", lang="en")
            self.agents["craft"] = get_agent("craft", lang="en")
            logger.info(f"[AGENT] Loaded: {list(self.agents.keys())}")
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
                    conv_id = msg.get("conv_id", "")
                    if not conv_id:
                        await self._send_error("缺少 conv_id")
                        continue
                    # 将处理放入独立任务，支持中断
                    self._current_task = asyncio.create_task(
                        self._handle_chat(msg.get("content", ""), conv_id)
                    )
                elif msg_type == "stop":
                    # 停止生成
                    self._stop_requested = True
                    if self._current_task:
                        self._current_task.cancel()
                    logger.info("[STOP] 用户请求停止")
                elif msg_type == "delete_conv":
                    conv_id = msg.get("conv_id", "")
                    if conv_id:
                        self.histories.pop(conv_id, None)
                        self.tokens.pop(conv_id, None)
                        logger.info(f"[DELETE] 会话 {conv_id} 已删除")
                elif msg_type == "get_usage":
                    conv_id = msg.get("conv_id", "")
                    if conv_id:
                        await self._send_usage(conv_id)
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
                    # 切换模型不重发 usage，前端按需 get_usage
                else:
                    logger.warning(f"[MSG] 未知消息类型: {msg_type}")

        except WebSocketDisconnect:
            logger.info("[DISCONNECT] 客户端断开")
        except Exception as e:
            logger.exception(f"[ERROR] {e}")
        finally:
            logger.info("[CLEANUP] Chat WebSocket 关闭")

    async def _handle_chat(self, content: str, conv_id: str) -> None:
        """处理对话消息，流式输出。"""
        if not content.strip():
            return

        # 重置停止标志
        self._stop_requested = False

        agent = self.agents.get(self.current_mode)
        if not agent:
            await self._send_error(f"Agent 未加载: {self.current_mode}")
            return

        logger.info(f"[CHAT] 用户 ({self.current_mode}, conv={conv_id}): {content[:50]}")

        history = self._get_history(conv_id)
        # 添加用户消息到历史
        user_msg = HumanMessage(content=content)
        history.append(user_msg)

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
        messages = list(history)

        # 初始状态
        state: AgentState = {
            "messages": messages,
            "terminal_output": terminal_output,
            "analysis_result": "",
            "llm_calls": 0,
            "waiting_user": False,
        }

        # 发送开始标记
        await self._send({"type": "start", "conv_id": conv_id})

        # 流式处理
        collected_content = ""
        config = {"recursion_limit": settings.agent_recursion_limit}
        try:
            async for event in agent.astream_events(state, config=config, version="v2"):
                # 检查停止标志
                if self._stop_requested:
                    logger.info("[CHAT] 用户请求停止")
                    await self._send({"type": "stopped"})
                    break

                event_type = event.get("event", "")

                # LLM 流式输出
                if event_type == "on_chat_model_stream":
                    chunk = event.get("data", {}).get("chunk")
                    if chunk and hasattr(chunk, "content"):
                        content = chunk.content
                        # content 可能是 string 或 list[dict]
                        if isinstance(content, str):
                            if content:
                                collected_content += content
                                await self._send({"type": "token", "content": content})
                        elif isinstance(content, list):
                            # 解析内容块，提取 thinking 和 text
                            for part in content:
                                if isinstance(part, dict):
                                    part_type = part.get("type", "text")
                                    if part_type == "thinking":
                                        thinking_text = part.get("thinking", "")
                                        if thinking_text:
                                            await self._send({"type": "thinking", "content": thinking_text})
                                    elif part_type == "text":
                                        text = part.get("text", "")
                                        if text:
                                            collected_content += text
                                            await self._send({"type": "token", "content": text})
                                    else:
                                        # 其他类型尝试提取 text 或 content
                                        text = part.get("text", "") or part.get("content", "")
                                        if text:
                                            collected_content += text
                                            await self._send({"type": "token", "content": text})
                                elif isinstance(part, str) and part:
                                    collected_content += part
                                    await self._send({"type": "token", "content": part})

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
                    raw = event.get("data", {}).get("output", "")
                    # output 可能是 ToolMessage / dict / str,统一序列化成字符串
                    if hasattr(raw, "content"):
                        tool_result = raw.content
                    elif isinstance(raw, (dict, list)):
                        try:
                            tool_result = json.dumps(raw, ensure_ascii=False, default=str)
                        except Exception:
                            tool_result = str(raw)
                    else:
                        tool_result = str(raw) if raw is not None else ""
                    if isinstance(tool_result, str) and len(tool_result) > 5000:
                        tool_result = tool_result[:5000] + "...(已截断)"
                    logger.debug(f"[TOOL_END] {tool_name}, result_len={len(tool_result) if isinstance(tool_result, str) else 'n/a'}")
                    await self._send({
                        "type": "tool_end",
                        "tool": tool_name,
                        "result": tool_result
                    })

            # 正常结束：添加 AI 回复到历史
            if collected_content and not self._stop_requested:
                history.append(AIMessage(content=collected_content))

            # 用 tiktoken 计算 token 用量
            tok = self._get_tokens(conv_id)
            tok["input"] = count_history_tokens(history)
            tok["output"] += count_tokens(collected_content)
            logger.info(
                f"[CHAT] conv={conv_id} token 用量: 输入={tok['input']}, "
                f"输出={tok['output']}"
            )
            await self._send_usage(conv_id)

            # 发送结束标记
            if self._stop_requested:
                await self._send({"type": "stopped"})
            else:
                await self._send({
                    "type": "end",
                    "content": collected_content,
                    "conv_id": conv_id,
                })

        except asyncio.CancelledError:
            # 被取消
            logger.info("[CHAT] 已取消")
            await self._send({"type": "stopped"})

        except Exception as e:
            # 出错时移除已添加的用户消息
            if history and history[-1] == user_msg:
                history.pop()
            logger.exception(f"[CHAT] 处理失败: {e}")
            await self._send_error(str(e))

        finally:
            self._current_task = None

    async def _send(self, data: dict) -> None:
        """发送 JSON 消息。"""
        try:
            await self.ws.send_text(json.dumps(data, ensure_ascii=False))
        except Exception as e:
            logger.warning(f"[SEND] 发送失败: {e}")

    async def _send_error(self, message: str) -> None:
        """发送错误消息。"""
        await self._send({"type": "error", "message": message})

    async def _send_usage(self, conv_id: str) -> None:
        """发送 token 使用量信息。"""
        config = UserConfig.load()
        current_model = config.get("selected_model", "")
        max_context = 200000
        if current_model:
            ctx = await fetch_model_context_length(current_model)
            if ctx:
                max_context = ctx
        tok = self._get_tokens(conv_id)
        await self._send({
            "type": "usage",
            "conv_id": conv_id,
            "input_tokens": tok["input"],
            "output_tokens": tok["output"],
            "max_context": max_context,
        })
