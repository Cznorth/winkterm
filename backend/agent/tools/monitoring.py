"""监控分析工具模块（终端外Agent使用）。"""

from __future__ import annotations

from langchain_core.tools import tool


@tool
def query_prometheus(query: str) -> str:
    """查询 Prometheus 指标。

    Args:
        query: PromQL 查询语句
    """
    # TODO: 接入真实 Prometheus
    # 这里是 demo 实现
    return f"[Mock Prometheus] 查询: {query}\n结果: CPU使用率 45%, 内存使用率 62%"


@tool
def search_logs(service: str, keywords: str = "") -> str:
    """搜索日志（Loki/ELK）。

    Args:
        service: 服务名称
        keywords: 搜索关键词
    """
    # TODO: 接入真实日志系统
    return f"[Mock Logs] 服务: {service}, 关键词: {keywords}\n最近日志: [INFO] 服务正常运行"


# 模块导出的工具列表
MONITORING_TOOLS = [query_prometheus, search_logs]
