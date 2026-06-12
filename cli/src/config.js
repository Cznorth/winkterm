/**
 * Configuration resolution for the WinkTerm CLI.
 *
 * Precedence: explicit CLI flags > environment variables > config file > defaults.
 *   WINKTERM_BASE_URL    backend HTTP base, e.g. https://ops.example.com  (default http://localhost:8000)
 *   WINKTERM_AGENT_TOKEN bearer token for the agent API
 *   WINKTERM_WS_URL      override the derived WebSocket URL (optional)
 *   WINKTERM_TRANSPORT   ws | http | auto  (default auto)
 *   WINKTERM_CONFIG      override the config file path (default ~/.winkterm/cli.json)
 *
 * The config file lets a user run `winkterm login` once and then call plain
 * `winkterm ssh-list` with no token on the command line — so a screenshot of a
 * later invocation never leaks the bearer token.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, chmodSync } from "node:fs";

const DEFAULT_BASE_URL = "http://localhost:8000";

export function configPath() {
  if (process.env.WINKTERM_CONFIG) return process.env.WINKTERM_CONFIG;
  return join(homedir(), ".winkterm", "cli.json");
}

/** Read the config file; returns {} when absent or unreadable. */
export function loadConfigFile() {
  try {
    return JSON.parse(readFileSync(configPath(), "utf-8")) || {};
  } catch {
    return {};
  }
}

/** Persist config (merged over existing) with 0600 perms. Returns the saved path. */
export function saveConfigFile(patch) {
  const path = configPath();
  mkdirSync(join(path, ".."), { recursive: true });
  const merged = { ...loadConfigFile(), ...patch };
  // Drop empty values so saving a partial patch never blanks a stored field.
  for (const k of Object.keys(merged)) {
    if (merged[k] === undefined || merged[k] === "" || merged[k] === null) delete merged[k];
  }
  writeFileSync(path, JSON.stringify(merged, null, 2) + "\n", { mode: 0o600 });
  try {
    chmodSync(path, 0o600); // ensure perms even if the file pre-existed
  } catch {
    /* best-effort on platforms without POSIX perms */
  }
  return path;
}

/** Remove the config file. Returns true if a file was deleted. */
export function clearConfigFile() {
  const path = configPath();
  if (!existsSync(path)) return false;
  rmSync(path);
  return true;
}

export function resolveConfig(flags = {}) {
  const file = loadConfigFile();
  const baseUrl = (
    flags.baseUrl ||
    process.env.WINKTERM_BASE_URL ||
    file.baseUrl ||
    DEFAULT_BASE_URL
  ).replace(/\/+$/, "");
  const token = flags.token || process.env.WINKTERM_AGENT_TOKEN || file.token || "";
  const wsUrl =
    flags.wsUrl || process.env.WINKTERM_WS_URL || file.wsUrl || deriveWsUrl(baseUrl);
  const transport = (
    flags.transport ||
    process.env.WINKTERM_TRANSPORT ||
    file.transport ||
    "auto"
  ).toLowerCase();
  return { baseUrl, token, wsUrl, transport };
}

/** http(s)://host[/p] -> ws(s)://host[/p]/ws/agent */
export function deriveWsUrl(baseUrl) {
  let u;
  try {
    u = new URL(baseUrl);
  } catch {
    return baseUrl;
  }
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.pathname = u.pathname.replace(/\/+$/, "") + "/ws/agent";
  return u.toString();
}
