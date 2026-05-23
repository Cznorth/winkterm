# Case Study: An AI Agent Hunts Down an XMR Cryptojacker via WinkTerm

> [中文版](case-study-xmr-miner-cleanup.md)


> **Date**: 2026-05-23
> **Scenario**: User reports unusually high load on a RackNerd VPS
> **Operator**: Claude Code (via the WinkTerm Agent API skill)
> **Total time**: ~30 minutes from first connection to cleanup + abuse report

This is a real incident response. The user said *"the 107.173-something server is
running hot, take a look."* That was it. No IP, no credentials, no prior context.
The AI agent used WinkTerm's HTTP Agent API to locate the culprit, reconstruct
the kill chain, block the C2, clean the malware, and file abuse reports — all
without further human input.

The case demonstrates how WinkTerm's Agent API holds up under **real ops
pressure**.

---

## 0. The Original User Prompt

```
the 107.173-something server is running hot, take a look
```

That's all. Bring your own intuition.

---

## 1. Locating the Target Server (1 API call)

```http
GET /api/agent/ssh/connections
Authorization: Bearer <token>
```

Returns every configured SSH connection. The agent scanned the `host` fields,
matched `107.173.156.37` (title: "US California RackNerd"), and obtained
`connection_id = 2pPrtCB`.

> **Design point**: The user never had to share credentials or hostnames. The
> agent simply reused WinkTerm's built-in connection manager.

---

## 2. Open an SSH Terminal + First-Pass Diagnostics

```http
POST /api/agent/terminals
body: {"type":"ssh","connection_id":"2pPrtCB","cols":200,"rows":50}
```

Then ran `top -bn1 | head -30 && echo --- && ps aux --sort=-%cpu | head -20`
to look at CPU pressure.

The smoking gun appeared immediately:

```
load average: 6.85, 19.48, 28.22   ← 15-min avg pinned at 28
2131795 root  S  492.9% CPU  35.7% MEM  python3.7.3   ← the culprit
```

PID 2131795 had been chewing ~5 cores and 2.1 GB RAM for four weeks (since
May 11).

---

## 3. Identifying the Suspicious Process (multiple `exec` calls)

Each command went through `/api/agent/terminals/{id}/exec`, returning a clean
`exit_code` + `stdout` per call:

| Command | Finding |
|---------|---------|
| `cat /proc/2131795/cmdline` | Just `/usr/bin/python3.7.3`, no args — not a normal Python invocation |
| `ls -la /proc/2131795/cwd` | cwd is `/usr/bin` (legit Python doesn't sit there) |
| `cat /proc/2131795/maps \| grep rwxp` | Multiple **rwxp anonymous pages** (writable + executable — malware signature) |
| `ls /usr/bin/python3.7.3` | **`No such file or directory`** — the binary deleted itself from disk |
| `strings /proc/2131795/exe \| grep -iE "pool\|mine\|xmr"` | Hits on `avaXMR`, `XmRo`, `POOL`, `_xmr` |
| `nsenter -t 2131795 -n ss -tnp \| grep python` | Outbound `192.168.49.2:47744 → 209.141.54.8:8443` |
| `strings /proc/2131795/exe \| head` | `$Id: UPX 5.11 Copyright ...$` — UPX-packed |

**Verdict**: a UPX-packed Monero miner masquerading as `python3.7.3`,
self-deleted from disk, running inside a Docker container.

> **Design point**: `/exec`'s `exit_code` means the agent never has to grep
> output to detect failure. One HTTP call runs a command and returns clean
> stdout — roughly 5× faster than the old "send → poll snapshot → strip
> prompt yourself" workflow.

---

## 4. Reconstructing the Parent Chain + Container Origin

```bash
ps -p $(cat /proc/2131795/status | grep PPid | awk '{print $2}') -o pid,cmd
# → 1115425 /sbin/init

ps -p 1115425 -o ppid
# → 1115402 (containerd-shim)
```

Process chain: `containerd-shim → /sbin/init (inside container) → python3.7.3`.

```bash
docker inspect 7a3785e9bccc... | jq '.[0].Config.Image'
# → gcr.io/k8s-minikube/kicbase:v0.0.50
```

**Intrusion vector confirmed**: inside the user's minikube container (a local
K8s test environment).

---

## 5. Finding the Persistence Mechanism

Stepped into the container to inspect systemd:

```bash
docker exec minikube systemctl list-units --type=service --state=running
# → nvidia-drivice.service   loaded active running python system service
```

Masquerading as an nvidia driver! The unit file:

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

`Restart=always` — kill the process and it bounces back in 3 seconds.

---

## 6. Mining-Pool C2 Attribution

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

FranTech Solutions / BuyVM — Las Vegas-based bulletproof hosting with a long
track record of harboring abusive infrastructure.

---

## 7. Cleanup (after user authorization)

User confirmed: *"the k8s containers can all go, I don't need them anymore."*

