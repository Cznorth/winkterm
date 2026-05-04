# WinkTerm Architecture

## Overview

WinkTerm is an AI + terminal human-machine integrated operations tool. The AI and user share the same PTY session, supporting both in-terminal interaction and sidebar conversation modes.

## Core Design: Human-Machine Unified Terminal

```
User Keyboard Input
    │
    ▼
Frontend Terminal (xterm.js)
    │  WebSocket
    ▼
ws_handler.py
    │
    ├── Normal input ──► pty_manager.write() ──► shell process
    │
    └── Lines starting with # ──► intercept ──► Agent (LangGraph)
                                                    │
                                                    ├── get_terminal_context()
                                                    ├── terminal_input()
                                                    └── write_command() ──► pty ──► terminal input line (not executed)
```

## Directory Structure

```
winkterm/
├── backend/
│   ├── agent/              # LangGraph Agent
│   │   ├── core/           # Core components
│   │   │   ├── state.py    # AgentState type definitions
│   │   │   └── builder.py  # Agent builder
│   │   ├── registry/       # Agent config registry
│   │   │   ├── loader.py   # Config loader
│   │   │   └── agents.yaml # Agent configuration file
│   │   ├── prompts/        # System prompts
│   │   │   ├── terminal.yaml
│   │   │   ├── chat.yaml
│   │   │   └── craft.yaml
│   │   ├── tools/          # Tool definitions
│   │   │   ├── terminal.py # Terminal interaction tools
│   │   │   └── monitoring.py # Monitoring tools
│   │   └── factory.py      # Agent factory (compile and cache)
│   ├── terminal/           # PTY management
│   │   ├── pty_manager.py  # PTY process wrapper
│   │   ├── session_manager.py # Multi-session management
│   │   └── ws_handler.py   # WebSocket handler with # detection logic
│   ├── ssh/                # SSH connection management
│   │   ├── connection_manager.py # SSH connection manager
│   │   ├── pty_spawner.py  # SSH PTY spawner
│   │   ├── file_transfer.py # File transfer
│   │   └── transfer_jobs.py # Transfer job queue
│   ├── api/                # FastAPI routes
│   │   ├── routes.py       # HTTP routes
│   │   ├── ws_routes.py    # WebSocket routes
│   │   └── ws_chat.py      # Sidebar chat WebSocket handler
│   ├── config.py           # pydantic-settings configuration
│   └── main.py             # FastAPI entry point
└── frontend/
    ├── src/
    │   ├── app/            # Next.js App Router
    │   ├── components/
    │   │   ├── Terminal/   # xterm.js wrapper
    │   │   ├── AIPanel/    # Sidebar AI chat panel
    │   │   ├── SSHPanel/   # SSH connection management panel
    │   │   ├── FileTransferDialog/ # File transfer dialog
    │   │   ├── SettingsPanel/ # Settings panel
    │   │   ├── TabBar/     # Multi-tab bar
    │   │   ├── TitleBar/   # Title bar
    │   │   └── Layout/     # Split-pane layout
    │   ├── lib/
    │   │   ├── websocket.ts    # WebSocket client (with reconnection)
    │   │   ├── axios.ts        # Axios instance
    │   │   └── api/generated.ts # orval generated hooks
    │   └── types/          # TypeScript types
    └── orval.config.ts     # API code generation config
```

## Message Protocol (WebSocket)

### Terminal WebSocket

| Direction     | type     | Meaning                    |
|---------------|----------|----------------------------|
| Frontend → Backend | input    | User keyboard input        |
| Frontend → Backend | resize   | Terminal resize event      |
| Backend → Frontend | output   | Raw PTY output             |

**Note**: AI messages are written directly to the PTY output stream, appearing in the terminal as if they came from the shell itself — this ensures the human-machine unified experience.

### Sidebar Chat WebSocket

| Direction     | type          | Meaning                        |
|---------------|---------------|--------------------------------|
| Frontend → Backend | chat          | Send chat message              |
| Frontend → Backend | clear         | Clear session history          |
| Frontend → Backend | switch_mode   | Switch agent mode              |
| Frontend → Backend | switch_model  | Switch model                   |
| Backend → Frontend | start         | Conversation started           |
| Backend → Frontend | token         | Streamed output token          |
| Backend → Frontend | tool_start    | Tool call started              |
| Backend → Frontend | tool_end      | Tool call ended                |
| Backend → Frontend | end           | Conversation ended             |
| Backend → Frontend | error         | Error message                  |

## Agent Tools

### Terminal Interaction Tools

| Tool                   | Description                                     |
|------------------------|-------------------------------------------------|
| terminal_input         | Execute a command or send control keys, returns terminal output |
| write_command          | Write a command to the input line (without executing), wait for user confirmation |
| get_terminal_context   | Get recent terminal output content (read-only)  |
| wait                   | Wait for a specified duration to observe output changes |

### Monitoring Tools

| Tool                   | Description                         |
|------------------------|-------------------------------------|
| query_prometheus       | Query Prometheus metrics (mock)     |
| search_logs            | Search logs (Loki/ELK, mock)        |

## Agent Configuration

Agents are configured via `backend/agent/registry/agents.yaml`:

```yaml
agents:
  terminal:
    description: In-terminal agent, operates the terminal directly
    tools:
      - write_command
      - get_terminal_context
    prompt: terminal.yaml

  chat:
    description: General-purpose chat assistant
    tools: []
    prompt: chat.yaml

  craft:
    description: Code and automation assistant with terminal access
    tools:
      - terminal_input
      - get_terminal_context
    prompt: craft.yaml
```

## Tech Stack

- **Backend**: Python 3.12 + FastAPI + LangGraph + LangChain (OpenAI protocol compatible) + ptyprocess + paramiko
- **Frontend**: Next.js 14 + TypeScript + xterm.js + TanStack Query + axios
- **API Code Generation**: orval (auto-generates react-query hooks from OpenAPI spec)
- **Deployment**: Docker Compose / PyInstaller desktop app
