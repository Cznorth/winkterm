"use client";

import { ReactNode, useMemo } from "react";
import TabBar from "@/components/TabBar";
import { useTabs } from "@/hooks/useTabs";
import Terminal from "@/components/Terminal";

interface LayoutProps {
  aiPanel: ReactNode;
}

export default function SplitLayout({ aiPanel }: LayoutProps) {
  const { tabs, activeTabId, addTab, closeTab, switchTab, renameTab } = useTabs();

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
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        width: "100vw",
        height: "100vh",
        background: "#0f0f1a",
        overflow: "hidden",
      }}
    >
      {/* 主内容区域 */}
      <div
        style={{
          display: "flex",
          flex: 1,
          overflow: "hidden",
        }}
      >
        {/* 左侧：终端 70% */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            flex: "0 0 70%",
            height: "100%",
            borderRight: "1px solid #2a2a4a",
            overflow: "hidden",
          }}
        >
          {/* TabBar */}
          <TabBar
            tabs={tabs}
            activeTabId={activeTabId}
            onTabClick={switchTab}
            onTabClose={closeTab}
            onTabAdd={addTab}
            onTabRename={renameTab}
          />

          {/* 终端区域 */}
          <div
            style={{
              flex: 1,
              overflow: "hidden",
            }}
          >
            {terminals}
          </div>
        </div>

        {/* 右侧：AI 面板 30% */}
        <div
          style={{
            flex: "0 0 30%",
            height: "100%",
            overflow: "hidden",
          }}
        >
          {aiPanel}
        </div>
      </div>
    </div>
  );
}
