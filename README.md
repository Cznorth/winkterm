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
[![Twitter](https://img.shields.io/twitter/url?url=https%3A%2F%2Fgithub.com%2FCznorth%2Fwinkterm)](https://twitter.com/intent/tweet?text=WinkTerm%20-%20AI%20that%20shares%20your%20terminal%20session&url=https://github.com/Cznorth/winkterm)

</div>

<p align="center">
  <a href="#-demo">Demo</a> •
  <a href="#-features">Features</a> •
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

```
$ # why is nginx returning 502?
[WinkTerm] Let me check. Looking at nginx error logs...
[WinkTerm] I can see the upstream is unreachable. Try this:
$ curl -I http://localhost:3000█   ← AI wrote this. Press Enter to run.
                                       Backspace to edit. Ctrl+C to cancel.
```

**This is not a ChatGPT wrapper pasted into a terminal.**
The AI writes directly into your terminal's input line. You stay in control — press Enter to execute, edit freely, or cancel. It's like SSH-ing into a server with a knowledgeable partner who can reach across the screen and type.

---

## ✨ Features

- **Shared PTY Session** — AI and user operate in the same terminal process. No copy-paste, no "run this command" without context.
- **In-Terminal Chat** — Type `#` followed by your question, right where your shell prompt is. No need to alt-tab.
- **Sidebar AI Panel** — Full conversational interface with mode switching (chat, terminal ops, code generation).
- **SSH Remote Connections** — Connect to remote servers with built-in file transfer.
- **Multi-Model Support** — Bring your own LLM. OpenAI, Anthropic, Ollama, or any OpenAI-compatible endpoint.
- **Docker & Desktop** — Deploy instantly with `docker compose up` or package as a standalone desktop app (Windows/macOS).

---

## 🔥 Why WinkTerm?

| Feature | WinkTerm | Warp | Tabby | Claude Code |
|---------|----------|------|-------|-------------|
| Shared PTY (AI types in your terminal) | ✅ | ❌ | ❌ | ❌ |
| Open source | ✅ | ❌ | ✅ | ❌ |
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
  -e ANTHROPIC_API_KEY=your-key \
  ghcr.io/Cznorth/winkterm:latest
```

Or with docker-compose:

```bash
git clone https://github.com/Cznorth/winkterm.git
cd winkterm
cp .env.example .env
# Edit .env with your API keys
docker compose up -d
```

Then open **http://localhost:3000**

### Desktop App

Download the latest release for your platform from the [Releases page](https://github.com/Cznorth/winkterm/releases).

- **Windows**: `.exe` installer
- **macOS**: `.app` bundle (Intel & Apple Silicon)

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
| Database-less | Config persisted to `~/.winkterm/config.json` |
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
    <a href="https://twitter.com/intent/tweet?text=WinkTerm%20-%20AI%20that%20shares%20your%20terminal%20session&url=https://github.com/Cznorth/winkterm">Share on Twitter</a>
  </p>
</div>
