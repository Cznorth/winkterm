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

## 步骤 2 —— 获取鉴权 token

调用接口需要 token。向用户索取 `AGENT_API_TOKEN`
（它配置在 WinkTerm 后端的 `.env` 文件里）。

把它记为环境变量 `WINKTERM_AGENT_TOKEN`，后续所有请求都要带 HTTP 头：
`Authorization: Bearer <WINKTERM_AGENT_TOKEN>`

同时把 `WINKTERM_BASE_URL` 设为 `{BASE_URL}`。

## 步骤 3 —— 验证

```bash
curl -s "{BASE_URL}/api/agent/ssh/connections" \
  -H "Authorization: Bearer <WINKTERM_AGENT_TOKEN>"
```
返回 JSON 即安装成功。

之后凡是需要远程跑 shell 命令、运维服务器、传文件，就加载并使用
winkterm-remote skill。完整接口说明见已下载的 SKILL.md。
