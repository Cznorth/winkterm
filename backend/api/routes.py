from __future__ import annotations

import logging
import os
import platform
import re
import subprocess
import threading
import time
import uuid
import webbrowser
import httpx
from datetime import datetime
from pathlib import Path
from typing import Any, Literal, Optional

logger = logging.getLogger("routes")

import json
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel
from langchain_core.messages import HumanMessage, SystemMessage
from langchain_openai import ChatOpenAI
from langchain_anthropic import ChatAnthropic

from backend.agent.graph import get_graph
from backend.agent.tools.terminal_legacy import get_terminal_context_raw
from backend.config import UserConfig, AgentDocs, settings

router = APIRouter()
APP_VERSION = "0.3.0"
GITHUB_RELEASES_API = "https://api.github.com/repos/Cznorth/winkterm/releases/latest"
_update_jobs: dict[str, dict[str, Any]] = {}

# In-memory analysis history (should be persisted to a database in production)
_analysis_history: list[dict[str, Any]] = []


class AnalyzeRequest(BaseModel):
    message: str
    terminal_context: str = ""


class AnalyzeResponse(BaseModel):
    result: str
    timestamp: str


# === Settings ===
class ModelInfo(BaseModel):
    id: str
    name: str = ""


class SettingsModel(BaseModel):
    # All fields optional: only update fields explicitly provided in the request,
    # so partial saves (e.g. language only) do not clear other fields
    api_format: Optional[Literal["openai", "anthropic"]] = None
    base_url: Optional[str] = None
    api_key: Optional[str] = None
    models: Optional[list[ModelInfo]] = None
    selected_model: Optional[str] = None
    language: Optional[str] = None
    theme: Optional[str] = None
    agent_api_token: Optional[str] = None
    web_access_key: Optional[str] = None


class ModelsRequest(BaseModel):
    base_url: str
    api_key: str
    api_format: Literal["openai", "anthropic"]


class StreamTestRequest(BaseModel):
    base_url: str
    api_key: str
    api_format: Literal["openai", "anthropic"]
    model: str = ""


def _parse_version(version: str) -> tuple[int, ...]:
    parts = re.findall(r"\d+", version.lstrip("v"))
    return tuple(int(part) for part in parts[:3]) if parts else (0,)


def _platform_asset_name() -> str | None:
    system = platform.system().lower()
    machine = platform.machine().lower()
    if system == "darwin":
        return "WinkTerm-macOS-arm64.dmg" if "arm" in machine or "aarch64" in machine else "WinkTerm-macOS-x64.dmg"
    if system == "windows":
        return "WinkTerm-Windows-x64.msi"
    return None


async def _fetch_latest_release() -> dict[str, Any]:
    async with httpx.AsyncClient(timeout=10.0, follow_redirects=True, trust_env=False) as client:
        resp = await client.get(GITHUB_RELEASES_API, headers={"Accept": "application/vnd.github+json"})
        resp.raise_for_status()
        return resp.json()


def _open_path(path: Path) -> None:
    system = platform.system().lower()
    if system == "darwin":
        subprocess.Popen(["open", str(path)])
    elif system == "windows":
        os.startfile(str(path))  # type: ignore[attr-defined]
    else:
        subprocess.Popen(["xdg-open", str(path)])


def _run_update_download(job_id: str, url: str, target: Path, version: str, total: int) -> None:
    job = _update_jobs[job_id]
    try:
        downloaded = 0
        started_at = time.monotonic()
        with httpx.stream("GET", url, timeout=120.0, follow_redirects=True, trust_env=False) as resp:
            resp.raise_for_status()
            actual_total = int(resp.headers.get("content-length") or total or 0)
            job["total"] = actual_total
            with target.open("wb") as fh:
                for chunk in resp.iter_bytes():
                    if not chunk:
                        continue
                    fh.write(chunk)
                    downloaded += len(chunk)
                    elapsed = max(time.monotonic() - started_at, 0.001)
                    job["downloaded"] = downloaded
                    job["speed"] = round(downloaded / elapsed)
                    job["progress"] = round(downloaded / actual_total * 100) if actual_total else 0
        job.update({
            "status": "opening",
            "downloaded": downloaded,
            "speed": 0,
            "progress": 100,
            "path": str(target),
        })
        _open_path(target)
        job.update({"status": "done", "done": True, "version": version})
    except Exception as e:
        logger.warning("Update download failed: %s", e)
        job.update({"status": "error", "done": True, "error": str(e)})


@router.get("/settings")
async def get_settings() -> dict:
    """Return settings with API keys masked."""
    return UserConfig.get_masked()


