import {
  createBridgeControlStateReader,
  type BridgeControlStateReader
} from "../state/controlStateReader.ts";
import { resolveHunsuPaths, type HunsuPathInput, type HunsuPaths } from "../state/paths.ts";
import {
  BRIDGE_CLI_RESULT_SCHEMA,
  BridgeError,
  bridgeErrorResult,
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
  stateReader?: BridgeControlStateReader;
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

export type ControlEndpointProbe =
  | { state: "offline" }
  | { state: "foreign-listener" }
  | { state: "hunsu-healthy" }
  | { state: "hunsu-unhealthy"; status?: number };

export type BridgeControlClient = {
  endpoint(): Promise<string>;
  probe(): Promise<ControlEndpointProbe>;
  health(): Promise<BridgeHealth | undefined>;
  request<T = unknown>(path: string, input?: BridgeControlRequest): Promise<BridgeCliResult<T>>;
};

export function createBridgeControlClient(options: BridgeControlClientOptions = {}): BridgeControlClient {
  const paths = options.paths ?? resolveHunsuPaths(options);
  const fetchImpl = options.fetchImpl ?? fetch;
  const defaultTimeoutMs = options.timeoutMs ?? 2_000;
  const stateReader = options.stateReader ?? createBridgeControlStateReader(paths);

  const endpoint = async (): Promise<string> => {
    if (options.endpoint) {
      return normalizeEndpoint(options.endpoint);
    }
    const config = await stateReader.readEndpointConfig();
    return endpointFromHostPort(config.host, config.port);
  };

  return {
    endpoint,
    async probe(): Promise<ControlEndpointProbe> {
      return (await probeHealthAt(fetchImpl, await endpoint(), defaultTimeoutMs)).probe;
    },
    async health(): Promise<BridgeHealth | undefined> {
      try {
        return (await probeHealthAt(fetchImpl, await endpoint(), defaultTimeoutMs)).health;
      } catch (_error) {
        return undefined;
      }
    },
    async request<T = unknown>(path: string, input: BridgeControlRequest = {}): Promise<BridgeCliResult<T>> {
      let targetEndpoint: string;
      try {
        targetEndpoint = await endpoint();
      } catch (error) {
        return bridgeErrorResult(error);
      }

      const timeoutMs = input.timeoutMs ?? defaultTimeoutMs;
      const healthProbe = await probeHealthAt(fetchImpl, targetEndpoint, timeoutMs);
      if (healthProbe.probe.state === "offline") return bridgeNotRunningResult();
      if (healthProbe.probe.state === "foreign-listener") {
        return cliFailure(
          "BRIDGE_PORT_IN_USE",
          "The configured Hunsu Bridge endpoint is in use by another service."
        );
      }
      if (healthProbe.probe.state === "hunsu-unhealthy") {
        return cliFailure(
          "BRIDGE_CONTROL_UNAVAILABLE",
          healthProbe.probe.status === undefined
            ? "Hunsu Bridge health is unavailable."
            : `Hunsu Bridge health is unavailable (HTTP ${healthProbe.probe.status}).`
        );
      }

      let credentials: Awaited<ReturnType<BridgeControlStateReader["readCredential"]>>;
      try {
        credentials = await stateReader.readCredential();
      } catch (error) {
        return bridgeErrorResult(error);
      }
      if (!credentials?.controlToken) {
        return cliFailure(
          "BRIDGE_CONTROL_UNAUTHORIZED",
          "Hunsu Bridge control credentials are missing."
        );
      }

      let controlPath: string;
      try {
        controlPath = normalizeControlPath(path);
      } catch (error) {
        return bridgeErrorResult(error);
      }

      let response: Response;
      try {
        response = await fetchImpl(new URL(controlPath, targetEndpoint), {
          method: input.method ?? "GET",
          headers: {
            [BRIDGE_CONTROL_TOKEN_HEADER]: credentials.controlToken,
            ...(input.body === undefined ? {} : { "content-type": "application/json" })
          },
          ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
          redirect: "error",
          signal: AbortSignal.timeout(timeoutMs)
        });
      } catch (_error) {
        return cliFailure(
          "BRIDGE_CONTROL_UNAVAILABLE",
          "Hunsu Bridge was healthy, but the authenticated control request did not complete."
        );
      }

      if (response.status === 401 || response.status === 403) {
        return cliFailure("BRIDGE_CONTROL_UNAUTHORIZED", "Hunsu Bridge rejected the local control credential.");
      }
      const parsed = await readControlResult<T>(response);
      if (parsed) return parsed;
      return cliFailure(
        "BRIDGE_CONTROL_UNAVAILABLE",
        `Hunsu Bridge returned an invalid control response (HTTP ${response.status}).`
      );
    }
  };
}

type HealthProbeResult = {
  probe: ControlEndpointProbe;
  health?: BridgeHealth;
};

async function probeHealthAt(fetchImpl: typeof fetch, endpoint: string, timeoutMs: number): Promise<HealthProbeResult> {
  let response: Response;
  try {
    response = await fetchImpl(new URL("/health", endpoint), {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (_error) {
    return { probe: { state: "offline" } };
  }

  const value = await response.json().catch(() => undefined) as Partial<BridgeHealth> | undefined;
  if (response.ok
    && value?.ok === true
    && value.service === "hunsu-bridge"
    && typeof value.version === "string"
    && value.protocolVersion === "local-bridge-v1") {
    return {
      probe: { state: "hunsu-healthy" },
      health: value as BridgeHealth
    };
  }
  if (value?.service === "hunsu-bridge") {
    return { probe: { state: "hunsu-unhealthy", status: response.status } };
  }
  return { probe: { state: "foreign-listener" } };
}

export function endpointFromHostPort(host: string, port: number): string {
  if (!isLoopbackHostname(host)) {
    throw new BridgeError("BRIDGE_STATE_INVALID", "Bridge control endpoint configuration must use a loopback host.");
  }
  const normalizedHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${normalizedHost}:${port}`;
}

function normalizeEndpoint(value: string): string {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch (error) {
    throw new BridgeError("BRIDGE_STATE_INVALID", "Bridge control endpoint configuration is invalid.", { cause: error });
  }
  if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
    throw new BridgeError("BRIDGE_STATE_INVALID", "Bridge control endpoint configuration must use HTTP or HTTPS.");
  }
  if (!isLoopbackHostname(endpoint.hostname)) {
    throw new BridgeError("BRIDGE_STATE_INVALID", "Bridge control endpoint configuration must use a loopback host.");
  }
  if (endpoint.username || endpoint.password) {
    throw new BridgeError("BRIDGE_STATE_INVALID", "Bridge control endpoint configuration must not contain credentials.");
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
    throw new BridgeError("BRIDGE_CONTROL_UNAVAILABLE", "The Bridge control client may call only control API routes.");
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
