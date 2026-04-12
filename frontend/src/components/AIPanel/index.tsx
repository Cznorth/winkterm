"use client";

import { useAgent } from "./useAgent";
import type { HistoryItem } from "@/types";

function HistoryCard({ item }: { item: HistoryItem }) {
  const date = new Date(item.timestamp).toLocaleTimeString("zh-CN");
  return (
    <div
      style={{
        marginBottom: "12px",
        padding: "10px 12px",
        background: "#16213e",
        borderLeft: "3px solid #00ff88",
        borderRadius: "4px",
        fontSize: "13px",
        lineHeight: "1.6",
      }}
    >
      <div style={{ color: "#888", fontSize: "11px", marginBottom: "4px" }}>
        {date}
      </div>
      <div style={{ color: "#8be9fd", marginBottom: "6px", fontWeight: 600 }}>
        # {item.message}
      </div>
      <div style={{ color: "#e0e0e0", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
        {item.result}
      </div>
    </div>
  );
}

export default function AIPanel() {
  const { history, isLoading, error } = useAgent();

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        background: "#0f0f1a",
        color: "#e0e0e0",
        fontFamily: "'JetBrains Mono', monospace",
      }}
    >
      {/* 标题栏 */}
      <div
        style={{
          padding: "12px 16px",
          borderBottom: "1px solid #2a2a4a",
          fontSize: "13px",
          color: "#00ff88",
          fontWeight: 700,
          letterSpacing: "0.05em",
          flexShrink: 0,
        }}
      >
        WinkTerm AI
      </div>

      {/* 使用提示 */}
      <div
        style={{
          padding: "10px 16px",
          borderBottom: "1px solid #1a1a3a",
          fontSize: "11px",
          color: "#555",
          flexShrink: 0,
        }}
      >
        在终端输入 <span style={{ color: "#f1fa8c" }}># 你的问题</span> 即可与 AI 对话
      </div>

      {/* 历史区域 */}
      <div
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "12px 16px",
        }}
      >
        {isLoading && (
          <div style={{ color: "#555", fontSize: "12px" }}>加载中...</div>
        )}
        {error && (
          <div style={{ color: "#ff5555", fontSize: "12px" }}>
            无法加载历史记录
          </div>
        )}
        {!isLoading && !error && history.length === 0 && (
          <div style={{ color: "#444", fontSize: "12px", textAlign: "center", marginTop: "40px" }}>
            暂无分析记录
            <br />
            <br />
            在终端输入 # 开头的消息开始对话
          </div>
        )}
        {history.map((item, idx) => (
          <HistoryCard key={idx} item={item} />
        ))}
      </div>
    </div>
  );
}
