export const BRIDGE_API_BASE_URL = __HUNSU_BRIDGE_API_BASE_URL__;
export const RELAY_API_BASE_URL = __HUNSU_RELAY_API_BASE_URL__;

const BRIDGE_API_TOKEN_QUERY_PARAM = "hunsuBridgeToken";
const RELAY_TOKEN_QUERY_PARAM = "hunsuRelayToken";
const BRIDGE_API_TOKEN_STORAGE_KEY = "hunsu.bridgeApiToken";
const RELAY_TOKEN_STORAGE_KEY = "hunsu.relayAccessToken";
const REMOTE_BRIDGE_SESSION_STORAGE_KEY = "hunsu.remoteBridgeSession";

export const BRIDGE_API_AUTH_TOKEN = readBridgeApiAuthToken();
export const RELAY_ACCESS_TOKEN = readRelayAccessToken();

export type RemoteBridgeSession = {
  deviceId: string;
  projectPath?: string;
  webUserId?: string;
  relayAccessToken?: string;
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

export function relayApiRequestHeaders(headers: HeadersInit = {}): HeadersInit {
  const next = new Headers(headers);
  const token = currentRelayAccessToken();
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

export function relayApiHttpUrl(path: string): string {
  return new URL(path, RELAY_API_BASE_URL).toString();
}

export function hasBridgeApiAuthToken(): boolean {
  return currentBridgeApiAuthToken().length > 0;
}

export function hasDirectRelaySession(): boolean {
  return Boolean(RELAY_API_BASE_URL && currentRelayAccessToken());
}

export function hasRemoteBridgeSession(): boolean {
  const session = currentRemoteBridgeSession();
  return Boolean(RELAY_API_BASE_URL && session?.deviceId && currentRelayAccessToken());
}

export function currentBridgeApiAuthToken(): string {
  return BRIDGE_API_AUTH_TOKEN || storedBridgeApiAuthToken();
}

export function currentRelayAccessToken(): string {
  return RELAY_ACCESS_TOKEN || storedRelayAccessToken() || storedRemoteBridgeSessionRelayAccessToken();
}

export function currentRemoteBridgeSession(): RemoteBridgeSession | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }
  const raw = window.localStorage.getItem(REMOTE_BRIDGE_SESSION_STORAGE_KEY);
  if (!raw) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<RemoteBridgeSession>;
    return typeof parsed.deviceId === "string" && parsed.deviceId.trim()
      ? {
          deviceId: parsed.deviceId.trim(),
          projectPath: typeof parsed.projectPath === "string" && parsed.projectPath.trim() ? parsed.projectPath.trim() : undefined,
          webUserId: typeof parsed.webUserId === "string" && parsed.webUserId.trim() ? parsed.webUserId.trim() : undefined,
          relayAccessToken: typeof parsed.relayAccessToken === "string" && parsed.relayAccessToken.trim() ? parsed.relayAccessToken.trim() : currentRelayAccessToken()
        }
      : undefined;
  } catch {
    return undefined;
  }
}

export function storeRemoteBridgeSession(session: RemoteBridgeSession): void {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.setItem(REMOTE_BRIDGE_SESSION_STORAGE_KEY, JSON.stringify({
    ...session,
    relayAccessToken: session.relayAccessToken ?? currentRelayAccessToken()
  }));
}

export function clearRemoteBridgeSession(): void {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.removeItem(REMOTE_BRIDGE_SESSION_STORAGE_KEY);
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

function readRelayAccessToken(): string {
  if (typeof window === "undefined") {
    return "";
  }
  const url = new URL(window.location.href);
  const queryToken = url.searchParams.get(RELAY_TOKEN_QUERY_PARAM)?.trim() ?? "";
  if (queryToken) {
    window.localStorage.setItem(RELAY_TOKEN_STORAGE_KEY, queryToken);
    url.searchParams.delete(RELAY_TOKEN_QUERY_PARAM);
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
    return queryToken;
  }
  return storedRelayAccessToken();
}

function storedBridgeApiAuthToken(): string {
  if (typeof window === "undefined") {
    return "";
  }
  return window.localStorage.getItem(BRIDGE_API_TOKEN_STORAGE_KEY)?.trim() ?? "";
}

function storedRelayAccessToken(): string {
  if (typeof window === "undefined") {
    return "";
  }
  return window.localStorage.getItem(RELAY_TOKEN_STORAGE_KEY)?.trim() ?? "";
}

function storedRemoteBridgeSessionRelayAccessToken(): string {
  if (typeof window === "undefined") {
    return "";
  }
  const raw = window.localStorage.getItem(REMOTE_BRIDGE_SESSION_STORAGE_KEY);
  if (!raw) {
    return "";
  }
  try {
    const parsed = JSON.parse(raw) as Partial<RemoteBridgeSession>;
    return typeof parsed.relayAccessToken === "string" ? parsed.relayAccessToken.trim() : "";
  } catch {
    return "";
  }
}

function browserOrigin(): string {
  return typeof window === "undefined" ? "http://localhost" : window.location.origin;
}
