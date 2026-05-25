"""统一终端工具集。

供 LangGraph agent 调用,底层走 SessionManager(与外部 HTTP API 同源)。
所有工具显式接 terminal_id,agent 通过每轮 system prompt 注入的终端列表
自主决定操作哪个终端。
"""

from __future__ import annotations

import asyncio
import logging
from typing import Optional

from langchain_core.tools import tool

from backend.terminal._term_utils import UnknownKeyError
from backend.terminal.session_manager import get_session_manager

logger = logging.getLogger("agent.tools.terminal")


def _truncate(value: object, limit: int = 4000) -> object:
    """工具结果截断,避免单次返回灌爆 LLM 上下文。"""
    if isinstance(value, str) and len(value) > limit:
        return value[:limit] + f"...(已截断,原长 {len(value)})"
    if isinstance(value, dict):
        out = dict(value)
        for k in ("output", "stdout"):
            if isinstance(out.get(k), str) and len(out[k]) > limit:
                out[k] = out[k][:limit] + f"...(已截断,原长 {len(out[k])})"
        return out
    return value


# ---------------------------------------------------------------------------
# 终端管理
# ---------------------------------------------------------------------------

@tool
def list_terminals() -> dict:
    """列出所有终端会话(含用户激活标记)。

    返回字段重点:id / type / title / is_user_active / user_visible / created_by /
    idle_seconds / cwd / last_command。

    通常每轮 prompt 已自动注入终端列表,本工具用于刷新或需要更详细字段时调用。
    """
    return {"terminals": get_session_manager().list_terminals()}


@tool
async def create_terminal(
    terminal_type: str = "local",
    connection_id: Optional[str] = None,
    name: str = "",
    cols: int = 120,
    rows: int = 40,
    ttl_seconds: float = 1800.0,
) -> dict:
    """新建终端会话(始终出现在用户标签栏)。

    Args:
        terminal_type: "local" 本地 shell / "ssh" SSH 连接(需 connection_id)。
        connection_id: SSH 类型必填,来自 list_ssh_connections。
        name: 终端展示名(可选,会显示在标签上)。
        ttl_seconds: 空闲回收时间,0/负数 = 永不过期。

    所有 agent 建的终端都对用户可见(透明可审计)。
    用完记得 close_terminal,避免标签栏堆满。
    """
    try:
        session = await get_session_manager().create(
            terminal_type=terminal_type,
            connection_id=connection_id,
            cols=cols,
            rows=rows,
            name=name,
            ttl_seconds=ttl_seconds,
            created_by="agent:internal",
            user_visible=True,
            transient=False,
        )
    except ValueError as exc:
        return {"ok": False, "error": str(exc)}
    return session.info(is_user_active=False)


@tool
def close_terminal(terminal_id: str) -> dict:
    """关闭并删除指定终端。"""
    ok = get_session_manager().close(terminal_id)
    return {"ok": ok, "terminal_id": terminal_id}


# ---------------------------------------------------------------------------
# 终端交互
# ---------------------------------------------------------------------------

@tool
def terminal_snapshot(
    terminal_id: str,
    since: Optional[int] = None,
    strip_ansi: bool = True,
    pattern: Optional[str] = None,
    context: int = 0,
    case_insensitive: bool = False,
) -> dict:
    """读取终端输出快照(只读)。

    Args:
        terminal_id: 终端 id。
        since: 绝对字节偏移,首次传 None 拉全量,后续传上次返回的 size。
        pattern: 给定时附带 grep 字段返回匹配行。
        context: grep 上下文行数(0-20)。
    """
    session = get_session_manager().get_session(terminal_id)
    if not session:
        return {"ok": False, "error": f"终端不存在: {terminal_id}"}
    try:
        result = session.snapshot(
            since=since,
            strip=strip_ansi,
            pattern=pattern,
            context=context,
            case_insensitive=case_insensitive,
        )
    except ValueError as exc:
        return {"ok": False, "error": str(exc)}
    return _truncate(result)  # type: ignore[return-value]


