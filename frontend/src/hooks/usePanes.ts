"use client";

import { useState, useCallback, useEffect } from "react";
import type { TabState } from "./useTabs";

// Layout type
export type LayoutType = "single" | "horizontal" | "vertical" | "grid";

// Pane data
export interface Pane {
  id: string;
  tabs: TabState[];
  activeTabId: string;
}

// Global split-pane state
export interface SplitState {
  layout: LayoutType;
  panes: Pane[];
}

// Layout configuration
export const LAYOUT_CONFIG: Record<LayoutType, { paneCount: number; gridCols: number; gridRows: number }> = {
  single: { paneCount: 1, gridCols: 1, gridRows: 1 },
  horizontal: { paneCount: 2, gridCols: 2, gridRows: 1 },
  vertical: { paneCount: 2, gridCols: 1, gridRows: 2 },
  grid: { paneCount: 4, gridCols: 2, gridRows: 2 },
};

let tabIdCounter = 0;
let paneIdCounter = 0;

const STORAGE_KEY = "winkterm-split-state";

// Default initial state (SSR-safe)
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

// Load state from localStorage (client only)
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

/** Fix persisted state where layout and pane count disagree (e.g. single layout with 2 panes) */
function normalizeSplitState(state: SplitState): SplitState {
  const config = LAYOUT_CONFIG[state.layout];
  if (state.panes.length === config.paneCount) return state;

  const allTabs: TabState[] = [];
  const allActiveIds: string[] = [];
  state.panes.forEach((pane) => {
    allTabs.push(...pane.tabs);
    allActiveIds.push(pane.activeTabId);
  });

  if (allTabs.length === 0) return getDefaultState();

  const newPanes: Pane[] = [];
  let tabIndex = 0;

  for (let i = 0; i < config.paneCount; i++) {
    const tabsForThisPane = Math.ceil((allTabs.length - tabIndex) / (config.paneCount - i));
    const paneTabs = allTabs.slice(tabIndex, tabIndex + Math.max(1, tabsForThisPane));
    tabIndex += paneTabs.length;

    if (paneTabs.length > 0) {
      const activeId = paneTabs.find((t) => allActiveIds.includes(t.id))?.id || paneTabs[0].id;
      paneIdCounter++;
      newPanes.push({
        id: `pane-${paneIdCounter}`,
        tabs: paneTabs,
        activeTabId: activeId,
      });
    } else {
      newPanes.push(createPane());
    }
  }

  return { layout: state.layout, panes: newPanes };
}

/** Fix duplicate tab ids in persisted state (causes terminal pool / VNC render loss) */
function dedupeTabIds(state: SplitState): SplitState {
  const globalSeen = new Set<string>();
  let changed = false;

  const panes = state.panes.map((pane) => {
    const tabs: TabState[] = [];
    let activeTabId = pane.activeTabId;

    for (const tab of pane.tabs) {
      if (!globalSeen.has(tab.id)) {
        globalSeen.add(tab.id);
        tabs.push(tab);
        continue;
      }

      changed = true;
      let newId = `tab-${++tabIdCounter}`;
      while (globalSeen.has(newId)) {
        newId = `tab-${++tabIdCounter}`;
      }
      globalSeen.add(newId);
      tabs.push({ ...tab, id: newId });
      if (activeTabId === tab.id) {
        activeTabId = newId;
      }
    }

    return { ...pane, tabs, activeTabId };
  });

  if (changed) {
    syncCountersFromState({ ...state, panes });
    return { ...state, panes };
  }
  return state;
}

export interface UsePanesReturn {
  layout: LayoutType;
  panes: Pane[];
  setLayout: (layout: LayoutType) => void;
  addTab: (paneId: string, options?: { id?: string; type?: "local" | "ssh" | "vnc"; sshConnectionId?: string; vncPort?: number; vncPassword?: string; title?: string; color?: string }) => string;
  closeTabById: (tabId: string) => void;
  hasTab: (tabId: string) => boolean;
  closeTab: (paneId: string, tabId: string) => void;
  switchTab: (paneId: string, tabId: string) => void;
  renameTab: (paneId: string, tabId: string, title: string) => void;
  moveTab: (fromPaneId: string, toPaneId: string, tabId: string) => void;
}

