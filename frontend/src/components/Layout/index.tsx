"use client";

import { ReactNode, useState, useRef, useCallback, useEffect, useMemo, isValidElement, cloneElement } from "react";
import { usePanes, LAYOUT_CONFIG, type LayoutType } from "@/hooks/usePanes";
import { useSessionsStream, type SessionInfo } from "@/hooks/useSessionsStream";
import { useBreakpoint } from "@/hooks/useBreakpoint";
import { useI18n } from "@/lib/i18n";
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

type ActivityItem = "terminal" | "ssh" | "settings";

const LAYOUT_BUTTONS: { layout: LayoutType; icon: ReactNode; titleKey: "layout.single" | "layout.horizontal" | "layout.vertical" | "layout.grid" }[] = [
  { layout: "single", icon: Icons.layoutSingle, titleKey: "layout.single" },
  { layout: "horizontal", icon: Icons.layoutHorizontal, titleKey: "layout.horizontal" },
  { layout: "vertical", icon: Icons.layoutVertical, titleKey: "layout.vertical" },
  { layout: "grid", icon: Icons.layoutGrid, titleKey: "layout.grid" },
];

const ACTIVITY_ITEMS: { id: ActivityItem; icon: ReactNode; labelKey: "layout.terminal" | "layout.sshConnections" | "layout.settings"; mobileLabelKey?: "layout.sshShort" }[] = [
  { id: "terminal", icon: Icons.terminal, labelKey: "layout.terminal" },
  { id: "ssh", icon: Icons.ssh, labelKey: "layout.sshConnections", mobileLabelKey: "layout.sshShort" },
  { id: "settings", icon: Icons.settings, labelKey: "layout.settings" },
];

