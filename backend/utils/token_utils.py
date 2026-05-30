"""Token utilities: tiktoken counting + OpenRouter context_length lookup."""

from __future__ import annotations

import logging

import tiktoken
from tiktoken.core import Encoding
from tiktoken_ext.openai_public import cl100k_base as _cl100k_base_constructor

logger = logging.getLogger("token_utils")

_tokenizer = Encoding(**_cl100k_base_constructor())


def count_tokens(text: str) -> int:
    """Count tokens with tiktoken."""
    return len(_tokenizer.encode(text))


def count_history_tokens(history: list) -> int:
    """Count total tokens in conversation history."""
    total = 0
    for msg in history:
        from langchain_core.messages import AIMessage as _AI, HumanMessage as _Human

        if isinstance(msg, _Human):
            total += count_tokens(msg.content or "")
        elif isinstance(msg, _AI):
            content = msg.content or ""
            if isinstance(content, str):
                total += count_tokens(content)
            elif isinstance(content, list):
                for block in content:
                    if isinstance(block, dict):
                        total += count_tokens(block.get("text", "") or "")
    # ~4 tokens overhead per message (OpenAI/Anthropic format differences)
    total += len(history) * 4
    return total


async def fetch_model_context_length(model_id: str) -> int | None:
    """Fetch context_length for a model from the OpenRouter API.

    OpenRouter IDs use provider/name; proxies often use the name part (possibly with date suffix).
    Matching strategy:
      1. Exact match on name_part
      2. Match after stripping trailing date version from name_part
    """
    try:
        import httpx

        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get("https://openrouter.ai/api/v1/models")
            if not resp.is_success:
                logger.warning(f"[OR] OpenRouter API 返回 {resp.status_code}")
                return None

            for m in resp.json().get("data", []):
                mid = m.get("id", "")
                name_part = mid.split("/", 1)[-1]

                # 1) Exact match
                if model_id == name_part:
                    ctx = m.get("context_length")
                    if ctx:
                        logger.debug(f"[OR] 精确匹配 {mid} -> {model_id} context_length={ctx}")
                        return ctx

                # 2) Match after stripping trailing date version
                if "-" in name_part:
                    base, suffix = name_part.rsplit("-", 1)
                    if suffix.isdigit() and model_id == base:
                        ctx = m.get("context_length")
                        if ctx:
                            logger.debug(f"[OR] 日期去尾匹配 {mid} -> {model_id} context_length={ctx}")
                            return ctx

            logger.warning(f"[OR] 在 OpenRouter 中未找到模型 {model_id}")
    except Exception as e:
        logger.debug(f"[OR] 请求失败: {e}")
    return None
