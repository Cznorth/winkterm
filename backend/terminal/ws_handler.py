from __future__ import annotations

import asyncio
import logging
import re
import sys
import time

from fastapi import WebSocket, WebSocketDisconnect

from backend.terminal.pty_manager import PtyManager

# 配置日志
logger = logging.getLogger("ws_handler")
logging.basicConfig(
    level=logging.DEBUG,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)

# resize 事件格式: ESC[8;rows;colst
_RESIZE_PATTERN = re.compile(r"\x1b\[8;(\d+);(\d+)t")


def _truncate(data: str, max_len: int = 100) -> str:
    """截断并转义控制字符用于日志显示。"""
    escaped = data.encode("unicode_escape").decode("ascii")
    if len(escaped) > max_len:
        return escaped[:max_len] + "..."
    return escaped


class TerminalWSHandler:
    """WebSocket 终端处理：纯透传字节。"""

    def __init__(self, websocket: WebSocket) -> None:
        self.ws = websocket
        self.pty = PtyManager()
        self._start_time = time.time()
        self._msg_count = 0
        self._bytes_sent = 0
        self._bytes_received = 0
        self._capturing_history = False  # 是否正在捕获历史命令
        self._history_buffer: list[str] = []  # 历史命令缓冲区
        client = websocket.client or "unknown"
        logger.info(f"[INIT] 客户端连接: {client}")

    async def hookinput(self, data: str) -> None:
        """hook用户输入，用于自定义操作"""
        logger.debug(f"[HOOKINPUT] len={len(data)} data={_truncate(data)}")

        # 检测回车键
        if data in ("\r", "\n", "\r\n"):
            logger.debug("[HISTORY] 检测到回车，开始获取上一条命令")
            await asyncio.sleep(0.1)
            await self._fetch_last_command()

    async def handle(self) -> None:
        await self.ws.accept()
        logger.info("[ACCEPT] WebSocket 已接受连接")

        self.pty.spawn()
        self.pty.add_output_callback(self._on_pty_output)
        logger.info(f"[SPAWN] PTY 已启动: pid={getattr(self.pty, '_pid', 'N/A')}")

        read_task = asyncio.create_task(self.pty.start_read_loop())

        try:
            while True:
                # 直接接收文本，透传给 PTY
                data = await self.ws.receive_text()
                self._msg_count += 1
                self._bytes_received += len(data.encode("utf-8"))

                # 检查是否是 resize 事件
                match = _RESIZE_PATTERN.fullmatch(data)
                if match:
                    rows, cols = int(match.group(1)), int(match.group(2))
                    logger.debug(f"[RESIZE] rows={rows}, cols={cols}")
                    self.pty.resize(cols, rows)
                else:
                    # 普通输入，透传给 PTY
                    logger.debug(f"[INPUT] len={len(data)} data={_truncate(data)}")
                    self.pty.write(data.encode("utf-8"))
                await self.hookinput(data) # 自定义操作

        except WebSocketDisconnect:
            logger.info(f"[DISCONNECT] 客户端断开, 统计: msgs={self._msg_count}, "
                        f"rx={self._bytes_received}B, tx={self._bytes_sent}B, "
                        f"duration={time.time() - self._start_time:.1f}s")
        except Exception as exc:
            logger.exception(f"[ERROR] 异常: {exc}")
        finally:
            read_task.cancel()
            self.pty.terminate()
            self.pty.remove_output_callback(self._on_pty_output)
            logger.debug("[CLEANUP] 资源已释放")

    async def _fetch_last_command(self) -> None:
        """发送上键和下键来获取上一条命令"""
        # 开始捕获
        self._capturing_history = True
        self._history_buffer = []

        # 发送上键
        logger.debug("[HISTORY] 发送上键序列")
        self.pty.write(b"\x1b[A")

        # 等待终端响应
        # await asyncio.sleep(0.3)

        # 发送下键
        logger.debug("[HISTORY] 发送下键序列")
        self.pty.write(b"\x1b[B")

        # 等待下键响应
        await asyncio.sleep(0.1)

        # 停止捕获并解析
        self._capturing_history = False
        await self._parse_last_command()

    async def _parse_last_command(self) -> None:
        """解析捕获的历史命令"""
        if not self._history_buffer:
            logger.debug("[HISTORY] 未捕获到任何输出")
            return

        # 合并缓冲区内容
        full_output = "".join(self._history_buffer)
        logger.debug(f"[HISTORY] 捕获的原始输出: {repr(full_output[:200])}")

        # 更全面的 ANSI 转义序列正则
        # 包括：CSI序列 (ESC[...字母)、OSC序列 (ESC]...BEL/ST)、其他转义
        ansi_escape = re.compile(
            r"\x1b\[[\?0-9;]*[A-Za-z]"  # CSI 序列（包括私有模式 ?）
            r"|\x1b\].*?(?:\x07|\x1b\\)"  # OSC 序列
            r"|\x1b[()][AB012]"  # 字符集选择
            r"|\x1b[78]"  # 保存/恢复光标
            r"|\x1b[=>]"  # 键盘模式
        )

        # 去除所有 ANSI 转义序列
        clean_output = ansi_escape.sub("", full_output)

        # 去除控制字符（保留可打印字符、空格、制表符）
        clean_output = "".join(c for c in clean_output if c.isprintable() or c in " \t")

        # 清理多余空白
        clean_output = " ".join(clean_output.split())

        if clean_output:
            logger.info(f"[HISTORY] 上一条命令: {clean_output}")
            if clean_output.startswith("#"):
                await self.agent_invoke(clean_output[1:])
        else:
            logger.debug("[HISTORY] 未能解析出有效命令")
    async def agent_invoke(self, user_input):
        """agent调用"""
        await self._send(user_input) #这里直接回显，稍后替换成完善的agent invoke
        self.pty.write(b"\r")
        
    def _on_pty_output(self, data: bytes) -> None:
        """PTY 输出回调：直接发送给 WebSocket。"""
        text = data.decode(errors="replace")
        self._bytes_sent += len(data)
        logger.debug(f"[OUTPUT] len={len(data)} data={_truncate(text)}")

        # 如果正在捕获历史命令，保存到缓冲区
        if self._capturing_history:
            self._history_buffer.append(text)
        asyncio.create_task(self._send(text))

    async def _send(self, text: str) -> None:
        try:
            await self.ws.send_text(text)
        except Exception as e:
            logger.warning(f"[SEND_FAIL] 发送失败: {e}")
