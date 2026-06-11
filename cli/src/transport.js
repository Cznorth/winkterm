/**
 * Transport layer: a single `call(method, params)` that prefers a long-lived
 * WebSocket (heartbeat-kept, so long commands survive reverse-proxy timeouts)
 * and transparently falls back to the legacy HTTP REST surface when the
 * WebSocket is unavailable (older backend without /ws/agent, or a blocked path).
 */

import { WebSocket } from "ws";

const WS_CONNECT_TIMEOUT_MS = 4000;
const WS_AUTH_FAILED = 4401;

export class TransportError extends Error {
  constructor(message, { code, status } = {}) {
    super(message);
    this.name = "TransportError";
    this.code = code;
    this.status = status;
  }
}

/**
 * Unified call. Resolves with the result payload; rejects with TransportError.
 * @param {string} method
 * @param {object} params
 * @param {object} opts { config, onProgress }
 */
export async function call(method, params, opts = {}) {
  const { config, onProgress } = opts;
  const mode = config.transport;

  if (mode === "http") return httpCall(method, params, config);
  if (mode === "ws") return wsCall(method, params, config, onProgress);

  // auto: try WS, fall back to HTTP only when the socket itself is unavailable.
  try {
    return await wsCall(method, params, config, onProgress);
  } catch (err) {
    if (err instanceof TransportError && err.code === "WS_UNAVAILABLE") {
      return httpCall(method, params, config);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// WebSocket transport
// ---------------------------------------------------------------------------

function wsCall(method, params, config, onProgress) {
  return new Promise((resolve, reject) => {
    const url = `${config.wsUrl}?token=${encodeURIComponent(config.token)}`;
    let ws;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      reject(new TransportError(`WS 连接失败: ${e.message}`, { code: "WS_UNAVAILABLE" }));
      return;
    }

    let settled = false;
    let ready = false;
    const reqId = "1";

    const connectTimer = setTimeout(() => {
      if (!ready && !settled) {
        settled = true;
        try { ws.terminate(); } catch {}
        reject(new TransportError("WS 连接超时", { code: "WS_UNAVAILABLE" }));
      }
    }, WS_CONNECT_TIMEOUT_MS);

    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      try { ws.close(); } catch {}
      fn();
    };

    ws.on("open", () => {
      // Wait for the server's `ready` frame before sending the request.
    });

    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type === "ping") {
        try { ws.send(JSON.stringify({ type: "pong" })); } catch {}
        return;
      }
      if (msg.type === "pong") return;
      if (msg.type === "ready") {
        ready = true;
        clearTimeout(connectTimer);
        ws.send(JSON.stringify({ id: reqId, method, params }));
        return;
      }
      if (msg.id !== reqId) return;
      if (msg.type === "progress") {
        if (onProgress) onProgress(msg.data);
        return;
      }
      if (msg.type === "result") {
        finish(() => resolve(msg.data));
        return;
      }
      if (msg.type === "error") {
        const e = msg.error || {};
        finish(() => reject(new TransportError(e.message || "请求失败", { status: e.code })));
        return;
      }
      if (msg.type === "cancelled") {
        finish(() => reject(new TransportError("请求已取消", { code: "CANCELLED" })));
        return;
      }
    });

    ws.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      if (code === WS_AUTH_FAILED) {
        reject(new TransportError("token 无效或未配置", { code: "AUTH_FAILED", status: 401 }));
      } else {
        // Closed before delivering a result: treat as unavailable so auto-mode falls back.
        reject(new TransportError(`WS 连接关闭 (code=${code})`, { code: "WS_UNAVAILABLE" }));
      }
    });

    ws.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      reject(new TransportError(`WS 错误: ${e.message}`, { code: "WS_UNAVAILABLE" }));
    });
  });
}

// ---------------------------------------------------------------------------
// HTTP fallback transport
// ---------------------------------------------------------------------------

const NO_FALLBACK = new Set(["terminal.stream", "events.stream"]);

