from __future__ import annotations

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
