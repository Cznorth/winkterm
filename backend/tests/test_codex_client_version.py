from __future__ import annotations

import backend.agent.codex_provider as cp


def test_parse_codex_cli_version_output():
    assert cp._parse_codex_cli_version_output("codex-cli 0.121.0") == "0.121.0"
    assert cp._parse_codex_cli_version_output("0.143.0-alpha.35") == "0.143.0-alpha.35"


def test_is_codex_version_gate_error():
    assert cp._is_codex_version_gate_error(
        "The 'gpt-5.5' model requires a newer version of Codex."
    )
    assert not cp._is_codex_version_gate_error("rate limited")


def test_codex_version_prefers_config(monkeypatch):
    monkeypatch.delenv("WINKTERM_CODEX_CLIENT_VERSION", raising=False)
    monkeypatch.setattr(cp, "_installed_codex_cli_version", lambda: "0.121.0")
    monkeypatch.setattr(
        cp,
        "_codex_version_from_user_config",
        lambda: "0.999.0",
    )
    assert cp._codex_version() == "0.999.0"