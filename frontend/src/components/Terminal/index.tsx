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
}

const TerminalPanel = forwardRef<TerminalPanelRef, TerminalPanelProps>(
  function TerminalPanel(
    { sessionId = "default", isActive = true, type = "local", sshConnectionId, isCompact = false },
    ref
  ) {
    const containerRef = useRef<HTMLDivElement>(null);
    const [containerReady, setContainerReady] = useState(false);
    const { resolvedTheme } = useTheme();
    const { init, term, fit, fitWithSize } = useTerminal(
      containerRef,
      sessionId,
      isActive,
      type,
      sshConnectionId,
      resolvedTheme,
      isCompact
    );

    // 暴露 fit 方法给父组件
    useImperativeHandle(ref, () => ({ fit, fitWithSize }), [fit, fitWithSize]);

    // 使用 ResizeObserver 监听容器尺寸 + 必要时重试 init
    useEffect(() => {
      const container = containerRef.current;
      if (!container) return;

      const checkSize = () => {
        if (container.offsetWidth > 0 && container.offsetHeight > 0) {
          setContainerReady(true);
          // agent 一次创建多个终端时,中间 tab 短暂激活又失活,init 在异步 import
          // 期间发现容器变 0 直接 bail。后续切回该 tab 时容器恢复可见,但
          // containerReady 已是 true → init useEffect 不会重跑 → 永远空显示。
          // 这里检测到容器可见且 term 未建则主动重试 init。
          if (!term.current) {
            init();
          }
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
    }, [isActive, init, term]);

    // 容器准备好后初始化终端(首次路径)
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
