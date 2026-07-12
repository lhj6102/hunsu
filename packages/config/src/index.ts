import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type ConfigResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: HunsuConfigError };

export type HunsuConfigError = {
  code: "invalid_port" | "invalid_boolean" | "invalid_url" | "invalid_path" | "invalid_enum" | "invalid_json" | "missing_required_env" | "port_conflict";
  message: string;
  env?: string;
  portName?: HunsuPortName;
  port?: number;
  value?: string;
  path?: string;
  allowed?: readonly string[];
};

export type HunsuPortName = "bridgeApi" | "studioWeb" | "agentPreview";

export type HunsuEndpoint = {
  name: HunsuPortName;
  host: string;
  hostSource: ConfigValueSource;
  hostEnv?: string;
  port: number;
  portSource: ConfigValueSource;
  portEnv?: string;
  reserved: boolean;
};

export type ConfigValueSource = "default" | "env" | "override";

export type Env = Record<string, string | undefined>;

export type HunsuPortConfig = Record<HunsuPortName, HunsuEndpoint>;

export type HunsuPortOverrides = Partial<Record<HunsuPortName, {
  host?: string;
  port?: number;
}>>;

export type HunsuPortResolveOptions = {
  overrides?: HunsuPortOverrides;
};

export type HunsuPortValidationOptions = {
  activePortNames: readonly HunsuPortName[];
};

export type StudioWebServerConfig = {
  web: HunsuEndpoint;
  bridgeApi: HunsuEndpoint;
  strictPort: boolean;
  apiProxyTarget: string;
  browserBridgeUrl?: string;
  browserHubApiUrl?: string;
  browserConnectApiUrl?: string;
};

export type StudioLauncherConfig = {
  webUrl: string;
};

export type BridgeApiServerConfig = {
  bridgeApi: HunsuEndpoint;
};

export type CodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type CodexApprovalPolicy = "never" | "on-request" | "on-failure" | "untrusted";
export type CodexApprovalsReviewer = "user" | "auto_review";

export type CodexThreadOptionsConfig = {
  sandboxMode?: CodexSandboxMode;
  approvalPolicy?: CodexApprovalPolicy;
  approvalsReviewer?: CodexApprovalsReviewer;
  networkAccessEnabled?: boolean;
  additionalDirectories?: string[];
};

export type CodexAppServerConfig = {
  command: string;
  args: string[];
  environment: Record<string, string>;
};

export type BridgeRuntimeConfig = {
  bridgeApi: HunsuEndpoint;
  processEnv: Record<string, string>;
  roadmapRegistryPath: string;
  routeWorktreeRoot?: string;
  actionWorktreeRoot?: string;
  testRunner?: "deterministic";
  codexAppServer: CodexAppServerConfig;
  codexThreadOptions: CodexThreadOptionsConfig;
};

export type ConnectClientConfig = {
  connectApiUrl: string;
  connectWsUrl: string;
};

export type BridgeRuntimeConfigOptions = {
  cwd?: string;
  homeDir?: string;
  processEnv?: Env;
  roadmapRegistryPath?: string;
  routeWorktreeRoot?: string;
  actionWorktreeRoot?: string;
  codexAppServer?: Partial<Omit<CodexAppServerConfig, "environment">> & { environment?: Env };
  codexThreadOptions?: CodexThreadOptionsConfig;
};

type PortSpec = {
  name: HunsuPortName;
  defaultHost: string;
  hostEnv: readonly string[];
  defaultPort: number;
  portEnv: readonly string[];
  reserved: boolean;
  allowPortZero: boolean;
};

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_LOCAL_HUB_API_URL = "http://127.0.0.1:8787";
const DEFAULT_STUDIO_WEB_URL = "https://hunsu.app/studio";

export const HUNSU_PORT_SPECS: Record<HunsuPortName, PortSpec> = {
  bridgeApi: {
    name: "bridgeApi",
    defaultHost: DEFAULT_HOST,
    hostEnv: ["HUNSU_BRIDGE_HOST", "HOST"],
    defaultPort: 19687,
    portEnv: ["HUNSU_BRIDGE_PORT", "PORT"],
    reserved: false,
    allowPortZero: true
  },
  studioWeb: {
    name: "studioWeb",
    defaultHost: DEFAULT_HOST,
    hostEnv: ["HUNSU_WEB_HOST"],
    defaultPort: 19688,
    portEnv: ["HUNSU_WEB_PORT"],
    reserved: false,
    allowPortZero: false
  },
  agentPreview: {
    name: "agentPreview",
    defaultHost: DEFAULT_HOST,
    hostEnv: ["HUNSU_AGENT_PREVIEW_HOST"],
    defaultPort: 19673,
    portEnv: ["HUNSU_AGENT_PREVIEW_PORT"],
    reserved: true,
    allowPortZero: false
  },
};

