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

// 模式图标 (SVG)
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

function ToolCallDisplay({ toolCall }: { toolCall: ToolCall }) {
  const [expanded, setExpanded] = useState(false);
  const argsStr = Object.keys(toolCall.args).length > 0
    ? JSON.stringify(toolCall.args, null, 2)
    : "";

  // 提取第一个参数值作为简要展示
  const firstArgValue = Object.values(toolCall.args)[0];
  const argPreview = typeof firstArgValue === "string"
    ? firstArgValue.length > 50 ? firstArgValue.slice(0, 50) + "..." : firstArgValue
    : argsStr.length > 50 ? argsStr.slice(0, 50) + "..." : argsStr;

  return (
    <div className={`tool-call ${expanded ? "expanded" : ""}`}>
      <div
        className="tool-call-header"
        onClick={() => toolCall.status === "done" && setExpanded(!expanded)}
      >
        <div className={`tool-call-status ${toolCall.status}`}>
          {toolCall.status === "running" ? "⏳" : "✓"}
        </div>
        <span className="tool-call-name">{toolCall.tool}</span>
        {argPreview && (
          <span className="tool-call-preview">{argPreview}</span>
        )}
        {toolCall.status === "done" && toolCall.result && (
          <span className="tool-call-arrow">▼</span>
        )}
        {toolCall.status === "running" && (
          <span style={{ color: "var(--fg-muted)", fontSize: "11px" }}>执行中...</span>
        )}
      </div>

      {expanded && toolCall.status === "done" && (
        <div className="tool-call-content">
          {argsStr && (
            <div className="tool-call-section">
              <div className="tool-call-label">参数</div>
              <pre className="tool-call-code">{argsStr}</pre>
            </div>
          )}
          {toolCall.result && (
            <div className="tool-call-section">
              <div className="tool-call-label">结果</div>
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

  return (
    <div className={`ai-message ${msg.role}`}>
      <div className="ai-message-bubble">
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
  chat: { label: "Chat", desc: "对话助手，回答问题、提供建议" },
  craft: { label: "Craft", desc: "创作助手，编写代码、生成配置" },
};

export default function AIPanel() {
  const { messages, isStreaming, isConnected, error, mode, model, sendMessage, clearMessages, switchMode, switchModel, reconnect } = useChatWs();
  const [input, setInput] = useState("");
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [modelDropdownOpen, setModelDropdownOpen] = useState(false);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const modelDropdownRef = useRef<HTMLDivElement>(null);

  // 加载模型列表
  useEffect(() => {
    axios.get("/api/settings").then((res) => {
      setModels(res.data.models || []);
    });
  }, []);

  // 自动滚动到底部
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // 点击外部关闭下拉菜单
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
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
    setDropdownOpen(false);
  };

  const handleModelSelect = (m: string) => {
    switchModel(m);
    setModelDropdownOpen(false);
  };

  const modeInfo = MODE_INFO[mode];

  return (
    <div className="ai-panel">
      {/* 标题栏 */}
      <div className="ai-header">
        <span className="ai-header-title">
          {MODE_ICONS[mode]}
          {modeInfo.label}
        </span>
        <div className="ai-header-actions">
          <div className="ai-status">
            <span className={`ai-status-dot ${isConnected ? "" : "disconnected"}`} />
            {isConnected ? "已连接" : "未连接"}
          </div>
          <button className="ai-clear-btn" onClick={clearMessages}>
            清空
          </button>
        </div>
      </div>

      {/* 消息区域 */}
      <div className="ai-messages">
        {messages.length === 0 && (
          <div className="ai-empty">
            <div className="ai-empty-icon">{MODE_ICONS[mode]}</div>
            {modeInfo.desc}
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
            思考中...
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* 错误提示 */}
      {error && (
        <div className="ai-error">
          <span>{error}</span>
          <button className="ai-error-retry" onClick={reconnect}>
            重连
          </button>
        </div>
      )}

      {/* 输入区域 */}
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
            placeholder={isConnected ? "输入问题... (Enter发送, Shift+Enter换行)" : "等待连接..."}
            disabled={!isConnected || isStreaming}
            rows={2}
          />
          <button
            type="submit"
            className="ai-send-btn"
            disabled={!isConnected || isStreaming || !input.trim()}
          >
            发送
          </button>
        </form>
      </div>

      {/* 模式选择器 */}
      <div className="ai-mode-selector" ref={dropdownRef}>
        {/* 下拉菜单 */}
        {dropdownOpen && isConnected && (
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

        {/* 模式按钮 */}
        <button
          className="ai-mode-btn"
          onClick={() => isConnected && setDropdownOpen(!dropdownOpen)}
          disabled={!isConnected}
        >
          {MODE_ICONS[mode]}
          <span>{modeInfo.label}</span>
          <span className="ai-mode-arrow">▾</span>
        </button>
      </div>

      {/* 模型选择器 */}
      <div className="ai-mode-selector" ref={modelDropdownRef} style={{ marginLeft: "8px" }}>
        {/* 下拉菜单 */}
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

        {/* 模型按钮 */}
        <button
          className="ai-mode-btn"
          onClick={() => isConnected && models.length > 0 && setModelDropdownOpen(!modelDropdownOpen)}
          disabled={!isConnected || models.length === 0}
          title={model || "选择模型"}
        >
          <span style={{ maxWidth: "100px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {model ? (models.find(m => m.id === model)?.name || model) : "模型"}
          </span>
          <span className="ai-mode-arrow">▾</span>
        </button>
      </div>
    </div>
  );
}
