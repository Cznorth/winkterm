/**
 * WinkTerm CLI entry. A thin client over the agent transport (WebSocket-first,
 * HTTP fallback). Designed to be spawned per-invocation by an agent: the result
 * payload is printed as JSON to stdout; streaming output and diagnostics go to
 * stderr; exit code is non-zero on error.
 */

import { resolveConfig, saveConfigFile, clearConfigFile, configPath } from "./config.js";
import { call, TransportError } from "./transport.js";

const GLOBAL_FLAGS = new Set(["base-url", "token", "transport", "ws-url"]);

function parseArgs(argv) {
  const _ = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const body = a.slice(2);
      const eq = body.indexOf("=");
      let key, val;
      if (eq >= 0) {
        key = body.slice(0, eq);
        val = body.slice(eq + 1);
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
        key = body;
        val = argv[++i];
      } else {
        key = body;
        val = true; // boolean flag
      }
      // Repeated flags (e.g. --p k=v --p k2=v2) accumulate into an array.
      if (Object.prototype.hasOwnProperty.call(flags, key)) {
        flags[key] = Array.isArray(flags[key]) ? [...flags[key], val] : [flags[key], val];
      } else {
        flags[key] = val;
      }
    } else {
      _.push(a);
    }
  }
  return { _, flags };
}

function configFromFlags(flags) {
  return resolveConfig({
    baseUrl: flags["base-url"],
    token: flags["token"],
    transport: flags["transport"],
    wsUrl: flags["ws-url"],
  });
}

