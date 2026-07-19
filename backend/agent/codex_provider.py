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
CODEX_DEFAULT_MODEL = "gpt-5.4-mini"
CODEX_PREMIUM_MODEL = "gpt-5.5"
CODEX_FALLBACK_MODEL = "gpt-5.4-mini"
CODEX_ALLOWED_MODEL_IDS: frozenset[str] = frozenset({"gpt-5.5", "gpt-5.4-mini"})
# Reported on Codex WebSocket as codex_cli_rs; WinkTerm implements the protocol in-process.
# Default matches @openai/codex npm dist-tags.latest; override via env or ~/.winkterm/config.json.
WINKTERM_CODEX_CLIENT_VERSION = "0.142.5"


def _is_codex_version_gate_error(message: str) -> bool:
    lower = (message or "").lower()
    return "newer version" in lower and "codex" in lower


def is_codex_model_allowed(model: str | None) -> bool:
    if not model or not str(model).strip():
        return False
    return str(model).strip() in CODEX_ALLOWED_MODEL_IDS


def normalize_codex_model(model: str | None) -> str:
    """Return a Codex WebSocket model id; fall back to default when missing or invalid."""
    name = (model or "").strip()
    if name in CODEX_ALLOWED_MODEL_IDS:
        return name
    return CODEX_DEFAULT_MODEL


def validate_codex_model(model: str | None) -> str:
    """Like normalize_codex_model but raises when the user picked a non-Codex model id."""
    name = (model or "").strip()
    if not name:
        return CODEX_DEFAULT_MODEL
    if name in CODEX_ALLOWED_MODEL_IDS:
        return name
    allowed = ", ".join(sorted(CODEX_ALLOWED_MODEL_IDS))
    raise CodexProviderError(
        f"The '{name}' model is not supported when using Codex with a ChatGPT account. "
        f"Use one of: {allowed}."
    )


CODEX_HOME = Path.home() / ".codex"
CODEX_AUTH_FILE = CODEX_HOME / "auth.json"
WINKTERM_HOME = Path.home() / ".winkterm"
WINKTERM_CODEX_AUTH_FILE = WINKTERM_HOME / "codex_auth.json"
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


def _parse_codex_cli_version_output(text: str) -> str:
    """Extract semver from `codex --version` output (e.g. 'codex-cli 0.142.5')."""
    import re

    match = re.search(r"(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)", text or "")
    return match.group(1) if match else ""