export default function SplitLayout({ aiPanel }: LayoutProps) {
  const { t } = useI18n();
  const {
    layout,
    panes,
    setLayout,
    addTab,
    closeTab,
    closeTabById,
    hasTab,
    switchTab,
    renameTab,
    moveTab,
  } = usePanes();

  const [activeActivity, setActiveActivity] = useState<ActivityItem>("terminal");
  const [showAI, setShowAI] = useState(true);
  const [aiWidth, setAiWidth] = useState(320);
  const [isDesktop, setIsDesktop] = useState(
    () => typeof window !== "undefined" && !!window.pywebview?.api
  );
  const resizingRef = useRef(false);
  const breakpoint = useBreakpoint();
  const useResponsiveShell = !isDesktop;
  const isCompact = useResponsiveShell && breakpoint === "mobile";
  const isTablet = useResponsiveShell && (breakpoint === "tablet" || isCompact);
  const useMobileNav = useResponsiveShell && breakpoint !== "desktop";

  useEffect(() => {
    const saved = localStorage.getItem("winkterm-ai-width");
    if (saved) {
      setAiWidth(Math.min(600, Math.max(240, Number(saved))));
    }
    const savedAI = localStorage.getItem("winkterm-ai-visible");
    if (savedAI !== null) {
      setShowAI(savedAI !== "false");
    }
    // Detect desktop mode
    const checkDesktop = () => setIsDesktop(!!window.pywebview?.api);
    const timer = setTimeout(checkDesktop, 300);
    return () => clearTimeout(timer);
  }, []);

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    if (isCompact) return;
    e.preventDefault();
    resizingRef.current = true;
    const startX = e.clientX;
    const startWidth = aiWidth;

    const onMouseMove = (ev: MouseEvent) => {
      if (!resizingRef.current) return;
      const delta = startX - ev.clientX;
      const next = Math.min(600, Math.max(240, startWidth + delta));
      setAiWidth(next);
    };

    const onMouseUp = () => {
      resizingRef.current = false;
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      setAiWidth((w) => {
        localStorage.setItem("winkterm-ai-width", String(w));
        return w;
      });
    };

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }, [aiWidth, isCompact]);

  const layoutStyle = { "--ai-panel-width": `${aiWidth}px` } as React.CSSProperties;

  const handleToggleAI = useCallback(() => {
    setShowAI((v) => {
      localStorage.setItem("winkterm-ai-visible", String(!v));
      return !v;
    });
  }, []);

  // 后端 session 事件 → 自动同步标签栏(agent 创建的可见终端自动加 tab)
  const handleSessionCreated = useCallback((s: SessionInfo) => {
    if (!s.user_visible) return;
    if (hasTab(s.id)) return;
    const firstPaneId = panes[0]?.id;
    if (!firstPaneId) return;
    addTab(firstPaneId, {
      id: s.id,
      type: s.type,
      sshConnectionId: s.connection_id || undefined,
      title: s.title || s.name || (s.type === "ssh" ? `${s.username}@${s.host}` : "Terminal"),
    });
  }, [panes, addTab, hasTab]);

  const handleSessionClosed = useCallback((id: string) => {
    if (hasTab(id)) closeTabById(id);
  }, [hasTab, closeTabById]);

  useSessionsStream({
    onCreated: handleSessionCreated,
    onClosed: handleSessionClosed,
  });

  // tab X 按钮:先通知后端关 session,再删本地标签(后端 close 也会广播,前端幂等)
  const handleTabClose = useCallback((paneId: string, tabId: string) => {
    closeTab(paneId, tabId);
    import("@/lib/axios").then(({ default: axios }) => {
      axios.delete(`/api/sessions/${encodeURIComponent(tabId)}`).catch(() => {});
    });
  }, [closeTab]);

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

  // 处理 VNC 连接 - 添加到第一个分区
  const handleVNCConnect = (conn: { id: string; title: string; host: string; color?: string }, vncPort: number, vncPassword?: string) => {
    const firstPaneId = panes[0].id;
    addTab(firstPaneId, {
      type: "vnc",
      sshConnectionId: conn.id,
      vncPort,
      vncPassword,
      title: `${conn.title || conn.host} (VNC:${vncPort})`,
      color: conn.color,
    });
    setActiveActivity("terminal");
  };

  // 窄屏仅展示单分区（合并标签），不改变持久化的 layout 偏好
  const { effectiveLayout, effectivePanes } = useMemo(() => {
    if (!isTablet || layout === "single") {
      return { effectiveLayout: layout, effectivePanes: panes };
    }
    const allTabs = panes.flatMap((p) => p.tabs);
    const activePane = panes.find((p) => p.tabs.some((t) => t.id === p.activeTabId)) ?? panes[0];
    const dedupedTabs = allTabs.filter((tab, i, arr) => arr.findIndex((t) => t.id === tab.id) === i);
    return {
      effectiveLayout: "single" as LayoutType,
      effectivePanes: [{
        ...activePane,
        tabs: dedupedTabs.length > 0 ? dedupedTabs : activePane.tabs,
        activeTabId: activePane.activeTabId,
      }],
    };
  }, [isTablet, layout, panes]);

  return (
    <div
      className={`layout-container${isDesktop ? " desktop-app" : ""}${isCompact ? " compact" : ""}${isTablet ? " tablet" : ""}`}
      style={layoutStyle}
    >
      <TitleBar onToggleAI={handleToggleAI} aiVisible={showAI} />
      {isCompact && showAI && (
        <button
          type="button"
          className="ai-backdrop"
          aria-label={t("layout.closeAiPanel")}
          onClick={handleToggleAI}
        />
      )}
      <div className="layout-workspace">
        <div className="workspace-main">
          {/* 桌面：左侧活动栏 */}
          {!useMobileNav && (
            <div className="activity-bar">
              <div className="activity-bar-top">
                {ACTIVITY_ITEMS.filter((item) => item.id !== "settings").map((item) => (
                  <div
                    key={item.id}
                    className={`activity-item ${activeActivity === item.id ? "active" : ""}`}
                    onClick={() => setActiveActivity(item.id)}
                    title={t(item.labelKey)}
                  >
                    {item.icon}
                  </div>
                ))}
              </div>
              <div className="activity-bar-bottom">
                <div className="layout-buttons">
                  {LAYOUT_BUTTONS.map((btn) => (
                    <div
                      key={btn.layout}
                      className={`layout-btn ${layout === btn.layout ? "active" : ""}`}
                      onClick={() => setLayout(btn.layout)}
                      title={t(btn.titleKey)}
                    >
                      {btn.icon}
                    </div>
                  ))}
                </div>
                <div
                  className={`activity-item ${activeActivity === "settings" ? "active" : ""}`}
                  title={t("layout.settings")}
                  onClick={() => setActiveActivity("settings")}
                >
                  {Icons.settings}
                </div>
              </div>
            </div>
          )}

        {/* 主内容区域 - 终端始终挂载，SSH/设置覆盖显示 */}
        <div className="terminal-section">
          <div className="terminal-layer" style={{ display: activeActivity === "ssh" || activeActivity === "settings" ? "none" : "flex" }}>
            <SplitContainer
              layout={effectiveLayout}
              panes={effectivePanes}
              onTabClick={switchTab}
              onTabClose={handleTabClose}
              onTabAdd={addTab}
              onTabRename={renameTab}
              onTabDrop={moveTab}
              onToggleAI={handleToggleAI}
              aiVisible={showAI}
            />
          </div>
          {activeActivity === "ssh" && <SSHPanel onConnect={handleSSHConnect} onVNCConnect={handleVNCConnect} />}
          {activeActivity === "settings" && <SettingsPanel />}
        </div>

        </div>

        {/* AI 侧边栏 - 置于 workspace 层，避免被 overflow 裁切 */}
        <div
          className="ai-resize-handle"
          onMouseDown={handleResizeStart}
          style={{ display: showAI && !isCompact ? undefined : "none" }}
        />
        <div
          className={`ai-section${isCompact && showAI ? " ai-section-overlay" : ""}`}
          style={{ display: showAI ? undefined : "none" }}
        >
          {isValidElement(aiPanel)
            ? cloneElement(aiPanel, {
                onClose: isCompact && showAI ? handleToggleAI : undefined,
              })
            : aiPanel}
        </div>
      </div>

      {/* 手机/平板：固定底栏，置于 layout 顶层避免被 AI overlay 遮挡 */}
      {useMobileNav && (
        <nav className="mobile-nav-bar" aria-label={t("layout.navigation")}>
          {ACTIVITY_ITEMS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`mobile-nav-item${activeActivity === item.id ? " active" : ""}`}
              onClick={() => setActiveActivity(item.id)}
              aria-current={activeActivity === item.id ? "page" : undefined}
            >
              <span className="mobile-nav-icon">{item.icon}</span>
              <span className="mobile-nav-label">{t(item.mobileLabelKey ?? item.labelKey)}</span>
            </button>
          ))}
        </nav>
      )}
    </div>
  );
}
