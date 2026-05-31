"""Synchronous one-shot SSH command execution for async run jobs.

Unlike the PTY-based ``TerminalSession.exec`` (which drives an interactive shell
on the event loop), this opens a dedicated paramiko channel, runs a single
command via ``exec_command``, and returns its real exit status. It is fully
blocking and meant to be called inside ``asyncio.to_thread`` so it never starves
the FastAPI event loop -- giving both a non-blocking submit and per-job
isolation (a slow/hung host stalls only its own worker thread).
"""

from __future__ import annotations

import re
import shlex
import socket

from backend.ssh.file_transfer import SSHFileTransfer
from backend.ssh.models import SSHConnection
from backend.terminal._term_utils import decode_b64, decode_terminal_text, strip_ansi

_VALID_ENV_KEY = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")


def build_command(
    command: str = "",
    command_b64: str | None = None,
    cwd: str | None = None,
    env: dict[str, str] | None = None,
) -> str:
    """Assemble the final shell command, applying optional cwd/env wrapping.

    Raises ValueError on an empty command or an illegal env var name.
    """
    cmd = command or ""
    if command_b64:
        cmd += decode_b64(command_b64)
    cmd = cmd.rstrip("\n")
    if not cmd:
        raise ValueError("命令为空")

    export_clause = ""
    if env:
        exports: list[str] = []
        for key, value in env.items():
            if not _VALID_ENV_KEY.fullmatch(key):
                raise ValueError(f"非法环境变量名: {key!r}")
            exports.append(f"export {key}={shlex.quote(value)}")
        export_clause = "; ".join(exports) + "; "

    if cwd or env:
        cd_clause = f"cd {shlex.quote(cwd)}; " if cwd else ""
        return f"{cd_clause}{export_clause}{cmd}"
    return cmd


def run_command(conn: SSHConnection, command: str, timeout: float = 60.0) -> dict:
    """Run ``command`` over a fresh SSH channel and return its result.

    Blocking -- call via ``asyncio.to_thread``. Output is decoded with the
    GBK/UTF-8 fallback decoder so non-UTF-8 locales don't garble.
    """
    client, sftp = SSHFileTransfer._connect(conn)
    try:
        try:
            sftp.close()
        except Exception:
            pass
        # get_pty=False keeps stdout/stderr separate and avoids CR/ANSI injection.
        _stdin, stdout, stderr = client.exec_command(command, timeout=timeout, get_pty=False)
        channel = stdout.channel
        channel.settimeout(timeout)
        try:
            out_bytes = stdout.read()
            err_bytes = stderr.read()
        except socket.timeout:
            channel.close()
            return {
                "ok": False,
                "reason": "timeout",
                "exit_code": None,
                "stdout": "",
            }
        exit_code = channel.recv_exit_status()
        combined = out_bytes
        if err_bytes:
            combined = combined + (b"\n" if combined else b"") + err_bytes
        return {
            "ok": True,
            "exit_code": exit_code,
            "stdout": strip_ansi(decode_terminal_text(combined)).rstrip("\n"),
            "reason": None,
        }
    finally:
        client.close()
