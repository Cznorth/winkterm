from __future__ import annotations

import asyncio
import base64
import hashlib
import http.server
import json
import platform
import secrets
import shutil
import ssl
import subprocess
import threading
import time
import urllib.parse
import uuid
import webbrowser
from datetime import datetime, timezone
from collections.abc import AsyncIterator
from pathlib import Path

import certifi
import httpx
import websockets

from langchain_core.messages import HumanMessage

from backend.agent.codex_protocol import codex_input_from_messages


CODEX_TIMEOUT_SECONDS = 180
CODEX_WS_URL = "wss://chatgpt.com/backend-api/codex/responses"
CODEX_DEFAULT_MODEL = "gpt-5.5"
CODEX_HOME = Path.home() / ".codex"
CODEX_AUTH_FILE = CODEX_HOME / "auth.json"
CODEX_OAUTH_FLOW_FILE = CODEX_HOME / "oauth_flow.json"
CODEX_OAUTH_HISTORY_FILE = CODEX_HOME / "oauth_flow_history.json"
CODEX_OAUTH_FLOW_TTL_SECONDS = 30 * 60
CODEX_OAUTH_HISTORY_MAX = 20
CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
CODEX_OAUTH_ISSUER = "https://auth.openai.com"
CODEX_OAUTH_PORTS = (1455, 1457)
CODEX_OAUTH_SCOPE = "openid profile email offline_access api.connectors.read api.connectors.invoke"
CODEX_OAUTH_ORIGINATOR = "codex_cli_rs"

_oauth_lock = threading.Lock()
_oauth_flow: dict | None = None
_oauth_server: http.server.ThreadingHTTPServer | None = None
_oauth_thread: threading.Thread | None = None


class CodexProviderError(RuntimeError):
    pass


def _codex_version() -> str:
    binary = shutil.which("codex")
    if not binary:
        return "0.142.5"
    try:
        proc = subprocess.run(
            [binary, "--version"],
            input="",
            text=True,
            capture_output=True,
            timeout=5,
        )
    except Exception:
        return "0.142.5"
    output = (proc.stdout or proc.stderr or "").strip()
    return output.split()[-1] if output else "0.142.5"


def _load_codex_tokens() -> dict:
    if not CODEX_AUTH_FILE.exists():
        raise CodexProviderError("Codex CLI is not logged in. Run codex login first.")
    data = json.loads(CODEX_AUTH_FILE.read_text(encoding="utf-8"))
    tokens = data.get("tokens") or {}
    if not tokens.get("access_token"):
        raise CodexProviderError("Codex auth file does not contain an access token. Run codex login again.")
    return tokens


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def _jwt_claims(jwt: str) -> dict:
    parts = jwt.split(".")
    if len(parts) < 2:
        return {}
    payload = parts[1] + "=" * (-len(parts[1]) % 4)
    try:
        data = json.loads(base64.urlsafe_b64decode(payload.encode("ascii")))
    except Exception:
        return {}
    auth_claims = data.get("https://api.openai.com/auth")
    return auth_claims if isinstance(auth_claims, dict) else data


def _account_id_from_tokens(id_token: str, access_token: str) -> str:
    for token in (id_token, access_token):
        claims = _jwt_claims(token)
        for key in ("chatgpt_account_id", "account_id"):
            value = claims.get(key)
            if isinstance(value, str) and value:
                return value
    return ""


def _save_codex_tokens(id_token: str, access_token: str, refresh_token: str) -> None:
    CODEX_HOME.mkdir(parents=True, exist_ok=True)
    existing = {}
    if CODEX_AUTH_FILE.exists():
        try:
            existing = json.loads(CODEX_AUTH_FILE.read_text(encoding="utf-8"))
        except Exception:
            existing = {}
    account_id = _account_id_from_tokens(id_token, access_token)
    existing.update({
        "tokens": {
            "id_token": id_token,
            "access_token": access_token,
            "refresh_token": refresh_token,
            "account_id": account_id,
        },
        "last_refresh": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    })
    CODEX_AUTH_FILE.write_text(json.dumps(existing, indent=2), encoding="utf-8")
    CODEX_AUTH_FILE.chmod(0o600)


