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

    # LLM (OpenAI 协议兼容)
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

    # 外部服务
    prometheus_url: str = "http://localhost:9090"
    loki_url: str = "http://localhost:3100"

    # 服务器
    host: str = "0.0.0.0"
    port: int = 8000
    debug: bool = False

    # CORS（开发模式 + 桌面模式）
    cors_origins: list[str] = ["*"]

    # Agent 配置
    agent_recursion_limit: int = 100

    @field_validator("debug", mode="before")
    @classmethod
    def parse_debug(cls, v: Any) -> bool:
        """宽松解析布尔值，处理无效环境变量"""
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
        """加载配置，返回字典"""
        if _CONFIG_FILE.exists():
            return json.loads(_CONFIG_FILE.read_text(encoding="utf-8"))
        return {
            "api_format": "openai",
            "base_url": "",
            "api_key": "",
            "models": [],
            "selected_model": "",
        }

    @staticmethod
    def save(config: dict) -> None:
        """保存配置"""
        _ensure_config_dir()
        _CONFIG_FILE.write_text(json.dumps(config, indent=2, ensure_ascii=False), encoding="utf-8")

    @staticmethod
    def merge_save(config: dict) -> None:
        """合并保存配置，保留未在 config 中的字段（如 ssh_connections）"""
        original = UserConfig.load()
        original.update(config)
        UserConfig.save(original)

    @staticmethod
    def get_masked() -> dict:
        """获取脱敏后的配置"""
        config = UserConfig.load()
        if config.get("api_key"):
            key = config["api_key"]
            config["api_key"] = key[:8] + "****" + key[-4:] if len(key) > 12 else "****"
        return config