@router.get("/app/update/check")
async def check_update() -> dict:
    """Check GitHub Releases for a newer WinkTerm build."""
    try:
        release = await _fetch_latest_release()
    except Exception as e:
        logger.warning("Update check failed: %s", e)
        return {
            "current_version": APP_VERSION,
            "latest_version": APP_VERSION,
            "update_available": False,
            "error": str(e),
        }

    tag = str(release.get("tag_name") or "")
    latest_version = tag.lstrip("v") or APP_VERSION
    asset_name = _platform_asset_name()
    assets = release.get("assets") or []
    asset = next((item for item in assets if item.get("name") == asset_name), None)

    return {
        "current_version": APP_VERSION,
        "latest_version": latest_version,
        "update_available": _parse_version(latest_version) > _parse_version(APP_VERSION),
        "release_url": release.get("html_url") or "",
        "release_notes": release.get("body") or "",
        "asset_name": asset_name or "",
        "asset_url": asset.get("browser_download_url") if asset else "",
        "asset_size": asset.get("size") if asset else 0,
        "platform_supported": asset is not None,
    }


@router.post("/app/update/install")
async def install_update(request: Request) -> dict:
    """Start downloading the latest platform package and open it when ready."""
    from backend.api.auth_routes import is_local_request
    if not is_local_request(request):
        raise HTTPException(status_code=403, detail="仅本机桌面客户端可触发安装包打开")

    release = await _fetch_latest_release()
    asset_name = _platform_asset_name()
    if not asset_name:
        raise HTTPException(status_code=400, detail="当前平台暂不支持一键更新")

    assets = release.get("assets") or []
    asset = next((item for item in assets if item.get("name") == asset_name), None)
    if not asset:
        raise HTTPException(status_code=404, detail="未找到适用于当前平台的安装包")

    tag = str(release.get("tag_name") or "latest")
    url = asset.get("browser_download_url")
    if not url:
        raise HTTPException(status_code=404, detail="安装包下载地址不存在")

    downloads = Path.home() / "Downloads"
    downloads.mkdir(parents=True, exist_ok=True)
    target = downloads / f"WinkTerm-{tag}-{asset_name}"

    job_id = uuid.uuid4().hex
    _update_jobs[job_id] = {
        "job_id": job_id,
        "status": "downloading",
        "done": False,
        "version": tag.lstrip("v"),
        "asset_name": asset_name,
        "downloaded": 0,
        "total": int(asset.get("size") or 0),
        "speed": 0,
        "progress": 0,
        "path": str(target),
        "error": "",
    }
    threading.Thread(
        target=_run_update_download,
        args=(job_id, url, target, tag.lstrip("v"), int(asset.get("size") or 0)),
        daemon=True,
    ).start()

    return {
        "success": True,
        "job_id": job_id,
        "version": tag.lstrip("v"),
        "message": "安装包开始下载。",
    }


@router.get("/app/update/install/{job_id}")
async def get_update_install_job(job_id: str) -> dict:
    """Return download progress for an update install job."""
    job = _update_jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="更新任务不存在")
    return job


@router.get("/settings/token/reveal")
async def reveal_agent_token(request: Request) -> dict:
    """Return the full agent_api_token for copy on the settings page.
    Auth: localhost allowed; remote requests require a valid X-Access-Key header.
    """
    from backend.api.auth_routes import is_local_request, verify_web_key
    if not is_local_request(request) and not verify_web_key(request.headers.get("X-Access-Key", "")):
        raise HTTPException(status_code=403, detail="需本机访问或有效的 X-Access-Key")
    token = UserConfig.load().get("agent_api_token") or settings.agent_api_token
    if not token:
        raise HTTPException(status_code=404, detail="未配置 agent_api_token")
    return {"token": token}


@router.get("/settings/export")
async def export_settings(request: Request) -> Response:
    """Export the full config file (including plaintext secrets); requires localhost or valid X-Access-Key."""
    from backend.api.auth_routes import is_local_request, verify_web_key
    if not is_local_request(request) and not verify_web_key(request.headers.get("X-Access-Key", "")):
        raise HTTPException(status_code=403, detail="需本机访问或有效的 X-Access-Key")
    config = UserConfig.load()
    content = json.dumps(config, indent=2, ensure_ascii=False)
    return Response(
        content=content,
        media_type="application/json",
        headers={"Content-Disposition": "attachment; filename=winkterm-config.json"},
    )


