import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { currentProcessEnv } from "@hunsu/config";
import {
  CodexAppServerProbeClient,
  DEFAULT_CODEX_PROBE_TIMEOUT_MS,
  detectCodexBinary,
  effectiveCodexAppServerLaunchCommand,
  errorMessage,
  getCodexVersion,
  knownWindowsCodexInstallDirs,
  redactSecretText,
  sanitizeDiagnostics,
  windowsAwarePath,
  type CodexCliStatus,
  type CodexDiscoveryCandidate,
  type CodexDetectionOptions
} from "./codexDetection.ts";

const STATUS_CACHE_TTL_MS = 5_000;

export type CodexAuthHomeDiagnostic = {
  effectiveCodexHome?: string;
  defaultCodexHome?: string;
  authFileExistsAtEffectiveHome: boolean;
  authFileExistsAtDefaultHome: boolean;
  likelyHomeMismatch: boolean;
  remediation?: {
    type: "set_codex_home" | "login_again";
    message: string;
    suggestedCodexHome?: string;
  };
};

export type CodexRuntimeStatus = {
  runtime: "codex";
  cli: {
    installed: boolean;
    binaryPath?: string;
    source?: CodexCliStatus["source"];
    version?: string;
    discovery?: CodexDiscoveryCandidate[];
    installActionAvailable: boolean;
    error?: string;
  };
  appServer: {
    available: boolean;
    initialized?: unknown;
    error?: string;
  };
  auth: {
    state: "authenticated" | "not_authenticated" | "expired" | "invalid" | "unknown" | "error";
    method?: "chatgpt" | "api_key" | "access_token" | "unknown";
    access?: "subscription" | "usage_based" | "unknown";
    accountSummary?: {
      displayName?: string;
      email?: string;
      workspaceName?: string;
      planLabel?: string;
    };
    error?: string;
    homeDiagnostic?: CodexAuthHomeDiagnostic;
  };
  usage: {
    rateLimitsAvailable: boolean;
    rateLimitSummary?: {
      label: string;
      resetAt?: string;
      remainingLabel?: string;
    };
    rateLimited?: boolean;
    lastRunUsage?: {
      inputTokens: number;
      cachedInputTokens: number;
      outputTokens: number;
      reasoningTokens: number;
    };
    error?: string;
  };
  ready: boolean;
  recommendedAction: "install_codex" | "select_binary" | "login_codex" | "recheck" | "none";
};

export type CodexAccountProbeResult =
  | { ok: true; account: unknown }
  | { ok: false; authState: CodexRuntimeStatus["auth"]["state"]; error: string };

export type CodexRateLimitProbeResult =
  | { ok: true; rateLimits: unknown }
  | { ok: false; error: string };

export type CodexRuntimeStatusOptions = CodexDetectionOptions & {
  force?: boolean;
  lastRunUsage?: CodexRuntimeStatus["usage"]["lastRunUsage"];
};

let cachedStatus: { at: number; key: string; status: CodexRuntimeStatus } | undefined;

export async function readCodexAccount(input: {
  binaryPath: string;
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
}): Promise<CodexAccountProbeResult> {
  const env = input.env ?? currentProcessEnv();
  const launch = effectiveCodexAppServerLaunchCommand({ env, cliBinaryPath: input.binaryPath });
  if (!launch.ok) {
    return { ok: false, authState: "error", error: launch.error };
  }
  const client = new CodexAppServerProbeClient(launch.value.command, input.timeoutMs ?? DEFAULT_CODEX_PROBE_TIMEOUT_MS, {
    env,
    platform: input.platform,
    args: launch.value.args
  });
  try {
    await client.initialize();
    const account = await client.request("account/read", { refreshToken: false });
    return { ok: true, account: sanitizeDiagnostics(account) };
  } catch (error) {
    const message = errorMessage(error);
    return { ok: false, authState: authStateFromError(message), error: message };
  } finally {
    client.close();
  }
}

export async function readCodexRateLimits(input: {
  binaryPath: string;
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
}): Promise<CodexRateLimitProbeResult> {
  const env = input.env ?? currentProcessEnv();
  const launch = effectiveCodexAppServerLaunchCommand({ env, cliBinaryPath: input.binaryPath });
  if (!launch.ok) {
    return { ok: false, error: launch.error };
  }
  const client = new CodexAppServerProbeClient(launch.value.command, input.timeoutMs ?? DEFAULT_CODEX_PROBE_TIMEOUT_MS, {
    env,
    platform: input.platform,
    args: launch.value.args
  });
  try {
    await client.initialize();
    const rateLimits = await client.request("account/rateLimits/read");
    return { ok: true, rateLimits: sanitizeDiagnostics(rateLimits) };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  } finally {
    client.close();
  }
}

