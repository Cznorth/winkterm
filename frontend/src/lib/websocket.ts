import { WsMessage } from "@/types";

type MessageHandler = (msg: WsMessage) => void;
type StatusHandler = (connected: boolean) => void;

const WS_URL =
  typeof window !== "undefined"
    ? (process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:8000/ws/terminal")
    : "";

const RECONNECT_DELAY_MS = 3000;
const MAX_RECONNECT_ATTEMPTS = 20;

export class TerminalWebSocket {
  private ws: WebSocket | null = null;
  private messageHandlers: MessageHandler[] = [];
  private statusHandlers: StatusHandler[] = [];
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** 标记是否由用户主动断开，断开时设为 true，connect() 时重置为 false */
  private userDisconnect = true;

  connect(): void {
    this.userDisconnect = false;
    this._connect();
  }

  private _connect(): void {
    if (!WS_URL) return;

    // 清理旧连接（不清 userDisconnect，保持重连能力）
    this._cleanupWs();

    let ws: WebSocket;
    try {
      ws = new WebSocket(WS_URL);
    } catch (err) {
      console.error("[WS] 创建失败:", err);
      this._notifyStatus(false);
      return;
    }

    ws.onopen = () => {
      this.reconnectAttempts = 0;
      this._notifyStatus(true);
    };

    ws.onmessage = (event: MessageEvent<string>) => {
      try {
        const msg: WsMessage = JSON.parse(event.data);
        this._notifyMessage(msg);
      } catch {
        // ignore parse error
      }
    };

    ws.onclose = (event: CloseEvent) => {
      this._notifyStatus(false);
      // 非主动断开且非正常关闭码时重连
      if (!this.userDisconnect && event.code !== 1000) {
        this._scheduleReconnect();
      }
    };

    ws.onerror = () => {
      // onerror 总会触发 onclose，这里不需要额外处理
    };

    this.ws = ws;
  }

  private _scheduleReconnect(): void {
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      console.warn("[WS] 达到最大重连次数");
      return;
    }
    this.reconnectAttempts++;
    console.log(`[WS] ${this.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} 次重连...`);
    this.reconnectTimer = setTimeout(
      () => this._connect(),
      RECONNECT_DELAY_MS
    );
  }

  private _cleanupWs(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onclose = null;
      this.ws.onerror = null;
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
  }

  disconnect(): void {
    this.userDisconnect = true;
    this._cleanupWs();
    this._notifyStatus(false);
  }

  send(msg: WsMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
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

  private _notifyMessage(msg: WsMessage): void {
    for (const h of this.messageHandlers) h(msg);
  }

  private _notifyStatus(connected: boolean): void {
    for (const h of this.statusHandlers) h(connected);
  }
}

// 单例，HMR 复用
let _instance: TerminalWebSocket | null = null;

export function getWebSocket(): TerminalWebSocket {
  if (!_instance) {
    _instance = new TerminalWebSocket();
  }
  return _instance;
}
