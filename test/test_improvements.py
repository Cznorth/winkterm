"""Standalone tests for agent-API improvements:

1. decode_terminal_text  -- GBK/UTF-8 fallback decoding (fixes garbled output).
2. TerminalRunManager    -- managed run protocol (fixes long-command timeouts).

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
from backend.terminal.run_manager import TerminalRunManager  # noqa: E402


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


def test_terminal_run_manager() -> None:
    print("TerminalRunManager:")
    command = TerminalRunManager._final_command("echo done")
    check("final command", command == "echo done")

    wrapped, sentinel = TerminalRunManager._wrap_command(
        "echo done",
        cwd="/tmp",
        env={"WINKTERM_SMOKE": "1"},
        powershell=False,
    )
    check("posix sentinel", sentinel in wrapped)
    check("posix cwd", "cd /tmp" in wrapped)
    check("posix env", "export WINKTERM_SMOKE=1" in wrapped)

    ps_wrapped, ps_sentinel = TerminalRunManager._wrap_command(
        "Write-Output done",
        cwd="C:/Temp",
        env={"WINKTERM_SMOKE": "1"},
        powershell=True,
    )
    check("powershell sentinel", ps_sentinel in ps_wrapped)
    check("powershell cwd", "Set-Location 'C:/Temp'" in ps_wrapped)
    check("powershell env", "$env:WINKTERM_SMOKE='1'" in ps_wrapped)

    try:
        TerminalRunManager._final_command("")
    except ValueError:
        check("empty command rejected", True)
    else:
        check("empty command rejected", False)


def test_route_wiring() -> None:
    print("agent_routes wiring:")
    from backend.api import agent_routes  # noqa: E402

    paths = {r.path for r in agent_routes.router.routes}
    check("terminal run route", "/api/agent/terminals/{terminal_id}/run" in paths)
    check("run status route", "/api/agent/runs/{run_id}" in paths)
    check("run wait route", "/api/agent/runs/{run_id}/wait" in paths)


def main() -> int:
    test_decoder()
    test_terminal_run_manager()
    test_route_wiring()
    print("\nALL TESTS PASSED")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
