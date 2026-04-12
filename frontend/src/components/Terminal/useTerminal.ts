import { useEffect, useRef, useCallback } from "react";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import { getWebSocket } from "@/lib/websocket";
import type { WsMessage } from "@/types";

export function useTerminal(containerRef: React.RefObject<HTMLDivElement | null>) {
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const wsRef = useRef(getWebSocket());

  // 初始化 xterm
  const initTerminal = useCallback(async () => {
    if (!containerRef.current || termRef.current) return;

    // 动态导入避免 SSR 问题
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
    term.onData((data: string) => {
      wsRef.current.send({ type: "input", data });
    });

    return { term, fitAddon };
  }, [containerRef]);

  // WebSocket 消息处理
  useEffect(() => {
    const ws = wsRef.current;

    const unsubMsg = ws.onMessage((msg: WsMessage) => {
      if (msg.type === "output" && termRef.current) {
        termRef.current.write(msg.data);
      }
    });

    const unsubStatus = ws.onStatus((connected: boolean) => {
      if (!termRef.current) return;
      if (connected) {
        termRef.current.write("\r\n\x1b[32m[WinkTerm] 已连接\x1b[0m\r\n");
      } else {
        termRef.current.write("\r\n\x1b[31m[WinkTerm] 连接断开，正在重连...\x1b[0m\r\n");
      }
    });

    ws.connect();

    return () => {
      unsubMsg();
      unsubStatus();
      ws.disconnect();
    };
  }, []);

  // resize 监听
  useEffect(() => {
    const handleResize = () => {
      if (fitAddonRef.current && termRef.current) {
        fitAddonRef.current.fit();
        const { cols, rows } = termRef.current;
        wsRef.current.send({ type: "resize", cols, rows });
      }
    };

    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  const init = useCallback(async () => {
    await initTerminal();
  }, [initTerminal]);

  return { init, term: termRef };
}
