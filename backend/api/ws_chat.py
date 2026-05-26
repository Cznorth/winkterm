"""侧边栏 AI 对话 WebSocket 处理器。"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import threading
import time
from typing import TYPE_CHECKING, Any, Callable, Awaitable

from fastapi import WebSocket, WebSocketDisconnect
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage

from backend.agent.factory import get_agent
from backend.agent.core.state import AgentState
from backend.agent.tools.terminal_legacy import get_terminal_context_raw
from backend.api import chat_store
from backend.config import UserConfig, settings
from backend.utils.token_utils import count_tokens, count_history_tokens, fetch_model_context_length

if TYPE_CHECKING:
    from langgraph.graph import CompiledGraph

logger = logging.getLogger("ws_chat")


# ---------------------------------------------------------------------------
# 模块级 in-flight 生成状态: 让 WS 重连(用户刷新页面)能复用未完成的 agent 流
# ---------------------------------------------------------------------------

_active_streams: dict[str, dict[str, Any]] = {}
_streams_lock = threading.Lock()


def _new_stream_state(conv_id: str) -> dict[str, Any]:
    return {
        "conv_id": conv_id,
        "content": "",          # 累积文本(含 token 流)
        "thinking": "",
        "blocks": [],           # contentBlocks 列表(text + tool 块)
        "subscribers": [],      # list[async send(msg)] 函数
        "started_at": time.time(),
    }


def _get_stream(conv_id: str) -> dict[str, Any] | None:
    with _streams_lock:
        return _active_streams.get(conv_id)


def _list_active_conv_ids() -> list[str]:
    with _streams_lock:
        return list(_active_streams.keys())


def _add_subscriber(conv_id: str, send: Callable[[dict], Awaitable[None]]) -> dict[str, Any] | None:
    with _streams_lock:
        s = _active_streams.get(conv_id)
        if s is not None:
            s["subscribers"].append(send)
        return s


def _remove_subscriber(conv_id: str, send: Callable[[dict], Awaitable[None]]) -> None:
    with _streams_lock:
        s = _active_streams.get(conv_id)
        if s and send in s["subscribers"]:
            s["subscribers"].remove(send)


async def _broadcast(conv_id: str, msg: dict) -> None:
    """异步把消息推给所有订阅者,失败的静默移除。"""
    with _streams_lock:
        s = _active_streams.get(conv_id)
        if not s:
            return
        subs = list(s["subscribers"])
    dead: list[Callable] = []
    for sub in subs:
        try:
            await sub(msg)
        except Exception:
            dead.append(sub)
    if dead:
        with _streams_lock:
            s = _active_streams.get(conv_id)
            if s:
                s["subscribers"] = [x for x in s["subscribers"] if x not in dead]


class ChatWSHandler:
    """侧边栏对话 WebSocket 处理器，支持多种模式。"""

    def __init__(self, websocket: WebSocket):
        self.ws = websocket
        self.agents: dict[str, CompiledGraph] = {}
        self.current_mode = "craft"  # 默认 craft 模式
        self._stop_requested = False  # 停止生成标志
        self._current_task: asyncio.Task | None = None  # 当前处理任务

    @staticmethod
    def _history_to_langchain(messages: list[dict]) -> list[HumanMessage | AIMessage]:
        """store 里的 dict 消息 → langchain Message 列表 (供 agent 用)。
        contentBlocks/thinking 等 UI 字段忽略,只取 role + content。"""
        out: list[HumanMessage | AIMessage] = []
        for m in messages:
            role = m.get("role")
            content = m.get("content", "")
            if not content:
                continue
            if role == "user":
                out.append(HumanMessage(content=content))
            elif role == "assistant":
                out.append(AIMessage(content=content))
        return out

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

        # 检查是否有正在进行中的 agent 流(用户刷新前的对话),订阅并下发当前进度
        await self._resume_active_streams()

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
                        chat_store.delete_conversation(conv_id)
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

    async def _resume_active_streams(self) -> None:
        """WS 刚连上时若有正在进行的 agent 流(用户刷新前的对话),订阅之并
        给本 WS 下发 start + 当前已生成内容 + 注册后续 token。"""
        for conv_id in _list_active_conv_ids():
            stream = _get_stream(conv_id)
            if not stream:
                continue
            logger.info(f"[RESUME] conv={conv_id} 接管 in-flight 流, 当前长度={len(stream['content'])}")
            await self._send({"type": "start", "conv_id": conv_id})
            if stream["thinking"]:
                await self._send({"type": "thinking", "content": stream["thinking"]})
            # 推送已累积内容到本 WS(前端按 token 累加渲染)
            if stream["content"]:
                await self._send({"type": "token", "content": stream["content"]})
            # 也推送已经 done 的 tool 块(用 tool_start + tool_end 配对)
            for block in stream.get("blocks", []):
                if block.get("type") == "tool":
                    tc = block.get("toolCall", {})
                    await self._send({
                        "type": "tool_start",
                        "tool": tc.get("tool"),
                        "args": tc.get("args", {}),
                    })
                    if tc.get("status") == "done":
                        await self._send({
                            "type": "tool_end",
                            "tool": tc.get("tool"),
                            "result": tc.get("result", ""),
                        })
            # 加入订阅,后续 token 自动推到本 WS
            _add_subscriber(conv_id, self._send)

    async def _handle_chat(self, content: str, conv_id: str) -> None:
        """处理对话消息，流式输出。"""
        if not content.strip():
            return

        # 同一 conv 已有 in-flight 流就拒绝,避免双重生成串台
        if _get_stream(conv_id) is not None:
            await self._send_error(f"会话 {conv_id} 已有生成进行中,请等待完成")
            return

        # 保存原始用户输入(下方 stream 循环里 content 会被 chunk.content 覆盖)
        user_input = content

        # 重置停止标志
        self._stop_requested = False

        agent = self.agents.get(self.current_mode)
        if not agent:
            await self._send_error(f"Agent 未加载: {self.current_mode}")
            return

        logger.info(f"[CHAT] 用户 ({self.current_mode}, conv={conv_id}): {user_input[:50]}")

        # 写入用户消息到 store
        user_dict = {"role": "user", "content": user_input, "timestamp": time.time()}
        chat_store.append_message(conv_id, user_dict)
        history = self._history_to_langchain(
            chat_store.get_conversation(conv_id).get("messages", [])
        )

        # 注册 in-flight 流并把本 WS 加入订阅
        stream = _new_stream_state(conv_id)
        with _streams_lock:
            _active_streams[conv_id] = stream
        _add_subscriber(conv_id, self._send)

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

        # 发送开始标记(广播给所有订阅者)
        await _broadcast(conv_id, {"type": "start", "conv_id": conv_id})

        # 流式处理
        collected_content = ""
        last_persist_len = 0
        config = {"recursion_limit": settings.agent_recursion_limit}

        async def _on_text(text: str) -> None:
            """累计文本 + 推订阅者 + 增量持久化(>=200 字符 flush 一次内存)。"""
            nonlocal collected_content, last_persist_len
            if not text:
                return
            collected_content += text
            stream["content"] = collected_content
            await _broadcast(conv_id, {"type": "token", "content": text})
            if len(collected_content) - last_persist_len >= 200:
                chat_store.update_last_assistant(conv_id, collected_content, flush_disk=False)
                last_persist_len = len(collected_content)

        try:
            async for event in agent.astream_events(state, config=config, version="v2"):
                # 检查停止标志
                if self._stop_requested:
                    logger.info("[CHAT] 用户请求停止")
                    await _broadcast(conv_id, {"type": "stopped"})
                    break

                event_type = event.get("event", "")

                # LLM 流式输出
                if event_type == "on_chat_model_stream":
                    chunk = event.get("data", {}).get("chunk")
                    if chunk and hasattr(chunk, "content"):
                        content = chunk.content
                        # content 可能是 string 或 list[dict]
                        if isinstance(content, str):
                            await _on_text(content)
                        elif isinstance(content, list):
                            for part in content:
                                if isinstance(part, dict):
                                    part_type = part.get("type", "text")
                                    if part_type == "thinking":
                                        thinking_text = part.get("thinking", "")
                                        if thinking_text:
                                            stream["thinking"] += thinking_text
                                            await _broadcast(conv_id, {"type": "thinking", "content": thinking_text})
                                    elif part_type == "text":
                                        await _on_text(part.get("text", ""))
                                    else:
                                        await _on_text(part.get("text", "") or part.get("content", ""))
                                elif isinstance(part, str):
                                    await _on_text(part)

                # 工具调用
                elif event_type == "on_tool_start":
                    tool_name = event.get("name", "unknown")
                    tool_args = event.get("data", {}).get("input", {})
                    logger.debug(f"[TOOL_START] {tool_name}, args: {tool_args}")
                    stream["blocks"].append({
                        "type": "tool",
                        "toolCall": {
                            "tool": tool_name,
                            "args": tool_args,
                            "status": "running",
                        },
                    })
                    await _broadcast(conv_id, {
                        "type": "tool_start",
                        "tool": tool_name,
                        "args": tool_args,
                    })

                elif event_type == "on_tool_end":
                    tool_name = event.get("name", "unknown")
                    raw = event.get("data", {}).get("output", "")
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
                    for b in stream["blocks"]:
                        if (
                            b.get("type") == "tool"
                            and b["toolCall"].get("tool") == tool_name
                            and b["toolCall"].get("status") == "running"
                        ):
                            b["toolCall"]["status"] = "done"
                            b["toolCall"]["result"] = tool_result
                            break
                    await _broadcast(conv_id, {
                        "type": "tool_end",
                        "tool": tool_name,
                        "result": tool_result,
                    })

            # 正常结束：添加 AI 回复到 store
            if collected_content and not self._stop_requested:
                history.append(AIMessage(content=collected_content))
                # 把流过程中已 placeholder 的 last assistant 替换为最终内容
                chat_store.update_last_assistant(
                    conv_id, collected_content, flush_disk=True
                )

            # 用 tiktoken 计算 token 用量
            conv = chat_store.get_conversation(conv_id)
            new_input = count_history_tokens(history)
            new_output = conv.get("output_tokens", 0) + count_tokens(collected_content)
            chat_store.update_tokens(conv_id, new_input, new_output)
            logger.info(
                f"[CHAT] conv={conv_id} token 用量: 输入={new_input}, 输出={new_output}"
            )
            await self._send_usage(conv_id)

            # 发送结束标记(广播)
            if self._stop_requested:
                await _broadcast(conv_id, {"type": "stopped"})
            else:
                await _broadcast(conv_id, {
                    "type": "end",
                    "content": collected_content,
                    "conv_id": conv_id,
                })

        except asyncio.CancelledError:
            # 被取消(刷新引起的本 ws_handler 实例退出不会取消 task,这里主要是
            # /stop 显式取消的路径)。把已生成内容落盘后退出。
            logger.info("[CHAT] 已取消")
            if collected_content:
                chat_store.update_last_assistant(conv_id, collected_content, flush_disk=True)
            await _broadcast(conv_id, {"type": "stopped"})

        except Exception as e:
            # 出错时移除已添加的用户消息(store 里)
            conv = chat_store.get_conversation(conv_id)
            msgs = conv.get("messages", [])
            if msgs and msgs[-1].get("role") == "user" and msgs[-1].get("content") == user_input:
                chat_store.set_messages(conv_id, msgs[:-1])
            logger.exception(f"[CHAT] 处理失败: {e}")
            await self._send_error(str(e))

        finally:
            self._current_task = None
            # 清理 in-flight 流状态
            with _streams_lock:
                _active_streams.pop(conv_id, None)

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
        conv = chat_store.get_conversation(conv_id)
        await self._send({
            "type": "usage",
            "conv_id": conv_id,
            "input_tokens": conv.get("input_tokens", 0),
            "output_tokens": conv.get("output_tokens", 0),
            "max_context": max_context,
        })
