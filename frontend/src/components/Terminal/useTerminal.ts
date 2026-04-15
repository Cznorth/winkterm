import { useEffect, useRef, useCallback } from "react";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import type { SerializeAddon } from "@xterm/addon-serialize";
import { getWebSocket } from "@/lib/websocket";

const DEBUG = process.env.NODE_ENV === "development";
const SCREEN_SYNC_DELAY = 200; // 防抖延迟（毫秒）

export function useTerminal(containerRef: React.RefObject<HTMLDivElement | null>) {
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const serializeAddonRef = useRef<SerializeAddon | null>(null);
  const wsRef = useRef(getWebSocket());
  const initRef = useRef(false);
  const screenSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 保存清理函数
  const unsubRef = useRef<{ msg?: () => void; status?: () => void }>({});

  const init = useCallback(async () => {
    if (initRef.current) return;
    if (!containerRef.current) return;

    initRef.current = true;
    DEBUG && console.log("[useTerminal] 开始初始化");

    // 动态导入
    const { Terminal } = await import("@xterm/xterm");
    const { FitAddon } = await import("@xterm/addon-fit");
    const { WebLinksAddon } = await import("@xterm/addon-web-links");
    const { SerializeAddon } = await import("@xterm/addon-serialize");

    const term = new Terminal({
      theme: {
        background: "#1a1a2e",
        foreground: "#e0e0e0",
        cursor: "#00ff88",
        cursorAccent: "#1a1a2e",
        black: "#1a1a2e",
        brightBlack: "#555",
        red: "#ff5555",
        brightRed: "#ff6e6e",
        green: "#50fa7b",
        brightGreen: "#69ff94",
        yellow: "#f1fa8c",
        brightYellow: "#ffffa5",
        blue: "#6272a4",
        brightBlue: "#d6acff",
        magenta: "#ff79c6",
        brightMagenta: "#ff92df",
        cyan: "#8be9fd",
        brightCyan: "#a4ffff",
        white: "#f8f8f2",
        brightWhite: "#ffffff",
      },
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
      fontSize: 14,
      lineHeight: 1.4,
      cursorBlink: true,
      cursorStyle: "bar",
      allowProposedApi: true,
      scrollback: 5000,
    });

    const fitAddon = new FitAddon();
    const serializeAddon = new SerializeAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(serializeAddon);
    term.loadAddon(new WebLinksAddon());
    term.open(containerRef.current);
    fitAddon.fit();

    termRef.current = term;
    fitAddonRef.current = fitAddon;
    serializeAddonRef.current = serializeAddon;

    // 键盘输入 → WebSocket
    term.onData((data) => {
      wsRef.current.send(data);
    });

    term.focus();

    // 清理之前的 handler
    if (unsubRef.current.msg) unsubRef.current.msg();
    if (unsubRef.current.status) unsubRef.current.status();

    // 初始化 WebSocket
    const ws = wsRef.current;
    const { cols, rows } = term;

    unsubRef.current.msg = ws.onMessage((data: string) => {
      term.write(data);
      // 每次输出后同步屏幕内容（防抖）
      if (screenSyncTimerRef.current) {
        clearTimeout(screenSyncTimerRef.current);
      }
      screenSyncTimerRef.current = setTimeout(() => {
        if (serializeAddonRef.current && termRef.current) {
          const screenContent = serializeAddonRef.current.serialize({ rows: termRef.current.rows });
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
        term.write("\r\n\x1b[31m[WinkTerm] 断开，重连中...\x1b[0m\r\n");
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

    DEBUG && console.log("[useTerminal] 初始化完成, cols=", cols, "rows=", rows);
  }, [containerRef]);

  // resize 监听
  useEffect(() => {
    const handleResize = () => {
      if (fitAddonRef.current && termRef.current) {
        fitAddonRef.current.fit();
        const { cols, rows } = termRef.current;
        wsRef.current.sendResize(cols, rows);
      }
    };

    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  // 清理
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

  return { init, term: termRef };
}