def _oauth_flow_snapshot(flow: dict) -> dict:
    return {
        k: flow[k]
        for k in ("state", "oauth_state", "code_verifier", "redirect_uri", "auth_url", "started_at", "message")
        if k in flow
    }


def _append_oauth_flow_history(flow: dict) -> None:
    if not flow.get("code_verifier") or not flow.get("oauth_state"):
        return
    CODEX_HOME.mkdir(parents=True, exist_ok=True)
    history: list = []
    if CODEX_OAUTH_HISTORY_FILE.exists():
        try:
            raw = json.loads(CODEX_OAUTH_HISTORY_FILE.read_text(encoding="utf-8"))
            if isinstance(raw, list):
                history = raw
        except Exception:
            history = []
    entry = _oauth_flow_snapshot(flow)
    entry["state"] = "pending"
    history = [h for h in history if h.get("oauth_state") != entry.get("oauth_state")]
    history.append(entry)
    history = history[-CODEX_OAUTH_HISTORY_MAX:]
    CODEX_OAUTH_HISTORY_FILE.write_text(json.dumps(history, indent=2), encoding="utf-8")
    CODEX_OAUTH_HISTORY_FILE.chmod(0o600)


def _remove_oauth_flow_from_history(oauth_state: str) -> None:
    if not CODEX_OAUTH_HISTORY_FILE.exists():
        return
    try:
        raw = json.loads(CODEX_OAUTH_HISTORY_FILE.read_text(encoding="utf-8"))
    except Exception:
        return
    if not isinstance(raw, list):
        return
    trimmed = [h for h in raw if h.get("oauth_state") != oauth_state]
    if len(trimmed) == len(raw):
        return
    if trimmed:
        CODEX_OAUTH_HISTORY_FILE.write_text(json.dumps(trimmed, indent=2), encoding="utf-8")
    else:
        CODEX_OAUTH_HISTORY_FILE.unlink(missing_ok=True)


