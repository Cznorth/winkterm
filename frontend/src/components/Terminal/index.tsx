"use client";

import { useEffect, useRef, useState, useImperativeHandle, forwardRef } from "react";
import { useTerminal } from "./useTerminal";
import { useTheme } from "@/lib/theme";
import "./terminal.css";

interface TerminalPanelProps {
  sessionId?: string;
  isActive?: boolean;
  type?: "local" | "ssh";
  sshConnectionId?: string;
  isCompact?: boolean;
}

export interface TerminalPanelRef {
  fit: () => void;
  fitWithSize: (cols: number, rows: number) => void;
  sendInput: (data: string) => void;
}

const TerminalPanel = forwardRef<TerminalPanelRef, TerminalPanelProps>(
  function TerminalPanel(
    { sessionId = "default", isActive = true, type = "local", sshConnectionId, isCompact = false },
    ref
  ) {
    const containerRef = useRef<HTMLDivElement>(null);
    const [containerReady, setContainerReady] = useState(false);
    const { resolvedTheme } = useTheme();
    const { init, term, fit, fitWithSize, sendInput } = useTerminal(
      containerRef,
      sessionId,
      isActive,
      type,
      sshConnectionId,
      resolvedTheme,
      isCompact
    );

    // Expose fit methods to parent component
    useImperativeHandle(ref, () => ({ fit, fitWithSize, sendInput }), [fit, fitWithSize, sendInput]);

    // Watch container size with ResizeObserver and retry init when needed
    useEffect(() => {
      const container = containerRef.current;
      if (!container) return;

      const checkSize = () => {
        if (container.offsetWidth > 0 && container.offsetHeight > 0) {
          setContainerReady(true);
          // When the agent creates multiple terminals, an intermediate tab may be briefly
          // activated then deactivated; init bails during async import when the container
          // becomes zero-sized. Switching back makes the container visible again, but
          // containerReady is already true so the init useEffect won't rerun → blank display.
          // Retry init here when the container is visible but term is not yet created.
          if (!term.current) {
            init();
          }
          return true;
        }
        return false;
      };

      // Check immediately
      if (checkSize()) return;

      // Watch with ResizeObserver
      const observer = new ResizeObserver(() => {
        checkSize();
      });

      observer.observe(container);
      return () => observer.disconnect();
    }, [isActive, init, term]);

    // Initialize terminal once container is ready (first path)
    useEffect(() => {
      if (containerReady && !term.current) {
        init();
      }
    }, [containerReady, init, term]);

    return (
      <div
        ref={containerRef}
        className={`terminal-container${isCompact ? " terminal-container-compact" : ""}`}
        style={{ width: "100%", height: "100%" }}
      />
    );
  }
);

export default TerminalPanel;
