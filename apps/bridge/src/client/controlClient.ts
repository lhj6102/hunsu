import {
  createConfigStore,
  createCredentialStore,
  resolveHunsuPaths,
  type HunsuPathInput,
  type HunsuPaths
} from "../state/index.ts";
import {
  BRIDGE_CLI_RESULT_SCHEMA,
  bridgeNotRunningResult,
  cliFailure,
  type BridgeCliFailure,
  type BridgeCliResult
} from "./cliResult.ts";

export const BRIDGE_CONTROL_TOKEN_HEADER = "X-Hunsu-Bridge-Control-Token";

export type BridgeControlClientOptions = HunsuPathInput & {
  paths?: HunsuPaths;
  endpoint?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

export type BridgeControlRequest = {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
  timeoutMs?: number;
};

export type BridgeHealth = {
  ok: true;
  service: "hunsu-bridge";
  version: string;
  protocolVersion: "local-bridge-v1";
};

export type BridgeControlClient = {
  endpoint(): Promise<string>;
  health(): Promise<BridgeHealth | undefined>;
  request<T = unknown>(path: string, input?: BridgeControlRequest): Promise<BridgeCliResult<T>>;
};

export function createBridgeControlClient(options: BridgeControlClientOptions = {}): BridgeControlClient {
  const paths = options.paths ?? resolveHunsuPaths(options);
  const fetchImpl = options.fetchImpl ?? fetch;
  const defaultTimeoutMs = options.timeoutMs ?? 2_000;

  const endpoint = async (): Promise<string> => {
    if (options.endpoint) {
      return normalizeEndpoint(options.endpoint);
    }
    const config = await createConfigStore(paths).read();
    return endpointFromHostPort(config.host, config.port);
  };

  return {
    endpoint,
    async health(): Promise<BridgeHealth | undefined> {
      try {
        return await readHealthAt(fetchImpl, await endpoint(), defaultTimeoutMs);
      } catch (_error) {
        return undefined;
      }
    },
    async request<T = unknown>(path: string, input: BridgeControlRequest = {}): Promise<BridgeCliResult<T>> {
      try {
        const targetEndpoint = await endpoint();
        const timeoutMs = input.timeoutMs ?? defaultTimeoutMs;
        if (!await readHealthAt(fetchImpl, targetEndpoint, timeoutMs)) {
          return bridgeNotRunningResult();
        }
        const credentials = await createCredentialStore(paths).read();
        if (!credentials?.controlToken) {
          return bridgeNotRunningResult();
        }
        const response = await fetchImpl(new URL(normalizeControlPath(path), targetEndpoint), {
          method: input.method ?? "GET",
          headers: {
            [BRIDGE_CONTROL_TOKEN_HEADER]: credentials.controlToken,
            ...(input.body === undefined ? {} : { "content-type": "application/json" })
          },
          ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
          redirect: "error",
          signal: AbortSignal.timeout(timeoutMs)
        });
        if (response.status === 401 || response.status === 403) {
          return cliFailure("BRIDGE_CONTROL_UNAUTHORIZED", "Hunsu Bridge rejected the local control credential.");
        }
        const parsed = await readControlResult<T>(response);
        if (parsed) {
          return parsed;
        }
        return cliFailure(
          "BRIDGE_CONTROL_UNAVAILABLE",
          `Hunsu Bridge returned an invalid control response (HTTP ${response.status}).`
        );
      } catch (_error) {
        return bridgeNotRunningResult();
      }
    }
  };
}

async function readHealthAt(fetchImpl: typeof fetch, endpoint: string, timeoutMs: number): Promise<BridgeHealth | undefined> {
  const response = await fetchImpl(new URL("/health", endpoint), {
    method: "GET",
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) return undefined;
  const value = await response.json() as Partial<BridgeHealth>;
  return value.ok === true
    && value.service === "hunsu-bridge"
    && typeof value.version === "string"
    && value.protocolVersion === "local-bridge-v1"
    ? value as BridgeHealth
    : undefined;
}

export function endpointFromHostPort(host: string, port: number): string {
  if (!isLoopbackHostname(host)) {
    throw new Error("Bridge control endpoint must use a loopback host.");
  }
  const normalizedHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${normalizedHost}:${port}`;
}

function normalizeEndpoint(value: string): string {
  const endpoint = new URL(value);
  if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
    throw new Error("Bridge control endpoint must use HTTP or HTTPS.");
  }
  if (!isLoopbackHostname(endpoint.hostname)) {
    throw new Error("Bridge control endpoint must use a loopback host.");
  }
  endpoint.pathname = "/";
  endpoint.search = "";
  endpoint.hash = "";
  return endpoint.toString().replace(/\/$/, "");
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost"
    || hostname === "127.0.0.1"
    || hostname === "::1"
    || hostname === "[::1]";
}

function normalizeControlPath(path: string): string {
  if (!path.startsWith("/v1/control")) {
    throw new Error("The Bridge control client may call only /v1/control routes.");
  }
  return path;
}

async function readControlResult<T>(response: Response): Promise<BridgeCliResult<T> | undefined> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return undefined;
  }
  const value = await response.json().catch(() => undefined) as Partial<BridgeCliResult<T>> | undefined;
  if (!value || value.schema !== BRIDGE_CLI_RESULT_SCHEMA || typeof value.ok !== "boolean" || typeof value.code !== "string" || typeof value.message !== "string") {
    return undefined;
  }
  return value as BridgeCliResult<T>;
}

export function isBridgeCliFailure<T>(result: BridgeCliResult<T>): result is BridgeCliFailure {
  return !result.ok;
}
