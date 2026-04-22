"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { WinkTermLogo } from "@/components/Logo";
import "./TitleBar.css";

// 声明 pywebview API 类型
declare global {
  interface Window {
    pywebview?: {
      api: {
        minimize: () => Promise<void>;
        maximize: () => Promise<void>;
        restore: () => Promise<void>;
        toggle_maximize: () => Promise<void>;
        close: () => Promise<void>;
        is_maximized: () => Promise<boolean>;
        resize: (width: number, height: number) => Promise<void>;
        move: (x: number, y: number) => Promise<void>;
        begin_native_drag?: () => Promise<boolean>;
        begin_drag_from_maximized?: (cursorX: number, cursorY: number) => Promise<boolean>;
        begin_native_resize?: (edge: string) => Promise<boolean>;
        get_size: () => Promise<{ width: number; height: number }>;
        get_position: () => Promise<{ x: number; y: number }>;
        get_work_area: () => Promise<{ x: number; y: number; width: number; height: number }>;
        pick_file?: () => Promise<string | null>;
        pick_files?: () => Promise<string[] | null>;
        pick_save_file?: (suggestedName?: string) => Promise<string | null>;
        pick_folder?: () => Promise<string | null>;
      };
    };
  }
}

// 边缘调整大小钩子
function useWindowResize(isMaximized: boolean) {
  const resizingRef = useRef<{
    edge: string;
    startX: number;
    startY: number;
    startWidth: number;
    startHeight: number;
    startXPos: number;
    startYPos: number;
  } | null>(null);

  const startResize = useCallback(async (edge: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const api = window.pywebview?.api;
    if (!api || isMaximized) return;

    const supportsNativeResize =
      navigator.userAgent.includes("Windows") &&
      typeof api.begin_native_resize === "function";

    try {
      if (supportsNativeResize) {
        const handled = await api.begin_native_resize?.(edge);
        if (handled) {
          return;
        }
      }

      const size = await api.get_size();
      const pos = await api.get_position();

      resizingRef.current = {
        edge,
        startX: e.screenX,
        startY: e.screenY,
        startWidth: size.width,
        startHeight: size.height,
        startXPos: pos.x,
        startYPos: pos.y,
      };

      const handleMove = async (moveEvent: MouseEvent) => {
        if (!resizingRef.current) return;

        const { edge, startX, startY, startWidth, startHeight, startXPos, startYPos } = resizingRef.current;
        const deltaX = moveEvent.screenX - startX;
        const deltaY = moveEvent.screenY - startY;

        let newWidth = startWidth;
        let newHeight = startHeight;
        let newX = startXPos;
        let newY = startYPos;

        const minWidth = 800;
        const minHeight = 600;

        if (edge.includes("e")) {
          newWidth = Math.max(minWidth, startWidth + deltaX);
        }
        if (edge.includes("w")) {
          newWidth = Math.max(minWidth, startWidth - deltaX);
          newX = startXPos + (startWidth - newWidth);
        }
        if (edge.includes("s")) {
          newHeight = Math.max(minHeight, startHeight + deltaY);
        }
        if (edge.includes("n")) {
          newHeight = Math.max(minHeight, startHeight - deltaY);
          newY = startYPos + (startHeight - newHeight);
        }

        await api.resize(Math.round(newWidth), Math.round(newHeight));
        if (edge.includes("w") || edge.includes("n")) {
          await api.move(Math.round(newX), Math.round(newY));
        }
      };

      const handleUp = () => {
        resizingRef.current = null;
        document.removeEventListener("mousemove", handleMove);
        document.removeEventListener("mouseup", handleUp);
        document.body.style.cursor = "";
      };

      document.body.style.cursor = edge.includes("n") || edge.includes("s") ? "ns-resize" :
                                    edge.includes("e") || edge.includes("w") ? "ew-resize" :
                                    edge === "nw" || edge === "se" ? "nwse-resize" : "nesw-resize";
      document.addEventListener("mousemove", handleMove);
      document.addEventListener("mouseup", handleUp);
    } catch (err) {
      console.error("Resize failed:", err);
    }
  }, [isMaximized]);

  return { startResize };
}

