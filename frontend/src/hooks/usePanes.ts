"use client";

import { useState, useCallback, useEffect } from "react";
import type { TabState } from "./useTabs";

// 布局类型
export type LayoutType = "single" | "horizontal" | "vertical" | "grid";

// 分区数据
export interface Pane {
  id: string;
  tabs: TabState[];
  activeTabId: string;
}

// 全局分区状态
export interface SplitState {
  layout: LayoutType;
  panes: Pane[];
}

// 布局配置
export const LAYOUT_CONFIG: Record<LayoutType, { paneCount: number; gridCols: number; gridRows: number }> = {
  single: { paneCount: 1, gridCols: 1, gridRows: 1 },
  horizontal: { paneCount: 2, gridCols: 2, gridRows: 1 },
  vertical: { paneCount: 2, gridCols: 1, gridRows: 2 },
  grid: { paneCount: 4, gridCols: 2, gridRows: 2 },
};

let tabIdCounter = 0;
let paneIdCounter = 0;

const STORAGE_KEY = "winkterm-split-state";

// 默认初始状态（SSR 安全）
function getDefaultState(): SplitState {
  return {
    layout: "single",
    panes: [
      {
        id: "pane-1",
        tabs: [{ id: "tab-1", title: "Terminal 1", type: "local" }],
        activeTabId: "tab-1",
      },
    ],
  };
}

function parseNumericId(id: string, prefix: string): number {
  return parseInt(id.replace(`${prefix}-`, ""), 10) || 0;
}

function getMaxCounters(state: SplitState): { tab: number; pane: number } {
  return {
    tab: Math.max(
      0,
      ...state.panes.flatMap((pane) => pane.tabs.map((tab) => parseNumericId(tab.id, "tab")))
    ),
    pane: Math.max(
      0,
      ...state.panes.map((pane) => parseNumericId(pane.id, "pane"))
    ),
  };
}

function syncCountersFromState(state: SplitState) {
  const counters = getMaxCounters(state);
  tabIdCounter = Math.max(tabIdCounter, counters.tab);
  paneIdCounter = Math.max(paneIdCounter, counters.pane);
}

syncCountersFromState(getDefaultState());

// 从 localStorage 加载状态（仅客户端）
function loadStateFromStorage(): SplitState | null {
  if (typeof window === "undefined") return null;
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved) as SplitState;
      if (parsed.panes && parsed.panes.length > 0) {
        return parsed;
      }
    }
  } catch (e) {
    console.error("Failed to load split state:", e);
  }
  return null;
}

function createPane(): Pane {
  paneIdCounter++;
  tabIdCounter++;
  return {
    id: `pane-${paneIdCounter}`,
    tabs: [{ id: `tab-${tabIdCounter}`, title: `Terminal ${tabIdCounter}`, type: "local" }],
    activeTabId: `tab-${tabIdCounter}`,
  };
}

function saveState(state: SplitState) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    console.error("Failed to save split state:", e);
  }
}

export interface UsePanesReturn {
  layout: LayoutType;
  panes: Pane[];
  setLayout: (layout: LayoutType) => void;
  addTab: (paneId: string, options?: { type?: "local" | "ssh"; sshConnectionId?: string; title?: string; color?: string }) => string;
  closeTab: (paneId: string, tabId: string) => void;
  switchTab: (paneId: string, tabId: string) => void;
  renameTab: (paneId: string, tabId: string, title: string) => void;
  moveTab: (fromPaneId: string, toPaneId: string, tabId: string) => void;
}

