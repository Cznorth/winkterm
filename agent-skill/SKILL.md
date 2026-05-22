---
name: winkterm-remote
description: 通过 HTTP 远程操作 WinkTerm —— 查看 SSH 连接列表、新建本地/SSH 终端、发送命令并读取输出、获取终端快照、SSH 文件传输。当需要远程执行 shell 命令、运维服务器、或在受控终端里跑命令时使用。
---

# WinkTerm 远程终端 Skill

通过 WinkTerm 后端的 HTTP 接口远程操作终端。后端为每个请求维护一个独立 PTY，
你可以创建本地或 SSH 终端、发命令、读输出、传文件。

## 配置

- **Base URL**: `${WINKTERM_BASE_URL}`（默认 `http://localhost:8000`）
- **鉴权**: 所有请求带 HTTP 头 `Authorization: Bearer ${WINKTERM_AGENT_TOKEN}`
- token 未配置时接口返回 `503`；token 错误返回 `401`。

## 工作流程

1. `GET /api/agent/ssh/connections` 查看可用 SSH 连接，拿到 `id`。
2. `POST /api/agent/terminals` 新建终端（local 或 ssh），拿到终端 `id`。
3. `POST /api/agent/terminals/{id}/input` 发送命令。带 `wait: true` 可同步拿到输出。
4. `GET /api/agent/terminals/{id}/snapshot` 随时查看终端当前内容。
5. 用完 `DELETE /api/agent/terminals/{id}` 关闭。

## 接口参考

### 查看 SSH 列表
```
GET /api/agent/ssh/connections
→ { "connections": [ { "id": "ab12cd34", "title": "...", "host": "...", "port": 22, "username": "..." } ] }
```
密码字段已脱敏。

### 新建终端
```
POST /api/agent/terminals
body: { "type": "local" }                              # 本地 shell
      { "type": "ssh", "connection_id": "ab12cd34" }   # SSH 连接
可选: "cols" (默认 120), "rows" (默认 40)
→ { "id": "f3a9...", "type": "...", "alive": true, "created_at": "...", "size": 0 }
```

### 发送命令
```
POST /api/agent/terminals/{id}/input
body: {
  "data": "ls -la",      # 要输入的文本
  "enter": true,         # 是否追加回车执行（默认 true）
  "wait": true,          # 同步等待输出稳定后返回（默认 false）
  "timeout": 10.0,       # wait 模式最长等待秒数
  "idle": 0.6            # wait 模式连续无新增输出多少秒视为稳定
}
```
- `wait: true` → 返回 `{ "ok": true, "since": <起始偏移>, "output": "<新增输出>", "size": <累计字节数>, "alive": true }`
- `wait: false` → 立即返回 `{ "ok": true, "since": <起始偏移> }`，之后用 snapshot 轮询。
- **控制键**：把控制字符放进 `data` 并设 `enter: false`。在 JSON body 里用对应码点的 Unicode 转义：Ctrl+C 用 U+0003、Ctrl+D 用 U+0004、Esc 用 U+001B、Tab 用 U+0009、方向键上 用 U+001B 后接 `[A`。

### 终端快照
```
GET /api/agent/terminals/{id}/snapshot?since=<偏移>&strip_ansi=true
→ { "output": "<文本>", "size": <累计字节数>, "truncated": false, "alive": true }
```
- 不带 `since` 返回全部缓冲；带 `since` 只返回该偏移之后的新增输出（增量轮询）。
- 把上次返回的 `size` 作为下次的 `since`。
- `truncated: true` 表示请求的偏移过旧、部分输出已被缓冲淘汰（每终端保留最近 256KB）。

### 终端管理
```
GET    /api/agent/terminals            列出所有终端
GET    /api/agent/terminals/{id}       获取单个终端信息
DELETE /api/agent/terminals/{id}       关闭并删除终端
```

### SSH 文件传输
文件传输的本地路径指 WinkTerm 后端所在机器的路径。
```
GET    /api/agent/ssh/{conn_id}/files?path=<远端目录>            列目录
GET    /api/agent/ssh/{conn_id}/files/content?path=<远端文件>    读文本文件（≤1MB）
PUT    /api/agent/ssh/{conn_id}/files/content                    写文本文件
       body: { "path": "...", "content": "...", "encoding": "utf-8" }
POST   /api/agent/ssh/{conn_id}/upload                           本地→远端 上传
       body: { "local_path": "...", "remote_path": "...", "overwrite": false }
POST   /api/agent/ssh/{conn_id}/download                         远端→本地 下载
       body: { "remote_path": "...", "local_path": "..." }
POST   /api/agent/ssh/{conn_id}/directories                      创建远端目录
       body: { "path": "..." }
DELETE /api/agent/ssh/{conn_id}/paths                            批量删除
       body: { "paths": ["...", "..."] }
```

## 使用建议

- 交互式命令（如分页器、确认提示）先发命令再用 snapshot 查看，再发对应按键。
- 命令运行慢时把 `timeout` 调大，或 `wait: false` 后轮询 snapshot。
- SSH 终端启动后首屏可能是登录横幅；发命令前可先 snapshot 确认 shell 就绪。
- 终端是有状态的：`cd`、环境变量在同一终端内保持，跨命令复用同一终端 id。

## 示例（curl）

```bash
BASE=http://localhost:8000
AUTH="Authorization: Bearer $WINKTERM_AGENT_TOKEN"

# 新建本地终端
TID=$(curl -s -X POST $BASE/api/agent/terminals -H "$AUTH" \
  -H 'Content-Type: application/json' -d '{"type":"local"}' | jq -r .id)

# 发命令并同步取输出
curl -s -X POST $BASE/api/agent/terminals/$TID/input -H "$AUTH" \
  -H 'Content-Type: application/json' \
  -d '{"data":"echo hello","wait":true}' | jq -r .output

# 关闭
curl -s -X DELETE $BASE/api/agent/terminals/$TID -H "$AUTH"
```