// 窗口拖拽钩子
function useWindowDrag(isMaximized: boolean, onRestored: () => void) {
  const draggingRef = useRef<{
    startX: number;
    startY: number;
    startWindowX: number;
    startWindowY: number;
  } | null>(null);

  const pendingRestoreRef = useRef<{
    startX: number;
    startY: number;
  } | null>(null);

  const startDrag = useCallback(async (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const api = window.pywebview?.api;
    if (!api) return;

    const supportsNativeDrag =
      navigator.userAgent.includes("Windows") &&
      typeof api.begin_native_drag === "function";
    const supportsMaximizedNativeDrag =
      navigator.userAgent.includes("Windows") &&
      typeof api.begin_drag_from_maximized === "function";

    try {
      if (isMaximized) {
        // 最大化时：先记录起始位置，等用户实际拖动时再还原窗口
        pendingRestoreRef.current = {
          startX: e.screenX,
          startY: e.screenY,
        };

        const handleMove = async (moveEvent: MouseEvent) => {
          if (!pendingRestoreRef.current) return;

          // 检查是否真的在拖动（移动超过阈值）
          const deltaX = Math.abs(moveEvent.screenX - pendingRestoreRef.current.startX);
          const deltaY = Math.abs(moveEvent.screenY - pendingRestoreRef.current.startY);

          if (deltaX > 5 || deltaY > 5) {
            if (supportsMaximizedNativeDrag) {
              const handled = await api.begin_drag_from_maximized?.(moveEvent.screenX, moveEvent.screenY);
              if (handled) {
                onRestored();
                pendingRestoreRef.current = null;
                document.removeEventListener("mousemove", handleMove);
                document.removeEventListener("mouseup", handleUp);
                return;
              }
            }

            // 用户确实在拖动，现在还原窗口
            const workArea = await api.get_work_area();
            if (!workArea) return;

            const ratio = Math.min(
              1,
              Math.max(0, (pendingRestoreRef.current.startX - workArea.x) / workArea.width)
            );

            await api.restore();
            onRestored();

            const restoredSize = await api.get_size();
            const minX = workArea.x;
            const maxX = workArea.x + workArea.width - restoredSize.width;
            const nextX = Math.round(moveEvent.screenX - restoredSize.width * ratio);
            const newWindowX = Math.min(Math.max(nextX, minX), Math.max(minX, maxX));
            const newWindowY = workArea.y;

            await api.move(newWindowX, newWindowY);

            // 清理 pending 状态，开始正常拖动
            pendingRestoreRef.current = null;
            document.removeEventListener("mousemove", handleMove);
            document.removeEventListener("mouseup", handleUp);

            if (supportsNativeDrag) {
              const handled = await api.begin_native_drag?.();
              if (handled) {
                return;
              }
            }

            // 启动正常拖动
            startDragImpl(moveEvent.screenX, moveEvent.screenY, newWindowX, newWindowY);
          }
        };

        const handleUp = () => {
          // 用户只是点击，没有拖动，不还原窗口
          pendingRestoreRef.current = null;
          document.removeEventListener("mousemove", handleMove);
          document.removeEventListener("mouseup", handleUp);
        };

        document.addEventListener("mousemove", handleMove);
        document.addEventListener("mouseup", handleUp);
      } else {
        if (supportsNativeDrag) {
          const handled = await api.begin_native_drag?.();
          if (handled) {
            return;
          }
        }

        const pos = await api.get_position();
        if (!pos) return;
        startDragImpl(e.screenX, e.screenY, pos.x, pos.y);
      }
    } catch (err) {
      console.error("Drag start failed:", err);
    }
  }, [isMaximized, onRestored]);

  const startDragImpl = (startX: number, startY: number, startWindowX: number, startWindowY: number) => {
    draggingRef.current = { startX, startY, startWindowX, startWindowY };

    const handleMove = async (moveEvent: MouseEvent) => {
      if (!draggingRef.current) return;

      const { startX, startY, startWindowX, startWindowY } = draggingRef.current;
      const deltaX = moveEvent.screenX - startX;
      const deltaY = moveEvent.screenY - startY;

      const newX = startWindowX + deltaX;
      const newY = startWindowY + deltaY;

      await window.pywebview?.api?.move?.(Math.round(newX), Math.round(newY));
    };

    const handleUp = () => {
      draggingRef.current = null;
      document.removeEventListener("mousemove", handleMove);
      document.removeEventListener("mouseup", handleUp);
    };

    document.addEventListener("mousemove", handleMove);
    document.addEventListener("mouseup", handleUp);
  };

  return { startDrag };
}

