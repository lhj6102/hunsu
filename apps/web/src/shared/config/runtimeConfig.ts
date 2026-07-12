export const HUNSU_WEB_RUNTIME_CONFIG_SCHEMA = "hunsu.web-runtime-config.v2" as const;

export const HUNSU_WEB_DEPLOY_TARGETS = ["local", "dev", "preview", "production"] as const;

export type HunsuWebDeployTarget = typeof HUNSU_WEB_DEPLOY_TARGETS[number];

export type HunsuBridgeDeploymentProfile = "production" | "preview";

export type HunsuWebRuntimeConfig = {
  schema: typeof HUNSU_WEB_RUNTIME_CONFIG_SCHEMA;
  target: HunsuWebDeployTarget;
  sourceSha: string;
  bridgePackageVersion: string;
  bridgeApiBaseUrl: string;
  hubApiBaseUrl: string;
  connectApiBaseUrl: string;
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
const EXACT_SEMVER_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:[0-9a-z-]+(?:\.[0-9a-z-]+)*))?(?:\+[0-9a-z-]+(?:\.[0-9a-z-]+)*)?$/iu;

const COMPILE_TIME_FALLBACK: HunsuWebRuntimeConfig = {
  schema: HUNSU_WEB_RUNTIME_CONFIG_SCHEMA,
  target: "local",
  sourceSha: "development",
  bridgePackageVersion: "",
  bridgeApiBaseUrl: typeof __HUNSU_BRIDGE_API_BASE_URL__ === "string" ? __HUNSU_BRIDGE_API_BASE_URL__ : "",
  hubApiBaseUrl: typeof __HUNSU_HUB_API_BASE_URL__ === "string" ? __HUNSU_HUB_API_BASE_URL__ : "",
  connectApiBaseUrl: typeof __HUNSU_CONNECT_API_BASE_URL__ === "string" ? __HUNSU_CONNECT_API_BASE_URL__ : ""
};

export const HUNSU_WEB_RUNTIME_CONFIG = Object.freeze(resolveHunsuWebRuntimeConfig(readRuntimeConfig(), COMPILE_TIME_FALLBACK));

export function bridgeDeploymentProfileForTarget(target: HunsuWebDeployTarget): HunsuBridgeDeploymentProfile {
  return target === "preview" ? "preview" : "production";
}

export function bridgeSetupCommands(config: HunsuWebRuntimeConfig = HUNSU_WEB_RUNTIME_CONFIG): string {
  const profile = bridgeDeploymentProfileForTarget(config.target);
  const packageSelector = config.bridgePackageVersion || (profile === "preview" ? "candidate-next" : "next");
  return [
    `npx @hunsu/bridge@${packageSelector} setup --profile ${profile}`,
    "hunsu-bridge status",
    "hunsu-bridge open"
  ].join("\n");
}

export function bridgeProfileCompatibilityError(
  target: HunsuWebDeployTarget,
  observedProfile: unknown
): string | undefined {
  if (target !== "preview" && target !== "production") {
    return undefined;
  }
  const expectedProfile = bridgeDeploymentProfileForTarget(target);
  return observedProfile === expectedProfile
    ? undefined
    : `This ${target} Studio requires a Bridge configured with the ${expectedProfile} profile.`;
}

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
  const sourceSha = readSourceSha(input.sourceSha);
  if (!sourceSha.ok) {
    return sourceSha;
  }
  const bridgePackageVersion = readBridgePackageVersion(input.bridgePackageVersion, input.target);
  if (!bridgePackageVersion.ok) {
    return bridgePackageVersion;
  }
  const bridgeApiBaseUrl = readBaseUrl(input.bridgeApiBaseUrl, "bridgeApiBaseUrl");
  if (!bridgeApiBaseUrl.ok) {
    return bridgeApiBaseUrl;
  }
  const hubApiBaseUrl = readBaseUrl(input.hubApiBaseUrl, "hubApiBaseUrl");
  if (!hubApiBaseUrl.ok) {
    return hubApiBaseUrl;
  }
  const connectApiBaseUrl = readBaseUrl(input.connectApiBaseUrl, "connectApiBaseUrl");
  if (!connectApiBaseUrl.ok) {
    return connectApiBaseUrl;
  }
  return {
    ok: true,
    value: {
      schema: HUNSU_WEB_RUNTIME_CONFIG_SCHEMA,
      target: input.target,
      sourceSha: sourceSha.value,
      bridgePackageVersion: bridgePackageVersion.value,
      bridgeApiBaseUrl: bridgeApiBaseUrl.value,
      hubApiBaseUrl: hubApiBaseUrl.value,
      connectApiBaseUrl: connectApiBaseUrl.value
    }
  };
}

function readRuntimeConfig(): unknown {
  return typeof window === "undefined" ? undefined : window.__HUNSU_WEB_RUNTIME_CONFIG__;
}

function readSourceSha(value: unknown): HunsuWebRuntimeConfigResultValue<string> {
  if (typeof value !== "string" || !SOURCE_SHA_PATTERN.test(value.trim())) {
    return invalid("sourceSha", "Invalid Hunsu Web sourceSha. Expected a complete 40- or 64-character Git commit SHA.");
  }
  return { ok: true, value: value.trim().toLowerCase() };
}

function readBridgePackageVersion(value: unknown, target: HunsuWebDeployTarget): HunsuWebRuntimeConfigResultValue<string> {
  if (typeof value !== "string") {
    return invalid("bridgePackageVersion", "Invalid Hunsu Bridge package version. Expected an exact semantic version.");
  }
  const version = value.trim();
  if (!version && (target === "local" || target === "dev")) {
    return { ok: true, value: "" };
  }
  if (!EXACT_SEMVER_PATTERN.test(version)) {
    return invalid("bridgePackageVersion", "Invalid Hunsu Bridge package version. Expected an exact semantic version, not a tag or range.");
  }
  return { ok: true, value: version };
}

function readBaseUrl(
  value: unknown,
  field: "bridgeApiBaseUrl" | "hubApiBaseUrl" | "connectApiBaseUrl"
): HunsuWebRuntimeConfigResultValue<string> {
  if (typeof value !== "string") {
    return invalid(field, `Invalid ${field}. Expected an empty string or an HTTP(S) URL.`);
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
    return invalid(field, `Invalid ${field}. Expected a credential-free HTTP(S) base URL without a query or fragment.`);
  }
}

function isDeployTarget(value: string): value is HunsuWebDeployTarget {
  return (HUNSU_WEB_DEPLOY_TARGETS as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type HunsuWebRuntimeConfigResultValue<T> =
  | { ok: true; value: T }
  | { ok: false; error: HunsuWebRuntimeConfigError };

function invalid(field: HunsuWebRuntimeConfigError["field"], message: string): { ok: false; error: HunsuWebRuntimeConfigError } {
  return {
    ok: false,
    error: {
      code: "invalid_runtime_config",
      field,
      message
    }
  };
}
