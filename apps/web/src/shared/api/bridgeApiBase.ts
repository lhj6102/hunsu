export const BRIDGE_API_BASE_URL = __HUNSU_BRIDGE_API_BASE_URL__;

const BRIDGE_API_TOKEN_QUERY_PARAM = "hunsuBridgeToken";
const BRIDGE_API_TOKEN_STORAGE_KEY = "hunsu.bridgeApiToken";

export const BRIDGE_API_AUTH_TOKEN = readBridgeApiAuthToken();

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

export function hasBridgeApiAuthToken(): boolean {
  return currentBridgeApiAuthToken().length > 0;
}

export function currentBridgeApiAuthToken(): string {
  return BRIDGE_API_AUTH_TOKEN || storedBridgeApiAuthToken();
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

function browserOrigin(): string {
  return typeof window === "undefined" ? "http://localhost" : window.location.origin;
}
