"use client";

import { useMemo, useEffect, useRef, useCallback } from "react";
import type { Pane, LayoutType } from "@/hooks/usePanes";
import type { TabState } from "@/hooks/useTabs";
import type { TerminalPanelRef } from "@/components/Terminal";
import Terminal from "@/components/Terminal";
import TabBar from "@/components/TabBar";
import "./SplitContainer.css";

interface SplitContainerProps {
  layout: LayoutType;
  panes: Pane[];
  onTabClick: (paneId: string, tabId: string) => void;
  onTabClose: (paneId: string, tabId: string) => void;
  onTabAdd: (paneId: string, options?: { type?: "local" | "ssh"; sshConnectionId?: string; title?: string; color?: string }) => void;
  onTabRename: (paneId: string, tabId: string, title: string) => void;
  onTabDrop: (fromPaneId: string, toPaneId: string, tabId: string) => void;
}

export default function SplitContainer({
  layout,
  panes,
  onTabClick,
  onTabClose,
  onTabAdd,
  onTabRename,
  onTabDrop,
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
  useEffect(() => {
    if (!containerRef.current) return;

    const container = containerRef.current;

    const updatePositions = () => {
      const panesElements = container.querySelectorAll<HTMLDivElement>("[data-pane-id]");
      const terminalElements = container.querySelectorAll<HTMLDivElement>("[data-terminal-id]");

      // 获取每个 pane 的位置信息
      const paneRects = new Map<string, DOMRect>();
      panesElements.forEach((el) => {
        const paneId = el.dataset.paneId!;
        paneRects.set(paneId, el.getBoundingClientRect());
      });

      // 获取 TabBar 高度
      const tabBarHeight = panesElements[0]?.querySelector(".tab-bar")?.getBoundingClientRect().height || 36;
      const containerRect = container.getBoundingClientRect();

      // 定位每个终端
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
    };

    updatePositions();

    // 监听窗口 resize 事件重新计算布局
    window.addEventListener("resize", updatePositions);
    return () => window.removeEventListener("resize", updatePositions);
  }, [panes, tabPaneMap, activeTabSet]);

  // 布局变化后，延迟调用所有终端的 fit
  useEffect(() => {
    // 等待 DOM 更新完成
    const timer = setTimeout(() => {
      // 收集每个分区可见终端的尺寸
      const paneSizes = new Map<string, { cols: number; rows: number }>();

      terminalRefs.current.forEach((ref, tabId) => {
        const paneId = tabPaneMap.get(tabId);
        if (paneId && activeTabSet.has(tabId)) {
          // 可见终端，执行 fit 并记录尺寸
          ref.fit();
          // 从 DOM 获取终端尺寸
          const terminalEl = document.querySelector(`[data-terminal-id="${tabId}"]`);
          if (terminalEl) {
            const width = terminalEl.clientWidth;
            const height = terminalEl.clientHeight;
            // 估算 cols 和 rows（字体大小约 14px，行高约 1.4）
            const cols = Math.floor(width / 9); // 约 9px 字符宽度
            const rows = Math.floor(height / 20); // 约 20px 行高
            paneSizes.set(paneId, { cols, rows });
          }
        }
      });

      // 给隐藏的终端发送相同分区的尺寸
      terminalRefs.current.forEach((ref, tabId) => {
        const paneId = tabPaneMap.get(tabId);
        if (paneId && !activeTabSet.has(tabId)) {
          const size = paneSizes.get(paneId);
          if (size) {
            ref.fitWithSize(size.cols, size.rows);
          }
        }
      });
    }, 100);
    return () => clearTimeout(timer);
  }, [layout, tabPaneMap, activeTabSet]);

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
  const renderPane = (pane: Pane) => {
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
        />
        <div className="pane-content" />
      </div>
    );
  };

  return (
    <div ref={containerRef} className="split-container" style={gridStyle}>
      {panes.map(renderPane)}

      {/* 全局终端池 */}
      <div className="terminal-pool">
        {allTabs.map((tab) => (
          <div
            key={tab.id}
            data-terminal-id={tab.id}
            className="terminal-instance"
            style={{ display: "none" }}
          >
            <Terminal
              ref={setTerminalRef(tab.id)}
              sessionId={tab.id}
              isActive={activeTabSet.has(tab.id)}
              type={tab.type}
              sshConnectionId={tab.sshConnectionId}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