export const HUNSU_ACTIVE_SERVICE_PORTS = ["bridgeApi", "studioWeb"] as const satisfies readonly HunsuPortName[];
export const HUNSU_STUDIO_WEB_ACTIVE_PORTS = ["bridgeApi", "studioWeb"] as const satisfies readonly HunsuPortName[];
const CODEX_SANDBOX_MODES = ["read-only", "workspace-write", "danger-full-access"] as const;
const CODEX_APPROVAL_POLICIES = ["never", "on-request", "on-failure", "untrusted"] as const;
const CODEX_APPROVALS_REVIEWERS = ["user", "auto_review"] as const;
const BRIDGE_TEST_RUNNERS = ["deterministic"] as const;

export function ok<T>(value: T): ConfigResult<T> {
  return { ok: true, value };
}

export function err(error: HunsuConfigError): ConfigResult<never> {
  return { ok: false, error };
}

export function mapConfigResult<T, U>(result: ConfigResult<T>, transform: (value: T) => U): ConfigResult<U> {
  return result.ok ? ok(transform(result.value)) : result;
}

export function flatMapConfigResult<T, U>(result: ConfigResult<T>, transform: (value: T) => ConfigResult<U>): ConfigResult<U> {
  return result.ok ? transform(result.value) : result;
}

export function unwrapConfigResult<T>(result: ConfigResult<T>): T {
  if (result.ok) {
    return result.value;
  }
  throw new Error(result.error.message);
}

export function resolveHunsuPorts(env: Env, options: HunsuPortResolveOptions = {}): ConfigResult<HunsuPortConfig> {
  const bridgeApi = resolveEndpoint(HUNSU_PORT_SPECS.bridgeApi, env, options.overrides?.bridgeApi);
  if (!bridgeApi.ok) {
    return bridgeApi;
  }

  const studioWeb = resolveEndpoint(HUNSU_PORT_SPECS.studioWeb, env, options.overrides?.studioWeb);
  if (!studioWeb.ok) {
    return studioWeb;
  }

  const agentPreview = resolveEndpoint(HUNSU_PORT_SPECS.agentPreview, env, options.overrides?.agentPreview);
  if (!agentPreview.ok) {
    return agentPreview;
  }

  return ok({
    bridgeApi: bridgeApi.value,
    studioWeb: studioWeb.value,
    agentPreview: agentPreview.value
  });
}

export function resolveValidatedHunsuPorts(env: Env, options: HunsuPortResolveOptions & HunsuPortValidationOptions): ConfigResult<HunsuPortConfig> {
  return flatMapConfigResult(resolveHunsuPorts(env, options), config => validateNoPortConflicts(config, options.activePortNames));
}

export function resolveStudioWebServerConfig(env: Env): ConfigResult<StudioWebServerConfig> {
  return flatMapConfigResult(
    resolveValidatedHunsuPorts(env, { activePortNames: HUNSU_STUDIO_WEB_ACTIVE_PORTS }),
    ports => flatMapConfigResult(readConfigBoolean(env, "HUNSU_WEB_STRICT_PORT", true), strictPort =>
      flatMapConfigResult(readOptionalUrl(env, "VITE_HUNSU_BRIDGE_URL"), browserBridgeUrl =>
        flatMapConfigResult(readFirstOptionalUrl(env, ["VITE_HUNSU_HUB_API_URL", "HUNSU_HUB_PUBLIC_API_URL"], defaultBrowserHubApiUrl(env)), browserHubApiUrl =>
          flatMapConfigResult(readFirstOptionalUrl(env, ["VITE_HUNSU_CONNECT_API_URL", "HUNSU_CONNECT_API_BASE_URL"]), browserConnectApiUrl =>
            mapConfigResult(readFirstUrl(env, ["HUNSU_BRIDGE_API_PROXY_TARGET"], browserBridgeUrl ?? endpointUrl(ports.bridgeApi)), apiProxyTarget => ({
              web: ports.studioWeb,
              bridgeApi: ports.bridgeApi,
              strictPort,
              apiProxyTarget,
              browserBridgeUrl,
              browserHubApiUrl,
              browserConnectApiUrl
            }))
          )
        )
      )
    )
  );
}

