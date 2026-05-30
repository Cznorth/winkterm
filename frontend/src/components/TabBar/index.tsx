"use client";

import { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { TabState } from "@/hooks/useTabs";
import axios from "@/lib/axios";
import { useI18n } from "@/lib/i18n";
import { useBreakpoint } from "@/hooks/useBreakpoint";
import FileTransferDialog from "@/components/FileTransferDialog";
import "./TabBar.css";

interface SSHConnection {
  id: string;
  title: string;
  host: string;
  color?: string;
}

interface TabBarProps {
  tabs: TabState[];
  activeTabId: string;
  onTabClick: (id: string) => void;
  onTabClose: (id: string) => void;
  onTabAdd: (options?: { type?: "local" | "ssh"; sshConnectionId?: string; title?: string; color?: string }) => void;
  onTabRename: (id: string, title: string) => void;
  paneId?: string;
  onDragStart?: (e: React.DragEvent, tab: TabState) => void;
  onToggleAI?: () => void;
  aiVisible?: boolean;
}

// Terminal icon
const TerminalIcon = ({ color }: { color?: string }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke={color || "currentColor"}
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <polyline points="4 17 10 11 4 5" />
    <line x1="12" y1="19" x2="20" y2="19" />
  </svg>
);

// VNC icon (monitor)
const VNCIcon = ({ color }: { color?: string }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke={color || "currentColor"}
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
    <line x1="8" y1="21" x2="16" y2="21" />
    <line x1="12" y1="17" x2="12" y2="21" />
  </svg>
);

// SSH icon
const SSHIcon = ({ color }: { color?: string }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke={color || "currentColor"}
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
  </svg>
);

function TabTypeIcon({ tab }: { tab: TabState }) {
  if (tab.type === "vnc") return <VNCIcon color={tab.color} />;
  if (tab.type === "ssh") return <SSHIcon color={tab.color} />;
  return <TerminalIcon color={tab.color} />;
}

const TransferIcon = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M7 7h10" />
    <path d="M13 3l4 4-4 4" />
    <path d="M17 17H7" />
    <path d="M11 21l-4-4 4-4" />
  </svg>
);

