from __future__ import annotations

import json
from pathlib import Path
from typing import Any
from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # LLM (OpenAI-compatible protocol)
    # Accept any of these env var names:
    llm_api_key: str = ""
    anthropic_api_key: str = ""
    openai_api_key: str = ""
    llm_base_url: str = ""
    openai_base_url: str = ""
    llm_model: str = "claude-sonnet-4-20250514"

    @property
    def effective_api_key(self) -> str:
        """Return the first non-empty API key."""
        return self.anthropic_api_key or self.openai_api_key or self.llm_api_key or ""

    @property
    def effective_base_url(self) -> str:
        """Return the first non-empty base URL."""
        return self.openai_base_url or self.llm_base_url or ""

    @property
    def effective_model(self) -> str:
        return self.llm_model or "claude-sonnet-4-20250514"

    # External services
    prometheus_url: str = "http://localhost:9090"
    loki_url: str = "http://localhost:3100"

    # Server
    host: str = "0.0.0.0"
    port: int = 8000
    debug: bool = False

    # CORS (dev mode + desktop mode)
    cors_origins: list[str] = ["*"]

    # Agent settings
    agent_recursion_limit: int = 100

    # Auth token for external agent HTTP API (/api/agent/* disabled when empty)
    agent_api_token: str = ""

    # Web remote access key (localhost desktop client exempt; remote access requires this key)
    web_access_key: str = ""

    @field_validator("debug", mode="before")
    @classmethod
    def parse_debug(cls, v: Any) -> bool:
        """Lenient boolean parsing for invalid env var values."""
        if isinstance(v, bool):
            return v
        if isinstance(v, str):
            return v.lower() in ("true", "1", "yes", "on")
        return bool(v)


settings = Settings()


# Config file path (desktop mode: ~/.winkterm/config.json)
_CONFIG_DIR = Path.home() / ".winkterm"
_CONFIG_FILE = _CONFIG_DIR / "config.json"


def _ensure_config_dir():
    """Ensure config directory exists."""
    _CONFIG_DIR.mkdir(parents=True, exist_ok=True)


class UserConfig:
    """User configuration persisted to ~/.winkterm/config.json"""

    @staticmethod
    def load() -> dict:
        """Load config and return as a dict."""
        if _CONFIG_FILE.exists():
            return json.loads(_CONFIG_FILE.read_text(encoding="utf-8"))
        return {
            "api_format": "openai",
            "base_url": "",
            "api_key": "",
            "models": [],
            "selected_model": "",
            "language": "",
            "theme": "system",
            "web_access_key": "",
        }

    @staticmethod
    def save(config: dict) -> None:
        """Save config."""
        _ensure_config_dir()
        _CONFIG_FILE.write_text(json.dumps(config, indent=2, ensure_ascii=False), encoding="utf-8")

    @staticmethod
    def merge_save(config: dict) -> None:
        """Merge-save config, preserving fields not in the update (e.g. ssh_connections)."""
        original = UserConfig.load()
        original.update(config)
        UserConfig.save(original)

    @staticmethod
    def _mask_secret(value: str) -> str:
        """Mask a secret: keep head/tail when long, fully hide when short."""
        return value[:8] + "****" + value[-4:] if len(value) > 12 else "****"

    @staticmethod
    def get_masked() -> dict:
        """Return config with secrets masked."""
        config = UserConfig.load()
        if config.get("api_key"):
            config["api_key"] = UserConfig._mask_secret(config["api_key"])
        if config.get("agent_api_token"):
            config["agent_api_token"] = UserConfig._mask_secret(config["agent_api_token"])
        if config.get("web_access_key"):
            config["web_access_key"] = UserConfig._mask_secret(config["web_access_key"])
        return config


# AI instructions and memory file paths (same directory as config.json)
AGENTS_MD_FILE = _CONFIG_DIR / "agents.md"
MEMORY_MD_FILE = _CONFIG_DIR / "memory.md"


class AgentDocs:
    """User instructions (agents.md) and AI long-term memory (memory.md), persisted under ~/.winkterm/."""

    @staticmethod
    def read_agents() -> str:
        return AGENTS_MD_FILE.read_text(encoding="utf-8") if AGENTS_MD_FILE.exists() else ""

    @staticmethod
    def write_agents(content: str) -> None:
        _ensure_config_dir()
        AGENTS_MD_FILE.write_text(content, encoding="utf-8")

    @staticmethod
    def read_memory() -> str:
        return MEMORY_MD_FILE.read_text(encoding="utf-8") if MEMORY_MD_FILE.exists() else ""

    @staticmethod
    def write_memory(content: str) -> None:
        """Overwrite memory in full; backup previous content to memory.md.bak before write."""
        _ensure_config_dir()
        if MEMORY_MD_FILE.exists():
            (_CONFIG_DIR / "memory.md.bak").write_text(
                MEMORY_MD_FILE.read_text(encoding="utf-8"), encoding="utf-8"
            )
        MEMORY_MD_FILE.write_text(content, encoding="utf-8")
