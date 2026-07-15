import assert from "node:assert/strict";
import test from "node:test";
import {
  invalidateProjectQueries,
  pollingQueryOptions,
  PROJECT_QUERY_ROOT,
  readQueryOptions
} from "../apps/web/src/shared/api/polling.ts";

test("polling reads pause after ordinary errors and honor bounded provider Retry-After", () => {
  const options = pollingQueryOptions(5_000);
  const freshPending = { state: { data: undefined, status: "pending" as const, errorUpdateCount: 0 } };
  const failed = { state: { data: { value: 1 }, status: "error" as const, errorUpdateCount: 1 } };
  const rateLimited = {
    state: {
      data: { value: 1 },
      status: "error" as const,
      errorUpdateCount: 1,
      error: { problem: { retryable: true, retryAfterSeconds: 73 } }
    }
  };
  const retrying = { state: { data: undefined, status: "pending" as const, errorUpdateCount: 1 } };
  const recovered = { state: { data: { value: 2 }, status: "success" as const, errorUpdateCount: 1 } };

  assert.equal(options.retry, false);
  assert.equal(options.retryOnMount, false);
  assert.equal(options.refetchIntervalInBackground, false);
  assert.equal(options.refetchInterval(freshPending), 5_000);
  assert.equal(options.refetchInterval(failed), false);
  assert.equal(options.refetchInterval(rateLimited), 73_000);
  assert.equal(options.refetchOnMount(failed), false);
  assert.equal(options.refetchOnReconnect(failed), false);
  assert.equal(options.refetchInterval(retrying), false);
  assert.equal(options.refetchInterval(recovered), 5_000);
  assert.equal(options.refetchOnMount(recovered), true);
  assert.equal(options.refetchOnReconnect(recovered), true);
});

test("adaptive polling uses active, stable, and terminal cadence", () => {
  type Data = { runStatus: "running" | "completed" };
  const stableOptions = pollingQueryOptions<Data>({
    activeIntervalMs: 5_000,
    stableIntervalMs: 60_000,
    isActive: data => data.runStatus === "running"
  });
  const terminalOptions = pollingQueryOptions<Data>({
    activeIntervalMs: 5_000,
    stableIntervalMs: false,
    isActive: data => data.runStatus === "running"
  });
  const state = (runStatus: Data["runStatus"]) => ({
    state: { data: { runStatus }, status: "success" as const, errorUpdateCount: 0 }
  });

  assert.equal(stableOptions.refetchInterval(state("running")), 5_000);
  assert.equal(stableOptions.refetchInterval(state("completed")), 60_000);
  assert.equal(terminalOptions.refetchInterval(state("running")), 5_000);
  assert.equal(terminalOptions.refetchInterval(state("completed")), false);
});

test("non-polling reads do not retry or remount repeatedly after an error", () => {
  const options = readQueryOptions();
  const failed = { state: { data: undefined, status: "error" as const, errorUpdateCount: 1 } };
  const recovered = { state: { data: { value: 1 }, status: "success" as const, errorUpdateCount: 1 } };

  assert.equal(options.retry, false);
  assert.equal(options.retryOnMount, false);
  assert.equal(options.refetchOnMount(failed), false);
  assert.equal(options.refetchOnReconnect(failed), false);
  assert.equal(options.refetchOnMount(recovered), true);
  assert.equal(options.refetchOnReconnect(recovered), true);
});

test("project mutations invalidate the active project query tree once", async () => {
  const calls: unknown[] = [];
  const queryClient = {
    invalidateQueries(filters: unknown) {
      calls.push(filters);
      return Promise.resolve();
    }
  } as Parameters<typeof invalidateProjectQueries>[0];

  await invalidateProjectQueries(queryClient);

  assert.deepEqual(calls, [{ queryKey: PROJECT_QUERY_ROOT }]);
});
