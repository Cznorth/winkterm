from __future__ import annotations

import logging
from typing import Literal

from langchain_openai import ChatOpenAI
from langchain_core.messages import AIMessage, SystemMessage, ToolMessage
from langgraph.graph import END, StateGraph

from backend.agent.state import AgentState
from backend.agent.prompts import SYSTEM_PROMPT
from backend.agent.tools import ALL_TOOLS
from backend.config import settings

logger = logging.getLogger("agent.graph")

# ---------------------------------------------------------------------------
# LLM 初始化
# ---------------------------------------------------------------------------

def _build_llm() -> ChatOpenAI:
    llm = ChatOpenAI(
        model=settings.llm_model,
        temperature=0,
        api_key=settings.llm_api_key,
        base_url=settings.llm_base_url,
    )
    bound = llm.bind_tools(ALL_TOOLS)
    logger.debug(f"[LLM] 绑定工具: {[t.name for t in ALL_TOOLS]}")
    return bound


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

    # 日志：响应内容
    logger.debug(f"[LLM] 响应内容: {response.content[:200] if response.content else '空'}")
    logger.debug(f"[LLM] tool_calls: {response.tool_calls}")
    logger.debug(f"[LLM] additional_kwargs: {response.additional_kwargs}")

    return {
        **state,
        "messages": [response],
        "llm_calls": state.get("llm_calls", 0) + 1,
    }


# ---------------------------------------------------------------------------
# 条件路由
# ---------------------------------------------------------------------------

def should_continue(state: AgentState) -> Literal["tool_node", "__end__"]:
    """判断最后一条消息是否包含工具调用，或是否需要等待用户。"""
    # 如果已在等待用户，直接结束
    if state.get("waiting_user"):
        logger.debug("[ROUTER] waiting_user=True, 结束")
        return END

    last = state["messages"][-1]
    has_tools = isinstance(last, AIMessage) and last.tool_calls
    logger.debug(f"[ROUTER] last type: {type(last).__name__}, has_tools: {has_tools}")

    if has_tools:
        logger.debug(f"[ROUTER] 进入 tool_node, tools: {[tc['name'] for tc in last.tool_calls]}")
        return "tool_node"
    logger.debug("[ROUTER] 无工具调用, 结束")
    return END


# ---------------------------------------------------------------------------
# 自定义 Tool Node
# ---------------------------------------------------------------------------

async def tool_node(state: AgentState) -> AgentState:
    """执行工具调用，检测 write_command 后设置等待用户标志。"""
    from langchain_core.messages import ToolMessage

    last = state["messages"][-1]
    if not isinstance(last, AIMessage) or not last.tool_calls:
        logger.warning("[TOOL_NODE] 无工具调用")
        return state

    # 执行所有工具调用
    new_messages = []
    waiting_user = False

    for tool_call in last.tool_calls:
        tool_name = tool_call["name"]
        tool_args = tool_call.get("args", {})
        tool_call_id = tool_call.get("id", "")

        logger.info(f"[TOOL_NODE] 执行工具: {tool_name}, args: {tool_args}")

        # 查找并执行工具
        tool_func = None
        for t in ALL_TOOLS:
            if t.name == tool_name:
                tool_func = t
                break

        if tool_func is None:
            result = f"工具 {tool_name} 不存在"
            logger.error(f"[TOOL_NODE] {result}")
        else:
            try:
                result = tool_func.invoke(tool_args)
                logger.info(f"[TOOL_NODE] 结果: {result}")
            except Exception as e:
                result = f"工具执行错误: {e}"
                logger.exception(f"[TOOL_NODE] 执行失败: {e}")

        new_messages.append(ToolMessage(content=result, tool_call_id=tool_call_id))

        # 检测 write_command 被调用
        if tool_name == "write_command":
            waiting_user = True
            logger.info("[TOOL_NODE] write_command 已调用，设置 waiting_user=True")

    return {
        **state,
        "messages": new_messages,
        "waiting_user": waiting_user,
    }


# ---------------------------------------------------------------------------
# 条件路由（tool_node 后）
# ---------------------------------------------------------------------------

def should_continue_after_tool(state: AgentState) -> Literal["llm_call", "__end__"]:
    """工具执行后判断是否继续。"""
    if state.get("waiting_user"):
        logger.debug("[ROUTER] waiting_user=True, 工具执行后结束")
        return END
    return "llm_call"


# ---------------------------------------------------------------------------
# 图构建
# ---------------------------------------------------------------------------

def build_graph() -> StateGraph:
    graph = StateGraph(AgentState)
    graph.add_node("llm_call", llm_call)
    graph.add_node("tool_node", tool_node)

    graph.set_entry_point("llm_call")

    graph.add_conditional_edges(
        "llm_call",
        should_continue,
        {"tool_node": "tool_node", END: END},
    )
    # tool_node 后也走条件路由，检查是否需要继续
    graph.add_conditional_edges(
        "tool_node",
        should_continue_after_tool,
        {"llm_call": "llm_call", END: END},
    )

    return graph.compile()


# 单例，避免重复编译
_graph = None


def get_graph():
    global _graph
    if _graph is None:
        _graph = build_graph()
    return _graph