def _installed_codex_cli_version() -> str:
    binary = shutil.which("codex")
    if not binary:
        return ""
    try:
        proc = subprocess.run(
            [binary, "--version"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        out = (proc.stdout or proc.stderr or "").strip()
        return _parse_codex_cli_version_output(out) if proc.returncode == 0 else ""
    except Exception:
        return ""


def _codex_version_from_user_config() -> str:
    try:
        from backend.config import UserConfig

        raw = (UserConfig.load().get("codex_client_version") or "").strip()
        return raw
    except Exception:
        return ""


def _codex_version() -> str:
    """Version sent on Codex WebSocket Version / User-Agent headers."""
    import os

    for candidate in (
        os.environ.get("WINKTERM_CODEX_CLIENT_VERSION", "").strip(),
        _codex_version_from_user_config(),
        WINKTERM_CODEX_CLIENT_VERSION,
        _installed_codex_cli_version(),
    ):
        if candidate:
            return candidate
    return WINKTERM_CODEX_CLIENT_VERSION


def codex_client_version_info() -> dict:
    """Effective client version and where it came from (for settings / debugging)."""
    import os

    env_v = os.environ.get("WINKTERM_CODEX_CLIENT_VERSION", "").strip()
    cfg_v = _codex_version_from_user_config()
    cli_v = _installed_codex_cli_version()
    effective = _codex_version()
    if env_v:
        source = "env"
    elif cfg_v:
        source = "config"
    elif effective == WINKTERM_CODEX_CLIENT_VERSION and not cfg_v and not env_v:
        source = "default"
    elif cli_v and effective == cli_v:
        source = "codex_cli"
    else:
        source = "default"
    return {
        "effective": effective,
        "source": source,
        "default": WINKTERM_CODEX_CLIENT_VERSION,
        "config": cfg_v,
        "codex_cli": cli_v,
    }


def _load_codex_tokens() -> dict:
    if not WINKTERM_CODEX_AUTH_FILE.exists():
        raise CodexProviderError("WinkTerm is not authorized for Codex. Authorize Codex in Settings first.")
    data = json.loads(WINKTERM_CODEX_AUTH_FILE.read_text(encoding="utf-8"))
    tokens = data.get("tokens") or {}
    if not tokens.get("access_token"):
        raise CodexProviderError("WinkTerm Codex authorization does not contain an access token. Authorize again.")
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
    WINKTERM_HOME.mkdir(parents=True, exist_ok=True)
    existing = {}
    if WINKTERM_CODEX_AUTH_FILE.exists():
        try:
            existing = json.loads(WINKTERM_CODEX_AUTH_FILE.read_text(encoding="utf-8"))
        except Exception:
            existing = {}
    account_id = _account_id_from_tokens(id_token, access_token)
    existing.update({
        "source": "winkterm_codex_oauth",
        "tokens": {
            "id_token": id_token,
            "access_token": access_token,
            "refresh_token": refresh_token,
            "account_id": account_id,
        },
        "last_refresh": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    })
    existing.pop("last_validated", None)
    existing.pop("validation_error", None)
    existing.pop("validation_invalid_at", None)
    WINKTERM_CODEX_AUTH_FILE.write_text(json.dumps(existing, indent=2), encoding="utf-8")
    WINKTERM_CODEX_AUTH_FILE.chmod(0o600)


def _update_codex_validation(*, valid: bool, error: str = "") -> None:
    """Persist credential validation state without changing OAuth tokens."""
    if not WINKTERM_CODEX_AUTH_FILE.exists():
        return
    try:
        data = json.loads(WINKTERM_CODEX_AUTH_FILE.read_text(encoding="utf-8"))
    except Exception:
        return
    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    data["last_validated"] = now
    if valid:
        data.pop("validation_error", None)
        data.pop("validation_invalid_at", None)
    else:
        data["validation_error"] = error
        data["validation_invalid_at"] = now
    WINKTERM_CODEX_AUTH_FILE.write_text(json.dumps(data, indent=2), encoding="utf-8")
    WINKTERM_CODEX_AUTH_FILE.chmod(0o600)


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
    with _oauth_lock:
        current = dict(_oauth_flow or {})
    if current.get("oauth_state") == oauth_state and current.get("code_verifier"):
        started = float(current.get("started_at") or 0)
        if not started or time.time() - started <= CODEX_OAUTH_FLOW_TTL_SECONDS:
            return current

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


def _clear_oauth_flow_file() -> None:
    try:
        CODEX_OAUTH_FLOW_FILE.unlink(missing_ok=True)
    except OSError:
        pass


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
            _clear_oauth_flow_file()
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
    if not WINKTERM_CODEX_AUTH_FILE.exists():
        return None
    try:
        data = json.loads(WINKTERM_CODEX_AUTH_FILE.read_text(encoding="utf-8"))
    except Exception:
        return None
    if data.get("validation_error"):
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


async def _refresh_codex_tokens(tokens: dict) -> dict:
    """Refresh an expired Codex access token and persist rotated credentials."""
    refresh_token = str(tokens.get("refresh_token") or "")
    if not refresh_token:
        raise CodexProviderError(
            "Codex authorization expired and cannot be refreshed. Authorize Codex again in Settings."
        )

    data = {
        "grant_type": "refresh_token",
        "refresh_token": refresh_token,
        "client_id": CODEX_OAUTH_CLIENT_ID,
    }
    async with httpx.AsyncClient(timeout=30.0, verify=certifi.where()) as client:
        resp = await client.post(
            f"{CODEX_OAUTH_ISSUER}/oauth/token",
            data=data,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
        if resp.status_code >= 400:
            raise CodexProviderError(
                f"Codex authorization refresh failed ({resp.status_code}). "
                "Authorize Codex again in Settings."
            )
        refreshed = resp.json()

    access_token = str(refreshed.get("access_token") or "")
    if not access_token:
        raise CodexProviderError(
            "Codex authorization refresh did not return an access token. "
            "Authorize Codex again in Settings."
        )
    _save_codex_tokens(
        str(refreshed.get("id_token") or tokens.get("id_token") or ""),
        access_token,
        str(refreshed.get("refresh_token") or refresh_token),
    )
    return _load_codex_tokens()


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
    auth_data: dict = {}
    if WINKTERM_CODEX_AUTH_FILE.exists():
        try:
            auth_data = json.loads(WINKTERM_CODEX_AUTH_FILE.read_text(encoding="utf-8"))
        except Exception:
            auth_data = {}
    validation_error = str(auth_data.get("validation_error") or "")
    last_validated = str(auth_data.get("last_validated") or "")
    credential_valid = False if validation_error else (True if last_validated else None)
    has_tokens = WINKTERM_CODEX_AUTH_FILE.exists() and bool(_oauth_already_logged_in_message())
    oauth = _oauth_status_public(logged_in=has_tokens)
    if validation_error:
        oauth = {
            "active": False,
            "state": "error",
            "message": validation_error,
            "auth_url": "",
            "started_at": 0,
        }
    try:
        binary = _codex_bin()
    except CodexProviderError as e:
        return {
            "installed": False,
            "logged_in": has_tokens,
            "message": validation_error or ("Logged in using ChatGPT" if has_tokens else str(e)),
            "transport": "websocket",
            "oauth": oauth,
            "credential_valid": credential_valid,
            "last_validated": last_validated,
            "client_version": codex_client_version_info(),
        }

    proc = subprocess.run(
        [binary, "login", "status"],
        input="",
        text=True,
        capture_output=True,
        timeout=15,
    )
    output = (proc.stdout or proc.stderr or "").strip()
    cli_logged_in = proc.returncode == 0
    transport = "websocket" if has_tokens else "cli"
    return {
        "installed": True,
        "logged_in": has_tokens,
        "cli_logged_in": cli_logged_in,
        "message": validation_error or ("Logged in using ChatGPT" if has_tokens else output),
        "transport": transport,
        "oauth": oauth,
        "credential_valid": credential_valid,
        "last_validated": last_validated,
        "client_version": codex_client_version_info(),
    }


async def _probe_codex_authorization(tokens: dict) -> None:
    """Open and close the production Codex WebSocket without creating a response."""
    headers, user_agent = _codex_headers(tokens)
    ssl_context = ssl.create_default_context(cafile=certifi.where())
    async with websockets.connect(
        CODEX_WS_URL,
        additional_headers=headers,
        user_agent_header=user_agent,
        ssl=ssl_context,
        open_timeout=45,
        ping_interval=None,
    ):
        return


def _websocket_status_code(exc: Exception) -> int | None:
    response = getattr(exc, "response", None)
    status_code = getattr(response, "status_code", None)
    return status_code if isinstance(status_code, int) else None


async def validate_codex_authorization() -> dict:
    """Validate saved Codex credentials online, refreshing once after HTTP 401."""
    try:
        tokens = _load_codex_tokens()
    except CodexProviderError as exc:
        result = codex_status()
        result.update({"credential_valid": False, "validation_error": str(exc)})
        return result

    try:
        await _probe_codex_authorization(tokens)
    except websockets.WebSocketException as exc:
        if _websocket_status_code(exc) not in {401, 403}:
            result = codex_status()
            result.update({"credential_valid": None, "validation_error": str(exc)})
            return result
        try:
            tokens = await _refresh_codex_tokens(tokens)
        except CodexProviderError as refresh_exc:
            message = str(refresh_exc)
            _update_codex_validation(valid=False, error=message)
            result = codex_status()
            result.update({"credential_valid": False, "validation_error": message})
            return result
        except Exception as refresh_exc:
            result = codex_status()
            result.update({"credential_valid": None, "validation_error": str(refresh_exc)})
            return result
        try:
            await _probe_codex_authorization(tokens)
        except websockets.WebSocketException as retry_exc:
            if _websocket_status_code(retry_exc) not in {401, 403}:
                result = codex_status()
                result.update({"credential_valid": None, "validation_error": str(retry_exc)})
                return result
            message = (
                f"Codex authorization was rejected ({_websocket_status_code(retry_exc)}). "
                "Authorize Codex again in Settings."
            )
            _update_codex_validation(valid=False, error=message)
            result = codex_status()
            result.update({"credential_valid": False, "validation_error": message})
            return result
        except (TimeoutError, OSError) as retry_exc:
            result = codex_status()
            result.update({"credential_valid": None, "validation_error": str(retry_exc)})
            return result
    except (TimeoutError, OSError) as exc:
        result = codex_status()
        result.update({"credential_valid": None, "validation_error": str(exc)})
        return result

    _update_codex_validation(valid=True)
    result = codex_status()
    result.update({"credential_valid": True, "validation_error": ""})
    return result


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


def codex_logout() -> dict:
    """Remove WinkTerm's locally stored Codex OAuth credentials."""
    try:
        WINKTERM_CODEX_AUTH_FILE.unlink(missing_ok=True)
    except OSError as e:
        raise CodexProviderError(f"Failed to remove WinkTerm Codex auth file: {e}") from e
    _set_oauth_flow("idle", "")
    return {"success": True}


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


async def _stream_codex_response_once(
    *,
    instructions: str,
    input_items: list,
    model: str,
    tools: list | None,
) -> AsyncIterator[dict]:
    tokens = _load_codex_tokens()
    body = {
        "type": "response.create",
        "model": model,
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
        headers, user_agent = _codex_headers(tokens)
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
                response = getattr(e, "response", None)
                if getattr(response, "status_code", None) == 401:
                    tokens = await _refresh_codex_tokens(tokens)
                    continue
                await asyncio.sleep(1)
                continue
            raise
    if last_error:
        raise last_error


async def stream_codex_response(
    *,
    instructions: str,
    input_items: list,
    model: str | None = None,
    tools: list | None = None,
) -> AsyncIterator[dict]:
    model_name = normalize_codex_model(model)
    try:
        async for event in _stream_codex_response_once(
            instructions=instructions,
            input_items=input_items,
            model=model_name,
            tools=tools,
        ):
            yield event
    except CodexProviderError as e:
        if model_name == CODEX_PREMIUM_MODEL and _is_codex_version_gate_error(str(e)):
            async for event in _stream_codex_response_once(
                instructions=instructions,
                input_items=input_items,
                model=CODEX_FALLBACK_MODEL,
                tools=tools,
            ):
                yield event
        else:
            raise


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
    name = normalize_codex_model(model)
    try:
        return await _run_codex_websocket(prompt, name)
    except CodexProviderError as e:
        if name == CODEX_PREMIUM_MODEL and _is_codex_version_gate_error(str(e)):
            return await _run_codex_websocket(prompt, CODEX_FALLBACK_MODEL)
        raise
