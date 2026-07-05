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
  const server = new McpServer({ name: "winkterm", version: "0.3.0" });

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
    "Run one short command in an existing terminal and wait for completion. For long tasks, prefer winkterm_run + winkterm_run_wait.",
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
    "winkterm_run",
    "Start a long-running command in an existing terminal and return immediately with a run_id.",
    {
      terminal_id: z.string(),
      command: z.string().optional(),
      command_b64: z.string().optional(),
      timeout: z.number().optional().describe("Run budget in seconds; <=0 means no run timeout."),
      cancel_on_timeout: z.boolean().optional().describe("Send Ctrl+C if the run budget expires."),
      cwd: z.string().optional(),
      env: z.record(z.string()).optional(),
    },
    (params) => invoke("terminal.run", clean(params)),
  );

  server.tool(
    "winkterm_run_status",
    "Read a managed run's status and optional incremental output since a byte offset.",
    {
      run_id: z.string(),
      since: z.number().optional(),
    },
    (params) => invoke("terminal.run_status", clean(params)),
  );

  server.tool(
    "winkterm_run_wait",
    "Wait until a managed run has new output, finishes, or the wait timeout expires. Prefer this over sleeping between status checks.",
    {
      run_id: z.string(),
      since: z.number().optional(),
      timeout: z.number().optional().describe("Wait timeout in seconds; does not affect the running command."),
    },
    (params) => invoke("terminal.run_wait", clean(params)),
  );

  server.tool(
    "winkterm_run_cancel",
    "Cancel a managed run, normally by sending Ctrl+C to its terminal.",
    {
      run_id: z.string(),
      mode: z.enum(["ctrl_c", "close"]).optional().default("ctrl_c"),
    },
    (params) => invoke("terminal.run_cancel", clean(params)),
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

  server.tool(
    "winkterm_get_terminal",
    "Get one terminal by id.",
    { terminal_id: z.string() },
    (params) => invoke("terminal.get", params),
  );

  server.tool("winkterm_list_ssh_connections", "List saved SSH connections.", {}, () =>
    invoke("ssh.connections.list"),
  );

  server.tool(
    "winkterm_get_ssh_connection",
    "Get one saved SSH connection. Secrets are masked unless secrets=true.",
    {
      conn_id: z.string(),
      secrets: z.boolean().optional(),
    },
    (params) => invoke("ssh.connections.get", clean(params)),
  );

  server.tool(
    "winkterm_create_ssh_connection",
    "Create a saved SSH connection.",
    {
      title: z.string().optional(),
      host: z.string(),
      port: z.number().optional(),
      username: z.string(),
      auth_type: z.enum(["password", "key"]).optional(),
      password: z.string().optional(),
      private_key_path: z.string().optional(),
      passphrase: z.string().optional(),
      vnc_port: z.number().optional(),
      vnc_password: z.string().optional(),
      color: z.string().optional(),
      group: z.string().optional(),
    },
    (params) => invoke("ssh.connections.create", clean(params)),
  );

  server.tool(
    "winkterm_update_ssh_connection",
    "Update a saved SSH connection. Omitted secret fields are retained by the backend.",
    {
      conn_id: z.string(),
      title: z.string().optional(),
      host: z.string().optional(),
      port: z.number().optional(),
      username: z.string().optional(),
      auth_type: z.enum(["password", "key"]).optional(),
      password: z.string().optional(),
      private_key_path: z.string().optional(),
      passphrase: z.string().optional(),
      vnc_port: z.number().optional(),
      vnc_password: z.string().optional(),
      color: z.string().optional(),
      group: z.string().optional(),
    },
    (params) => invoke("ssh.connections.update", clean(params)),
  );

  server.tool(
    "winkterm_delete_ssh_connection",
    "Delete a saved SSH connection.",
    { conn_id: z.string() },
    (params) => invoke("ssh.connections.delete", params),
  );

  server.tool(
    "winkterm_import_electerm",
    "Import electerm bookmarks into saved SSH connections.",
    { bookmarks: z.array(z.record(z.any())) },
    (params) => invoke("ssh.import_electerm", params),
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

  server.tool(
    "winkterm_recent_events",
    "Read recent WinkTerm agent events.",
    {
      since_id: z.number().optional(),
      limit: z.number().optional(),
    },
    (params) => invoke("events.recent", clean(params)),
  );

  server.tool(
    "winkterm_ssh_files_list",
    "List a directory on a saved SSH connection.",
    {
      conn_id: z.string(),
      path: z.string().optional(),
    },
    (params) => invoke("ssh.files.list", clean(params)),
  );

  server.tool(
    "winkterm_ssh_files_read",
    "Read a text file on a saved SSH connection.",
    {
      conn_id: z.string(),
      path: z.string(),
    },
    (params) => invoke("ssh.files.read", params),
  );

  server.tool(
    "winkterm_ssh_files_write",
    "Write a text file on a saved SSH connection.",
    {
      conn_id: z.string(),
      path: z.string(),
      content: z.string(),
      encoding: z.string().optional(),
    },
    (params) => invoke("ssh.files.write", clean(params)),
  );

  server.tool(
    "winkterm_ssh_upload",
    "Upload a local file from the MCP client machine to a saved SSH connection.",
    {
      conn_id: z.string(),
      local_path: z.string(),
      remote_path: z.string(),
      overwrite: z.boolean().optional(),
    },
    (params) => invoke("ssh.upload", clean(params)),
  );

  server.tool(
    "winkterm_ssh_download",
    "Download a remote file to a local path on the WinkTerm backend machine.",
    {
      conn_id: z.string(),
      remote_path: z.string(),
      local_path: z.string(),
    },
    (params) => invoke("ssh.download", params),
  );

  server.tool(
    "winkterm_ssh_mkdir",
    "Create a directory on a saved SSH connection.",
    {
      conn_id: z.string(),
      path: z.string(),
    },
    (params) => invoke("ssh.mkdir", params),
  );

  server.tool(
    "winkterm_ssh_delete_paths",
    "Delete one or more paths on a saved SSH connection.",
    {
      conn_id: z.string(),
      paths: z.array(z.string()),
    },
    (params) => invoke("ssh.delete_paths", params),
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
