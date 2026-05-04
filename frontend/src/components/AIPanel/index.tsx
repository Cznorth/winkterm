"use client";

import { useState, useRef, useEffect } from "react";
import { useChatWs, ChatMessage, ChatMode, ToolCall } from "@/lib/chatWs";
import axios from "@/lib/axios";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import "./AIPanel.css";

interface ModelInfo {
  id: string;
  name: string;
}

function formatTokens(n: number): string {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
  if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1) + "K";
  return String(n);
}

function ContextMeter({ inputTokens, outputTokens, maxContext }: { inputTokens: number; outputTokens: number; maxContext: number }) {
  const total = inputTokens + outputTokens;
  const pct = Math.min(total / maxContext, 1);
  const circumference = 2 * Math.PI * 8;
  const offset = circumference * (1 - pct);
  const color = pct > 0.85 ? "var(--error)" : pct > 0.70 ? "var(--warning)" : "var(--success)";

  return (
    <div className="ctx-meter">
      <svg viewBox="0 0 22 22" className="ctx-meter-ring">
        <circle cx="11" cy="11" r="8" className="ctx-meter-track" />
        <circle cx="11" cy="11" r="8" className="ctx-meter-fill" style={{ stroke: color, strokeDasharray: circumference, strokeDashoffset: offset }} />
      </svg>
      <div className="ctx-meter-tooltip">
        <div className="ctx-meter-tooltip-title">Context Window</div>
        <div className="ctx-meter-tooltip-row">
          <span>Input</span><span className="ctx-meter-tooltip-val">{formatTokens(inputTokens)}</span>
        </div>
        <div className="ctx-meter-tooltip-row">
          <span>Output</span><span className="ctx-meter-tooltip-val">{formatTokens(outputTokens)}</span>
        </div>
        <div className="ctx-meter-tooltip-divider" />
        <div className="ctx-meter-tooltip-row">
          <span>Total</span><span className="ctx-meter-tooltip-val">{formatTokens(total)} / {formatTokens(maxContext)}</span>
        </div>
      </div>
    </div>
  );
}
const MODE_ICONS: Record<ChatMode, JSX.Element> = {
  chat: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  ),
  craft: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="14" rx="2" />
      <path d="M3 8h18" />
      <path d="M7 3v5" />
    </svg>
  ),
};

const ToolIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
  </svg>
);