export default function TitleBar() {
  const [isMaximized, setIsMaximized] = useState(false);
  const [isDesktop, setIsDesktop] = useState(false);
  const [isMac, setIsMac] = useState(false);
  const [isWindowFocused, setIsWindowFocused] = useState(true);
  const { startResize } = useWindowResize(isMaximized);
  const { startDrag } = useWindowDrag(isMaximized, () => setIsMaximized(false));

  useEffect(() => {
    const checkDesktop = async () => {
      const hasApi = !!window.pywebview?.api;
      setIsDesktop(hasApi);
      // 检测是否为 Mac
      setIsMac(navigator.userAgent.includes("Mac") || navigator.platform.includes("Mac"));

      if (hasApi) {
        try {
          const maximized = await window.pywebview?.api?.is_maximized?.();
          setIsMaximized(!!maximized);
        } catch (e) {
          // ignore
        }
      }
    };

    const timer = setTimeout(checkDesktop, 200);
    const interval = setInterval(checkDesktop, 500);

    // 监听窗口焦点变化
    const handleFocus = () => setIsWindowFocused(true);
    const handleBlur = () => setIsWindowFocused(false);
    window.addEventListener("focus", handleFocus);
    window.addEventListener("blur", handleBlur);

    return () => {
      clearTimeout(timer);
      clearInterval(interval);
      window.removeEventListener("focus", handleFocus);
      window.removeEventListener("blur", handleBlur);
    };
  }, []);

  const handleMinimize = async () => {
    try {
      await window.pywebview?.api?.minimize?.();
    } catch (e) {
      console.error("Minimize failed:", e);
    }
  };

  const handleMaximize = async () => {
    try {
      await window.pywebview?.api?.toggle_maximize?.();
      setTimeout(async () => {
        const maximized = await window.pywebview?.api?.is_maximized?.();
        setIsMaximized(!!maximized);
      }, 100);
    } catch (e) {
      console.error("Maximize failed:", e);
    }
  };

  const handleClose = async () => {
    try {
      // 先尝试 pywebview API
      if (window.pywebview?.api?.close) {
        await window.pywebview.api.close();
      } else {
        // 降级到 HTTP 请求
        await fetch("/exit", { method: "POST" });
      }
    } catch (e) {
      console.error("Close failed:", e);
      // 尝试 HTTP 请求作为备选
      try {
        await fetch("/exit", { method: "POST" });
      } catch (e2) {
        console.error("HTTP exit also failed:", e2);
      }
    }
  };

  // 非桌面模式下不显示标题栏
  if (!isDesktop) {
    return null;
  }

  return (
    <>
      {/* 边缘调整大小区域 */}
      <div className="resize-edge top" onMouseDown={(e) => startResize("n", e)} />
      <div className="resize-edge bottom" onMouseDown={(e) => startResize("s", e)} />
      <div className="resize-edge left" onMouseDown={(e) => startResize("w", e)} />
      <div className="resize-edge right" onMouseDown={(e) => startResize("e", e)} />
      <div className="resize-corner nw" onMouseDown={(e) => startResize("nw", e)} />
      <div className="resize-corner ne" onMouseDown={(e) => startResize("ne", e)} />
      <div className="resize-corner sw" onMouseDown={(e) => startResize("sw", e)} />
      <div className="resize-corner se" onMouseDown={(e) => startResize("se", e)} />

      {/* 自定义标题栏 */}
      <div className={`title-bar ${isMac ? "mac-style" : "windows-style"}`}>
        {isMac ? (
          // Mac 风格：红黄绿按钮在左侧
          <>
            <div className={`title-bar-traffic-lights ${!isWindowFocused ? "dimmed" : ""}`}>
              <button className="traffic-light close" onClick={handleClose} title="关闭">
                <svg viewBox="0 0 12 12"><path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.5" fill="none" /></svg>
              </button>
              <button className="traffic-light minimize" onClick={handleMinimize} title="最小化">
                <svg viewBox="0 0 12 12"><rect x="2" y="5.5" width="8" height="1.5" fill="currentColor" /></svg>
              </button>
              <button className="traffic-light maximize" onClick={handleMaximize} title={isMaximized ? "还原" : "最大化"}>
                {isMaximized ? (
                  <svg viewBox="0 0 12 12">
                    <rect x="3" y="1" width="6" height="6" fill="none" stroke="currentColor" strokeWidth="1" />
                    <rect x="2" y="4" width="6" height="6" fill="var(--bg-tertiary)" stroke="currentColor" strokeWidth="1" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 12 12"><path d="M2.5 2.5h7v7h-7z" fill="none" stroke="currentColor" strokeWidth="1" /></svg>
                )}
              </button>
            </div>
            <div
              className="title-bar-drag"
              onMouseDown={startDrag}
              onDoubleClick={handleMaximize}
            >
              <WinkTermLogo size={18} className="title-bar-logo" />
              <span className="title-bar-title">WinkTerm</span>
            </div>
          </>
        ) : (
          // Windows 风格：按钮在右侧
          <>
            <div
              className="title-bar-drag"
              onMouseDown={startDrag}
              onDoubleClick={handleMaximize}
            >
              <WinkTermLogo size={18} className="title-bar-logo" />
              <span className="title-bar-title">WinkTerm</span>
            </div>
            <div className="title-bar-controls">
              <button className="title-bar-btn minimize" onClick={handleMinimize} title="最小化">
                <svg viewBox="0 0 12 12">
                  <rect x="2" y="5.5" width="8" height="1" fill="currentColor" />
                </svg>
              </button>
              <button className="title-bar-btn maximize" onClick={handleMaximize} title={isMaximized ? "还原" : "最大化"}>
                {isMaximized ? (
                  <svg viewBox="0 0 12 12">
                    <rect x="3" y="1" width="7" height="7" fill="none" stroke="currentColor" strokeWidth="1" />
                    <rect x="2" y="4" width="7" height="7" fill="var(--bg-primary)" stroke="currentColor" strokeWidth="1" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 12 12">
                    <rect x="2" y="2" width="8" height="8" fill="none" stroke="currentColor" strokeWidth="1" />
                  </svg>
                )}
              </button>
              <button className="title-bar-btn close" onClick={handleClose} title="关闭">
                <svg viewBox="0 0 12 12">
                  <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.2" fill="none" />
                </svg>
              </button>
            </div>
          </>
        )}
      </div>
    </>
  );
}
