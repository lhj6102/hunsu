import { useQuery } from "@tanstack/react-query";
import { fetchBridgeStatus } from "@/shared/api/bridgeClient";
import type { BridgeStatusResponse } from "@/shared/api/bridgeTypes";

export const BRIDGE_STATUS_QUERY_KEY = ["bridge", "status"] as const;

export function useBridgeStatus({ enabled = true, intervalMs = 2500 }: { enabled?: boolean; intervalMs?: number } = {}): {
  data?: BridgeStatusResponse;
  status: "checking" | "online" | "offline";
  error?: string;
  refetch: () => void;
} {
  const query = useQuery({
    queryKey: BRIDGE_STATUS_QUERY_KEY,
    queryFn: fetchBridgeStatus,
    enabled,
    refetchInterval: enabled ? intervalMs : false
  });
  if (!enabled) {
    return { status: "offline", refetch: () => undefined };
  }
  if (query.isError) {
    return {
      data: query.data,
      status: "offline",
      error: query.error instanceof Error ? query.error.message : "Bridge status is unavailable.",
      refetch: () => {
        void query.refetch();
      }
    };
  }
  if (query.isLoading && !query.data) {
    return {
      status: "checking",
      refetch: () => {
        void query.refetch();
      }
    };
  }
  return {
    data: query.data,
    status: query.data ? "online" : "checking",
    refetch: () => {
      void query.refetch();
    }
  };
}
