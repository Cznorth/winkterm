"""Agent factory — compiles and caches agent graphs."""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from backend.agent.core.builder import AgentBuilder
from backend.agent.registry.loader import AgentRegistry, AgentConfig
from backend.agent.tools import get_tools

if TYPE_CHECKING:
    from langgraph.graph import CompiledGraph

logger = logging.getLogger("agent.factory")


class AgentFactory:
    """Agent factory, responsible for compiling and managing agent instances."""

    _instance: AgentFactory | None = None
    _agents: dict[str, CompiledGraph] = {}

    def __new__(cls) -> AgentFactory:
        if cls._instance is None:
            cls._instance = super().__new__(cls)
        return cls._instance

    def compile(self, name: str, lang: str = "en") -> CompiledGraph:
        """Compile an agent by name.

        Args:
            name: Agent name, e.g. "terminal", "chat", "craft"
            lang: Language for prompts ("en" or "zh", defaults to "en")

        Returns:
            Compiled StateGraph
        """
        # Check cache
        cache_key = f"{name}_{lang}"
        if cache_key in self._agents:
            logger.debug(f"[Factory] Cache hit: {cache_key}")
            return self._agents[cache_key]

        # Get config
        config = AgentRegistry().get(name)
        if config is None:
            raise ValueError(f"Agent '{name}' not registered")

        # Load tools
        tools = get_tools(config.tool_modules)
        if not tools:
            logger.warning(f"[Factory] Agent '{name}' has no tools loaded")

        # Load prompt with language support
        prompt = config.load_prompt(lang=lang)
        if not prompt:
            logger.warning(f"[Factory] Agent '{name}' has no prompt")

        # Build
        logger.info(f"[Factory] Compiling agent: {name} (lang={lang})")
        builder = AgentBuilder(
            name=name,
            prompt=prompt,
            tools=tools,
            model=config.model,
        )
        graph = builder.build()

        # Cache
        self._agents[cache_key] = graph
        return graph

    def get(self, name: str, lang: str = "en") -> CompiledGraph:
        """Get an agent (alias for compile)."""
        return self.compile(name, lang=lang)

    def reload(self, name: str | None = None, lang: str | None = None) -> None:
        """Reload agent(s), clearing caches.

        Args:
            name: Specific agent name to clear, or None for all
            lang: Language variant to clear, or None for all variants
        """
        if name:
            if lang:
                cache_key = f"{name}_{lang}"
                self._agents.pop(cache_key, None)
                logger.info(f"[Factory] Cleared cache: {cache_key}")
            else:
                # Clear all variants of this agent
                keys = [k for k in self._agents if k.startswith(f"{name}_")]
                for k in keys:
                    del self._agents[k]
                logger.info(f"[Factory] Cleared cache: {name}_*")
        else:
            self._agents.clear()
            AgentRegistry().reload()
            logger.info("[Factory] Cleared all caches")


# Convenience functions
def get_agent(name: str, lang: str = "en") -> CompiledGraph:
    """Get a compiled agent graph."""
    return AgentFactory().get(name, lang=lang)


def reload_agent(name: str | None = None, lang: str | None = None) -> None:
    """Reload agent(s)."""
    AgentFactory().reload(name, lang=lang)
