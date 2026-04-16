"""Agent 构建器。"""

from __future__ import annotations

import logging
from typing import Literal, Union

from langchain_core.messages import AIMessage, SystemMessage, ToolMessage
from langchain_openai import ChatOpenAI
from langchain_anthropic import ChatAnthropic
from langgraph.graph import END, StateGraph

from backend.agent.core.state import AgentState
from backend.config import settings, UserConfig

logger = logging.getLogger("agent.builder")


class AgentBuilder:
    """Agent 构建器，负责组装和编译 StateGraph。"""

    def __init__(self, name: str, prompt: str, tools: list, model: str = "default"):
        self.name = name
        self.prompt = prompt
        self.tools = tools
        self.model = model

    def _build_llm(self) -> Union[ChatOpenAI, ChatAnthropic]:
        """构建 LLM 并绑定工具。"""
        # 优先使用用户配置
        user_config = UserConfig.load()
        api_format = user_config.get("api_format", "openai")
        base_url = user_config.get("base_url") or settings.llm_base_url
        api_key = user_config.get("api_key") or settings.llm_api_key
        selected_model = user_config.get("selected_model")

        # 模型优先级: 用户选择 > 配置默认
        model_name = selected_model or (
            settings.llm_model if self.model == "default" else self.model
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
        logger.debug(f"[{self.name}] 绑定工具: {[t.name for t in self.tools]}, 模型: {model_name}, 格式: {api_format}")
        return bound

    async def _llm_call(self, state: AgentState) -> AgentState:
        """LLM 调用节点。"""
        llm = self._build_llm()
        messages = list(state["messages"])

        # 构建系统提示词
        system_content = self.prompt
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
            clean_output = ansi_escape.sub("", terminal_output)
            clean_output = "".join(
                c for c in clean_output if c.isprintable() or c in "\n\t"
            )
            if len(clean_output) > 4000:
                clean_output = "...(省略前面内容)...\n" + clean_output[-4000:]
            system_content += f"\n\n---\n## 当前终端输出\n```\n{clean_output}\n```"

        # 把系统提示词放在最前面
        if not messages or not isinstance(messages[0], SystemMessage):
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
        """判断是否继续执行工具。"""
        if state.get("waiting_user"):
            return END

        last = state["messages"][-1]
        has_tools = isinstance(last, AIMessage) and last.tool_calls

        if has_tools:
            return "tool_node"
        return END

    async def _tool_node(self, state: AgentState) -> AgentState:
        """工具执行节点。"""
        last = state["messages"][-1]
        if not isinstance(last, AIMessage) or not last.tool_calls:
            return state

        new_messages = []
        waiting_user = False

        for tool_call in last.tool_calls:
            tool_name = tool_call["name"]
            tool_args = tool_call.get("args", {})
            tool_call_id = tool_call.get("id", "")

            logger.info(f"[{self.name}] 执行工具: {tool_name}, args: {tool_args}")

            # 查找并执行工具
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

            new_messages.append(ToolMessage(content=result, tool_call_id=tool_call_id))

            # 检测 write_command 被调用
            if tool_name == "write_command":
                waiting_user = True

        return {
            **state,
            "messages": new_messages,
            "waiting_user": waiting_user,
        }

    def _should_continue_after_tool(
        self, state: AgentState
    ) -> Literal["llm_call", "__end__"]:
        """工具执行后判断是否继续。"""
        if state.get("waiting_user"):
            return END
        return "llm_call"

    def build(self) -> StateGraph:
        """构建并编译 StateGraph。"""
        graph = StateGraph(AgentState)

        # 添加节点
        graph.add_node("llm_call", self._llm_call)
        graph.add_node("tool_node", self._tool_node)

        # 设置入口
        graph.set_entry_point("llm_call")

        # 添加边
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
