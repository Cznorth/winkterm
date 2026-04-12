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
        client = websocket.client or "unknown"
        logger.info(f"[INIT] 客户端连接: {client}")

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

    def _on_pty_output(self, data: bytes) -> None:
        """PTY 输出回调：直接发送给 WebSocket。"""
        text = data.decode(errors="replace")
        self._bytes_sent += len(data)
        logger.debug(f"[OUTPUT] len={len(data)} data={_truncate(text)}")
        asyncio.create_task(self._send(text))

    async def _send(self, text: str) -> None:
        try:
            await self.ws.send_text(text)
        except Exception as e:
            logger.warning(f"[SEND_FAIL] 发送失败: {e}")