export function resolveStudioLauncherConfig(env: Env): ConfigResult<StudioLauncherConfig> {
  return mapConfigResult(readConfigUrl(env, "HUNSU_WEB_URL", DEFAULT_STUDIO_WEB_URL), webUrl => ({ webUrl }));
}

export function currentProcessEnv(): Env {
  return process.env;
}

function defaultBrowserHubApiUrl(env: Env): string | undefined {
  const target = firstNonEmpty(env, ["HUNSU_DEPLOY_TARGET"])?.value;
  if (target === undefined || target === "local") {
    return DEFAULT_LOCAL_HUB_API_URL;
  }
  return undefined;
}

export function resolveBridgeApiServerConfig(env: Env): ConfigResult<BridgeApiServerConfig> {
  return mapConfigResult(
    resolveValidatedHunsuPorts(env, { activePortNames: ["bridgeApi"] }),
    ports => ({ bridgeApi: ports.bridgeApi })
  );
}

export function resolveBridgeRuntimeConfig(env: Env, options: BridgeRuntimeConfigOptions = {}): ConfigResult<BridgeRuntimeConfig> {
  const processEnv = filterEnv(options.processEnv ?? env);
  return flatMapConfigResult(resolveBridgeApiServerConfig(env), ({ bridgeApi }) =>
    flatMapConfigResult(resolveRequiredConfiguredPath(
      options.roadmapRegistryPath,
      env,
      "HUNSU_ROADMAP_REGISTRY_PATH",
      join(options.homeDir ?? homedir(), ".config", "hunsu", "roadmaps.json"),
      options.cwd
    ), roadmapRegistryPath =>
      flatMapConfigResult(resolveConfiguredPath(options.routeWorktreeRoot, env, "HUNSU_ROUTE_WORKTREE_ROOT", undefined, options.cwd), routeWorktreeRoot =>
        flatMapConfigResult(resolveConfiguredPath(options.actionWorktreeRoot, env, "HUNSU_ACTION_WORKTREE_ROOT", undefined, options.cwd), actionWorktreeRoot =>
          flatMapConfigResult(readOptionalEnum(env, "HUNSU_BRIDGE_TEST_RUNNER", BRIDGE_TEST_RUNNERS), testRunner =>
            flatMapConfigResult(resolveCodexAppServerConfig(env, options.codexAppServer), codexAppServer =>
              mapConfigResult(resolveCodexThreadOptions(env, options.codexThreadOptions), codexThreadOptions => ({
                bridgeApi,
                processEnv,
                roadmapRegistryPath,
                routeWorktreeRoot,
                actionWorktreeRoot,
                testRunner,
                codexAppServer,
                codexThreadOptions
              }))
            )
          )
        )
      )
    )
  );
}

export function resolveConnectClientConfig(env: Env): ConfigResult<ConnectClientConfig> {
  return flatMapConfigResult(
    readFirstUrl(env, ["HUNSU_CONNECT_API_BASE_URL"], "https://connect.hunsu.app"),
    connectApiUrl => mapConfigResult(
      readFirstOptionalWebSocketUrl(
        env,
        ["HUNSU_CONNECT_WS_URL"],
        httpUrlToWebSocketUrl(`${connectApiUrl}/v1/connect/device`)
      ),
      connectWsUrl => ({
        connectApiUrl,
        connectWsUrl: connectWsUrl ?? httpUrlToWebSocketUrl(`${connectApiUrl}/v1/connect/device`)
      })
    )
  );
}

export function validateNoPortConflicts(config: HunsuPortConfig, activePortNames: readonly HunsuPortName[]): ConfigResult<HunsuPortConfig> {
  for (let i = 0; i < activePortNames.length; i += 1) {
    const left = config[activePortNames[i]];
    if (left.port === 0) {
      continue;
    }
    for (let j = i + 1; j < activePortNames.length; j += 1) {
      const right = config[activePortNames[j]];
      if (right.port !== left.port || right.port === 0) {
        continue;
      }
      if (hostsMayConflict(left.host, right.host)) {
        return err({
          code: "port_conflict",
          message: `Hunsu port conflict: ${left.name} and ${right.name} both use ${left.host}:${left.port}.`,
          port: left.port
        });
      }
    }
  }
  return ok(config);
}

