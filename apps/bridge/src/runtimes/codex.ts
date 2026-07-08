import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { accessSync, constants, existsSync, readdirSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { currentProcessEnv } from "@hunsu/config";

const execFileAsync = promisify(execFile);
const DEFAULT_PROBE_TIMEOUT_MS = 3_500;
const STATUS_CACHE_TTL_MS = 5_000;
const WINDOWS_CODEX_SELECT_PATH_MESSAGE = [
  "Codex works in your terminal, but Hunsu Bridge App cannot find it.",
  "",
  "This can happen when Windows resolves `codex` through an App Execution Alias or a shell-specific PATH that desktop apps do not inherit.",
  "",
  "Select the real codex.exe file or restart Hunsu Bridge App after updating PATH."
].join("\n");

export type CodexCliStatus = {
  installed: boolean;
  binaryPath?: string;
  source?: CodexBinarySource;
  version?: string;
  error?: string;
  discovery?: CodexDiscoveryReport;
};

export type CodexBinarySource =
  | "custom"
  | "env"
  | "path"
  | "windows_user_path"
  | "windows_machine_path"
  | "where"
  | "powershell"
  | "known_install_dir"
  | "windows_apps_alias"
  | "unknown";

export type CodexDiscoveryCandidateStatus =
  | "usable"
  | "missing"
  | "invalid"
  | "alias"
  | "skipped";

export type CodexDiscoveryCandidate = {
  source: CodexBinarySource;
  command?: string;
  binaryPath?: string;
  status: CodexDiscoveryCandidateStatus;
  version?: string;
  reason?: string;
};

export type CodexDiscoveryReport = {
  platform: NodeJS.Platform;
  candidates: CodexDiscoveryCandidate[];
  suspectedInstalled: boolean;
  message?: string;
};

export type CodexRuntimeStatus = {
  runtime: "codex";
  cli: {
    installed: boolean;
    binaryPath?: string;
    source?: CodexBinarySource;
    version?: string;
    installActionAvailable: boolean;
    error?: string;
    discovery?: CodexDiscoveryReport;
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
  recommendedAction: "install_codex" | "select_codex_path" | "login_codex" | "recheck" | "none";
};

export type CodexAppServerProbeResult =
  | { available: true; initialized?: unknown }
  | { available: false; error: string };

export type CodexAccountProbeResult =
  | { ok: true; account: unknown }
  | { ok: false; authState: CodexRuntimeStatus["auth"]["state"]; error: string };

export type CodexRateLimitProbeResult =
  | { ok: true; rateLimits: unknown }
  | { ok: false; error: string };

export type CodexRuntimeStatusOptions = {
  env?: Record<string, string | undefined>;
  customBinaryPath?: string;
  timeoutMs?: number;
  force?: boolean;
  lastRunUsage?: CodexRuntimeStatus["usage"]["lastRunUsage"];
  platform?: NodeJS.Platform;
  windowsUserPath?: string;
  windowsMachinePath?: string;
  commandRunner?: CodexDiscoveryCommandRunner;
};

export type CodexDiscoveryCommandRunner = (
  command: string,
  args: string[],
  options: {
    env: Record<string, string | undefined>;
    timeoutMs: number;
  }
) => Promise<{ status: number | null; stdout: string; stderr: string }>;

type CodexCommandResolution =
  | {
      kind: "binary";
      installed: true;
      binaryPath: string;
      source: CodexBinarySource;
    }
  | {
      kind: "missing";
      installed: false;
      source: CodexBinarySource;
      binaryPath?: string;
      error: string;
    }
  | {
      kind: "unsupported_command_string";
      installed: false;
      source: "env";
      error: string;
    };

type JsonRpcMessage = {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { message?: string };
};

let cachedStatus: { at: number; key: string; status: CodexRuntimeStatus } | undefined;

export async function detectCodexBinary(options: CodexRuntimeStatusOptions = {}): Promise<CodexCliStatus> {
  const env = options.env ?? currentProcessEnv();
  const platform = options.platform ?? process.platform;
  const discovery: CodexDiscoveryReport = {
    platform,
    candidates: [],
    suspectedInstalled: false
  };
  const customPath = options.customBinaryPath?.trim() || env.HUNSU_CODEX_BINARY_PATH?.trim();
  if (customPath) {
    return binaryStatusFromCandidate(customPath, "custom", env, platform, discovery);
  }
  const envCommand = env.HUNSU_CODEX_APP_SERVER_COMMAND?.trim();
  if (envCommand) {
    const envStatus = binaryStatusFromCandidate(envCommand, "env", env, platform, discovery);
    if (envStatus.installed || platform !== "win32" || isAbsoluteForPlatform(envCommand, platform) || /\s/.test(envCommand)) {
      return envStatus;
    }
  }
  const pathCandidate = findExecutableOnPath("codex", env, platform);
  if (pathCandidate) {
    if (platform === "win32") {
      const pathStatus = await validateWindowsDiscoveryCandidate(pathCandidate, "path", env, { ...options, env, platform });
      discovery.candidates.push(pathStatus);
      if (pathStatus.status === "usable" && pathStatus.binaryPath) {
        discovery.suspectedInstalled = true;
        return {
          installed: true,
          binaryPath: pathStatus.binaryPath,
          source: "path",
          version: pathStatus.version,
          discovery
        };
      }
      if (pathStatus.status === "alias" || pathStatus.status === "invalid") {
        discovery.suspectedInstalled = true;
      }
    } else {
      return binaryStatusFromCandidate(pathCandidate, "path", env, platform, discovery);
    }
  }
  if (platform === "win32") {
    const windowsStatus = await detectCodexBinaryOnWindows({ ...options, env, platform, discovery });
    if (windowsStatus) {
      return windowsStatus;
    }
    if (discovery.candidates.some(candidate => candidate.status === "alias" || candidate.status === "invalid")) {
      discovery.suspectedInstalled = true;
      discovery.message = WINDOWS_CODEX_SELECT_PATH_MESSAGE;
      return {
        installed: false,
        source: "unknown",
        error: WINDOWS_CODEX_SELECT_PATH_MESSAGE,
        discovery
      };
    }
  }
  return {
    installed: false,
    source: "unknown",
    error: platform === "win32"
      ? "Codex CLI was not found in Bridge App PATH, Windows PATH, known Codex install directories, or WindowsApps aliases."
      : "Codex CLI was not found on PATH.",
    discovery: discovery.candidates.length > 0 ? discovery : undefined
  };
}

export async function getCodexVersion(input: { binaryPath: string; timeoutMs?: number }): Promise<string | undefined> {
  try {
    const { stdout, stderr } = await execFileAsync(input.binaryPath, ["--version"], {
      timeout: input.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 64 * 1024
    });
    const output = `${stdout}\n${stderr}`.trim();
    return output.split(/\r?\n/).map(line => line.trim()).find(Boolean);
  } catch (_error) {
    return undefined;
  }
}

export async function probeCodexAppServer(input: { binaryPath: string; timeoutMs?: number }): Promise<CodexAppServerProbeResult> {
  const client = new ProbeClient(input.binaryPath, input.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS);
  try {
    const initialized = await client.request("initialize", {
      clientInfo: { name: "hunsu-bridge", title: "Hunsu Bridge", version: "0.1.0" }
    });
    client.notify("initialized", {});
    return { available: true, initialized: sanitizeAppServerPayload(initialized) };
  } catch (error) {
    return { available: false, error: errorMessage(error) };
  } finally {
    client.close();
  }
}

export async function readCodexAccount(input: { binaryPath: string; timeoutMs?: number }): Promise<CodexAccountProbeResult> {
  const client = new ProbeClient(input.binaryPath, input.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS);
  try {
    await client.request("initialize", {
      clientInfo: { name: "hunsu-bridge", title: "Hunsu Bridge", version: "0.1.0" }
    });
    client.notify("initialized", {});
    const account = await client.request("account/read", { refreshToken: false });
    return { ok: true, account: sanitizeAppServerPayload(account) };
  } catch (error) {
    const message = errorMessage(error);
    return { ok: false, authState: authStateFromError(message), error: message };
  } finally {
    client.close();
  }
}

export async function readCodexRateLimits(input: { binaryPath: string; timeoutMs?: number }): Promise<CodexRateLimitProbeResult> {
  const client = new ProbeClient(input.binaryPath, input.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS);
  try {
    await client.request("initialize", {
      clientInfo: { name: "hunsu-bridge", title: "Hunsu Bridge", version: "0.1.0" }
    });
    client.notify("initialized", {});
    const rateLimits = await client.request("account/rateLimits/read");
    return { ok: true, rateLimits: sanitizeAppServerPayload(rateLimits) };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  } finally {
    client.close();
  }
}

export async function probeCodexRuntimeWithAppServer(input: {
  binaryPath: string;
  timeoutMs?: number;
}): Promise<{
  appServer: CodexRuntimeStatus["appServer"];
  account?: CodexAccountProbeResult;
  rateLimits?: CodexRateLimitProbeResult;
}> {
  const client = new ProbeClient(input.binaryPath, input.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS);
  try {
    const initialized = await client.initialize();
    const account = await client.readAccount();
    const rateLimits = await client.readRateLimits();
    return {
      appServer: { available: true, initialized: sanitizeAppServerPayload(initialized) },
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
  const cacheKey = JSON.stringify({
    customBinaryPath: options.customBinaryPath ?? env.HUNSU_CODEX_BINARY_PATH,
    envCommand: env.HUNSU_CODEX_APP_SERVER_COMMAND,
    path: env.PATH,
    platform: options.platform ?? process.platform,
    windowsUserPath: options.windowsUserPath,
    windowsMachinePath: options.windowsMachinePath,
    lastRunUsage: options.lastRunUsage
  });
  if (!options.force && cachedStatus && cachedStatus.key === cacheKey && Date.now() - cachedStatus.at < STATUS_CACHE_TTL_MS) {
    return cachedStatus.status;
  }
  const cli = await detectCodexBinary(options);
  if (!cli.installed || !cli.binaryPath) {
    const status: CodexRuntimeStatus = {
      runtime: "codex",
      cli: { installed: false, source: cli.source, installActionAvailable: true, error: cli.error, discovery: cli.discovery },
      appServer: { available: false },
      auth: { state: "unknown", access: "unknown" },
      usage: { rateLimitsAvailable: false, lastRunUsage: options.lastRunUsage },
      ready: false,
      recommendedAction: cli.discovery?.suspectedInstalled ? "select_codex_path" : "install_codex"
    };
    cachedStatus = { at: Date.now(), key: cacheKey, status };
    return status;
  }

  const version = await getCodexVersion({ binaryPath: cli.binaryPath, timeoutMs: options.timeoutMs });
  const probe = await probeCodexRuntimeWithAppServer({ binaryPath: cli.binaryPath, timeoutMs: options.timeoutMs });
  const appServer = probe.appServer;
  if (!appServer.available) {
    const status: CodexRuntimeStatus = {
      runtime: "codex",
      cli: { installed: true, binaryPath: cli.binaryPath, source: cli.source, version, installActionAvailable: false, error: cli.error, discovery: cli.discovery },
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
  const auth = account.ok
    ? accountStatus(account.account)
    : { state: account.authState, access: "unknown" as const, error: account.error };
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
    cli: { installed: true, binaryPath: cli.binaryPath, source: cli.source, version, installActionAvailable: false, error: cli.error, discovery: cli.discovery },
    appServer,
    auth,
    usage,
    ready,
    recommendedAction: ready ? "none" : auth.state === "not_authenticated" || auth.state === "expired" || auth.state === "invalid" ? "login_codex" : "recheck"
  };
  cachedStatus = { at: Date.now(), key: cacheKey, status };
  return status;
}

export function codexRuntimePreflightError(status: CodexRuntimeStatus): ExecutePreflightError | undefined {
  if (!status.cli.installed) {
    return preflight("CODEX_CLI_MISSING", CODEX_SETUP_REQUIRED_MESSAGE, [
      { type: "install_codex", label: "Open Codex setup" },
      { type: "open_prerequisites", label: "Open Codex setup" }
    ]);
  }
  if (!status.appServer.available) {
    return preflight("CODEX_APP_SERVER_UNAVAILABLE", CODEX_TEMPORARILY_UNAVAILABLE_MESSAGE, [
      { type: "open_prerequisites", label: "Open Codex setup" },
      { type: "codex_recheck", label: "Recheck Codex" }
    ]);
  }
  if (status.auth.state === "not_authenticated") {
    return preflight("CODEX_LOGIN_REQUIRED", "Codex login is required before Execute can start.", [
      { type: "codex_login_chatgpt", label: "Sign in with ChatGPT" },
      { type: "codex_login_device", label: "Use Device Code" },
      { type: "open_prerequisites", label: "Open Codex setup" }
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
    return preflight("CODEX_RUNTIME_UNKNOWN", CODEX_SETUP_REQUIRED_MESSAGE, [
      { type: "open_prerequisites", label: "Open Codex setup" },
      { type: "codex_recheck", label: "Recheck Codex" }
    ]);
  }
  if (status.usage.rateLimited) {
    const reset = status.usage.rateLimitSummary?.resetAt ? ` Reset: ${status.usage.rateLimitSummary.resetAt}.` : "";
    return preflight("CODEX_RATE_LIMITED", `Codex access is temporarily unavailable because it is rate limited.${reset}`, [
      { type: "codex_recheck", label: "Recheck Codex" },
      { type: "open_prerequisites", label: "Open Codex setup" }
    ]);
  }
  return undefined;
}

const CODEX_SETUP_REQUIRED_MESSAGE = "Codex setup required. Open Codex setup in Hunsu Bridge App before starting Execute.";
const CODEX_TEMPORARILY_UNAVAILABLE_MESSAGE = "Codex is temporarily unavailable. Open Codex setup in Hunsu Bridge App and recheck before starting Execute.";

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

export function sanitizeDiagnostics(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sanitizeDiagnostics);
  }
  if (typeof value !== "object" || value === null) {
    return typeof value === "string" ? redactSecretText(value) : value;
  }
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    result[key] = isSecretKey(key) ? "[redacted]" : sanitizeDiagnostics(child);
  }
  return result;
}

function preflight(error: Extract<ExecutePreflightError, { area: "codex" }>["error"], message: string, actions: ExecutePreflightAction[]): ExecutePreflightError {
  return { area: "codex", error, message, runtime: "codex", actions: [{ type: "open_bridge_app", label: "Open Bridge App", href: "hunsu://open" }, ...actions] };
}

async function detectCodexBinaryOnWindows(options: CodexRuntimeStatusOptions & {
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  discovery: CodexDiscoveryReport;
}): Promise<CodexCliStatus | undefined> {
  const env = options.env;
  const userPath = options.windowsUserPath ?? await readWindowsRegistryPath("user", env, options);
  const machinePath = options.windowsMachinePath ?? await readWindowsRegistryPath("machine", env, options);
  const candidates: Array<{ source: CodexBinarySource; command: string }> = [
    ...pathCandidates("windows_user_path", userPath, env, options.platform),
    ...pathCandidates("windows_machine_path", machinePath, env, options.platform),
    ...await commandDiscoveryCandidates("where", "where.exe", ["codex"], env, options),
    ...await commandDiscoveryCandidates("powershell", "powershell.exe", [
      "-NoProfile",
      "-Command",
      "(Get-Command codex -All | Select-Object -ExpandProperty Source) -join [Environment]::NewLine"
    ], env, options),
    ...knownWindowsCodexInstallCandidates(env),
    ...windowsAppsAliasCandidates(env)
  ];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const key = `${candidate.source}:${candidate.command.toLowerCase()}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const status = await validateWindowsDiscoveryCandidate(candidate.command, candidate.source, env, options);
    options.discovery.candidates.push(status);
    if (status.status === "usable" && status.binaryPath) {
      options.discovery.suspectedInstalled = true;
      return {
        installed: true,
        binaryPath: status.binaryPath,
        source: candidate.source,
        version: status.version,
        discovery: options.discovery
      };
    }
    if (status.status === "alias" || status.status === "invalid") {
      options.discovery.suspectedInstalled = true;
    }
  }
  if (options.discovery.suspectedInstalled) {
    options.discovery.message = WINDOWS_CODEX_SELECT_PATH_MESSAGE;
  }
  return undefined;
}

function pathCandidates(
  source: CodexBinarySource,
  pathValue: string | undefined,
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform
): Array<{ source: CodexBinarySource; command: string }> {
  if (!pathValue?.trim()) {
    return [];
  }
  const pathEnv = { ...env, PATH: pathValue };
  const candidate = findExecutableOnPath("codex", pathEnv, platform);
  return candidate ? [{ source, command: candidate }] : [];
}

async function commandDiscoveryCandidates(
  source: CodexBinarySource,
  command: string,
  args: string[],
  env: Record<string, string | undefined>,
  options: CodexRuntimeStatusOptions
): Promise<Array<{ source: CodexBinarySource; command: string }>> {
  const result = await runDiscoveryCommand(command, args, env, options);
  if (result.status !== 0) {
    return [];
  }
  return result.stdout
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(candidate => ({ source, command: candidate }));
}

async function readWindowsRegistryPath(
  scope: "user" | "machine",
  env: Record<string, string | undefined>,
  options: CodexRuntimeStatusOptions
): Promise<string | undefined> {
  const key = scope === "user"
    ? "HKCU\\Environment"
    : "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment";
  const result = await runDiscoveryCommand("reg.exe", ["query", key, "/v", "Path"], env, options);
  if (result.status !== 0) {
    return undefined;
  }
  const pathLine = result.stdout
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(line => /^Path\s+REG_/i.test(line));
  if (!pathLine) {
    return undefined;
  }
  const match = pathLine.match(/^Path\s+REG_\S+\s+(.+)$/i);
  return match?.[1] ? expandWindowsEnvVars(match[1], env) : undefined;
}

async function runDiscoveryCommand(
  command: string,
  args: string[],
  env: Record<string, string | undefined>,
  options: CodexRuntimeStatusOptions
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  if (options.commandRunner) {
    return options.commandRunner(command, args, {
      env,
      timeoutMs: options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS
    });
  }
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      env,
      encoding: "utf8",
      timeout: options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 256 * 1024
    });
    return { status: 0, stdout, stderr };
  } catch (error) {
    const processError = error as NodeJS.ErrnoException & { stdout?: string | Buffer; stderr?: string | Buffer; code?: number | string | null };
    return {
      status: typeof processError.code === "number" ? processError.code : null,
      stdout: processError.stdout ? String(processError.stdout) : "",
      stderr: processError.stderr ? String(processError.stderr) : errorMessage(error)
    };
  }
}

async function validateWindowsDiscoveryCandidate(
  candidate: string,
  source: CodexBinarySource,
  env: Record<string, string | undefined>,
  options: CodexRuntimeStatusOptions
): Promise<CodexDiscoveryCandidate> {
  const resolution = resolveCodexCommand(candidate, source, env, options.platform ?? "win32");
  if (resolution.kind !== "binary") {
    return {
      source,
      command: candidate,
      binaryPath: resolution.kind === "missing" ? resolution.binaryPath : undefined,
      status: "missing",
      reason: resolution.error
    };
  }
  const version = await getCodexVersion({ binaryPath: resolution.binaryPath, timeoutMs: options.timeoutMs });
  const isAlias = source === "windows_apps_alias" || isWindowsAppsAliasPath(resolution.binaryPath, env);
  if (!version) {
    return {
      source,
      command: candidate,
      binaryPath: resolution.binaryPath,
      status: isAlias ? "alias" : "invalid",
      reason: "codex --version failed."
    };
  }
  const appServer = await probeCodexAppServer({ binaryPath: resolution.binaryPath, timeoutMs: options.timeoutMs });
  if (!appServer.available) {
    return {
      source,
      command: candidate,
      binaryPath: resolution.binaryPath,
      status: isAlias ? "alias" : "invalid",
      version,
      reason: appServer.error
    };
  }
  return {
    source,
    command: candidate,
    binaryPath: resolution.binaryPath,
    status: "usable",
    version
  };
}

function knownWindowsCodexInstallCandidates(env: Record<string, string | undefined>): Array<{ source: CodexBinarySource; command: string }> {
  const localAppData = env.LOCALAPPDATA?.trim();
  if (!localAppData) {
    return [];
  }
  const binRoot = join(localAppData, "OpenAI", "Codex", "bin");
  const candidates: string[] = [];
  const direct = join(binRoot, "codex.exe");
  if (existsSync(direct)) {
    candidates.push(direct);
  }
  try {
    for (const entry of readdirSync(binRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const candidate = join(binRoot, entry.name, "codex.exe");
      if (existsSync(candidate)) {
        candidates.push(candidate);
      }
    }
  } catch (_error) {
    // The known install root is optional.
  }
  return candidates.sort().map(command => ({ source: "known_install_dir", command }));
}

function windowsAppsAliasCandidates(env: Record<string, string | undefined>): Array<{ source: CodexBinarySource; command: string }> {
  const localAppData = env.LOCALAPPDATA?.trim();
  if (!localAppData) {
    return [];
  }
  const alias = join(localAppData, "Microsoft", "WindowsApps", "codex.exe");
  return existsSync(alias) ? [{ source: "windows_apps_alias", command: alias }] : [];
}

function isWindowsAppsAliasPath(candidate: string, env: Record<string, string | undefined>): boolean {
  const normalizedCandidate = normalizeWindowsPath(candidate);
  const localAppData = env.LOCALAPPDATA?.trim();
  if (localAppData) {
    const expected = normalizeWindowsPath(join(localAppData, "Microsoft", "WindowsApps", "codex.exe"));
    if (normalizedCandidate === expected) {
      return true;
    }
  }
  return /(?:^|\/)microsoft\/windowsapps\/codex\.exe$/i.test(normalizedCandidate);
}

function normalizeWindowsPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function expandWindowsEnvVars(value: string, env: Record<string, string | undefined>): string {
  return value.replace(/%([^%]+)%/g, (match, key: string) => env[key] ?? env[key.toUpperCase()] ?? env[key.toLowerCase()] ?? match);
}

function binaryStatusFromCandidate(
  candidate: string,
  source: CodexCliStatus["source"],
  env: Record<string, string | undefined>,
  platform = process.platform,
  discovery?: CodexDiscoveryReport
): CodexCliStatus {
  const resolution = resolveCodexCommand(candidate, source, env, platform);
  if (resolution.kind !== "binary") {
    discovery?.candidates.push({
      source: resolution.source,
      command: candidate,
      binaryPath: resolution.kind === "missing" ? resolution.binaryPath : undefined,
      status: "missing",
      reason: resolution.error
    });
    return {
      installed: false,
      source: resolution.source,
      binaryPath: resolution.kind === "missing" ? resolution.binaryPath : undefined,
      error: resolution.error,
      discovery: discovery && discovery.candidates.length > 0 ? discovery : undefined
    };
  }
  discovery?.candidates.push({
    source: resolution.source,
    command: candidate,
    binaryPath: resolution.binaryPath,
    status: "usable"
  });
  return {
    installed: true,
    binaryPath: resolution.binaryPath,
    source: resolution.source,
    discovery: discovery && discovery.candidates.length > 0 ? discovery : undefined
  };
}

function resolveCodexCommand(
  candidate: string,
  source: CodexCliStatus["source"],
  env: Record<string, string | undefined>,
  platform = process.platform
): CodexCommandResolution {
  const trimmed = candidate.trim();
  if (!trimmed) {
    return { kind: "missing", installed: false, source: source ?? "unknown", error: "Codex command is empty." };
  }
  if (source === "env" && /\s/.test(trimmed)) {
    return {
      kind: "unsupported_command_string",
      installed: false,
      source: "env",
      error: "HUNSU_CODEX_APP_SERVER_COMMAND must be a binary path or command name without arguments. Put arguments in HUNSU_CODEX_APP_SERVER_ARGS."
    };
  }
  const binaryPath = isAbsoluteForPlatform(trimmed, platform) ? trimmed : findExecutableOnPath(trimmed, env, platform);
  if (!binaryPath) {
    return {
      kind: "missing",
      installed: false,
      source: source ?? "unknown",
      binaryPath: isAbsoluteForPlatform(trimmed, platform) ? trimmed : undefined,
      error: isAbsoluteForPlatform(trimmed, platform) ? "Configured Codex path does not exist." : `Codex command was not found on PATH: ${trimmed}`
    };
  }
  try {
    const stat = statSync(binaryPath);
    if (!stat.isFile()) {
      return { kind: "missing", installed: false, binaryPath, source: source ?? "unknown", error: "Configured Codex path is not a file." };
    }
    if (platform !== "win32") {
      accessSync(binaryPath, constants.X_OK);
    }
    return { kind: "binary", installed: true, binaryPath, source: source === "unknown" || source === undefined ? "path" : source };
  } catch (error) {
    return { kind: "missing", installed: false, binaryPath, source: source ?? "unknown", error: errorMessage(error) };
  }
}

function findExecutableOnPath(command: string, env: Record<string, string | undefined>, platform = process.platform): string | undefined {
  if (isAbsoluteForPlatform(command, platform)) {
    return existsSync(command) ? command : undefined;
  }
  const path = env.PATH ?? "";
  const pathDelimiter = platform === "win32" ? ";" : delimiter;
  const extensions = platform === "win32"
    ? uniqueExtensions(["", ...(env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")])
    : [""];
  for (const directory of path.split(pathDelimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = join(directory, platform === "win32" && extension && !command.toUpperCase().endsWith(extension.toUpperCase()) ? `${command}${extension}` : command);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

function uniqueExtensions(extensions: string[]): string[] {
  const result: string[] = [];
  for (const extension of extensions.flatMap(value => [value, value.toLowerCase()])) {
    if (!result.includes(extension)) {
      result.push(extension);
    }
  }
  return result;
}

function isAbsoluteForPlatform(value: string, platform: NodeJS.Platform): boolean {
  return platform === "win32"
    ? isAbsolute(value) || /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith("\\\\")
    : isAbsolute(value);
}

class ProbeClient {
  private child: ChildProcessWithoutNullStreams;
  private readonly binaryPath: string;
  private readonly timeoutMs: number;
  private nextId = 1;
  private buffer = "";
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();

  constructor(binaryPath: string, timeoutMs: number) {
    this.binaryPath = binaryPath;
    this.timeoutMs = timeoutMs;
    this.child = spawn(this.binaryPath, ["app-server", "--stdio"], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", chunk => this.read(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.on("error", error => this.rejectAll(error));
    this.child.on("exit", () => this.rejectAll(new Error("Codex app-server process exited before probe completed.")));
  }

  request(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server probe timed out: ${method}`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async initialize(): Promise<unknown> {
    const initialized = await this.request("initialize", {
      clientInfo: { name: "hunsu-bridge", title: "Hunsu Bridge", version: "0.1.0" }
    });
    this.notify("initialized", {});
    return initialized;
  }

  async readAccount(): Promise<CodexAccountProbeResult> {
    try {
      const account = await this.request("account/read", { refreshToken: false });
      return { ok: true, account: sanitizeAppServerPayload(account) };
    } catch (error) {
      const message = errorMessage(error);
      return { ok: false, authState: authStateFromError(message), error: message };
    }
  }

  async readRateLimits(): Promise<CodexRateLimitProbeResult> {
    try {
      const rateLimits = await this.request("account/rateLimits/read");
      return { ok: true, rateLimits: sanitizeAppServerPayload(rateLimits) };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  }

  notify(method: string, params?: unknown): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  close(): void {
    this.rejectAll(new Error("Codex app-server probe closed."));
    this.child.kill();
  }

  private write(message: JsonRpcMessage & { jsonrpc: "2.0" }): void {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private read(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      newline = this.buffer.indexOf("\n");
      if (!line) continue;
      let message: JsonRpcMessage;
      try {
        message = JSON.parse(line) as JsonRpcMessage;
      } catch (error) {
        this.rejectAll(new Error(`Invalid Codex app-server JSON-RPC line: ${errorMessage(error)}`));
        continue;
      }
      if (message.id === undefined || typeof message.id !== "number") {
        continue;
      }
      const pending = this.pending.get(message.id);
      if (!pending) {
        continue;
      }
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message ?? "Codex app-server request failed."));
      } else {
        pending.resolve(message.result);
      }
    }
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}

function accountStatus(account: unknown): CodexRuntimeStatus["auth"] {
  const object = isRecord(account) ? account : {};
  if (object.requiresOpenaiAuth === true) {
    return { state: "not_authenticated", access: "unknown" };
  }
  const method = authMethod(object);
  return {
    state: "authenticated",
    method,
    access: method === "api_key" || method === "access_token" ? "usage_based" : method === "chatgpt" ? "subscription" : "unknown",
    accountSummary: {
      displayName: stringField(object, ["displayName", "name", "userName"]),
      email: stringField(object, ["email", "userEmail"]),
      workspaceName: stringField(object, ["workspaceName", "organizationName", "orgName"]),
      planLabel: stringField(object, ["planLabel", "plan", "subscriptionPlan"])
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

function sanitizeAppServerPayload(value: unknown): unknown {
  return sanitizeDiagnostics(value);
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

function isSecretKey(key: string): boolean {
  return /token|secret|api.?key|authorization|credential|auth\.json/i.test(key);
}

function redactSecretText(value: string): string {
  return value
    .replace(/sk-[A-Za-z0-9_-]{10,}/g, "[redacted]")
    .replace(/(OPENAI_API_KEY|CODEX_ACCESS_TOKEN)=\S+/g, "$1=[redacted]")
    .replace(/~\/\.codex\/auth\.json/g, "[redacted]")
    .replace(/("(?:apiKey|refreshToken|accessToken|authorization)"\s*:\s*")[^"]+(")/gi, "$1[redacted]$2")
    .replace(/\b(apiKey|refreshToken|accessToken|authorization)=(?:Bearer\s+)?\S+/gi, "$1=[redacted]")
    .replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, "$1[redacted]");
}

function errorMessage(error: unknown): string {
  return redactSecretText(error instanceof Error ? error.message : String(error));
}
