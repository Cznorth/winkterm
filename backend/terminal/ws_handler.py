from __future__ import annotations

import asyncio
import json
import re
from typing import Any

from fastapi import WebSocket, WebSocketDisconnect
from langchain_core.messages import HumanMessage

from backend.terminal.pty_manager import PtyManager
from backend.agent.tools import set_pty_manager
from backend.agent.graph import get_graph

# 自动触发 AI 分析的关键词（检测终端输出）
_ERROR_PATTERN = re.compile(
    r"\b(error|fatal|exception|oom|killed|panic|traceback|segfault)\b",
    re.IGNORECASE,
)


class TerminalWSHandler:
    """处理单个 WebSocket 连接的终端会话。"""

    def __init__(self, websocket: WebSocket) -> None:
        self.ws = websocket
        self.pty = PtyManager()
        self._input_line_buf: str = ""   # 追踪当前输入行，检测 # 开头
        self._agent_running = False

    async def handle(self) -> None:
        await self.ws.accept()

        # 启动 pty
        self.pty.spawn()
        set_pty_manager(self.pty)

        # 注册输出回调：把 pty 输出转发给前端
        self.pty.add_output_callback(self._on_pty_output)

        # 后台任务：读取 pty 输出
        read_task = asyncio.create_task(self.pty.start_read_loop())

        try:
            while True:
                raw = await self.ws.receive_text()
                msg: dict[str, Any] = json.loads(raw)
                await self._dispatch(msg)
        except WebSocketDisconnect:
            pass
        except Exception as exc:
            print(f"[ws_handler] 异常: {exc}")
        finally:
            read_task.cancel()
            self.pty.terminate()
            self.pty.remove_output_callback(self._on_pty_output)

    # ------------------------------------------------------------------
    # 消息分发
    # ------------------------------------------------------------------

    async def _dispatch(self, msg: dict[str, Any]) -> None:
        msg_type = msg.get("type")

        if msg_type == "input":
            await self._handle_input(msg.get("data", ""))
        elif msg_type == "resize":
            cols = int(msg.get("cols", 80))
            rows = int(msg.get("rows", 24))
            self.pty.resize(cols, rows)
        elif msg_type == "analyze":
            # 手动触发分析（兼容旧协议）
            text = msg.get("data", "")
            asyncio.create_task(self._run_agent(text))

    async def _handle_input(self, data: str) -> None:
        """处理用户键盘输入。

        - 追踪输入行缓冲
        - 回车时判断是否 # 开头 → 拦截并交给 Agent
        - 否则透传给 pty
        """
        for char in data:
            if char in ("\r", "\n"):
                line = self._input_line_buf.strip()
                self._input_line_buf = ""

                if line.startswith("#"):
                    # 拦截，不发给 pty，转给 Agent
                    # 先回显换行（让终端看起来自然）
                    self.pty.write(b"\r\n")
                    asyncio.create_task(self._run_agent(line[1:].strip()))
                else:
                    # 正常透传（含回车）
                    self.pty.write((line + "\r").encode())
            elif char in ("\x7f", "\x08"):
                # 退格
                if self._input_line_buf:
                    self._input_line_buf = self._input_line_buf[:-1]
                self.pty.write(char.encode())
            else:
                self._input_line_buf += char
                self.pty.write(char.encode())

    # ------------------------------------------------------------------
    # Agent 调用
    # ------------------------------------------------------------------

    async def _run_agent(self, user_message: str) -> None:
        if self._agent_running:
            self.pty.write_message("Agent 正在处理上一个请求，请稍候...")
            return

        self._agent_running = True
        try:
            graph = get_graph()
            initial_state = {
                "messages": [HumanMessage(content=user_message)],
                "terminal_output": self.pty.get_context(),
                "analysis_result": "",
                "llm_calls": 0,
            }
            await graph.ainvoke(initial_state)
        except Exception as exc:
            error_msg = f"Agent 出错：{exc}"
            self.pty.write_message(error_msg)
        finally:
            self._agent_running = False

    # ------------------------------------------------------------------
    # pty 输出回调
    # ------------------------------------------------------------------

    def _on_pty_output(self, data: bytes) -> None:
        """pty 有输出时：转发给前端，并检测错误关键词。"""
        text = data.decode(errors="replace")

        # 发送给前端
        asyncio.create_task(
            self.ws.send_text(json.dumps({"type": "output", "data": text}))
        )

        # 检测错误关键词，自动触发分析（仅当 Agent 未在运行时）
        if _ERROR_PATTERN.search(text) and not self._agent_running:
            asyncio.create_task(
                self._run_agent(f"终端检测到异常，请帮我分析：{text[:200]}")
            )
