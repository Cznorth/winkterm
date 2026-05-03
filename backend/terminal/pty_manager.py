from __future__ import annotations

import asyncio
import logging
import sys
import threading
from collections import deque
from typing import Callable, Optional

logger = logging.getLogger("pty_manager")

# Windows: pywinpty | Unix: ptyprocess
if sys.platform == "win32":
    try:
        import winpty

        _HAS_PTY = True
    except ImportError:
        _HAS_PTY = False
        logger.warning("pywinpty 未安装，PTY 功能不可用")
else:
    try:
        import ptyprocess

        _HAS_PTY = True
    except ImportError:
        _HAS_PTY = False
        logger.warning("ptyprocess 未安装，PTY 功能不可用")


class PtyManager:
    """PTY 管理器：纯透传字节，不做任何解析。

    Windows: 使用 pywinpty（真正的 PTY）
    Unix:    使用 ptyprocess
    """

    BUFFER_LINES = 500

    def __init__(self) -> None:
        self._proc = None  # winpty.PtyProcess | ptyprocess.PtyProcess
        self._output_buffer: deque[str] = deque(maxlen=self.BUFFER_LINES)
        self._screen_content: str = ""  # 前端序列化的屏幕内容
        self._read_callbacks: list[Callable[[bytes], None]] = []
        self._queue: asyncio.Queue[bytes | None] | None = None
        self._read_thread: threading.Thread | None = None
        self._alive = False
        self._loop: asyncio.AbstractEventLoop | None = None
        # SSH 相关
        self._ssh_password_handler = None
        self._ssh_connection_id: Optional[str] = None

    # ------------------------------------------------------------------
    # 生命周期
    # ------------------------------------------------------------------

    def spawn(
        self,
        shell: str | None = None,
        cols: int = 80,
        rows: int = 24,
        ssh_config: dict | None = None,
    ) -> None:
        """启动 PTY 进程。

        Args:
            shell: 本地 shell 路径
            cols: 列数
            rows: 行数
            ssh_config: SSH 连接配置，包含 host, port, username, password 等
        """
        if not _HAS_PTY:
            raise RuntimeError("PTY not available: install pywinpty (Windows) or ptyprocess (Unix)")

        # SSH 模式
        if ssh_config:
            self._spawn_ssh(ssh_config, cols, rows)
            return

        # 本地 shell 模式
        if sys.platform == "win32":
            # Windows: pywinpty
            shell = shell or "powershell.exe"
            logger.info(f"[SPAWN] Windows: 启动 {shell}, dimensions=({rows}, {cols})")
            self._proc = winpty.PtyProcess.spawn(
                shell,
                dimensions=(rows, cols),
            )
            self._pid = getattr(self._proc, "pid", "N/A")
            logger.info(f"[SPAWN] PTY 进程已启动, pid={self._pid}")
        else:
            # Unix: ptyprocess
            import os
            shell = shell or os.environ.get("SHELL", "/bin/bash")
            # 设置必要的环境变量
            env = os.environ.copy()
            env.setdefault("TERM", "xterm-256color")
            env.setdefault("LANG", "en_US.UTF-8")
            env.setdefault("LC_ALL", "en_US.UTF-8")
            logger.info(f"[SPAWN] Unix: 启动 {shell}, dimensions=({rows}, {cols})")
            self._proc = ptyprocess.PtyProcess.spawn(
                [shell],
                dimensions=(rows, cols),
                env=env,
            )
            self._pid = getattr(self._proc, "pid", "N/A")
            logger.info(f"[SPAWN] PTY 进程已启动, pid={self._pid}")

        self._alive = True

    def _spawn_ssh(self, ssh_config: dict, cols: int, rows: int) -> None:
        """启动 SSH 连接。"""
        from backend.ssh.pty_spawner import SSHPtySpawner, PasswordAutoInput
        from backend.ssh.models import SSHConnection

        # 构建 SSHConnection 对象
        conn = SSHConnection(
            host=ssh_config.get("host", ""),
            port=ssh_config.get("port", 22),
            username=ssh_config.get("username", ""),
            auth_type=ssh_config.get("auth_type", "password"),
            password=ssh_config.get("password"),
            private_key_path=ssh_config.get("private_key_path"),
        )

        # 存储 SSH 连接 ID
        self._ssh_connection_id = ssh_config.get("id")

        # 构建 SSH 命令
        if sys.platform == "win32":
            # Windows: winpty 需要字符串
            ssh_cmd = SSHPtySpawner.build_ssh_command_str(conn)
            logger.info(f"[SPAWN SSH] Windows: 启动 SSH {conn.username}@{conn.host}:{conn.port}")
            self._proc = winpty.PtyProcess.spawn(
                ssh_cmd,
                dimensions=(rows, cols),
            )
        else:
            # Unix: ptyprocess 需要列表
            import os
            ssh_cmd = SSHPtySpawner.build_ssh_command(conn)
            # 设置必要的环境变量
            env = os.environ.copy()
            env.setdefault("TERM", "xterm-256color")
            env.setdefault("LANG", "en_US.UTF-8")
            env.setdefault("LC_ALL", "en_US.UTF-8")
            logger.info(f"[SPAWN SSH] Unix: 启动 SSH {conn.username}@{conn.host}:{conn.port}")
            self._proc = ptyprocess.PtyProcess.spawn(
                ssh_cmd,
                dimensions=(rows, cols),
                env=env,
            )

        self._pid = getattr(self._proc, "pid", "N/A")
        logger.info(f"[SPAWN SSH] PTY 进程已启动, pid={self._pid}")

        # 设置密码自动输入处理器（注册为回调）
        if conn.auth_type == "password" and conn.password:
            self._ssh_password_handler = PasswordAutoInput(
                password=conn.password,
                write_func=self.write,
            )
            self.add_output_callback(self._ssh_password_handler)
            logger.info("[SPAWN SSH] 密码自动输入处理器已启用")

        self._alive = True

    def is_alive(self) -> bool:
        if self._proc is None:
            return False
        if hasattr(self._proc, "isalive"):
            return self._proc.isalive()
        return self._alive

    def terminate(self) -> None:
        self._alive = False
        if self._proc:
            try:
                if hasattr(self._proc, "terminate"):
                    self._proc.terminate(force=True)
                elif hasattr(self._proc, "close"):
                    self._proc.close()
            except Exception:
                pass
        self._proc = None

    # ------------------------------------------------------------------
    # 写操作（透传字节）
    # ------------------------------------------------------------------

    def write(self, data: bytes) -> None:
        """透传原始字节给 PTY。"""
        if self._proc is None:
            logger.warning("[WRITE] PTY 进程未启动，忽略写入")
            return
        if not hasattr(self._proc, "write"):
            logger.warning("[WRITE] PTY 没有 write 方法")
            return
        try:
            # winpty 需要 str, ptyprocess 需要 bytes
            if sys.platform == "win32":
                text = data.decode("utf-8", errors="replace")
                # logger.debug(f"[WRITE] Windows: 写入 {len(text)} 字符: {repr(text[:50])}")
                self._proc.write(text)
            else:
                # logger.debug(f"[WRITE] Unix: 写入 {len(data)} 字节: {repr(data[:50])}")
                self._proc.write(data)
        except Exception as e:
            logger.error(f"[WRITE] 写入失败: {e}")

    def write_command(self, command: str) -> None:
        """写入命令到输入行（不执行，不发送回车）。"""
        self.write(command.encode("utf-8"))

    def resize(self, cols: int, rows: int) -> None:
        """调整 PTY 大小。"""
        if self._proc and hasattr(self._proc, "setwinsize"):
            try:
                self._proc.setwinsize(rows, cols)
            except Exception:
                pass

    # ------------------------------------------------------------------
    # 异步读取（后台线程 + asyncio queue）
    # ------------------------------------------------------------------

    def add_output_callback(self, cb: Callable[[bytes], None]) -> None:
        self._read_callbacks.append(cb)

    def remove_output_callback(self, cb: Callable[[bytes], None]) -> None:
        self._read_callbacks = [c for c in self._read_callbacks if c is not cb]

    async def start_read_loop(self) -> None:
        """启动读取循环：后台线程读 PTY，放入 asyncio queue。"""
        if self._proc is None or not hasattr(self._proc, "read"):
            return

        self._loop = asyncio.get_event_loop()
        self._queue = asyncio.Queue()

        def _reader():
            while self.is_alive():
                try:
                    data = self._proc.read(4096)
                    if not data:
                        break
                    raw = data.encode("utf-8") if isinstance(data, str) else data
                    if self._loop:
                        self._loop.call_soon_threadsafe(self._queue.put_nowait, raw)
                except EOFError:
                    break
                except Exception:
                    break
            # 终止信号
            if self._loop:
                self._loop.call_soon_threadsafe(self._queue.put_nowait, None)

        self._read_thread = threading.Thread(target=_reader, daemon=True)
        self._read_thread.start()

        # 主循环：从 queue 取数据，回调处理
        while True:
            data = await self._queue.get()
            if data is None:
                break
            self._output_buffer.append(data.decode("utf-8", errors="replace"))
            self._notify_callbacks(data)

    def _notify_callbacks(self, data: bytes) -> None:
        """通知所有输出回调。"""
        for cb in list(self._read_callbacks):
            try:
                cb(data)
            except Exception:
                pass

    # ------------------------------------------------------------------
    # 屏幕内容（从前端 xterm.js 序列化）
    # ------------------------------------------------------------------

    def set_screen_content(self, content: str) -> None:
        """更新屏幕内容缓存（由 ws_handler 调用）。"""
        self._screen_content = content

    def get_screen_content(self) -> str:
        """获取当前屏幕内容。"""
        return self._screen_content

    # ------------------------------------------------------------------
    # 上下文（用于 AI 分析）
    # ------------------------------------------------------------------

    def get_context(self, lines: int = 500) -> str:
        """获取终端上下文，优先使用屏幕内容。

        如果有前端序列化的屏幕内容，直接返回（这是最准确的渲染结果）。
        否则回退到 output buffer（原始 ANSI 流）。
        """
        if self._screen_content:
            return self._screen_content[-5000:]  # 截取最后部分屏幕内容，避免过大
        recent = list(self._output_buffer)[-lines:]
        return "\n".join(recent)
