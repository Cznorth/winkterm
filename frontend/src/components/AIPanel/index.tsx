"use client";

import { useState, useRef, useEffect } from "react";
import { useChatWs, ChatMessage, ChatMode } from "@/lib/chatWs";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

// 模式图标 (SVG)
const MODE_ICONS: Record<ChatMode, JSX.Element> = {
  chat: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
    </svg>
  ),
  craft: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="14" rx="2"/>
      <path d="M3 8h18"/>
      <path d="M7 3v5"/>
    </svg>
  ),
};

// Markdown 样式
const markdownStyles = `
  .md-content h1, .md-content h2, .md-content h3 {
    color: #00ff88;
    margin: 12px 0 8px 0;
    font-weight: 600;
  }
  .md-content h1 { font-size: 16px; }
  .md-content h2 { font-size: 14px; }
  .md-content h3 { font-size: 13px; }
  .md-content p { margin: 6px 0; }
  .md-content ul, .md-content ol { margin: 6px 0; padding-left: 20px; }
  .md-content li { margin: 2px 0; }
  .md-content code {
    background: #0a0a15;
    padding: 2px 6px;
    border-radius: 4px;
    font-size: 12px;
    color: #f1fa8c;
  }
  .md-content pre {
    background: #0a0a15;
    padding: 10px 12px;
    border-radius: 6px;
    overflow-x: auto;
    margin: 8px 0;
    border: 1px solid #1a1a3a;
  }
  .md-content pre code {
    background: none;
    padding: 0;
    color: #e0e0e0;
  }
  .md-content blockquote {
    border-left: 3px solid #44475a;
    margin: 8px 0;
    padding-left: 12px;
    color: #888;
  }
  .md-content table {
    border-collapse: collapse;
    margin: 8px 0;
    width: 100%;
  }
  .md-content th, .md-content td {
    border: 1px solid #2a2a4a;
    padding: 6px 10px;
    text-align: left;
  }
  .md-content th {
    background: #1a1a2e;
    color: #00ff88;
  }
  .md-content a {
    color: #8be9fd;
  }
  .md-content hr {
    border: none;
    border-top: 1px solid #2a2a4a;
    margin: 12px 0;
  }
`;

function MessageBubble({ msg }: { msg: ChatMessage }) {
  const isUser = msg.role === "user";
  return (
    <div
      style={{
        display: "flex",
        justifyContent: isUser ? "flex-end" : "flex-start",
        marginBottom: "12px",
      }}
    >
      <div
        style={{
          maxWidth: "90%",
          padding: "10px 14px",
          borderRadius: "12px",
          background: isUser ? "#1a5f7a" : "#1a1a2e",
          color: isUser ? "#fff" : "#e0e0e0",
          fontSize: "13px",
          lineHeight: "1.6",
          wordBreak: "break-word",
        }}
        className={isUser ? "" : "md-content"}
      >
        {isUser ? (
          msg.content
        ) : (
          <ReactMarkdown remarkPlugins={[remarkGfm]}>
            {msg.content}
          </ReactMarkdown>
        )}
      </div>
    </div>
  );
}

const MODE_INFO: Record<ChatMode, { label: string; desc: string }> = {
  chat: { label: "Chat", desc: "对话助手，回答问题、提供建议" },
  craft: { label: "Craft", desc: "创作助手，编写代码、生成配置" },
};

