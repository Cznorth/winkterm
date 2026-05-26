"use client";

import { useMemo, useEffect, useRef, useCallback } from "react";
import dynamic from "next/dynamic";
import type { Pane, LayoutType } from "@/hooks/usePanes";
import type { TabState } from "@/hooks/useTabs";
import type { TerminalPanelRef } from "@/components/Terminal";
import Terminal from "@/components/Terminal";
import TabBar from "@/components/TabBar";
import "./SplitContainer.css";

const VNCViewer = dynamic(() => import("@/components/VNCViewer"), { ssr: false });

interface SplitContainerProps {
  layout: LayoutType;
  panes: Pane[];
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
  onTabClick,
  onTabClose,
  onTabAdd,
  onTabRename,
  onTabDrop,
  onToggleAI,
  aiVisible,
}: SplitContainerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  // 存储所有终端实例的 ref
  const terminalRefs = useRef<Map<string, TerminalPanelRef>>(new Map());

  // 根据布局生成 grid 样式
  const gridStyle = useMemo(() => {
    const configs: Record<LayoutType, string> = {
      single: "1fr / 1fr",
      horizontal: "1fr / 1fr 1fr",
      vertical: "1fr 1fr / 1fr",
      grid: "1fr 1fr / 1fr 1fr",
    };
    return { gridTemplate: configs[layout] };
  }, [layout]);

  // 收集所有唯一的 tab
  const allTabs = useMemo(() => {
    const seen = new Set<string>();
    const tabs: TabState[] = [];
    panes.forEach((pane) => {
      pane.tabs.forEach((tab) => {
        if (!seen.has(tab.id)) {
          seen.add(tab.id);
          tabs.push(tab);
        }
      });
    });
    return tabs;
  }, [panes]);

  // 构建 tabId -> 激活状态的映射
  const activeTabSet = useMemo(() => {
    const set = new Set<string>();
    panes.forEach((pane) => {
      set.add(pane.activeTabId);
    });
    return set;
  }, [panes]);

  // tabId -> paneId 映射
  const tabPaneMap = useMemo(() => {
    const map = new Map<string, string>();
    panes.forEach((pane) => {
      pane.tabs.forEach((tab) => {
        map.set(tab.id, pane.id);
      });
    });
    return map;
  }, [panes]);

  // 更新终端实例的位置
  const updatePositions = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;

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
      const paneId = tabPaneMap.get(tabId);
      const paneRect = paneId ? paneRects.get(paneId) : null;

      if (paneRect && activeTabSet.has(tabId)) {
        el.style.display = "block";
        el.style.left = `${paneRect.left - containerRect.left}px`;
        el.style.top = `${paneRect.top - containerRect.top + tabBarHeight}px`;
        el.style.width = `${paneRect.width}px`;
        el.style.height = `${paneRect.height - tabBarHeight}px`;
      } else {
        el.style.display = "none";
      }
    });
  }, [tabPaneMap, activeTabSet]);

  // fit 所有终端（同步，调用前需确保 DOM 已更新）
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

  // 位置更新 + fit 一体化
  const updateAndFit = useCallback(() => {
    updatePositions();
    // 强制浏览器重排，确保 terminal-container 尺寸已更新
    containerRef.current?.offsetHeight;
    fitAllTerminals();
  }, [updatePositions, fitAllTerminals]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    updateAndFit();

    const ro = new ResizeObserver(() => updateAndFit());
    ro.observe(container);
    return () => ro.disconnect();
  }, [panes, updateAndFit]);

  // 布局切换
  useEffect(() => {
    // 等 DOM 更新完成再 fit
    const timer = setTimeout(updateAndFit, 50);
    return () => clearTimeout(timer);
  }, [layout, updateAndFit]);

  // 注册终端 ref 的回调
  const setTerminalRef = useCallback((tabId: string) => {
    return (ref: TerminalPanelRef | null) => {
      if (ref) {
        terminalRefs.current.set(tabId, ref);
      } else {
        terminalRefs.current.delete(tabId);
      }
    };
  }, []);

  // 渲染单个分区
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
          {...(index === 0 && onToggleAI ? { onToggleAI, aiVisible } : {})}
        />
        <div className="pane-content" />
      </div>
    );
  };

  return (
    <div ref={containerRef} className="split-container" style={gridStyle} data-layout={layout}>
      {panes.map((pane, index) => renderPane(pane, index))}

      {/* 全局终端池 */}
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
              />
            ) : (
              <Terminal
                ref={setTerminalRef(tab.id)}
                sessionId={tab.id}
                isActive={activeTabSet.has(tab.id)}
                type={tab.type as "local" | "ssh"}
                sshConnectionId={tab.sshConnectionId}
              />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
