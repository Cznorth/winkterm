"""Agent configuration loader with language support."""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

import yaml

logger = logging.getLogger("agent.loader")

# Configuration paths
REGISTRY_PATH = Path(__file__).parent / "agents.yaml"
PROMPTS_PATH = Path(__file__).parent.parent / "prompts"


class AgentConfig:
    """Configuration for a single agent."""

    def __init__(self, name: str, config: dict[str, Any]):
        self.name = name
        self.description = config.get("description", "")
        self.tool_modules = config.get("tools", [])
        self.prompt_file = config.get("prompt", "")
        self.model = config.get("model", "default")

    def load_prompt(self, lang: str = "en") -> str:
        """Load the prompt content, respecting language preference.

        Args:
            lang: Language code ('en' or 'zh'). Falls back to default if translated file missing.
        """
        if not self.prompt_file:
            return ""

        # Try language-specific prompt first
        if lang == "zh":
            zh_path = PROMPTS_PATH / self.prompt_file.replace(".yaml", ".zh.yaml")
            if zh_path.exists():
                return zh_path.read_text(encoding="utf-8")

        # Fall back to default
        prompt_path = PROMPTS_PATH / self.prompt_file
        if not prompt_path.exists():
            logger.warning(f"Prompt file not found: {prompt_path}")
            return ""

        return prompt_path.read_text(encoding="utf-8")


class AgentRegistry:
    """Agent configuration registry (singleton)."""

    _instance: AgentRegistry | None = None
    _configs: dict[str, AgentConfig] = {}

    def __new__(cls) -> AgentRegistry:
        if cls._instance is None:
            cls._instance = super().__new__(cls)
            cls._instance._load()
        return cls._instance

    def _load(self) -> None:
        """Load configuration from YAML."""
        if not REGISTRY_PATH.exists():
            logger.warning(f"Config file not found: {REGISTRY_PATH}")
            return

        with open(REGISTRY_PATH, encoding="utf-8") as f:
            data = yaml.safe_load(f)

        agents = data.get("agents", {})
        for name, config in agents.items():
            self._configs[name] = AgentConfig(name, config)
            logger.info(f"Loaded agent config: {name}")

    def get(self, name: str) -> AgentConfig | None:
        """Get configuration for a named agent."""
        return self._configs.get(name)

    def list_agents(self) -> list[str]:
        """List all registered agent names."""
        return list(self._configs.keys())

    def reload(self) -> None:
        """Reload all configurations."""
        self._configs.clear()
        self._load()


# Convenience functions
def get_agent_config(name: str) -> AgentConfig | None:
    """Get agent configuration."""
    return AgentRegistry().get(name)


def list_agents() -> list[str]:
    """List all agents."""
    return AgentRegistry().list_agents()
