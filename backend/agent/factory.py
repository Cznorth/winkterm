"""Agent 工厂，负责编译和缓存 Agent。"""

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
    """Agent 工厂，负责编译和管理 Agent 实例。"""

    _instance: AgentFactory | None = None
    _agents: dict[str, CompiledGraph] = {}

    def __new__(cls) -> AgentFactory:
        if cls._instance is None:
            cls._instance = super().__new__(cls)
        return cls._instance

    def compile(self, name: str) -> CompiledGraph:
        """编译指定名称的 Agent。

        Args:
            name: Agent 名称，如 "terminal", "analysis"

        Returns:
            编译后的 StateGraph
        """
        # 检查缓存
        if name in self._agents:
            logger.debug(f"[Factory] 从缓存获取 Agent: {name}")
            return self._agents[name]

        # 获取配置
        config = AgentRegistry().get(name)
        if config is None:
            raise ValueError(f"Agent '{name}' 未注册")

        # 获取工具
        tools = get_tools(config.tool_modules)
        if not tools:
            logger.warning(f"[Factory] Agent '{name}' 没有工具")

        # 获取提示词
        prompt = config.load_prompt()
        if not prompt:
            logger.warning(f"[Factory] Agent '{name}' 没有提示词")

        # 构建
        logger.info(f"[Factory] 编译 Agent: {name}")
        builder = AgentBuilder(
            name=name,
            prompt=prompt,
            tools=tools,
            model=config.model,
        )
        graph = builder.build()

        # 缓存
        self._agents[name] = graph
        return graph

    def get(self, name: str) -> CompiledGraph:
        """获取 Agent（等同于 compile）。"""
        return self.compile(name)

    def reload(self, name: str | None = None) -> None:
        """重新加载 Agent。

        Args:
            name: 指定 Agent 名称，None 则重载全部
        """
        if name:
            if name in self._agents:
                del self._agents[name]
                logger.info(f"[Factory] 清除缓存: {name}")
        else:
            self._agents.clear()
            AgentRegistry().reload()
            logger.info("[Factory] 清除全部缓存")


# 便捷函数
def get_agent(name: str) -> CompiledGraph:
    """获取编译后的 Agent。"""
    return AgentFactory().get(name)


def reload_agent(name: str | None = None) -> None:
    """重新加载 Agent。"""
    AgentFactory().reload(name)