export function endpointUrl(endpoint: Pick<HunsuEndpoint, "host" | "port">): string {
  return `http://${endpoint.host}:${endpoint.port}`;
}

export function readConfigBoolean(env: Env, envName: string, fallback: boolean): ConfigResult<boolean> {
  const raw = env[envName];
  if (raw === undefined || raw.trim() === "") {
    return ok(fallback);
  }
  return parseConfigBoolean(envName, raw);
}

export function readConfigEnum<const T extends string>(env: Env, envName: string, allowed: readonly T[], fallback: T): ConfigResult<T> {
  const raw = env[envName];
  if (raw === undefined || raw.trim() === "") {
    return ok(fallback);
  }
  return parseConfigEnum(envName, raw, allowed);
}

export function readConfigOptionalString(env: Env, envName: string): ConfigResult<string | undefined> {
  const raw = env[envName];
  return ok(raw === undefined || raw.trim() === "" ? undefined : raw);
}

export function readConfigUrl(env: Env, envName: string, fallback: string): ConfigResult<string> {
  const raw = env[envName];
  return validateUrl(raw === undefined || raw.trim() === "" ? fallback : raw, envName);
}

export function readConfigJsonStringArray(env: Env, envName: string, fallback: readonly string[] = []): ConfigResult<string[]> {
  const raw = env[envName];
  if (raw === undefined || raw.trim() === "") {
    return ok([...fallback]);
  }
  return parseJsonStringArray(envName, raw);
}

export function readConfigPath(env: Env, envName: string, fallback: string, cwd?: string): ConfigResult<string> {
  const raw = env[envName];
  return validatePath(raw === undefined || raw.trim() === "" ? fallback : raw, envName, cwd);
}

export function resolveCodexAppServerConfig(env: Env, overrides: BridgeRuntimeConfigOptions["codexAppServer"] = {}): ConfigResult<CodexAppServerConfig> {
  const command = overrides.command ?? firstNonEmpty(env, ["HUNSU_CODEX_APP_SERVER_COMMAND"])?.value ?? "codex";
  if (command.trim() === "") {
    return err({
      code: "missing_required_env",
      env: "HUNSU_CODEX_APP_SERVER_COMMAND",
      message: "Invalid HUNSU_CODEX_APP_SERVER_COMMAND: expected a non-empty command."
    });
  }
  return mapConfigResult(resolveCodexAppServerArgs(env, overrides.args), args => ({
    command,
    args,
    environment: filterEnv(overrides.environment ?? env)
  }));
}

export function resolveCodexThreadOptions(env: Env, overrides: CodexThreadOptionsConfig = {}): ConfigResult<CodexThreadOptionsConfig> {
  return flatMapConfigResult(readOptionalEnum(env, "HUNSU_CODEX_SANDBOX_MODE", CODEX_SANDBOX_MODES), sandboxMode =>
    flatMapConfigResult(readOptionalEnum(env, "HUNSU_CODEX_APPROVAL_POLICY", CODEX_APPROVAL_POLICIES), approvalPolicy =>
      flatMapConfigResult(readOptionalEnum(env, "HUNSU_CODEX_APPROVALS_REVIEWER", CODEX_APPROVALS_REVIEWERS), approvalsReviewer =>
        flatMapConfigResult(readOptionalBoolean(env, "HUNSU_CODEX_NETWORK_ACCESS"), networkAccessEnabled =>
          mapConfigResult(readCommaSeparatedList(env, "HUNSU_CODEX_ADDITIONAL_DIRECTORIES"), additionalDirectories => ({
            ...(sandboxMode === undefined ? {} : { sandboxMode }),
            ...(approvalPolicy === undefined ? {} : { approvalPolicy }),
            ...(approvalsReviewer === undefined ? {} : { approvalsReviewer }),
            ...(networkAccessEnabled === undefined ? {} : { networkAccessEnabled }),
            ...(additionalDirectories.length === 0 ? {} : { additionalDirectories }),
            ...overrides
          }))
        )
      )
    )
  );
}