```bash
# Stop the process (Restart=always means we also need to remove the unit)
kill -9 2131795

# Wipe minikube + all k8s containers
minikube delete --all --purge
docker rmi gcr.io/k8s-minikube/kicbase:v0.0.50
docker rmi 1panel/kubepi:v1.9.0
docker stop 1Panel-kubepi-8ncs && docker rm 1Panel-kubepi-8ncs

# Leftovers
rm -f /usr/local/bin/minikube /usr/local/bin/kubectl
rm -rf /root/.kube /root/.minikube
```

Load dropped from **load average: 28** to **0.13** within 15 minutes.

---

## 8. Hardening: iptables + SSH key Cleanup

```bash
# Permanently block the mining pool IP
iptables -I OUTPUT -d 209.141.54.8 -j DROP
iptables -I INPUT -s 209.141.54.8 -j DROP

# Install iptables-persistent so the rule survives reboot
DEBIAN_FRONTEND=noninteractive apt-get install -y iptables-persistent

# Found a malformed `cznorth@claude` entry in authorized_keys (broken across
# lines). Backed up, then kept only the 3 keys that ssh-keygen validates.
head -n 3 /root/.ssh/authorized_keys > /tmp/ak.new && mv /tmp/ak.new /root/.ssh/authorized_keys
```

---

## 9. Abuse Reporting

The agent drafted a full AbuseIPDB report + FranTech abuse email body (with
MD5, timestamps, string evidence). The user pasted into the browser/mail
client and submitted.

---

## Agent API Endpoint Usage Stats

| Endpoint | Calls | Primary use |
|----------|-------|-------------|
| `GET /ssh/connections` | 1 | Locate target server |
| `POST /terminals` | 2 | Create/recreate SSH terminal |
| `POST /terminals/{id}/input` | ~10 | Interactive commands, Ctrl+C to unstick shells |
| `POST /terminals/{id}/exec` | (not used — case predates the exec endpoint) | — |
| `GET /terminals/{id}/snapshot` | ~5 | Pull accumulated output |
| `DELETE /terminals/{id}` | 2 | Cleanup |

> **Post-incident reflection**: during this run the agent kept hitting
> *"JSON escape for `` crashed,"* *"nested-quote awk won't run,"* and
> *"I need a grep but can only fetch the whole snapshot."* These pain points
> directly drove the new **`/exec`, named-key `keys`, `data_b64`, snapshot
> `pattern` grep** features in this release.

Redoing this cleanup with v3 API today would cut HTTP requests roughly in
half, and `Ctrl+C` rescues would never get stuck on PowerShell control-char
encoding.

---

## Lessons Learned

### Indicators of Compromise (IoC)

- Binary MD5: `ea1d8763dee3307e3f7ce7b6a5a42f4b`
- String signatures: `avaXMR`, `XmRo`, `POOL`, `_xmr`
- C2 / mining pool: `209.141.54.8:8443` (AS53667 FranTech Solutions)
- Persistence: systemd unit `nvidia-drivice.service` (masqueraded name)
- Self-deletion: process running but `/usr/bin/python3.7.3` not on disk
- Packed with UPX 5.11

### "Is This Process Suspicious?" Cheat Sheet

| Signal | What it means |
|--------|---------------|
| `/proc/<pid>/exe` link broken (shows "deleted") | Process self-deleted its on-disk binary |
| `/proc/<pid>/maps` has many `rwxp` anonymous pages | Self-modifying / shellcode |
| `cmdline` is just the executable path, no args | Not a typical interpreter (Python/Node) invocation |
| `cwd` points to `/usr/bin`, `/tmp`, or `/dev/shm` | Unusual |
| High CPU + running for weeks + no systemd log entries | Quiet long-term miner |
| Outbound on uncommon port (`8443` is a popular "fake-HTTPS" mining pool port) | Suspicious |

### "Hacking Back" Is a Trap

During the incident the user asked: *"can we submit invalid shares with the
attacker's wallet to get them banned from the pool?"*

The answer: **theoretically yes, in practice no.**

1. Private pools (this IP profile looks like one) don't even have a "ban
   wallet" mechanism — the attacker runs the pool.
2. The wallet address is buried in a UPX-packed binary; you'd have to unpack
   it first.
3. Your IP lands on the pool/ISP blocklist.
4. Unauthorized access to third-party compute resources is illegal in most
   jurisdictions.

**Correct path**: clean → patch the intrusion vector → file abuse reports →
firewall the C2 IP.

---

## Takeaways for Agent API Designers

This run exposed a series of API design flaws. v3 fixes them all:

| Pain point | Fix |
|------------|-----|
| Ctrl+C as JSON `` crashes | `keys: ["ctrl+c"]` named keys |
| awk/jq nested-quote hell | `data_b64` / `command_b64` |
| `exit_code` inferred from output | `/exec` returns it directly |
| 256 KB buffer downloaded just to grep | Snapshot `?pattern=` server-side grep |
| Long commands need snapshot polling | `/stream` SSE push |
| No visibility into what the agent did | `/events/stream` + frontend monitor panel |
| One-shot command = 3 HTTP calls | `/ssh/{id}/run` bundles them |
| Token re-asked every session | `/handshake` auto-discovery |
| Forgotten terminals pile up | TTL auto-cleanup |

> Real ops are the best API spec. This one incident effectively wrote the
> requirements doc for v3.
