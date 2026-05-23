# 实践案例：AI agent 通过 WinkTerm 排查 + 清除 XMR 挖矿木马

> [English version](case-study-xmr-miner-cleanup.en.md)


> **日期**：2026-05-23
> **场景**：用户报告 RackNerd VPS 负载异常飙高
> **执行者**：Claude Code（通过 WinkTerm Agent API skill）
> **总耗时**：从首次连接到完成清理 + 上报 ≈ 30 分钟

本文记录一次真实的安全事件响应：用户说"107.173 开头的服务器负载很高"，
AI agent 通过 WinkTerm 的 HTTP Agent API 从零开始定位元凶、还原入侵链、
封禁外联 IP、清理木马、上报 abuse，全过程未经人工额外干预。

本案例集中展示 WinkTerm Agent API 在**真实运维场景**下的设计价值。

---

## 0. 用户原始指令

```
有个107.173开头的服务器负载很高，看看怎么回事
```

仅此一句。没有 IP、没有凭据、没有任何前置上下文。

---

## 1. 定位目标服务器（1 次 API 调用）

```http
GET /api/agent/ssh/connections
Authorization: Bearer <token>
```

返回所有已配置的 SSH 连接。agent 扫一遍 `host` 字段命中 `107.173.156.37`
（标题"美国 加州 RackNerd"），拿到 `connection_id = 2pPrtCB`。

> **设计点**：免去用户手动指定凭据。Agent 直接复用 WinkTerm 内置的连接管理。

---

## 2. 建立 SSH 终端 + 初步诊断

```http
POST /api/agent/terminals
body: {"type":"ssh","connection_id":"2pPrtCB","cols":200,"rows":50}
```

接着发"`top -bn1 | head -30 && echo --- && ps aux --sort=-%cpu | head -20`"
查 CPU 占用 top。

立即发现：

```
load average: 6.85, 19.48, 28.22   ← 15 分钟均值飙到 28
2131795 root  S  492.9% CPU  35.7% MEM  python3.7.3   ← 元凶
```

PID 2131795 占了近 5 核 CPU、2.1GB 内存，已运行 4 周（May 11 起）。

---

## 3. 鉴定可疑进程身份（多次 exec）

走 `/api/agent/terminals/{id}/exec` 一连串原子命令，每次拿到 `exit_code` + `stdout`：

| 命令 | 发现 |
|------|------|
| `cat /proc/2131795/cmdline` | 命令行只有 `/usr/bin/python3.7.3`，无参数 — 不像正常 Python |
| `ls -la /proc/2131795/cwd` | cwd 指向 `/usr/bin`（正常 Python 不会在 /usr/bin） |
| `cat /proc/2131795/maps \| grep rwxp` | 多个 **rwxp 匿名内存页**（可执行 + 可写 — 恶意软件特征） |
| `ls /usr/bin/python3.7.3` | **`No such file or directory`** — 文件已自删除 |
| `strings /proc/2131795/exe \| grep -iE "pool\|mine\|xmr"` | 命中字符串 `avaXMR`、`XmRo`、`POOL`、`_xmr` |
| `nsenter -t 2131795 -n ss -tnp \| grep python` | 外联 `192.168.49.2:47744 → 209.141.54.8:8443` |
| `strings /proc/2131795/exe \| head` | 出现 `$Id: UPX 5.11 Copyright ...$` — UPX 加壳 |

**结论**：UPX 加壳的 Monero 矿工，伪装成 `python3.7.3`，自删除磁盘文件，跑在 Docker 容器内。

> **设计点**：`/exec` 端点的 `exit_code` 让 agent 不用 grep 输出来判定命令成败。
> 每次只要 1 次 HTTP 调用就能跑完整命令并拿干净 stdout — 比传统的"发命令 → 轮询 snapshot → 自己 strip prompt"流程快 5 倍以上。

---

## 4. 还原父进程链 + 容器归属

```bash
ps -p $(cat /proc/2131795/status | grep PPid | awk '{print $2}') -o pid,cmd
# → 1115425 /sbin/init

ps -p 1115425 -o ppid
# → 1115402 (containerd-shim)
```

进程链：`containerd-shim → /sbin/init (容器内) → python3.7.3`。

```bash
docker inspect 7a3785e9bccc... | jq '.[0].Config.Image'
# → gcr.io/k8s-minikube/kicbase:v0.0.50
```

**入侵入口确认**：minikube 容器内（用户配置的本地 K8s 测试环境）。

---

## 5. 找持久化机制

进入容器查 systemd：

```bash
docker exec minikube systemctl list-units --type=service --state=running
# → nvidia-drivice.service   loaded active running python system service
```

伪装成 nvidia 驱动！查 unit 文件：

```ini
# /lib/systemd/system/nvidia-drivice.service
[Unit]
Description=python system service
After=network.target
[Service]
ExecStart=/usr/bin/python3.7.3
WorkingDirectory=/usr/bin
Restart=always
RestartSec=3
[Install]
WantedBy=multi-user.target
```

`Restart=always` — 进程被 kill 也会立刻拉起。

---

## 6. 矿池 C2 归属

```bash
curl -s https://ipinfo.io/209.141.54.8
```

```json
{
  "ip": "209.141.54.8",
  "city": "Las Vegas",
  "org": "AS53667 FranTech Solutions",
  ...
}
```

FranTech Solutions / BuyVM — 拉斯维加斯防弹托管，已知恶意基础设施提供方。

---

## 7. 用户确认后执行清理

用户授权后（用户说"k8s相关容器都可以删了，我不需要了"）：

