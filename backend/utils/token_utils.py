"""Token 工具：tiktoken 计数 + OpenRouter context_length 查询。"""

from __future__ import annotations

import logging

import tiktoken

logger = logging.getLogger("token_utils")

_tokenizer = tiktoken.get_encoding("cl100k_base")


def count_tokens(text: str) -> int:
    """用 tiktoken 计算 token 数。"""
    return len(_tokenizer.encode(text))


def count_history_tokens(history: list) -> int:
    """计算会话历史的总 token 数。"""
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
    # 每条消息约 4 token 开销（OpenAI/Anthropic 格式差异）
    total += len(history) * 4
    return total


async def fetch_model_context_length(model_id: str) -> int | None:
    """从 OpenRouter API 获取指定模型的 context_length。

    OpenRouter ID 格式为 provider/name，代理使用 name 部分（可能带日期后缀）。
    匹配策略：
      1. 精确匹配 name_part
      2. name_part 去掉尾部日期版本号后匹配
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

                # 1) 精确匹配
                if model_id == name_part:
                    ctx = m.get("context_length")
                    if ctx:
                        logger.debug(f"[OR] 精确匹配 {mid} -> {model_id} context_length={ctx}")
                        return ctx

                # 2) 去尾部日期版本号后匹配
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
