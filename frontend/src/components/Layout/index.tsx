"use client";

import { ReactNode, useMemo, useState } from "react";
import TabBar from "@/components/TabBar";
import { useTabs } from "@/hooks/useTabs";
import Terminal from "@/components/Terminal";
import "./Layout.css";

interface LayoutProps {
  aiPanel: ReactNode;
}

// SVG 图标
const Icons = {
  terminal: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
    </svg>
  ),
  ai: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2a2 2 0 0 1 2 2c0 .74-.4 1.39-1 1.73V7h1a7 7 0 0 1 7 7h1a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-1v1a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-1H2a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1h1a7 7 0 0 1 7-7h1V5.73c-.6-.34-1-.99-1-1.73a2 2 0 0 1 2-2z" />
      <circle cx="8" cy="14" r="1.5" fill="currentColor" />
      <circle cx="16" cy="14" r="1.5" fill="currentColor" />
    </svg>
  ),
  settings: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  ),
};

type ActivityItem = "terminal" | "ai";

export default function SplitLayout({ aiPanel }: LayoutProps) {
  const { tabs, activeTabId, addTab, closeTab, switchTab, renameTab } = useTabs();
  const [activeActivity, setActiveActivity] = useState<ActivityItem>("terminal");

  // 为每个标签创建终端组件
  const terminals = useMemo(() => {
    return tabs.map((tab) => (
      <div
        key={tab.id}
        style={{
          display: tab.id === activeTabId ? "block" : "none",
          width: "100%",
          height: "100%",
        }}
      >
        <Terminal sessionId={tab.id} isActive={tab.id === activeTabId} />
      </div>
    ));
  }, [tabs, activeTabId]);

  return (
    <div className="layout-container">
      <div className="main-content">
        {/* 活动栏 */}
        <div className="activity-bar">
          <div className="activity-bar-top">
            <div
              className={`activity-item ${activeActivity === "terminal" ? "active" : ""}`}
              onClick={() => setActiveActivity("terminal")}
              title="终端"
            >
              {Icons.terminal}
            </div>
            <div
              className={`activity-item ${activeActivity === "ai" ? "active" : ""}`}
              onClick={() => setActiveActivity("ai")}
              title="AI 助手"
            >
              {Icons.ai}
            </div>
          </div>
          <div className="activity-bar-bottom">
            <div className="activity-item" title="设置">
              {Icons.settings}
            </div>
          </div>
        </div>

        {/* 终端区域 */}
        <div className="terminal-section">
          <TabBar
            tabs={tabs}
            activeTabId={activeTabId}
            onTabClick={switchTab}
            onTabClose={closeTab}
            onTabAdd={addTab}
            onTabRename={renameTab}
          />
          <div style={{ flex: 1, overflow: "hidden" }}>
            {terminals}
          </div>
        </div>

        {/* AI 面板 */}
        <div className="ai-section">
          {aiPanel}
        </div>
      </div>

    </div>
  );
}