export default function TabBar({
  tabs,
  activeTabId,
  onTabClick,
  onTabClose,
  onTabAdd,
  onTabRename,
  paneId,
  onDragStart,
  onToggleAI,
  aiVisible,
}: TabBarProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [showDropdown, setShowDropdown] = useState(false);
  const [showTabList, setShowTabList] = useState(false);
  const { t } = useI18n();
  const breakpoint = useBreakpoint();
  const [isDesktopApp, setIsDesktopApp] = useState(
    () => typeof window !== "undefined" && !!window.pywebview?.api
  );
  const isMobileTabBar = breakpoint === "mobile" && !isDesktopApp;
  const [fileTransferTarget, setFileTransferTarget] = useState<{ connectionId: string; title: string } | null>(null);
  const [sshConnections, setSSHConnections] = useState<SSHConnection[]>([]);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const tabListRef = useRef<HTMLButtonElement>(null);

  const [dropdownPosition, setDropdownPosition] = useState({ top: 0, left: 0, width: 220 });
  const [tabListPosition, setTabListPosition] = useState({ top: 0, left: 0, width: 0 });
  const [portalReady, setPortalReady] = useState(false);
  const dropdownMenuRef = useRef<HTMLDivElement>(null);
  const tabListMenuRef = useRef<HTMLDivElement>(null);
  const tabBarRef = useRef<HTMLDivElement>(null);
  const activeTabRef = useRef<HTMLDivElement>(null);

  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0];

  useEffect(() => {
    setIsDesktopApp(!!window.pywebview?.api);
    setPortalReady(true);
  }, []);

  const computeDropdownPosition = (triggerRect: DOMRect, mobile: boolean) => {
    const pad = 8;
    const vw = window.innerWidth;
    const preferredWidth = mobile ? Math.min(320, vw - pad * 2) : 220;
    const width = Math.max(180, Math.min(preferredWidth, vw - pad * 2));
    let left = mobile ? Math.max(pad, triggerRect.right - width) : triggerRect.left;
    if (left + width > vw - pad) {
      left = Math.max(pad, vw - pad - width);
    }
    return { top: triggerRect.bottom, left, width };
  };

  // Load SSH connection list
  useEffect(() => {
    axios.get("/api/ssh/connections").then((res) => {
      setSSHConnections(res.data.connections || []);
    }).catch(() => {});
  }, []);

  const handleDropdownToggle = () => {
    setShowTabList(false);
    if (!showDropdown) {
      // Reload SSH list each time dropdown opens
      axios.get("/api/ssh/connections").then((res) => {
        setSSHConnections(res.data.connections || []);
      }).catch(() => {});
    }
    if (dropdownRef.current) {
      const rect = dropdownRef.current.getBoundingClientRect();
      setDropdownPosition(computeDropdownPosition(rect, isMobileTabBar));
    }
    setShowDropdown(!showDropdown);
  };

  const handleTabListToggle = () => {
    setShowDropdown(false);
    if (!showTabList && tabListRef.current) {
      const rect = tabListRef.current.getBoundingClientRect();
      setTabListPosition({ top: rect.bottom, left: rect.left, width: rect.width });
    }
    setShowTabList(!showTabList);
  };

  // Desktop: scroll active tab into view
  useEffect(() => {
    if (isMobileTabBar) return;
    activeTabRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeTabId, isMobileTabBar]);

  // Close dropdown on outside click
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      const clickedInAddWrapper = dropdownRef.current?.contains(target);
      const clickedInAddMenu = dropdownMenuRef.current?.contains(target);
      const clickedInTabListWrapper = tabListRef.current?.contains(target);
      const clickedInTabListMenu = tabListMenuRef.current?.contains(target);
      if (!clickedInAddWrapper && !clickedInAddMenu) {
        setShowDropdown(false);
      }
      if (!clickedInTabListWrapper && !clickedInTabListMenu) {
        setShowTabList(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const handleDoubleClick = (tab: TabState) => {
    setEditingId(tab.id);
    setEditTitle(tab.title);
  };

  const handleBlur = () => {
    if (editingId && editTitle.trim()) {
      onTabRename(editingId, editTitle.trim());
    }
    setEditingId(null);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      handleBlur();
    } else if (e.key === "Escape") {
      setEditingId(null);
    }
  };

  const handleNewLocal = (e: React.MouseEvent) => {
    e.stopPropagation();
    onTabAdd({ type: "local" });
    setShowDropdown(false);
  };

  const handleNewSSH = (e: React.MouseEvent, conn: SSHConnection) => {
    e.stopPropagation();
    onTabAdd({
      type: "ssh",
      sshConnectionId: conn.id,
      title: conn.title || conn.host,
      color: conn.color,
    });
    setShowDropdown(false);
  };

  /** Middle-click close (browser tab behavior; left-click switch unaffected) */
  const handleTabMouseDown = (e: React.MouseEvent, tabId: string) => {
    if (e.button !== 1 || tabs.length <= 1) return;
    e.preventDefault();
    e.stopPropagation();
    onTabClose(tabId);
  };

  return (
    <>
      <div
        ref={tabBarRef}
        className={`tab-bar${isMobileTabBar ? " tab-bar-mobile" : ""}`}
      >
        {isMobileTabBar ? (
          <>
            <button
              ref={tabListRef}
              type="button"
              className={`tab-picker${showTabList ? " active" : ""}`}
              onClick={handleTabListToggle}
              title={t("tabbar.switchTab")}
            >
              {activeTab && (
                <>
                  <span className="tab-picker-icon">
                    <TabTypeIcon tab={activeTab} />
                  </span>
                  <span className="tab-picker-title">{activeTab.title}</span>
                  {tabs.length > 1 && (
                    <span className="tab-picker-count">{tabs.length}</span>
                  )}
                  <span className="tab-picker-chevron">▾</span>
                </>
              )}
            </button>
            <div className="tab-bar-mobile-actions">
              {activeTab?.type === "ssh" && activeTab.sshConnectionId && (
                <button
                  type="button"
                  className="tab-bar-transfer-toggle"
                  onClick={() => setFileTransferTarget({
                    connectionId: activeTab.sshConnectionId!,
                    title: activeTab.title,
                  })}
                  title={t("ssh.fileTransfer")}
                  aria-label={t("ssh.fileTransfer")}
                >
                  <TransferIcon />
                </button>
              )}
              <div className="tab-add-wrapper" ref={dropdownRef}>
                <button
                  className={`tab-add ${showDropdown ? "active" : ""}`}
                  onClick={handleDropdownToggle}
                  title={t("tabbar.newTerminal")}
                >
                  +
                </button>
              </div>
              {onToggleAI && (
                <button
                  className={`tab-bar-ai-toggle ${aiVisible ? "active" : ""}`}
                  onClick={onToggleAI}
                  title={t("layout.aiAssistant")}
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 2a2 2 0 0 1 2 2c0 .74-.4 1.39-1 1.73V7h1a7 7 0 0 1 7 7h1a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-1v1a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-1H2a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1h1a7 7 0 0 1 7-7h1V5.73c-.6-.34-1-.99-1-1.73a2 2 0 0 1 2-2z" />
                    <circle cx="8" cy="14" r="1.5" fill="currentColor" />
                    <circle cx="16" cy="14" r="1.5" fill="currentColor" />
                  </svg>
                </button>
              )}
            </div>
          </>
        ) : (
          <>
        <div className="tab-bar-scroll">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            ref={tab.id === activeTabId ? activeTabRef : undefined}
            className={`tab ${tab.id === activeTabId ? "active" : ""}`}
            onClick={() => onTabClick(tab.id)}
            onMouseDown={(e) => handleTabMouseDown(e, tab.id)}
            onDoubleClick={() => handleDoubleClick(tab)}
            draggable={!!onDragStart}
            onDragStart={(e) => onDragStart?.(e, tab)}
          >
            <span className="tab-icon">
              {tab.type === "vnc" ? (
                <VNCIcon color={tab.color} />
              ) : tab.type === "ssh" ? (
                <SSHIcon color={tab.color} />
              ) : (
                <TerminalIcon color={tab.color} />
              )}
            </span>
            {editingId === tab.id ? (
              <input
                type="text"
                className="tab-title-input"
                value={editTitle}
                onChange={(e) => setEditTitle(e.target.value)}
                onBlur={handleBlur}
                onKeyDown={handleKeyDown}
                autoFocus
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <span className="tab-title">{tab.title}</span>
            )}
            {tabs.length > 1 && (
              <button
                className="tab-close"
                onClick={(e) => {
                  e.stopPropagation();
                  onTabClose(tab.id);
                }}
                title={t("tabbar.close")}
              >
                ×
              </button>
            )}
          </div>
        ))}

        {/* New tab button */}
        <div className="tab-add-wrapper" ref={dropdownRef}>
          <button
            className={`tab-add ${showDropdown ? "active" : ""}`}
            onClick={handleDropdownToggle}
            title={t("tabbar.newTerminal")}
          >
            +
          </button>
        </div>
        </div>

        <div className="tab-bar-actions">
        {onToggleAI && (
          <button
            className={`tab-bar-ai-toggle ${aiVisible ? "active" : ""}`}
            onClick={onToggleAI}
            title={t("layout.aiAssistant")}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 2a2 2 0 0 1 2 2c0 .74-.4 1.39-1 1.73V7h1a7 7 0 0 1 7 7h1a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-1v1a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-1H2a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1h1a7 7 0 0 1 7-7h1V5.73c-.6-.34-1-.99-1-1.73a2 2 0 0 1 2-2z" />
              <circle cx="8" cy="14" r="1.5" fill="currentColor" />
              <circle cx="16" cy="14" r="1.5" fill="currentColor" />
            </svg>
          </button>
        )}
        </div>
          </>
        )}
      </div>

      {portalReady && showTabList && isMobileTabBar && createPortal(
        <div
          ref={tabListMenuRef}
          className="tab-list-dropdown"
          style={{
            position: "fixed",
            top: tabListPosition.top,
            left: tabListPosition.left,
            width: tabListPosition.width,
            zIndex: 1000,
          }}
        >
          <div className="tab-list-header">{t("tabbar.tabs")}</div>
          {tabs.map((tab) => (
            <div
              key={tab.id}
              className={`tab-list-item ${tab.id === activeTabId ? "active" : ""}`}
              onClick={() => {
                onTabClick(tab.id);
                setShowTabList(false);
              }}
              onMouseDown={(e) => {
                handleTabMouseDown(e, tab.id);
                if (e.button === 1 && tabs.length > 1) setShowTabList(false);
              }}
            >
              <span className="tab-list-icon">
                <TabTypeIcon tab={tab} />
              </span>
              <span className="tab-list-title">{tab.title}</span>
              {tabs.length > 1 && (
                <button
                  type="button"
                  className="tab-list-close"
                  onClick={(e) => {
                    e.stopPropagation();
                    onTabClose(tab.id);
                  }}
                  title={t("tabbar.close")}
                >
                  ×
                </button>
              )}
            </div>
          ))}
        </div>,
        document.body
      )}

      {/* Dropdown — portal to body to avoid split-pane overflow clipping */}
      {portalReady && showDropdown && createPortal(
        <div
          ref={dropdownMenuRef}
          className={`tab-add-dropdown${isMobileTabBar ? " tab-add-dropdown-mobile" : ""}`}
          style={{
            position: "fixed",
            top: dropdownPosition.top,
            left: dropdownPosition.left,
            width: dropdownPosition.width,
            zIndex: 1000,
          }}
        >
          <div className="dropdown-item" onClick={handleNewLocal}>
            <TerminalIcon />
            <span>{t("tabbar.localTerminal")}</span>
          </div>

          {sshConnections.length > 0 && (
            <>
              <div className="dropdown-divider" />
              <div className="dropdown-header">{t("tabbar.sshConnection")}</div>
              {sshConnections.map((conn) => (
                <div
                  key={conn.id}
                  className="dropdown-item ssh"
                  style={{ borderLeftColor: conn.color || "#0078d4" }}
                  onClick={(e) => handleNewSSH(e, conn)}
                >
                  <SSHIcon color={conn.color} />
                  <span>{conn.title || conn.host}</span>
                </div>
              ))}
            </>
          )}
        </div>,
        document.body
      )}

      {fileTransferTarget && (
        <FileTransferDialog
          open={true}
          connectionId={fileTransferTarget.connectionId}
          title={fileTransferTarget.title}
          onClose={() => setFileTransferTarget(null)}
        />
      )}

    </>
  );
}
