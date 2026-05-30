"""Sidebar AI chat WebSocket handler."""

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
from backend.agent.core.approval import cancel_all as cancel_all_approvals, resolve_approval
from backend.agent.core.state import AgentState
from backend.agent.tools.terminal_legacy import get_terminal_context_raw
from backend.api import chat_store
from backend.config import UserConfig, settings
from backend.utils.token_utils import count_tokens, count_history_tokens, fetch_model_context_length

if TYPE_CHECKING:
    from langgraph.graph import CompiledGraph

logger = logging.getLogger("ws_chat")


# ---------------------------------------------------------------------------
# Module-level in-flight generation state: lets a WS reconnect (user refreshing the page) reuse an unfinished agent stream
# ---------------------------------------------------------------------------

_active_streams: dict[str, dict[str, Any]] = {}
_streams_lock = threading.Lock()


def _new_stream_state(conv_id: str) -> dict[str, Any]:
    return {
        "conv_id": conv_id,
        "content": "",          # accumulated text (incl. token stream)
        "thinking": "",
        "blocks": [],           # list of contentBlocks (text + tool blocks)
        "subscribers": [],      # list[async send(msg)] functions
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
    """Asynchronously push a message to all subscribers, silently dropping failures."""
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
    """Sidebar chat WebSocket handler, supporting multiple modes."""

    def __init__(self, websocket: WebSocket):
        self.ws = websocket
        self.agents: dict[str, CompiledGraph] = {}
        self.current_mode = "craft"  # default craft mode
        self._stop_requested = False  # stop-generation flag
        self._current_task: asyncio.Task | None = None  # current processing task

    @staticmethod
    def _history_to_langchain(messages: list[dict]) -> list[HumanMessage | AIMessage]:
        """Convert dict messages from store → list of langchain Messages (for the agent).
        UI fields like contentBlocks/thinking are ignored; only role + content are kept."""
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

        # Send the current model
        config = UserConfig.load()
        current_model = config.get("selected_model", "")
        if current_model:
            await self._send({"type": "model_changed", "model": current_model})

        # No conv context initially, so don't send usage (frontend fetches on demand when switching to a specific conv)

        # Preload common agents
        try:
            self.agents["chat"] = get_agent("chat", lang="en")
            self.agents["craft"] = get_agent("craft", lang="en")
            logger.info(f"[AGENT] Loaded: {list(self.agents.keys())}")
        except Exception as e:
            logger.error(f"[AGENT] 加载失败: {e}")
            await self._send_error("Agent 加载失败")
            return

        # Check for an in-flight agent stream (a conversation from before the refresh), subscribe and send the current progress
        await self._resume_active_streams()

        try:
            while True:
                # Receive a message
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
                    # Run handling in a separate task to support interruption
                    self._current_task = asyncio.create_task(
                        self._handle_chat(msg.get("content", ""), conv_id)
                    )
                elif msg_type == "stop":
                    # Stop generation
                    self._stop_requested = True
                    cancel_all_approvals()  # release any tool node waiting on approval
                    if self._current_task:
                        self._current_task.cancel()
                    logger.info("[STOP] 用户请求停止")
                elif msg_type == "tool_decision":
                    # ask mode: user's approve/deny for a specific tool call
                    approval_id = msg.get("approval_id", "")
                    approved = bool(msg.get("approved"))
                    if approval_id:
                        hit = resolve_approval(approval_id, approved)
                        logger.info(
                            f"[APPROVAL] decision id={approval_id} "
                            f"approved={approved} hit={hit}"
                        )
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
                    # ask mode is not a standalone agent: reuse craft's toolset + confirm before running
                    if mode in self.agents or mode == "ask":
                        self.current_mode = mode
                        logger.info(f"[MODE] 切换到: {mode}")
                        await self._send({"type": "mode_changed", "mode": mode})
                    else:
                        await self._send_error(f"未知模式: {mode}")
                elif msg_type == "switch_model":
                    model = msg.get("model", "")
                    # Save to config
                    config = UserConfig.load()
                    config["selected_model"] = model
                    UserConfig.save(config)
                    logger.info(f"[MODEL] 切换到: {model}")
                    await self._send({"type": "model_changed", "model": model})
                    # Switching model doesn't resend usage; frontend calls get_usage on demand
                else:
                    logger.warning(f"[MSG] 未知消息类型: {msg_type}")

        except WebSocketDisconnect:
            logger.info("[DISCONNECT] 客户端断开")
        except Exception as e:
            logger.exception(f"[ERROR] {e}")
        finally:
            # release any tool node still waiting on approval, so the task doesn't hang
            cancel_all_approvals()
            logger.info("[CLEANUP] Chat WebSocket 关闭")

    async def _resume_active_streams(self) -> None:
        """When the WS just connects, if there's an in-flight agent stream (a conversation
        from before the refresh), subscribe to it and send this WS the start + already-generated content + register for subsequent tokens."""
        for conv_id in _list_active_conv_ids():
            stream = _get_stream(conv_id)
            if not stream:
                continue
            logger.info(f"[RESUME] conv={conv_id} 接管 in-flight 流, 当前长度={len(stream['content'])}")
            await self._send({"type": "start", "conv_id": conv_id})
            if stream["thinking"]:
                await self._send({"type": "thinking", "content": stream["thinking"]})
            # Push already-accumulated content to this WS (frontend renders by accumulating tokens)
            if stream["content"]:
                await self._send({"type": "token", "content": stream["content"]})
            # Also push already-done tool blocks (paired as tool_start + tool_end)
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
            # Subscribe so subsequent tokens are automatically pushed to this WS
            _add_subscriber(conv_id, self._send)

    async def _handle_chat(self, content: str, conv_id: str) -> None:
        """Handle a chat message, streaming the output."""
        if not content.strip():
            return

        # Reject if the same conv already has an in-flight stream, to avoid double-generation crosstalk
        if _get_stream(conv_id) is not None:
            await self._send_error(f"会话 {conv_id} 已有生成进行中,请等待完成")
            return

        # Save the original user input (content below is overwritten by chunk.content in the stream loop)
        user_input = content

        # Reset the stop flag
        self._stop_requested = False

        # ask mode reuses craft's full toolset, but confirms each tool before running
        ask_mode = self.current_mode == "ask"
        agent_key = "craft" if ask_mode else self.current_mode
        agent = self.agents.get(agent_key)
        if not agent:
            await self._send_error(f"Agent 未加载: {agent_key}")
            return

        logger.info(f"[CHAT] 用户 ({self.current_mode}, conv={conv_id}): {user_input[:50]}")

        # Write the user message to the store
        user_dict = {"role": "user", "content": user_input, "timestamp": time.time()}
        chat_store.append_message(conv_id, user_dict)
        history = self._history_to_langchain(
            chat_store.get_conversation(conv_id).get("messages", [])
        )

        # Register the in-flight stream and add this WS as a subscriber
        stream = _new_stream_state(conv_id)
        with _streams_lock:
            _active_streams[conv_id] = stream
        _add_subscriber(conv_id, self._send)

        # Get the terminal context
        terminal_output = get_terminal_context_raw(50)
        if terminal_output:
            # Strip ANSI escape sequences
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

        # Build messages: history + the current user message
        messages = list(history)

        # ask-mode approval broadcast: push tool_approval to all subscribers of this conv
        async def _approval_emit(msg: dict) -> None:
            await _broadcast(conv_id, msg)

        # Initial state
        state: AgentState = {
            "messages": messages,
            "terminal_output": terminal_output,
            "analysis_result": "",
            "llm_calls": 0,
            "waiting_user": False,
            "ask_mode": ask_mode,
            "approval_emit": _approval_emit if ask_mode else None,
        }

        # Send the start marker (broadcast to all subscribers)
        await _broadcast(conv_id, {"type": "start", "conv_id": conv_id})

        # Stream processing
        collected_content = ""
        last_persist_len = 0
        config = {"recursion_limit": settings.agent_recursion_limit}

        async def _on_text(text: str) -> None:
            """Accumulate text + push to subscribers + incremental persistence (flush memory once per >=200 chars)."""
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
                # Check the stop flag
                if self._stop_requested:
                    logger.info("[CHAT] 用户请求停止")
                    await _broadcast(conv_id, {"type": "stopped"})
                    break

                event_type = event.get("event", "")

                # LLM streaming output
                if event_type == "on_chat_model_stream":
                    chunk = event.get("data", {}).get("chunk")
                    if chunk and hasattr(chunk, "content"):
                        content = chunk.content
                        # content may be a string or list[dict]
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

                # Tool call
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

            # Normal end: add the AI reply to the store
            if collected_content and not self._stop_requested:
                history.append(AIMessage(content=collected_content))
                # Replace the last assistant placeholder from the stream with the final content
                chat_store.update_last_assistant(
                    conv_id, collected_content, flush_disk=True
                )

            # Compute token usage with tiktoken
            conv = chat_store.get_conversation(conv_id)
            new_input = count_history_tokens(history)
            new_output = conv.get("output_tokens", 0) + count_tokens(collected_content)
            chat_store.update_tokens(conv_id, new_input, new_output)
            logger.info(
                f"[CHAT] conv={conv_id} token 用量: 输入={new_input}, 输出={new_output}"
            )
            await self._send_usage(conv_id)

            # Send the end marker (broadcast)
            if self._stop_requested:
                await _broadcast(conv_id, {"type": "stopped"})
            else:
                await _broadcast(conv_id, {
                    "type": "end",
                    "content": collected_content,
                    "conv_id": conv_id,
                })

        except asyncio.CancelledError:
            # Cancelled (a ws_handler instance exiting due to refresh won't cancel the task;
            # this is mainly the explicit /stop cancellation path). Persist generated content, then exit.
            logger.info("[CHAT] 已取消")
            if collected_content:
                chat_store.update_last_assistant(conv_id, collected_content, flush_disk=True)
            await _broadcast(conv_id, {"type": "stopped"})

        except Exception as e:
            # On error, remove the already-added user message (from the store)
            conv = chat_store.get_conversation(conv_id)
            msgs = conv.get("messages", [])
            if msgs and msgs[-1].get("role") == "user" and msgs[-1].get("content") == user_input:
                chat_store.set_messages(conv_id, msgs[:-1])
            logger.exception(f"[CHAT] 处理失败: {e}")
            await self._send_error(str(e))

        finally:
            self._current_task = None
            # Clean up in-flight stream state
            with _streams_lock:
                _active_streams.pop(conv_id, None)

    async def _send(self, data: dict) -> None:
        """Send a JSON message."""
        try:
            await self.ws.send_text(json.dumps(data, ensure_ascii=False))
        except Exception as e:
            logger.warning(f"[SEND] 发送失败: {e}")

    async def _send_error(self, message: str) -> None:
        """Send an error message."""
        await self._send({"type": "error", "message": message})

    async def _send_usage(self, conv_id: str) -> None:
        """Send token usage information."""
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
