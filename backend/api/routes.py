from __future__ import annotations

from datetime import datetime
from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel
from langchain_core.messages import HumanMessage

from backend.agent.graph import get_graph
from backend.agent.tools.terminal import get_terminal_context_raw

router = APIRouter()

# 内存中保存分析历史（生产应持久化到数据库）
_analysis_history: list[dict[str, Any]] = []


class AnalyzeRequest(BaseModel):
    message: str
    terminal_context: str = ""


class AnalyzeResponse(BaseModel):
    result: str
    timestamp: str


@router.get("/history")
async def get_history() -> dict[str, Any]:
    """获取分析历史记录。"""
    return {"history": list(reversed(_analysis_history)), "total": len(_analysis_history)}