export function usePanes(): UsePanesReturn {
  // Initialize with default state (SSR-safe)
  const [state, setState] = useState<SplitState>(getDefaultState);
  const [isHydrated, setIsHydrated] = useState(false);

  // Client hydration: load from localStorage
  useEffect(() => {
    const savedState = loadStateFromStorage();
    if (savedState) {
      const layoutNormalized = normalizeSplitState(savedState);
      syncCountersFromState(layoutNormalized);
      const normalized = dedupeTabIds(layoutNormalized);
      setState(normalized);
      syncCountersFromState(normalized);
    } else {
      syncCountersFromState(getDefaultState());
    }
    setIsHydrated(true);
  }, []);

  // Persist state (only after hydration completes)
  useEffect(() => {
    if (isHydrated) {
      saveState(state);
    }
  }, [state, isHydrated]);

  // Switch layout
  const setLayout = useCallback((layout: LayoutType) => {
    setState((prev) => {
      const config = LAYOUT_CONFIG[layout];

      // Collect all existing tabs
      const allTabs: TabState[] = [];
      const allActiveIds: string[] = [];
      prev.panes.forEach((pane) => {
        allTabs.push(...pane.tabs);
        allActiveIds.push(pane.activeTabId);
      });

      // If no tabs exist, create new ones
      if (allTabs.length === 0) {
        const newPanes: Pane[] = [];
        for (let i = 0; i < config.paneCount; i++) {
          newPanes.push(createPane());
        }
        return { layout, panes: newPanes };
      }

      // Distribute existing tabs across panes
      const newPanes: Pane[] = [];
      let tabIndex = 0;

      for (let i = 0; i < config.paneCount; i++) {
        // How many tabs this pane should get
        const tabsForThisPane = Math.ceil((allTabs.length - tabIndex) / (config.paneCount - i));
        const paneTabs = allTabs.slice(tabIndex, tabIndex + Math.max(1, tabsForThisPane));
        tabIndex += paneTabs.length;

        if (paneTabs.length > 0) {
          // Active tab for this pane (prefer previously active tab)
          const activeId = paneTabs.find(t => allActiveIds.includes(t.id))?.id || paneTabs[0].id;
          paneIdCounter++;
          newPanes.push({
            id: `pane-${paneIdCounter}`,
            tabs: paneTabs,
            activeTabId: activeId,
          });
        } else {
          // No tabs to assign; create an empty pane
          newPanes.push(createPane());
        }
      }

      return { layout, panes: newPanes };
    });
  }, []);

  // Add tab
  const addTab = useCallback((paneId: string, options?: { id?: string; type?: "local" | "ssh" | "vnc"; sshConnectionId?: string; vncPort?: number; vncPassword?: string; title?: string; color?: string }) => {
    let newId = options?.id || `tab-${++tabIdCounter}`;
    const tabType = options?.type || "local";

    setState((prev) => {
      const existingIds = new Set(prev.panes.flatMap((pane) => pane.tabs.map((tab) => tab.id)));
      while (existingIds.has(newId)) {
        newId = `tab-${++tabIdCounter}`;
      }

      const newTab: TabState = {
        id: newId,
        title: options?.title || `Terminal ${tabIdCounter}`,
        type: tabType,
        sshConnectionId: options?.sshConnectionId,
        vncPort: options?.vncPort,
        vncPassword: options?.vncPassword,
        color: options?.color,
      };

      return {
        ...prev,
        panes: prev.panes.map((pane) =>
          pane.id === paneId
            ? { ...pane, tabs: [...pane.tabs, newTab], activeTabId: newId }
            : pane
        ),
      };
    });

    return newId;
  }, []);

  const hasTab = useCallback((tabId: string): boolean => {
    return state.panes.some((pane) => pane.tabs.some((tab) => tab.id === tabId));
  }, [state]);

  const closeTabById = useCallback((tabId: string) => {
    setState((prev) => ({
      ...prev,
      panes: prev.panes.map((pane) => {
        if (!pane.tabs.some((t) => t.id === tabId)) return pane;
        const newTabs = pane.tabs.filter((t) => t.id !== tabId);
        if (newTabs.length === 0) {
          // Fallback: never leave pane empty; create placeholder local tab
          tabIdCounter++;
          const placeholder: TabState = {
            id: `tab-${tabIdCounter}`,
            title: `Terminal ${tabIdCounter}`,
            type: "local",
          };
          return { ...pane, tabs: [placeholder], activeTabId: placeholder.id };
        }
        let newActive = pane.activeTabId;
        if (newActive === tabId) {
          const idx = pane.tabs.findIndex((t) => t.id === tabId);
          newActive = newTabs[Math.min(idx, newTabs.length - 1)].id;
        }
        return { ...pane, tabs: newTabs, activeTabId: newActive };
      }),
    }));
  }, []);

  // Close tab
  const closeTab = useCallback((paneId: string, tabId: string) => {
    setState((prev) => ({
      ...prev,
      panes: prev.panes.map((pane) => {
        if (pane.id !== paneId) return pane;

        if (pane.tabs.length <= 1) return pane; // Keep at least one tab

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

  // Switch tab
  const switchTab = useCallback((paneId: string, tabId: string) => {
    setState((prev) => ({
      ...prev,
      panes: prev.panes.map((pane) =>
        pane.id === paneId ? { ...pane, activeTabId: tabId } : pane
      ),
    }));
  }, []);

  // Rename tab
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

  // Move tab across panes
  const moveTab = useCallback((fromPaneId: string, toPaneId: string, tabId: string) => {
    setState((prev) => {
      const fromPane = prev.panes.find((p) => p.id === fromPaneId);
      const toPane = prev.panes.find((p) => p.id === toPaneId);

      if (!fromPane || !toPane || fromPaneId === toPaneId) return prev;

      const movingTab = fromPane.tabs.find((t) => t.id === tabId);
      if (!movingTab) return prev;

      // Source pane must keep at least one tab
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
    closeTabById,
    hasTab,
    switchTab,
    renameTab,
    moveTab,
  };
}
