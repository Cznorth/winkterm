"""Standalone tests for two agent-API improvements:

1. decode_terminal_text  -- GBK/UTF-8 fallback decoding (fixes garbled output).
2. RunJobManager         -- async run-job registry (fixes ~60s gateway timeout).

Run from the repo root with the project venv:

    .venv/Scripts/python.exe test/test_improvements.py
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

# Make the repo root importable (so `backend` resolves) regardless of CWD.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backend.terminal._term_utils import decode_terminal_text  # noqa: E402
from backend.ssh.run_jobs import RunJob, RunJobManager  # noqa: E402


def check(name: str, cond: bool) -> None:
    print(f"  [{'PASS' if cond else 'FAIL'}] {name}")
    if not cond:
        raise AssertionError(name)


def test_decoder() -> None:
    print("decode_terminal_text:")
    # Plain ASCII / UTF-8 unaffected.
    check("ascii", decode_terminal_text(b"hello") == "hello")
    check("utf8 chinese", decode_terminal_text("版本".encode("utf-8")) == "版本")
    # GBK-encoded Chinese (the real-world bug: `1pctl version` on a GBK locale).
    check("gbk chinese", decode_terminal_text("版本: v2.0.0".encode("gbk")) == "版本: v2.0.0")
    check("gbk mixed", decode_terminal_text("模式 stable".encode("gbk")) == "模式 stable")
    # UTF-8 must win even though the bytes are *also* valid GBK-ish: real UTF-8 first.
    check("utf8 wins", decode_terminal_text("中文".encode("utf-8")) == "中文")
    # Empty + non-decodable binary falls back lossily without raising.
    check("empty", decode_terminal_text(b"") == "")
    out = decode_terminal_text(b"\xff\xfe\x00\x01ok")
    check("binary no-raise", isinstance(out, str) and "ok" in out)


async def _fake_ok_worker(job: RunJob) -> None:
    job.set_terminal("term-xyz")
    await asyncio.sleep(0.05)
    job.finish({"ok": True, "exit_code": 0, "stdout": "done", "reason": None})


async def _fake_slow_worker(job: RunJob) -> None:
    job.set_terminal("term-slow")
    await asyncio.sleep(5.0)  # long; we cancel before this completes
    job.finish({"ok": True, "exit_code": 0, "stdout": "late"})


async def _fake_boom_worker(job: RunJob) -> None:
    raise RuntimeError("boom")


async def test_run_jobs() -> None:
    print("RunJobManager:")
    # Happy path: submit returns immediately as 'running', then resolves to success.
    d = RunJobManager.submit("conn1", "echo done", _fake_ok_worker)
    check("submit returns job_id", bool(d["job_id"]))
    check("submit status running", d["status"] == "running")
    check("submit not done", d["done"] is False)
    jid = d["job_id"]
    await asyncio.sleep(0.2)
    j = RunJobManager.get(jid)
    check("resolves success", j["status"] == "success")
    check("done flag", j["done"] is True)
    check("stdout captured", j["stdout"] == "done")
    check("exit_code", j["exit_code"] == 0)
    check("terminal_id set", j["terminal_id"] == "term-xyz")

    # Error path: worker raises -> status 'error', message captured.
    d2 = RunJobManager.submit("conn1", "bad", _fake_boom_worker)
    await asyncio.sleep(0.1)
    j2 = RunJobManager.get(d2["job_id"])
    check("error status", j2["status"] == "error")
    check("error message", j2["error"] == "boom")

    # Cancel path: cancel a still-running job.
    d3 = RunJobManager.submit("conn1", "sleep", _fake_slow_worker)
    await asyncio.sleep(0.1)
    RunJobManager.cancel(d3["job_id"])
    await asyncio.sleep(0.1)
    j3 = RunJobManager.get(d3["job_id"])
    check("canceled status", j3["status"] == "canceled")

    # Unknown id.
    check("unknown get -> None", RunJobManager.get("nope") is None)
    check("unknown cancel -> None", RunJobManager.cancel("nope") is None)


def test_route_wiring() -> None:
    print("agent_routes wiring:")
    from backend.api import agent_routes  # noqa: E402

    paths = {r.path for r in agent_routes.router.routes}
    check("run_async route", "/api/agent/ssh/{conn_id}/run_async" in paths)
    check("jobs list route", "/api/agent/jobs" in paths)
    check("job get route", "/api/agent/jobs/{job_id}" in paths)


def main() -> int:
    test_decoder()
    asyncio.run(test_run_jobs())
    test_route_wiring()
    print("\nALL TESTS PASSED")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
