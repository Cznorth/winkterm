type MessageHandler = (data: string) => void;
type StatusHandler = (connected: boolean) => void;

const WS_BASE_URL =
  typeof window !== "undefined"
    ? (process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:8000/ws/terminal")
    : "";

const RECONNECT_DELAY_MS = 3000;
const MAX_RECONNECT_ATTEMPTS = 20;

// 调试日志工具
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

// 截断并转义控制字符用于日志
const truncate = (data: string, maxLen = 80): string => {
  const escaped = JSON.stringify(data);
  return escaped.length > maxLen ? escaped.slice(0, maxLen) + '..."' : escaped;
};

/**
 * WebSocket 客户端：纯透传文本。
 *
 * - send(data): 直接发送文本到 WebSocket
 * - onMessage(handler): 接收 PTY 输出文本
 */
export class TerminalWebSocket {
  private ws: WebSocket | null = null;
  private messageHandlers: MessageHandler[] = [];
  private statusHandlers: StatusHandler[] = [];
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionallyClosed = false;
  private sessionId: string;
  // 调试统计
  private _connectTime = 0;
  private _msgCount = 0;
  private _bytesReceived = 0;
  private _bytesSent = 0;

  constructor(sessionId: string = "default") {
    this.sessionId = sessionId;
  }

  private getWsUrl(): string {
    return `${WS_BASE_URL}/${this.sessionId}`;
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
      // 每 100 条消息打印一次统计
      if (this._msgCount % 100 === 0) {
        log.info(
          `[onmessage] 统计: msgs=${this._msgCount}, rx=${this._bytesReceived}B, tx=${this._bytesSent}B`
        );
      }
      // 首几条消息打印详细内容
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
      // 浏览器会同时触发 onclose
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
   * 发送文本到 WebSocket（直接透传）。
   */
  send(data: string): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this._bytesSent += data.length;
      // 首几条消息打印详细内容
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
   * 发送 resize 事件。
   */
  sendResize(cols: number, rows: number): void {
    log.info(`[sendResize] cols=${cols} rows=${rows}`);
    // 格式: ESC[8;rows;colst
    this.send(`\x1b[8;${rows};${cols}t`);
  }

  /**
   * 发送激活消息（通知后端此会话被激活）。
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

// 多实例缓存（按 session_id）
const _instances: Map<string, TerminalWebSocket> = new Map();

export function getWebSocket(sessionId: string = "default"): TerminalWebSocket {
  if (!_instances.has(sessionId)) {
    _instances.set(sessionId, new TerminalWebSocket(sessionId));
  }
  return _instances.get(sessionId)!;
}

export function closeWebSocket(sessionId: string): void {
  const instance = _instances.get(sessionId);
  if (instance) {
    instance.disconnect();
    _instances.delete(sessionId);
  }
}
