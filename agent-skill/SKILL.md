---
name: winkterm-remote
version: 8
description: 远程操作 WinkTerm —— 默认用 winkterm CLI（WebSocket 长连接，长任务不被反代超时切断），HTTP 仅在 CLI 不可用时兜底。管理 SSH 连接（增删改查）、新建本地/SSH 终端、发命令并读输出、获取终端快照、SSH 文件传输。当需要远程执行 shell 命令、运维服务器、或在受控终端里跑命令时使用。
---

# WinkTerm 远程终端 Skill

远程操作 WinkTerm 后端的终端。后端为每个终端维护一个独立 PTY，
你可以创建本地或 SSH 终端、发命令、读输出、传文件。

**默认用 CLI，几乎不用碰 HTTP：**

- **`winkterm` CLI（默认，几乎总是用它）** —— 走 WebSocket 长连接，应用层心跳每 15s 一次，
  长命令（安装、build、dump）不会被 nginx 等反向代理的默认 60s 空闲超时切断。
  覆盖全部操作，长任务直接 `exec` 全程保活，**无需 job 轮询**。见下方 [CLI](#cli默认).
- **HTTP 接口（兜底，实在没办法才用）** —— 原有 REST/SSE 接口全部保留，CLI 连不上时
  auto 模式自动 fallback。**只有目标机跑不了 Node、或需要 SSE 流式订阅时才手动碰 HTTP。**
  细节单独放在 [HTTP_API.md](./HTTP_API.md)（远程 agent 用 `curl ${WINKTERM_BASE_URL}/api/agent/http.md` 取），
  **确需 HTTP 时再读，平时不占上下文。**

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

## CLI（默认）

`winkterm` CLI 把所有终端/SSH 操作封成一条 WebSocket 长连接上的 JSON 消息。
好处：长任务靠心跳保活，**不被反向代理的 60s 空闲超时切断**；连不上时自动退回 HTTP。
**这是默认且几乎唯一的通道——能用 CLI 就别碰 HTTP。**

### 安装与配置

CLI 已发布到 npm，无需 clone 仓库：

```bash
npx winkterm help          # 免安装直接跑
# 或全局装：npm install -g winkterm  后直接 winkterm
```

（开发场景也可用仓库 `cli/` 目录：`cd cli && npm install && node bin/winkterm.js help`）

**推荐：`login` 存一次凭据**，写到 `~/.winkterm/cli.json`（权限 0600），后续命令行不再带 token——**截图也不会泄露**：

```bash
winkterm login --base-url https://ops.example.com --token <bearer-token>
winkterm ssh-list        # 之后裸跑，无需 token
winkterm whoami          # 看当前 base-url + 掩码 token + 来源
winkterm logout          # 删除已存凭据
```

也可走环境变量 / flags（优先级 flags > env > 配置文件 > 默认，与 HTTP 同一套 token）：

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

### 可用方法（`call` 直通后端）

每个后端端点都有等价 WS 方法，参数同名（路径参数如 `terminal_id` / `conn_id`
放进 params）。完整 HTTP 端点映射见 [HTTP_API.md](./HTTP_API.md)。

| WS method | 用途 | params 关键字段 |
|-----------|------|----------------|
| `terminal.create` | 新建终端 | type, connection_id, name, ttl_seconds |
| `terminal.list` | 列终端 | — |
| `terminal.get` | 终端信息 | terminal_id |
| `terminal.delete` | 关闭终端 | terminal_id |
| `terminal.exec` | 跑命令（带退出码，长任务首选） | terminal_id, command/command_b64, timeout, cwd, env |
| `terminal.input` | 发输入/控制键 | terminal_id, data/keys, enter, wait |
| `terminal.snapshot` | 读终端内容 | terminal_id, since, pattern |
| `ssh.connections.list/get/create/update/delete` | SSH 连接增删改查 | conn_id, host, username, … |
| `ssh.import_electerm` | 导入 electerm 书签 | bookmarks |
| `ssh.run` | 一次性 SSH 执行（WS 全程保活） | conn_id, command, timeout |
| `events.recent` | 操作事件流 | since_id, limit |
| `ssh.files.list/read/write` | SSH 文件读写 | conn_id, path, content |
| `ssh.upload` / `ssh.download` | SSH 文件传输 | conn_id, local_path, remote_path |
| `ssh.mkdir` | 建远端目录 | conn_id, path |
| `ssh.delete_paths` | 批量删远端路径 | conn_id, paths |

> SSE 流（`terminal.stream` / `events.stream`）和异步 job（`ssh.run_async` / `job.*`）
> 是 **HTTP 专属**：CLI 走 WS 不需要 job 轮询，长任务直接 `exec`/`ssh-run` 保活即可。
> 真要流式订阅见 [HTTP_API.md](./HTTP_API.md)。

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

- **直接 `winkterm exec` / `winkterm ssh-run`**：WS 心跳保活，命令跑多久都不断，输出实时回流。
  装包、build、mysqldump、大文件拷贝——全都这么跑，**不需要 job、不需要轮询**。
- 把 `--timeout` 调到够大（默认偏小），命令才不会被客户端提前判超时。
- 只有 CLI 彻底连不上（旧后端无 `/ws/agent`、WS 被网络阻断）才退回 HTTP；
  那种情况下长命令才需要 HTTP 的异步 job（见 [HTTP_API.md](./HTTP_API.md)）躲网关超时。
  正常用 CLI 时**永远用不到 job**。

## 选 input 还是 exec

| 场景 | 用哪个 |
|------|-------|
| 跑一条命令，要 stdout 和退出码 | **`/exec`**（POSIX shell only，bash/zsh/sh/dash）|
| 发控制键（Ctrl+C、方向键、Tab 补全）| `/input` + `keys` 字段 |
| 交互式程序（vim/top/分页器）| `/input` + snapshot 轮询 |
| Windows 本地 cmd.exe | `/input` |
| 想要"零回显、零 prompt 干扰" | **`/exec`** |

## 工作流程

1. `winkterm ssh-list` 查看可用 SSH 连接，拿到 `id`。
2. 简单一次性命令：`winkterm ssh-run <conn_id> "<cmd>"` 一步搞定（自动建临时终端→执行→关闭）。
3. 要复用 shell 状态（cd、环境变量）或多步操作：
   - `winkterm create --type ssh --connection-id <id>` 新建终端，拿终端 `id`。
   - `winkterm exec <terminal_id> "<cmd>"` 跑命令（带退出码，首选）。
   - `winkterm input <terminal_id> ...` 发原始输入 / 控制键（交互程序、Ctrl+C 等）。
   - `winkterm snapshot <terminal_id>` 查看终端当前内容。
   - 用完 `winkterm delete <terminal_id>` 关闭。
## HTTP 接口（兜底，平时别碰）

**默认全部走上面的 CLI。** 只有 CLI 真的用不了才退回 HTTP：
- 目标机装不了 Node / 跑不了 `winkterm`，手头只有 `curl`；
- 需要 SSE 实时流（`/stream` 长命令监控、tail -f）；
- CLI 自动 fallback（`auto` 模式）连不上 WS 时内部已替你走 HTTP。

完整 HTTP/SSE 端点、异步 job、curl 示例都在 **[HTTP_API.md](./HTTP_API.md)**——
远程 agent 用 `curl ${WINKTERM_BASE_URL}/api/agent/http.md` 取。
**只在确需 HTTP 时读它，平时不加载、不占上下文。**

## 使用建议

- **优先 `exec`**（`winkterm exec` / `winkterm ssh-run`）：拿退出码 + 干净 stdout，省去自己 strip 回显和 prompt。
- 复杂引号嵌套命令一律走 `command_b64` / `data_b64`，省一层转义就少一层翻车
  （`winkterm call terminal.exec '{"terminal_id":"t","command_b64":"<base64>"}'`）。
- 交互式命令（分页器、确认提示）先发命令再 `snapshot` 查看，再用 `call terminal.input` 带 `keys` 字段发对应按键。
- 命令运行慢时把 `--timeout` 调大；WS 全程保活，不用怕断。
- SSH 终端启动后首屏可能是登录横幅；发命令前可先 `snapshot` 确认 shell 就绪。
- 终端是有状态的：`cd`、环境变量在同一终端内保持，跨命令复用同一终端 id。
- `exec` 会在 shell 历史里留下 sentinel 包装的命令；若要避免，先 `exec "export HISTFILE=/dev/null"`。

## 示例（CLI）

```bash
# 配一次凭据（之后裸跑，截图不泄露 token）
winkterm login --base-url https://ops.example.com --token <bearer-token>

# 一次性命令：拿 stdout + 退出码
winkterm ssh-run ab12cd34 "uptime; df -h"

# 多步、复用 shell 状态
TID=$(winkterm create --type ssh --connection-id ab12cd34 | jq -r .id)
winkterm exec "$TID" "cd /var/log && ls -la"
winkterm exec "$TID" "tail -n 50 syslog"

# 多层引号的 awk —— base64 绕开转义
CMD=$(echo -n "ps aux | awk '\$3>0 {print \$2}'" | base64 -w0)
winkterm call terminal.exec "{\"terminal_id\":\"$TID\",\"command_b64\":\"$CMD\"}"

# 长任务：WS 心跳保活，跑多久都不断，无需 job 轮询
winkterm exec "$TID" "apt-get install -y nginx && systemctl restart nginx" --timeout 600

# 打断卡死命令（控制键走通用 call；input 子命令只发文本）
winkterm call terminal.input "{\"terminal_id\":\"$TID\",\"keys\":[\"ctrl+c\"],\"enter\":false}"

# 关闭
winkterm delete "$TID"
```