@router.post("/settings")
async def save_settings(payload: SettingsModel) -> dict:
    """Save settings: only update fields explicitly provided in the request."""
    data = payload.model_dump(exclude_none=True)
    original = UserConfig.load()
    # Masked values (containing ****) or empty strings (left blank when editing) mean unchanged — keep originals
    for secret in ("api_key", "agent_api_token", "web_access_key"):
        if secret not in data:
            continue
        val = data[secret] or ""
        if "****" in val or (val == "" and original.get(secret)):
            data[secret] = original.get(secret, "")
    UserConfig.merge_save(data)
    return {"success": True}


class DocContent(BaseModel):
    content: str


@router.get("/settings/agents-md")
async def get_agents_md() -> dict:
    """Read user-defined operating instructions (agents.md)."""
    return {"content": AgentDocs.read_agents()}


@router.put("/settings/agents-md")
async def put_agents_md(payload: DocContent) -> dict:
    """Save user-defined operating instructions (agents.md)."""
    AgentDocs.write_agents(payload.content)
    return {"success": True}


@router.get("/settings/memory-md")
async def get_memory_md() -> dict:
    """Read AI long-term memory (memory.md)."""
    return {"content": AgentDocs.read_memory()}


@router.put("/settings/memory-md")
async def put_memory_md(payload: DocContent) -> dict:
    """Save AI long-term memory (memory.md); auto-backup to .bak before write."""
    AgentDocs.write_memory(payload.content)
    return {"success": True}


@router.post("/models/fetch")
async def fetch_models(req: ModelsRequest) -> dict:
    """Fetch available model list from the API."""
    # If api_key contains ****, use the original key from the config file
    api_key = req.api_key
    if "****" in api_key:
        config = UserConfig.load()
        api_key = config.get("api_key", "")

    try:
        if req.api_format == "anthropic":
            # ChatAnthropic SDK appends /v1 automatically, so strip user-supplied /v1 before building URL
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


@router.post("/models/stream-test")
async def stream_test(req: StreamTestRequest) -> StreamingResponse:
    """Send a short streaming request to verify API config and model streaming support."""
    api_key = req.api_key
    if "****" in api_key:
        config = UserConfig.load()
        api_key = config.get("api_key", "")

    model = req.model.strip()
    if not model:
        user_config = UserConfig.load()
        model = user_config.get("selected_model") or settings.effective_model

    if not api_key or not req.base_url or not model:
        raise HTTPException(status_code=400, detail="缺少 base_url、api_key 或 model")

    async def gen():
        try:
            if req.api_format == "anthropic":
                llm = ChatAnthropic(
                    model=model,
                    temperature=1,
                    max_tokens=32,
                    api_key=api_key,
                    base_url=req.base_url.rstrip("/").split("/v1")[0] if req.base_url else None,
                    thinking={"type": "disabled"},
                )
            else:
                llm = ChatOpenAI(
                    model=model,
                    temperature=0,
                    max_tokens=32,
                    api_key=api_key,
                    base_url=req.base_url if req.base_url else None,
                )

            messages = [HumanMessage(content="Reply with exactly: OK")]
            chunk_count = 0
            async for chunk in llm.astream(messages):
                content = chunk.content
                if isinstance(content, list):
                    text_blocks = [
                        b["text"] for b in content
                        if isinstance(b, dict) and b.get("type") == "text"
                    ]
                    content = "".join(text_blocks)
                if content:
                    chunk_count += 1
                    payload = json.dumps(
                        {"type": "token", "content": str(content)},
                        ensure_ascii=False,
                    )
                    yield f"data: {payload}\n\n"

            done_payload = json.dumps(
                {"type": "done", "chunks": chunk_count},
                ensure_ascii=False,
            )
            yield f"data: {done_payload}\n\n"
        except Exception as e:
            logger.warning(f"Stream test failed: {e}")
            err_payload = json.dumps(
                {"type": "error", "message": str(e)},
                ensure_ascii=False,
            )
            yield f"data: {err_payload}\n\n"

    headers = {
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
    }
    return StreamingResponse(gen(), media_type="text/event-stream", headers=headers)


# === Chat history persistence (process-level + file) ===
@router.get("/chat/conversations")
async def list_chat_conversations() -> dict:
    """List all saved conversations (for frontend restore on mount)."""
    from backend.api import chat_store
    return {"conversations": chat_store.list_conversations()}


class TitleUpdate(BaseModel):
    title: str


@router.post("/chat/conversations/{conv_id}/title")
async def set_chat_title(conv_id: str, body: TitleUpdate) -> dict:
    from backend.api import chat_store
    chat_store.update_title(conv_id, body.title)
    return {"ok": True}


