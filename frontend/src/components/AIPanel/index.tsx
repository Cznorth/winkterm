"use client";

import { useState, useRef, useEffect } from "react";
import { useChatWs, ChatMessage } from "@/lib/chatWs";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

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

export default function AIPanel() {
  const { messages, isStreaming, isConnected, error, sendMessage, clearMessages, reconnect } = useChatWs();
  const [input, setInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // 自动滚动到底部
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (input.trim() && !isStreaming) {
      sendMessage(input.trim());
      setInput("");
    }
  };

  return (
    <>
      {/* 注入 Markdown 样式 */}
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
          <span style={{ fontSize: "13px", color: "#00ff88", fontWeight: 700 }}>
            AI 分析助手
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
              分析助手，可以帮你：
              <br />
              • 查询监控指标
              <br />
              • 搜索日志
              <br />
              • 分析系统问题
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
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={isConnected ? "输入问题..." : "等待连接..."}
            disabled={!isConnected || isStreaming}
            style={{
              flex: 1,
              padding: "10px 14px",
              background: "#1a1a2e",
              border: "1px solid #2a2a4a",
              borderRadius: "8px",
              color: "#e0e0e0",
              fontSize: "13px",
              outline: "none",
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
            }}
          >
            发送
          </button>
        </form>
      </div>
    </>
  );
}
