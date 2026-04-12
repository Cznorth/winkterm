"use client";

import { useEffect, useRef } from "react";
import { useTerminal } from "./useTerminal";
import "./terminal.css";

export default function TerminalPanel() {
  const containerRef = useRef<HTMLDivElement>(null);
  const { init } = useTerminal(containerRef);

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
