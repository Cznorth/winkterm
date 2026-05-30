"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { WinkTermLogo } from "@/components/Logo";
import { useI18n } from "@/lib/i18n";
import "./TitleBar.css";

// pywebview API types
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

// Window edge resize hook
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

// Window drag hook
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
        // When maximized: record start position; restore window only after real drag
        pendingRestoreRef.current = {
          startX: e.screenX,
          startY: e.screenY,
        };

        const handleMove = async (moveEvent: MouseEvent) => {
          if (!pendingRestoreRef.current) return;

          // Check for real drag (movement past threshold)
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

            // User is dragging — restore window now
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

            // Clear pending state and start normal drag
            pendingRestoreRef.current = null;
            document.removeEventListener("mousemove", handleMove);
            document.removeEventListener("mouseup", handleUp);

            if (supportsNativeDrag) {
              const handled = await api.begin_native_drag?.();
              if (handled) {
                return;
              }
            }

            // Start normal drag
            startDragImpl(moveEvent.screenX, moveEvent.screenY, newWindowX, newWindowY);
          }
        };

        const handleUp = () => {
          // Click only, no drag — do not restore window
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

interface TitleBarProps {
  onToggleAI?: () => void;
  aiVisible?: boolean;
}

export default function TitleBar({ onToggleAI, aiVisible }: TitleBarProps) {
  const { t } = useI18n();
  const [isMaximized, setIsMaximized] = useState(false);
  const [isDesktop, setIsDesktop] = useState(
    () => typeof window !== "undefined" && !!window.pywebview?.api
  );
  const [isMac, setIsMac] = useState(false);
  const [isWindowFocused, setIsWindowFocused] = useState(true);
  const { startResize } = useWindowResize(isMaximized);
  const { startDrag } = useWindowDrag(isMaximized, () => setIsMaximized(false));

  useEffect(() => {
    const checkDesktop = async () => {
      const hasApi = !!window.pywebview?.api;
      setIsDesktop(hasApi);
      // Detect macOS
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

    // Track window focus changes
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
      // Try pywebview API first
      if (window.pywebview?.api?.close) {
        await window.pywebview.api.close();
      } else {
        // Fall back to HTTP request
        await fetch("/exit", { method: "POST" });
      }
    } catch (e) {
      console.error("Close failed:", e);
      // Try HTTP request as fallback
      try {
        await fetch("/exit", { method: "POST" });
      } catch (e2) {
        console.error("HTTP exit also failed:", e2);
      }
    }
  };

  // Hide title bar outside desktop app
  if (!isDesktop) {
    return null;
  }

  return (
    <>
      {/* Edge resize handles */}
      <div className="resize-edge top" onMouseDown={(e) => startResize("n", e)} />
      <div className="resize-edge bottom" onMouseDown={(e) => startResize("s", e)} />
      <div className="resize-edge left" onMouseDown={(e) => startResize("w", e)} />
      <div className="resize-edge right" onMouseDown={(e) => startResize("e", e)} />
      <div className="resize-corner nw" onMouseDown={(e) => startResize("nw", e)} />
      <div className="resize-corner ne" onMouseDown={(e) => startResize("ne", e)} />
      <div className="resize-corner sw" onMouseDown={(e) => startResize("sw", e)} />
      <div className="resize-corner se" onMouseDown={(e) => startResize("se", e)} />

      {/* Custom title bar */}
      <div className={`title-bar ${isMac ? "mac-style" : "windows-style"}`}>
        {isMac ? (
          // macOS style: traffic lights on the left
          <>
            <div className={`title-bar-traffic-lights ${!isWindowFocused ? "dimmed" : ""}`}>
              <button className="traffic-light close" onClick={handleClose} title={t("titlebar.close")}>
                <svg viewBox="0 0 12 12"><path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.5" fill="none" /></svg>
              </button>
              <button className="traffic-light minimize" onClick={handleMinimize} title={t("titlebar.minimize")}>
                <svg viewBox="0 0 12 12"><rect x="2" y="5.5" width="8" height="1.5" fill="currentColor" /></svg>
              </button>
              <button className="traffic-light maximize" onClick={handleMaximize} title={isMaximized ? t("titlebar.restore") : t("titlebar.maximize")}>
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
            {onToggleAI && (
              <button
                className={`title-bar-btn ai-toggle ${aiVisible ? "active" : ""}`}
                onClick={onToggleAI}
                title={t("layout.aiAssistant")}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" width="16" height="16">
                  <path d="M12 2a2 2 0 0 1 2 2c0 .74-.4 1.39-1 1.73V7h1a7 7 0 0 1 7 7h1a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-1v1a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-1H2a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1h1a7 7 0 0 1 7-7h1V5.73c-.6-.34-1-.99-1-1.73a2 2 0 0 1 2-2z" />
                  <circle cx="8" cy="14" r="1.5" fill="currentColor" />
                  <circle cx="16" cy="14" r="1.5" fill="currentColor" />
                </svg>
              </button>
            )}
          </>
        ) : (
          // Windows style: controls on the right
          <>
            <div
              className="title-bar-drag"
              onMouseDown={startDrag}
              onDoubleClick={handleMaximize}
            >
              <WinkTermLogo size={18} className="title-bar-logo" />
              <span className="title-bar-title">WinkTerm</span>
            </div>
            {onToggleAI && (
              <button
                className={`title-bar-btn ai-toggle ${aiVisible ? "active" : ""}`}
                onClick={onToggleAI}
                title={t("layout.aiAssistant")}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" width="16" height="16">
                  <path d="M12 2a2 2 0 0 1 2 2c0 .74-.4 1.39-1 1.73V7h1a7 7 0 0 1 7 7h1a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-1v1a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-1H2a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1h1a7 7 0 0 1 7-7h1V5.73c-.6-.34-1-.99-1-1.73a2 2 0 0 1 2-2z" />
                  <circle cx="8" cy="14" r="1.5" fill="currentColor" />
                  <circle cx="16" cy="14" r="1.5" fill="currentColor" />
                </svg>
              </button>
            )}
            <div className="title-bar-controls">
              <button className="title-bar-btn minimize" onClick={handleMinimize} title={t("titlebar.minimize")}>
                <svg viewBox="0 0 12 12">
                  <rect x="2" y="5.5" width="8" height="1" fill="currentColor" />
                </svg>
              </button>
              <button className="title-bar-btn maximize" onClick={handleMaximize} title={isMaximized ? t("titlebar.restore") : t("titlebar.maximize")}>
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
              <button className="title-bar-btn close" onClick={handleClose} title={t("titlebar.close")}>
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
