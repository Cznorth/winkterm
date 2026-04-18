"use client";

import { ReactNode, useState, useMemo } from "react";
import { usePanes, LAYOUT_CONFIG, type LayoutType } from "@/hooks/usePanes";
import Terminal from "@/components/Terminal";
import SettingsPanel from "@/components/SettingsPanel";
import SSHPanel from "@/components/SSHPanel";
import TitleBar from "@/components/TitleBar";
import SplitContainer from "@/components/SplitContainer";
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
  ssh: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  ),
  settings: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  ),
  // 布局图标
  layoutSingle: (
    <svg viewBox="0 0 16 16" fill="currentColor">
      <rect x="1" y="1" width="14" height="14" rx="1" />
    </svg>
  ),
  layoutHorizontal: (
    <svg viewBox="0 0 16 16" fill="currentColor">
      <rect x="1" y="1" width="6.5" height="14" rx="1" />
      <rect x="8.5" y="1" width="6.5" height="14" rx="1" />
    </svg>
  ),
  layoutVertical: (
    <svg viewBox="0 0 16 16" fill="currentColor">
      <rect x="1" y="1" width="14" height="6.5" rx="1" />
      <rect x="1" y="8.5" width="14" height="6.5" rx="1" />
    </svg>
  ),
  layoutGrid: (
    <svg viewBox="0 0 16 16" fill="currentColor">
      <rect x="1" y="1" width="6.5" height="6.5" rx="1" />
      <rect x="8.5" y="1" width="6.5" height="6.5" rx="1" />
      <rect x="1" y="8.5" width="6.5" height="6.5" rx="1" />
      <rect x="8.5" y="8.5" width="6.5" height="6.5" rx="1" />
    </svg>
  ),
};

type ActivityItem = "terminal" | "ai" | "ssh" | "settings";

const LAYOUT_BUTTONS: { layout: LayoutType; icon: ReactNode; title: string }[] = [
  { layout: "single", icon: Icons.layoutSingle, title: "单分区" },
  { layout: "horizontal", icon: Icons.layoutHorizontal, title: "左右双列" },
  { layout: "vertical", icon: Icons.layoutVertical, title: "上下双行" },
  { layout: "grid", icon: Icons.layoutGrid, title: "田字格 2x2" },
];

export default function SplitLayout({ aiPanel }: LayoutProps) {
  const {
    layout,
    panes,
    setLayout,
    addTab,
    closeTab,
    switchTab,
    renameTab,
    moveTab,
  } = usePanes();

  const [activeActivity, setActiveActivity] = useState<ActivityItem>("terminal");

  // 处理 SSH 连接 - 添加到第一个分区
  const handleSSHConnect = (conn: { id: string; title: string; host: string; color?: string }) => {
    const firstPaneId = panes[0].id;
    addTab(firstPaneId, {
      type: "ssh",
      sshConnectionId: conn.id,
      title: conn.title || conn.host,
      color: conn.color,
    });
    setActiveActivity("terminal");
  };

  return (
    <div className="layout-container">
      <TitleBar />
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
            <div
              className={`activity-item ${activeActivity === "ssh" ? "active" : ""}`}
              onClick={() => setActiveActivity("ssh")}
              title="SSH 连接"
            >
              {Icons.ssh}
            </div>
          </div>
          <div className="activity-bar-bottom">
            {/* 布局切换按钮 */}
            <div className="layout-buttons">
              {LAYOUT_BUTTONS.map((btn) => (
                <div
                  key={btn.layout}
                  className={`layout-btn ${layout === btn.layout ? "active" : ""}`}
                  onClick={() => setLayout(btn.layout)}
                  title={btn.title}
                >
                  {btn.icon}
                </div>
              ))}
            </div>
            <div
              className={`activity-item ${activeActivity === "settings" ? "active" : ""}`}
              title="设置"
              onClick={() => setActiveActivity("settings")}
            >
              {Icons.settings}
            </div>
          </div>
        </div>

        {/* 终端区域 - 使用 SplitContainer */}
        <div className="terminal-section">
          <SplitContainer
            layout={layout}
            panes={panes}
            onTabClick={switchTab}
            onTabClose={closeTab}
            onTabAdd={addTab}
            onTabRename={renameTab}
            onTabDrop={moveTab}
          />
        </div>

        {/* 右侧面板 */}
        <div className="ai-section">
          {activeActivity === "settings" ? (
            <SettingsPanel />
          ) : activeActivity === "ssh" ? (
            <SSHPanel onConnect={handleSSHConnect} />
          ) : (
            aiPanel
          )}
        </div>
      </div>
    </div>
  );
}
