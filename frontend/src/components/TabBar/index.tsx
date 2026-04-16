"use client";

import { useState } from "react";
import type { TabState } from "@/hooks/useTabs";
import "./TabBar.css";

interface TabBarProps {
  tabs: TabState[];
  activeTabId: string;
  onTabClick: (id: string) => void;
  onTabClose: (id: string) => void;
  onTabAdd: () => void;
  onTabRename: (id: string, title: string) => void;
}

// 终端图标
const TerminalIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="4 17 10 11 4 5" />
    <line x1="12" y1="19" x2="20" y2="19" />
  </svg>
);

export default function TabBar({
  tabs,
  activeTabId,
  onTabClick,
  onTabClose,
  onTabAdd,
  onTabRename,
}: TabBarProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");

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

  return (
    <div className="tab-bar">
      {tabs.map((tab) => (
        <div
          key={tab.id}
          className={`tab ${tab.id === activeTabId ? "active" : ""}`}
          onClick={() => onTabClick(tab.id)}
          onDoubleClick={() => handleDoubleClick(tab)}
        >
          <span className="tab-icon">{TerminalIcon}</span>
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
      <button className="tab-add" onClick={onTabAdd} title="新建终端">
        +
      </button>
      <div className="tab-bar-spacer" />
    </div>
  );
}
