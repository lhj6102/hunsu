import { useEffect, useState } from "react";
import { bridgeApiHttpUrl, hasBridgeApiAuthToken } from "@/shared/api/bridgeApiBase";

export type BridgeConnectionState =
  | { status: "idle"; tokenPresent: boolean }
  | { status: "checking"; tokenPresent: boolean }
  | { status: "online"; tokenPresent: boolean }
  | { status: "offline"; tokenPresent: boolean; error?: string };

export function useBridgeConnection({
  enabled = true,
  intervalMs = 0,
  timeoutMs = 1200
}: {
  enabled?: boolean;
  intervalMs?: number;
  timeoutMs?: number;
} = {}): BridgeConnectionState {
  const [state, setState] = useState<BridgeConnectionState>(() => ({
    status: enabled ? "checking" : "idle",
    tokenPresent: hasBridgeApiAuthToken()
  }));

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;

    async function runCheck() {
      if (!enabled) {
        setState({ status: "idle", tokenPresent: hasBridgeApiAuthToken() });
        return;
      }
      const tokenPresent = hasBridgeApiAuthToken();
      setState(current => current.status === "idle"
        ? { status: "checking", tokenPresent }
        : { ...current, tokenPresent });
      const result = await checkBridgeHealth(timeoutMs);
      if (cancelled) {
        return;
      }
      const nextTokenPresent = hasBridgeApiAuthToken();
      if (result.ok) {
        setState({ status: "online", tokenPresent: nextTokenPresent });
      } else {
        setState({ status: "offline", tokenPresent: nextTokenPresent, error: result.error });
      }
    }

    void runCheck();
    if (enabled && intervalMs > 0) {
      timer = window.setInterval(() => {
        void runCheck();
      }, intervalMs);
    }
    return () => {
      cancelled = true;
      if (timer !== undefined) {
        window.clearInterval(timer);
      }
    };
  }, [enabled, intervalMs, timeoutMs]);

  return state;
}

export async function checkBridgeHealth(timeoutMs = 1200): Promise<{ ok: true } | { ok: false; error: string }> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(bridgeApiHttpUrl("/health"), {
      cache: "no-store",
      signal: controller.signal
    });
    if (!response.ok) {
      return { ok: false, error: `Bridge returned ${response.status}` };
    }
    const body = await response.json().catch(() => undefined) as { ok?: unknown; service?: unknown } | undefined;
    if (body?.ok !== true || body.service !== "hunsu-bridge") {
      return { ok: false, error: "Unexpected Bridge response" };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Bridge is not reachable" };
  } finally {
    window.clearTimeout(timeout);
  }
}
