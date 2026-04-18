"use client";

import { useEffect, useRef, useState, useImperativeHandle, forwardRef } from "react";
import { useTerminal } from "./useTerminal";
import "./terminal.css";

interface TerminalPanelProps {
  sessionId?: string;
  isActive?: boolean;
  type?: "local" | "ssh";
  sshConnectionId?: string;
}

export interface TerminalPanelRef {
  fit: () => void;
  fitWithSize: (cols: number, rows: number) => void;
}

const TerminalPanel = forwardRef<TerminalPanelRef, TerminalPanelProps>(
  function TerminalPanel(
    { sessionId = "default", isActive = true, type = "local", sshConnectionId },
    ref
  ) {
    const containerRef = useRef<HTMLDivElement>(null);
    const [containerReady, setContainerReady] = useState(false);
    const { init, term, fit, fitWithSize } = useTerminal(containerRef, sessionId, isActive, type, sshConnectionId);

    // 暴露 fit 方法给父组件
    useImperativeHandle(ref, () => ({ fit, fitWithSize }), [fit, fitWithSize]);

    // 使用 ResizeObserver 监听容器尺寸
    useEffect(() => {
      const container = containerRef.current;
      if (!container) return;

      const checkSize = () => {
        if (container.offsetWidth > 0 && container.offsetHeight > 0) {
          setContainerReady(true);
          return true;
        }
        return false;
      };

      // 立即检查
      if (checkSize()) return;

      // 使用 ResizeObserver 监听
      const observer = new ResizeObserver(() => {
        checkSize();
      });

      observer.observe(container);
      return () => observer.disconnect();
    }, [isActive]);

    // 容器准备好后初始化终端
    useEffect(() => {
      if (containerReady && !term.current) {
        init();
      }
    }, [containerReady, init, term]);

    return (
      <div
        ref={containerRef}
        className="terminal-container"
        style={{ width: "100%", height: "100%" }}
      />
    );
  }
);

export default TerminalPanel;