function resolveEndpoint(spec: PortSpec, env: Env, override: { host?: string; port?: number } | undefined): ConfigResult<HunsuEndpoint> {
  const hostValue = override?.host !== undefined
    ? { value: override.host, source: "override" as const, env: undefined }
    : firstNonEmpty(env, spec.hostEnv) ?? { value: spec.defaultHost, source: "default" as const, env: undefined };

  const portValue = override?.port !== undefined
    ? mapConfigResult(validatePort(override.port, spec, undefined), port => ({ value: port, source: "override" as const, env: undefined }))
    : readPort(env, spec);

  return mapConfigResult(portValue, port => ({
    name: spec.name,
    host: hostValue.value,
    hostSource: hostValue.source,
    hostEnv: hostValue.env,
    port: port.value,
    portSource: port.source,
    portEnv: port.env,
    reserved: spec.reserved
  }));
}

function readPort(env: Env, spec: PortSpec): ConfigResult<{ value: number; source: ConfigValueSource; env?: string }> {
  const envValue = firstNonEmpty(env, spec.portEnv);
  if (!envValue) {
    return ok({ value: spec.defaultPort, source: "default" });
  }
  return mapConfigResult(validatePort(envValue.value, spec, envValue.env), port => ({
    value: port,
    source: "env",
    env: envValue.env
  }));
}

function validatePort(value: string | number, spec: PortSpec, envName: string | undefined): ConfigResult<number> {
  const port = typeof value === "number" ? value : Number(value);
  const min = spec.allowPortZero ? 0 : 1;
  if (!Number.isInteger(port) || port < min || port > 65535) {
    return err({
      code: "invalid_port",
      env: envName,
      portName: spec.name,
      message: envName
        ? `Invalid ${envName}: ${value}. Expected an integer port from ${min} to 65535.`
        : `Invalid ${spec.name} port: ${value}. Expected an integer port from ${min} to 65535.`
    });
  }
  return ok(port);
}

function parseConfigBoolean(envName: string, raw: string): ConfigResult<boolean> {
  if (/^(1|true|yes|on)$/i.test(raw)) {
    return ok(true);
  }
  if (/^(0|false|no|off)$/i.test(raw)) {
    return ok(false);
  }
  return err({
    code: "invalid_boolean",
    env: envName,
    message: `Invalid ${envName}: ${raw}. Expected true, false, 1, 0, yes, no, on, or off.`
  });
}

function readOptionalBoolean(env: Env, envName: string): ConfigResult<boolean | undefined> {
  const raw = env[envName];
  return raw === undefined || raw.trim() === "" ? ok(undefined) : parseConfigBoolean(envName, raw);
}

function parseConfigEnum<const T extends string>(envName: string, value: string, allowed: readonly T[]): ConfigResult<T> {
  if (allowed.includes(value as T)) {
    return ok(value as T);
  }
  return err({
    code: "invalid_enum",
    env: envName,
    value,
    allowed,
    message: `Invalid ${envName}: ${value}. Expected one of: ${allowed.join(", ")}.`
  });
}

function readOptionalEnum<const T extends string>(env: Env, envName: string, allowed: readonly T[]): ConfigResult<T | undefined> {
  const raw = env[envName];
  return raw === undefined || raw.trim() === "" ? ok(undefined) : parseConfigEnum(envName, raw, allowed);
}

function readOptionalUrl(env: Env, envName: string): ConfigResult<string | undefined> {
  const raw = env[envName];
  return raw === undefined || raw.trim() === "" ? ok(undefined) : validateUrl(raw, envName);
}

function readFirstUrl(env: Env, envNames: readonly string[], fallback: string): ConfigResult<string> {
  const raw = firstNonEmpty(env, envNames);
  return validateUrl(raw?.value ?? fallback, raw?.env ?? envNames[0]);
}

function readFirstOptionalUrl(env: Env, envNames: readonly string[], fallback?: string): ConfigResult<string | undefined> {
  const raw = firstNonEmpty(env, envNames);
  const value = raw?.value ?? fallback;
  return value === undefined ? ok(undefined) : validateUrl(value, raw?.env ?? envNames[0]);
}

function readFirstOptionalWebSocketUrl(env: Env, envNames: readonly string[], fallback?: string): ConfigResult<string | undefined> {
  const raw = firstNonEmpty(env, envNames);
  const value = raw?.value ?? fallback;
  return value === undefined ? ok(undefined) : validateWebSocketUrl(value, raw?.env ?? envNames[0]);
}

function validateUrl(value: string, envName: string | undefined): ConfigResult<string> {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("Unsupported protocol");
    }
    return ok(url.toString().replace(/\/$/, ""));
  } catch (_error) {
    return err({
      code: "invalid_url",
      env: envName,
      value,
      message: envName
        ? `Invalid ${envName}: ${value}. Expected an http or https URL.`
        : `Invalid URL: ${value}. Expected an http or https URL.`
    });
  }
}

