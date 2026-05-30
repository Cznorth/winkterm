"use client";

import { useMemo, useEffect, useRef, useCallback } from "react";
import dynamic from "next/dynamic";
import type { Pane, LayoutType } from "@/hooks/usePanes";
import type { TabState } from "@/hooks/useTabs";
import type { TerminalPanelRef } from "@/components/Terminal";
import Terminal from "@/components/Terminal";
import MobileTerminalKeys from "@/components/Terminal/MobileTerminalKeys";
import TabBar from "@/components/TabBar";
import "./SplitContainer.css";

const VNCViewer = dynamic(() => import("@/components/VNCViewer"), { ssr: false });

interface SplitContainerProps {
  layout: LayoutType;
  panes: Pane[];
  isCompact?: boolean;
  showMobileKeys?: boolean;
  onTabClick: (paneId: string, tabId: string) => void;
  onTabClose: (paneId: string, tabId: string) => void;
  onTabAdd: (paneId: string, options?: { type?: "local" | "ssh" | "vnc"; sshConnectionId?: string; vncPort?: number; title?: string; color?: string }) => void;
  onTabRename: (paneId: string, tabId: string, title: string) => void;
  onTabDrop: (fromPaneId: string, toPaneId: string, tabId: string) => void;
  onToggleAI?: () => void;
  aiVisible?: boolean;
}

