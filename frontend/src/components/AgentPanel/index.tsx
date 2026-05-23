"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { getApiBaseUrl } from "@/lib/config";
import { getAccessKey } from "@/lib/auth";
import "./AgentPanel.css";

interface TerminalInfo {
  id: string;
  type: string;
  connection_id: string | null;
  title: string;
  name: string;
  cwd: string | null;
  cols: number;
  rows: number;
  alive: boolean;
  created_at: string;
  size: number;
  idle_seconds: number;
  ttl_seconds: number;
}

interface AgentEvent {
  id: number;
  ts: number;
  action: string;
  [key: string]: unknown;
}

function formatTime(ts: number): string {
  const d = new Date(ts * 1000);
  return d.toLocaleTimeString();
}

function summarizeEvent(ev: AgentEvent): string {
  const parts: string[] = [];
  switch (ev.action) {
    case "terminal_create":
      parts.push(`create ${(ev.terminal_type as string) || "?"} terminal`);
      if (ev.name) parts.push(`name=${ev.name}`);
      if (ev.title) parts.push(`title="${ev.title}"`);
      break;
    case "terminal_close":
      parts.push(`close terminal`);
      break;
    case "terminal_input":
      parts.push("input");
      if (ev.keys) parts.push(`keys=${JSON.stringify(ev.keys)}`);
      if (ev.data) parts.push(`data="${ev.data}"`);
      if (ev.reason) parts.push(`reason=${ev.reason}`);
      break;
    case "terminal_exec":
      parts.push(`exec exit=${ev.exit_code ?? "?"}`);
      if (ev.command) parts.push(`cmd="${ev.command}"`);
      break;
    case "ssh_run_start":
      parts.push(`ssh.run start`);
      if (ev.command) parts.push(`cmd="${ev.command}"`);
      break;
    case "ssh_run_done":
      parts.push(`ssh.run done exit=${ev.exit_code ?? "?"}`);
      break;
    case "ssh_file_write":
      parts.push(`ssh write ${ev.path} (${ev.bytes}B)`);
      break;
    case "ssh_file_upload":
      parts.push(`ssh upload ${ev.remote_path}`);
      break;
    case "ssh_file_download":
      parts.push(`ssh download ${ev.remote_path}`);
      break;
    case "ssh_paths_delete":
      parts.push(`ssh delete ${(ev.paths as string[]).join(", ")}`);
      break;
    default:
      parts.push(ev.action);
  }
  if (ev.terminal_id) parts.push(`[${(ev.terminal_id as string).slice(0, 8)}]`);
  return parts.join(" · ");
}

