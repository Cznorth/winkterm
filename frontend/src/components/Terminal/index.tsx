"use client";

import { useEffect, useRef } from "react";
import { useTerminal } from "./useTerminal";
import "./terminal.css";

interface TerminalPanelProps {
  sessionId?: string;
  isActive?: boolean;
  type?: "local" | "ssh";
  sshConnectionId?: string;
}

export default function TerminalPanel({
  sessionId = "default",
  isActive = true,
  type = "local",
  sshConnectionId,
}: TerminalPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { init } = useTerminal(containerRef, sessionId, isActive, type, sshConnectionId);

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
