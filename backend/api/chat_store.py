"""Sidebar chat history store (process-level singleton + file persistence).

Previously ChatWSHandler kept histories on self; when the WS disconnected the instance
was destroyed and frontend refresh lost everything. Now a module-level dict survives
WS reconnects, with optional write to ~/.winkterm/chat_history.json for process restarts.
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
    """Flush to disk. Caller must hold the lock."""
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
    """Get or create a conversation entry."""
    _ensure_loaded()
    with _lock:
        if conv_id not in _conversations:
            _conversations[conv_id] = _new_conv()
        return _conversations[conv_id]


def list_conversations() -> list[dict[str, Any]]:
    """List all conversations (newest updated_at first)."""
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
    """Append one message (role + content + optional thinking/contentBlocks)."""
    _ensure_loaded()
    global _dirty
    with _lock:
        conv = _conversations.setdefault(conv_id, _new_conv())
        conv["messages"].append(message)
        conv["updated_at"] = time.time()
        _dirty = True
        _flush()


def set_messages(conv_id: str, messages: list[dict[str, Any]]) -> None:
    """Replace the entire message list (e.g. undo last message)."""
    _ensure_loaded()
    global _dirty
    with _lock:
        conv = _conversations.setdefault(conv_id, _new_conv())
        conv["messages"] = messages
        conv["updated_at"] = time.time()
        _dirty = True
        _flush()


def update_last_assistant(
    conv_id: str,
    content: str,
    *,
    thinking: str | None = None,
    content_blocks: list[dict[str, Any]] | None = None,
    flush_disk: bool = False,
) -> None:
    """Streaming append: update the last assistant message in place.
    If the last message is not assistant, append one. When flush_disk=False, memory only
    to reduce disk writes during streaming; set flush_disk=True on end to persist."""
    _ensure_loaded()
    global _dirty
    with _lock:
        conv = _conversations.setdefault(conv_id, _new_conv())
        msgs = conv.get("messages") or []
        last = msgs[-1] if msgs else None
        if not last or last.get("role") != "assistant":
            msgs.append(
                {
                    "role": "assistant",
                    "content": content,
                    "thinking": thinking,
                    "contentBlocks": content_blocks,
                    "timestamp": time.time(),
                }
            )
            conv["messages"] = msgs
        else:
            last["content"] = content
            if thinking is not None:
                last["thinking"] = thinking
            if content_blocks is not None:
                last["contentBlocks"] = content_blocks
        conv["updated_at"] = time.time()
        _dirty = True
        if flush_disk:
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
