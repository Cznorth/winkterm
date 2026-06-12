# 安装 winkterm-remote skill（外部 agent 接入指导）

你正在阅读 WinkTerm 的外部 agent 接入指导。按下面步骤安装 skill 后，
你就能通过 HTTP 远程操作 WinkTerm 终端：查看 SSH 列表、新建终端、
发送命令、查看终端快照、传输文件。

WinkTerm 后端地址（下文 `{BASE_URL}` 均指它）：`{BASE_URL}`

## 步骤 1 —— 下载 skill 文件

skill 文件由后端提供，直接下载、不要手写内容。保存到你的 skills 目录：
- Claude Code：`~/.claude/skills/winkterm-remote/SKILL.md`
- 其它 agent：放到你加载 skill 的目录下

```bash
mkdir -p ~/.claude/skills/winkterm-remote
curl -fsSL "{BASE_URL}/api/agent/skill.md" \
  -o ~/.claude/skills/winkterm-remote/SKILL.md
```
该下载端点无需鉴权。下载后确认文件开头是 `---` 起始的 frontmatter。

## 步骤 2 —— 安装 winkterm CLI（推荐通道）

skill 优先用 `winkterm` CLI（WebSocket 长连接，长任务不被反向代理 60s 空闲超时切断），
HTTP 接口仅作兜底。CLI 已发布到 npm，无需 clone 仓库：

```bash
npx winkterm help          # 免安装直接跑
# 或全局装：npm install -g winkterm  后直接用 winkterm
```

需要 Node ≥ 18。**建议先 `login` 把凭据存一次**（写到 `~/.winkterm/cli.json`，
权限 0600），后续所有命令行不再带 token——截图也不会泄露：

```bash
npx winkterm login --base-url {BASE_URL} --token <WINKTERM_AGENT_TOKEN>
npx winkterm ssh-list      # 之后裸跑即可
```

token 获取见下方步骤 3。CLI 连不上时自动 fallback 到 HTTP，所以装不上也不致命。

## 步骤 3 —— 获取鉴权 token

调用接口需要 token。向用户索取 `AGENT_API_TOKEN`
（它配置在 WinkTerm 后端的 `.env` 文件里）。

把它记为环境变量 `WINKTERM_AGENT_TOKEN`，后续所有请求都要带 HTTP 头：
`Authorization: Bearer <WINKTERM_AGENT_TOKEN>`

同时把 `WINKTERM_BASE_URL` 设为 `{BASE_URL}`。

## 步骤 4 —— 验证

```bash
curl -s "{BASE_URL}/api/agent/ssh/connections" \
  -H "Authorization: Bearer <WINKTERM_AGENT_TOKEN>"
```
返回 JSON 即安装成功。

之后凡是需要远程跑 shell 命令、运维服务器、传文件，就加载并使用
winkterm-remote skill。完整接口说明见已下载的 SKILL.md。
