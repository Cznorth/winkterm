/**
 * MCP stdio server for WinkTerm.
 *
 * The tools are thin wrappers over the CLI transport, so MCP clients get the
 * same WebSocket keepalive and HTTP fallback without duplicating protocol code.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { resolveConfig } from "./config.js";
import { call, TransportError } from "./transport.js";

function configFromEnv() {
  const config = resolveConfig();
  if (!config.token) {
    throw new Error(
      "未配置 WinkTerm agent token。请先运行 `winkterm login --base-url <url> --token <token>`，或设置 WINKTERM_AGENT_TOKEN。",
    );
  }
  return config;
}

function jsonText(data) {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  };
}

async function invoke(method, params = {}) {
  const progress = [];
  try {
    const result = await call(method, params, {
      config: configFromEnv(),
      onProgress: (data) => {
        if (!data) return;
        if (typeof data.output === "string") progress.push(data.output);
        else if (typeof data.text === "string") progress.push(data.text);
      },
    });
    return jsonText(progress.length ? { result, progress: progress.join("") } : result);
  } catch (err) {
    const message = err instanceof TransportError ? err.message : (err && err.message) || String(err);
    return { isError: true, content: [{ type: "text", text: message }] };
  }
}

export function createServer() {
  const server = new McpServer({ name: "winkterm", version: "0.2.1" });

  server.tool(
    "winkterm_call",
    "Call any WinkTerm agent method by name. Use this for new or less common methods.",
    {
      method: z.string().describe("Agent method, for example terminal.exec or ssh.files.read."),
      params: z.record(z.any()).optional().default({}).describe("Method parameters as a JSON object."),
    },
    ({ method, params }) => invoke(method, params),
  );

  server.tool("winkterm_list_terminals", "List open WinkTerm terminals.", {}, () => invoke("terminal.list"));

  server.tool(
    "winkterm_create_terminal",
    "Create a local or SSH terminal.",
    {
      type: z.enum(["local", "ssh"]).optional().default("local"),
      connection_id: z.string().optional(),
      name: z.string().optional(),
      transient: z.boolean().optional(),
      user_visible: z.boolean().optional(),
    },
    (params) => invoke("terminal.create", clean(params)),
  );

  server.tool(
    "winkterm_exec",
    "Run one command in an existing terminal. Prefer this for normal shell commands and long tasks.",
    {
      terminal_id: z.string(),
      command: z.string().optional(),
      command_b64: z.string().optional(),
      timeout: z.number().optional(),
      cwd: z.string().optional(),
      env: z.record(z.string()).optional(),
    },
    (params) => invoke("terminal.exec", clean(params)),
  );

  server.tool(
    "winkterm_input",
    "Send raw input or control keys to an existing terminal.",
    {
      terminal_id: z.string(),
      data: z.string().optional().default(""),
      data_b64: z.string().optional(),
      keys: z.array(z.string()).optional(),
      enter: z.boolean().optional(),
      wait: z.boolean().optional(),
      timeout: z.number().optional(),
      idle: z.number().optional(),
      strip_echo: z.boolean().optional(),
    },
    (params) => invoke("terminal.input", clean(params)),
  );

  server.tool(
    "winkterm_snapshot",
    "Read terminal output, optionally from an offset or filtered by pattern.",
    {
      terminal_id: z.string(),
      since: z.number().optional(),
      pattern: z.string().optional(),
      context: z.number().optional(),
      case_insensitive: z.boolean().optional(),
    },
    (params) => invoke("terminal.snapshot", clean(params)),
  );

  server.tool(
    "winkterm_delete_terminal",
    "Close an existing terminal.",
    { terminal_id: z.string() },
    (params) => invoke("terminal.delete", params),
  );

  server.tool("winkterm_list_ssh_connections", "List saved SSH connections.", {}, () =>
    invoke("ssh.connections.list"),
  );

  server.tool(
    "winkterm_ssh_run",
    "Run one command on a saved SSH connection using a transient terminal.",
    {
      conn_id: z.string(),
      command: z.string().optional(),
      command_b64: z.string().optional(),
      timeout: z.number().optional(),
      cwd: z.string().optional(),
      env: z.record(z.string()).optional(),
    },
    (params) => invoke("ssh.run", clean(params)),
  );

  return server;
}

function clean(obj) {
  const out = {};
  for (const [key, value] of Object.entries(obj || {})) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

export async function main() {
  const server = createServer();
  await server.connect(new StdioServerTransport());
  process.stdin.resume();
  await new Promise(() => {});
}
