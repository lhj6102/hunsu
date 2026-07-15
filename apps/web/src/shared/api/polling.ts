import type { QueryClient } from "@tanstack/react-query";

type PollingQuerySnapshot<TData> = {
  state: {
    data: TData | undefined;
    status: "pending" | "error" | "success";
    errorUpdateCount: number;
    error?: unknown;
  };
};

type AdaptivePollingCadence<TData> = {
  activeIntervalMs: number;
  stableIntervalMs: number | false;
  isActive: (data: TData) => boolean;
};

export const PROJECT_QUERY_ROOT = ["projects"] as const;

function canAutoRefresh<TData>(query: PollingQuerySnapshot<TData>): boolean {
  return query.state.errorUpdateCount === 0 || query.state.status === "success";
}

export function readQueryOptions<TData = unknown>() {
  return {
    retry: false as const,
    retryOnMount: false as const,
    refetchOnMount: canAutoRefresh<TData>,
    refetchOnReconnect: canAutoRefresh<TData>
  };
}

export function pollingQueryOptions<TData = unknown>(cadence: number | AdaptivePollingCadence<TData>) {
  return {
    ...readQueryOptions<TData>(),
    refetchInterval: (query: PollingQuerySnapshot<TData>): number | false => {
      if (!canAutoRefresh(query)) return retryAfterInterval(query.state.error);
      if (typeof cadence === "number") return cadence;
      const data = query.state.data;
      return data !== undefined && cadence.isActive(data) ? cadence.activeIntervalMs : cadence.stableIntervalMs;
    },
    refetchIntervalInBackground: false as const
  };
}

function retryAfterInterval(error: unknown): number | false {
  if (!isRecord(error) || !isRecord(error.problem) || error.problem.retryable !== true) return false;
  const seconds = error.problem.retryAfterSeconds;
  if (!Number.isSafeInteger(seconds) || Number(seconds) <= 0) return false;
  return Math.min(Number(seconds) * 1_000, 2_147_000_000);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function invalidateProjectQueries(queryClient: Pick<QueryClient, "invalidateQueries">): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: PROJECT_QUERY_ROOT });
}
