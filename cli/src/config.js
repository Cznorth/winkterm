/**
 * Configuration resolution for the WinkTerm CLI.
 *
 * Precedence: explicit CLI flags > environment variables > defaults.
 *   WINKTERM_BASE_URL    backend HTTP base, e.g. https://ops.example.com  (default http://localhost:8000)
 *   WINKTERM_AGENT_TOKEN bearer token for the agent API
 *   WINKTERM_WS_URL      override the derived WebSocket URL (optional)
 *   WINKTERM_TRANSPORT   ws | http | auto  (default auto)
 */

const DEFAULT_BASE_URL = "http://localhost:8000";

export function resolveConfig(flags = {}) {
  const baseUrl = (flags.baseUrl || process.env.WINKTERM_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const token = flags.token || process.env.WINKTERM_AGENT_TOKEN || "";
  const wsUrl = flags.wsUrl || process.env.WINKTERM_WS_URL || deriveWsUrl(baseUrl);
  const transport = (flags.transport || process.env.WINKTERM_TRANSPORT || "auto").toLowerCase();
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
