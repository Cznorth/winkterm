from __future__ import annotations

import json
from pathlib import Path
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # LLM (OpenAI 协议兼容)
    llm_api_key: str = ""
    llm_base_url: str = "https://qianfan.baidubce.com/v2/coding"
    llm_model: str = "glm-5"

    # 外部服务
    prometheus_url: str = "http://localhost:9090"
    loki_url: str = "http://localhost:3100"

    # 服务器
    host: str = "0.0.0.0"
    port: int = 8000
    debug: bool = False

    # CORS
    cors_origins: list[str] = ["http://localhost:3000", "http://127.0.0.1:3000"]


settings = Settings()


# 配置文件路径
_CONFIG_FILE = Path(__file__).parent.parent / "config.json"


class UserConfig:
    """用户配置（持久化到 config.json）"""

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
        _CONFIG_FILE.write_text(json.dumps(config, indent=2, ensure_ascii=False), encoding="utf-8")

    @staticmethod
    def get_masked() -> dict:
        """获取脱敏后的配置"""
        config = UserConfig.load()
        if config.get("api_key"):
            key = config["api_key"]
            config["api_key"] = key[:8] + "****" + key[-4:] if len(key) > 12 else "****"
        return config
