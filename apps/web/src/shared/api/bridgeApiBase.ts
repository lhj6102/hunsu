import { HUNSU_WEB_RUNTIME_CONFIG } from "@/shared/config/runtimeConfig";

export const BRIDGE_API_BASE_URL = HUNSU_WEB_RUNTIME_CONFIG.bridgeApiBaseUrl;
export const CONNECT_API_BASE_URL = HUNSU_WEB_RUNTIME_CONFIG.connectApiBaseUrl;

const BRIDGE_API_TOKEN_QUERY_PARAM = "hunsuBridgeToken";
const BRIDGE_API_TOKEN_STORAGE_KEY = "hunsu.bridgeApiToken";
const REMOTE_BRIDGE_SELECTION_STORAGE_KEY = "hunsu.remotePeerSelection.v1";

export const BRIDGE_API_AUTH_TOKEN = readBridgeApiAuthToken();

export type RemoteBridgeSession = {
  deviceId: string;
  deviceLabel?: string;
  workspaceId: string;
  workspaceLabel?: string;
};

export function bridgeApiRequestHeaders(headers: HeadersInit = {}): HeadersInit {
  const next = new Headers(headers);
  const token = currentBridgeApiAuthToken();
  if (!token) {
    return next;
  }
  next.set("authorization", `Bearer ${token}`);
  return next;
}

export function bridgeApiEventUrl(path: string): string {
  const url = new URL(bridgeApiHttpUrl(path), browserOrigin());
  const token = currentBridgeApiAuthToken();
  if (token) {
    url.searchParams.set(BRIDGE_API_TOKEN_QUERY_PARAM, token);
  }
  return BRIDGE_API_BASE_URL ? url.toString() : `${url.pathname}${url.search}`;
}

export function bridgeApiHttpUrl(path: string): string {
  if (!BRIDGE_API_BASE_URL) {
    return path;
  }
  return new URL(path, BRIDGE_API_BASE_URL).toString();
}

export function connectApiHttpUrl(path: string): string {
  if (!CONNECT_API_BASE_URL) {
    throw new Error("Hunsu Connect is not configured for this Studio deployment.");
  }
  const base = new URL(CONNECT_API_BASE_URL);
  const url = new URL(path, base);
  if (url.origin !== base.origin) {
    throw new Error("Hunsu Connect requests must use the configured origin.");
  }
  return url.toString();
}

export function hasBridgeApiAuthToken(): boolean {
  return currentBridgeApiAuthToken().length > 0;
}

export function hasConnectConfigured(): boolean {
  return CONNECT_API_BASE_URL.length > 0;
}

export function hasRemoteBridgeSession(): boolean {
  const session = currentRemoteBridgeSession();
  return Boolean(CONNECT_API_BASE_URL && session?.deviceId);
}

export function currentBridgeApiAuthToken(): string {
  return BRIDGE_API_AUTH_TOKEN || storedBridgeApiAuthToken();
}

export function currentRemoteBridgeSession(): RemoteBridgeSession | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }
  const raw = window.localStorage.getItem(REMOTE_BRIDGE_SELECTION_STORAGE_KEY);
  if (!raw) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const deviceId = safeStoredText(parsed.deviceId);
    const workspaceId = safeStoredText(parsed.workspaceId);
    if (!deviceId || !workspaceId) {
      window.localStorage.removeItem(REMOTE_BRIDGE_SELECTION_STORAGE_KEY);
      return undefined;
    }
    const selection: RemoteBridgeSession = {
      deviceId,
      deviceLabel: safeStoredText(parsed.deviceLabel),
      workspaceId,
      workspaceLabel: safeStoredText(parsed.workspaceLabel)
    };
    const normalized = JSON.stringify(selection);
    if (raw !== normalized) {
      window.localStorage.setItem(REMOTE_BRIDGE_SELECTION_STORAGE_KEY, normalized);
    }
    return selection;
  } catch {
    window.localStorage.removeItem(REMOTE_BRIDGE_SELECTION_STORAGE_KEY);
    return undefined;
  }
}

export function storeRemoteBridgeSession(session: RemoteBridgeSession): void {
  if (typeof window === "undefined") {
    return;
  }
  const deviceId = safeStoredText(session.deviceId);
  const workspaceId = safeStoredText(session.workspaceId);
  if (!deviceId || !workspaceId) {
    throw new Error("Remote Bridge selection requires device and workspace IDs.");
  }
  window.localStorage.setItem(REMOTE_BRIDGE_SELECTION_STORAGE_KEY, JSON.stringify({
    deviceId,
    deviceLabel: safeStoredText(session.deviceLabel),
    workspaceId,
    workspaceLabel: safeStoredText(session.workspaceLabel)
  } satisfies RemoteBridgeSession));
}

export function clearRemoteBridgeSession(): void {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.removeItem(REMOTE_BRIDGE_SELECTION_STORAGE_KEY);
}

function readBridgeApiAuthToken(): string {
  if (typeof window === "undefined") {
    return "";
  }
  const url = new URL(window.location.href);
  const queryToken = url.searchParams.get(BRIDGE_API_TOKEN_QUERY_PARAM)?.trim() ?? "";
  if (queryToken) {
    window.localStorage.setItem(BRIDGE_API_TOKEN_STORAGE_KEY, queryToken);
    url.searchParams.delete(BRIDGE_API_TOKEN_QUERY_PARAM);
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
    return queryToken;
  }
  return storedBridgeApiAuthToken();
}

function storedBridgeApiAuthToken(): string {
  if (typeof window === "undefined") {
    return "";
  }
  return window.localStorage.getItem(BRIDGE_API_TOKEN_STORAGE_KEY)?.trim() ?? "";
}

function safeStoredText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function browserOrigin(): string {
  return typeof window === "undefined" ? "http://localhost" : new URL(window.location.href).origin;
}
