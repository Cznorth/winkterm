// ------------------------------------------------------------------
// HTTP API 类型（保留，用于 AI 分析功能）
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
