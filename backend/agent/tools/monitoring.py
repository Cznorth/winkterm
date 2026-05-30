"""Monitoring and analysis tool module (used by the out-of-terminal Agent)."""

from __future__ import annotations

from langchain_core.tools import tool


@tool
def query_prometheus(query: str) -> str:
    """Query Prometheus metrics.

    Args:
        query: PromQL query statement
    """
    # TODO: integrate with a real Prometheus
    # This is a demo implementation
    return f"[Mock Prometheus] 查询: {query}\n结果: CPU使用率 45%, 内存使用率 62%"


@tool
def search_logs(service: str, keywords: str = "") -> str:
    """Search logs (Loki/ELK).

    Args:
        service: service name
        keywords: search keywords
    """
    # TODO: integrate with a real logging system
    return f"[Mock Logs] 服务: {service}, 关键词: {keywords}\n最近日志: [INFO] 服务正常运行"


# List of tools exported by this module
MONITORING_TOOLS = [query_prometheus, search_logs]
