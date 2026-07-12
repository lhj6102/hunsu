import { useEffect, useState } from "react";
import { postRemoteBridgeConnect } from "@/shared/api/bridgeClient";
import { bridgeApiHttpUrl, bridgeApiRequestHeaders, clearRemoteBridgeSession, currentRemoteBridgeSession, hasBridgeApiAuthToken } from "@/shared/api/bridgeApiBase";
import type { BridgeVersionInfo, StudioConnectionStatus } from "@/shared/api/bridgeTypes";
import { bridgeProfileCompatibilityError, HUNSU_WEB_RUNTIME_CONFIG } from "@/shared/config/runtimeConfig";

export type BridgeConnectionState =
  | { status: "idle"; tokenPresent: boolean }
  | { status: "checking"; tokenPresent: boolean }
  | { status: "online"; tokenPresent: boolean; connection?: StudioConnectionStatus; version?: BridgeVersionInfo }
  | { status: "offline"; tokenPresent: boolean; error?: string };

export type RemoteBridgeSessionState =
  | { status: "idle"; sessionPresent: boolean }
  | { status: "remote_checking"; sessionPresent: true }
  | { status: "remote_connected"; sessionPresent: true; connection: StudioConnectionStatus }
  | { status: "remote_offline"; sessionPresent: true; error?: string; connection?: StudioConnectionStatus }
  | { status: "remote_expired"; sessionPresent: false; error?: string; connection?: StudioConnectionStatus }
  | { status: "remote_account_mismatch"; sessionPresent: false; error?: string; connection?: StudioConnectionStatus }
  | { status: "remote_project_grant_needed"; sessionPresent: true; error?: string; connection?: StudioConnectionStatus };

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

export function useVerifiedRemoteBridgeSession({ enabled = true }: { enabled?: boolean } = {}): RemoteBridgeSessionState {
  const [state, setState] = useState<RemoteBridgeSessionState>(() => {
    const session = currentRemoteBridgeSession();
    return enabled && session ? { status: "remote_checking", sessionPresent: true } : { status: "idle", sessionPresent: Boolean(session) };
  });

  useEffect(() => {
    let cancelled = false;
    const session = currentRemoteBridgeSession();
    if (!enabled || !session) {
      setState({ status: "idle", sessionPresent: Boolean(session) });
      return () => {
        cancelled = true;
      };
    }
    setState({ status: "remote_checking", sessionPresent: true });
    postRemoteBridgeConnect({
      deviceId: session.deviceId,
      workspaceId: session.workspaceId,
      workspaceLabel: session.workspaceLabel
    })
      .then(result => {
        if (cancelled) return;
        setState(remoteBridgeSessionStateFromConnection(result.connection));
      })
      .catch(error => {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : "Remote Bridge session could not be verified.";
        if (looksLikeExpiredRemoteSession(message)) {
          clearRemoteBridgeSession();
          setState({ status: "remote_expired", sessionPresent: false, error: message });
          return;
        }
        setState({ status: "remote_offline", sessionPresent: true, error: message });
      });
    return () => {
      cancelled = true;
    };
  }, [enabled]);

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
    const body = await response.json().catch(() => undefined) as {
      ok?: unknown;
      service?: unknown;
      version?: unknown;
      protocolVersion?: unknown;
      deploymentProfile?: unknown;
    } | undefined;
    if (body?.ok !== true || body.service !== "hunsu-bridge") {
      return { ok: false, error: "Unexpected Bridge response" };
    }
    const profileError = bridgeProfileCompatibilityError(HUNSU_WEB_RUNTIME_CONFIG.target, body.deploymentProfile);
    if (profileError) {
      return { ok: false, error: profileError };
    }
    const version = typeof body.version === "string" && typeof body.protocolVersion === "string"
      ? {
          bridgeVersion: body.version,
          protocolVersion: body.protocolVersion,
          supportedFeatures: []
        }
      : undefined;
    return { ok: true, version };
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

function remoteBridgeSessionStateFromConnection(connection: StudioConnectionStatus): RemoteBridgeSessionState {
  if (connection.auth === "account_mismatch") {
    clearRemoteBridgeSession();
    return { status: "remote_account_mismatch", sessionPresent: false, error: connection.error, connection };
  }
  if (connection.auth === "expired" || connection.auth === "missing_token" || connection.auth === "invalid") {
    clearRemoteBridgeSession();
    return { status: "remote_expired", sessionPresent: false, error: connection.error, connection };
  }
  if (connection.projectAccess === "needs_grant" || connection.projectAccess === "denied") {
    return { status: "remote_project_grant_needed", sessionPresent: true, error: connection.error, connection };
  }
  if (connection.mode === "remote" && connection.health === "connected" && connection.compatibility?.compatible !== false) {
    return { status: "remote_connected", sessionPresent: true, connection };
  }
  return { status: "remote_offline", sessionPresent: true, error: connection.error, connection };
}

function looksLikeExpiredRemoteSession(message: string): boolean {
  return /expired|invalid_token|unauthorized|401/i.test(message);
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
    : error.code === "pairing_token_invalid"
      ? "invalid"
      : error.code === "pairing_token_missing"
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
