"use client";

import { ReactNode } from "react";

interface LayoutProps {
  terminal: ReactNode;
  aiPanel: ReactNode;
}

export default function SplitLayout({ terminal, aiPanel }: LayoutProps) {
  return (
    <div
      style={{
        display: "flex",
        width: "100vw",
        height: "100vh",
        background: "#0f0f1a",
        overflow: "hidden",
      }}
    >
      {/* 左侧：终端 70% */}
      <div
        style={{
          flex: "0 0 70%",
          height: "100%",
          borderRight: "1px solid #2a2a4a",
          overflow: "hidden",
        }}
      >
        {terminal}
      </div>

      {/* 右侧：AI 面板 30% */}
      <div
        style={{
          flex: "0 0 30%",
          height: "100%",
          overflow: "hidden",
        }}
      >
        {aiPanel}
      </div>
    </div>
  );
}
