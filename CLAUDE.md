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

## 前端调试方法 (Agent 自验证)

验证前端修复时，**按运行环境选一种方式**（不要混用）：

| 环境 | 方式 |
|------|------|
| **Cursor IDE** | 内置浏览器（Browser MCP） |
| **其他**（Claude Code、CI、无 MCP 的 Agent） | puppeteer-core + 系统 Chrome（见下文） |

### Cursor：内置浏览器（优先）

在 Cursor 里测 `http://localhost:3000` 时，让 Agent **只用内置浏览器**，不要起 puppeteer。

**前置**：前后端已启动；已复制 `frontend/.env.example` → `frontend/.env.local`（指向 `localhost:8000`）。

**推荐流程**：

1. `browser_navigate` → `http://localhost:3000`
2. `browser_lock` → 操作 → `browser_unlock`
3. 常规控件：`browser_snapshot` → `browser_click` / `browser_type` / `browser_fill`
4. **xterm 终端**：先点 `.xterm-screen`（或 `browser_cdp` 点击），再用 `browser_press_key` 输入；读输出用 `browser_cdp` + `Runtime.evaluate` 读 `.xterm-rows`（不要用整页 `textContent`）
5. **侧栏活动栏 / 分屏布局**：快照里常无 ref，用 `browser_cdp` 点 `.activity-item`、`.layout-btn` 等

**可覆盖的冒烟项**：鉴权、本地终端 echo、新建标签、`+` 下拉、SSH 列表、设置页、AI 侧栏与对话、分屏布局。

**密码/密钥保存**：编辑 SSH 或设置时未改密码/API Key 字段，保存后不应被清空（前后端已做保留逻辑，可顺带用 API 校验 `~/.winkterm/config.json`）。

后端联动、增量读终端等仍可用下文 **「跑场景」** 的 Agent HTTP API；与浏览器测 UI 互补。

### 其他环境：puppeteer-core + 系统 Chrome

无 Browser MCP 时，用 puppeteer-core 驱动系统 Chrome 访问 `localhost:3000`。

可选脚本：`node scripts/e2e-frontend-test.mjs`（需本机已装 Chrome，并在临时目录 `npm install puppeteer-core`）。

### 一键测试模板（puppeteer）

```bash
# 1. 临时目录装依赖(只装 puppeteer-core,不下 Chromium)
mkdir -p /c/Users/$USER/AppData/Local/Temp/winkterm-test
cd /c/Users/$USER/AppData/Local/Temp/winkterm-test
npm init -y && npm install puppeteer-core --no-audit --no-fund

# 2. 取 agent token (localhost 免鉴权)
curl -s http://localhost:8000/api/agent/handshake
# → {"token": "...", ...}
```

测试脚本要点:

```js
const puppeteer = require("puppeteer-core");
const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: false,  // headed 看清楚;CI 改 true
  defaultViewport: { width: 1400, height: 900 },
  args: ["--no-sandbox"],
});
const page = await browser.newPage();

// 捕获前端 console (调试用)
page.on("console", (msg) => {
  const t = msg.text();
  if (t.includes("useTerminal")) console.log("[browser]", t);
});

await page.goto("http://localhost:3000", { waitUntil: "networkidle2" });
```

### 跑场景

后端 agent HTTP API 模拟用户/agent 动作:

```bash
TOKEN=<from handshake>
AUTH="Authorization: Bearer $TOKEN"
BASE=http://localhost:8000

# 建终端
curl -s -X POST $BASE/api/agent/terminals -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"type":"local","name":"verify-1"}'

# 发命令
curl -s -X POST $BASE/api/agent/terminals/<id>/input -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"data":"echo MARKER_X","enter":true}'

# 清理
curl -s -X DELETE $BASE/api/agent/terminals/<id> -H "$AUTH"
```

### 提取 xterm 内容

`textContent` 会带上 xterm 的 `<style>` 块。读 `.xterm-rows` 拿干净文本:

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

切 tab:
```js
await page.evaluate((needle) => {
  document.querySelectorAll(".tab")
    .forEach((t) => { if (t.textContent.includes(needle)) t.click(); });
}, "verify-2");
await new Promise((r) => setTimeout(r, 2500));  // 等 SplitContainer fit + replay
```

### 常用 debug 思路

| 现象 | 排查路径 |
|------|---------|
| tab 空显示 | 看 console 有无 `跳过初始化` / `import 后容器已不可见,放弃 init` |
| prompt 截断 | 看 backend `[SPAWN] cols=` 是不是异常小;前端 `fit 完成 cols=` |
| 输出乱码 | 检查 cols 是否 mismatch(backend pty vs frontend xterm) |
| WS 不重连 | 浏览器 Network → WS frame,看 close code |

### 注意

- **Cursor** 用内置浏览器时无需 puppeteer 临时目录。
- **puppeteer 路径**：用完删 `/c/Users/$USER/AppData/Local/Temp/winkterm-test` 避免堆积。
- 前端 dev server 是 Next.js + Turbopack,改文件秒热更新,无需重启。
- 后端 `--reload` 模式同样热更新,但 pty 子进程不重启。

## Git 提交规范

- **commit message 一律用英文**，遵循 Conventional Commits：`type(scope): summary`。
  - 常用 type：`feat`、`fix`、`docs`、`refactor`、`test`、`chore`。
  - 例：`feat(agent): add kubectl tool`、`fix(ws): handle reconnect on close code 1006`。
- 主题行 ≤72 字符，必要时加正文解释 why。
- 不添加 `Co-Authored-By` 行。
- 详见 [CONTRIBUTING.md](CONTRIBUTING.md#commit-messages)。

## 打包发布

推送 tag 触发 GitHub Actions 自动打包：
```bash
git tag v0.1.0
git push origin v0.1.0
```

生成 Windows (.exe) 和 macOS (.app，分 Intel 和 AppleSilicon) 两种安装包。