function ToolCallDisplay({ toolCall }: { toolCall: ToolCall }) {
  const [expanded, setExpanded] = useState(false);
  const argsStr = Object.keys(toolCall.args).length > 0
    ? JSON.stringify(toolCall.args, null, 2)
    : "";

  const firstArgValue = Object.values(toolCall.args)[0];
  const argPreview = typeof firstArgValue === "string"
    ? firstArgValue.length > 60 ? firstArgValue.slice(0, 60) + "..." : firstArgValue
    : argsStr.length > 60 ? argsStr.slice(0, 60) + "..." : argsStr;

  return (
    <div className={`tool-call ${expanded ? "expanded" : ""}`}>
      <div
        className="tool-call-header"
        onClick={() => toolCall.status === "done" && setExpanded(!expanded)}
      >
        <div className={`tool-call-status ${toolCall.status}`}>
          {toolCall.status === "done" ? "✓" : ""}
        </div>
        <span className="tool-call-icon"><ToolIcon /></span>
        <span className="tool-call-name">{toolCall.tool}</span>
        {argPreview && (
          <span className="tool-call-preview">{argPreview}</span>
        )}
        {toolCall.status === "done" && toolCall.result && (
          <span className="tool-call-arrow">▼</span>
        )}
        {toolCall.status === "running" && (
          <span style={{ color: "var(--fg-muted)", fontSize: "11px", whiteSpace: "nowrap" }}>Running...</span>
        )}
      </div>

      {expanded && toolCall.status === "done" && (
        <div className="tool-call-content">
          {argsStr && (
            <div className="tool-call-section">
              <div className="tool-call-label">Args</div>
              <pre className="tool-call-code">{argsStr}</pre>
            </div>
          )}
          {toolCall.result && (
            <div className="tool-call-section">
              <div className="tool-call-label">Result</div>
              <pre className="tool-call-code">{toolCall.result}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function MessageBubble({ msg }: { msg: ChatMessage }) {
  const isUser = msg.role === "user";
  const [showThinking, setShowThinking] = useState(false);

  return (
    <div className={`ai-message ${msg.role}`}>
      <div className="ai-message-bubble">
        {msg.thinking && (
          <div className="ai-thinking-block">
            <div
              className="ai-thinking-header"
              onClick={() => setShowThinking(!showThinking)}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="14" height="14">
                <circle cx="12" cy="12" r="10" />
                <path d="M12 16v-4M12 8h.01" />
              </svg>
              <span>Thinking</span>
              <span className="ai-thinking-toggle">{showThinking ? "▲" : "▼"}</span>
            </div>
            {showThinking && (
              <div className="ai-thinking-content">{msg.thinking}</div>
            )}
          </div>
        )}
        {msg.toolCalls && msg.toolCalls.length > 0 && (
          <div style={{ marginBottom: msg.content ? "12px" : 0 }}>
            {msg.toolCalls.map((tc) => (
              <ToolCallDisplay key={tc.id} toolCall={tc} />
            ))}
          </div>
        )}
        {isUser ? (
          msg.content
        ) : msg.content ? (
          <div className="md-content">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {msg.content}
            </ReactMarkdown>
          </div>
        ) : null}
      </div>
    </div>
  );
}

const MODE_INFO: Record<ChatMode, { label: string; desc: string }> = {
  chat: { label: "Chat", desc: "General assistant for questions and advice" },
  craft: { label: "Craft", desc: "Code writer with terminal access" },
};

export default function AIPanel() {
  const { messages, isStreaming, isConnected, error, mode, model, inputTokens, outputTokens, maxContext, sendMessage, stopGeneration, clearMessages, switchMode, switchModel, reconnect } = useChatWs();
  const [input, setInput] = useState("");
  const [modeDropdownOpen, setModeDropdownOpen] = useState(false);
  const [modelDropdownOpen, setModelDropdownOpen] = useState(false);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const modeDropdownRef = useRef<HTMLDivElement>(null);
  const modelDropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    axios.get("/api/settings").then((res) => {
      setModels(res.data.models || []);
    });
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (modeDropdownRef.current && !modeDropdownRef.current.contains(e.target as Node)) {
        setModeDropdownOpen(false);
      }
      if (modelDropdownRef.current && !modelDropdownRef.current.contains(e.target as Node)) {
        setModelDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (input.trim() && !isStreaming) {
      sendMessage(input.trim());
      setInput("");
    }
  };

  const handleModeSelect = (m: ChatMode) => {
    switchMode(m);
    setModeDropdownOpen(false);
  };

  const handleModelSelect = (m: string) => {
    switchModel(m);
    setModelDropdownOpen(false);
  };

  const modeInfo = MODE_INFO[mode];
  const currentModelName = model ? (models.find(m => m.id === model)?.name || model) : null;

  return (
    <div className="ai-panel">
      <div className="ai-header">
        <div className="ai-header-left">
          <span className="ai-header-icon">{MODE_ICONS[mode]}</span>
          <span className="ai-header-title">{modeInfo.label}</span>
        </div>
        <div className="ai-header-actions">
          <div className="ai-status">
            <span className={`ai-status-dot ${isConnected ? "" : "disconnected"}`} />
            {isConnected ? "Connected" : "Disconnected"}
          </div>
          <button className="ai-clear-btn" onClick={clearMessages}>
            Clear
          </button>
        </div>
      </div>

      <div className="ai-messages">
        {messages.length === 0 && (
          <div className="ai-empty">
            <div className="ai-empty-icon">{MODE_ICONS[mode]}</div>
            <div className="ai-empty-title">{modeInfo.label} Mode</div>
            <div className="ai-empty-desc">{modeInfo.desc}</div>
          </div>
        )}
        {messages.map((msg) => (
          <MessageBubble key={msg.id} msg={msg} />
        ))}
        {isStreaming && (
          <div className="ai-thinking">
            <div className="ai-thinking-dots">
              <span /><span /><span />
            </div>
            Thinking...
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {error && (
        <div className="ai-error">
          <span>{error}</span>
          <button className="ai-error-retry" onClick={reconnect}>
            Reconnect
          </button>
        </div>
      )}

      <div className="ai-input-area">
        <form className="ai-input-form" onSubmit={handleSubmit}>
          <textarea
            className="ai-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSubmit(e);
              }
            }}
            placeholder={isConnected ? "Ask anything... (Enter to send, Shift+Enter for new line)" : "Waiting for connection..."}
            disabled={!isConnected || isStreaming}
            rows={2}
          />
          {isStreaming ? (
            <button
              type="button"
              className="ai-stop-btn"
              onClick={stopGeneration}
            >
              <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14">
                <rect x="6" y="6" width="12" height="12" rx="2" />
              </svg>
              Stop
            </button>
          ) : (
            <button
              type="submit"
              className="ai-send-btn"
              disabled={!isConnected || !input.trim()}
            >
              Send
            </button>
          )}
        </form>
      </div>

      <div className="ai-toolbar">
        <div className="ai-mode-selector" ref={modeDropdownRef}>
          {modeDropdownOpen && isConnected && (
            <div className="ai-mode-dropdown">
              {(Object.keys(MODE_INFO) as ChatMode[]).map((m) => (
                <div
                  key={m}
                  className={`ai-mode-option ${m === mode ? "active" : ""}`}
                  onClick={() => handleModeSelect(m)}
                >
                  <div className="ai-mode-option-left">
                    {MODE_ICONS[m]}
                    <span className="ai-mode-option-name">{MODE_INFO[m].label}</span>
                  </div>
                  {m === mode && <span className="ai-mode-check">✓</span>}
                </div>
              ))}
            </div>
          )}
          <button
            className="ai-mode-btn"
            onClick={() => isConnected && setModeDropdownOpen(!modeDropdownOpen)}
            disabled={!isConnected}
          >
            {MODE_ICONS[mode]}
            <span className="ai-mode-btn-text">{modeInfo.label}</span>
            <span className="ai-mode-arrow">▼</span>
          </button>
        </div>

        <div className="ai-toolbar-divider" />

        <div className="ai-mode-selector" ref={modelDropdownRef}>
          {modelDropdownOpen && isConnected && models.length > 0 && (
            <div className="ai-mode-dropdown">
              {models.map((m) => (
                <div
                  key={m.id}
                  className={`ai-mode-option ${m.id === model ? "active" : ""}`}
                  onClick={() => handleModelSelect(m.id)}
                >
                  <span className="ai-mode-option-name">{m.name || m.id}</span>
                  {m.id === model && <span className="ai-mode-check">✓</span>}
                </div>
              ))}
            </div>
          )}
          <button
            className="ai-mode-btn"
            onClick={() => isConnected && models.length > 0 && setModelDropdownOpen(!modelDropdownOpen)}
            disabled={!isConnected || models.length === 0}
            title={model || "Select model"}
          >
            <span className="ai-mode-btn-text">
              {currentModelName || "Select model"}
            </span>
            <span className="ai-mode-arrow">▼</span>
          </button>
        </div>

        <div style={{ marginLeft: "auto" }}>
          <ContextMeter inputTokens={inputTokens} outputTokens={outputTokens} maxContext={maxContext} />
        </div>
      </div>
    </div>
  );
}
