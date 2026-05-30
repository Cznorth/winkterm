# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

WinkTerm is an AI + terminal "human-machine fusion" ops tool. The AI and the user share the same pty session, and all interaction happens inside the terminal. The user talks to the AI by typing a `# message`; the AI can suggest commands and write them into the input line, where the user presses Enter to run or Backspace to edit.

## Common Commands

### Backend Development
```bash
cd backend
python -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt

# Start the development server
python -m uvicorn backend.main:app --reload --port 8000
```

### Frontend Development
```bash
cd frontend
npm install
npm run dev           # Development mode
npm run build         # Build (output to frontend/out/)
npm run lint          # Lint check
npm run gen:api       # Generate TypeScript types and react-query hooks from OpenAPI
```

### Desktop App Packaging
```bash
# Windows
build\build.bat

# Or run manually
pyinstaller build\winkterm.spec --clean --noconfirm
```

### Docker Deployment
```bash
docker compose up -d
```

## Architecture

### Core Data Flow
```
User keyboard input
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
```

### Key Modules

| Module | Path | Responsibility |
|--------|------|----------------|
| WebSocket handling | `backend/terminal/ws_handler.py` | Message dispatch, `#` detection, Agent invocation |
| PTY management | `backend/terminal/pty_manager.py` | Shell process wrapper, read/write, context retrieval |
| Session management | `backend/terminal/session_manager.py` | Multi-terminal sessions, active state |
| Agent graph | `backend/agent/graph.py` | LangGraph StateGraph definition |
| Agent tools | `backend/agent/tools/` | Terminal interaction tool definitions |
| SSH connections | `backend/ssh/` | SSH connection management, file transfer |

### Agent Tools

- `terminal_input`: Run a command or send control keys, returns the execution result
- `write_command`: Write a command into the input line (without running it); the agent stops and waits for the user
- `get_terminal_context`: Read terminal output content (read-only)

### WebSocket Message Protocol

| Direction | type | Meaning |
|-----------|------|---------|
| Frontend → Backend | input | User keyboard input |
| Frontend → Backend | resize | Terminal size change |
| Backend → Frontend | output | Raw pty output |

AI messages are returned via pty output, preserving the human-machine fusion experience.

### Frontend Structure

- `src/app/`: Next.js App Router
- `src/components/Terminal/`: xterm.js wrapper
- `src/lib/websocket.ts`: WebSocket client (with reconnect)
- `src/lib/api/generated.ts`: orval-generated API hooks

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `ANTHROPIC_API_KEY` | Anthropic API Key | Yes |
| `MODEL_NAME` | Claude model name | No (default `claude-opus-4-6`) |
| `NEXT_PUBLIC_API_URL` | Backend HTTP API address | No |
| `NEXT_PUBLIC_WS_URL` | Backend WebSocket address | No |

## Frontend Debugging (Agent Self-Verification)

