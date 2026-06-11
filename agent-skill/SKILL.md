---
name: winkterm-remote
version: 6
description: 远程操作 WinkTerm —— 优先用 winkterm CLI（WebSocket 长连接，长任务不被反代超时切断），HTTP 接口作兜底。管理 SSH 连接（增删改查）、新建本地/SSH 终端、发命令并读输出、获取终端快照、运行异步任务、SSH 文件传输。当需要远程执行 shell 命令、运维服务器、或在受控终端里跑命令时使用。
---

# WinkTerm 远程终端 Skill

远程操作 WinkTerm 后端的终端。后端为每个终端维护一个独立 PTY，
你可以创建本地或 SSH 终端、发命令、读输出、传文件。

**两条通道，优先用 CLI：**

- **`winkterm` CLI（首选）** —— 走 WebSocket 长连接，应用层心跳每 15s 一次，
  长命令（安装、build、dump）不会被 nginx 等反向代理的默认 60s 空闲超时切断。
  见下方 [CLI](#cli推荐).
- **HTTP 接口（兜底）** —— 原有 REST/SSE 接口全部保留。CLI 连不上时自动 fallback，
  你也可以直接用 curl。见 [HTTP 接口参考](#http-接口参考兜底).

## 配置

- **Base URL**: `${WINKTERM_BASE_URL}`（默认 `http://localhost:8000`）
- **鉴权**: 所有请求带 HTTP 头 `Authorization: Bearer ${WINKTERM_AGENT_TOKEN}`
- 或在 URL 上加 `?token=<token>`（SSE/EventSource 不支持自定义 header 时用）。
- token 未配置时接口返回 `503`；token 错误返回 `401`。

### Token 自动发现（**会话开始就做**）

会话第一次用本 skill 时，按顺序尝试：

**1. 查持久化 memory / 上下文**：用户之前可能已经告诉你 token，写到了 memory 文件 / CLAUDE.md / 环境变量。先找一遍：
- env `WINKTERM_AGENT_TOKEN`
- agent memory 系统（Claude Code 等：`~/.claude/projects/<...>/memory/`）
- 项目级 `CLAUDE.md`

**2. 本地 handshake**（只对 WinkTerm 同机的 agent 有效）：

```bash
curl -s http://localhost:8000/api/agent/handshake
→ {"token":"<bearer-token>","base_url":"http://localhost:8000"}
```

该端点免鉴权但**仅 localhost 可访问**（远程 IP 返回 `403`）。

**3. 远程 agent / 全部失败**：问用户**一次** token，**立刻写入 memory**（或等价持久化层），后续会话直接复用。
不要每次会话都问用户 —— 一次提供，永久记住。

如果调 API 时收到 `401`，token 可能已轮换：清掉 memory 里的旧值，重走以上流程。

### Skill 自更新（**会话开始顺手做**）

WinkTerm 后端会持续迭代接口。本 skill 文件顶部 frontmatter 有 `version` 字段，
和服务端 `GET /api/agent/skill.md` 第二行的 `version: N` 比对即可判断是否落后。

会话第一次连上 WinkTerm 时：

```bash
# 1. 取服务端 skill 版本
curl -s http://localhost:8000/api/agent/skill.md | head -10 | grep '^version:'
# → version: 3

# 2. 取本地 skill 版本（路径因 agent 而异，Claude Code 是 ~/.claude/skills/winkterm-remote/SKILL.md）
head -10 <local-skill-path> | grep '^version:'
# → version: 2
```

如果服务端版本更新：
1. **告诉用户**："WinkTerm skill 有更新（v2 → v3），建议覆盖本地副本"
2. 用户同意后用 `curl -s http://<base>/api/agent/skill.md > <local-skill-path>` 拉新版
3. **当前会话仍按已载入的旧 skill 行为操作**（skill 内容只在下次会话载入时刷新）
4. 提示用户下次会话才生效

不要静默覆盖。覆盖前给用户看 diff（`curl http://<base>/api/agent/skill.md | diff - <local>`）。

服务端版本号 `<` 本地，或两者相等：跳过，正常工作。

## CLI（推荐）

`winkterm` CLI 把下方所有 HTTP 接口封成一条 WebSocket 长连接上的 JSON 消息。
好处：长任务靠心跳保活，**不被反向代理的 60s 空闲超时切断**；连不上时自动退回 HTTP。

### 安装与配置

CLI 源码在 WinkTerm 仓库 `cli/` 目录。

```bash
cd cli && npm install        # 仅一个依赖 ws
node bin/winkterm.js help    # 或 npm link 后直接 winkterm
```

配置走环境变量（与 HTTP 接口同一套 token）：

```bash
export WINKTERM_BASE_URL=https://ops.example.com   # 默认 http://localhost:8000
export WINKTERM_AGENT_TOKEN=<bearer-token>         # 同 HTTP 的 agent token
# 可选：WINKTERM_TRANSPORT=ws|http|auto（默认 auto，先 WS 后 HTTP）
```

WebSocket URL 自动从 base_url 推导（`http→ws`、`https→wss`，路径 `/ws/agent`）。

### 通用调用（覆盖全部方法）

```bash
winkterm call <method> '<json-params>'
```

`call` 直通后端，新增方法无需升级 CLI。结果 JSON 打到 **stdout**，
实时输出（progress）打到 **stderr**，出错退出码非 0。

### 方法名 ↔ HTTP 接口对照

下方「HTTP 接口参考」的每个端点都有等价 WS 方法，参数同名（路径参数如
`terminal_id` / `conn_id` / `job_id` 放进 params）：

| WS method | 对应 HTTP | params 关键字段 |
|-----------|-----------|----------------|
| `terminal.create` | POST /terminals | type, connection_id, name, ttl_seconds |
| `terminal.list` | GET /terminals | — |
| `terminal.get` | GET /terminals/{id} | terminal_id |
| `terminal.delete` | DELETE /terminals/{id} | terminal_id |
| `terminal.exec` | POST /terminals/{id}/exec | terminal_id, command/command_b64, timeout, cwd, env |
| `terminal.input` | POST /terminals/{id}/input | terminal_id, data/keys, enter, wait |
| `terminal.snapshot` | GET /terminals/{id}/snapshot | terminal_id, since, pattern |
| `terminal.stream` | GET /terminals/{id}/stream (SSE) | terminal_id, since（**仅 WS**，无 HTTP fallback，改用 snapshot 轮询）|
| `ssh.connections.list/get/create/update/delete` | …/ssh/connections | conn_id, host, username, … |
| `ssh.import_electerm` | POST /ssh/import/electerm | bookmarks |
| `ssh.run` | POST /ssh/{conn_id}/run | conn_id, command, timeout |
| `ssh.run_async` | POST /ssh/{conn_id}/run_async | conn_id, command, timeout |
| `job.list/get/cancel` | …/jobs | job_id |
| `events.recent` | GET /events/recent | since_id, limit |
| `events.stream` | GET /events/stream (SSE) | since_id（**仅 WS**，无 HTTP fallback）|
| `ssh.files.list/read/write` | …/ssh/{conn_id}/files… | conn_id, path, content |
| `ssh.upload` / `ssh.download` | …/ssh/{conn_id}/upload\|download | conn_id, local_path, remote_path |
| `ssh.mkdir` | POST /ssh/{conn_id}/directories | conn_id, path |
| `ssh.delete_paths` | DELETE /ssh/{conn_id}/paths | conn_id, paths |

### 便捷子命令

```bash
winkterm list                                  # 列终端
winkterm create --type ssh --connection-id ab12cd34 --name fix
winkterm exec <terminal_id> "sleep 300 && echo done"   # 长任务，WS 全程保活
winkterm input <terminal_id> ":q!" --no-enter
winkterm snapshot <terminal_id> --since 1024 --pattern ERROR
winkterm delete <terminal_id>
winkterm ssh-list
winkterm ssh-run <conn_id> "uptime; df -h" --timeout 120
```

### 长任务怎么办

- **首选 `winkterm exec`**：WS 心跳保活，命令跑多久都不断，输出实时回流。
- 仍想要 job 语义（提交即返回、断开续查）：用 `winkterm ssh-run --async` 等价的
  `winkterm call ssh.run_async ...` + `winkterm call job.get ...`。
- CLI 不可用（旧后端无 `/ws/agent`、WS 被网络阻断）→ auto 模式自动走下方 HTTP；
  此时长命令仍建议用 `ssh.run_async` + 轮询 `job.get` 躲过网关超时。

## 选 input 还是 exec

| 场景 | 用哪个 |
|------|-------|
| 跑一条命令，要 stdout 和退出码 | **`/exec`**（POSIX shell only，bash/zsh/sh/dash）|
| 发控制键（Ctrl+C、方向键、Tab 补全）| `/input` + `keys` 字段 |
| 交互式程序（vim/top/分页器）| `/input` + snapshot 轮询 |
| Windows 本地 cmd.exe | `/input` |
| 想要"零回显、零 prompt 干扰" | **`/exec`** |

## 工作流程

1. `GET /api/agent/ssh/connections` 查看可用 SSH 连接，拿到 `id`。
2. `POST /api/agent/terminals` 新建终端（local 或 ssh），拿到终端 `id`。
3. 操作终端：
   - **首选** `POST /api/agent/terminals/{id}/exec` 跑命令（带 exit code）。
   - 或 `POST /api/agent/terminals/{id}/input` 发原始输入 / 控制键。
4. `GET /api/agent/terminals/{id}/snapshot` 查看终端当前内容。
5. 用完 `DELETE /api/agent/terminals/{id}` 关闭。

## HTTP 接口参考（兜底）

> 以下是原有 HTTP/SSE 接口，**全部保留**。CLI 的 auto/http 模式内部就走这些路径；
> 你也可以在没装 CLI 时直接 curl。优先用上面的 [CLI](#cli推荐)。

### 查看 SSH 列表
```
GET /api/agent/ssh/connections
→ { "connections": [ { "id": "ab12cd34", "title": "...", "host": "...", "port": 22, "username": "..." } ] }
```
密码字段已脱敏。

### 管理 SSH 连接（增删改查）

连接配置存在后端 `~/.winkterm/config.json`，密码/passphrase/vnc_password 为机密字段。

```
POST   /api/agent/ssh/connections                创建连接
       body: {
         "title": "prod-db", "host": "1.2.3.4", "port": 22, "username": "root",
         "auth_type": "password",        # "password" | "key"
         "password": "...",              # auth_type=password 时
         "private_key_path": "...",      # auth_type=key 时（后端机器上的路径）
         "passphrase": "...",            # 私钥口令，可选
         "group": "...", "color": "..."  # 可选分组/颜色
       }
       → { "success": true, "id": "ab12cd34" }
       host / username 为空 → 400。

GET    /api/agent/ssh/connections/{id}            查看单个连接（机密脱敏为 ********）
       ?secrets=true                              返回明文机密（仅必要时用，如建 VNC 隧道）
       → { "connection": { ... } }

PUT    /api/agent/ssh/connections/{id}            更新连接（只传要改的字段）
       body: 同 create，全部字段可选
       → { "success": true }
       机密字段留空 / 不传 / 传 ******** = 保持原值不变（不会被清空）。

DELETE /api/agent/ssh/connections/{id}            删除连接
       → { "success": true }

POST   /api/agent/ssh/import/electerm             批量导入 electerm 书签
       body: { "bookmarks": [ {...}, {...} ] }    按 host+port+username 去重
       → { "success": true, "imported": 3 }
```

不存在的 `id` → 404。改密码时只发 `password` 字段即可；想保留旧密码就别传该字段。

### 新建终端
```
POST /api/agent/terminals
body: { "type": "local" }                              # 本地 shell
      { "type": "ssh", "connection_id": "ab12cd34" }   # SSH 连接
可选:
  "cols": 120, "rows": 40,
  "name": "miner-fix",        # 自定义标签，便于在事件流 / 前端面板里识别
  "ttl_seconds": 1800         # 空闲多少秒后自动回收（0/负数 = 永不过期）
→ {
    "id": "f3a9...", "type": "...", "name": "...", "cwd": null,
    "alive": true, "created_at": "...", "size": 0,
    "idle_seconds": 0, "ttl_seconds": 1800
  }
```

终端默认 30 分钟空闲自动回收。长任务把 ``ttl_seconds`` 调大或设为 0。

### 原子执行（推荐）—— `/exec`

跑一条 POSIX shell 命令，返回 stdout + exit_code。命令回显行和后续 prompt 都被剥离。

```
POST /api/agent/terminals/{id}/exec
body: {
  "command": "ls -la /tmp",        # 命令文本
  "command_b64": "<base64>",       # 替代/拼接 command，避开多层引号转义
  "timeout": 30.0,                 # 最长等待秒数（默认 30）
  "idle": 0.3,                     # 保留字段（默认 0.3）
  "cwd": "/var/log",               # 临时切目录（subshell，不污染终端持久 cwd）
  "env": { "LANG": "C", "MY_VAR": "x" }  # 临时环境变量（subshell 内 export，对整条命令生效）
}
→ {
  "ok": true,
  "exit_code": 0,                  # 命令真实退出码
  "stdout": "...",                 # 已剥离回显和 sentinel
  "cwd": "/root",                  # 终端持久 cwd（每次 exec 后自动更新）
  "size": 12345,
  "alive": true
}

# 超时
→ { "ok": false, "reason": "timeout", "stdout": "<已收到>", "size": ..., "alive": ... }
```

**为什么用 `command_b64`**：当命令含多层引号嵌套（awk 单引号包双引号、jq 过滤器、HEREDOC 等），
在 JSON body 里写 `command` 要做三层转义（shell → JSON → POSIX shell）极易出错。
把命令 base64 编码后塞 `command_b64` 完全绕开转义，最稳。

实现细节：服务端在命令后追加 `; printf '\n__WT_EXEC_<id>__%d\n' "$?"` sentinel，
读到 sentinel 即返回。仅支持 POSIX shell（bash/zsh/sh/dash 等）。Windows cmd.exe 走 `/input`。

### 发送命令 / 控制键 —— `/input`

```
POST /api/agent/terminals/{id}/input
body: {
  "data": "ls -la",         # 直接文本输入
  "data_b64": "<base64>",   # base64 编码文本（替代/拼接 data）
  "keys": ["ctrl+c"],       # 命名控制键列表（替代/拼接前两者）
  "enter": true,            # 是否追加回车执行（默认 true，发控制键时通常设 false）
  "wait": true,             # 同步等待输出稳定后返回（默认 false）
  "timeout": 10.0,          # wait 模式最长等待秒数
  "idle": 0.6,              # wait 模式连续无新增输出多少秒视为稳定
  "strip_echo": false       # 是否剥离命令回显行（仅 wait=true 生效）
}
```

`data` / `data_b64` / `keys` 三者可同时使用，按 keys → data → data_b64 顺序拼接。

- `wait: true` → 返回：
  ```
  {
    "ok": true,
    "since": <起始偏移>,
    "output": "<新增输出>",
    "size": <累计字节数>,
    "alive": true,
    "reason": "idle" | "timeout" | "no_output"
  }
  ```
  - `idle`: 看到新输出后，连续 `idle` 秒无新增，正常收尾。
  - `timeout`: 到了 `timeout` 还在持续出输出（可能进程没结束）。
  - `no_output`: 自始至终没看到新输出（命令默默运行，或没事发生）。

- `wait: false` → 立即返回 `{"ok": true, "since": <起始偏移>}`，之后用 snapshot 轮询。

#### 命名控制键（`keys` 字段）

避免在 JSON 里塞 `` 这种控制字符（curl / PowerShell 经常把它处理坏）。

| 键名 | 字节 | 备注 |
|------|------|------|
| `ctrl+c` … `ctrl+z` | `\x01` … `\x1a` | 所有控制字符 |
| `tab` (= `ctrl+i`) | `\x09` | 触发补全 |
| `enter` / `return` | `\x0d` | 回车 |
| `esc` / `escape` | `\x1b` | |
| `space` | ` ` | |
| `backspace` / `del` | `\x7f` | 删除前一字符 |
| `up` / `down` / `left` / `right` | xterm 方向键序列 | 命令历史、菜单导航 |
| `home` / `end` / `pageup` / `pagedown` / `insert` / `delete` | | 编辑键 |
| `f1` … `f12` | | 功能键 |

未知键名返回 `400`。键名大小写不敏感、空格忽略。

#### 常用模式

```jsonc
// 打断卡死的命令
{ "keys": ["ctrl+c"], "enter": false }

// 退出 vim
{ "keys": ["esc"], "enter": false }
{ "data": ":q!", "enter": true }

// 命令历史上一条并执行
{ "keys": ["up", "enter"], "enter": false }

// 跑复杂带嵌套引号的 awk —— 避免 JSON 转义
{ "data_b64": "<base64(awk '...')>" }

// less / more 分页时翻页
{ "data": " ", "enter": false }
```

### 终端快照
```
GET /api/agent/terminals/{id}/snapshot
  ?since=<偏移>           # 增量查询起点
  &strip_ansi=true
  &pattern=<正则>         # 服务端 grep：仅返回匹配行
  &context=2              # grep 上下文行数（0-20）
  &case_insensitive=false

→ {
    "output": "<文本>",
    "size": <累计字节数>,
    "truncated": false,
    "alive": true,
    "grep": {                # 仅 pattern 给定时存在
      "match_count": 3,
      "total_lines": 120,
      "matches": [{ "line_no": 17, "line": "...", "match": true }, ...]
    }
  }
```
- 不带 `since` 返回全部缓冲；带 `since` 只返回该偏移之后的新增输出（增量轮询）。
- 把上次返回的 `size` 作为下次的 `since`。
- `truncated: true` 表示请求的偏移过旧、部分输出已被缓冲淘汰（每终端保留最近 256KB）。
- 用 `pattern` 在服务端 grep，省去把 256KB 全拉下来再 grep 的带宽。

### 终端实时流（SSE）
```
GET /api/agent/terminals/{id}/stream?since=<偏移>&token=<token>
→ text/event-stream
   id: <累计字节数>
   event: output | heartbeat | end
   data: {"text": "<chunk>", "size": <total>}
```

Server-Sent Events 实时推送新输出，**做长命令监控 / tail -f 的杀手锏**。
断线重连时把上次的 `id` 当 `since` 续传。EventSource 不支持自定义 header，
所以这里把 token 放在 query 参数里。

### 终端管理
```
GET    /api/agent/terminals            列出所有终端
GET    /api/agent/terminals/{id}       获取单个终端信息
DELETE /api/agent/terminals/{id}       关闭并删除终端
```

### 一次性 SSH 执行（推荐用于简单命令）

跑完一条命令就走，省去 create / exec / delete 三次调用。
后端自动新建临时终端 → 等 SSH 横幅落定 → exec → 关闭。

```
POST /api/agent/ssh/{conn_id}/run
body: {
  "command": "uptime; df -h",
  "command_b64": "<base64>",
  "timeout": 60.0,
  "initial_wait": 2.5,     # 等 SSH 登录横幅的秒数（默认 2.5）
  "cwd": "/tmp",           # 可选
  "env": { "K": "v" }      # 可选
}
→ { "ok": true, "exit_code": 0, "stdout": "...", "cwd": "...", "request_id": "..." }
```

如果要复用 shell 状态（cd、环境变量）请走 `/terminals` + `/exec` 两步流程。

### 异步一次性执行（长任务 / 防网关超时，**推荐**）

`/run` 是同步的：HTTP 请求一直挂到命令结束。命令耗时超过反向代理网关超时
（常见 ~60s）时会 504，哪怕命令在主机上还在跑。**安装包、mysqldump、docker
build、大文件拷贝等长命令一律用异步版本。**

提交立即返回 `job_id`，命令在后台**独立线程 + 专用 SSH 通道**里跑（不占事件
循环、互不影响：某台主机卡住只拖住它自己的 job）。之后轮询 `/jobs/{id}` 取结果。

```
POST /api/agent/ssh/{conn_id}/run_async
body: 同 /run（command / command_b64 / timeout / cwd / env）
→ { "job_id": "...", "status": "running", "done": false, ... }   # 立即返回

GET /api/agent/jobs/{job_id}
→ {
    "job_id": "...", "conn_id": "...", "command": "<预览>",
    "status": "running|success|failed|timeout|error|canceled",
    "done": true,
    "exit_code": 0, "ok": true,
    "stdout": "...",          # 已解码(UTF-8/GBK 自适应)+去 ANSI
    "reason": null, "error": null,
    "created_at": "...", "updated_at": "..."
  }

GET    /api/agent/jobs              列出所有 job
DELETE /api/agent/jobs/{job_id}     取消（任务级取消；已在跑的远端进程不保证中止）
```

轮询节奏建议：长任务先 sleep 命令预估时长再查，别每秒打。`status != "running"`
即 `done`。job 在内存里保留最近 200 条，进程重启清零。

### 操作事件流

agent 的每个动作（create/exec/input/close/file 操作等）都被记录到环形缓冲，
前端 / 监控工具可实时订阅：

```
GET /api/agent/events/recent?since_id=N&limit=100
→ { "events": [{ "id": 42, "ts": 1779511837.18, "action": "terminal_exec", ... }, ...] }

GET /api/agent/events/stream?since_id=0&token=<token>
→ SSE 流，event 名 "agent_event" / "heartbeat"
```

无持久化，进程重启后清零。最多保留 500 条。

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

- **优先 `/exec`**：拿退出码 + 干净 stdout，省去自己 strip 回显和 prompt。
- 复杂引号嵌套命令一律走 `command_b64` / `data_b64`，省一层转义就少一层翻车。
- 交互式命令（如分页器、确认提示）发命令再 snapshot 查看，再用 `keys` 发对应按键。
- 命令运行慢时把 `timeout` 调大，或 `wait: false` 后轮询 snapshot。
- SSH 终端启动后首屏可能是登录横幅；发命令前可先 snapshot 确认 shell 就绪。
- 终端是有状态的：`cd`、环境变量在同一终端内保持，跨命令复用同一终端 id。
- `/exec` 会在 shell 历史里留下 sentinel 包装的命令；若要避免，发 `export HISTFILE=/dev/null` 后再 exec。

## 示例（curl）

```bash
BASE=http://localhost:8000
AUTH="Authorization: Bearer $WINKTERM_AGENT_TOKEN"

# 新建 SSH 终端
TID=$(curl -s -X POST $BASE/api/agent/terminals -H "$AUTH" \
  -H 'Content-Type: application/json' \
  -d '{"type":"ssh","connection_id":"ab12cd34"}' | jq -r .id)

# 推荐：用 /exec 拿 stdout + 退出码
curl -s -X POST $BASE/api/agent/terminals/$TID/exec -H "$AUTH" \
  -H 'Content-Type: application/json' \
  -d '{"command":"uptime"}' | jq

# 多层引号的 awk —— base64 输入
CMD=$(echo -n "ps aux | awk '\$3>0 {print \$2}'" | base64 -w0)
curl -s -X POST $BASE/api/agent/terminals/$TID/exec -H "$AUTH" \
  -H 'Content-Type: application/json' \
  -d "{\"command_b64\":\"$CMD\"}" | jq

# 打断卡死命令
curl -s -X POST $BASE/api/agent/terminals/$TID/input -H "$AUTH" \
  -H 'Content-Type: application/json' \
  -d '{"keys":["ctrl+c"],"enter":false}' | jq

# 关闭
curl -s -X DELETE $BASE/api/agent/terminals/$TID -H "$AUTH"
```
