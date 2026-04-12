from __future__ import annotations

import json
import random
from datetime import datetime, timedelta
from typing import TYPE_CHECKING

from langchain_core.tools import tool

if TYPE_CHECKING:
    from backend.terminal.pty_manager import PtyManager

# pty_manager 由外部注入，避免循环导入
_pty_manager: "PtyManager | None" = None


def set_pty_manager(manager: "PtyManager") -> None:
    global _pty_manager
    _pty_manager = manager


def _require_pty() -> "PtyManager":
    return _pty_manager  # may be None — tools handle that gracefully


# ---------------------------------------------------------------------------
# 终端交互工具
# ---------------------------------------------------------------------------

@tool
def read_terminal_context() -> str:
    """获取当前终端的最近输出内容（最近 50 行），每次分析前必须先调用。"""
    pty = _require_pty()
    if pty is None:
        return "（无终端会话）"
    ctx = pty.get_context(lines=50)
    return ctx if ctx else "（终端暂无输出）"


@tool
def write_command(command: str, explanation: str) -> str:
    """把命令写入终端输入行（不执行），并先打印一句解释。

    Args:
        command: 要写入输入行的 shell 命令（不加换行符）
        explanation: 一句话说明为什么建议这条命令
    """
    pty = _require_pty()
    if pty is None:
        return f"[无终端会话] {explanation} → {command}"
    pty.write_message(explanation)
    pty.write_command(command)
    return f"命令已写入终端，等待用户执行：{command}"


@tool
def write_message(message: str) -> str:
    """在终端里打印 AI 消息（分析结论、建议、问题等）。

    Args:
        message: 要打印的内容，简短直接
    """
    pty = _require_pty()
    if pty is None:
        return f"[无终端会话] {message}"
    pty.write_message(message)
    return "消息已打印"


# ---------------------------------------------------------------------------
# 运维数据工具（mock 实现，接口贴近真实）
# ---------------------------------------------------------------------------

@tool
def query_prometheus(query: str, duration: str = "5m") -> str:
    """查询 Prometheus 指标。

    Args:
        query: PromQL 查询表达式，例如 'rate(http_requests_total[5m])'
        duration: 查询时间范围，例如 '5m', '1h'
    """
    # Mock：返回模拟指标数据
    mock_results = {
        "status": "success",
        "query": query,
        "duration": duration,
        "data": {
            "resultType": "vector",
            "result": [
                {
                    "metric": {"job": "nginx", "instance": "10.0.0.1:9113"},
                    "value": [datetime.now().timestamp(), str(round(random.uniform(0.1, 99.9), 2))],
                }
            ],
        },
    }
    return json.dumps(mock_results, ensure_ascii=False)


@tool
def search_logs(
    query: str,
    service: str = "",
    level: str = "error",
    limit: int = 20,
) -> str:
    """搜索 Loki 日志。

    Args:
        query: 日志搜索关键词或 LogQL 表达式
        service: 服务名称过滤，例如 'nginx', 'api-server'
        level: 日志级别过滤，例如 'error', 'warn', 'info'
        limit: 返回条数上限
    """
    now = datetime.now()
    mock_logs = [
        {
            "timestamp": (now - timedelta(minutes=i)).isoformat(),
            "service": service or "nginx",
            "level": level,
            "message": f"[mock] {query} 匹配日志第 {i + 1} 条 - upstream connect error or disconnect/reset before headers",
        }
        for i in range(min(limit, 5))
    ]
    return json.dumps({"logs": mock_logs, "total": len(mock_logs)}, ensure_ascii=False)


@tool
def get_k8s_events(
    namespace: str = "default",
    reason: str = "",
    limit: int = 10,
) -> str:
    """获取 Kubernetes 事件列表。

    Args:
        namespace: k8s 命名空间，默认 'default'
        reason: 事件原因过滤，例如 'OOMKilling', 'BackOff', 'Failed'
        limit: 返回条数上限
    """
    now = datetime.now()
    reasons = [reason] if reason else ["OOMKilling", "BackOff", "Pulling"]
    mock_events = [
        {
            "timestamp": (now - timedelta(minutes=i * 3)).isoformat(),
            "namespace": namespace,
            "name": f"pod-{random.randint(1000, 9999)}",
            "reason": reasons[i % len(reasons)],
            "message": f"[mock] Container xxx in pod yyy: {reasons[i % len(reasons)]}",
            "count": random.randint(1, 20),
        }
        for i in range(min(limit, 5))
    ]
    return json.dumps({"events": mock_events}, ensure_ascii=False)


@tool
def get_recent_deploys(service: str = "", limit: int = 5) -> str:
    """查询最近发布记录。

    Args:
        service: 服务名称，空则返回所有服务
        limit: 返回条数上限
    """
    now = datetime.now()
    services = [service] if service else ["api-server", "nginx", "worker", "scheduler"]
    mock_deploys = [
        {
            "deploy_id": f"deploy-{random.randint(10000, 99999)}",
            "service": services[i % len(services)],
            "version": f"v1.{random.randint(0, 9)}.{random.randint(0, 99)}",
            "deployed_at": (now - timedelta(hours=i * 2)).isoformat(),
            "deployed_by": random.choice(["alice", "bob", "ci-bot"]),
            "status": random.choice(["success", "success", "success", "failed"]),
        }
        for i in range(min(limit, 5))
    ]
    return json.dumps({"deploys": mock_deploys}, ensure_ascii=False)


# 所有工具列表，供 graph.py 使用
ALL_TOOLS = [
    read_terminal_context,
    write_command,
    write_message,
    query_prometheus,
    search_logs,
    get_k8s_events,
    get_recent_deploys,
]
