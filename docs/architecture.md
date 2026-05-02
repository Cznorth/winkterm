# WinkTerm 架构说明

## 概述

WinkTerm 是一个 AI + 终端人机合一的运维工具。AI 和用户共享同一个 pty 会话，支持终端内交互和侧边栏对话两种模式。

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
                                      ├── get_terminal_context()
                                      ├── terminal_input()
                                      └── write_command() ──► pty ──► 终端输入行（不执行）
```

## 目录结构

```
winkterm/
├── backend/
│   ├── agent/              # LangGraph Agent
│   │   ├── core/           # 核心组件
│   │   │   ├── state.py    # AgentState 类型定义
│   │   │   └── builder.py  # Agent 构建器
│   │   ├── registry/       # Agent 配置注册
│   │   │   ├── loader.py   # 配置加载器
│   │   │   └── agents.yaml # Agent 配置文件
│   │   ├── prompts/        # 系统提示词
│   │   │   ├── terminal.yaml
│   │   │   ├── chat.yaml
│   │   │   └── craft.yaml
│   │   ├── tools/          # 工具定义
│   │   │   ├── terminal.py # 终端交互工具
│   │   │   └── monitoring.py # 监控工具
│   │   └── factory.py      # Agent 工厂（编译和缓存）
│   ├── terminal/           # pty 管理
│   │   ├── pty_manager.py  # pty 进程封装
│   │   ├── session_manager.py # 多终端会话管理
│   │   └── ws_handler.py   # WebSocket 处理，含 # 检测逻辑
│   ├── ssh/                # SSH 连接管理
│   │   ├── connection_manager.py # SSH 连接管理器
│   │   ├── pty_spawner.py  # SSH PTY 启动器
│   │   ├── file_transfer.py # 文件传输
│   │   └── transfer_jobs.py # 传输任务队列
│   ├── api/                # FastAPI 路由
│   │   ├── routes.py       # HTTP 路由
│   │   ├── ws_routes.py    # WebSocket 路由
│   │   └── ws_chat.py      # 侧边栏对话 WebSocket 处理器
│   ├── config.py           # pydantic-settings 配置
│   └── main.py             # FastAPI 入口
└── frontend/
    ├── src/
    │   ├── app/            # Next.js App Router
    │   ├── components/
    │   │   ├── Terminal/   # xterm.js 封装
    │   │   ├── AIPanel/    # 侧边栏 AI 对话面板
    │   │   ├── SSHPanel/   # SSH 连接管理面板
    │   │   ├── FileTransferDialog/ # 文件传输对话框
    │   │   ├── SettingsPanel/ # 设置面板
    │   │   ├── TabBar/     # 多标签栏
    │   │   ├── TitleBar/   # 标题栏
    │   │   └── Layout/     # 分栏布局
    │   ├── lib/
    │   │   ├── websocket.ts    # WebSocket 客户端（含重连）
    │   │   ├── axios.ts        # axios 实例
    │   │   └── api/generated.ts # orval 生成的 hooks
    │   └── types/          # TypeScript 类型
    └── orval.config.ts     # API 代码生成配置
```

## 消息协议（WebSocket）

### 终端 WebSocket

| 方向       | type     | 含义                     |
|------------|----------|--------------------------|
| 前端 → 后端 | input    | 用户键盘输入              |
| 前端 → 后端 | resize   | 终端尺寸变化              |
| 后端 → 前端 | output   | pty 原始输出              |

**注意**：AI 的消息直接写入 pty，以 pty output 的形式返回前端，保证了人机合一的体验。

### 侧边栏对话 WebSocket

| 方向       | type          | 含义                     |
|------------|---------------|--------------------------|
| 前端 → 后端 | chat          | 发送对话消息              |
| 前端 → 后端 | clear         | 清空会话历史              |
| 前端 → 后端 | switch_mode   | 切换 Agent 模式           |
| 前端 → 后端 | switch_model  | 切换模型                  |
| 后端 → 前端 | start         | 对话开始                  |
| 后端 → 前端 | token         | 流式输出 token            |
| 后端 → 前端 | tool_start    | 工具调用开始              |
| 后端 → 前端 | tool_end      | 工具调用结束              |
| 后端 → 前端 | end           | 对话结束                  |
| 后端 → 前端 | error         | 错误消息                  |

## Agent 工具

### 终端交互工具

| 工具                   | 说明                                    |
|------------------------|----------------------------------------|
| terminal_input         | 执行命令或发送控制键，返回终端输出      |
| write_command          | 写入命令到输入行（不执行），等待用户确认 |
| get_terminal_context   | 获取最近的终端输出内容（只读）          |
| wait                   | 等待指定时间，用于观察输出变化          |

### 监控工具

| 工具                   | 说明                        |
|------------------------|----------------------------|
| query_prometheus       | 查询 Prometheus 指标（mock） |
| search_logs            | 搜索日志（Loki/ELK，mock）   |

## Agent 配置

Agent 通过 `backend/agent/registry/agents.yaml` 配置：

```yaml
agents:
  terminal:
    description: 终端内Agent，直接操作终端
    tools:
      - write_command
      - get_terminal_context
    prompt: terminal.yaml

  chat:
    description: 通用对话助手
    tools: []
    prompt: chat.yaml

  craft:
    description: 代码创作助手，可直接操作终端
    tools:
      - terminal_input
      - get_terminal_context
    prompt: craft.yaml
```

## 技术栈

- **后端**：Python 3.12 + FastAPI + LangGraph + LangChain（OpenAI 协议兼容）+ ptyprocess + paramiko
- **前端**：Next.js 14 + TypeScript + xterm.js + TanStack Query + axios
- **API 代码生成**：orval（从 OpenAPI 自动生成 react-query hooks）
- **部署**：Docker Compose / PyInstaller 桌面应用
