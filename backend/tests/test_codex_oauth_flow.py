"""Tests for Codex OAuth flow persistence and callback completion."""

from __future__ import annotations

import json
import time
from unittest.mock import AsyncMock, patch

import pytest

from backend.agent import codex_provider as cp


@pytest.fixture(autouse=True)
def _isolate_codex_home(tmp_path, monkeypatch):
    home = tmp_path / "codex"
    monkeypatch.setattr(cp, "CODEX_HOME", home)
    monkeypatch.setattr(cp, "CODEX_AUTH_FILE", home / "auth.json")
    monkeypatch.setattr(cp, "CODEX_OAUTH_FLOW_FILE", home / "oauth_flow.json")
    monkeypatch.setattr(cp, "CODEX_OAUTH_HISTORY_FILE", home / "oauth_flow_history.json")
    with cp._oauth_lock:
        cp._oauth_flow = None
    yield
    cp._persist_oauth_flow(None)
    with cp._oauth_lock:
        cp._oauth_flow = None


def test_persisted_flow_survives_memory_clear():
    started = start = cp.start_codex_oauth(open_browser=False)
    assert started["state"] == "pending"
    with cp._oauth_lock:
        cp._oauth_flow = None
    flow = cp._get_active_oauth_flow()
    assert flow.get("state") == "pending"
    assert flow.get("auth_url") == started["auth_url"]


def test_complete_callback_without_memory_flow():
    cp.start_codex_oauth(open_browser=False)
    flow = cp._get_active_oauth_flow()
    callback = (
        f"http://localhost:1455/auth/callback?code=test_code&state={flow['oauth_state']}"
    )
    with cp._oauth_lock:
        cp._oauth_flow = None

    fake_tokens = {
        "id_token": "id",
        "access_token": "access",
        "refresh_token": "refresh",
    }
    with patch.object(cp, "_exchange_oauth_code", new_callable=AsyncMock, return_value=fake_tokens):
        result = cp.complete_codex_oauth_callback(callback)

    assert result["success"] is True
    assert cp.CODEX_AUTH_FILE.exists()


def test_complete_callback_from_history_after_new_start():
    cp.start_codex_oauth(open_browser=False)
    first = cp._get_active_oauth_flow()
    cp.start_codex_oauth(open_browser=False)
    callback = (
        f"http://localhost:1455/auth/callback?code=hist_code&state={first['oauth_state']}"
    )
    fake_tokens = {
        "id_token": "id",
        "access_token": "access",
        "refresh_token": "refresh",
    }
    with patch.object(cp, "_exchange_oauth_code", new_callable=AsyncMock, return_value=fake_tokens):
        result = cp.complete_codex_oauth_callback(callback)
    assert result["success"] is True


def test_codex_status_oauth_complete_when_logged_in(tmp_path, monkeypatch):
    home = tmp_path / "codex"
    home.mkdir()
    monkeypatch.setattr(cp, "CODEX_HOME", home)
    monkeypatch.setattr(cp, "CODEX_AUTH_FILE", home / "auth.json")
    (home / "auth.json").write_text(
        json.dumps({"tokens": {"access_token": "x", "id_token": "y", "refresh_token": "z"}}),
        encoding="utf-8",
    )
    with cp._oauth_lock:
        cp._oauth_flow = {
            "state": "pending",
            "message": "Waiting for browser authorization.",
            "oauth_state": "st",
            "code_verifier": "v",
            "redirect_uri": "http://localhost:1455/auth/callback",
            "auth_url": "https://example.com",
            "started_at": 1,
        }
    cp._persist_oauth_flow(dict(cp._oauth_flow))
    st = cp.codex_status()
    assert st["logged_in"] is True
    assert st["oauth"]["state"] == "complete"
    assert "Waiting" not in st["oauth"]["message"]


def test_complete_callback_when_already_logged_in():
    cp.CODEX_HOME.mkdir(parents=True, exist_ok=True)
    cp.CODEX_AUTH_FILE.write_text(
        json.dumps({"tokens": {"access_token": "x", "id_token": "y", "refresh_token": "z"}}),
        encoding="utf-8",
    )
    callback = "http://localhost:1455/auth/callback?code=ac_used&state=wrong"
    result = cp.complete_codex_oauth_callback(callback)
    assert result.get("already_logged_in") is True