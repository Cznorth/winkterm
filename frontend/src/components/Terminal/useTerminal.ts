import { useEffect, useRef, useCallback } from "react";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import type { SerializeAddon } from "@xterm/addon-serialize";
import { getWebSocket } from "@/lib/websocket";
import { xtermDarkTheme, xtermLightTheme } from "@/lib/theme";
import axios from "@/lib/axios";

const DEBUG = process.env.NODE_ENV === "development";
const SCREEN_SYNC_DELAY = 200; // Debounce delay (ms)

const DESKTOP_FONT_SIZE = 14;
const MOBILE_FONT_SIZE = 11;
const DESKTOP_LINE_HEIGHT = 1.4;
const MOBILE_LINE_HEIGHT = 1.15;

function getTerminalFontSettings(isCompact: boolean) {
  const mobile =
    isCompact ||
    (typeof window !== "undefined" && window.matchMedia("(max-width: 768px)").matches);
  return {
    fontSize: mobile ? MOBILE_FONT_SIZE : DESKTOP_FONT_SIZE,
    lineHeight: mobile ? MOBILE_LINE_HEIGHT : DESKTOP_LINE_HEIGHT,
  };
}

/** Sync write to clipboard within user gesture (keydown); async clipboard API failures are silently caught */
function syncCopyText(text: string): boolean {
  const el = document.createElement("textarea");
  el.value = text;
  el.setAttribute("readonly", "");
  el.style.cssText = "position:fixed;left:-9999px;opacity:0";
  document.body.appendChild(el);
  el.select();
  el.setSelectionRange(0, text.length);
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } finally {
    document.body.removeChild(el);
  }
  return ok;
}

