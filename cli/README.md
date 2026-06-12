# winkterm

Thin client that drives a WinkTerm backend's external agent API over a **WebSocket**
long-connection, with transparent **HTTP fallback**.

Why: the HTTP agent API (`/exec`, `/run`) blocks for the whole command. Behind a
reverse proxy (nginx default `proxy_read_timeout 60s`) a long command gets the
connection cut at 60s. The WebSocket transport sends an application-level heartbeat
every 15s, so the socket never goes idle long enough to trip a proxy timeout — long
installs/builds/dumps run to completion.

## Install

Published to npm — no clone needed:

```bash
npx winkterm help          # run without installing
# or install globally:
npm install -g winkterm    # then `winkterm ...` on PATH
```

From the repo (development):

```bash
cd cli
npm install            # single dependency: ws
node bin/winkterm.js help
# optional: npm link   # then `winkterm ...` on PATH
```

## Configure

Run `login` once — credentials go to `~/.winkterm/cli.json` (mode `0600`), so later
commands carry no token on the command line (a screenshot can't leak it):

```bash
npx winkterm login --base-url https://ops.example.com --token <bearer-token>
npx winkterm ssh-list        # no token needed anymore
npx winkterm whoami          # show base-url + masked token + source
npx winkterm logout          # delete stored credentials
```

Or pass per-call via env / flags (precedence: flags > env > config file > defaults):

```bash
export WINKTERM_BASE_URL=https://ops.example.com   # default http://localhost:8000
export WINKTERM_AGENT_TOKEN=<bearer-token>         # same token as the HTTP agent API
export WINKTERM_TRANSPORT=auto                     # ws | http | auto (default auto)
```

The WebSocket URL is derived from the base URL (`http→ws`, `https→wss`, path
`/ws/agent`); override with `WINKTERM_WS_URL` or `--ws-url`.

## Usage

```bash
# Generic — covers every backend method, no client update needed when the backend adds one:
winkterm call <method> '<json-params>'
winkterm call terminal.exec '{"terminal_id":"t1","command":"ls -la"}'

# Convenience sugar:
winkterm list
winkterm create --type ssh --connection-id ab12cd34 --name fix
winkterm exec <terminal_id> "sleep 300 && echo done"   # long task, WS keeps it alive
winkterm input <terminal_id> ":q!" --no-enter
winkterm snapshot <terminal_id> --since 1024 --pattern ERROR
winkterm delete <terminal_id>
winkterm ssh-list
winkterm ssh-run <conn_id> "uptime; df -h" --timeout 120
```

Result payload prints as JSON to **stdout**; live streaming output and diagnostics go
to **stderr**; exit code is non-zero on error.

## Transport behaviour

- `auto` (default): try WebSocket `/ws/agent`; on connect failure / closed-before-result
  (e.g. an older backend without the route), fall back to the HTTP REST endpoint.
- `ws`: WebSocket only.
- `http`: HTTP only. Note `terminal.stream` and `events.stream` are WS-only — over HTTP
  use polling (`terminal.snapshot` / `events.recent`) instead.

See the authoritative method ↔ endpoint map in the backend's
`GET /api/agent/skill.md`.
