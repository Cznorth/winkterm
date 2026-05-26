#!/usr/bin/env python3
"""Test WinkTerm VNC WebSocket proxy + RFB auth for a given SSH connection."""

from __future__ import annotations

import argparse
import asyncio
import json
import struct
from pathlib import Path

import websockets
from websockets.exceptions import ConnectionClosed

from pyDes import des, ECB, PAD_NORMAL


def load_connection(conn_id: str) -> dict:
    cfg = Path.home() / ".winkterm" / "config.json"
    data = json.loads(cfg.read_text(encoding="utf-8"))
    for key in ("ssh_connections", "connections"):
        for c in data.get(key, []):
            if c.get("id") == conn_id:
                return c
    raise SystemExit(f"connection {conn_id} not found in {cfg}")


def vnc_encrypt_password(password: str, challenge: bytes) -> bytes:
    key = (password.encode("utf-8") + b"\x00" * 8)[:8]
    d = des(key, ECB, pad=None, padmode=PAD_NORMAL)
    return d.encrypt(challenge, padmode=PAD_NORMAL)


async def recv_bytes(ws, n: int, buf: bytes = b"") -> bytes:
    data = buf
    while len(data) < n:
        chunk = await ws.recv()
        if isinstance(chunk, str):
            raise RuntimeError(f"unexpected text: {chunk[:120]}")
        data += chunk
    return data


async def read_security_type(ws, buf: bytes) -> tuple[int, bytes]:
    """Parse RFB 3.3 (uint32) or 3.7+ (1 byte count + list)."""
    data = await recv_bytes(ws, 1, buf)
    first = data[0]
    # Heuristic: 3.7+ uses small count (1-10). 3.3 uint32 first byte often 0.
    if first in (0, 1, 2, 5, 16, 18, 19, 20, 21, 22) and len(data) == 1:
        peek = await recv_bytes(ws, 3, data[1:])
        word = struct.unpack("!I", bytes([first]) + peek)[0]
        if word == 0:
            return 0, peek
        if word == 2:
            return 2, b""
        if first <= 10:
            # treat as count byte
            ntypes = first
            rest = peek
            types_data = await recv_bytes(ws, ntypes, rest)
            types = list(types_data[:ntypes])
            if 2 not in types:
                return -1, types_data[ntypes:]
            await ws.send(bytes([2]))
            return 2, types_data[ntypes:]
    # fallback: 3.3 uint32 already buffered
    data = await recv_bytes(ws, 4, data[:1] if len(data) == 1 else data)
    sec_type = struct.unpack("!I", data[:4])[0]
    return sec_type, data[4:]


async def rfb_handshake_after_banner(
    ws, banner: bytes, password: str | None, buf: bytes = b""
) -> tuple[bool, str]:
    if not banner.startswith(b"RFB "):
        return False, f"bad banner: {banner[:20]!r}"

    # Match server version (003.008 etc.)
    await ws.send(banner)

    sec_type, rest = await read_security_type(ws, buf)

    if sec_type == 0:
        data = await recv_bytes(ws, 4, rest)
        reason_len = struct.unpack("!I", data[:4])[0]
        reason = (await recv_bytes(ws, reason_len))[ :reason_len].decode("utf-8", errors="replace")
        return False, f"security failure: {reason.strip()}"

    if sec_type == -1:
        return False, "no VncAuth security type offered"

    if sec_type != 2:
        return False, f"unsupported security type {sec_type} (need VncAuth=2)"

    challenge = (await recv_bytes(ws, 16, rest))[:16]
    if not password:
        return False, "password required but not provided"

    await ws.send(vnc_encrypt_password(password, challenge))

    result = struct.unpack("!I", await recv_bytes(ws, 4))[0]
    if result != 0:
        reason_len = struct.unpack("!I", await recv_bytes(ws, 4))[0]
        reason = (await recv_bytes(ws, reason_len))[:reason_len].decode("utf-8", errors="replace")
        return False, f"auth failed ({result}): {reason.strip()}"

    await recv_bytes(ws, 20)
    name_len = struct.unpack("!I", await recv_bytes(ws, 4))[0]
    name = (await recv_bytes(ws, name_len))[:name_len].decode("utf-8", errors="replace")
    return True, f"connected, desktop={name!r}"


async def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--connection-id", default="2pPrtCB")
    parser.add_argument("--port", type=int, default=5901)
    parser.add_argument("--password", default="")
    parser.add_argument("--try-ssh-password", action="store_true")
    parser.add_argument("--base", default="ws://127.0.0.1:8000")
    args = parser.parse_args()

    conn = load_connection(args.connection_id)
    password = args.password or conn.get("vnc_password") or ""
    if not password and args.try_ssh_password:
        password = conn.get("password") or ""

    session = "vnc-test-" + args.connection_id
    url = f"{args.base}/ws/vnc/{session}?connection_id={args.connection_id}&port={args.port}"
    print(f"WS {url}")
    print(f"host={conn.get('title')} vnc_port={args.port} pwd={'set' if password else 'MISSING'}")

    try:
        async with websockets.connect(url, max_size=None) as ws:
            first = await asyncio.wait_for(ws.recv(), timeout=15)
            if isinstance(first, str):
                print("TEXT:", first)
                return 2
            print("banner:", repr(first[:12]))
            banner = first[:12]
            rest = first[12:]
            ok, msg = await rfb_handshake_after_banner(ws, banner, password or None, rest)
            print("RESULT:", "OK" if ok else "FAIL", msg)
            return 0 if ok else 1
    except ConnectionClosed as e:
        print("WS closed:", e)
        return 2
    except Exception as e:
        import traceback

        traceback.print_exc()
        return 2


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
