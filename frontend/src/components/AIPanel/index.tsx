"use client";

import { useState, useRef, useEffect } from "react";
import { useChatWs, ChatMessage } from "@/lib/chatWs";

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
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
      >
        {msg.content}
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
  );
}
