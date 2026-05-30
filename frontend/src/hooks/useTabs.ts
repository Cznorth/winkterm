"use client";

import { useState, useCallback, useRef } from "react";
import type { Terminal } from "@xterm/xterm";

export interface TabState {
  id: string;
  title: string;
  type: "local" | "ssh" | "vnc";      // Connection type
  sshConnectionId?: string;           // SSH connection ID
  vncPort?: number;                   // VNC port
  vncPassword?: string;               // VNC password
  color?: string;                     // Tab color
}

export interface UseTabsReturn {
  tabs: TabState[];
  activeTabId: string;
  addTab: (options?: { type?: "local" | "ssh" | "vnc"; sshConnectionId?: string; vncPort?: number; title?: string; color?: string }) => string;
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

  const addTab = useCallback((options?: { type?: "local" | "ssh" | "vnc"; sshConnectionId?: string; vncPort?: number; title?: string; color?: string }) => {
    tabIdCounter++;
    const newId = `tab-${tabIdCounter}`;
    const tabType = options?.type || "local";

    const newTab: TabState = {
      id: newId,
      title: options?.title || `Terminal ${tabs.length + 1}`,
      type: tabType,
      sshConnectionId: options?.sshConnectionId,
      vncPort: options?.vncPort,
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
          // Keep at least one tab
          return prev;
        }
        const newTabs = prev.filter((tab) => tab.id !== id);

        // If closing the active tab, switch to previous or next
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