/** Coerce a CLI string value to JSON when it parses, else keep as string. */
function coerce(v) {
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

const HELP = `winkterm — drive a WinkTerm backend (WebSocket-first, HTTP fallback)

Usage:
  winkterm <command> [args] [--flags]

Global flags (or env WINKTERM_BASE_URL / WINKTERM_AGENT_TOKEN / WINKTERM_TRANSPORT):
  --base-url <url>     backend HTTP base (default http://localhost:8000)
  --token <token>      agent bearer token
  --transport <mode>   ws | http | auto (default auto)
  --ws-url <url>       override derived WebSocket URL
  --quiet              suppress live progress on stderr

Auth (store credentials once so later calls carry no token on the command line):
  winkterm login --base-url <url> --token <token>   # saved to ~/.winkterm/cli.json (0600)
  winkterm logout                                   # delete the stored credentials
  winkterm whoami                                   # show active base-url + masked token + source

Generic (covers every backend method, no client update needed):
  winkterm call <method> [json-params]    # e.g. call terminal.exec '{"terminal_id":"t","command":"ls"}'
                         [--p key=value]   # add/override a param (value JSON-coerced)

Convenience:
  winkterm list                                   # list terminals
  winkterm create [--type local|ssh] [--connection-id id] [--name n]
  winkterm exec <terminal_id> <command...> [--timeout n] [--cwd dir]
  winkterm input <terminal_id> <data...> [--no-enter] [--wait]
  winkterm snapshot <terminal_id> [--since n] [--pattern p]
  winkterm delete <terminal_id>
  winkterm ssh-list                               # list SSH connections
  winkterm ssh-run <conn_id> <command...> [--timeout n]

Long tasks: just use exec/ssh-run. The WebSocket heartbeat keeps the call
alive for as long as the command runs, so there is no job/polling layer here —
async jobs are an HTTP-only workaround for proxy timeouts the CLI doesn't hit.

Examples:
  winkterm exec t1 "sleep 600 && echo done"       # 10-min task: WS keeps it alive, output streams live
  winkterm ssh-run ab12cd34 "apt-get install -y nginx"   # long install, no polling needed
`;

/** Build (method, params) from a parsed command. Returns null for meta commands. */
function buildCall(cmd, _, flags) {
  const rest = _.slice(1);
  switch (cmd) {
    case "call": {
      const method = rest[0];
      if (!method) throw new UsageError("call 需要 <method>");
      let params = {};
      if (rest[1]) params = coerce(rest[1]) || {};
      if (flags.p) {
        const pairs = Array.isArray(flags.p) ? flags.p : [flags.p];
        for (const pair of pairs) {
          const eq = String(pair).indexOf("=");
          if (eq > 0) params[String(pair).slice(0, eq)] = coerce(String(pair).slice(eq + 1));
        }
      }
      return { method, params };
    }
    case "list":
      return { method: "terminal.list", params: {} };
    case "create":
      return {
        method: "terminal.create",
        params: clean({
          type: flags.type,
          connection_id: flags["connection-id"],
          name: flags.name,
          transient: flags.transient ? true : undefined,
          user_visible: flags["no-visible"] ? false : undefined,
        }),
      };
    case "exec": {
      const tid = rest[0];
      const command = rest.slice(1).join(" ");
      if (!tid || !command) throw new UsageError("exec 需要 <terminal_id> <command...>");
      return {
        method: "terminal.exec",
        params: clean({ terminal_id: tid, command, timeout: numFlag(flags.timeout), cwd: flags.cwd }),
      };
    }
    case "input": {
      const tid = rest[0];
      const data = rest.slice(1).join(" ");
      if (!tid) throw new UsageError("input 需要 <terminal_id> <data...>");
      return {
        method: "terminal.input",
        params: clean({
          terminal_id: tid,
          data,
          enter: flags["no-enter"] ? false : undefined,
          wait: flags.wait ? true : undefined,
        }),
      };
    }
    case "snapshot": {
      const tid = rest[0];
      if (!tid) throw new UsageError("snapshot 需要 <terminal_id>");
      return {
        method: "terminal.snapshot",
        params: clean({ terminal_id: tid, since: numFlag(flags.since), pattern: flags.pattern }),
      };
    }
    case "delete": {
      const tid = rest[0];
      if (!tid) throw new UsageError("delete 需要 <terminal_id>");
      return { method: "terminal.delete", params: { terminal_id: tid } };
    }
    case "ssh-list":
      return { method: "ssh.connections.list", params: {} };
    case "ssh-run": {
      const conn = rest[0];
      const command = rest.slice(1).join(" ");
      if (!conn || !command) throw new UsageError("ssh-run 需要 <conn_id> <command...>");
      return { method: "ssh.run", params: clean({ conn_id: conn, command, timeout: numFlag(flags.timeout) }) };
    }
    default:
      throw new UsageError(`未知命令: ${cmd}`);
  }
}

class UsageError extends Error {}

function numFlag(v) {
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isNaN(n) ? undefined : n;
}

function clean(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out;
}

/** Show only the last 4 chars of a token; everything else becomes asterisks. */
function maskToken(token) {
  if (!token) return null;
  if (token.length <= 4) return "*".repeat(token.length);
  return "*".repeat(token.length - 4) + token.slice(-4);
}

export async function main(argv) {
  const { _, flags } = parseArgs(argv);
  const cmd = _[0];

  if (!cmd || cmd === "help" || flags.help) {
    process.stdout.write(HELP);
    return 0;
  }

  // Auth meta-commands: never touch the network.
  if (cmd === "login") {
    const baseUrl = flags["base-url"] || process.env.WINKTERM_BASE_URL;
    const token = flags.token || process.env.WINKTERM_AGENT_TOKEN;
    if (!token) {
      process.stderr.write("错误: login 需要 --token（或环境变量 WINKTERM_AGENT_TOKEN）\n");
      return 2;
    }
    const path = saveConfigFile({
      baseUrl: baseUrl ? baseUrl.replace(/\/+$/, "") : undefined,
      token,
      transport: flags.transport,
    });
    process.stdout.write(`已保存凭据到 ${path}（权限 600）。后续命令无需再带 token。\n`);
    return 0;
  }
  if (cmd === "logout") {
    const removed = clearConfigFile();
    process.stdout.write(removed ? `已删除 ${configPath()}\n` : "无已保存的凭据\n");
    return 0;
  }
  if (cmd === "whoami") {
    const c = configFromFlags(flags);
    const src = flags.token
      ? "--token"
      : process.env.WINKTERM_AGENT_TOKEN
        ? "env"
        : "config-file";
    process.stdout.write(
      JSON.stringify(
        { baseUrl: c.baseUrl, token: maskToken(c.token), transport: c.transport, tokenSource: c.token ? src : null },
        null,
        2,
      ) + "\n",
    );
    return 0;
  }

  let spec;
  try {
    spec = buildCall(cmd, _, flags);
  } catch (e) {
    if (e instanceof UsageError) {
      process.stderr.write(`错误: ${e.message}\n\n${HELP}`);
      return 2;
    }
    throw e;
  }

  const config = configFromFlags(flags);
  if (!config.token) {
    process.stderr.write(
      "错误: 未配置 token。先 `winkterm login --base-url <url> --token <token>`，或用 --token / 环境变量 WINKTERM_AGENT_TOKEN\n",
    );
    return 2;
  }

  const onProgress = flags.quiet
    ? undefined
    : (data) => {
        if (data && typeof data.output === "string") process.stderr.write(data.output);
        else if (data && typeof data.text === "string") process.stderr.write(data.text);
      };

  try {
    const result = await call(spec.method, spec.params, { config, onProgress });
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return 0;
  } catch (e) {
    if (e instanceof TransportError) {
      process.stderr.write(`错误: ${e.message}${e.status ? ` (status=${e.status})` : ""}\n`);
      return 1;
    }
    process.stderr.write(`错误: ${e.message}\n`);
    return 1;
  }
}
