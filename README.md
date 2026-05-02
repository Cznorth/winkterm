# WinkTerm

> AI + 终端人机合一的运维工具

AI 和用户共享同一个 pty 会话，像有一个会打字的搭档和你共用一个终端。

## 交互方式

### 终端内对话

在终端输入 `# 开头的消息` 即可与 AI 对话：

```
$ # 帮我看看为什么 nginx 报 502
[WinkTerm] 我来看看，先检查 nginx 错误日志
[WinkTerm] 建议执行以下命令：
$ tail -n 50 /var/log/nginx/error.log█   ← 光标停在这里，回车执行，退格修改
```

- **回车** = 执行 AI 建议的命令
- **退格/修改** = 按自己意愿调整
- **Ctrl+C** = 取消

### 侧边栏对话

点击右侧侧边栏可打开 AI 对话面板，支持：
- 多种模式切换（chat 闲聊、craft 终端操作）
- 模型选择（可在设置中配置多个模型）
- 流式输出

### SSH 远程连接

支持 SSH 连接到远程服务器，并带有文件传输功能。

## 技术栈

| 层     | 技术                                           |
|--------|------------------------------------------------|
| 后端   | Python + FastAPI + LangGraph + OpenAI 协议兼容 LLM |
| 前端   | Next.js + TypeScript + xterm.js                |
| 部署   | Docker Compose / 桌面应用（Windows/macOS）     |

## 快速启动

### 1. 配置环境变量

```bash
cp .env.example .env
# 编辑 .env，填写 LLM_API_KEY 和 LLM_BASE_URL
```

### 2. Docker Compose 启动

```bash
docker compose up -d
```

访问 http://localhost:3000

### 3. 本地开发

**后端：**

```bash
cd backend
python -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt

# 启动
python -m uvicorn backend.main:app --reload --port 8000
```

**前端：**

```bash
cd frontend
npm install
npm run dev
```

**生成 API 类型（orval）：**

```bash
# 确保后端已启动
cd frontend
npm run gen:api
```

### 4. 桌面应用打包

```bash
# Windows
build\build.bat

# 或手动执行
pyinstaller build\winkterm.spec --clean --noconfirm
```

## 环境变量

| 变量                     | 说明                           | 默认值                            |
|--------------------------|--------------------------------|-----------------------------------|
| `LLM_API_KEY`            | LLM API Key（必填）            | -                                 |
| `LLM_BASE_URL`           | LLM API 地址                   | `https://qianfan.baidubce.com/v2/coding` |
| `LLM_MODEL`              | 使用的模型名                   | `glm-5`                           |
| `AGENT_RECURSION_LIMIT`  | Agent 递归限制                 | `100`                             |
| `PROMETHEUS_URL`         | Prometheus 地址                | `http://localhost:9090`           |
| `LOKI_URL`               | Loki 地址                      | `http://localhost:3100`           |
| `NEXT_PUBLIC_API_URL`    | 后端 HTTP API 地址             | `http://localhost:8000`           |
| `NEXT_PUBLIC_WS_URL`     | 后端 WebSocket 地址            | `ws://localhost:8000/ws/terminal` |

## 项目结构

详见 [docs/architecture.md](docs/architecture.md)