@router.delete("/chat/conversations/{conv_id}")
async def delete_chat_conversation(conv_id: str) -> dict:
    from backend.api import chat_store
    ok = chat_store.delete_conversation(conv_id)
    return {"ok": ok}


# === Chat title generation ===
class TitleRequest(BaseModel):
    messages: list[dict]  # [{"role": "user"|"assistant", "content": str}]


@router.post("/chat/title")
async def generate_title(req: TitleRequest) -> dict:
    """Generate a short conversation title from chat content using AI."""
    user_config = UserConfig.load()
    api_format = user_config.get("api_format", "openai")
    base_url = user_config.get("base_url") or settings.effective_base_url
    api_key = user_config.get("api_key") or settings.effective_api_key
    model = user_config.get("selected_model") or settings.effective_model

    if not api_key or not model or not req.messages:
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

        recent = req.messages[:8]
        history_text = "\n".join(
            f"{m['role'].upper()}: {str(m.get('content', ''))[:300]}"
            for m in recent
        )
        system = SystemMessage(content=(
            "Generate a very short title (3-5 words) summarizing the conversation below. "
            "Ignore greetings and pleasantries; focus on the actual topic or task. "
            "Return ONLY the title text, no quotes, no trailing punctuation."
        ))
        response = await llm.ainvoke([system, HumanMessage(content=history_text)])
        content = response.content
        if isinstance(content, list):
            text_blocks = [b["text"] for b in content if isinstance(b, dict) and b.get("type") == "text"]
            content = " ".join(text_blocks)
        title = str(content).strip().strip('"')
        logger.info(f"Generated title: {title!r} from {len(recent)} messages")
        return {"title": title}
    except Exception as e:
        logger.warning(f"Title generation failed: {e}")
        return {"title": ""}


# === Chat continuation suggestions ===
class SuggestionsRequest(BaseModel):
    messages: list[dict]  # [{"role": "user"|"assistant", "content": str}]


@router.post("/chat/suggestions")
async def generate_suggestions(req: SuggestionsRequest) -> dict:
    """Generate 3 suggested follow-up messages the user might send next."""
    user_config = UserConfig.load()
    api_format = user_config.get("api_format", "openai")
    base_url = user_config.get("base_url") or settings.effective_base_url
    api_key = user_config.get("api_key") or settings.effective_api_key
    model = user_config.get("selected_model") or settings.effective_model

    if not api_key or not model or not req.messages:
        return {"suggestions": []}

    # Use recent turns as context (avoid excessive tokens)
    recent = req.messages[-6:]
    history_text = "\n".join(
        f"{m['role'].upper()}: {str(m.get('content', ''))[:300]}"
        for m in recent
    )

    try:
        if api_format == "anthropic":
            llm = ChatAnthropic(
                model=model,
                temperature=1,
                max_tokens=200,
                api_key=api_key,
                base_url=base_url.split("/v1")[0] if base_url else None,
                thinking={"type": "disabled"},
            )
        else:
            llm = ChatOpenAI(
                model=model,
                temperature=0.7,
                max_tokens=200,
                api_key=api_key,
                base_url=base_url if base_url else None,
            )

        system = SystemMessage(content=(
            "You are a helpful assistant. Based on the conversation below, generate exactly 3 short follow-up questions or messages "
            "the user might want to send next. Each suggestion should be concise (under 15 words). "
            "Return ONLY the 3 suggestions, one per line, no numbering, no bullets, no extra text."
        ))
        response = await llm.ainvoke([system, HumanMessage(content=history_text)])
        content = response.content
        if isinstance(content, list):
            text_blocks = [b["text"] for b in content if isinstance(b, dict) and b.get("type") == "text"]
            content = " ".join(text_blocks)
        lines = [line.strip().lstrip("0123456789.-) ") for line in str(content).strip().splitlines() if line.strip()]
        suggestions = lines[:3]
        logger.info(f"Generated {len(suggestions)} suggestions")
        return {"suggestions": suggestions}
    except Exception as e:
        logger.warning(f"Suggestions generation failed: {e}")
        return {"suggestions": []}


# === History ===
@router.get("/history")
async def get_history() -> dict[str, Any]:
    """Return analysis history records."""
    return {"history": list(reversed(_analysis_history)), "total": len(_analysis_history)}


# === Open URL ===
class OpenUrlRequest(BaseModel):
    url: str


@router.post("/open-url")
async def open_url(req: OpenUrlRequest) -> dict:
    """Open a URL in the system default browser."""
    try:
        webbrowser.open(req.url)
        return {"success": True}
    except Exception as e:
        return {"success": False, "error": str(e)}
