# Show HN: WinkTerm — AI that types commands into your terminal (MIT, self-hosted)

> Copy-paste drafts for posting WinkTerm to various promotion channels.

---

## Hacker News (Show HN)

**Title:** WinkTerm — open-source AI that types commands into your terminal

**URL:** https://github.com/Cznorth/winkterm

**Text:**
I built an open-source AI terminal where the AI writes commands directly into your shell's input line. You review, edit, and press Enter.

Key differentiator from Warp/Tabby/Claude Code: it shares your PTY session, so the AI sees the same shell state you do, and types directly at your cursor. No more context-switching between ChatGPT and your terminal.

Built with Python + FastAPI + LangGraph backend, Next.js + xterm.js frontend.

MIT licensed, self-hosted via Docker, no telemetry.

---

## Reddit r/selfhosted

**Title:** I built WinkTerm — an open-source AI terminal where the AI types commands into your shell, not just suggests them

**Text:**
Hey r/selfhosted!

I've been working on an open-source AI terminal called WinkTerm, and I wanted to share it with the community.

The core idea is simple: instead of having AI suggest commands that you copy-paste, the AI writes directly into your terminal's input line. You review, edit, and press Enter. It's like having a knowledgeable partner who can reach across the screen and type.

**Why self-hosted relevant:**
- MIT licensed, fully self-hosted
- BYO LLM — bring your own API key (OpenAI, Anthropic, Ollama, or any OpenAI-compatible endpoint)
- Deploy with one `docker compose up -d`
- No telemetry, no cloud dependency, your data stays on your infra

**Key features:**
- Shared PTY session — AI and user in the same terminal process
- In-terminal chat — type `#` followed by your question at your prompt
- SSH remote connections with file transfer
- Multi-model support
- Web UI + Desktop app (Windows/macOS)

**Quick start:**
```bash
docker run -p 3000:3000 -p 8000:8000 -e ANTHROPIC_API_KEY=*** ghcr.io/cznorth/winkterm:latest
```

https://github.com/Cznorth/winkterm

I'd love to hear your thoughts — especially from folks who manage servers remotely and might find the SSH + AI combo useful!

---

## Reddit r/devops

**Title:** I built an open-source AI terminal with SSH support and shared PTY — looking for feedback

**Text:**
As a DevOps engineer, I got tired of alt-tabbing to ChatGPT just to copy-paste commands. So I built WinkTerm — an open-source AI terminal where the AI writes commands directly into your shell's input line.

It shares your PTY session, so the AI sees the same terminal output you do and can type responses where your cursor is. No more context switching.

**What makes it different:**
- Works over SSH — connect to remote servers and the AI helps there too
- Built-in file transfer
- BYO LLM — use whatever model you have access to
- Docker deploy, ready in 60 seconds

**Quick start:**
```bash
docker run -p 3000:3000 -p 8000:8000 -e ANTHROPIC_API_KEY=*** ghcr.io/cznorth/winkterm:latest
```

GitHub: https://github.com/Cznorth/winkterm

Would love to hear what you think, especially if you've used Warp/Tabby/Claude Code and can compare. Is this useful for your daily ops work?

---

## Reddit r/opensource

**Title:** WinkTerm — open-source AI that types commands in your terminal (MIT license)

**Text:**
I open-sourced WinkTerm today under MIT license — an AI terminal where the AI types commands directly into your shell's input line.

https://github.com/Cznorth/winkterm

Stack: Python + FastAPI + LangGraph backend, Next.js + xterm.js frontend, Docker deployment.

**Features:**
- Shared PTY between user and AI
- SSH remote connections with file transfer
- In-terminal `#chat`
- Multi-model (OpenAI, Anthropic, Ollama)
- Web UI + Desktop app

Contributions welcome — especially tests, error handling, and kubectl/docker agent tools!

Promo video: https://github.com/Cznorth/winkterm/raw/master/assets/promo.mp4

---

## AlternativeTo (suggested description)

**Software Name:** WinkTerm
**Category:** Terminal Emulator / Developer Tools
**Description:** An open-source AI terminal where the AI types commands directly into your shell. It shares your PTY session, supports SSH remote connections with file transfer, and works with multiple LLM providers (OpenAI, Anthropic, Ollama). Self-hosted via Docker, MIT licensed.
**Alternatives to:** Warp, Tabby, Termius
**Tags:** AI terminal, SSH client, self-hosted, terminal emulator

---

## Terminal Trove (email submission)

**To:** curator@terminaltrove.com
**Subject:** Tool Submission: WinkTerm - Open-source AI terminal

```
Tool Name: WinkTerm
URL: https://github.com/Cznorth/winkterm
Tagline: Open-source AI terminal that types commands directly into your shell
Description:
WinkTerm is an open-source AI terminal. Instead of suggesting commands for you to copy-paste, the AI writes them directly into your terminal input line. You review, edit, and press Enter. It shares your PTY session so the AI sees the same output you do.

Key features:
- Shared PTY session between AI and user
- In-terminal #chat
- SSH remote connections with file transfer
- Multi-model (OpenAI, Anthropic, Ollama)
- Web UI + Desktop app (Windows/macOS)
- Self-hosted via Docker, MIT licensed

Preview Image: https://raw.githubusercontent.com/Cznorth/winkterm/master/assets/og-image-social.png
GitHub: https://github.com/Cznorth/winkterm
Homepage: https://cznorth.github.io/winkterm/
License: MIT
Language: Python, TypeScript
Platform: Linux, macOS, Windows
Categories: AI, CLI, devops, docker, ssh, networking, terminal
```
