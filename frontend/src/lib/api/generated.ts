/**
 * 自动生成的 API hooks（由 orval 从 /openapi.json 生成）
 * 运行 `npm run gen:api` 可重新生成
 */

import { useMutation, useQuery } from "@tanstack/react-query";
import axiosInstance from "../axios";
import type { AnalyzeRequest, AnalyzeResponse, HistoryResponse } from "@/types";

// ------------------------------------------------------------------
// POST /api/analyze
// ------------------------------------------------------------------

export function useAnalyzeAlert() {
  return useMutation<AnalyzeResponse, Error, AnalyzeRequest>({
    mutationFn: async (body) => {
      const { data } = await axiosInstance.post<AnalyzeResponse>(
        "/api/analyze",
        body
      );
      return data;
    },
  });
}

// ------------------------------------------------------------------
// GET /api/history
// ------------------------------------------------------------------

export function useGetHistory() {
  return useQuery<HistoryResponse, Error>({
    queryKey: ["history"],
    queryFn: async () => {
      const { data } = await axiosInstance.get<HistoryResponse>("/api/history");
      return data;
    },
    refetchInterval: 5000,
  });
}
