"use client";

import { useState, useCallback, useRef } from "react";
import type { Terminal } from "@xterm/xterm";

export interface TabState {
  id: string;
  title: string;
  type: "local" | "ssh";      // 连接类型
  sshConnectionId?: string;   // SSH 连接 ID
  color?: string;             // 标签颜色
}

export interface UseTabsReturn {
  tabs: TabState[];
  activeTabId: string;
  addTab: (options?: { type?: "local" | "ssh"; sshConnectionId?: string; title?: string; color?: string }) => string;
  closeTab: (id: string) => void;
  switchTab: (id: string) => void;
  renameTab: (id: string, title: string) => void;
}

let tabIdCounter = 0;

export function useTabs(): UseTabsReturn {
  const [tabs, setTabs] = useState<TabState[]>([
    { id: "tab-0", title: "Terminal 1", type: "local" },
  ]);
  const [activeTabId, setActiveTabId] = useState<string>("tab-0");

  const addTab = useCallback((options?: { type?: "local" | "ssh"; sshConnectionId?: string; title?: string; color?: string }) => {
    tabIdCounter++;
    const newId = `tab-${tabIdCounter}`;
    const tabType = options?.type || "local";

    const newTab: TabState = {
      id: newId,
      title: options?.title || `Terminal ${tabs.length + 1}`,
      type: tabType,
      sshConnectionId: options?.sshConnectionId,
      color: options?.color,
    };

    setTabs((prev) => [...prev, newTab]);
    setActiveTabId(newId);
    return newId;
  }, [tabs.length]);

  const closeTab = useCallback(
    (id: string) => {
      setTabs((prev) => {
        if (prev.length <= 1) {
          // 至少保留一个标签
          return prev;
        }
        const newTabs = prev.filter((tab) => tab.id !== id);

        // 如果关闭的是当前激活的标签，切换到前一个或后一个
        if (activeTabId === id) {
          const closedIndex = prev.findIndex((tab) => tab.id === id);
          const newActiveIndex = Math.min(closedIndex, newTabs.length - 1);
          setActiveTabId(newTabs[newActiveIndex].id);
        }

        return newTabs;
      });
    },
    [activeTabId]
  );

  const switchTab = useCallback((id: string) => {
    setActiveTabId(id);
  }, []);

  const renameTab = useCallback((id: string, title: string) => {
    setTabs((prev) =>
      prev.map((tab) => (tab.id === id ? { ...tab, title } : tab))
    );
  }, []);

  return {
    tabs,
    activeTabId,
    addTab,
    closeTab,
    switchTab,
    renameTab,
  };
}