export default function AIPanel() {
  const { messages, isStreaming, isConnected, error, mode, sendMessage, clearMessages, switchMode, reconnect } = useChatWs();
  const [input, setInput] = useState("");
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

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

  const modeInfo = MODE_INFO[mode];

  return (
    <>
      <style>{markdownStyles}</style>

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          height: "100%",
          background: "#0d0d1a",
          color: "#e0e0e0",
          fontFamily: "'JetBrains Mono', monospace",
        }}
      >
        {/* 标题栏 */}
        <div
          style={{
            padding: "12px 16px",
            borderBottom: "1px solid #1a1a3a",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            flexShrink: 0,
          }}
        >
          <span style={{ fontSize: "13px", color: "#00ff88", fontWeight: 700, display: "flex", alignItems: "center", gap: "8px" }}>
            <span style={{ width: "16px", height: "16px", display: "flex" }}>{MODE_ICONS[mode]}</span>
            {modeInfo.label}
          </span>
          <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
            <span
              style={{
                fontSize: "11px",
                color: isConnected ? "#00ff88" : "#ff5555",
              }}
            >
              {isConnected ? "● 已连接" : "○ 未连接"}
            </span>
            <button
              onClick={clearMessages}
              style={{
                fontSize: "11px",
                padding: "4px 8px",
                background: "#1a1a2e",
                border: "1px solid #2a2a4a",
                color: "#888",
                borderRadius: "4px",
                cursor: "pointer",
              }}
            >
              清空
            </button>
          </div>
        </div>

        {/* 消息区域 */}
        <div
          style={{
            flex: 1,
            overflowY: "auto",
            padding: "16px",
          }}
        >
          {messages.length === 0 && (
            <div
              style={{
                color: "#444",
                fontSize: "12px",
                textAlign: "center",
                marginTop: "60px",
                lineHeight: "1.8",
              }}
            >
              {modeInfo.desc}
            </div>
          )}
          {messages.map((msg) => (
            <MessageBubble key={msg.id} msg={msg} />
          ))}
          {isStreaming && (
            <div style={{ color: "#555", fontSize: "12px", textAlign: "center" }}>
              思考中...
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* 错误提示 */}
        {error && (
          <div
            style={{
              padding: "8px 16px",
              background: "#2a1a1a",
              color: "#ff5555",
              fontSize: "12px",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            {error}
            <button
              onClick={reconnect}
              style={{
                padding: "2px 8px",
                background: "#ff5555",
                border: "none",
                color: "#fff",
                borderRadius: "4px",
                cursor: "pointer",
                fontSize: "11px",
              }}
            >
              重连
            </button>
          </div>
        )}

        {/* 输入区域 */}
        <form
          onSubmit={handleSubmit}
          style={{
            padding: "12px 16px",
            borderTop: "1px solid #1a1a3a",
            display: "flex",
            gap: "8px",
            flexShrink: 0,
          }}
        >
          <textarea
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
            style={{
              flex: 1,
              padding: "10px 14px",
              background: "#1a1a2e",
              border: "1px solid #2a2a4a",
              borderRadius: "8px",
              color: "#e0e0e0",
              fontSize: "13px",
              outline: "none",
              resize: "none",
              lineHeight: "1.5",
            }}
          />
          <button
            type="submit"
            disabled={!isConnected || isStreaming || !input.trim()}
            style={{
              padding: "10px 16px",
              background: isConnected && input.trim() ? "#1a5f7a" : "#1a1a2e",
              border: "1px solid #2a2a4a",
              borderRadius: "8px",
              color: isConnected && input.trim() ? "#fff" : "#555",
              fontSize: "13px",
              cursor: isConnected && input.trim() ? "pointer" : "not-allowed",
              alignSelf: "flex-end",
            }}
          >
            发送
          </button>
        </form>

        {/* 模式选择器 - 底部 */}
        <div
          ref={dropdownRef}
          style={{
            padding: "8px 16px",
            borderTop: "1px solid #1a1a3a",
            flexShrink: 0,
            position: "relative",
          }}
        >
          {/* 下拉菜单 */}
          {dropdownOpen && isConnected && (
            <div
              style={{
                position: "absolute",
                bottom: "100%",
                left: "16px",
                marginBottom: "6px",
                background: "#2a2a2e",
                borderRadius: "10px",
                padding: "6px",
                minWidth: "180px",
                border: "0.5px solid rgba(255,255,255,0.08)",
                boxShadow: "0 -4px 16px rgba(0,0,0,0.4)",
              }}
            >
              {(Object.keys(MODE_INFO) as ChatMode[]).map((m) => (
                <div
                  key={m}
                  onClick={() => handleModeSelect(m)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: "9px 10px",
                    borderRadius: "7px",
                    cursor: "pointer",
                    background: m === mode ? "#3a3a40" : "transparent",
                    transition: "background 0.15s",
                  }}
                  onMouseEnter={(e) => {
                    if (m !== mode) e.currentTarget.style.background = "rgba(255,255,255,0.06)";
                  }}
                  onMouseLeave={(e) => {
                    if (m !== mode) e.currentTarget.style.background = "transparent";
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                    <div
                      style={{
                        width: "20px",
                        height: "20px",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        color: "#a0a0b0",
                      }}
                    >
                      {MODE_ICONS[m]}
                    </div>
                    <span style={{ color: "#e0e0e8", fontSize: "13.5px" }}>{MODE_INFO[m].label}</span>
                  </div>
                  {m === mode && (
                    <span style={{ color: "#a0a0b0", fontSize: "13px" }}>✓</span>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* 状态栏 / 触发按钮 */}
          <div
            onClick={() => isConnected && setDropdownOpen(!dropdownOpen)}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
              padding: "7px 12px",
              background: "#2a2a2e",
              borderRadius: "7px",
              border: "0.5px solid rgba(255,255,255,0.08)",
              cursor: isConnected ? "pointer" : "not-allowed",
              transition: "background 0.15s",
              opacity: isConnected ? 1 : 0.5,
            }}
            onMouseEnter={(e) => {
              if (isConnected) e.currentTarget.style.background = "#32323a";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "#2a2a2e";
            }}
          >
            <div style={{ width: "14px", height: "14px", color: "#a0a0b0", display: "flex" }}>
              {MODE_ICONS[mode]}
            </div>
            <span style={{ color: "#e0e0e8", fontSize: "13px" }}>{MODE_INFO[mode].label}</span>
            <span style={{ color: "#a0a0b0", fontSize: "10px", marginLeft: "2px" }}>▾</span>
          </div>
        </div>
      </div>
    </>
  );
}
