export const BRIDGE_API_BASE_URL = __HUNSU_BRIDGE_API_BASE_URL__;

const BRIDGE_API_TOKEN_QUERY_PARAM = "hunsuBridgeToken";
const BRIDGE_API_TOKEN_STORAGE_KEY = "hunsu.bridgeApiToken";

export const BRIDGE_API_AUTH_TOKEN = readBridgeApiAuthToken();

export function bridgeApiRequestHeaders(headers: HeadersInit = {}): HeadersInit {
  const next = new Headers(headers);
  if (!BRIDGE_API_AUTH_TOKEN) {
    return next;
  }
  next.set("authorization", `Bearer ${BRIDGE_API_AUTH_TOKEN}`);
  return next;
}

export function bridgeApiEventUrl(path: string): string {
  const base = BRIDGE_API_BASE_URL || browserOrigin();
  const url = new URL(`${BRIDGE_API_BASE_URL}${path}`, base);
  if (BRIDGE_API_AUTH_TOKEN) {
    url.searchParams.set(BRIDGE_API_TOKEN_QUERY_PARAM, BRIDGE_API_AUTH_TOKEN);
  }
  return BRIDGE_API_BASE_URL ? url.toString() : `${url.pathname}${url.search}`;
}

function readBridgeApiAuthToken(): string {
  if (typeof window === "undefined") {
    return "";
  }
  const url = new URL(window.location.href);
  const queryToken = url.searchParams.get(BRIDGE_API_TOKEN_QUERY_PARAM)?.trim() ?? "";
  const storedToken = window.localStorage.getItem(BRIDGE_API_TOKEN_STORAGE_KEY)?.trim() ?? "";
  if (queryToken) {
    window.localStorage.setItem(BRIDGE_API_TOKEN_STORAGE_KEY, queryToken);
    url.searchParams.delete(BRIDGE_API_TOKEN_QUERY_PARAM);
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
    return queryToken;
  }
  return storedToken;
}

function browserOrigin(): string {
  return typeof window === "undefined" ? "http://localhost" : window.location.origin;
}