export async function probeCodexRuntimeWithAppServer(input: {
  binaryPath: string;
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
}): Promise<{
  appServer: CodexRuntimeStatus["appServer"];
  account?: CodexAccountProbeResult;
  rateLimits?: CodexRateLimitProbeResult;
}> {
  const env = input.env ?? currentProcessEnv();
  const launch = effectiveCodexAppServerLaunchCommand({ env, cliBinaryPath: input.binaryPath });
  if (!launch.ok) {
    return { appServer: { available: false, error: launch.error } };
  }
  const client = new CodexAppServerProbeClient(launch.value.command, input.timeoutMs ?? DEFAULT_CODEX_PROBE_TIMEOUT_MS, {
    env,
    platform: input.platform,
    args: launch.value.args
  });
  try {
    const initialized = await client.initialize();
    const account = await readAccountWithClient(client);
    const rateLimits = await readRateLimitsWithClient(client);
    return {
      appServer: { available: true, initialized: sanitizeDiagnostics(initialized) },
      account,
      rateLimits
    };
  } catch (error) {
    return { appServer: { available: false, error: errorMessage(error) } };
  } finally {
    client.close();
  }
}

export async function getCodexRuntimeStatus(options: CodexRuntimeStatusOptions = {}): Promise<CodexRuntimeStatus> {
  const env = options.env ?? currentProcessEnv();
  const platform = options.platform ?? process.platform;
  const cacheKey = JSON.stringify({
    customBinaryPath: options.customBinaryPath ?? env.HUNSU_CODEX_BINARY_PATH,
    envCommand: env.HUNSU_CODEX_APP_SERVER_COMMAND,
    envArgs: env.HUNSU_CODEX_APP_SERVER_ARGS,
    codexHome: env.CODEX_HOME,
    path: windowsAwarePath(env, platform),
    knownWindowsInstallDirs: knownWindowsCodexInstallDirs(env, platform),
    platform,
    lastRunUsage: options.lastRunUsage
  });
  if (!options.force && cachedStatus && cachedStatus.key === cacheKey && Date.now() - cachedStatus.at < STATUS_CACHE_TTL_MS) {
    return cachedStatus.status;
  }
  const cli = await detectCodexBinary(options);
  if (!cli.installed || !cli.binaryPath) {
    const status: CodexRuntimeStatus = {
      runtime: "codex",
      cli: { installed: false, source: cli.source, discovery: cli.discovery, installActionAvailable: true, error: cli.error },
      appServer: { available: false },
      auth: { state: "unknown", access: "unknown" },
      usage: { rateLimitsAvailable: false, lastRunUsage: options.lastRunUsage },
      ready: false,
      recommendedAction: cli.aliasDetected || cli.error?.includes("WindowsApps") ? "select_binary" : "install_codex"
    };
    cachedStatus = { at: Date.now(), key: cacheKey, status };
    return status;
  }

  const version = cli.version ?? await getCodexVersion({ binaryPath: cli.binaryPath, timeoutMs: options.timeoutMs, env, platform });
  const probe = await probeCodexRuntimeWithAppServer({ binaryPath: cli.binaryPath, timeoutMs: options.timeoutMs, env, platform });
  const appServer = probe.appServer;
  if (!appServer.available) {
    const status: CodexRuntimeStatus = {
      runtime: "codex",
      cli: { installed: true, binaryPath: cli.binaryPath, source: cli.source, version, discovery: cli.discovery, installActionAvailable: false, error: cli.error },
      appServer,
      auth: { state: "unknown", access: "unknown" },
      usage: { rateLimitsAvailable: false, lastRunUsage: options.lastRunUsage },
      ready: false,
      recommendedAction: "recheck"
    };
    cachedStatus = { at: Date.now(), key: cacheKey, status };
    return status;
  }

  const account = probe.account ?? { ok: false, authState: "unknown" as const, error: "Codex account probe did not return a result." };
  const rateLimits = probe.rateLimits ?? { ok: false, error: "Codex rate limit probe did not return a result." };
  const authWithoutHomeDiagnostic = account.ok
    ? codexAccountAuthStatus(account.account)
    : { state: account.authState, access: "unknown" as const, error: account.error };
  const homeDiagnostic = codexAuthHomeDiagnostic({ env, platform });
  const auth = authWithoutHomeDiagnostic.state === "not_authenticated" || authWithoutHomeDiagnostic.state === "expired" || authWithoutHomeDiagnostic.state === "invalid"
    ? { ...authWithoutHomeDiagnostic, homeDiagnostic }
    : authWithoutHomeDiagnostic;
  const rateLimit = rateLimits.ok ? rateLimitStatus(rateLimits.rateLimits) : undefined;
  const usage = rateLimits.ok
    ? {
        rateLimitsAvailable: true,
        rateLimitSummary: rateLimit?.summary,
        rateLimited: rateLimit?.rateLimited,
        lastRunUsage: options.lastRunUsage
      }
    : { rateLimitsAvailable: false, lastRunUsage: options.lastRunUsage, error: rateLimits.error };
  const ready = auth.state === "authenticated" && usage.rateLimited !== true;
  const status: CodexRuntimeStatus = {
    runtime: "codex",
    cli: { installed: true, binaryPath: cli.binaryPath, source: cli.source, version, discovery: cli.discovery, installActionAvailable: false, error: cli.error },
    appServer,
    auth,
    usage,
    ready,
    recommendedAction: ready ? "none" : auth.state === "not_authenticated" || auth.state === "expired" || auth.state === "invalid" ? "login_codex" : "recheck"
  };
  cachedStatus = { at: Date.now(), key: cacheKey, status };
  return status;
}

