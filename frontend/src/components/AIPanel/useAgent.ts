import { useGetHistory } from "@/lib/api";
import type { HistoryItem } from "@/types";

export function useAgent() {
  const { data, isLoading, error } = useGetHistory();

  const history: HistoryItem[] = data?.history ?? [];

  return { history, isLoading, error };
}
