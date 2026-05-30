"""Agent builder."""

from __future__ import annotations

import json
import logging
from typing import Literal, Union

from langchain_core.messages import AIMessage, SystemMessage, ToolMessage
from langchain_openai import ChatOpenAI
from langchain_anthropic import ChatAnthropic
from langgraph.graph import END, StateGraph

from backend.agent.core.approval import request_approval
from backend.agent.core.state import AgentState
from backend.config import settings, UserConfig
from backend.terminal.session_manager import get_session_manager

logger = logging.getLogger("agent.builder")


def _render_terminal_block(max_terminals: int = 12) -> str:
    """Render the terminal-list system prompt block.

    Injected before every LLM call so the agent sees the full picture without
    first calling list_terminals. When over max_terminals, keep active and
    most-recently-active ones first.
    """
    sm = get_session_manager()
    terminals = sm.list_terminals()
    if not terminals:
        return "\n\n<terminals>\n(当前无终端会话)\n</terminals>"

    # Sort: active first, then most recently active (smaller idle_seconds)
    terminals.sort(
        key=lambda t: (not t.get("is_user_active"), t.get("idle_seconds", 9e9))
    )
    if len(terminals) > max_terminals:
        terminals = terminals[:max_terminals]

    lines = ["<terminals>", "id | type | active | visible | by | idle_s | title | last_cmd"]
    for t in terminals:
        last_cmd = (t.get("last_command") or "").strip().replace("\n", " ")
        if len(last_cmd) > 60:
            last_cmd = last_cmd[:60] + "..."
        title = (t.get("title") or t.get("name") or "").strip()
        if len(title) > 30:
            title = title[:30] + "..."
        active = "Y" if t.get("is_user_active") else "-"
        visible = "Y" if t.get("user_visible") else "-"
        lines.append(
            f"{t['id']} | {t['type']} | {active} | {visible} | "
            f"{t.get('created_by', '?')} | {t.get('idle_seconds', 0)} | "
            f"{title} | {last_cmd}"
        )
    lines.append("</terminals>")
    return "\n\n" + "\n".join(lines)


def _render_user_docs() -> str:
    """Inject user-defined instructions (agents.md) and AI long-term memory (memory.md).

    Re-read every round, so file edits take effect immediately with no restart
    or cache clearing.
    """
    from backend.config import AgentDocs

    out = ""
    instr = AgentDocs.read_agents().strip()
    if instr:
        out += (
            "\n\n<user_instructions>\n"
            "以下是用户自定义的操作指令，你必须严格遵循：\n"
            f"{instr}\n</user_instructions>"
        )
    mem = AgentDocs.read_memory().strip()
    if mem:
        out += (
            "\n\n<memory>\n"
            "以下是你的长期记忆（用户偏好、主机信息、已验证的操作方法等）。"
            "需要记住或修订时，调用 save_memory 工具传入整篇新内容来覆盖更新：\n"
            f"{mem}\n</memory>"
        )
    return out


