import { useEffect, useState } from "react";
import { bridgeApiHttpUrl, bridgeApiRequestHeaders, hasBridgeApiAuthToken } from "@/shared/api/bridgeApiBase";
import type { BridgeVersionInfo, StudioConnectionStatus } from "@/shared/api/bridgeTypes";

export type BridgeConnectionState =
  | { status: "idle"; tokenPresent: boolean }
  | { status: "checking"; tokenPresent: boolean }
  | { status: "online"; tokenPresent: boolean; connection?: StudioConnectionStatus; version?: BridgeVersionInfo }
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
        if (nextTokenPresent) {
          const connection = await fetchConnectionStatus(timeoutMs).catch(error => connectionStatusFromError(error, result.version));
          if (cancelled) {
            return;
          }
          setState({ status: "online", tokenPresent: nextTokenPresent, connection, version: result.version });
        } else {
          setState({ status: "online", tokenPresent: nextTokenPresent, version: result.version });
        }
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

export async function checkBridgeHealth(timeoutMs = 1200): Promise<{ ok: true; version?: BridgeVersionInfo } | { ok: false; error: string }> {
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
    const body = await response.json().catch(() => undefined) as { ok?: unknown; service?: unknown; version?: BridgeVersionInfo } | undefined;
    if (body?.ok !== true || body.service !== "hunsu-bridge") {
      return { ok: false, error: "Unexpected Bridge response" };
    }
    return { ok: true, version: body.version };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Bridge is not reachable" };
  } finally {
    window.clearTimeout(timeout);
  }
}

export async function fetchConnectionStatus(timeoutMs = 1200): Promise<StudioConnectionStatus> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(bridgeApiHttpUrl("/api/connection/status"), {
      cache: "no-store",
      headers: bridgeApiRequestHeaders(),
      signal: controller.signal
    });
    if (!response.ok) {
      const body = await response.json().catch(() => undefined) as { code?: string; error?: string } | undefined;
      throw new BridgeConnectionStatusError(response.status, body?.code, body?.error ?? `Connection status returned ${response.status}`);
    }
    return response.json() as Promise<StudioConnectionStatus>;
  } finally {
    window.clearTimeout(timeout);
  }
}

class BridgeConnectionStatusError extends Error {
  constructor(readonly status: number, readonly code: string | undefined, message: string) {
    super(message);
    this.name = "BridgeConnectionStatusError";
  }
}

function connectionStatusFromError(error: unknown, version: BridgeVersionInfo | undefined): StudioConnectionStatus | undefined {
  if (!(error instanceof BridgeConnectionStatusError)) {
    return undefined;
  }
  const auth = error.code === "pairing_token_expired" || error.code === "pairing_token_revoked"
    ? "expired"
    : error.code === "pairing_token_missing" || error.code === "pairing_token_invalid"
      ? "missing_token"
      : "unknown";
  return {
    mode: "local",
    transport: "direct",
    health: "error",
    auth,
    projectAccess: "not_applicable",
    warnings: [],
    error: error.message,
    version: version ?? {
      bridgeVersion: "unknown",
      protocolVersion: "unknown",
      supportedFeatures: []
    }
  };
}
