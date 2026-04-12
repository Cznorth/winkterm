import { useEffect, useRef, useCallback } from "react";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import { getWebSocket } from "@/lib/websocket";

const DEBUG = process.env.NODE_ENV === "development";

export function useTerminal(containerRef: React.RefObject<HTMLDivElement | null>) {
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const wsRef = useRef(getWebSocket());
  const initRef = useRef(false);

  const init = useCallback(async () => {
    if (initRef.current) return;
    if (!containerRef.current) return;

    initRef.current = true;
    DEBUG && console.log("[useTerminal] 开始初始化");

    // 动态导入
    const { Terminal } = await import("@xterm/xterm");
    const { FitAddon } = await import("@xterm/addon-fit");
    const { WebLinksAddon } = await import("@xterm/addon-web-links");

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
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon());
    term.open(containerRef.current);
    fitAddon.fit();

    termRef.current = term;
    fitAddonRef.current = fitAddon;

    // 键盘输入 → WebSocket
    term.onData((data) => {
      wsRef.current.send(data);
    });

    term.focus();

    // 初始化 WebSocket
    const ws = wsRef.current;
    const { cols, rows } = term;

    ws.onMessage((data: string) => {
      term.write(data);
    });

    ws.onStatus((connected: boolean) => {
      if (!connected) {
        term.write("\r\n\x1b[31m[WinkTerm] 断开，重连中...\x1b[0m\r\n");
      }
    });

    ws.reset();
    ws.connect();

    // 延迟发送 resize，确保 PTY 已启动
    requestAnimationFrame(() => {
      ws.sendResize(cols, rows);
    });

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
      wsRef.current.disconnect();
    };
  }, []);

  return { init, term: termRef };
}