@tool
async def terminal_input(
    terminal_id: str,
    data: str = "",
    keys: Optional[list[str]] = None,
    enter: bool = True,
    wait: bool = False,
    timeout: float = 10.0,
    idle: float = 0.6,
    strip_echo: bool = False,
    halt_for_user: bool = False,
) -> dict:
    """向终端发送输入(命令/控制键/原始文本)。

    Args:
        terminal_id: 目标终端 id。
        data: 文本内容(命令本身)。
        keys: 命名控制键数组,如 ["ctrl+c"]、["up","enter"]。
        enter: 末尾是否追加回车(默认 true)。
        wait: 是否等待输出落定再返回。
        halt_for_user: 仅写入不执行 + 等待用户决策时设 true(配合 enter=false 使用)。
            agent 会终止本轮,把控制交还用户。适合"建议命令但让用户确认执行"场景。
    """
    session = get_session_manager().get_session(terminal_id)
    if not session:
        return {"ok": False, "error": f"终端不存在: {terminal_id}"}
    try:
        result = await session.send(
            data=data,
            keys=keys,
            enter=enter,
            wait=wait,
            timeout=timeout,
            idle=idle,
            strip_echo=strip_echo,
        )
    except UnknownKeyError as exc:
        return {"ok": False, "error": str(exc)}
    except ValueError as exc:
        return {"ok": False, "error": str(exc)}
    if halt_for_user:
        result["_halt_for_user"] = True
    return _truncate(result)  # type: ignore[return-value]


@tool
async def terminal_exec(
    terminal_id: str,
    command: str,
    timeout: float = 30.0,
    cwd: Optional[str] = None,
    env: Optional[dict[str, str]] = None,
) -> dict:
    """原子执行 POSIX shell 命令,返回 stdout + exit_code + cwd。

    cwd / env 用 subshell 注入,不污染终端持久状态。命令包含 sentinel
    跟踪退出码,适合需要可靠判断成功与否的场景。

    Args:
        terminal_id: 目标终端 id。
        command: 命令字符串。
        timeout: 超时秒数。
    """
    session = get_session_manager().get_session(terminal_id)
    if not session:
        return {"ok": False, "error": f"终端不存在: {terminal_id}"}
    try:
        result = await session.exec(
            command=command,
            timeout=timeout,
            cwd=cwd,
            env=env,
        )
    except ValueError as exc:
        return {"ok": False, "error": str(exc)}
    return _truncate(result)  # type: ignore[return-value]


# ---------------------------------------------------------------------------
# SSH 辅助
# ---------------------------------------------------------------------------

@tool
def list_ssh_connections() -> dict:
    """列出所有已配置的 SSH 连接(密码脱敏)。"""
    from backend.ssh.connection_manager import SSHConnectionManager

    return SSHConnectionManager.list_connections()


@tool
async def ssh_run(
    connection_id: str,
    command: str,
    timeout: float = 60.0,
    initial_wait: float = 12.0,
    cwd: Optional[str] = None,
    env: Optional[dict[str, str]] = None,
) -> dict:
    """一次性 SSH 命令:新建隐藏终端 → exec → 关闭。

    适合一次性诊断/巡检,不进入用户标签栏。如需复用 shell 状态(cd/env),
    用 create_terminal + terminal_exec 两步流程。
    """
    from backend.ssh.connection_manager import SSHConnectionManager

    if not SSHConnectionManager.get_connection(connection_id):
        return {"ok": False, "error": f"SSH 连接不存在: {connection_id}"}

    sm = get_session_manager()
    try:
        session = await sm.create(
            terminal_type="ssh",
            connection_id=connection_id,
            cols=200,
            rows=50,
            name=f"oneshot:{connection_id}",
            ttl_seconds=max(timeout + 30, 120),
            created_by="agent:internal",
            user_visible=True,
            transient=False,
        )
    except ValueError as exc:
        return {"ok": False, "error": str(exc)}

    try:
        await session.wait_until_idle(idle=2.0, max_wait=max(initial_wait, 5.0))
        result = await session.exec(
            command=command,
            timeout=timeout,
            cwd=cwd,
            env=env,
        )
    finally:
        sm.close(session.id)
    return _truncate(result)  # type: ignore[return-value]


# ---------------------------------------------------------------------------
# 通用
# ---------------------------------------------------------------------------

@tool
async def wait(seconds: float) -> str:
    """等待指定秒数,用于让长任务跑完或观察日志变化。范围 0-60。"""
    seconds = min(max(seconds, 0), 60)
    await asyncio.sleep(seconds)
    return f"[等待完成] {seconds} 秒"


# ---------------------------------------------------------------------------
# 导出
# ---------------------------------------------------------------------------

TERMINAL_TOOLS = [
    list_terminals,
    create_terminal,
    close_terminal,
    terminal_snapshot,
    terminal_input,
    terminal_exec,
    list_ssh_connections,
    ssh_run,
    wait,
]

TOOLS_BY_NAME = {t.name: t for t in TERMINAL_TOOLS}
