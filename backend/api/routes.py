from __future__ import annotations

import httpx
from datetime import datetime
from typing import Any, Literal

from fastapi import APIRouter
from pydantic import BaseModel
from langchain_core.messages import HumanMessage

from backend.agent.graph import get_graph
from backend.agent.tools.terminal import get_terminal_context_raw
from backend.config import UserConfig

router = APIRouter()

# 内存中保存分析历史（生产应持久化到数据库）
_analysis_history: list[dict[str, Any]] = []


class AnalyzeRequest(BaseModel):
    message: str
    terminal_context: str = ""


class AnalyzeResponse(BaseModel):
    result: str
    timestamp: str


# === 设置相关 ===
class ModelInfo(BaseModel):
    id: str
    name: str = ""


class SettingsModel(BaseModel):
    api_format: Literal["openai", "anthropic"] = "openai"
    base_url: str = ""
    api_key: str = ""
    models: list[ModelInfo] = []
    selected_model: str = ""


class ModelsRequest(BaseModel):
    base_url: str
    api_key: str
    api_format: Literal["openai", "anthropic"]


@router.get("/settings")
async def get_settings() -> dict:
    """获取配置（API Key 脱敏）"""
    return UserConfig.get_masked()


@router.post("/settings")
async def save_settings(settings: SettingsModel) -> dict:
    """保存配置"""
    data = settings.model_dump()
    # 如果 api_key 是脱敏的（包含 ****），保留原始值
    if data.get("api_key") and "****" in data["api_key"]:
        original = UserConfig.load()
        data["api_key"] = original.get("api_key", "")
    UserConfig.save(data)
    return {"success": True}


@router.post("/models/fetch")
async def fetch_models(req: ModelsRequest) -> dict:
    """从 API 获取可用模型列表"""
    # 如果 api_key 包含 ****，使用配置文件中的原始 key
    api_key = req.api_key
    if "****" in api_key:
        config = UserConfig.load()
        api_key = config.get("api_key", "")

    try:
        url = req.base_url.rstrip("/") + "/models"
        headers = {"Authorization": f"Bearer {api_key}"}

        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(url, headers=headers)
            resp.raise_for_status()
            data = resp.json()

        models = [{"id": m["id"], "name": m.get("id")} for m in data.get("data", [])]
        return {"models": models}
    except Exception as e:
        return {"models": [], "error": str(e)}


# === 历史记录 ===
@router.get("/history")
async def get_history() -> dict[str, Any]:
    """获取分析历史记录。"""
    return {"history": list(reversed(_analysis_history)), "total": len(_analysis_history)}