export default function AgentPanel() {
  const [token, setToken] = useState<string | null>(null);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [terminals, setTerminals] = useState<TerminalInfo[]>([]);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [output, setOutput] = useState<string>("");
  const [outputSize, setOutputSize] = useState<number>(0);
  const outputRef = useRef<HTMLPreElement>(null);
  const baseUrl = useMemo(() => getApiBaseUrl(), []);

  // 1) 取 token（远程访问时附带 web 鉴权 key）
  useEffect(() => {
    const accessKey = getAccessKey();
    const headers: Record<string, string> = {};
    if (accessKey) headers["X-Access-Key"] = accessKey;
    fetch(`${baseUrl}/api/agent/handshake`, { headers })
      .then((r) => {
        if (!r.ok) throw new Error(`handshake 失败: ${r.status}`);
        return r.json();
      })
      .then((d) => setToken(d.token))
      .catch((e) => setTokenError(String(e)));
  }, [baseUrl]);

  // 2) 拉终端列表（每 3s 刷新）
  useEffect(() => {
    if (!token) return;
    let stopped = false;
    const fetchList = async () => {
      try {
        const r = await fetch(`${baseUrl}/api/agent/terminals`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!r.ok) return;
        const d = await r.json();
        if (!stopped) setTerminals(d.terminals || []);
      } catch {
        /* ignore */
      }
    };
    fetchList();
    const id = setInterval(fetchList, 3000);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, [baseUrl, token]);

  // 3) 订阅事件流
  useEffect(() => {
    if (!token) return;
    const url = `${baseUrl}/api/agent/events/stream?since_id=0&token=${encodeURIComponent(token)}`;
    const es = new EventSource(url);
    es.addEventListener("agent_event", (ev) => {
      try {
        const data = JSON.parse((ev as MessageEvent).data);
        setEvents((prev) => {
          const next = [...prev, data];
          return next.length > 300 ? next.slice(-300) : next;
        });
      } catch {
        /* ignore */
      }
    });
    es.addEventListener("heartbeat", () => {});
    es.onerror = () => {
      // 连接失败，由浏览器自动重连
    };
    return () => es.close();
  }, [baseUrl, token]);

  // 4) 订阅选中终端的输出流
  useEffect(() => {
    if (!token || !selectedId) {
      setOutput("");
      setOutputSize(0);
      return;
    }
    setOutput("");
    setOutputSize(0);
    const url = `${baseUrl}/api/agent/terminals/${selectedId}/stream?since=0&token=${encodeURIComponent(token)}`;
    const es = new EventSource(url);
    es.addEventListener("output", (ev) => {
      try {
        const d = JSON.parse((ev as MessageEvent).data);
        setOutput((prev) => {
          const next = prev + (d.text || "");
          // 限制最多保留 200KB 防止页面卡顿
          return next.length > 200_000 ? next.slice(-200_000) : next;
        });
        setOutputSize(d.size || 0);
      } catch {
        /* ignore */
      }
    });
    es.addEventListener("end", () => es.close());
    return () => es.close();
  }, [baseUrl, token, selectedId]);

  // 自动滚动到底部
  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [output]);

  if (tokenError) {
    return (
      <div className="agent-panel">
        <div className="agent-error">
          <strong>无法连接 Agent API：</strong> {tokenError}
          <br />
          请确认设置页已配置 agent token，且当前以本机模式访问。
        </div>
      </div>
    );
  }

  if (!token) {
    return <div className="agent-panel"><div className="agent-loading">连接中…</div></div>;
  }

  return (
    <div className="agent-panel">
      <div className="agent-header">
        <h2>Agent 实时监控</h2>
        <div className="agent-stats">
          <span>{terminals.length} 终端</span>
          <span>·</span>
          <span>{events.length} 事件</span>
        </div>
      </div>

      <div className="agent-body">
        {/* 左：终端列表 */}
        <div className="agent-terminals">
          <div className="agent-section-title">Agent 终端</div>
          {terminals.length === 0 && <div className="agent-empty">无活跃终端</div>}
          {terminals.map((t) => (
            <div
              key={t.id}
              className={`agent-terminal-item ${selectedId === t.id ? "active" : ""} ${t.alive ? "" : "dead"}`}
              onClick={() => setSelectedId(t.id)}
            >
              <div className="agent-terminal-title">
                {t.name || t.title || t.id}
                {!t.alive && <span className="agent-dead-badge">×</span>}
              </div>
              <div className="agent-terminal-meta">
                <span className="agent-mono">{t.id.slice(0, 8)}</span>
                <span>·</span>
                <span>{t.type}</span>
                {t.cwd && <span className="agent-cwd">{t.cwd}</span>}
              </div>
              <div className="agent-terminal-meta">
                <span>idle {Math.round(t.idle_seconds)}s</span>
                <span>·</span>
                <span>{(t.size / 1024).toFixed(1)}KB</span>
              </div>
            </div>
          ))}
        </div>

        {/* 中：输出查看 */}
        <div className="agent-viewer">
          <div className="agent-section-title">
            终端输出
            {selectedId && (
              <span className="agent-mono"> · {selectedId.slice(0, 8)} ({(outputSize / 1024).toFixed(1)}KB)</span>
            )}
          </div>
          {selectedId ? (
            <pre ref={outputRef} className="agent-output">{output}</pre>
          ) : (
            <div className="agent-empty">点左侧终端查看实时输出</div>
          )}
        </div>

        {/* 右：事件流 */}
        <div className="agent-events">
          <div className="agent-section-title">操作事件流</div>
          <div className="agent-event-list">
            {events.length === 0 && <div className="agent-empty">暂无事件</div>}
            {events.slice().reverse().map((ev) => (
              <div key={ev.id} className={`agent-event-item action-${ev.action}`}>
                <span className="agent-event-time">{formatTime(ev.ts)}</span>
                <span className="agent-event-summary">{summarizeEvent(ev)}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
