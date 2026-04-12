// WebSocket 消息联合类型

export interface WsInputMessage {
  type: "input";
  data: string;
}

export interface WsOutputMessage {
  type: "output";
  data: string;
}

export interface WsAnalyzeMessage {
  type: "analyze";
  data: string;
}

export interface WsResizeMessage {
  type: "resize";
  cols: number;
  rows: number;
}

/** 后端推送给前端的 AI 分析结果（保留，用于 HTTP 轮询） */
export interface WsAiMessage {
  type: "ai";
  data: string;
  timestamp: string;
}

export type WsMessage =
  | WsInputMessage
  | WsOutputMessage
  | WsAnalyzeMessage
  | WsResizeMessage
  | WsAiMessage;

// ------------------------------------------------------------------
// HTTP API 类型
// ------------------------------------------------------------------

export interface AnalyzeRequest {
  message: string;
  terminal_context?: string;
}

export interface AnalyzeResponse {
  result: string;
  timestamp: string;
}

export interface HistoryItem {
  message: string;
  result: string;
  timestamp: string;
}

export interface HistoryResponse {
  history: HistoryItem[];
  total: number;
}
