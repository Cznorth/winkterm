from __future__ import annotations

import pytest

from backend.agent.codex_provider import (
    CodexProviderError,
    validate_codex_model,
    is_codex_model_allowed,
)


def test_validate_codex_model_allows_gpt():
    assert validate_codex_model("gpt-5.5") == "gpt-5.5"
    assert validate_codex_model("gpt-5.4-mini") == "gpt-5.4-mini"
    assert validate_codex_model("") == "gpt-5.4-mini"
    assert validate_codex_model(None) == "gpt-5.4-mini"


def test_validate_codex_model_rejects_glm():
    with pytest.raises(CodexProviderError) as exc:
        validate_codex_model("glm-5.1")
    assert "glm-5.1" in str(exc.value)
    assert "ChatGPT account" in str(exc.value)


def test_is_codex_model_allowed():
    assert is_codex_model_allowed("gpt-5.5")
    assert not is_codex_model_allowed("glm-5.1")