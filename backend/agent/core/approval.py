"""Ask-mode tool approval coordinator.

In ask mode, before executing each tool the agent broadcasts a tool_approval
request to the frontend and awaits a Future. Once the user clicks
approve/deny, the WS receive loop calls resolve() to settle the Future, and
the tool node decides whether to run or skip the call.

The wait happens inside _tool_node (the astream_events stream suspends there
naturally), so no LangGraph checkpointer / graph re-entry is needed.
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from typing import Any, Awaitable, Callable

logger = logging.getLogger("agent.approval")

# approval_id -> Future[bool]
_pending: dict[str, asyncio.Future[bool]] = {}


async def request_approval(
    emit: Callable[[dict], Awaitable[None]],
    tool_name: str,
    tool_args: Any,
) -> bool:
    """Broadcast an approval request and wait for the user's decision.

    Returns True if approved, False if denied. `emit` is an async function
    that pushes a message to the frontend (typically the conv broadcaster).
    """
    approval_id = uuid.uuid4().hex
    loop = asyncio.get_event_loop()
    fut: asyncio.Future[bool] = loop.create_future()
    _pending[approval_id] = fut

    await emit({
        "type": "tool_approval",
        "approval_id": approval_id,
        "tool": tool_name,
        "args": tool_args,
    })
    logger.info(f"[APPROVAL] waiting for user decision: {tool_name} (id={approval_id})")

    try:
        approved = await fut
        logger.info(f"[APPROVAL] {tool_name} -> {'approved' if approved else 'denied'}")
        return approved
    finally:
        _pending.pop(approval_id, None)


def resolve_approval(approval_id: str, approved: bool) -> bool:
    """Settle the Future for a decision. Returns whether a pending request matched."""
    fut = _pending.get(approval_id)
    if fut is not None and not fut.done():
        fut.set_result(approved)
        return True
    return False


def cancel_all() -> None:
    """Cancel all pending approvals (on WS disconnect / stop) as denials,
    so any waiting tool node is released instead of hanging forever."""
    for approval_id, fut in list(_pending.items()):
        if not fut.done():
            fut.set_result(False)
        _pending.pop(approval_id, None)