def _find_oauth_flow_for_state(oauth_state: str) -> dict:
    active = _get_active_oauth_flow()
    if active.get("oauth_state") == oauth_state and active.get("code_verifier"):
        return active
    if not CODEX_OAUTH_HISTORY_FILE.exists():
        return {}
    try:
        history = json.loads(CODEX_OAUTH_HISTORY_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {}
    if not isinstance(history, list):
        return {}
    now = time.time()
    for entry in reversed(history):
        if entry.get("oauth_state") != oauth_state:
            continue
        if not entry.get("code_verifier"):
            continue
        started = float(entry.get("started_at") or 0)
        if started and now - started > CODEX_OAUTH_FLOW_TTL_SECONDS:
            continue
        return dict(entry)
    return {}


def _persist_oauth_flow(flow: dict | None) -> None:
    CODEX_HOME.mkdir(parents=True, exist_ok=True)
    if not flow or flow.get("state") != "pending":
        if CODEX_OAUTH_FLOW_FILE.exists():
            try:
                stale = json.loads(CODEX_OAUTH_FLOW_FILE.read_text(encoding="utf-8"))
                if isinstance(stale, dict) and stale.get("state") == "pending":
                    _append_oauth_flow_history(stale)
            except Exception:
                pass
        try:
            CODEX_OAUTH_FLOW_FILE.unlink(missing_ok=True)
        except OSError:
            pass
        return
    CODEX_OAUTH_FLOW_FILE.write_text(json.dumps(flow, indent=2), encoding="utf-8")
    CODEX_OAUTH_FLOW_FILE.chmod(0o600)


def _load_persisted_oauth_flow() -> dict | None:
    if not CODEX_OAUTH_FLOW_FILE.exists():
        return None
    try:
        data = json.loads(CODEX_OAUTH_FLOW_FILE.read_text(encoding="utf-8"))
    except Exception:
        return None
    if not isinstance(data, dict) or data.get("state") != "pending":
        return None
    started = float(data.get("started_at") or 0)
    if started and time.time() - started > CODEX_OAUTH_FLOW_TTL_SECONDS:
        _persist_oauth_flow(None)
        return None
    return data


def _set_oauth_flow(state: str, message: str) -> None:
    with _oauth_lock:
        global _oauth_flow
        if _oauth_flow is not None:
            _oauth_flow["state"] = state
            _oauth_flow["message"] = message
            _oauth_flow["completed_at"] = time.time()
        if state != "pending":
            _persist_oauth_flow(None)
        elif _oauth_flow is not None:
            _persist_oauth_flow(dict(_oauth_flow))


def _get_active_oauth_flow() -> dict:
    global _oauth_flow
    with _oauth_lock:
        flow = dict(_oauth_flow or {})
    if flow.get("state") == "pending" and flow.get("code_verifier"):
        return flow
    disk = _load_persisted_oauth_flow()
    if disk:
        with _oauth_lock:
            _oauth_flow = disk
        return dict(disk)
    return {}


def _oauth_already_logged_in_message() -> str | None:
    if not CODEX_AUTH_FILE.exists():
        return None
    try:
        data = json.loads(CODEX_AUTH_FILE.read_text(encoding="utf-8"))
    except Exception:
        return None
    tokens = data.get("tokens") or {}
    if tokens.get("access_token"):
        return "Logged in using ChatGPT"
    return None


def _oauth_status() -> dict:
    flow = _get_active_oauth_flow()
    if not flow:
        with _oauth_lock:
            if _oauth_flow:
                flow = dict(_oauth_flow)
    if not flow:
        return {"active": False, "state": "idle", "message": ""}
    return {
        "active": flow.get("state") == "pending",
        "state": flow.get("state", "idle"),
        "message": flow.get("message", ""),
        "auth_url": flow.get("auth_url", ""),
        "started_at": flow.get("started_at", 0),
    }


def _oauth_status_public(*, logged_in: bool) -> dict:
    if logged_in:
        return {
            "active": False,
            "state": "complete",
            "message": "Logged in using ChatGPT",
            "auth_url": "",
            "started_at": 0,
        }
    return _oauth_status()


def _parse_oauth_callback_params(callback_url: str) -> dict[str, str]:
    """Parse query parameters from a pasted OAuth callback URL."""
    text = callback_url.strip()
    if not text:
        raise CodexProviderError("Callback URL is empty.")

    if "://" not in text:
        if text.startswith("/"):
            text = f"http://localhost{text}"
        elif text.startswith("?"):
            text = f"http://localhost/auth/callback{text}"
        else:
            text = f"http://localhost/auth/callback?{text}"

    parsed = urllib.parse.urlparse(text)
    return dict(urllib.parse.parse_qsl(parsed.query))


def _build_authorize_url(redirect_uri: str, state: str, code_challenge: str) -> str:
    query = {
        "response_type": "code",
        "client_id": CODEX_OAUTH_CLIENT_ID,
        "redirect_uri": redirect_uri,
        "scope": CODEX_OAUTH_SCOPE,
        "code_challenge": code_challenge,
        "code_challenge_method": "S256",
        "id_token_add_organizations": "true",
        "codex_cli_simplified_flow": "true",
        "state": state,
        "originator": CODEX_OAUTH_ORIGINATOR,
    }
    return f"{CODEX_OAUTH_ISSUER}/oauth/authorize?{urllib.parse.urlencode(query)}"


async def _exchange_oauth_code(code: str, redirect_uri: str, code_verifier: str) -> dict:
    data = {
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": redirect_uri,
        "client_id": CODEX_OAUTH_CLIENT_ID,
        "code_verifier": code_verifier,
    }
    async with httpx.AsyncClient(timeout=30.0, verify=certifi.where()) as client:
        resp = await client.post(
            f"{CODEX_OAUTH_ISSUER}/oauth/token",
            data=data,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
        if resp.status_code >= 400:
            raise CodexProviderError(f"token endpoint returned {resp.status_code}: {resp.text[:500]}")
        return resp.json()


class _CodexOAuthCallbackHandler(http.server.BaseHTTPRequestHandler):
    def log_message(self, format: str, *args) -> None:
        return

    def do_GET(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path != "/auth/callback":
            self.send_response(404)
            self.end_headers()
            return

        params = dict(urllib.parse.parse_qsl(parsed.query))
        flow = _find_oauth_flow_for_state(params.get("state") or "")

        if not flow or params.get("state") != flow.get("oauth_state"):
            self._finish(400, "WinkTerm Codex OAuth failed: state mismatch.")
            return
        if params.get("error"):
            message = params.get("error_description") or params.get("error") or "OAuth error"
            self._set_flow("error", message)
            self._finish(400, f"WinkTerm Codex OAuth failed: {message}")
            return
        code = params.get("code")
        if not code:
            self._set_flow("error", "Missing authorization code.")
            self._finish(400, "WinkTerm Codex OAuth failed: missing authorization code.")
            return

        try:
            tokens = asyncio.run(_exchange_oauth_code(code, flow["redirect_uri"], flow["code_verifier"]))
            _save_codex_tokens(tokens["id_token"], tokens["access_token"], tokens["refresh_token"])
        except Exception as e:
            self._set_flow("error", str(e))
            self._finish(500, "WinkTerm Codex OAuth token exchange failed. Return to WinkTerm and retry.")
            return

        self._set_flow("complete", "Logged in using ChatGPT")
        _remove_oauth_flow_from_history(flow.get("oauth_state") or "")
        self._finish(200, "WinkTerm Codex OAuth complete. You can close this tab.")

    def _set_flow(self, state: str, message: str) -> None:
        _set_oauth_flow(state, message)

    def _finish(self, status: int, message: str) -> None:
        body = (
            "<!doctype html><meta charset='utf-8'>"
            "<title>WinkTerm Codex OAuth</title>"
            f"<body style='font:14px system-ui;padding:32px'>{message}</body>"
        ).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def _ensure_oauth_server() -> int:
    global _oauth_server, _oauth_thread
    if _oauth_server and _oauth_thread and _oauth_thread.is_alive():
        return int(_oauth_server.server_port)

    last_error: Exception | None = None
    for port in CODEX_OAUTH_PORTS:
        try:
            server = http.server.ThreadingHTTPServer(("127.0.0.1", port), _CodexOAuthCallbackHandler)
        except OSError as e:
            last_error = e
            continue
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        _oauth_server = server
        _oauth_thread = thread
        return int(server.server_port)
    raise CodexProviderError(f"Unable to bind Codex OAuth callback server: {last_error}")


def start_codex_oauth(open_browser: bool = False) -> dict:
    port = _ensure_oauth_server()
    redirect_uri = f"http://localhost:{port}/auth/callback"
    code_verifier = _b64url(secrets.token_bytes(32))
    code_challenge = _b64url(hashlib.sha256(code_verifier.encode("ascii")).digest())
    state = _b64url(secrets.token_bytes(32))
    auth_url = _build_authorize_url(redirect_uri, state, code_challenge)

    with _oauth_lock:
        global _oauth_flow
        if _oauth_flow and _oauth_flow.get("state") == "pending":
            _append_oauth_flow_history(dict(_oauth_flow))
        disk_pending = _load_persisted_oauth_flow()
        if disk_pending:
            _append_oauth_flow_history(disk_pending)
        _oauth_flow = {
            "state": "pending",
            "message": "Waiting for browser authorization.",
            "oauth_state": state,
            "code_verifier": code_verifier,
            "redirect_uri": redirect_uri,
            "auth_url": auth_url,
            "started_at": time.time(),
        }
        _persist_oauth_flow(dict(_oauth_flow))
    if open_browser:
        webbrowser.open(auth_url)
    return {"auth_url": auth_url, "redirect_uri": redirect_uri, "state": "pending"}


def complete_codex_oauth_callback(callback_url: str) -> dict:
    """Finish OAuth using a callback URL pasted from the user's browser."""
    existing = _oauth_already_logged_in_message()
    if existing:
        _set_oauth_flow("complete", existing)
        return {"success": True, "message": existing, "already_logged_in": True}

    params = _parse_oauth_callback_params(callback_url)
    if params.get("error"):
        message = params.get("error_description") or params.get("error") or "OAuth error"
        _set_oauth_flow("error", message)
        raise CodexProviderError(message)

    code = params.get("code")
    state = params.get("state")
    if not code:
        raise CodexProviderError("Missing authorization code in callback URL.")
    if not state:
        raise CodexProviderError("Missing state in callback URL.")

    flow = _find_oauth_flow_for_state(state)
    if not flow or not flow.get("code_verifier"):
        existing = _oauth_already_logged_in_message()
        if existing:
            return {"success": True, "message": existing, "already_logged_in": True}
        raise CodexProviderError(
            "未找到对应的 Codex 登录会话（可能已过期）。请先点击「生成授权链接」，"
            "在浏览器完成授权后立刻粘贴回调 URL，不要再次点击生成以免 state 失效。"
        )
    if flow.get("state") != "pending":
        flow = {**flow, "state": "pending"}

    try:
        tokens = asyncio.run(
            _exchange_oauth_code(code, flow["redirect_uri"], flow["code_verifier"])
        )
        _save_codex_tokens(tokens["id_token"], tokens["access_token"], tokens["refresh_token"])
    except Exception as e:
        err = str(e)
        existing = _oauth_already_logged_in_message()
        if existing and ("invalid_grant" in err.lower() or "authorization code" in err.lower()):
            _set_oauth_flow("complete", existing)
            _remove_oauth_flow_from_history(state)
            return {"success": True, "message": existing, "already_logged_in": True}
        if "invalid_grant" in err.lower() or "authorization code" in err.lower():
            err = (
                f"{err} 授权码可能已被本机 localhost 回调用过。"
                "请先点「检查状态」；若仍未登录，再点「生成授权链接」重新授权并粘贴新的回调 URL。"
            )
        _set_oauth_flow("error", err)
        raise CodexProviderError(err) from e

    _remove_oauth_flow_from_history(state)
    _set_oauth_flow("complete", "Logged in using ChatGPT")
    return {"success": True, "message": "Logged in using ChatGPT"}


def _codex_bin() -> str:
    binary = shutil.which("codex")
    if not binary:
        raise CodexProviderError("Codex CLI is not installed. Install it, then run codex login.")
    return binary


def codex_status() -> dict:
    has_tokens = CODEX_AUTH_FILE.exists() and bool(_oauth_already_logged_in_message())
    oauth = _oauth_status_public(logged_in=has_tokens)
    try:
        binary = _codex_bin()
    except CodexProviderError as e:
        return {
            "installed": False,
            "logged_in": has_tokens,
            "message": "Logged in using ChatGPT" if has_tokens else str(e),
            "transport": "websocket",
            "oauth": oauth,
        }

    proc = subprocess.run(
        [binary, "login", "status"],
        input="",
        text=True,
        capture_output=True,
        timeout=15,
    )
    output = (proc.stdout or proc.stderr or "").strip()
    logged_in = has_tokens or proc.returncode == 0
    transport = "websocket" if has_tokens else "cli"
    return {
        "installed": True,
        "logged_in": logged_in,
        "message": "Logged in using ChatGPT" if logged_in and has_tokens else output,
        "transport": transport,
        "oauth": _oauth_status_public(logged_in=logged_in),
    }


def codex_login(device_auth: bool = True) -> dict:
    binary = _codex_bin()
    args = [binary, "login"]
    if device_auth:
        args.append("--device-auth")
    proc = subprocess.run(
        args,
        input="",
        text=True,
        capture_output=True,
        timeout=120,
    )
    output = (proc.stdout or proc.stderr or "").strip()
    return {
        "success": proc.returncode == 0,
        "message": output,
    }


def _codex_headers(tokens: dict) -> tuple[dict, str]:
    version = _codex_version()
    headers = {
        "Authorization": f"Bearer {tokens['access_token']}",
        "OpenAI-Beta": "responses_websockets=2026-02-06",
        "Version": version,
        "Originator": "codex_cli_rs",
        "session_id": str(uuid.uuid4()),
        "thread_id": str(uuid.uuid4()),
    }
    if tokens.get("account_id"):
        headers["ChatGPT-Account-ID"] = tokens["account_id"]
    user_agent = (
        f"codex_cli_rs/{version} "
        f"({platform.system()} {platform.release()}; {platform.machine()})"
    )
    return headers, user_agent


def _codex_request(prompt: str, model: str | None) -> dict:
    model_name = model or CODEX_DEFAULT_MODEL
    return {
        "type": "response.create",
        "model": model_name,
        "instructions": prompt,
        "input": codex_input_from_messages([HumanMessage(content=prompt)]),
        "tools": [],
        "tool_choice": "auto",
        "parallel_tool_calls": False,
        "store": False,
        "stream": True,
        "include": ["reasoning.encrypted_content"],
    }


async def stream_codex_response(
    *,
    instructions: str,
    input_items: list,
    model: str | None = None,
    tools: list | None = None,
) -> AsyncIterator[dict]:
    tokens = _load_codex_tokens()
    headers, user_agent = _codex_headers(tokens)
    body = {
        "type": "response.create",
        "model": model or CODEX_DEFAULT_MODEL,
        "instructions": instructions,
        "input": input_items,
        "tools": tools or [],
        "tool_choice": "auto",
        "parallel_tool_calls": False,
        "store": False,
        "stream": True,
        "include": ["reasoning.encrypted_content"],
    }
    ssl_context = ssl.create_default_context(cafile=certifi.where())

    last_error: Exception | None = None
    for attempt in range(2):
        try:
            async with websockets.connect(
                CODEX_WS_URL,
                additional_headers=headers,
                user_agent_header=user_agent,
                ssl=ssl_context,
                open_timeout=45,
                ping_interval=20,
            ) as websocket:
                await websocket.send(json.dumps(body, ensure_ascii=False))
                while True:
                    raw = await asyncio.wait_for(websocket.recv(), timeout=CODEX_TIMEOUT_SECONDS)
                    event = json.loads(raw)
                    yield event
                    kind = event.get("type")
                    if kind == "response.completed":
                        return
                    if kind == "error":
                        error = event.get("error") or {}
                        message = error.get("message") or json.dumps(event, ensure_ascii=False)
                        raise CodexProviderError(message)
        except (TimeoutError, OSError, websockets.WebSocketException) as e:
            last_error = e
            if attempt == 0:
                await asyncio.sleep(1)
                continue
            raise
    if last_error:
        raise last_error


async def stream_codex(prompt: str, model: str | None = None) -> AsyncIterator[str]:
    input_items = codex_input_from_messages([HumanMessage(content=prompt)])
    async for event in stream_codex_response(
        instructions=prompt,
        input_items=input_items,
        model=model,
        tools=[],
    ):
        kind = event.get("type")
        if kind == "response.output_text.delta":
            yield str(event.get("delta") or "")
        elif kind == "response.refusal.delta":
            yield str(event.get("delta") or "")


async def _run_codex_websocket(prompt: str, model: str | None = None) -> str:
    output: list[str] = []
    async for delta in stream_codex(prompt, model):
        output.append(delta)
    return "".join(output).strip()


async def run_codex(prompt: str, model: str | None = None) -> str:
    return await _run_codex_websocket(prompt, model)
