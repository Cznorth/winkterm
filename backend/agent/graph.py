from __future__ import annotations

from typing import Literal

from langchain_community.chat_models import MiniMaxChat
from langchain_core.messages import AIMessage, SystemMessage
from langgraph.graph import END, StateGraph
from langgraph.prebuilt import ToolNode

from backend.agent.state import AgentState
from backend.agent.prompts import SYSTEM_PROMPT
from backend.agent.tools import ALL_TOOLS
from backend.config import settings

# ---------------------------------------------------------------------------
# LLM 初始化
# ---------------------------------------------------------------------------

def _build_llm() -> MiniMaxChat:
    return MiniMaxChat(
        model=settings.model_name,
        temperature=0,
        api_key=settings.minimax_api_key,
        base_url=settings.minimax_base_url,
    )
    # 暂时不绑定工具
    # ).bind_tools(ALL_TOOLS)


# ---------------------------------------------------------------------------
# 节点函数
# ---------------------------------------------------------------------------

async def llm_call(state: AgentState) -> AgentState:
    """调用 LLM，注入系统提示词和当前 terminal_output。"""
    llm = _build_llm()

    messages = list(state["messages"])

    # 构建系统提示词，包含终端上下文
    system_content = SYSTEM_PROMPT
    terminal_output = state.get("terminal_output", "")
    if terminal_output:
        # 清理 ANSI 转义序列
        import re
        ansi_escape = re.compile(
            r"\x1b\[[\?0-9;]*[A-Za-z]"
            r"|\x1b\].*?(?:\x07|\x1b\\)"
            r"|\x1b[()][AB012]"
            r"|\x1b[78]"
            r"|\x1b[=>]"
        )
        clean_output = ansi_escape.sub("", terminal_output)
        # 只保留可打印字符
        clean_output = "".join(c for c in clean_output if c.isprintable() or c in "\n\t")
        # 限制长度，避免 token 过多
        if len(clean_output) > 4000:
            clean_output = "...(省略前面内容)...\n" + clean_output[-4000:]
        system_content += f"\n\n---\n## 当前终端输出\n```\n{clean_output}\n```"

    # 把系统提示词放在最前面
    if not messages or not isinstance(messages[0], SystemMessage):
        messages = [SystemMessage(content=system_content)] + messages

    response: AIMessage = await llm.ainvoke(messages)

    return {
        **state,
        "messages": [response],
        "llm_calls": state.get("llm_calls", 0) + 1,
    }


# ---------------------------------------------------------------------------
# 条件路由
# ---------------------------------------------------------------------------

def should_continue(state: AgentState) -> Literal["tool_node", "__end__"]:
    """判断最后一条消息是否包含工具调用。"""
    last = state["messages"][-1]
    if isinstance(last, AIMessage) and last.tool_calls:
        return "tool_node"
    return END


# ---------------------------------------------------------------------------
# 图构建
# ---------------------------------------------------------------------------

def build_graph() -> StateGraph:
    tool_node = ToolNode(ALL_TOOLS)

    graph = StateGraph(AgentState)
    graph.add_node("llm_call", llm_call)
    graph.add_node("tool_node", tool_node)

    graph.set_entry_point("llm_call")

    graph.add_conditional_edges(
        "llm_call",
        should_continue,
        {"tool_node": "tool_node", END: END},
    )
    graph.add_edge("tool_node", "llm_call")

    return graph.compile()


# 单例，避免重复编译
_graph = None


def get_graph():
    global _graph
    if _graph is None:
        _graph = build_graph()
    return _graph