When verifying frontend fixes, **pick one method based on the runtime environment** (don't mix them):

| Environment | Method |
|-------------|--------|
| **Cursor IDE** | Built-in browser (Browser MCP) |
| **Others** (Claude Code, CI, agents without MCP) | puppeteer-core + system Chrome (see below) |

### Cursor: Built-in Browser (preferred)

When testing `http://localhost:3000` in Cursor, have the agent use **only the built-in browser** — don't start puppeteer.

**Prerequisites**: backend and frontend are running; `frontend/.env.example` has been copied to `frontend/.env.local` (pointing at `localhost:8000`).

**Recommended flow**:

1. `browser_navigate` → `http://localhost:3000`
2. `browser_lock` → interact → `browser_unlock`
3. Standard controls: `browser_snapshot` → `browser_click` / `browser_type` / `browser_fill`
4. **xterm terminal**: first click `.xterm-screen` (or click via `browser_cdp`), then type with `browser_press_key`; read output via `browser_cdp` + `Runtime.evaluate` on `.xterm-rows` (don't use whole-page `textContent`)
5. **Activity bar / split layout**: snapshots often lack a ref — use `browser_cdp` to click `.activity-item`, `.layout-btn`, etc.

**Smoke items to cover**: auth, local terminal echo, new tab, `+` dropdown, SSH list, settings page, AI sidebar and chat, split layout.

**Password/secret retention**: when editing SSH or settings without changing the password/API Key fields, they must not be cleared after save (the frontend and backend already implement retention logic; you can additionally verify `~/.winkterm/config.json` via the API).

Backend interaction, incremental terminal reads, etc. can still use the Agent HTTP API under **"Running Scenarios"** below; it complements browser-based UI testing.

### Other Environments: puppeteer-core + system Chrome

Without Browser MCP, use puppeteer-core to drive system Chrome against `localhost:3000`.

Optional script: `node scripts/e2e-frontend-test.mjs` (requires Chrome installed locally and `npm install puppeteer-core` in a temp directory).

### One-Shot Test Template (puppeteer)

```bash
# 1. Install deps in a temp dir (only puppeteer-core, no Chromium download)
mkdir -p /c/Users/$USER/AppData/Local/Temp/winkterm-test
cd /c/Users/$USER/AppData/Local/Temp/winkterm-test
npm init -y && npm install puppeteer-core --no-audit --no-fund

# 2. Get an agent token (localhost is auth-free)
curl -s http://localhost:8000/api/agent/handshake
# → {"token": "...", ...}
```

Test script essentials:

```js
const puppeteer = require("puppeteer-core");
const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: false,  // headed to see clearly; set true for CI
  defaultViewport: { width: 1400, height: 900 },
  args: ["--no-sandbox"],
});
const page = await browser.newPage();

// Capture frontend console (for debugging)
page.on("console", (msg) => {
  const t = msg.text();
  if (t.includes("useTerminal")) console.log("[browser]", t);
});

await page.goto("http://localhost:3000", { waitUntil: "networkidle2" });
```

### Running Scenarios

The backend agent HTTP API simulates user/agent actions:

```bash
TOKEN=<from handshake>
AUTH="Authorization: Bearer $TOKEN"
BASE=http://localhost:8000

# Create a terminal
curl -s -X POST $BASE/api/agent/terminals -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"type":"local","name":"verify-1"}'

# Send a command
curl -s -X POST $BASE/api/agent/terminals/<id>/input -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"data":"echo MARKER_X","enter":true}'

# Clean up
curl -s -X DELETE $BASE/api/agent/terminals/<id> -H "$AUTH"
```

### Extracting xterm Content

`textContent` includes xterm's `<style>` block. Read `.xterm-rows` to get clean text:

```js
const visible = await page.evaluate(() => {
  return Array.from(document.querySelectorAll("[data-terminal-id]"))
    .filter((inst) => window.getComputedStyle(inst).display !== "none")
    .map((inst) => ({
      terminalId: inst.dataset.terminalId,
      text: inst.querySelector(".xterm-rows")?.textContent?.trim() || "",
    }));
});
```

Switch tabs:
```js
await page.evaluate((needle) => {
  document.querySelectorAll(".tab")
    .forEach((t) => { if (t.textContent.includes(needle)) t.click(); });
}, "verify-2");
await new Promise((r) => setTimeout(r, 2500));  // wait for SplitContainer fit + replay
```

### Common Debugging Approaches

| Symptom | Where to look |
|---------|---------------|
| Tab shows empty | Check console for `跳过初始化` (skipped init) / `import 后容器已不可见,放弃 init` (container hidden after import, init abandoned) |
| Prompt truncated | Check backend `[SPAWN] cols=` for an abnormally small value; frontend `fit 完成 cols=` (fit done cols=) |
| Garbled output | Check for cols mismatch (backend pty vs frontend xterm) |
| WS won't reconnect | Browser Network → WS frame, check close code |

### Notes

- **Cursor** with the built-in browser does not need the puppeteer temp directory.
- **puppeteer path**: delete `/c/Users/$USER/AppData/Local/Temp/winkterm-test` when done to avoid buildup.
- The frontend dev server is Next.js + Turbopack — file changes hot-reload instantly, no restart needed.
- The backend `--reload` mode also hot-reloads, but the pty child process is not restarted.

## Code Comments

- **Write all code comments and docstrings in English** (both backend Python and frontend TypeScript). Do not add new Chinese comments — existing ones are being migrated incrementally.

## Git Commit Convention

- **Write all commit messages in English**, following Conventional Commits: `type(scope): summary`.
  - Common types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`.
  - Examples: `feat(agent): add kubectl tool`, `fix(ws): handle reconnect on close code 1006`.
- Keep the subject line ≤72 characters; add a body to explain the "why" when it isn't obvious.
- Do not add `Co-Authored-By` lines.
- See [CONTRIBUTING.md](CONTRIBUTING.md#commit-messages) for details.

## Release & Packaging

Pushing a tag triggers GitHub Actions to build automatically:
```bash
git tag v0.1.0
git push origin v0.1.0
```

This produces Windows (.exe) and macOS (.app, both Intel and AppleSilicon) installers.