class AgentBuilder:
    """Agent builder, responsible for assembling and compiling the StateGraph."""

    def __init__(self, name: str, prompt: str, tools: list, model: str = "default"):
        self.name = name
        self.prompt = prompt
        self.tools = tools
        self.model = model

    def _build_llm(self) -> Union[ChatOpenAI, ChatAnthropic]:
        user_config = UserConfig.load()
        api_format = user_config.get("api_format", "openai")
        base_url = user_config.get("base_url") or settings.effective_base_url
        api_key = user_config.get("api_key") or settings.effective_api_key
        selected_model = user_config.get("selected_model")

        model_name = selected_model or (
            settings.effective_model if self.model == "default" else self.model
        )

        if api_format == "anthropic":
            llm = ChatAnthropic(
                model=model_name,
                temperature=0,
                api_key=api_key,
                base_url=base_url.split("/v1")[0] if base_url else None,
            )
        else:
            llm = ChatOpenAI(
                model=model_name,
                temperature=0,
                api_key=api_key,
                base_url=base_url if base_url else None,
            )
        bound = llm.bind_tools(self.tools)
        logger.debug(
            f"[{self.name}] 绑定工具: {[t.name for t in self.tools]}, "
            f"模型: {model_name}, 格式: {api_format}"
        )
        return bound

    async def _llm_call(self, state: AgentState) -> AgentState:
        llm = self._build_llm()
        messages = list(state["messages"])

        # Re-render the system prompt each round (terminal list refreshed live)
        system_content = self.prompt + _render_user_docs() + _render_terminal_block()

        # Lightweight agent (terminal) compat: if state carries the active terminal's raw context, inject it too
        terminal_output = state.get("terminal_output", "")
        if terminal_output:
            import re

            ansi_escape = re.compile(
                r"\x1b\[[\?0-9;]*[A-Za-z]"
                r"|\x1b\].*?(?:\x07|\x1b\\)"
                r"|\x1b[()][AB012]"
                r"|\x1b[78]"
                r"|\x1b[=>]"
            )
            clean = ansi_escape.sub("", terminal_output)
            clean = "".join(c for c in clean if c.isprintable() or c in "\n\t")
            if len(clean) > 4000:
                clean = "...(省略前面内容)...\n" + clean[-4000:]
            system_content += f"\n\n---\n## 当前激活终端输出\n```\n{clean}\n```"

        if messages and isinstance(messages[0], SystemMessage):
            messages = [SystemMessage(content=system_content)] + list(messages[1:])
        else:
            messages = [SystemMessage(content=system_content)] + messages

        response: AIMessage = await llm.ainvoke(messages)

        logger.debug(
            f"[{self.name}] 响应: {response.content[:200] if response.content else '空'}"
        )
        logger.debug(f"[{self.name}] tool_calls: {response.tool_calls}")

        return {
            **state,
            "messages": [response],
            "llm_calls": state.get("llm_calls", 0) + 1,
        }

    def _should_continue(self, state: AgentState) -> Literal["tool_node", "__end__"]:
        if state.get("waiting_user"):
            return END

        last = state["messages"][-1]
        has_tools = isinstance(last, AIMessage) and last.tool_calls

        if has_tools:
            return "tool_node"
        return END

    async def _tool_node(self, state: AgentState) -> AgentState:
        last = state["messages"][-1]
        if not isinstance(last, AIMessage) or not last.tool_calls:
            return state

        new_messages = []
        waiting_user = False

        ask_mode = bool(state.get("ask_mode"))
        approval_emit = state.get("approval_emit")
        denied = False

        for tool_call in last.tool_calls:
            tool_name = tool_call["name"]
            tool_args = tool_call.get("args", {})
            tool_call_id = tool_call.get("id", "")

            # ask mode: get user consent before each tool runs. On a denial,
            # skip the rest of this batch (each tool_call still needs a matching
            # ToolMessage) but DON'T halt — feed the denial back so the model can
            # acknowledge and keep the conversation going.
            if denied:
                new_messages.append(ToolMessage(
                    content="Skipped: the user denied a tool call earlier in this batch.",
                    tool_call_id=tool_call_id,
                ))
                continue

            if ask_mode and approval_emit is not None:
                approved = await request_approval(approval_emit, tool_name, tool_args)
                if not approved:
                    logger.info(f"[{self.name}] user denied tool: {tool_name}")
                    new_messages.append(ToolMessage(
                        content=(
                            "The user denied this tool call. Do not retry it. "
                            "Acknowledge briefly and ask how they'd like to proceed."
                        ),
                        tool_call_id=tool_call_id,
                    ))
                    denied = True
                    continue

            logger.info(f"[{self.name}] 工具: {tool_name}, args: {tool_args}")

            tool_func = None
            for t in self.tools:
                if t.name == tool_name:
                    tool_func = t
                    break

            if tool_func is None:
                result = f"工具 {tool_name} 不存在"
                logger.error(f"[{self.name}] {result}")
            else:
                try:
                    result = await tool_func.ainvoke(tool_args)
                    logger.info(f"[{self.name}] 结果: {result}")
                except Exception as e:
                    result = f"工具执行错误: {e}"
                    logger.exception(f"[{self.name}] 执行失败: {e}")

            # Detect the halt_for_user flag (replaces the old write_command detection)
            if isinstance(result, dict) and result.pop("_halt_for_user", False):
                waiting_user = True
            elif tool_name == "terminal_input" and tool_args.get("halt_for_user"):
                waiting_user = True
            elif tool_name == "write_command":
                # The lightweight terminal agent's write_command always halts mid-way to wait for the user
                waiting_user = True

            # ToolMessage content must be a string
            if not isinstance(result, str):
                try:
                    content_str = json.dumps(result, ensure_ascii=False, default=str)
                except Exception:
                    content_str = str(result)
            else:
                content_str = result

            new_messages.append(ToolMessage(content=content_str, tool_call_id=tool_call_id))

        return {
            **state,
            "messages": new_messages,
            "waiting_user": waiting_user,
        }

    def _should_continue_after_tool(
        self, state: AgentState
    ) -> Literal["llm_call", "__end__"]:
        if state.get("waiting_user"):
            return END
        return "llm_call"

    def build(self) -> StateGraph:
        graph = StateGraph(AgentState)
        graph.add_node("llm_call", self._llm_call)
        graph.add_node("tool_node", self._tool_node)
        graph.set_entry_point("llm_call")
        graph.add_conditional_edges(
            "llm_call",
            self._should_continue,
            {"tool_node": "tool_node", END: END},
        )
        graph.add_conditional_edges(
            "tool_node",
            self._should_continue_after_tool,
            {"llm_call": "llm_call", END: END},
        )
        return graph.compile()
