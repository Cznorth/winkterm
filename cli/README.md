# winkterm

Thin client that drives a WinkTerm backend's external agent API over a **WebSocket**
long-connection, with transparent **HTTP fallback**.

Why: the HTTP agent API (`/exec`, `/run`) blocks for the whole command. Behind a
reverse proxy (nginx default `proxy_read_timeout 60s`) a long command gets the
connection cut at 60s. The WebSocket transport sends an application-level heartbeat
every 15s, so the socket never goes idle long enough to trip a proxy timeout — long
installs/builds/dumps run to completion.

The CLI is intended for agents that cannot use MCP. Do not rely on live stderr
streaming as the only progress channel: many agent shell tools return stdout/stderr
only after the process exits. For long-running work, use an observable workflow:
start the command, then query snapshots/job status or a wait-for-event API when
available, so the agent can catch prompts, errors, and stuck commands early.

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

## MCP server

For MCP-capable agents, use `winkterm-mcp` instead of asking the agent to spawn CLI
commands manually. It exposes common tools (`winkterm_ssh_run`, `winkterm_exec`,
`winkterm_snapshot`, `winkterm_ssh_upload`, etc.) plus a generic `winkterm_call`
tool for new or less common backend methods.

Run `login` once first, or pass credentials through environment variables:

```bash
npx winkterm login --base-url https://ops.example.com --token <bearer-token>
```

Example MCP config:

```json
{
  "mcpServers": {
    "winkterm": {
      "command": "npx",
      "args": ["-y", "winkterm", "mcp"],
      "env": {
        "WINKTERM_BASE_URL": "https://ops.example.com",
        "WINKTERM_AGENT_TOKEN": "<bearer-token>"
      }
    }
  }
}
```

If installed globally, use:

```json
{
  "mcpServers": {
    "winkterm": {
      "command": "winkterm-mcp"
    }
  }
}
```

Common MCP tools:

| Tool group | Tools |
| --- | --- |
| Generic | `winkterm_call` |
| Terminals | `winkterm_list_terminals`, `winkterm_get_terminal`, `winkterm_create_terminal`, `winkterm_exec`, `winkterm_run`, `winkterm_run_status`, `winkterm_run_wait`, `winkterm_run_cancel`, `winkterm_input`, `winkterm_snapshot`, `winkterm_delete_terminal` |
| SSH connections | `winkterm_list_ssh_connections`, `winkterm_get_ssh_connection`, `winkterm_create_ssh_connection`, `winkterm_update_ssh_connection`, `winkterm_delete_ssh_connection`, `winkterm_import_electerm` |
| SSH commands | `winkterm_ssh_run` |
| Events | `winkterm_recent_events` |
| SSH files | `winkterm_ssh_files_list`, `winkterm_ssh_files_read`, `winkterm_ssh_files_write`, `winkterm_ssh_upload`, `winkterm_ssh_download`, `winkterm_ssh_mkdir`, `winkterm_ssh_delete_paths` |

`winkterm_ssh_upload` reads `local_path` on the machine running the MCP server.
`winkterm_ssh_download` writes `local_path` on the WinkTerm backend machine.

## Usage

```bash
# Generic — covers every backend method, no client update needed when the backend adds one:
winkterm call <method> '<json-params>'
winkterm call terminal.exec '{"terminal_id":"t1","command":"ls -la"}'

# Convenience sugar:
winkterm list
winkterm create --type ssh --connection-id ab12cd34 --name fix
winkterm exec <terminal_id> "uptime"                   # short command, waits for result
winkterm run <terminal_id> "npm install"               # agent-friendly long task
winkterm run-wait <run_id> --since <size> --timeout 30 # wait for next output/status
winkterm run-status <run_id> --since <size>
winkterm run-cancel <run_id>
winkterm input <terminal_id> ":q!" --no-enter
winkterm snapshot <terminal_id> --since 1024 --pattern ERROR
winkterm delete <terminal_id>
winkterm ssh-list
winkterm ssh-run <conn_id> "uptime; df -h" --timeout 120
winkterm call ssh.upload '{"conn_id":"<conn_id>","local_path":"./app.log","remote_path":"/tmp/","overwrite":true}'
```

Result payload prints as JSON to **stdout**; live progress and diagnostics may be
printed to **stderr**, but agent callers must not depend on seeing stderr before the
CLI process exits. Exit code is non-zero on error.

For `ssh.upload`, `local_path` is resolved on the machine running the CLI, then
sent to the WinkTerm backend as multipart file content.

## Transport behaviour

- `auto` (default): try WebSocket `/ws/agent`; on connect failure / closed-before-result
  (e.g. an older backend without the route), fall back to the HTTP REST endpoint.
- `ws`: WebSocket only.
- `http`: HTTP only. Note `terminal.stream` and `events.stream` are WS-only — over HTTP
  use polling (`terminal.snapshot` / `events.recent`) instead.

See the authoritative method ↔ endpoint map in the backend's
`GET /api/agent/skill.md`.