export function useTerminal(
  containerRef: React.RefObject<HTMLDivElement | null>,
  sessionId: string = "default",
  isActive: boolean = true,
  terminalType: "local" | "ssh" = "local",
  sshConnectionId?: string,
  resolvedTheme: "dark" | "light" = "dark",
  isCompact: boolean = false
) {
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const serializeAddonRef = useRef<SerializeAddon | null>(null);
  const wsRef = useRef(getWebSocket(sessionId, terminalType, sshConnectionId));
  const initRef = useRef(false);
  const screenSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Store cleanup functions
  const unsubRef = useRef<{ msg?: () => void; status?: () => void }>({});

  const init = useCallback(async () => {
    if (initRef.current) return;
    if (!containerRef.current) return;

    // Check container has valid dimensions
    if (containerRef.current.offsetWidth === 0 || containerRef.current.offsetHeight === 0) {
      DEBUG && console.log(`[useTerminal] 容器尺寸为 0，跳过初始化, sessionId=${sessionId}`);
      initRef.current = false; // Allow retry later
      return;
    }

    initRef.current = true;
    DEBUG && console.log(`[useTerminal] 开始初始化, sessionId=${sessionId}, type=${terminalType}`);

    // Dynamic import
    const { Terminal } = await import("@xterm/xterm");
    const { FitAddon } = await import("@xterm/addon-fit");
    const { WebLinksAddon } = await import("@xterm/addon-web-links");
    const { SerializeAddon } = await import("@xterm/addon-serialize");

    // During import the container may have been hidden (display:none) by the parent
    // (SplitContainer), e.g. when the agent creates multiple terminals and an intermediate
    // tab is briefly activated then deactivated. Continuing init would open xterm + fit
    // on a zero-dim container, yielding abnormally small xterm.cols. Bail out and let
    // ResizeObserver retry init when the container becomes visible again.
    if (
      !containerRef.current ||
      containerRef.current.offsetWidth === 0 ||
      containerRef.current.offsetHeight === 0
    ) {
      DEBUG && console.log(`[useTerminal] import 后容器已不可见,放弃 init, sessionId=${sessionId}`);
      initRef.current = false;
      return;
    }

    const { fontSize, lineHeight } = getTerminalFontSettings(isCompact);
    const term = new Terminal({
      theme: resolvedTheme === "light" ? xtermLightTheme : xtermDarkTheme,
      fontFamily: "'Cascadia Code', 'Fira Code', 'JetBrains Mono', Consolas, monospace",
      fontSize,
      lineHeight,
      cursorBlink: true,
      cursorStyle: "bar",
      allowProposedApi: true,
      scrollback: 5000,
    });

    const fitAddon = new FitAddon();
    const serializeAddon = new SerializeAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(serializeAddon);
    // Custom link handler: open in system browser via backend API
    term.loadAddon(new WebLinksAddon((_event: MouseEvent, uri: string) => {
      axios.post("/api/open-url", { url: uri }).catch((e) => {
        console.error("打开链接失败:", e);
      });
    }));
    term.open(containerRef.current);
    fitAddon.fit();

    // When selection exists, Ctrl/Cmd+C copies to clipboard instead of sending SIGINT (\x03)
    term.attachCustomKeyEventHandler((event: KeyboardEvent) => {
      if (event.type !== "keydown") return true;
      const isCopyKey =
        (event.ctrlKey || event.metaKey) &&
        !event.shiftKey &&
        !event.altKey &&
        (event.key === "c" || event.key === "C" || event.code === "KeyC");
      if (!isCopyKey) return true;

      const selection = term.getSelection();
      if (!selection) return true;

      event.preventDefault();
      if (!syncCopyText(selection) && navigator.clipboard?.writeText) {
        void navigator.clipboard.writeText(selection).catch(() => {});
      }
      return false;
    });

    termRef.current = term;
    fitAddonRef.current = fitAddon;
    serializeAddonRef.current = serializeAddon;

    // Keyboard input → WebSocket
    term.onData((data) => {
      // Detect Enter: sync screen content before sending user input so the backend
      // can capture the command before execution
      if (data === '\r' || data === '\n' || data === '\r\n') {
        if (serializeAddonRef.current) {
          const screenContent = serializeAddonRef.current.serialize();
          wsRef.current.send(`\x1b[?9999;screen;${encodeURIComponent(screenContent)}h`);
        }
      }
      wsRef.current.send(data);
    });

    term.focus();

    // Clean up previous handlers
    if (unsubRef.current.msg) unsubRef.current.msg();
    if (unsubRef.current.status) unsubRef.current.status();

    // Initialize WebSocket
    const ws = wsRef.current;
    const { cols, rows } = term;

    unsubRef.current.msg = ws.onMessage((data: string) => {
      term.write(data);
      // Sync screen content after each output (debounced)
      if (screenSyncTimerRef.current) {
        clearTimeout(screenSyncTimerRef.current);
      }
      screenSyncTimerRef.current = setTimeout(() => {
        if (serializeAddonRef.current && termRef.current) {
          const screenContent = serializeAddonRef.current.serialize();
          ws.send(`\x1b[?9999;screen;${encodeURIComponent(screenContent)}h`);
        }
      }, SCREEN_SYNC_DELAY);
    });

    let resizeOnConnect: (() => void) | null = () => {
      ws.sendResize(cols, rows);
      DEBUG && console.log("[useTerminal] 连接后发送 resize:", cols, rows);
    };

    unsubRef.current.status = ws.onStatus((connected: boolean) => {
      if (connected) {
        if (resizeOnConnect) {
          resizeOnConnect();
          resizeOnConnect = null;
        }
      } else {
        // Do not write "disconnected/reconnecting" text into xterm: on reconnect the
        // backend ws_handler replays session._raw / screen_content; inserting a yellow
        // line in between breaks PSReadLine cursor positioning (overwrites at stale coords
        // after prompt redraw).
        resizeOnConnect = () => {
          if (termRef.current) {
            const { cols, rows } = termRef.current;
            ws.sendResize(cols, rows);
          }
        };
      }
    });

    ws.reset();
    ws.connect();

    DEBUG && console.log(`[useTerminal] 初始化完成, sessionId=${sessionId}, type=${terminalType}, cols=`, cols, "rows=", rows);
  }, [containerRef, sessionId, terminalType, sshConnectionId, isCompact, resolvedTheme]);

  // Update font size and refit on mobile/desktop switch
  useEffect(() => {
    const term = termRef.current;
    const fitAddon = fitAddonRef.current;
    const el = containerRef.current;
    if (!term || !fitAddon || !el) return;

    const { fontSize, lineHeight } = getTerminalFontSettings(isCompact);
    if (term.options.fontSize === fontSize && term.options.lineHeight === lineHeight) return;

    term.options.fontSize = fontSize;
    term.options.lineHeight = lineHeight;

    if (el.clientWidth < 100 || el.clientHeight < 50) return;
    try {
      fitAddon.fit();
      const { cols, rows } = term;
      if (cols >= 20 && rows >= 5) {
        wsRef.current.sendResize(cols, rows);
      }
    } catch {
      // ignore fit errors during transitions
    }
  }, [isCompact, containerRef]);

  // Update xterm theme when theme changes
  useEffect(() => {
    if (termRef.current) {
      termRef.current.options.theme = resolvedTheme === "light" ? xtermLightTheme : xtermDarkTheme;
    }
  }, [resolvedTheme]);

  // Resize listener - use ResizeObserver to watch container size changes
  useEffect(() => {
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;

    const handleResize = () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (!fitAddonRef.current || !termRef.current || !containerRef.current) return;
        // Never fit when container is hidden or too small (e.g. display:none when tab
        // switches to another pane). Otherwise fitAddon computes cols from zero-dim
        // container (e.g. 2), and stale small cols truncate the prompt after switching back.
        const el = containerRef.current;
        if (el.clientWidth < 100 || el.clientHeight < 50) return;
        try {
          fitAddonRef.current.fit();
          const { cols, rows } = termRef.current;
          if (cols >= 20 && rows >= 5) {
            wsRef.current.sendResize(cols, rows);
          }
        } catch (e) {
          // ignore fit errors during transitions
        }
      }, 50);
    };

    window.addEventListener("resize", handleResize);

    const resizeObserver = new ResizeObserver(handleResize);
    if (containerRef.current) {
      resizeObserver.observe(containerRef.current);
    }

    return () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      window.removeEventListener("resize", handleResize);
      resizeObserver.disconnect();
    };
  }, []);

  // Cleanup
  useEffect(() => {
    return () => {
      if (screenSyncTimerRef.current) {
        clearTimeout(screenSyncTimerRef.current);
      }
      if (unsubRef.current.msg) unsubRef.current.msg();
      if (unsubRef.current.status) unsubRef.current.status();
      wsRef.current.disconnect();
    };
  }, []);

  // Activate session when tab becomes active
  useEffect(() => {
    if (isActive && wsRef.current.isConnected) {
      wsRef.current.sendActivate();
    }
  }, [isActive]);

  // Manually trigger fit (after layout changes)
  const fit = useCallback(() => {
    if (!fitAddonRef.current || !termRef.current || !containerRef.current) return;
    const el = containerRef.current;
    // Skip fit when container is too small/hidden to avoid abnormal xterm.cols
    if (el.clientWidth < 100 || el.clientHeight < 50) {
      DEBUG && console.log(`[useTerminal] 容器过小跳过 fit, sessionId=${sessionId}, w=${el.clientWidth}, h=${el.clientHeight}`);
      return;
    }
    try {
      fitAddonRef.current.fit();
      const { cols, rows } = termRef.current;
      if (cols >= 20 && rows >= 5) {
        wsRef.current.sendResize(cols, rows);
        DEBUG && console.log(`[useTerminal] fit 完成, sessionId=${sessionId}, cols=${cols}, rows=${rows}`);
      } else {
        DEBUG && console.log(`[useTerminal] fit 结果异常 cols=${cols} rows=${rows},不发 resize`);
      }
    } catch (e) {
      DEBUG && console.log(`[useTerminal] fit 失败, sessionId=${sessionId}`, e);
    }
  }, [containerRef, sessionId]);

  // Send resize with specified dimensions (for hidden terminals)
  const fitWithSize = useCallback((cols: number, rows: number) => {
    if (termRef.current && wsRef.current.isConnected) {
      wsRef.current.sendResize(cols, rows);
      DEBUG && console.log(`[useTerminal] fitWithSize 完成, sessionId=${sessionId}, cols=${cols}, rows=${rows}`);
    }
  }, [sessionId]);

  const sendInput = useCallback((data: string) => {
    termRef.current?.input(data);
  }, []);

  return { init, term: termRef, fit, fitWithSize, sendInput };
}