```bash
# 杀进程（虽然 Restart=always，但先停 service）
kill -9 2131795

# 移除整个 minikube + 所有 k8s 容器
minikube delete --all --purge
docker rmi gcr.io/k8s-minikube/kicbase:v0.0.50
docker rmi 1panel/kubepi:v1.9.0
docker stop 1Panel-kubepi-8ncs && docker rm 1Panel-kubepi-8ncs

# 清残留
rm -f /usr/local/bin/minikube /usr/local/bin/kubectl
rm -rf /root/.kube /root/.minikube
```

负载从 **load average: 28** 在 15 分钟内回落到 **0.13**。

---

## 8. 加固：iptables + SSH key 清理

```bash
# 永久封矿池 IP
iptables -I OUTPUT -d 209.141.54.8 -j DROP
iptables -I INPUT -s 209.141.54.8 -j DROP

# 安装 iptables-persistent 保证重启生效
DEBIAN_FRONTEND=noninteractive apt-get install -y iptables-persistent

# 检查 authorized_keys 发现格式异常的 cznorth@claude 条目（多行残破）
# 备份后只保留头 3 个 ssh-keygen 验证通过的 key
head -n 3 /root/.ssh/authorized_keys > /tmp/ak.new && mv /tmp/ak.new /root/.ssh/authorized_keys
```

---

## 9. 上报 abuse

agent 起草了完整的 AbuseIPDB 报告 + FranTech abuse 邮件正文（含 MD5、时间戳、字符串证据），用户复制到浏览器/邮件客户端提交。

---

## 用到的 Agent API 端点统计

| 端点 | 调用次数 | 主要用途 |
|------|---------|---------|
| `GET /ssh/connections` | 1 | 找目标服务器 |
| `POST /terminals` | 2 | 建/重建 SSH 终端 |
| `POST /terminals/{id}/input` | ~10 | 命令交互、Ctrl+C 解锁卡死 shell |
| `POST /terminals/{id}/exec` | （未使用，案例发生在 exec 端点开发前）| — |
| `GET /terminals/{id}/snapshot` | ~5 | 拉取已积累输出 |
| `DELETE /terminals/{id}` | 2 | 清理终端 |

> **案例后的反思**：这次操作中 agent 频繁遇到"`` JSON 转义崩"、
> "嵌套引号 awk 跑不起来"、"需要 grep 但只能拉全量 snapshot"等问题。
> 这些痛点直接催生了本次更新的 **`/exec`、命名控制键 keys、`data_b64`、
> snapshot pattern grep** 等功能。

如果今天用最新 v3 API 重做这次清理，HTTP 请求次数预计减半，
而且 `Ctrl+C` 等关键时刻不会卡在 PowerShell 控制字符编码问题上。

---

## 经验复盘

### 入侵指标（IoC）

- 二进制 MD5: `ea1d8763dee3307e3f7ce7b6a5a42f4b`
- 字符串特征: `avaXMR`、`XmRo`、`POOL`、`_xmr`
- C2 / 矿池: `209.141.54.8:8443`（AS53667 FranTech Solutions）
- 持久化: systemd `nvidia-drivice.service`（伪装名）
- 自删除: 进程跑着但磁盘 `/usr/bin/python3.7.3` 不存在
- UPX 5.11 加壳

### 检测一个进程是否可疑的速查表

| 信号 | 含义 |
|------|------|
| `/proc/<pid>/exe` 链接已断（指向 deleted）| 进程自删除磁盘文件 |
| `/proc/<pid>/maps` 含多个 `rwxp` 匿名页 | 自修改 / shellcode |
| `cmdline` 仅有可执行路径无参数 | 不像正常 Python/Node 等解释器 |
| `cwd` 指向 `/usr/bin`、`/tmp`、`/dev/shm` | 异常 |
| 高 CPU 占用 + 跑数周 + 无 systemd 日志 | 隐蔽长期挖矿 |
| 外联非常用端口（`8443` 是矿池常用伪装 HTTPS）| 可疑 |

### "反攻"是个坑

事件中用户问"能不能用攻击者的钱包地址给矿池提交无效 share 让他被封号"。
答案：**理论上有效，实际上不建议**。

1. 私池（本案 IP 特征像私池）根本没有"封钱包"机制。
2. 钱包地址藏在 UPX 加壳二进制内，提取要先脱壳。
3. 你的 IP 进矿池/上游 ISP 黑名单。
4. 未授权访问第三方计算资源 — 多数司法区违法。

**正确路径**：清除 → 修入侵口 → 上报 abuse → 防火墙黑掉 C2 IP。

---

## 给 agent 开发者的启示

这次实战暴露了 Agent API 的一系列设计缺陷，下一版统一修掉：

| 痛点 | 修复方案 |
|------|---------|
| Ctrl+C 在 JSON 里塞 `` 易崩 | `keys: ["ctrl+c"]` 命名键 |
| awk/jq 多层引号嵌套地狱 | `data_b64` / `command_b64` |
| exit_code 靠 grep 输出判定 | `/exec` 端点直接返回 |
| 256KB 缓冲全拉再 grep 浪费带宽 | snapshot `?pattern=` 服务端 grep |
| 长命令只能轮询 snapshot 浪费 CPU | `/stream` SSE 实时推流 |
| Agent 操作不透明 | `/events/stream` 操作事件流 + 前端监控面板 |
| 一次性命令要 3 次 HTTP | `/ssh/{id}/run` 三步合一 |
| Token 每次会话都问 | `/handshake` 自动发现 |
| 终端忘删积压 | TTL 自动回收 |

> 真实场景才是 API 设计的最佳验证场。这次安全事件直接成了 v3 版本的需求文档。
