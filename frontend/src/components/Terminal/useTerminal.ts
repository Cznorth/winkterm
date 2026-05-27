import { useEffect, useRef, useCallback } from "react";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import type { SerializeAddon } from "@xterm/addon-serialize";
import { getWebSocket } from "@/lib/websocket";
import { xtermDarkTheme, xtermLightTheme } from "@/lib/theme";
import axios from "@/lib/axios";

const DEBUG = process.env.NODE_ENV === "development";
const SCREEN_SYNC_DELAY = 200; // 防抖延迟（毫秒）

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

/** 在用户手势（keydown）内同步写入剪贴板；async clipboard API 失败会被 silent catch */
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

    // import 期间容器可能已被父组件 (SplitContainer) 切到 display:none
    // (例如 agent 一次创建多个终端,中间 tab 短暂激活又失活)。
    // 此时继续 init 会在 0-dim 容器上 open xterm + fit,xterm.cols 被算成
    // 异常小值。回退,等容器再次可见时 ResizeObserver 重试 init。
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
    // 自定义链接处理器：通过后端 API 在系统浏览器中打开
    term.loadAddon(new WebLinksAddon((_event: MouseEvent, uri: string) => {
      axios.post("/api/open-url", { url: uri }).catch((e) => {
        console.error("打开链接失败:", e);
      });
    }));
    term.open(containerRef.current);
    fitAddon.fit();

    // 有选区时 Ctrl/Cmd+C 复制到剪贴板，不发送 SIGINT (\x03)
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

    // 键盘输入 → WebSocket
    term.onData((data) => {
      // 检测回车键：在发送用户输入之前，先同步屏幕内容
      // 这样后端可以在命令执行前捕获到用户输入的命令
      if (data === '\r' || data === '\n' || data === '\r\n') {
        if (serializeAddonRef.current) {
          const screenContent = serializeAddonRef.current.serialize();
          wsRef.current.send(`\x1b[?9999;screen;${encodeURIComponent(screenContent)}h`);
        }
      }
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
        // 不再往 xterm 写"断开/重连中"提示:后端 ws_handler 重连时会回放
        // session._raw / screen_content,中间插一行黄字会让 PSReadLine 的
        // 光标定位错乱(prompt 重画后还在旧的光标坐标上覆盖)。
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

  // 手机端/桌面切换时更新字号并 refit
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

  // 主题变化时更新 xterm 主题
  useEffect(() => {
    if (termRef.current) {
      termRef.current.options.theme = resolvedTheme === "light" ? xtermLightTheme : xtermDarkTheme;
    }
  }, [resolvedTheme]);

  // resize 监听 - 用 ResizeObserver 监听容器尺寸变化
  useEffect(() => {
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;

    const handleResize = () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (!fitAddonRef.current || !termRef.current || !containerRef.current) return;
        // 容器隐藏/过小(如 tab 切换到其他 pane 时 display:none)绝不 fit。
        // 否则 fitAddon 用 0 维容器算出来的 cols 会把 xterm 缩成 2 之类,
        // 等切回来 xterm 还残留小 cols → prompt 显示截断。
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
    if (!fitAddonRef.current || !termRef.current || !containerRef.current) return;
    const el = containerRef.current;
    // 容器过小/不可见时不 fit,避免 xterm.cols 被算成异常小值
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

  // 使用指定的尺寸发送 resize（用于隐藏的终端）
  const fitWithSize = useCallback((cols: number, rows: number) => {
    if (termRef.current && wsRef.current.isConnected) {
      wsRef.current.sendResize(cols, rows);
      DEBUG && console.log(`[useTerminal] fitWithSize 完成, sessionId=${sessionId}, cols=${cols}, rows=${rows}`);
    }
  }, [sessionId]);

  return { init, term: termRef, fit, fitWithSize };
}
