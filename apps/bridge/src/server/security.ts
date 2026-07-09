import type { ServerResponse } from "node:http";

export function baseCorsHeaders(): Record<string, string> {
  return {
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "authorization,content-type,x-hunsu-bridge-token,x-hunsu-bridge-control-token",
    "vary": "origin"
  };
}

export function createResponseSecurityHeaderStore() {
  const responseSecurityHeaders = new WeakMap<object, Record<string, string>>();
  return {
    set(response: ServerResponse, headers: Record<string, string>): void {
      responseSecurityHeaders.set(response, headers);
    },
    get(response: ServerResponse): Record<string, string> {
      return responseSecurityHeaders.get(response) ?? baseCorsHeaders();
    }
  };
}
