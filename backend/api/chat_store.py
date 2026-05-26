"""侧边栏对话历史存储 (进程级单例 + 文件持久化)。

之前 ChatWSHandler 把 histories 放在 self 上,WS 断开实例销毁 → 前端 refresh
就丢光。这里改成模块级 dict,跨 WS 重连保留,可选写入 ~/.winkterm/chat_history.json
让进程重启也保留。
"""

from __future__ import annotations

import json
import logging
import threading
import time
from pathlib import Path
from typing import Any

logger = logging.getLogger("chat_store")

_STORE_PATH = Path.home() / ".winkterm" / "chat_history.json"
_lock = threading.Lock()
_dirty = False
_conversations: dict[str, dict[str, Any]] = {}
_loaded = False


def _ensure_loaded() -> None:
    global _loaded
    if _loaded:
        return
    with _lock:
        if _loaded:
            return
        if _STORE_PATH.exists():
            try:
                raw = json.loads(_STORE_PATH.read_text(encoding="utf-8"))
                if isinstance(raw, dict):
                    _conversations.update(raw)
                    logger.info(f"[load] {len(_conversations)} 条会话从 {_STORE_PATH}")
            except Exception as e:
                logger.warning(f"[load] 读取失败: {e}")
        _loaded = True


def _flush() -> None:
    """写盘。调用方持锁。"""
    global _dirty
    if not _dirty:
        return
    try:
        _STORE_PATH.parent.mkdir(parents=True, exist_ok=True)
        _STORE_PATH.write_text(
            json.dumps(_conversations, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        _dirty = False
    except Exception as e:
        logger.warning(f"[flush] 写盘失败: {e}")


def _new_conv() -> dict[str, Any]:
    return {
        "title": "",
        "messages": [],  # [{role, content, thinking?, contentBlocks?, timestamp}]
        "input_tokens": 0,
        "output_tokens": 0,
        "updated_at": time.time(),
    }


def get_conversation(conv_id: str) -> dict[str, Any]:
    """获取/创建会话条目。"""
    _ensure_loaded()
    with _lock:
        if conv_id not in _conversations:
            _conversations[conv_id] = _new_conv()
        return _conversations[conv_id]


def list_conversations() -> list[dict[str, Any]]:
    """列出所有会话(按 updated_at 倒序)。"""
    _ensure_loaded()
    with _lock:
        items = []
        for cid, conv in _conversations.items():
            items.append(
                {
                    "id": cid,
                    "title": conv.get("title", ""),
                    "messages": conv.get("messages", []),
                    "input_tokens": conv.get("input_tokens", 0),
                    "output_tokens": conv.get("output_tokens", 0),
                    "updated_at": conv.get("updated_at", 0),
                }
            )
        items.sort(key=lambda x: x["updated_at"], reverse=True)
        return items


def append_message(conv_id: str, message: dict[str, Any]) -> None:
    """追加一条消息(message 含 role + content + 可选 thinking/contentBlocks)。"""
    _ensure_loaded()
    global _dirty
    with _lock:
        conv = _conversations.setdefault(conv_id, _new_conv())
        conv["messages"].append(message)
        conv["updated_at"] = time.time()
        _dirty = True
        _flush()


def set_messages(conv_id: str, messages: list[dict[str, Any]]) -> None:
    """覆盖整条消息列表(撤回最后一条等场景)。"""
    _ensure_loaded()
    global _dirty
    with _lock:
        conv = _conversations.setdefault(conv_id, _new_conv())
        conv["messages"] = messages
        conv["updated_at"] = time.time()
        _dirty = True
        _flush()


def update_tokens(conv_id: str, input_tokens: int, output_tokens: int) -> None:
    _ensure_loaded()
    global _dirty
    with _lock:
        conv = _conversations.setdefault(conv_id, _new_conv())
        conv["input_tokens"] = input_tokens
        conv["output_tokens"] = output_tokens
        conv["updated_at"] = time.time()
        _dirty = True
        _flush()


def update_title(conv_id: str, title: str) -> None:
    _ensure_loaded()
    global _dirty
    with _lock:
        conv = _conversations.setdefault(conv_id, _new_conv())
        conv["title"] = title
        conv["updated_at"] = time.time()
        _dirty = True
        _flush()


def delete_conversation(conv_id: str) -> bool:
    _ensure_loaded()
    global _dirty
    with _lock:
        if conv_id in _conversations:
            _conversations.pop(conv_id)
            _dirty = True
            _flush()
            return True
        return False
