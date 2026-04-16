"use client";

import { useEffect, useRef } from "react";
import { useTerminal } from "./useTerminal";
import "./terminal.css";

interface TerminalPanelProps {
  sessionId?: string;
  isActive?: boolean;
}

export default function TerminalPanel({ sessionId = "default", isActive = true }: TerminalPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { init } = useTerminal(containerRef, sessionId, isActive);

  useEffect(() => {
    init();
  }, [init]);

  return (
    <div
      ref={containerRef}
      className="terminal-container"
      style={{ width: "100%", height: "100%" }}
    />
  );
}
