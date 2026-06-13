# WinkTerm HTTP 接口参考（兜底）

> **先读这个判断**：你**真的**需要 HTTP 吗？默认全部走 `winkterm` CLI（WebSocket 长连接，
> 长任务靠心跳保活，连不上自动退回 HTTP）。只有这些情况才直接碰 HTTP：
> - 目标机器**装不了 Node / 跑不了 CLI**，手头只有 `curl`；
> - 需要 **SSE 实时流**（`/stream`，CLI 不转发流式订阅）；
> - 调试 CLI 自身、或要看原始 REST 响应。
>
> 其余一律回 [SKILL.md](./SKILL.md) 用 CLI。本文档独立加载，**只在确需 HTTP 时读**，省上下文。

## 鉴权

- **Base URL**: `${WINKTERM_BASE_URL}`（默认 `http://localhost:8000`）
- 所有请求带头 `Authorization: Bearer ${WINKTERM_AGENT_TOKEN}`；
  SSE/EventSource 不支持自定义 header 时改用 URL 上的 `?token=<token>`。
- token 未配置 → `503`；token 错误 → `401`。

token 自动发现流程见 [SKILL.md](./SKILL.md#token-自动发现会话开始就做)。

## 长任务：异步 job（**HTTP 专属，CLI 用不到**）

> ⚠️ job 轮询是为 **HTTP 网关超时**设计的兜底。CLI 走 WebSocket，长命令直接 `winkterm exec`
> 全程保活，**不要在 CLI 里搞 job 轮询**——纯属浪费往返。只有被迫用 HTTP 时才用本节。

`/run` 是同步的：HTTP 请求一直挂到命令结束。命令耗时超过反向代理网关超时
（常见 ~60s）时会 504，哪怕命令在主机上还在跑。**安装包、mysqldump、docker
build、大文件拷贝等长命令，在 HTTP 模式下一律用异步版本。**

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

## 查看 SSH 列表
```
GET /api/agent/ssh/connections
→ { "connections": [ { "id": "ab12cd34", "title": "...", "host": "...", "port": 22, "username": "..." } ] }
```
密码字段已脱敏。

## 管理 SSH 连接（增删改查）

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

## 新建终端
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

## 原子执行（推荐）—— `/exec`

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

## 发送命令 / 控制键 —— `/input`

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

### 命名控制键（`keys` 字段）

避免在 JSON 里塞 `` 这种控制字符（curl / PowerShell 经常把它处理坏）。

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

### 常用模式

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

## 终端快照
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

## 终端实时流（SSE）—— CLI 不转发，需流式时用这个
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

## 终端管理
```
GET    /api/agent/terminals            列出所有终端
GET    /api/agent/terminals/{id}       获取单个终端信息
DELETE /api/agent/terminals/{id}       关闭并删除终端
```

## 一次性 SSH 执行（推荐用于简单命令）

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
长命令（>~60s）在 HTTP 模式下改用上面的 [异步 job](#长任务异步-jobhttp-专属cli-用不到)。

## 操作事件流

agent 的每个动作（create/exec/input/close/file 操作等）都被记录到环形缓冲，
前端 / 监控工具可实时订阅：

```
GET /api/agent/events/recent?since_id=N&limit=100
→ { "events": [{ "id": 42, "ts": 1779511837.18, "action": "terminal_exec", ... }, ...] }

GET /api/agent/events/stream?since_id=0&token=<token>
→ SSE 流，event 名 "agent_event" / "heartbeat"
```

无持久化，进程重启后清零。最多保留 500 条。

## SSH 文件传输
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
