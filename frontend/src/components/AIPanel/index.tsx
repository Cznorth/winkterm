"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { useChatWs, ChatMessage, ChatMode, ToolCall, ContentBlock, Conversation } from "@/lib/chatWs";
import axios from "@/lib/axios";
import { useI18n } from "@/lib/i18n";
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

const CTX_CATEGORIES = [
  { key: "input", label: "Input tokens", color: "#6b7280" },
  { key: "output", label: "Output tokens", color: "#a78bfa" },
] as const;

function ContextMeter({ inputTokens, outputTokens, maxContext }: { inputTokens: number; outputTokens: number; maxContext: number }) {
  const [open, setOpen] = useState(false);
  const popupRef = useRef<HTMLDivElement>(null);
  const total = inputTokens + outputTokens;
  const pct = Math.min(total / maxContext, 1);
  const pctDisplay = Math.round(pct * 100);
  const circumference = 2 * Math.PI * 8;
  const offset = circumference * (1 - pct);
  const color = pct > 0.85 ? "var(--error)" : pct > 0.70 ? "var(--warning)" : "var(--success)";

  const segments = [
    { value: inputTokens, color: "#6b7280" },
    { value: outputTokens, color: "#a78bfa" },
  ];

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (popupRef.current && !popupRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  return (
    <div className="ctx-meter" ref={popupRef}>
      <svg viewBox="0 0 22 22" className="ctx-meter-ring" onClick={() => setOpen(!open)}>
        <circle cx="11" cy="11" r="8" className="ctx-meter-track" />
        <circle cx="11" cy="11" r="8" className="ctx-meter-fill" style={{ stroke: color, strokeDasharray: circumference, strokeDashoffset: offset }} />
      </svg>
      {open && (
        <div className="ctx-popup">
          <div className="ctx-popup-header">
            <span className="ctx-popup-title">Context</span>
            <button className="ctx-popup-close" onClick={() => setOpen(false)}>✕</button>
          </div>
          <div className="ctx-popup-summary">
            <span>{pctDisplay}% Full</span>
            <span>~{formatTokens(total)} / {formatTokens(maxContext)} Tokens</span>
          </div>
          <div className="ctx-popup-bar">
            {segments.map((seg, i) => {
              const w = maxContext > 0 ? (seg.value / maxContext) * 100 : 0;
              return w > 0 ? <div key={i} className="ctx-popup-bar-seg" style={{ width: `${w}%`, background: seg.color }} /> : null;
            })}
          </div>
          <div className="ctx-popup-list">
            {CTX_CATEGORIES.map((cat) => {
              const val = cat.key === "input" ? inputTokens : outputTokens;
              return (
                <div key={cat.key} className="ctx-popup-row">
                  <span className="ctx-popup-dot" style={{ background: cat.color }} />
                  <span className="ctx-popup-label">{cat.label}</span>
                  <span className="ctx-popup-val">{formatTokens(val)}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
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
  ask: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  ),
};

const ToolIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
  </svg>
);

function ToolCallDisplay({ toolCall }: { toolCall: ToolCall }) {
  const { t } = useI18n();
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
          <span style={{ color: "var(--fg-muted)", fontSize: "11px", whiteSpace: "nowrap" }}>{t("ai.running")}</span>
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
  const { t } = useI18n();
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
              <span>{t("ai.thinking")}</span>
              <span className="ai-thinking-toggle">{showThinking ? "▲" : "▼"}</span>
            </div>
            {showThinking && (
              <div className="ai-thinking-content">{msg.thinking}</div>
            )}
          </div>
        )}
        {isUser ? (
          msg.content
        ) : msg.contentBlocks && msg.contentBlocks.length > 0 ? (
          msg.contentBlocks.map((block: ContentBlock, i: number) =>
            block.type === "tool" ? (
              <ToolCallDisplay key={block.toolCall.id} toolCall={block.toolCall} />
            ) : block.text ? (
              <div key={i} className="md-content">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{block.text}</ReactMarkdown>
              </div>
            ) : null
          )
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

const MODE_KEYS: Record<ChatMode, { label: "ai.chatLabel" | "ai.craftLabel" | "ai.askLabel"; desc: "ai.chatDesc" | "ai.craftDesc" | "ai.askDesc" }> = {
  chat: { label: "ai.chatLabel", desc: "ai.chatDesc" },
  craft: { label: "ai.craftLabel", desc: "ai.craftDesc" },
  ask: { label: "ai.askLabel", desc: "ai.askDesc" },
};

function ConvTabs({
  conversations,
  activeConvId,
  onSwitch,
  onNew,
  onDelete,
  onRegenerateTitle,
}: {
  conversations: Conversation[];
  activeConvId: string;
  onSwitch: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  onRegenerateTitle: (id: string) => void;
}) {
  const { t } = useI18n();
  const listRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const updateScrollState = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    setCanScrollLeft(el.scrollLeft > 0);
    setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
  }, []);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    updateScrollState();
    el.addEventListener("scroll", updateScrollState);
    const ro = new ResizeObserver(updateScrollState);
    ro.observe(el);
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY === 0) return;
      e.preventDefault();
      el.scrollBy({ left: e.deltaY, behavior: "auto" });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("scroll", updateScrollState);
      el.removeEventListener("wheel", onWheel);
      ro.disconnect();
    };
  }, [conversations, updateScrollState]);

  // Scroll active tab into view when active conv changes
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const active = el.querySelector(".ai-tab.active") as HTMLElement | null;
    active?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeConvId]);

  const scroll = (dir: "left" | "right") => {
    listRef.current?.scrollBy({ left: dir === "left" ? -120 : 120, behavior: "smooth" });
  };

  /** Middle-click close (same as terminal tab bar) */
  const handleTabMouseDown = (e: React.MouseEvent, convId: string) => {
    if (e.button !== 1 || conversations.length <= 1) return;
    e.preventDefault();
    e.stopPropagation();
    onDelete(convId);
  };

  return (
    <div className="ai-tabs">
      {canScrollLeft && (
        <button className="ai-tabs-scroll-btn" onClick={() => scroll("left")}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="10" height="10">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
      )}
      <div className="ai-tabs-list" ref={listRef}>
        {conversations.map((conv, i) => (
          <div
            key={conv.id}
            className={`ai-tab ${conv.id === activeConvId ? "active" : ""}`}
            onClick={() => onSwitch(conv.id)}
            onMouseDown={(e) => handleTabMouseDown(e, conv.id)}
            title={conv.title || `${t("ai.conversation")} ${i + 1}`}
          >
            <span className="ai-tab-title">
              {conv.title || `${t("ai.conversation")} ${i + 1}`}
            </span>
            {conv.messages.length > 0 && (
              <button
                className="ai-tab-regen"
                title={t("ai.regenerateTitle")}
                onClick={(e) => {
                  e.stopPropagation();
                  onRegenerateTitle(conv.id);
                }}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="11" height="11">
                  <path d="m3 21 9-9" />
                  <path d="M15 4V2" />
                  <path d="M15 16v-2" />
                  <path d="M8 9h2" />
                  <path d="M20 9h2" />
                  <path d="M17.8 11.8 19 13" />
                  <path d="M15 9h.01" />
                  <path d="M17.8 6.2 19 5" />
                  <path d="M12.2 6.2 11 5" />
                </svg>
              </button>
            )}
            {conversations.length > 1 && (
              <button
                className="ai-tab-close"
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(conv.id);
                }}
              >
                ×
              </button>
            )}
          </div>
        ))}
      </div>
      {canScrollRight && (
        <button className="ai-tabs-scroll-btn" onClick={() => scroll("right")}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="10" height="10">
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </button>
      )}
      <button className="ai-tab-new" onClick={onNew} title={t("ai.newConversation")}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="12" height="12">
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
      </button>
    </div>
  );
}

