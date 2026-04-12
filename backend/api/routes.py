from __future__ import annotations

from datetime import datetime
from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel
from langchain_core.messages import HumanMessage

from backend.agent.graph import get_graph
from backend.agent.tools import _pty_manager

router = APIRouter()

# 内存中保存分析历史（生产应持久化到数据库）
_analysis_history: list[dict[str, Any]] = []


class AnalyzeRequest(BaseModel):
    message: str
    terminal_context: str = ""


class AnalyzeResponse(BaseModel):
    result: str
    timestamp: str


@router.post("/analyze", response_model=AnalyzeResponse)
async def analyze(req: AnalyzeRequest) -> AnalyzeResponse:
    """手动触发根因分析。"""
    graph = get_graph()

    terminal_output = req.terminal_context
    if not terminal_output and _pty_manager is not None:
        terminal_output = _pty_manager.get_context()

    initial_state = {
        "messages": [HumanMessage(content=req.message)],
        "terminal_output": terminal_output,
        "analysis_result": "",
        "llm_calls": 0,
    }

    result_state = await graph.ainvoke(initial_state)

    # 提取最后一条 AI 消息作为分析结果
    last_msg = result_state["messages"][-1]
    result_text = getattr(last_msg, "content", str(last_msg))

    record = {
        "message": req.message,
        "result": result_text,
        "timestamp": datetime.now().isoformat(),
    }
    _analysis_history.append(record)

    return AnalyzeResponse(result=result_text, timestamp=record["timestamp"])


@router.get("/history")
async def get_history() -> dict[str, Any]:
    """获取分析历史记录。"""
    return {"history": list(reversed(_analysis_history)), "total": len(_analysis_history)}
