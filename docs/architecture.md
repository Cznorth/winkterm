# WinkTerm 架构说明

## 概述

WinkTerm 是一个 AI + 终端人机合一的运维工具。AI 和用户共享同一个 pty 会话，所有交互都在终端内完成，无额外 UI 对话框。

## 核心设计：人机合一终端

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
                                      │
                                      ├── read_terminal_context()
                                      ├── write_message() ──► pty ──► 终端
                                      └── write_command()  ──► pty ──► 终端输入行（不执行）
```

## 目录结构

```
winkterm/
├── backend/
│   ├── agent/          # LangGraph Agent
│   │   ├── state.py    # AgentState 类型定义
│   │   ├── graph.py    # StateGraph 图结构
│   │   ├── nodes.py    # 节点函数
│   │   ├── tools.py    # 工具定义（终端交互 + 运维数据）
│   │   └── prompts.py  # 系统提示词
│   ├── terminal/       # pty 管理
│   │   ├── pty_manager.py  # pty 进程封装
│   │   └── ws_handler.py   # WebSocket 处理，含 # 检测逻辑
│   ├── api/            # FastAPI 路由
│   │   ├── routes.py   # HTTP 路由
│   │   └── ws_routes.py    # WebSocket 路由
│   ├── config.py       # pydantic-settings 配置
│   └── main.py         # FastAPI 入口
└── frontend/
    ├── src/
    │   ├── app/        # Next.js App Router
    │   ├── components/
    │   │   ├── Terminal/   # xterm.js 封装
    │   │   ├── AIPanel/    # 历史记录展示
    │   │   └── Layout/     # 分栏布局
    │   ├── lib/
    │   │   ├── websocket.ts    # WebSocket 客户端（含重连）
    │   │   ├── axios.ts        # axios 实例
    │   │   └── api/generated.ts    # orval 生成的 hooks
    │   └── types/      # TypeScript 类型
    └── orval.config.ts # API 代码生成配置
```

## 消息协议（WebSocket）

| 方向       | type     | 含义                     |
|------------|----------|--------------------------|
| 前端 → 后端 | input    | 用户键盘输入              |
| 前端 → 后端 | resize   | 终端尺寸变化              |
| 后端 → 前端 | output   | pty 原始输出              |

**注意**：AI 的消息（`write_message`/`write_command`）直接写入 pty，以 pty output 的形式返回前端，而不是单独的消息类型。这保证了人机合一的体验。

## Agent 工具

| 工具                   | 类型     | 说明                        |
|------------------------|----------|-----------------------------|
| read_terminal_context  | 终端交互 | 获取最近 50 行终端输出       |
| write_command          | 终端交互 | 写入命令到输入行（不执行）   |
| write_message          | 终端交互 | 打印 AI 消息（青色）         |
| query_prometheus       | 运维数据 | 查询 Prometheus 指标（mock） |
| search_logs            | 运维数据 | 搜索 Loki 日志（mock）       |
| get_k8s_events         | 运维数据 | 获取 k8s 事件（mock）        |
| get_recent_deploys     | 运维数据 | 查询最近发布记录（mock）     |

## 技术栈

- **后端**：Python 3.12 + FastAPI + LangGraph + LangChain Anthropic + ptyprocess
- **前端**：Next.js 14 + TypeScript + xterm.js + TanStack Query + axios
- **API 代码生成**：orval（从 OpenAPI 自动生成 react-query hooks）
- **部署**：Docker Compose