function validateWebSocketUrl(value: string, envName: string | undefined): ConfigResult<string> {
  try {
    const url = new URL(value);
    if (url.protocol !== "ws:" && url.protocol !== "wss:") {
      throw new Error("Unsupported protocol");
    }
    return ok(url.toString().replace(/\/$/, ""));
  } catch (_error) {
    return err({
      code: "invalid_url",
      env: envName,
      value,
      message: envName
        ? `Invalid ${envName}: ${value}. Expected a ws or wss URL.`
        : `Invalid WebSocket URL: ${value}. Expected a ws or wss URL.`
    });
  }
}

function httpUrlToWebSocketUrl(value: string): string {
  const url = new URL(value);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString().replace(/\/$/, "");
}


function resolveConfiguredPath(override: string | undefined, env: Env, envName: string, fallback: string | undefined, cwd?: string): ConfigResult<string | undefined> {
  if (override !== undefined) {
    return validatePath(override, undefined, cwd);
  }
  const raw = env[envName];
  if (raw !== undefined && raw.trim() !== "") {
    return validatePath(raw, envName, cwd);
  }
  return fallback === undefined ? ok(undefined) : validatePath(fallback, undefined, cwd);
}

function resolveRequiredConfiguredPath(override: string | undefined, env: Env, envName: string, fallback: string, cwd?: string): ConfigResult<string> {
  return mapConfigResult(resolveConfiguredPath(override, env, envName, fallback, cwd), path => path ?? resolve(cwd ?? ".", fallback));
}

function validatePath(value: string, envName: string | undefined, cwd = "."): ConfigResult<string> {
  if (value.trim() === "" || value.includes("\0")) {
    return err({
      code: "invalid_path",
      env: envName,
      path: value,
      message: envName
        ? `Invalid ${envName}: expected a non-empty filesystem path.`
        : "Invalid filesystem path: expected a non-empty path."
    });
  }
  return ok(resolve(cwd, value));
}

function resolveCodexAppServerArgs(env: Env, override: readonly string[] | undefined): ConfigResult<string[]> {
  if (override !== undefined) {
    return ok([...override]);
  }
  const raw = env.HUNSU_CODEX_APP_SERVER_ARGS;
  if (raw === undefined || raw.trim() === "") {
    return ok(["app-server", "--stdio"]);
  }
  if (raw.trim().startsWith("[")) {
    return parseJsonStringArray("HUNSU_CODEX_APP_SERVER_ARGS", raw);
  }
  return ok(raw.split(/\s+/).filter(Boolean));
}

function parseJsonStringArray(envName: string, raw: string): ConfigResult<string[]> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed) && parsed.every(item => typeof item === "string")) {
      return ok(parsed);
    }
  } catch (_error) {
    return err({
      code: "invalid_json",
      env: envName,
      value: raw,
      message: `Invalid ${envName}: expected a JSON string array.`
    });
  }
  return err({
    code: "invalid_json",
    env: envName,
    value: raw,
    message: `Invalid ${envName}: expected a JSON string array.`
  });
}

function readCommaSeparatedList(env: Env, envName: string): ConfigResult<string[]> {
  const raw = env[envName];
  return ok(raw === undefined || raw.trim() === ""
    ? []
    : raw.split(",").map(value => value.trim()).filter(Boolean));
}

function filterEnv(env: Env): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      next[key] = value;
    }
  }
  return next;
}

function firstNonEmpty(env: Env, names: readonly string[]): { value: string; source: "env"; env: string } | undefined {
  for (const name of names) {
    const value = env[name];
    if (value !== undefined && value.trim() !== "") {
      return { value, source: "env", env: name };
    }
  }
  return undefined;
}

function hostsMayConflict(left: string, right: string): boolean {
  const normalizedLeft = normalizeHost(left);
  const normalizedRight = normalizeHost(right);
  return normalizedLeft === normalizedRight || isWildcardHost(normalizedLeft) || isWildcardHost(normalizedRight);
}

function normalizeHost(host: string): string {
  const normalized = host.trim().toLowerCase();
  return normalized === "localhost" ? DEFAULT_HOST : normalized;
}

function isWildcardHost(host: string): boolean {
  return host === "0.0.0.0" || host === "::" || host === "[::]";
}
