// ------------------------------------------------------------------
// HTTP API types (kept for AI analysis features)
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
