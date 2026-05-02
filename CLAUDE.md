# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

WinkTerm 是一个 AI + 终端人机合一的运维工具。AI 和用户共享同一个 pty 会话，所有交互都在终端内完成。用户输入 `# 开头的消息` 与 AI 对话，AI 可以建议命令并写入终端输入行，用户按回车执行或退格修改。

## 常用命令

### 后端开发
```bash
cd backend
python -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt

# 启动开发服务器
python -m uvicorn backend.main:app --reload --port 8000
```

### 前端开发
```bash
cd frontend
npm install
npm run dev           # 开发模式
npm run build         # 构建（输出到 frontend/out/）
npm run lint          # 代码检查
npm run gen:api       # 从 OpenAPI 生成 TypeScript 类型和 react-query hooks
```

### 桌面应用打包
```bash
# Windows
build\build.bat

# 或手动执行
pyinstaller build\winkterm.spec --clean --noconfirm
```

### Docker 部署
```bash
docker compose up -d
```

## 架构要点

### 核心数据流
```
用户键盘输入
    │
    ▼
前端 Terminal (xterm.js)
    │  WebSocket
    ▼
ws_handler.py
    │
    ├── 普通输入 ──► pty_manager.write() ──► shell 进程
    │
    └── # 开头的行 ──► 拦截 ──► Agent (LangGraph)
```

### 关键模块

| 模块 | 路径 | 职责 |
|------|------|------|
| WebSocket 处理 | `backend/terminal/ws_handler.py` | 消息分发、`#` 检测、调用 Agent |
| PTY 管理 | `backend/terminal/pty_manager.py` | shell 进程封装、读写、上下文获取 |
| 会话管理 | `backend/terminal/session_manager.py` | 多终端会话、激活状态 |
| Agent 图 | `backend/agent/graph.py` | LangGraph StateGraph 定义 |
| Agent 工具 | `backend/agent/tools/` | 终端交互工具定义 |
| SSH 连接 | `backend/ssh/` | SSH 连接管理、文件传输 |

### 终端工具（Agent Tools）

- `terminal_input`: 执行命令或发送控制键，返回执行结果
- `write_command`: 写入命令到输入行（不执行），agent 终止等待用户操作
- `get_terminal_context`: 获取终端输出内容（只读）

### WebSocket 消息协议

| 方向 | type | 含义 |
|------|------|------|
| 前端 → 后端 | input | 用户键盘输入 |
| 前端 → 后端 | resize | 终端尺寸变化 |
| 后端 → 前端 | output | pty 原始输出 |

AI 消息通过 pty output 返回，保证人机合一体验。

### 前端结构

- `src/app/`: Next.js App Router
- `src/components/Terminal/`: xterm.js 封装
- `src/lib/websocket.ts`: WebSocket 客户端（含重连）
- `src/lib/api/generated.ts`: orval 生成的 API hooks

## 环境变量

| 变量 | 说明 | 必填 |
|------|------|------|
| `ANTHROPIC_API_KEY` | Anthropic API Key | 是 |
| `MODEL_NAME` | Claude 模型名 | 否（默认 claude-opus-4-6） |
| `NEXT_PUBLIC_API_URL` | 后端 HTTP API 地址 | 否 |
| `NEXT_PUBLIC_WS_URL` | 后端 WebSocket 地址 | 否 |

## 打包发布

推送 tag 触发 GitHub Actions 自动打包：
```bash
git tag v0.1.0
git push origin v0.1.0
```

生成 Windows (.exe) 和 macOS (.app，分 Intel 和 AppleSilicon) 两种安装包。
