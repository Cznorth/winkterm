from __future__ import annotations

import logging
import webbrowser
import httpx
from datetime import datetime
from typing import Any, Literal

logger = logging.getLogger("routes")

from fastapi import APIRouter
from pydantic import BaseModel
from langchain_core.messages import HumanMessage, SystemMessage
from langchain_openai import ChatOpenAI
from langchain_anthropic import ChatAnthropic

from backend.agent.graph import get_graph
from backend.agent.tools.terminal import get_terminal_context_raw
from backend.config import UserConfig, settings

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
    language: str = ""


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
    UserConfig.merge_save(data)
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
        if req.api_format == "anthropic":
            # ChatAnthropic SDK 会自动加 /v1，所以先去掉用户填的 /v1 再拼
            url = req.base_url.rstrip("/").split("/v1")[0] + "/v1/models"
            headers = {"x-api-key": api_key, "anthropic-version": "2023-06-01"}
        else:
            url = req.base_url.rstrip("/") + "/models"
            headers = {"Authorization": f"Bearer {api_key}"}

        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(url, headers=headers)
            resp.raise_for_status()
            text = resp.text
            if not text.strip():
                return {"models": [], "error": "Empty response from API"}
            data = resp.json()

        # Support both {"data": [...]} (OpenAI) and [...] (plain list) formats
        if isinstance(data, list):
            items = data
        else:
            items = data.get("data", [])

        models = [{"id": m["id"], "name": m.get("id")} for m in items if isinstance(m, dict) and "id" in m]
        return {"models": models}
    except Exception as e:
        return {"models": [], "error": str(e)}


# === 对话标题生成 ===
class TitleRequest(BaseModel):
    message: str


@router.post("/chat/title")
async def generate_title(req: TitleRequest) -> dict:
    """根据首条用户消息用 AI 生成简短对话标题"""
    user_config = UserConfig.load()
    api_format = user_config.get("api_format", "openai")
    base_url = user_config.get("base_url") or settings.effective_base_url
    api_key = user_config.get("api_key") or settings.effective_api_key
    model = user_config.get("selected_model") or settings.effective_model

    if not api_key or not model:
        return {"title": ""}

    try:
        if api_format == "anthropic":
            llm = ChatAnthropic(
                model=model,
                temperature=1,  # required when thinking disabled
                max_tokens=100,
                api_key=api_key,
                base_url=base_url.split("/v1")[0] if base_url else None,
                thinking={"type": "disabled"},
            )
        else:
            llm = ChatOpenAI(
                model=model,
                temperature=0,
                max_tokens=20,
                api_key=api_key,
                base_url=base_url if base_url else None,
            )

        system = SystemMessage(content=(
            "Generate a very short title (3-5 words) for a conversation that starts with the user message below. "
            "Return ONLY the title text, no quotes, no trailing punctuation."
        ))
        response = await llm.ainvoke([system, HumanMessage(content=req.message)])
        content = response.content
        if isinstance(content, list):
            text_blocks = [b["text"] for b in content if isinstance(b, dict) and b.get("type") == "text"]
            content = " ".join(text_blocks)
        title = str(content).strip().strip('"')
        logger.info(f"Generated title: {title!r} for message: {req.message[:50]!r}")
        return {"title": title}
    except Exception as e:
        logger.warning(f"Title generation failed: {e}")
        return {"title": ""}


# === 历史记录 ===
@router.get("/history")
async def get_history() -> dict[str, Any]:
    """获取分析历史记录。"""
    return {"history": list(reversed(_analysis_history)), "total": len(_analysis_history)}


# === 打开链接 ===
class OpenUrlRequest(BaseModel):
    url: str


@router.post("/open-url")
async def open_url(req: OpenUrlRequest) -> dict:
    """在系统默认浏览器中打开链接。"""
    try:
        webbrowser.open(req.url)
        return {"success": True}
    except Exception as e:
        return {"success": False, "error": str(e)}
