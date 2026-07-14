import { HUNSU_WEB_RUNTIME_CONFIG } from "@/shared/config/runtimeConfig";
import type { ApiProblem } from "@/shared/api/types";

export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly problem: ApiProblem
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

export class ApiConflictError extends ApiRequestError {
  constructor(status: number, problem: ApiProblem) {
    super(problem.message, status, problem);
    this.name = "ApiConflictError";
  }
}

export async function requestApi<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (!path.startsWith("/api/")) {
    throw new Error("Hunsu API paths must begin with /api/.");
  }
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  if (init.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const response = await fetch(apiUrl(path), {
    ...init,
    headers,
    credentials: "include",
    cache: init.method && init.method !== "GET" ? "no-store" : init.cache
  });
  if (!response.ok) {
    const problem = await readProblem(response);
    if (response.status === 409 || response.status === 412) {
      throw new ApiConflictError(response.status, problem);
    }
    throw new ApiRequestError(problem.message, response.status, problem);
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return response.json() as Promise<T>;
}

export function getApi<T>(path: string, signal?: AbortSignal): Promise<T> {
  return requestApi<T>(path, { method: "GET", signal });
}

export function postApi<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  return requestApi<T>(path, { method: "POST", body: JSON.stringify(body), signal });
}

export function patchApi<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  return requestApi<T>(path, { method: "PATCH", body: JSON.stringify(body), signal });
}

export function apiErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiConflictError) {
    const expected = error.problem.expectedStateSha?.slice(0, 12);
    const actual = error.problem.actualStateSha?.slice(0, 12);
    return expected && actual
      ? `${error.message} Expected ${expected}, but GitHub is at ${actual}. Refresh and try again.`
      : `${error.message} Refresh and try again.`;
  }
  if (error instanceof ApiRequestError && error.problem.requestId) {
    return `${error.message} GitHub request ID: ${error.problem.requestId}.`;
  }
  return error instanceof Error ? error.message : fallback;
}

function apiUrl(path: string): string {
  const base = HUNSU_WEB_RUNTIME_CONFIG.apiBaseUrl;
  return base ? new URL(path, `${base}/`).toString() : path;
}

async function readProblem(response: Response): Promise<ApiProblem> {
  const body = await response.json().catch(() => undefined) as unknown;
  if (isRecord(body)) {
    const nested = isRecord(body.error) ? body.error : body;
    return {
      code: textField(nested, "code") ?? `http_${response.status}`,
      message: textField(nested, "message") ?? textField(body, "message") ?? `Hunsu API request failed with ${response.status}.`,
      retryable: typeof nested.retryable === "boolean" ? nested.retryable : undefined,
      retryAfterSeconds: positiveIntegerField(nested, "retryAfterSeconds"),
      requestId: textField(nested, "requestId"),
      expectedStateSha: textField(nested, "expectedStateSha"),
      actualStateSha: textField(nested, "actualStateSha"),
      fieldErrors: isStringRecord(nested.fieldErrors) ? nested.fieldErrors : undefined
    };
  }
  return {
    code: `http_${response.status}`,
    message: `Hunsu API request failed with ${response.status}.`
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every(item => typeof item === "string");
}

function textField(value: Record<string, unknown>, key: string): string | undefined {
  const item = value[key];
  return typeof item === "string" && item.trim() ? item.trim() : undefined;
}

function positiveIntegerField(value: Record<string, unknown>, key: string): number | undefined {
  const item = value[key];
  return Number.isSafeInteger(item) && (item as number) > 0 ? item as number : undefined;
}
