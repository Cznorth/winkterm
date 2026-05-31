---
name: winkterm-remote
description: Drive a running WinkTerm backend over HTTP — list SSH connections, open local/SSH terminals, send commands and read output, take terminal snapshots, run async SSH jobs, and transfer files via SSH. Use when you need to run shell commands on remote servers or inside a controlled terminal. Requires a reachable WinkTerm backend.
version: 4
license: MIT
homepage: https://github.com/Cznorth/winkterm
---

# WinkTerm Remote Terminal

Operate WinkTerm's terminals over its HTTP API. The backend keeps a dedicated PTY
per terminal; you can open local or SSH terminals, run commands, read output, run
long-running jobs asynchronously, and move files over SSH.

This skill is a thin bootstrap. The authoritative, always-current reference lives
on the backend at `GET /api/agent/skill.md` — fetch it on first use so you have the
exact endpoint surface for the version you are talking to.

## Prerequisites

A running WinkTerm backend (default `http://localhost:8000`). Get WinkTerm at
https://github.com/Cznorth/winkterm — run via `docker compose up -d` or the
desktop build, then set `ANTHROPIC_API_KEY` and an agent token.

## Configure

- **Base URL**: `${WINKTERM_BASE_URL}` (default `http://localhost:8000`)
- **Auth**: every request carries `Authorization: Bearer ${WINKTERM_AGENT_TOKEN}`,
  or append `?token=<token>` to the URL (for SSE/EventSource clients that cannot
  set custom headers).
- Missing token → endpoints return `503`; wrong token → `401`.

### Token discovery (do this at session start)

1. **Check persisted memory / context** — the token may already be in an env var
   (`WINKTERM_AGENT_TOKEN`), your agent memory store, or the project `CLAUDE.md`.
2. **Local handshake** (only valid for an agent on the same host as WinkTerm):
   ```bash
   curl -s http://localhost:8000/api/agent/handshake
   # → {"token":"<bearer-token>","base_url":"http://localhost:8000"}
   ```
   This endpoint needs no auth but is **localhost-only** (remote IPs get `403`).
3. **Remote agent / all else fails** — ask the user **once** for the token, then
   persist it to memory and reuse it in later sessions. Do not re-ask every session.

On `401` mid-session the token may have rotated: clear the stored value and redo
the steps above.

## Fetch the full skill (do this at session start)

The backend evolves. Pull the live, complete reference and prefer it over this file:

```bash
curl -fsSL "${WINKTERM_BASE_URL:-http://localhost:8000}/api/agent/skill.md"
```

Compare the `version:` line (second line) against this file's frontmatter. If the
server is newer, tell the user and offer to overwrite the local copy
(`curl ... /api/agent/skill.md > <local-skill-path>`); the new content takes effect
next session. Never overwrite silently — show a diff first.

## Core workflow

1. `GET /api/agent/ssh/connections` — list SSH connections, get a connection `id`.
2. `POST /api/agent/terminals` — open a terminal (`{"type":"local"}` or
   `{"type":"ssh","connection_id":"<id>"}`), get a terminal `id`.
3. Operate the terminal:
   - **Preferred** `POST /api/agent/terminals/{id}/exec` — run one POSIX-shell
     command, returns clean `stdout` + real `exit_code`.
   - `POST /api/agent/terminals/{id}/input` — raw input / named control keys
     (`{"keys":["ctrl+c"],"enter":false}`).
4. `GET /api/agent/terminals/{id}/snapshot` — read current terminal content
   (supports incremental `since`, server-side `pattern` grep).
5. `DELETE /api/agent/terminals/{id}` — close when done.

## Useful shortcuts

- **One-shot SSH**: `POST /api/agent/ssh/{conn_id}/run` runs a single command on a
  connection without manual create/exec/delete.
- **Async SSH job** (long tasks, survives gateway timeouts):
  `POST /api/agent/ssh/{conn_id}/run_async` → `{job_id}`, then poll
  `GET /api/agent/jobs/{job_id}`. Use for installs, `mysqldump`, `docker build`,
  large copies — anything that can exceed a ~60s proxy timeout.
- **Live stream**: `GET /api/agent/terminals/{id}/stream` (SSE) for `tail -f` /
  long-command monitoring.
- **Files over SSH**: `GET/PUT .../files`, `POST .../upload`, `POST .../download`,
  `POST .../directories`, `DELETE .../paths`.

## Tips

- Prefer `/exec` — you get a clean `stdout` and a real exit code, no echo/prompt
  stripping needed. POSIX shells only; for Windows `cmd.exe` use `/input`.
- For commands with nested quotes (awk, jq, heredocs), send `command_b64` /
  `data_b64` (base64) to skip a layer of JSON+shell escaping.
- Terminals are stateful: `cd` and env vars persist across commands on the same
  terminal `id`.
- SSH terminals may show a login banner first; snapshot once to confirm the shell
  is ready before sending commands.

For the complete endpoint reference (request/response shapes, all control-key
names, event stream, SFTP details), use the live `GET /api/agent/skill.md`.
