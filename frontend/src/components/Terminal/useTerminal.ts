import { useEffect, useRef, useCallback } from "react";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import type { SerializeAddon } from "@xterm/addon-serialize";
import { getWebSocket } from "@/lib/websocket";
import axios from "@/lib/axios";

const DEBUG = process.env.NODE_ENV === "development";
const SCREEN_SYNC_DELAY = 200; // 防抖延迟（毫秒）

export function useTerminal(
  containerRef: React.RefObject<HTMLDivElement | null>,
  sessionId: string = "default",
  isActive: boolean = true,
  terminalType: "local" | "ssh" = "local",
  sshConnectionId?: string
) {
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const serializeAddonRef = useRef<SerializeAddon | null>(null);
  const wsRef = useRef(getWebSocket(sessionId, terminalType, sshConnectionId));
  const initRef = useRef(false);
  const screenSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 保存清理函数
  const unsubRef = useRef<{ msg?: () => void; status?: () => void }>({});

  const init = useCallback(async () => {
    if (initRef.current) return;
    if (!containerRef.current) return;

    // 检查容器是否有有效尺寸
    if (containerRef.current.offsetWidth === 0 || containerRef.current.offsetHeight === 0) {
      DEBUG && console.log(`[useTerminal] 容器尺寸为 0，跳过初始化, sessionId=${sessionId}`);
      initRef.current = false; // 允许稍后重试
      return;
    }

    initRef.current = true;
    DEBUG && console.log(`[useTerminal] 开始初始化, sessionId=${sessionId}, type=${terminalType}`);

    // 动态导入
    const { Terminal } = await import("@xterm/xterm");
    const { FitAddon } = await import("@xterm/addon-fit");
    const { WebLinksAddon } = await import("@xterm/addon-web-links");
    const { SerializeAddon } = await import("@xterm/addon-serialize");

    // VS Code 风格终端主题
    const term = new Terminal({
      theme: {
        background: "#1e1e1e",
        foreground: "#d4d4d4",
        cursor: "#aeafad",
        cursorAccent: "#1e1e1e",
        selectionBackground: "#264f78",
        black: "#1e1e1e",
        brightBlack: "#6e6e6e",
        red: "#f14c4c",
        brightRed: "#f14c4c",
        green: "#23d18b",
        brightGreen: "#3fcf8e",
        yellow: "#e2e084",
        brightYellow: "#e2e084",
        blue: "#3794ff",
        brightBlue: "#3794ff",
        magenta: "#c586c0",
        brightMagenta: "#d679d1",
        cyan: "#4ec9b0",
        brightCyan: "#4ec9b0",
        white: "#d4d4d4",
        brightWhite: "#d4d4d4",
      },
      fontFamily: "'Cascadia Code', 'Fira Code', 'JetBrains Mono', Consolas, monospace",
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
    // 自定义链接处理器：通过后端 API 在系统浏览器中打开
    term.loadAddon(new WebLinksAddon((_event: MouseEvent, uri: string) => {
      axios.post("/api/open-url", { url: uri }).catch((e) => {
        console.error("打开链接失败:", e);
      });
    }));
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
        term.write("\r\n\x1b[33m[WinkTerm] 断开，重连中...\x1b[0m\r\n");
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
  }, [containerRef, sessionId, terminalType, sshConnectionId]);

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

  // 激活会话（当标签页切换为激活状态时）
  useEffect(() => {
    if (isActive && wsRef.current.isConnected) {
      wsRef.current.sendActivate();
    }
  }, [isActive]);

  // 手动触发 fit（用于布局切换后）
  const fit = useCallback(() => {
    if (fitAddonRef.current && termRef.current) {
      // 始终执行 fit，即使容器不可见
      try {
        fitAddonRef.current.fit();
        const { cols, rows } = termRef.current;
        wsRef.current.sendResize(cols, rows);
        DEBUG && console.log(`[useTerminal] fit 完成, sessionId=${sessionId}, cols=${cols}, rows=${rows}`);
      } catch (e) {
        // 容器不可见时可能会报错，忽略
        DEBUG && console.log(`[useTerminal] fit 失败（容器可能不可见）, sessionId=${sessionId}`, e);
      }
    }
  }, [sessionId]);

  // 使用指定的尺寸发送 resize（用于隐藏的终端）
  const fitWithSize = useCallback((cols: number, rows: number) => {
    if (termRef.current && wsRef.current.isConnected) {
      wsRef.current.sendResize(cols, rows);
      DEBUG && console.log(`[useTerminal] fitWithSize 完成, sessionId=${sessionId}, cols=${cols}, rows=${rows}`);
    }
  }, [sessionId]);

  return { init, term: termRef, fit, fitWithSize };
}
