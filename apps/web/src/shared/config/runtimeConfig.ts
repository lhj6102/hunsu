export const HUNSU_WEB_RUNTIME_CONFIG_SCHEMA = "hunsu.web-runtime-config.v3" as const;

export const HUNSU_WEB_DEPLOY_TARGETS = ["local", "dev", "production"] as const;

export type HunsuWebDeployTarget = typeof HUNSU_WEB_DEPLOY_TARGETS[number];

export type HunsuWebRuntimeConfig = {
  schema: typeof HUNSU_WEB_RUNTIME_CONFIG_SCHEMA;
  target: HunsuWebDeployTarget;
  sourceSha: string;
  apiBaseUrl: string;
};

export type HunsuWebRuntimeConfigError = {
  code: "invalid_runtime_config";
  field: keyof HunsuWebRuntimeConfig | "config";
  message: string;
};

export type HunsuWebRuntimeConfigResult =
  | { ok: true; value: HunsuWebRuntimeConfig }
  | { ok: false; error: HunsuWebRuntimeConfigError };

const SOURCE_SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu;

const COMPILE_TIME_FALLBACK: HunsuWebRuntimeConfig = {
  schema: HUNSU_WEB_RUNTIME_CONFIG_SCHEMA,
  target: "local",
  sourceSha: "development",
  apiBaseUrl: typeof __HUNSU_API_BASE_URL__ === "string" ? __HUNSU_API_BASE_URL__ : ""
};

export const HUNSU_WEB_RUNTIME_CONFIG = Object.freeze(
  resolveHunsuWebRuntimeConfig(readRuntimeConfig(), COMPILE_TIME_FALLBACK)
);

export function resolveHunsuWebRuntimeConfig(
  input: unknown,
  fallback: HunsuWebRuntimeConfig = COMPILE_TIME_FALLBACK
): HunsuWebRuntimeConfig {
  if (input === undefined || input === null) {
    return { ...fallback };
  }
  const result = parseHunsuWebRuntimeConfig(input);
  if (result.ok) {
    return result.value;
  }
  throw new Error(result.error.message);
}

export function parseHunsuWebRuntimeConfig(input: unknown): HunsuWebRuntimeConfigResult {
  if (!isRecord(input)) {
    return invalid("config", "Hunsu Web runtime config must be an object.");
  }
  if (input.schema !== HUNSU_WEB_RUNTIME_CONFIG_SCHEMA) {
    return invalid("schema", `Invalid Hunsu Web runtime config schema. Expected ${HUNSU_WEB_RUNTIME_CONFIG_SCHEMA}.`);
  }
  if (typeof input.target !== "string" || !isDeployTarget(input.target)) {
    return invalid("target", `Invalid Hunsu Web deploy target. Expected one of: ${HUNSU_WEB_DEPLOY_TARGETS.join(", ")}.`);
  }
  const sourceSha = readSourceSha(input.sourceSha, input.target);
  if (!sourceSha.ok) {
    return sourceSha;
  }
  const apiBaseUrl = readBaseUrl(input.apiBaseUrl);
  if (!apiBaseUrl.ok) {
    return apiBaseUrl;
  }
  return {
    ok: true,
    value: {
      schema: HUNSU_WEB_RUNTIME_CONFIG_SCHEMA,
      target: input.target,
      sourceSha: sourceSha.value,
      apiBaseUrl: apiBaseUrl.value
    }
  };
}

function readRuntimeConfig(): unknown {
  return typeof window === "undefined" ? undefined : window.__HUNSU_WEB_RUNTIME_CONFIG__;
}

function readSourceSha(value: unknown, target: HunsuWebDeployTarget): ConfigValueResult<string> {
  if (value === "development" && (target === "local" || target === "dev")) {
    return { ok: true, value };
  }
  if (typeof value !== "string" || !SOURCE_SHA_PATTERN.test(value.trim())) {
    return invalid("sourceSha", "Invalid Hunsu Web sourceSha. Expected a complete Git commit SHA.");
  }
  return { ok: true, value: value.trim().toLowerCase() };
}

function readBaseUrl(value: unknown): ConfigValueResult<string> {
  if (typeof value !== "string") {
    return invalid("apiBaseUrl", "Invalid apiBaseUrl. Expected an empty string or an HTTP(S) URL.");
  }
  const raw = value.trim();
  if (!raw) {
    return { ok: true, value: "" };
  }
  try {
    const url = new URL(raw);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.search || url.hash) {
      throw new Error("Unsupported URL");
    }
    return { ok: true, value: url.toString().replace(/\/$/u, "") };
  } catch {
    return invalid("apiBaseUrl", "Invalid apiBaseUrl. Expected a credential-free HTTP(S) URL without a query or fragment.");
  }
}

function isDeployTarget(value: string): value is HunsuWebDeployTarget {
  return (HUNSU_WEB_DEPLOY_TARGETS as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type ConfigValueResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: HunsuWebRuntimeConfigError };

function invalid(
  field: HunsuWebRuntimeConfigError["field"],
  message: string
): { ok: false; error: HunsuWebRuntimeConfigError } {
  return { ok: false, error: { code: "invalid_runtime_config", field, message } };
}
