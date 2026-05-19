<div align="center">
  <img src="assets/logo.svg" alt="WinkTerm Logo" width="120"/>
  <h1>WinkTerm</h1>
  <p><strong>与你共享终端会话的 AI</strong></p>
  <p>不是一个只会建议命令的聊天机器人，而是在同一个 PTY 中与你并肩操作的协作者。</p>
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
  <a href="#-demo">演示</a> •
  <a href="#-features">功能特性</a> •
  <a href="#-quick-start">快速开始</a> •
  <a href="#-why-winkterm">为什么选择 WinkTerm？</a> •
  <a href="#-architecture">架构</a> •
  <a href="#-configuration">配置</a> •
  <a href="#-development">开发</a> •
  <a href="#-roadmap">路线图</a>
</p>

---

## 🎬 演示

![WinkTerm Demo](assets/demo.gif)

[▶️ 观看宣传视频](assets/promo.mp4)

```
$ # nginx 为什么报 502？
[WinkTerm] 让我看看。正在检查 nginx 错误日志...
[WinkTerm] 发现 upstream 不可达。试试这个：
$ curl -I http://localhost:3000█   ← AI 写入的。按回车执行。
                                       退格修改。Ctrl+C 取消。
```

**这不是一个套在终端里的 ChatGPT。**
AI 直接写入你的终端输入行。你始终掌控一切 — 按回车执行、自由编辑、或取消。就像在 SSH 到服务器时，身边坐着一位懂技术的搭档，能直接伸手帮你打字。

---

## ✨ 功能特性

- **共享 PTY 会话** — AI 和用户在同一个终端进程中操作。无需复制粘贴，没有脱离上下文的"运行这个命令"。
- **终端内对话** — 在 shell 提示符处直接输入 `#` 加你的问题，无需切换窗口。
- **侧边栏 AI 面板** — 完整的对话界面，支持模式切换（闲聊、终端操作、代码生成）。
- **SSH 远程连接** — 连接远程服务器，内置文件传输功能。
- **多模型支持** — 自带 LLM。OpenAI、Anthropic、Ollama 或任何兼容 OpenAI 协议的端点。
- **Docker 与桌面应用** — 通过 `docker compose up` 一键部署，或打包为独立桌面应用（Windows/macOS）。

---

## 🔥 为什么选择 WinkTerm？

| 特性 | WinkTerm | Warp | Tabby | Claude Code |
|------|----------|------|-------|-------------|
| 共享 PTY（AI 在终端中打字） | ✅ | ❌ | ❌ | ❌ |
| 开源 | ✅ | ❌ | ✅ | ❌ |
| 自托管 / 自带 LLM | ✅ | ❌ | ❌ | ✅ |
| Web UI | ✅ | ✅ | ✅ | ❌（仅 CLI） |
| SSH + 文件传输 | ✅ | ❌ | ✅ | ❌ |
| 桌面应用 | ✅ | ✅ | ✅ | ❌ |

**WinkTerm 的核心理念**：终端是运维发生的地方。AI 应该活在终端*里面*，而不是旁边。当 AI 将命令写入你的输入行，你按下回车 — 这不是盲目信任，而是在审查、理解和选择。这就是协作运维。

---

## 🚀 快速开始

### Docker（最简方式）

```bash
docker run -p 3000:3000 -p 8000:8000 \
  -e ANTHROPIC_API_KEY=*** \
  ghcr.io/cznorth/winkterm:latest
```

或使用 docker-compose：

```bash
git clone https://github.com/Cznorth/winkterm.git
cd winkterm
cp .env.example .env
# 编辑 .env 填写你的 API Key
docker compose up -d
```

然后打开 **http://localhost:3000**

### 桌面应用

