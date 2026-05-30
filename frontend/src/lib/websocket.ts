import { getWsBaseUrl } from "./config";
import { getAccessKey } from "./auth";

const WS_BASE_URL = typeof window !== "undefined" ? getWsBaseUrl() : "";

type MessageHandler = (data: string) => void;
type StatusHandler = (connected: boolean) => void;

const RECONNECT_DELAY_MS = 3000;
const MAX_RECONNECT_ATTEMPTS = 20;

// Debug logging utilities
const DEBUG = process.env.NODE_ENV === "development";
const log = {
  info: (msg: string, ...args: unknown[]) =>
    DEBUG && console.log(`[WS] ${new Date().toISOString()} ${msg}`, ...args),
  debug: (msg: string, ...args: unknown[]) =>
    DEBUG && console.log(`[WS] ${new Date().toISOString()} ${msg}`, ...args),
  warn: (msg: string, ...args: unknown[]) =>
    console.warn(`[WS] ${new Date().toISOString()} ${msg}`, ...args),
  error: (msg: string, ...args: unknown[]) =>
    console.error(`[WS] ${new Date().toISOString()} ${msg}`, ...args),
};

// Truncate and escape control characters for logging
const truncate = (data: string, maxLen = 80): string => {
  const escaped = JSON.stringify(data);
  return escaped.length > maxLen ? escaped.slice(0, maxLen) + '..."' : escaped;
};

/**
 * WebSocket client: plain text passthrough.
 *
 * - send(data): send text directly to the WebSocket
 * - onMessage(handler): receive PTY output text
 */
export class TerminalWebSocket {
  private ws: WebSocket | null = null;
  private messageHandlers: MessageHandler[] = [];
  private statusHandlers: StatusHandler[] = [];
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionallyClosed = false;
  private sessionId: string;
  private terminalType: "local" | "ssh";
  private sshConnectionId?: string;
  // Debug counters
  private _connectTime = 0;
  private _msgCount = 0;
  private _bytesReceived = 0;
  private _bytesSent = 0;

  constructor(
    sessionId: string = "default",
    terminalType: "local" | "ssh" = "local",
    sshConnectionId?: string
  ) {
    this.sessionId = sessionId;
    this.terminalType = terminalType;
    this.sshConnectionId = sshConnectionId;
  }

  private getWsUrl(): string {
    const baseUrl = `${WS_BASE_URL}/${this.sessionId}`;
    const params = new URLSearchParams();

    if (this.terminalType === "ssh" && this.sshConnectionId) {
      params.set("type", "ssh");
      params.set("connection_id", this.sshConnectionId);
    }

    const accessKey = getAccessKey();
    if (accessKey) {
      params.set("key", accessKey);
    }

    return params.toString() ? `${baseUrl}?${params}` : baseUrl;
  }

  connect(): void {
    this.intentionallyClosed = false;
    if (this.ws?.readyState === WebSocket.OPEN) {
      log.info("[connect] 已连接，跳过");
      return;
    }
    if (
      this.ws?.readyState === WebSocket.CONNECTING ||
      this.ws?.readyState === WebSocket.OPEN
    ) {
      log.info("[connect] 正在连接中，跳过");
      return;
    }
    const wsUrl = this.getWsUrl();
    log.info(`[connect] 开始连接: ${wsUrl}`);
    this._connect(wsUrl);
  }

