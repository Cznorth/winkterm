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
      <button className="tab-add" onClick={onTabAdd} title="新建标签">
        +
      </button>
    </div>
  );
}