从 [Releases 页面](https://github.com/Cznorth/winkterm/releases) 下载最新版本。

- **Windows**：`.exe` 安装包
- **macOS**：`.app` 安装包（Intel 和 Apple Silicon）

---

## ⚙️ 配置

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `ANTHROPIC_API_KEY` | Anthropic API key（必填） | — |
| `OPENAI_API_KEY` | OpenAI API key（备选） | — |
| `MODEL_NAME` | 使用的模型 | `claude-sonnet-4-20250514` |
| `OPENAI_BASE_URL` | 自定义 API 端点 | — |
| `AGENT_RECURSION_LIMIT` | Agent 递归限制 | `100` |
| `PROMETHEUS_URL` | Prometheus 端点 | `http://localhost:9090` |
| `LOKI_URL` | Loki 端点 | `http://localhost:3100` |
| `DEBUG` | 启用调试模式 | `false` |

> **自带 LLM**：WinkTerm 使用兼容 OpenAI 的协议。将 `OPENAI_BASE_URL` 设置为任意提供商（Ollama、vLLM、Groq、OpenRouter 等），WinkTerm 即可使用。

---

## 🏗 架构

```
用户键盘输入
    │
    ▼
前端终端 (xterm.js)
    │  WebSocket
    ▼
ws_handler.py
    │
    ├── 普通输入 ──► pty_manager.write() ──► shell 进程
    │
    └── 以 # 开头的行 ──► 拦截 ──► Agent (LangGraph)
                                                    │
                                                    ├── get_terminal_context()
                                                    ├── terminal_input()
                                                    └── write_command() ──► pty ──► 终端输入行
```

**关键洞察**：AI 消息直接写入 PTY 输出流，因此会无缝显示在你的终端中。无需独立的 UI 界面，无需上下文切换。

### 技术栈

| 层 | 技术 |
|-----|------|
| 后端 | Python + FastAPI + LangGraph + LangChain |
| 前端 | Next.js 14 + TypeScript + xterm.js |
| 无数据库 | 配置持久化到 `~/.winkterm/config.json` |
| 部署 | Docker Compose / PyInstaller 桌面应用 |

---

## 🛠 开发

### 前置要求

- Python 3.12+
- Node.js 20+
- Docker（可选）

### 后端

```bash
cd backend
python -m venv .venv
source .venv/bin/activate  # Windows: .venv\Scripts\activate
pip install -r requirements.txt
python -m uvicorn backend.main:app --reload --port 8000
```

### 前端

```bash
cd frontend
npm install
npm run dev
```

打开 http://localhost:3000

### API 类型（orval）

```bash
# 确保后端已启动
cd frontend
npm run gen:api
```

---

## 🗺 路线图

- [ ] Vim/Neovim 集成（AI 在缓冲区中写入）
- [ ] 终端录制与回放（类似回放）
- [ ] 多 Agent 编排（并行操作）
- [ ] 自定义工具的插件系统
- [ ] 原生 tmux 集成
- [ ] Kubernetes 上下文感知

---

## 🤝 参与贡献

欢迎贡献！请参阅 [CONTRIBUTING.md](CONTRIBUTING.md) 了解指南。

**适合初次 PR 的想法：**
- 改进错误消息和边界情况处理
- 添加更多 Agent 工具（kubectl、docker、git 辅助工具）
- 编写测试（后端测试覆盖不足）
- 改进 xterm.js 主题/配色方案
- 添加 Agent 提示词的语言支持

---

## 📄 许可证

[MIT](LICENSE) © 2026 Cznorth

---

## 🌐 多语言

- [English](README.md)
- [中文](README.zh-CN.md)（当前）

---

<div align="center">
  <p>由 <a href="https://github.com/Cznorth">Cznorth</a> 用 ❤️ 制作</p>
  <p>
    <a href="https://github.com/Cznorth/winkterm/issues">报告 Bug</a> •
    <a href="https://github.com/Cznorth/winkterm/discussions">讨论</a> •
    <a href="https://star-history.com/#Cznorth/winkterm&Date">Star 历史</a> •
    <a href="https://twitter.com/intent/tweet?text=WinkTerm%20-%20AI%20that%20shares%20your%20terminal%20session&url=https://github.com/Cznorth/winkterm">分享到 Twitter</a>
  </p>
</div>