  private _connect(wsUrl: string): void {
    if (!wsUrl) {
      log.warn("[_connect] WS_URL 为空，跳过");
      return;
    }
    this._cleanupWs();
    this._connectTime = Date.now();
    this._msgCount = 0;
    this._bytesReceived = 0;
    this._bytesSent = 0;

    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl);
      log.info("[_connect] WebSocket 实例已创建");
    } catch (err) {
      log.error("[_connect] 创建失败:", err);
      this._notifyStatus(false);
      return;
    }

    ws.onopen = () => {
      const duration = Date.now() - this._connectTime;
      log.info(`[onopen] 连接成功 (耗时 ${duration}ms)`);
      this.reconnectAttempts = 0;
      this._notifyStatus(true);
    };

    ws.onmessage = (event: MessageEvent<string>) => {
      this._msgCount++;
      this._bytesReceived += event.data.length;
      // Log stats every 100 messages
      if (this._msgCount % 100 === 0) {
        log.info(
          `[onmessage] 统计: msgs=${this._msgCount}, rx=${this._bytesReceived}B, tx=${this._bytesSent}B`
        );
      }
      // Log first few messages in detail
      if (this._msgCount <= 3) {
        log.info(`[onmessage] #${this._msgCount} len=${event.data.length} data=${truncate(event.data)}`);
      }
      this._notifyMessage(event.data);
    };

    ws.onclose = (event: CloseEvent) => {
      const duration = (Date.now() - this._connectTime) / 1000;
      log.info(
        `[onclose] code=${event.code} reason=${event.reason || "(无)"} ` +
          `clean=${event.wasClean} duration=${duration.toFixed(1)}s ` +
          `stats: msgs=${this._msgCount} rx=${this._bytesReceived}B tx=${this._bytesSent}B`
      );
      this._notifyStatus(false);
      if (!this.intentionallyClosed && event.code !== 1000) {
        this._scheduleReconnect();
      }
    };

    ws.onerror = (event: Event) => {
      log.error("[onerror] WebSocket 错误:", event.type);
      // Browser also fires onclose
    };

    this.ws = ws;
  }

  private _scheduleReconnect(): void {
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      log.warn("[_scheduleReconnect] 达到最大重连次数，停止重连");
      return;
    }
    this.reconnectAttempts++;
    log.info(
      `[_scheduleReconnect] ${this.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} ` +
        `延迟 ${RECONNECT_DELAY_MS}ms 后重连`
    );
    this.reconnectTimer = setTimeout(() => this.connect(), RECONNECT_DELAY_MS);
  }

  private _cleanupWs(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
      log.debug("[_cleanupWs] 重连定时器已清除");
    }
    if (this.ws) {
      const state = ["CONNECTING", "OPEN", "CLOSING", "CLOSED"][this.ws.readyState];
      log.info(`[_cleanupWs] 清理 WebSocket (state=${state})`);
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onclose = null;
      this.ws.onerror = null;
      try {
        this.ws.close();
      } catch (e) {
        log.warn("[_cleanupWs] close 异常:", e);
      }
      this.ws = null;
    }
  }

  disconnect(): void {
    log.info("[disconnect] 主动断开连接");
    this.intentionallyClosed = true;
    this._cleanupWs();
    this._notifyStatus(false);
  }

  reset(): void {
    log.info("[reset] 重置重连计数器");
    this.intentionallyClosed = false;
    this.reconnectAttempts = 0;
  }

  /**
   * Send text to the WebSocket (direct passthrough).
   */
  send(data: string): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this._bytesSent += data.length;
      // Log first few messages in detail
      if (this._bytesSent <= 200) {
        log.info(`[send] len=${data.length} data=${truncate(data)}`);
      }
      this.ws.send(data);
    } else {
      const state = this.ws ? ["CONNECTING", "OPEN", "CLOSING", "CLOSED"][this.ws.readyState] : "null";
      log.warn(`[send] 未连接 (state=${state})，丢弃数据 len=${data.length}`);
    }
  }

  /**
   * Send a resize event.
   */
  sendResize(cols: number, rows: number): void {
    log.info(`[sendResize] cols=${cols} rows=${rows}`);
    // Format: ESC[8;rows;colst
    this.send(`\x1b[8;${rows};${cols}t`);
  }

  /**
   * Send an activate message (notify backend this session is active).
   */
  sendActivate(): void {
    log.info(`[sendActivate] session=${this.sessionId}`);
    this.send(`\x1b[?9999;activateh`);
  }

  onMessage(handler: MessageHandler): () => void {
    this.messageHandlers.push(handler);
    return () => {
      this.messageHandlers = this.messageHandlers.filter((h) => h !== handler);
    };
  }

  onStatus(handler: StatusHandler): () => void {
    this.statusHandlers.push(handler);
    return () => {
      this.statusHandlers = this.statusHandlers.filter((h) => h !== handler);
    };
  }

  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private _notifyMessage(data: string): void {
    for (const h of this.messageHandlers) h(data);
  }

  private _notifyStatus(connected: boolean): void {
    for (const h of this.statusHandlers) h(connected);
  }
}

// Multi-instance cache keyed by session_id
const _instances: Map<string, TerminalWebSocket> = new Map();

export function getWebSocket(
  sessionId: string = "default",
  terminalType: "local" | "ssh" = "local",
  sshConnectionId?: string
): TerminalWebSocket {
  // For SSH connections, use a distinct cache key (includes connection_id)
  const cacheKey = terminalType === "ssh" && sshConnectionId
    ? `${sessionId}:ssh:${sshConnectionId}`
    : sessionId;

  if (!_instances.has(cacheKey)) {
    _instances.set(cacheKey, new TerminalWebSocket(sessionId, terminalType, sshConnectionId));
  }
  return _instances.get(cacheKey)!;
}

export function closeWebSocket(sessionId: string): void {
  // Find and close all instances whose key starts with this sessionId
  for (const [key, instance] of _instances.entries()) {
    if (key === sessionId || key.startsWith(`${sessionId}:`)) {
      instance.disconnect();
      _instances.delete(key);
    }
  }
}