export default function AIPanel({ onClose }: { onClose?: () => void }) {
  const { t } = useI18n();
  const { conversations, activeConvId, messages, isStreaming, isConnected, error, mode, model, inputTokens, outputTokens, maxContext, messageQueue, pendingApproval, sendMessage, stopGeneration, sendToolDecision, interruptAndSend, removeFromQueue, newConversation, switchConversation, deleteConversation, updateConvTitle, switchMode, switchModel, reconnect } = useChatWs();
  const [input, setInput] = useState("");
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [modeDropdownOpen, setModeDropdownOpen] = useState(false);
  const [modelDropdownOpen, setModelDropdownOpen] = useState(false);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const modeDropdownRef = useRef<HTMLDivElement>(null);
  const modelDropdownRef = useRef<HTMLDivElement>(null);

  const fetchModels = useCallback(() => {
    axios.get("/api/settings").then((res) => {
      setModels(res.data.models || []);
      if (!model && res.data.selected_model) {
        switchModel(res.data.selected_model);
      }
    }).catch(() => {});
  }, [model, switchModel]);

  useEffect(() => {
    fetchModels();
  }, [fetchModels]);

  // Re-fetch models when panel gains focus (e.g. after settings change)
  useEffect(() => {
    const onFocus = () => fetchModels();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [fetchModels]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const prevIsStreamingRef = useRef(false);
  useEffect(() => {
    const wasStreaming = prevIsStreamingRef.current;
    prevIsStreamingRef.current = isStreaming;
    if (wasStreaming && !isStreaming && messages.length > 0) {
      // Streaming just finished — fetch follow-up suggestions
      const payload = messages.slice(-6).map((m) => ({
        role: m.role,
        content: typeof m.content === "string" ? m.content : "",
      }));
      axios.post("/api/chat/suggestions", { messages: payload })
        .then((res) => setSuggestions(res.data.suggestions || []))
        .catch(() => setSuggestions([]));
    }
    if (isStreaming) {
      setSuggestions([]);
    }
  }, [isStreaming, messages]);

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
    const text = input.trim();
    if (!text) return;

    const activeConv = conversations.find((c) => c.id === activeConvId);
    const isFirstMessage = activeConv?.messages.length === 0;
    const convId = activeConvId;

    sendMessage(text);
    setInput("");
    setSuggestions([]);

    if (isFirstMessage) {
      axios.post("/api/chat/title", { messages: [{ role: "user", content: text }] })
        .then((res) => {
          if (res.data.title) updateConvTitle(convId, res.data.title);
        })
        .catch(() => {});
    }
  };

  const handleRegenerateTitle = useCallback((convId: string) => {
    const conv = conversations.find((c) => c.id === convId);
    if (!conv || conv.messages.length === 0) return;
    const payload = conv.messages.slice(0, 8).map((m) => ({
      role: m.role,
      content: typeof m.content === "string" ? m.content : "",
    }));
    axios.post("/api/chat/title", { messages: payload })
      .then((res) => {
        if (res.data.title) updateConvTitle(convId, res.data.title);
      })
      .catch(() => {});
  }, [conversations, updateConvTitle]);

  const handleModeSelect = (m: ChatMode) => {
    switchMode(m);
    setModeDropdownOpen(false);
  };

  const handleModelSelect = (m: string) => {
    switchModel(m);
    setModelDropdownOpen(false);
  };

  const modeKeys = MODE_KEYS[mode];
  const currentModelName = model ? (models.find(m => m.id === model)?.name || model) : null;

  return (
    <div className="ai-panel">
      <div className="ai-header">
        <div className="ai-header-left">
          <span className="ai-header-icon">{MODE_ICONS[mode]}</span>
          <span className="ai-header-title">{t(modeKeys.label)}</span>
        </div>
        <div className="ai-header-actions">
          <div className="ai-status">
            <span className={`ai-status-dot ${isConnected ? "" : "disconnected"}`} />
            {isConnected ? t("ai.connected") : t("ai.disconnected")}
          </div>
          {onClose && (
            <>
              <button
                type="button"
                className="ai-header-icon-btn"
                onClick={newConversation}
                aria-label={t("ai.newConversation")}
                title={t("ai.newConversation")}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
              </button>
              <button
                type="button"
                className="ai-header-icon-btn ai-header-close"
                onClick={onClose}
                aria-label={t("layout.closeAiPanel")}
              >
                ✕
              </button>
            </>
          )}
        </div>
      </div>

      <ConvTabs
        conversations={conversations}
        activeConvId={activeConvId}
        onSwitch={switchConversation}
        onNew={newConversation}
        onDelete={deleteConversation}
        onRegenerateTitle={handleRegenerateTitle}
      />

      <div className="ai-messages">
        {messages.length === 0 && (
          <div className="ai-empty">
            <div className="ai-empty-icon">{MODE_ICONS[mode]}</div>
            <div className="ai-empty-title">{mode === "chat" ? t("ai.chatMode") : mode === "ask" ? t("ai.askMode") : t("ai.craftMode")}</div>
            <div className="ai-empty-desc">{t(modeKeys.desc)}</div>
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
            {t("ai.thinking")}...
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {messageQueue.length > 0 && (
        <div className="ai-queue">
          {messageQueue.map((msg, i) => (
            <div key={i} className="ai-queue-item">
              <span className="ai-queue-index">{i + 1}</span>
              <span className="ai-queue-text">{msg}</span>
              <button
                className="ai-queue-interrupt"
                title={t("ai.queue.interrupt")}
                onClick={() => interruptAndSend(msg)}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" width="12" height="12">
                  <polyline points="9 18 15 12 9 6" />
                </svg>
              </button>
              <button
                className="ai-queue-remove"
                title={t("ai.queue.remove")}
                onClick={() => removeFromQueue(i)}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" width="10" height="10">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
          ))}
        </div>
      )}

      {suggestions.length > 0 && !isStreaming && (
        <div className="ai-suggestions">
          {suggestions.map((s, i) => (
            <button
              key={i}
              className="ai-suggestion-chip"
              onClick={() => {
                sendMessage(s);
                setSuggestions([]);
              }}
            >
              {s}
            </button>
          ))}
        </div>
      )}

      {pendingApproval && (
        <div className="ai-approval">
          <div className="ai-approval-header">
            <span className="ai-approval-icon"><ToolIcon /></span>
            <span className="ai-approval-title">{t("ai.approval.title")}</span>
          </div>
          <div className="ai-approval-tool">{pendingApproval.tool}</div>
          {Object.keys(pendingApproval.args).length > 0 && (
            <pre className="ai-approval-args">{JSON.stringify(pendingApproval.args, null, 2)}</pre>
          )}
          <div className="ai-approval-actions">
            <button
              className="ai-approval-deny"
              onClick={() => sendToolDecision(pendingApproval.approvalId, false)}
            >
              {t("ai.approval.deny")}
            </button>
            <button
              className="ai-approval-approve"
              onClick={() => sendToolDecision(pendingApproval.approvalId, true)}
            >
              {t("ai.approval.approve")}
            </button>
          </div>
        </div>
      )}

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
            placeholder={isConnected ? t("ai.placeholder") : t("ai.waitingConnection")}
            disabled={!isConnected}
            rows={1}
          />
        </form>

        <div className="ai-toolbar">
        <div className="ai-mode-selector" ref={modeDropdownRef}>
          {modeDropdownOpen && isConnected && (
            <div className="ai-mode-dropdown">
              {(Object.keys(MODE_KEYS) as ChatMode[]).map((m) => (
                <div
                  key={m}
                  className={`ai-mode-option ${m === mode ? "active" : ""}`}
                  onClick={() => handleModeSelect(m)}
                >
                  <div className="ai-mode-option-left">
                    {MODE_ICONS[m]}
                    <span className="ai-mode-option-name">{t(MODE_KEYS[m].label)}</span>
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
            <span className="ai-mode-btn-text">{t(modeKeys.label)}</span>
            <span className="ai-mode-arrow">▼</span>
          </button>
        </div>

        <div className="ai-toolbar-divider" />

        <div className="ai-mode-selector" ref={modelDropdownRef}>
          {modelDropdownOpen && models.length > 0 && (
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
            onClick={() => models.length > 0 && setModelDropdownOpen(!modelDropdownOpen)}
            disabled={models.length === 0}
            title={model || "Select model"}
          >
            <span className="ai-mode-btn-text">
              {currentModelName || "Select model"}
            </span>
            <span className="ai-mode-arrow">▼</span>
          </button>
        </div>

        <div className="ai-toolbar-right">
          <ContextMeter inputTokens={inputTokens} outputTokens={outputTokens} maxContext={maxContext} />
          {isStreaming ? (
            <button
              type="button"
              className="ai-stop-btn"
              onClick={stopGeneration}
            >
              <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14">
                <rect x="6" y="6" width="12" height="12" rx="2" />
              </svg>
              {t("ai.stop")}
            </button>
          ) : (
            <button
              type="button"
              className="ai-send-btn"
              disabled={!isConnected || !input.trim() || isStreaming}
              onClick={handleSubmit}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
                <line x1="22" y1="2" x2="11" y2="13" />
                <polygon points="22 2 15 22 11 13 2 9 22 2" />
              </svg>
            </button>
          )}
        </div>
      </div>
      </div>
    </div>
  );
}
