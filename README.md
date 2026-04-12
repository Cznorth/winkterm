# WinkTerm

> AI + 终端人机合一的运维工具

AI 和用户共享同一个 pty 会话，像有一个会打字的搭档和你共用一个终端。

## 交互方式

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

## 技术栈

| 层     | 技术                                         |
|--------|----------------------------------------------|
| 后端   | Python + FastAPI + LangGraph + Anthropic Claude |
| 前端   | Next.js + TypeScript + xterm.js              |
| 部署   | Docker Compose                               |

## 快速启动

### 1. 配置环境变量

```bash
cp .env.example .env
# 编辑 .env，填写 ANTHROPIC_API_KEY
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

## 环境变量

| 变量                   | 说明                     | 默认值                         |
|------------------------|--------------------------|--------------------------------|
| `ANTHROPIC_API_KEY`    | Anthropic API Key（必填）| -                              |
| `MODEL_NAME`           | Claude 模型名            | `claude-opus-4-6`              |
| `PROMETHEUS_URL`       | Prometheus 地址          | `http://localhost:9090`        |
| `LOKI_URL`             | Loki 地址                | `http://localhost:3100`        |
| `NEXT_PUBLIC_API_URL`  | 后端 HTTP API 地址       | `http://localhost:8000`        |
| `NEXT_PUBLIC_WS_URL`   | 后端 WebSocket 地址      | `ws://localhost:8000/ws/terminal` |

## 项目结构

详见 [docs/architecture.md](docs/architecture.md)
