<div align="center">

[中文版本](README.zh-CN.md)

</div>

<div align="center">
  <img src="assets/logo.svg" alt="WinkTerm Logo" width="120"/>
  <h1>WinkTerm</h1>
  <p><strong>AI that shares your terminal session.</strong></p>
  <p>Not a chatbot that suggests commands. A collaborator that types alongside you in the same PTY.</p>
</div>

<br>

<div align="center">

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/language-TypeScript%20%2F%20Python-blue)](https://github.com/Cznorth/winkterm)
[![Docker](https://img.shields.io/badge/deploy-Docker-2496ED?logo=docker)](docker-compose.yml)
[![GitHub Stars](https://img.shields.io/github/stars/Cznorth/winkterm?style=social)](https://github.com/Cznorth/winkterm)
[![Star History](https://api.star-history.com/svg?repos=Cznorth/winkterm&type=Date)](https://star-history.com/#Cznorth/winkterm&Date)
[![Visitors](https://api.visitorbadge.io/api/visitors?path=https%3A%2F%2Fgithub.com%2FCznorth%2Fwinkterm&label=Visitors&countColor=%23263759)](https://github.com/Cznorth/winkterm)
[![Twitter](https://img.shields.io/twitter/url?url=https%3A%2F%2Fgithub.com%2FCznorth%2Fwinkterm)](https://twitter.com/intent/tweet?text=WinkTerm%20-%20AI%20that%20shares%20your%20terminal%20session&url=https://github.com/Cznorth/winkterm)
[![Promo Video](https://img.shields.io/badge/Promo-Video-ff0000?logo=youtube)](assets/promo.mp4)
[![Dev.to](https://img.shields.io/badge/Read%20on-Dev.to-0A0A0A?logo=dev.to)](https://dev.to/cznorth/winkterm-ai-that-shares-your-terminal-session-not-just-command-suggestions-8p9)
[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/Cznorth/winkterm)

</div>

<p align="center">
  <a href="#-demo">Demo</a> •
  <a href="#-features">Features</a> •
  <a href="#-agent-api-highlights">Agent API</a> •
  <a href="#-quick-start">Quick Start</a> •
  <a href="#-why-winkterm">Why WinkTerm?</a> •
  <a href="#-architecture">Architecture</a> •
  <a href="#-configuration">Configuration</a> •
  <a href="#-development">Development</a> •
  <a href="#-roadmap">Roadmap</a>
</p>

---

## 🎬 Demo

![WinkTerm Demo](assets/demo.gif)

*GIF — real SSH session: a mistaken command (`ipconfig`), then `# what's wrong`; the AI answers in the same PTY and can pre-fill the fix.*

[▶️ Watch Promo Video](assets/promo.mp4)

*Promo — single-column terminal with multiple SSH tabs; Craft orchestrates checks across hosts (`list_ssh_connections`, `terminal_exec`, `ssh_run`).*

```
$ ipconfig
Command 'ipconfig' not found, did you mean: ...
$ # what's wrong
[WinkTerm] `ipconfig` is a Windows command — on Linux use `ip addr` (or `ifconfig`).
$ ip addr█   ← AI wrote this. Press Enter to run. Backspace to edit. Ctrl+C to cancel.
```

**This is not a ChatGPT wrapper pasted into a terminal.**
The AI writes directly into your terminal's input line. You stay in control — press Enter to execute, edit freely, or cancel. It's like SSH-ing into a server with a knowledgeable partner who can reach across the screen and type.

---

## ✨ Features

- **Shared PTY Session** — AI and user operate in the same terminal process. No copy-paste, no "run this command" without context.
- **In-Terminal Chat** — Type `#` followed by your question, right where your shell prompt is. No need to alt-tab.
- **Sidebar AI Panel** — Full conversational interface with multi-conversation tabs, AI-generated titles, and chat/craft mode switching.
- **Persistent Chat History** — Conversations are saved to `~/.winkterm/chat_history.json` and restored on page load; survives WebSocket reconnects and backend restarts.
- **Streaming Resume** — Refresh or reconnect mid-response without losing in-flight tokens; active streams are tracked server-side and replayed to new WebSocket clients.
- **Streaming Queue & Suggestions** — Queue follow-up messages while the AI is responding (interrupt or drop queued items anytime), and get one-click follow-up suggestion chips after each answer.
- **External Agent API** — An authenticated HTTP interface lets external agents drive your terminal, SSH, and file transfers via an installable skill (see Agent API highlights below).
- **Agent Terminals in Your Tabs** — Agent-created sessions appear as normal terminal tabs (no separate monitor panel). `GET /api/sessions/stream` keeps the UI in sync; WebSocket disconnect no longer kills PTY sessions — refresh replays buffered output.
- **Remote Access Auth** — Web access is protected by an access key; the local desktop client needs no authentication.
- **SSH Remote Connections** — Connect to remote servers with built-in file transfer. Editing a connection without re-entering the password keeps the saved credential.
- **Settings Export & Secret-safe Saves** — Export `config.json` from Settings (`GET /api/settings/export`). Blank password or API key fields on save do not wipe stored secrets.
- **Reliable Terminals** — Debounced PTY sizing fixes truncated PowerShell prompts; agent multi-tab creation no longer leaves empty panes; WebSocket reconnect is silent (no disconnect banner that breaks PSReadLine).
- **Internationalization** — Built-in English / Chinese UI, with language selection on first launch.
- **Multi-Model Support** — Bring your own LLM. OpenAI, Anthropic, Ollama, or any OpenAI-compatible endpoint.
- **Docker & Desktop** — Deploy instantly with `docker compose up` or package as a standalone desktop app (Windows/macOS).

---

## 🤖 Agent API Highlights

WinkTerm's HTTP Agent API is designed for AI agents (Claude Code, Cursor, etc.) to drive the terminal remotely — not just an afterthought.

### Endpoints

| Endpoint | Purpose |
|----------|---------|
| `POST /api/agent/terminals/{id}/exec` | **Atomic execution**: returns stdout + real `exit_code` + current `cwd`. Sentinel marker auto-strips command echo and prompt. Supports `cwd` / `env` subshell injection (doesn't pollute persistent terminal state). |
| `POST /api/agent/ssh/{conn_id}/run` | **One-shot SSH execution**: bundles create → exec → close into one call, saving 3 round-trips. |
| `POST/GET/PUT/DELETE /api/agent/ssh/connections[/{id}]` | **SSH connection management**: full CRUD on the stored connection profiles, plus `POST /api/agent/ssh/import/electerm`. Update leaves masked/omitted secrets unchanged. |
| `POST /api/agent/terminals/{id}/input` | **Named control keys**: `{"keys": ["ctrl+c"]}` instead of stuffing control chars into JSON. `data_b64` input bypasses multi-layer quote escape hell. |
| `GET /api/agent/terminals/{id}/snapshot?pattern=...` | **Server-side grep**: regex-match within the 256KB rolling buffer. Save bandwidth. |
| `GET /api/agent/terminals/{id}/stream` | **SSE live output**: killer feature for long-running commands / `tail -f`. Resume with `since` after disconnect. |
| `GET /api/agent/events/stream` | **Operation event feed**: every agent action is pushed to a ring buffer (no persistence), broadcast via SSE. |
| `GET /api/sessions` / `GET /api/sessions/stream` | **Session lifecycle**: list user-visible terminals; SSE pushes `session_created` / `session_closed` so the web UI tab bar stays in sync with agent activity. |
| `GET /api/chat/conversations` | **Chat persistence**: list saved sidebar conversations (also written to `~/.winkterm/chat_history.json`). |
| `GET /api/settings/export` | **Config backup**: download full `config.json` (localhost or valid `X-Access-Key`). |
| `GET /api/agent/handshake` | **Zero-config onboarding**: localhost or web-auth'd clients get the token automatically. The agent doesn't need to ask the user every session. |

### Key Design Choices

- **Exit codes are first-class**: no need to grep output to detect failure — `exit_code` is in the response.
- **30+ named keys**: `ctrl+c` / `up` / `tab` / `esc` / `f1` — no raw control chars in JSON.
- **base64 input**: complex awk / jq / heredoc commands go through `command_b64`, sidestepping triple-escaping.
- **Persistent cwd tracking**: the exec sentinel reports `$PWD` after every run; the monitoring panel displays the terminal's current directory.
- **TTL auto-cleanup**: terminals default to 30-minute idle TTL, so forgotten terminals don't leak.
- **wait reason field**: distinguishes `idle` / `timeout` / `no_output` so callers know what happened.

### Installable Skill

**Claude Code plugin (one-liner):**

```bash
/plugin marketplace add Cznorth/winkterm
/plugin install winkterm-remote@winkterm
```

**Any agent (raw skill from a running backend):**

```bash
curl -s http://<your-winkterm-host>:8000/api/agent/skill.md > SKILL.md
```

Drop SKILL.md into Claude Code / Cursor / any agent tool's skills directory and the AI immediately knows how to drive the API. The skill is versioned — agents check for updates each session.

### Unified Session Pool

Internal craft agents and the external HTTP API share the same terminal session pool and tool surface (`list` / `create` / `close` / `snapshot` / `input` / `exec` / `ssh_run`). Agent-created terminals are **user-visible** and open as regular tabs in the main UI. Subscribe to `/api/sessions/stream` for live tab sync, or `/api/agent/events/stream` for a color-coded operation audit log.

### Case Study

[📖 Case: AI agent locates and removes an XMR cryptojacker in 30 minutes via WinkTerm](docs/case-study-xmr-miner-cleanup.en.md)

A real incident write-up: user said only "the 107.173 server's load is high," and the AI agent completed discovery → investigation → kill chain reconstruction → hardening → abuse reporting end-to-end via the Agent API. The 9 new features in this release were reverse-engineered from the pain points hit during this exact case.

---

## 🔥 Why WinkTerm?

| Feature | WinkTerm | Warp | Tabby | Claude Code |
|---------|----------|------|-------|-------------|
| Shared PTY (AI types in your terminal) | ✅ | ❌ | ❌ | ❌ |
| Open source | ✅ | ✅ | ✅ | ❌ |
| Self-hosted / BYO LLM | ✅ | ❌ | ❌ | ✅ |
| Web UI | ✅ | ✅ | ✅ | ❌ (CLI only) |
| SSH + file transfer | ✅ | ❌ | ✅ | ❌ |
| Desktop app | ✅ | ✅ | ✅ | ❌ |

**WinkTerm's core philosophy**: The terminal is where operations happen. AI should live *inside* it, not beside it. When the AI writes a command into your input line and you press Enter, you're not blindly trusting — you're reviewing, understanding, and choosing. That's collaborative ops.

---

## 🚀 Quick Start

### Docker (easiest)

```bash
docker run -p 3000:3000 -p 8000:8000 \
  -e ANTHROPIC_API_KEY=*** \
  ghcr.io/cznorth/winkterm:latest
```

Or with docker-compose:

```bash
git clone https://github.com/Cznorth/winkterm.git
cd winkterm
cp .env.example .env
# Edit .env with your API keys
docker compose up -d
```

The compose file mounts a `winkterm-data` volume at `/root/.winkterm`, so config, chat history, and SSH credentials survive container rebuilds. The image also bundles the installable agent skill (no 404 on `skill.md` fetch).

Then open **http://localhost:3000**

### Desktop App

Download the latest release for your platform from the [Releases page](https://github.com/Cznorth/winkterm/releases).

- **Windows**: `.exe` installer
- **macOS**: `.app` bundle (Intel & Apple Silicon). The desktop build starts the embedded backend before opening the WebView and avoids baking dev-only `localhost:8000` into static assets.

---

## ⚙️ Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `ANTHROPIC_API_KEY` | Anthropic API key (required) | — |
| `OPENAI_API_KEY` | OpenAI API key (alternative) | — |
| `MODEL_NAME` | Model to use | `claude-sonnet-4-20250514` |
| `OPENAI_BASE_URL` | Custom API endpoint | — |
| `AGENT_RECURSION_LIMIT` | Agent recursion limit | `100` |
| `PROMETHEUS_URL` | Prometheus endpoint | `http://localhost:9090` |
| `LOKI_URL` | Loki endpoint | `http://localhost:3100` |
| `DEBUG` | Enable debug mode | `false` |

> **Bring your own LLM**: WinkTerm uses the OpenAI-compatible protocol. Set `OPENAI_BASE_URL` to any provider (Ollama, vLLM, Groq, OpenRouter, etc.) and WinkTerm will use it.

---

## 🏗 Architecture

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
                                                    └── write_command() ──► pty ──► terminal input line
```

**Key insight**: AI messages are written directly into the PTY output stream, so they appear seamlessly in your terminal. No separate UI chrome, no context switching.

### Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | Python + FastAPI + LangGraph + LangChain |
| Frontend | Next.js 14 + TypeScript + xterm.js |
| Database-less | `~/.winkterm/config.json` + `chat_history.json` on disk |
| Deployment | Docker Compose / PyInstaller desktop app |

---

## 🛠 Development

### Prerequisites

- Python 3.12+
- Node.js 20+
- Docker (optional)

### Backend

```bash
cd backend
python -m venv .venv
source .venv/bin/activate  # Windows: .venv\Scripts\activate
pip install -r requirements.txt
python -m uvicorn backend.main:app --reload --port 8000
```

### Frontend

```bash
cd frontend
npm install
npm run dev
```

Open http://localhost:3000

### Frontend verification

In **Cursor**, use the built-in browser MCP against `http://localhost:3000` (click `.xterm-screen`, read `.xterm-rows` via CDP). Elsewhere, use `puppeteer-core` with system Chrome — see [CLAUDE.md](CLAUDE.md) for the full smoke checklist and agent HTTP curl recipes.

### README media (maintainers)

Requires local frontend/backend, system Chrome, and `ffmpeg`. Uses your `~/.winkterm/config.json` (theme, language, SSH connections).

```bash
cd scripts && npm install
node record-readme-normal.mjs   # → assets/demo.gif
node record-promo-normal.mjs    # → assets/promo.mp4
node capture-og-image.mjs       # → assets/og-image-social.png (from demo final frame)
```

Slow down an existing GIF without re-recording: `REBUILD_GIF_ONLY=1 GIF_FRAME_SEC=1.4 node record-readme-normal.mjs`

### API Types (orval)

```bash
# With the backend running
cd frontend
npm run gen:api
```

---

## 🗺 Roadmap

- [ ] Vim/Neovim integration (AI writes inside buffers)
- [ ] Terminal recording & replay (as replays)
- [ ] Multi-Agent orchestration (parallel ops)
- [ ] Plugin system for custom tools
- [ ] Native tmux integration
- [ ] Kubernetes context awareness

---

## 🤝 Contributing

We welcome contributions! See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

**Ideas for first PRs:**
- Improve error messages and edge-case handling
- Add more agent tools (kubectl, docker, git helpers)
- Write tests (backend is undertested)
- Improve the xterm.js theme/color scheme
- Add language support for agent prompts

---

## 🔗 Friendly Links

- [LinuxDo](https://linux.do) — a community of people who love technology

---

## 📄 License

[MIT](LICENSE) © 2026 Cznorth

---

## 🌐 Translations

- [English](README.md) (current)
- [中文](README.zh-CN.md)

---

<div align="center">
  <p>Made with ❤️ by <a href="https://github.com/Cznorth">Cznorth</a></p>
  <p>
    <a href="https://github.com/Cznorth/winkterm/issues">Report Bug</a> •
    <a href="https://github.com/Cznorth/winkterm/discussions">Discussion</a> •
    <a href="https://star-history.com/#Cznorth/winkterm&Date">Star History</a> •
    <a href="https://twitter.com/intent/tweet?text=WinkTerm%20-%20AI%20that%20shares%20your%20terminal%20session&url=https://github.com/Cznorth/winkterm">Share on Twitter</a>
  </p>
</div>
