"""Agent配置加载器。"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

import yaml

logger = logging.getLogger("agent.loader")

# 配置文件路径
REGISTRY_PATH = Path(__file__).parent / "agents.yaml"
PROMPTS_PATH = Path(__file__).parent.parent / "prompts"


class AgentConfig:
    """单个Agent的配置。"""

    def __init__(self, name: str, config: dict[str, Any]):
        self.name = name
        self.description = config.get("description", "")
        self.tool_modules = config.get("tools", [])
        self.prompt_file = config.get("prompt", "")
        self.model = config.get("model", "default")

    def load_prompt(self) -> str:
        """加载提示词内容。"""
        if not self.prompt_file:
            return ""

        prompt_path = PROMPTS_PATH / self.prompt_file
        if not prompt_path.exists():
            logger.warning(f"提示词文件不存在: {prompt_path}")
            return ""

        return prompt_path.read_text(encoding="utf-8")


class AgentRegistry:
    """Agent配置注册表。"""

    _instance: AgentRegistry | None = None
    _configs: dict[str, AgentConfig] = {}

    def __new__(cls) -> AgentRegistry:
        if cls._instance is None:
            cls._instance = super().__new__(cls)
            cls._instance._load()
        return cls._instance

    def _load(self) -> None:
        """加载配置文件。"""
        if not REGISTRY_PATH.exists():
            logger.warning(f"配置文件不存在: {REGISTRY_PATH}")
            return

        with open(REGISTRY_PATH, encoding="utf-8") as f:
            data = yaml.safe_load(f)

        agents = data.get("agents", {})
        for name, config in agents.items():
            self._configs[name] = AgentConfig(name, config)
            logger.info(f"加载Agent配置: {name}")

    def get(self, name: str) -> AgentConfig | None:
        """获取指定Agent的配置。"""
        return self._configs.get(name)

    def list_agents(self) -> list[str]:
        """列出所有已注册的Agent名称。"""
        return list(self._configs.keys())

    def reload(self) -> None:
        """重新加载配置。"""
        self._configs.clear()
        self._load()


# 便捷函数
def get_agent_config(name: str) -> AgentConfig | None:
    """获取Agent配置。"""
    return AgentRegistry().get(name)


def list_agents() -> list[str]:
    """列出所有Agent。"""
    return AgentRegistry().list_agents()
