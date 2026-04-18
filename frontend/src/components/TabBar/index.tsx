"use client";

import { useState, useEffect, useRef } from "react";
import type { TabState } from "@/hooks/useTabs";
import axios from "@/lib/axios";
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
}

// 终端图标
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

// SSH 图标
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

export default function TabBar({
  tabs,
  activeTabId,
  onTabClick,
  onTabClose,
  onTabAdd,
  onTabRename,
  paneId,
  onDragStart,
}: TabBarProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [showDropdown, setShowDropdown] = useState(false);
  const [sshConnections, setSSHConnections] = useState<SSHConnection[]>([]);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const [dropdownPosition, setDropdownPosition] = useState({ top: 0, left: 0 });
  const dropdownMenuRef = useRef<HTMLDivElement>(null);

  // 加载 SSH 连接列表
  useEffect(() => {
    axios.get("/api/ssh/connections").then((res) => {
      setSSHConnections(res.data.connections || []);
    }).catch(() => {});
  }, []);

  const handleDropdownToggle = () => {
    if (!showDropdown) {
      // 每次打开下拉时重新加载 SSH 列表
      axios.get("/api/ssh/connections").then((res) => {
        setSSHConnections(res.data.connections || []);
      }).catch(() => {});
    }
    if (dropdownRef.current) {
      const rect = dropdownRef.current.getBoundingClientRect();
      setDropdownPosition({ top: rect.bottom, left: rect.left });
    }
    setShowDropdown(!showDropdown);
  };

  // 点击外部关闭下拉菜单
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      const clickedInWrapper = dropdownRef.current?.contains(target);
      const clickedInMenu = dropdownMenuRef.current?.contains(target);
      if (!clickedInWrapper && !clickedInMenu) {
        setShowDropdown(false);
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

  return (
    <>
      <div className="tab-bar">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={`tab ${tab.id === activeTabId ? "active" : ""}`}
            onClick={() => onTabClick(tab.id)}
            onDoubleClick={() => handleDoubleClick(tab)}
            draggable={!!onDragStart}
            onDragStart={(e) => onDragStart?.(e, tab)}
          >
            <span className="tab-icon">
              {tab.type === "ssh" ? (
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
                title="关闭"
              >
                ×
              </button>
            )}
          </div>
        ))}

        {/* 新建按钮 */}
        <div className="tab-add-wrapper" ref={dropdownRef}>
          <button
            className={`tab-add ${showDropdown ? "active" : ""}`}
            onClick={handleDropdownToggle}
            title="新建终端"
          >
            +
          </button>
        </div>

        <div className="tab-bar-spacer" />
      </div>

      {/* 下拉菜单 - 使用 fixed 定位避免被裁剪 */}
      {showDropdown && (
        <div
          ref={dropdownMenuRef}
          className="tab-add-dropdown"
          style={{
            position: "fixed",
            top: dropdownPosition.top,
            left: dropdownPosition.left,
            zIndex: 1000,
          }}
        >
          <div className="dropdown-item" onClick={handleNewLocal}>
            <TerminalIcon />
            <span>本地终端</span>
          </div>

          {sshConnections.length > 0 && (
            <>
              <div className="dropdown-divider" />
              <div className="dropdown-header">SSH 连接</div>
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
        </div>
      )}
    </>
  );
}