async function readAccountWithClient(client: CodexAppServerProbeClient): Promise<CodexAccountProbeResult> {
  try {
    const account = await client.request("account/read", { refreshToken: false });
    return { ok: true, account: sanitizeDiagnostics(account) };
  } catch (error) {
    const message = errorMessage(error);
    return { ok: false, authState: authStateFromError(message), error: message };
  }
}

async function readRateLimitsWithClient(client: CodexAppServerProbeClient): Promise<CodexRateLimitProbeResult> {
  try {
    const rateLimits = await client.request("account/rateLimits/read");
    return { ok: true, rateLimits: sanitizeDiagnostics(rateLimits) };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

export function codexRuntimePreflightError(status: CodexRuntimeStatus): ExecutePreflightError | undefined {
  if (!status.cli.installed) {
    return preflight("CODEX_CLI_MISSING", "Codex CLI is not installed or was not found.", [
      { type: "install_codex", label: "Install Codex" },
      { type: "open_prerequisites", label: "Open Prerequisites" }
    ]);
  }
  if (!status.appServer.available) {
    return preflight("CODEX_APP_SERVER_UNAVAILABLE", status.appServer.error ?? "Codex app-server is unavailable.", [
      { type: "codex_recheck", label: "Recheck Codex" },
      { type: "open_prerequisites", label: "Open Prerequisites" }
    ]);
  }
  if (status.auth.state === "not_authenticated") {
    return preflight("CODEX_LOGIN_REQUIRED", "Codex login is required before Execute can start.", [
      { type: "codex_login_chatgpt", label: "Sign in with ChatGPT" },
      { type: "codex_login_device", label: "Use Device Code" },
      { type: "open_prerequisites", label: "Open Prerequisites" }
    ]);
  }
  if (status.auth.state === "expired") {
    return preflight("CODEX_AUTH_EXPIRED", "Codex authentication is expired. Sign in again before Execute.", [
      { type: "codex_login_chatgpt", label: "Sign in with ChatGPT" },
      { type: "codex_recheck", label: "Recheck Codex" }
    ]);
  }
  if (status.auth.state === "invalid") {
    return preflight("CODEX_LOGIN_REQUIRED", "Codex authentication is invalid. Sign in again before Execute.", [
      { type: "codex_login_chatgpt", label: "Sign in with ChatGPT" },
      { type: "codex_recheck", label: "Recheck Codex" }
    ]);
  }
  if (status.auth.state !== "authenticated") {
    return preflight("CODEX_RUNTIME_UNKNOWN", status.auth.error ?? "Codex runtime readiness could not be confirmed.", [
      { type: "codex_recheck", label: "Recheck Codex" },
      { type: "open_prerequisites", label: "Open Prerequisites" }
    ]);
  }
  if (status.usage.rateLimited) {
    const reset = status.usage.rateLimitSummary?.resetAt ? ` Reset: ${status.usage.rateLimitSummary.resetAt}.` : "";
    return preflight("CODEX_RATE_LIMITED", `Codex access is temporarily unavailable because it is rate limited.${reset}`, [
      { type: "codex_recheck", label: "Recheck Codex" },
      { type: "open_prerequisites", label: "Open Prerequisites" }
    ]);
  }
  return undefined;
}

export type ExecutePreflightError = {
  area: "codex";
  error: "CODEX_CLI_MISSING" | "CODEX_LOGIN_REQUIRED" | "CODEX_AUTH_EXPIRED" | "CODEX_APP_SERVER_UNAVAILABLE" | "CODEX_RATE_LIMITED" | "CODEX_RUNTIME_UNKNOWN";
  message: string;
  runtime: "codex";
  actions: ExecutePreflightAction[];
} | {
  area: "roadmap";
  error: "ROADMAP_INACTIVE" | "ROADMAP_MISSING" | "ROADMAP_NEEDS_UPGRADE" | "ROADMAP_UNHEALTHY";
  message: string;
  roadmapId?: string;
  lifecycle?: "inactive" | "missing" | "needs_upgrade" | "error";
  actions: ExecutePreflightAction[];
};

export type ExecutePreflightAction = {
  type:
    | "install_codex"
    | "codex_login_chatgpt"
    | "codex_login_device"
    | "codex_recheck"
    | "open_bridge_app"
    | "open_prerequisites"
    | "open_roadmaps"
    | "activate_roadmap";
  label: string;
  href?: string;
  roadmapId?: string;
};

function preflight(error: Extract<ExecutePreflightError, { area: "codex" }>["error"], message: string, actions: ExecutePreflightAction[]): ExecutePreflightError {
  return { area: "codex", error, message, runtime: "codex", actions: [{ type: "open_bridge_app", label: "Open Bridge App", href: "hunsu://open" }, ...actions] };
}

export function codexAuthHomeDiagnostic(input: {
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  homeDir?: string;
} = {}): CodexAuthHomeDiagnostic {
  const env = input.env ?? currentProcessEnv();
  const platform = input.platform ?? process.platform;
  const defaultCodexHome = defaultCodexHomePath(env, platform, input.homeDir ?? homedir());
  const effectiveCodexHome = env.CODEX_HOME?.trim() || defaultCodexHome;
  const authFileExistsAtEffectiveHome = authJsonExists(effectiveCodexHome);
  const authFileExistsAtDefaultHome = authJsonExists(defaultCodexHome);
  const likelyHomeMismatch = Boolean(
    effectiveCodexHome
      && defaultCodexHome
      && !authFileExistsAtEffectiveHome
      && authFileExistsAtDefaultHome
      && normalizeCodexHomeForComparison(effectiveCodexHome, platform) !== normalizeCodexHomeForComparison(defaultCodexHome, platform)
  );
  return {
    effectiveCodexHome,
    defaultCodexHome,
    authFileExistsAtEffectiveHome,
    authFileExistsAtDefaultHome,
    likelyHomeMismatch,
    remediation: likelyHomeMismatch
      ? {
          type: "set_codex_home",
          message: `Codex auth was not found for CODEX_HOME=${effectiveCodexHome}. Default Codex auth appears to exist at ${defaultCodexHome}. Set Codex Home to this path or sign in again for the current Codex Home.`,
          suggestedCodexHome: defaultCodexHome
        }
      : authFileExistsAtEffectiveHome
        ? undefined
        : {
            type: "login_again",
            message: `Codex auth was not found for CODEX_HOME=${effectiveCodexHome}. Sign in again for this Codex Home.`
          }
  };
}

export function defaultCodexHomePath(
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform,
  fallbackHomeDir = homedir()
): string {
  if (platform === "win32") {
    const userProfile = firstNonEmpty(env, ["USERPROFILE", "UserProfile", "userprofile"]);
    const homeDrive = firstNonEmpty(env, ["HOMEDRIVE", "HomeDrive", "homedrive"]);
    const homePath = firstNonEmpty(env, ["HOMEPATH", "HomePath", "homepath"]);
    const home = userProfile ?? (homeDrive && homePath ? `${homeDrive}${homePath}` : undefined) ?? firstNonEmpty(env, ["HOME", "Home", "home"]) ?? fallbackHomeDir;
    return join(home, ".codex");
  }
  return join(firstNonEmpty(env, ["HOME"]) ?? fallbackHomeDir, ".codex");
}

function authJsonExists(codexHome: string | undefined): boolean {
  return Boolean(codexHome && existsSync(join(codexHome, "auth.json")));
}

function normalizeCodexHomeForComparison(value: string, platform: NodeJS.Platform): string {
  const normalized = value.replace(/\\/g, "/").replace(/\/+$/, "");
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

function firstNonEmpty(env: Record<string, string | undefined>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = env[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

export function codexAccountAuthStatus(account: unknown): CodexRuntimeStatus["auth"] {
  const object = isRecord(account) ? account : {};
  const nestedAccount = isRecord(object.account) ? object.account : undefined;
  if (!nestedAccount && object.requiresOpenaiAuth === true) {
    return { state: "not_authenticated", access: "unknown" };
  }
  const accountDetails = nestedAccount ? { ...object, ...nestedAccount } : object;
  const method = authMethod(accountDetails);
  return {
    state: "authenticated",
    method,
    access: method === "api_key" || method === "access_token" ? "usage_based" : method === "chatgpt" ? "subscription" : "unknown",
    accountSummary: {
      displayName: stringField(accountDetails, ["displayName", "name", "userName"]),
      email: stringField(accountDetails, ["email", "userEmail"]),
      workspaceName: stringField(accountDetails, ["workspaceName", "organizationName", "orgName"]),
      planLabel: stringField(accountDetails, ["planLabel", "plan", "planType", "subscriptionPlan"])
    }
  };
}

function authMethod(object: Record<string, unknown>): CodexRuntimeStatus["auth"]["method"] {
  const nested = isRecord(object.account) ? object.account : {};
  const raw = `${stringField(object, ["authMethod", "method", "loginMethod", "accountType", "type"]) ?? stringField(nested, ["authMethod", "method", "loginMethod", "accountType", "type"]) ?? ""}`.toLowerCase();
  if (raw.includes("chatgpt") || raw.includes("subscription")) return "chatgpt";
  if (raw.includes("api")) return "api_key";
  if (raw.includes("access")) return "access_token";
  return "unknown";
}

function authStateFromError(message: string): CodexRuntimeStatus["auth"]["state"] {
  const lower = message.toLowerCase();
  if (lower.includes("not authenticated") || lower.includes("login") || lower.includes("sign in") || lower.includes("unauthorized")) return "not_authenticated";
  if (lower.includes("expired")) return "expired";
  if (lower.includes("invalid")) return "invalid";
  return "error";
}

function rateLimitStatus(value: unknown): { summary: CodexRuntimeStatus["usage"]["rateLimitSummary"]; rateLimited: boolean } {
  const object = rateLimitObject(value);
  const summary = {
    label: stringField(object, ["label", "status", "summary"]) ?? (isRateLimitedObject(object) ? "Rate limited" : "Available"),
    resetAt: stringField(object, ["resetAt", "reset_at"]),
    remainingLabel: stringField(object, ["remainingLabel", "remaining"])
  };
  return {
    summary,
    rateLimited: isRateLimitedObject(object) || isRateLimitedText(`${summary.label} ${summary.remainingLabel ?? ""}`)
  };
}

function rateLimitObject(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    return {};
  }
  if (isRecord(value.rateLimits)) {
    return { ...value, ...value.rateLimits };
  }
  return value;
}

function isRateLimitedObject(object: Record<string, unknown>): boolean {
  if (object.rateLimited === true || object.limited === true) {
    return true;
  }
  const reachedType = stringField(object, ["rateLimitReachedType", "rate_limit_reached_type"]);
  if (reachedType && reachedType.toLowerCase() !== "none") {
    return true;
  }
  return isRateLimitedText(stringField(object, ["label", "status", "summary", "remainingLabel", "remaining"]) ?? "");
}

function isRateLimitedText(value: string): boolean {
  return /\brate.?limited\b|quota exceeded|temporarily unavailable|no remaining/i.test(value);
}

function stringField(object: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = object[key];
    if (typeof value === "string" && value.trim()) {
      return redactSecretText(value.trim());
    }
    if (typeof value === "number") {
      return String(value);
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export { sanitizeDiagnostics };
