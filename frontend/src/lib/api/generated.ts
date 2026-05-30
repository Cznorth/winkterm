/**
 * Auto-generated API hooks (orval from /openapi.json).
 * Regenerate with `npm run gen:api`.
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