export default function SplitContainer({
  layout,
  panes,
  isCompact = false,
  showMobileKeys = false,
  onTabClick,
  onTabClose,
  onTabAdd,
  onTabRename,
  onTabDrop,
  onToggleAI,
  aiVisible,
}: SplitContainerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const layoutRetryRef = useRef<number | null>(null);
  const updateAndFitRef = useRef<() => void>(() => {});
  // Refs for all terminal instances
  const terminalRefs = useRef<Map<string, TerminalPanelRef>>(new Map());

  // Grid style from layout type
  const gridStyle = useMemo(() => {
    const configs: Record<LayoutType, string> = {
      single: "1fr / 1fr",
      horizontal: "1fr / 1fr 1fr",
      vertical: "1fr 1fr / 1fr",
      grid: "1fr 1fr / 1fr 1fr",
    };
    return { gridTemplate: configs[layout] };
  }, [layout]);

  // Collect all unique tabs
  const allTabs = useMemo(() => {
    const tabMap = new Map<string, TabState>();
    panes.forEach((pane) => {
      pane.tabs.forEach((tab) => {
        tabMap.set(tab.id, tab);
      });
    });
    return Array.from(tabMap.values());
  }, [panes]);

  // Active shell terminal tab (non-VNC)
  const activeShellTabId = useMemo(() => {
    for (const pane of panes) {
      const tab = pane.tabs.find((t) => t.id === pane.activeTabId);
      if (tab && (tab.type === "local" || tab.type === "ssh")) {
        return tab.id;
      }
    }
    return null;
  }, [panes]);

  const handleMobileKeySend = useCallback(
    (data: string) => {
      if (!activeShellTabId) return;
      terminalRefs.current.get(activeShellTabId)?.sendInput(data);
    },
    [activeShellTabId]
  );

  // Build tabId → active-state set
  const activeTabSet = useMemo(() => {
    const set = new Set<string>();
    panes.forEach((pane) => {
      set.add(pane.activeTabId);
    });
    return set;
  }, [panes]);

  // tabId → paneId map
  const tabPaneMap = useMemo(() => {
    const map = new Map<string, string>();
    panes.forEach((pane) => {
      pane.tabs.forEach((tab) => {
        map.set(tab.id, pane.id);
      });
    });
    return map;
  }, [panes]);

  // Update terminal instance positions
  const updatePositions = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;

    if (container.clientWidth === 0 || container.clientHeight === 0) {
      if (layoutRetryRef.current !== null) {
        window.clearTimeout(layoutRetryRef.current);
      }
      layoutRetryRef.current = window.setTimeout(() => {
        layoutRetryRef.current = null;
        updateAndFitRef.current();
      }, 50);
      return;
    }

    const panesElements = container.querySelectorAll<HTMLDivElement>("[data-pane-id]");
    const terminalElements = container.querySelectorAll<HTMLDivElement>("[data-terminal-id]");

    const paneRects = new Map<string, DOMRect>();
    panesElements.forEach((el) => {
      const paneId = el.dataset.paneId!;
      paneRects.set(paneId, el.getBoundingClientRect());
    });

    const tabBarHeight = panesElements[0]?.querySelector(".tab-bar")?.getBoundingClientRect().height || 36;
    const containerRect = container.getBoundingClientRect();

    terminalElements.forEach((el) => {
      const tabId = el.dataset.terminalId!;
      const tab = allTabs.find((t) => t.id === tabId);
      const paneId = tabPaneMap.get(tabId);
      const paneRect = paneId ? paneRects.get(paneId) : null;

      if (paneRect && paneRect.width > 0 && paneRect.height > 0 && activeTabSet.has(tabId)) {
        el.style.display = "block";
        const isVncTab = tab?.type === "vnc";
        const reserveMobileKeys = isCompact && !isVncTab && showMobileKeys;
        const mobileBottom = `calc(var(--mobile-nav-height) + var(--safe-bottom)${reserveMobileKeys ? " + var(--mobile-keys-height)" : ""})`;
        if (isCompact && (isVncTab || showMobileKeys)) {
          el.style.position = "fixed";
          el.style.left = "0";
          el.style.right = "0";
          el.style.width = "100%";
          el.style.top = `${paneRect.top + tabBarHeight}px`;
          el.style.bottom = mobileBottom;
          el.style.height = "auto";
          el.style.zIndex = isVncTab ? "40" : "";
        } else {
          el.style.position = "absolute";
          el.style.left = `${paneRect.left - containerRect.left}px`;
          el.style.top = `${paneRect.top - containerRect.top + tabBarHeight}px`;
          el.style.width = `${paneRect.width}px`;
          el.style.height = `${paneRect.height - tabBarHeight}px`;
          el.style.right = "";
          el.style.bottom = "";
          el.style.zIndex = "";
        }
      } else {
        el.style.display = "none";
      }
    });
  }, [tabPaneMap, activeTabSet, allTabs, isCompact, showMobileKeys]);

  // Fit all terminals (sync; ensure DOM is updated before calling)
  const fitAllTerminals = useCallback(() => {
    const paneSizes = new Map<string, { cols: number; rows: number }>();

    terminalRefs.current.forEach((ref, tabId) => {
      const tab = allTabs.find((t) => t.id === tabId);
      if (tab?.type === "vnc") return;
      const paneId = tabPaneMap.get(tabId);
      if (paneId && activeTabSet.has(tabId)) {
        ref.fit();
        const terminalEl = document.querySelector(`[data-terminal-id="${tabId}"]`);
        if (terminalEl) {
          const width = terminalEl.clientWidth;
          const height = terminalEl.clientHeight;
          const cols = Math.floor(width / 9);
          const rows = Math.floor(height / 20);
          paneSizes.set(paneId, { cols, rows });
        }
      }
    });

    terminalRefs.current.forEach((ref, tabId) => {
      const tab = allTabs.find((t) => t.id === tabId);
      if (tab?.type === "vnc") return;
      const paneId = tabPaneMap.get(tabId);
      if (paneId && !activeTabSet.has(tabId)) {
        const size = paneSizes.get(paneId);
        if (size) {
          ref.fitWithSize(size.cols, size.rows);
        }
      }
    });
  }, [tabPaneMap, activeTabSet, allTabs]);

  // Position update + fit in one step
  const updateAndFit = useCallback(() => {
    updatePositions();
    // Force reflow so terminal-container dimensions are current
    containerRef.current?.offsetHeight;
    fitAllTerminals();
  }, [updatePositions, fitAllTerminals]);

  updateAndFitRef.current = updateAndFit;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    updateAndFit();

    const ro = new ResizeObserver(() => updateAndFit());
    ro.observe(container);
    return () => {
      ro.disconnect();
      if (layoutRetryRef.current !== null) {
        window.clearTimeout(layoutRetryRef.current);
      }
    };
  }, [panes, updateAndFit]);

  // Layout change
  useEffect(() => {
    // Fit after DOM has settled
    const timer = setTimeout(updateAndFit, 50);
    return () => clearTimeout(timer);
  }, [layout, updateAndFit]);

  // Callback to register terminal refs
  const setTerminalRef = useCallback((tabId: string) => {
    return (ref: TerminalPanelRef | null) => {
      if (ref) {
        terminalRefs.current.set(tabId, ref);
      } else {
        terminalRefs.current.delete(tabId);
      }
    };
  }, []);

  // Render a single pane
  const renderPane = (pane: Pane, index: number) => {
    return (
      <div
        key={pane.id}
        className="split-pane"
        data-pane-id={pane.id}
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer!.dropEffect = "move";
        }}
        onDrop={(e) => {
          e.preventDefault();
          const fromPaneId = e.dataTransfer!.getData("paneId");
          const tabId = e.dataTransfer!.getData("tabId");
          if (fromPaneId && tabId && fromPaneId !== pane.id) {
            onTabDrop(fromPaneId, pane.id, tabId);
          }
        }}
      >
        <TabBar
          tabs={pane.tabs}
          activeTabId={pane.activeTabId}
          onTabClick={(tabId) => onTabClick(pane.id, tabId)}
          onTabClose={(tabId) => onTabClose(pane.id, tabId)}
          onTabAdd={(options) => onTabAdd(pane.id, options)}
          onTabRename={(tabId, title) => onTabRename(pane.id, tabId, title)}
          paneId={pane.id}
          onDragStart={(e, tab) => {
            e.dataTransfer.setData("paneId", pane.id);
            e.dataTransfer.setData("tabId", tab.id);
          }}
          {...(onToggleAI ? { onToggleAI, aiVisible } : {})}
        />
        <div className="pane-content" />
      </div>
    );
  };

  return (
    <div ref={containerRef} className="split-container" style={gridStyle} data-layout={layout}>
      {panes.map((pane, index) => renderPane(pane, index))}

      {/* Global terminal pool */}
      <div className="terminal-pool">
        {allTabs.map((tab) => (
          <div
            key={tab.id}
            data-terminal-id={tab.id}
            className="terminal-instance"
            style={{ display: "none" }}
          >
            {tab.type === "vnc" ? (
              <VNCViewer
                sessionId={tab.id}
                sshConnectionId={tab.sshConnectionId!}
                vncPort={tab.vncPort!}
                vncPassword={tab.vncPassword}
                isActive={activeTabSet.has(tab.id)}
                isCompact={isCompact}
              />
            ) : (
              <Terminal
                ref={setTerminalRef(tab.id)}
                sessionId={tab.id}
                isActive={activeTabSet.has(tab.id)}
                type={tab.type as "local" | "ssh"}
                sshConnectionId={tab.sshConnectionId}
                isCompact={isCompact}
              />
            )}
          </div>
        ))}
      </div>

      {isCompact && showMobileKeys && activeShellTabId && (
        <MobileTerminalKeys onSend={handleMobileKeySend} />
      )}
    </div>
  );
}
