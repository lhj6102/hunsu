export const LOCAL_API_BASE_URL = __HUNSU_LOCAL_API_BASE_URL__;

const LOCAL_API_TOKEN_QUERY_PARAM = "hunsuLocalToken";
const LOCAL_API_TOKEN_STORAGE_KEY = "hunsu.localApiToken";

export const LOCAL_API_AUTH_TOKEN = readLocalApiAuthToken();

export function localApiRequestHeaders(headers: HeadersInit = {}): HeadersInit {
  const next = new Headers(headers);
  if (!LOCAL_API_AUTH_TOKEN) {
    return next;
  }
  next.set("authorization", `Bearer ${LOCAL_API_AUTH_TOKEN}`);
  return next;
}

export function localApiEventUrl(path: string): string {
  const base = LOCAL_API_BASE_URL || browserOrigin();
  const url = new URL(`${LOCAL_API_BASE_URL}${path}`, base);
  if (LOCAL_API_AUTH_TOKEN) {
    url.searchParams.set(LOCAL_API_TOKEN_QUERY_PARAM, LOCAL_API_AUTH_TOKEN);
  }
  return LOCAL_API_BASE_URL ? url.toString() : `${url.pathname}${url.search}`;
}

function readLocalApiAuthToken(): string {
  if (typeof window === "undefined") {
    return "";
  }
  const url = new URL(window.location.href);
  const queryToken = url.searchParams.get(LOCAL_API_TOKEN_QUERY_PARAM)?.trim() ?? "";
  const storedToken = window.localStorage.getItem(LOCAL_API_TOKEN_STORAGE_KEY)?.trim() ?? "";
  if (queryToken) {
    window.localStorage.setItem(LOCAL_API_TOKEN_STORAGE_KEY, queryToken);
    url.searchParams.delete(LOCAL_API_TOKEN_QUERY_PARAM);
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
    return queryToken;
  }
  return storedToken;
}

function browserOrigin(): string {
  return typeof window === "undefined" ? "http://localhost" : window.location.origin;
}