export function usePanes(): UsePanesReturn {
  // 使用默认状态初始化（SSR 安全）
  const [state, setState] = useState<SplitState>(getDefaultState);
  const [isHydrated, setIsHydrated] = useState(false);

  // 客户端 hydration：从 localStorage 加载
  useEffect(() => {
    const savedState = loadStateFromStorage();
    if (savedState) {
      setState(savedState);
      syncCountersFromState(savedState);
    } else {
      syncCountersFromState(getDefaultState());
    }
    setIsHydrated(true);
  }, []);

  // 保存状态（仅在 hydration 完成后）
  useEffect(() => {
    if (isHydrated) {
      saveState(state);
    }
  }, [state, isHydrated]);

  // 切换布局
  const setLayout = useCallback((layout: LayoutType) => {
    setState((prev) => {
      const config = LAYOUT_CONFIG[layout];

      // 收集所有现有的标签页
      const allTabs: TabState[] = [];
      const allActiveIds: string[] = [];
      prev.panes.forEach((pane) => {
        allTabs.push(...pane.tabs);
        allActiveIds.push(pane.activeTabId);
      });

      // 如果没有标签页，创建新的
      if (allTabs.length === 0) {
        const newPanes: Pane[] = [];
        for (let i = 0; i < config.paneCount; i++) {
          newPanes.push(createPane());
        }
        return { layout, panes: newPanes };
      }

      // 将现有标签页分配到各个分区
      const newPanes: Pane[] = [];
      let tabIndex = 0;

      for (let i = 0; i < config.paneCount; i++) {
        // 计算这个分区应该有多少标签
        const tabsForThisPane = Math.ceil((allTabs.length - tabIndex) / (config.paneCount - i));
        const paneTabs = allTabs.slice(tabIndex, tabIndex + Math.max(1, tabsForThisPane));
        tabIndex += paneTabs.length;

        if (paneTabs.length > 0) {
          // 找出这个分区的激活标签（优先使用之前的激活标签）
          const activeId = paneTabs.find(t => allActiveIds.includes(t.id))?.id || paneTabs[0].id;
          paneIdCounter++;
          newPanes.push({
            id: `pane-${paneIdCounter}`,
            tabs: paneTabs,
            activeTabId: activeId,
          });
        } else {
          // 没有标签可分配，创建空分区
          newPanes.push(createPane());
        }
      }

      return { layout, panes: newPanes };
    });
  }, []);

  // 添加标签页
  const addTab = useCallback((paneId: string, options?: { type?: "local" | "ssh"; sshConnectionId?: string; title?: string; color?: string }) => {
    const newId = `tab-${++tabIdCounter}`;
    const tabType = options?.type || "local";

    const newTab: TabState = {
      id: newId,
      title: options?.title || `Terminal ${tabIdCounter}`,
      type: tabType,
      sshConnectionId: options?.sshConnectionId,
      color: options?.color,
    };

    setState((prev) => ({
      ...prev,
      panes: prev.panes.map((pane) =>
        pane.id === paneId
          ? { ...pane, tabs: [...pane.tabs, newTab], activeTabId: newId }
          : pane
      ),
    }));

    return newId;
  }, []);

  // 关闭标签页
  const closeTab = useCallback((paneId: string, tabId: string) => {
    setState((prev) => ({
      ...prev,
      panes: prev.panes.map((pane) => {
        if (pane.id !== paneId) return pane;

        if (pane.tabs.length <= 1) return pane; // 至少保留一个

        const newTabs = pane.tabs.filter((tab) => tab.id !== tabId);
        let newActiveId = pane.activeTabId;

        if (pane.activeTabId === tabId) {
          const closedIndex = pane.tabs.findIndex((tab) => tab.id === tabId);
          const newActiveIndex = Math.min(closedIndex, newTabs.length - 1);
          newActiveId = newTabs[newActiveIndex].id;
        }

        return { ...pane, tabs: newTabs, activeTabId: newActiveId };
      }),
    }));
  }, []);

  // 切换标签页
  const switchTab = useCallback((paneId: string, tabId: string) => {
    setState((prev) => ({
      ...prev,
      panes: prev.panes.map((pane) =>
        pane.id === paneId ? { ...pane, activeTabId: tabId } : pane
      ),
    }));
  }, []);

  // 重命名标签页
  const renameTab = useCallback((paneId: string, tabId: string, title: string) => {
    setState((prev) => ({
      ...prev,
      panes: prev.panes.map((pane) =>
        pane.id === paneId
          ? { ...pane, tabs: pane.tabs.map((tab) => (tab.id === tabId ? { ...tab, title } : tab)) }
          : pane
      ),
    }));
  }, []);

  // 跨分区移动标签页
  const moveTab = useCallback((fromPaneId: string, toPaneId: string, tabId: string) => {
    setState((prev) => {
      const fromPane = prev.panes.find((p) => p.id === fromPaneId);
      const toPane = prev.panes.find((p) => p.id === toPaneId);

      if (!fromPane || !toPane || fromPaneId === toPaneId) return prev;

      const movingTab = fromPane.tabs.find((t) => t.id === tabId);
      if (!movingTab) return prev;

      // 源分区至少保留一个标签
      if (fromPane.tabs.length <= 1) return prev;

      return {
        ...prev,
        panes: prev.panes.map((pane) => {
          if (pane.id === fromPaneId) {
            const newTabs = pane.tabs.filter((t) => t.id !== tabId);
            let newActiveId = pane.activeTabId;
            if (pane.activeTabId === tabId) {
              newActiveId = newTabs[0].id;
            }
            return { ...pane, tabs: newTabs, activeTabId: newActiveId };
          }
          if (pane.id === toPaneId) {
            return { ...pane, tabs: [...pane.tabs, movingTab], activeTabId: tabId };
          }
          return pane;
        }),
      };
    });
  }, []);

  return {
    layout: state.layout,
    panes: state.panes,
    setLayout,
    addTab,
    closeTab,
    switchTab,
    renameTab,
    moveTab,
  };
}
