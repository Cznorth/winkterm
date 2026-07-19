#!/usr/bin/env python3
"""Smoke-test terminal output delivery after a WebSocket reconnect."""

from __future__ import annotations

import argparse
import asyncio
import json
import urllib.error
import urllib.request
import uuid

import websockets


async def _receive_until(ws, needle: str, timeout: float) -> str:
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    output: list[str] = []
    while loop.time() < deadline:
        remaining = max(0.1, deadline - loop.time())
        raw = await asyncio.wait_for(ws.recv(), timeout=remaining)
        text = raw.decode(errors="replace") if isinstance(raw, bytes) else raw
        output.append(text)
        combined = "".join(output)
        if needle in combined:
            return combined
    raise TimeoutError(f"terminal output did not contain {needle!r}")


async def _run(ws_base: str, session_id: str, marker: str) -> None:
    url = f"{ws_base.rstrip('/')}/{session_id}"

    async with websockets.connect(url, open_timeout=10) as first:
        await first.send("\x1b[8;40;120t")
        await _receive_until(first, ">", timeout=15)

    async with websockets.connect(url, open_timeout=10) as current:
        await current.send("\x1b[8;40;120t")
        await asyncio.sleep(0.5)
        await current.send(f"echo {marker}\r")
        await _receive_until(current, marker, timeout=10)


def _delete_session(http_base: str, session_id: str) -> None:
    request = urllib.request.Request(
        f"{http_base.rstrip('/')}/api/sessions/{session_id}",
        method="DELETE",
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=10):
            return
    except urllib.error.HTTPError as exc:
        if exc.code != 404:
            raise


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--ws-base", default="ws://127.0.0.1:8000/ws/terminal")
    parser.add_argument("--http-base", default="http://127.0.0.1:8000")
    args = parser.parse_args()

    session_id = f"reconnect-smoke-{uuid.uuid4().hex[:10]}"
    marker = f"WINKTERM_RECONNECT_{uuid.uuid4().hex[:10]}"
    try:
        asyncio.run(_run(args.ws_base, session_id, marker))
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        return 1
    finally:
        try:
            _delete_session(args.http_base, session_id)
        except Exception as exc:
            print(json.dumps({"cleanup_warning": str(exc)}, ensure_ascii=False))

    print(json.dumps({"ok": True, "session_id": session_id, "marker": marker}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