/** Map a WS method + params onto the legacy REST endpoint. */
function restRoute(method, params) {
  const p = { ...params };
  const take = (k) => {
    const v = p[k];
    delete p[k];
    return v;
  };
  switch (method) {
    case "terminal.create": return { verb: "POST", path: `/api/agent/terminals`, body: p };
    case "terminal.list": return { verb: "GET", path: `/api/agent/terminals` };
    case "terminal.get": return { verb: "GET", path: `/api/agent/terminals/${take("terminal_id")}` };
    case "terminal.delete": return { verb: "DELETE", path: `/api/agent/terminals/${take("terminal_id")}` };
    case "terminal.snapshot": return { verb: "GET", path: `/api/agent/terminals/${take("terminal_id")}/snapshot`, query: p };
    case "terminal.input": return { verb: "POST", path: `/api/agent/terminals/${take("terminal_id")}/input`, body: p };
    case "terminal.exec": return { verb: "POST", path: `/api/agent/terminals/${take("terminal_id")}/exec`, body: p };
    case "ssh.connections.list": return { verb: "GET", path: `/api/agent/ssh/connections` };
    case "ssh.connections.create": return { verb: "POST", path: `/api/agent/ssh/connections`, body: p };
    case "ssh.connections.get": return { verb: "GET", path: `/api/agent/ssh/connections/${take("conn_id")}`, query: p };
    case "ssh.connections.update": return { verb: "PUT", path: `/api/agent/ssh/connections/${take("conn_id")}`, body: p };
    case "ssh.connections.delete": return { verb: "DELETE", path: `/api/agent/ssh/connections/${take("conn_id")}` };
    case "ssh.import_electerm": return { verb: "POST", path: `/api/agent/ssh/import/electerm`, body: p };
    case "ssh.run": return { verb: "POST", path: `/api/agent/ssh/${take("conn_id")}/run`, body: p };
    case "ssh.run_async": return { verb: "POST", path: `/api/agent/ssh/${take("conn_id")}/run_async`, body: p };
    case "job.list": return { verb: "GET", path: `/api/agent/jobs` };
    case "job.get": return { verb: "GET", path: `/api/agent/jobs/${take("job_id")}` };
    case "job.cancel": return { verb: "DELETE", path: `/api/agent/jobs/${take("job_id")}` };
    case "events.recent": return { verb: "GET", path: `/api/agent/events/recent`, query: p };
    case "ssh.files.list": return { verb: "GET", path: `/api/agent/ssh/${take("conn_id")}/files`, query: p };
    case "ssh.files.read": return { verb: "GET", path: `/api/agent/ssh/${take("conn_id")}/files/content`, query: p };
    case "ssh.files.write": return { verb: "PUT", path: `/api/agent/ssh/${take("conn_id")}/files/content`, body: p };
    case "ssh.upload": return { verb: "POST", path: `/api/agent/ssh/${take("conn_id")}/upload`, body: p };
    case "ssh.download": return { verb: "POST", path: `/api/agent/ssh/${take("conn_id")}/download`, body: p };
    case "ssh.mkdir": return { verb: "POST", path: `/api/agent/ssh/${take("conn_id")}/directories`, body: p };
    case "ssh.delete_paths": return { verb: "DELETE", path: `/api/agent/ssh/${take("conn_id")}/paths`, body: p };
    default: return null;
  }
}

async function httpCall(method, params, config) {
  if (NO_FALLBACK.has(method)) {
    throw new TransportError(
      `方法 ${method} 仅支持 WebSocket；HTTP 兜底请改用轮询 (terminal.snapshot / events.recent)`,
      { code: "NO_HTTP_FALLBACK" }
    );
  }
  const route = restRoute(method, params);
  if (!route) {
    throw new TransportError(`HTTP 兜底不支持的方法: ${method}`, { code: "NO_HTTP_FALLBACK" });
  }

  let url = config.baseUrl + route.path;
  if (route.query && Object.keys(route.query).length) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(route.query)) {
      if (v !== undefined && v !== null) qs.append(k, String(v));
    }
    const s = qs.toString();
    if (s) url += `?${s}`;
  }

  const headers = { Authorization: `Bearer ${config.token}` };
  const init = { method: route.verb, headers };
  if (route.body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(route.body);
  }

  let res;
  try {
    res = await fetch(url, init);
  } catch (e) {
    throw new TransportError(`HTTP 请求失败: ${e.message}`, { code: "HTTP_ERROR" });
  }

  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const detail = (data && data.detail) || res.statusText;
    throw new TransportError(typeof detail === "string" ? detail : JSON.stringify(detail), {
      status: res.status,
      code: "HTTP_STATUS",
    });
  }
  return data;
}
