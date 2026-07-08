import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_PROBE_TIMEOUT_MS = 3_500;
const STATUS_CACHE_TTL_MS = 5_000;

export type CodexCliStatus = {
  installed: boolean;
  binaryPath?: string;
  source?: "custom" | "env" | "path" | "unknown";
  version?: string;
  error?: string;
};

export type CodexRuntimeStatus = {
  runtime: "codex";
  cli: {
    installed: boolean;
    binaryPath?: string;
    source?: "custom" | "env" | "path" | "unknown";
    version?: string;
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
  recommendedAction: "install_codex" | "login_codex" | "recheck" | "none";
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
  const env = options.env ?? process.env;
  const customPath = options.customBinaryPath?.trim() || env.HUNSU_CODEX_BINARY_PATH?.trim();
  if (customPath) {
    return binaryStatusFromCandidate(customPath, "custom", env);
  }
  const envCommand = env.HUNSU_CODEX_APP_SERVER_COMMAND?.trim();
  if (envCommand) {
    return binaryStatusFromCandidate(envCommand, "env", env);
  }
  const pathCandidate = findExecutableOnPath("codex", env);
  if (pathCandidate) {
    return binaryStatusFromCandidate(pathCandidate, "path", env);
  }
  return { installed: false, source: "unknown", error: "Codex CLI was not found on PATH." };
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

export async function getCodexRuntimeStatus(options: CodexRuntimeStatusOptions = {}): Promise<CodexRuntimeStatus> {
  const env = options.env ?? process.env;
  const cacheKey = JSON.stringify({
    customBinaryPath: options.customBinaryPath ?? env.HUNSU_CODEX_BINARY_PATH,
    envCommand: env.HUNSU_CODEX_APP_SERVER_COMMAND,
    path: env.PATH,
    lastRunUsage: options.lastRunUsage
  });
  if (!options.force && cachedStatus && cachedStatus.key === cacheKey && Date.now() - cachedStatus.at < STATUS_CACHE_TTL_MS) {
    return cachedStatus.status;
  }
  const cli = await detectCodexBinary(options);
  if (!cli.installed || !cli.binaryPath) {
    const status: CodexRuntimeStatus = {
      runtime: "codex",
      cli: { installed: false, source: cli.source, installActionAvailable: true, error: cli.error },
      appServer: { available: false },
      auth: { state: "unknown", access: "unknown" },
      usage: { rateLimitsAvailable: false, lastRunUsage: options.lastRunUsage },
      ready: false,
      recommendedAction: "install_codex"
    };
    cachedStatus = { at: Date.now(), key: cacheKey, status };
    return status;
  }

  const version = await getCodexVersion({ binaryPath: cli.binaryPath, timeoutMs: options.timeoutMs });
  const appServer = await probeCodexAppServer({ binaryPath: cli.binaryPath, timeoutMs: options.timeoutMs });
  if (!appServer.available) {
    const status: CodexRuntimeStatus = {
      runtime: "codex",
      cli: { installed: true, binaryPath: cli.binaryPath, source: cli.source, version, installActionAvailable: false, error: cli.error },
      appServer,
      auth: { state: "unknown", access: "unknown" },
      usage: { rateLimitsAvailable: false, lastRunUsage: options.lastRunUsage },
      ready: false,
      recommendedAction: "recheck"
    };
    cachedStatus = { at: Date.now(), key: cacheKey, status };
    return status;
  }

  const account = await readCodexAccount({ binaryPath: cli.binaryPath, timeoutMs: options.timeoutMs });
  const rateLimits = await readCodexRateLimits({ binaryPath: cli.binaryPath, timeoutMs: options.timeoutMs });
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
    cli: { installed: true, binaryPath: cli.binaryPath, source: cli.source, version, installActionAvailable: false, error: cli.error },
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
  error: "CODEX_CLI_MISSING" | "CODEX_LOGIN_REQUIRED" | "CODEX_AUTH_EXPIRED" | "CODEX_APP_SERVER_UNAVAILABLE" | "CODEX_RATE_LIMITED" | "CODEX_RUNTIME_UNKNOWN";
  message: string;
  runtime: "codex";
  actions: Array<{
    type: "install_codex" | "codex_login_chatgpt" | "codex_login_device" | "codex_recheck" | "open_bridge_app" | "open_prerequisites";
    label: string;
  }>;
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

function preflight(error: ExecutePreflightError["error"], message: string, actions: ExecutePreflightError["actions"]): ExecutePreflightError {
  return { error, message, runtime: "codex", actions: [{ type: "open_bridge_app", label: "Open Bridge App" }, ...actions] };
}

function binaryStatusFromCandidate(candidate: string, source: CodexCliStatus["source"], env: Record<string, string | undefined>): CodexCliStatus {
  const binaryPath = isAbsolute(candidate) ? candidate : findExecutableOnPath(candidate, env) ?? candidate;
  try {
    if (isAbsolute(binaryPath)) {
      const stat = statSync(binaryPath);
      if (!stat.isFile()) {
        return { installed: false, binaryPath, source, error: "Configured Codex path is not a file." };
      }
    }
    return { installed: true, binaryPath, source };
  } catch (error) {
    return { installed: false, binaryPath, source, error: errorMessage(error) };
  }
}

function findExecutableOnPath(command: string, env: Record<string, string | undefined>): string | undefined {
  if (isAbsolute(command)) {
    return existsSync(command) ? command : undefined;
  }
  const path = env.PATH ?? "";
  const extensions = process.platform === "win32"
    ? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")
    : [""];
  for (const directory of path.split(delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = join(directory, process.platform === "win32" && !command.toUpperCase().endsWith(extension.toUpperCase()) ? `${command}${extension}` : command);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
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
    this.write({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server probe timed out: ${method}`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
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
      const message = JSON.parse(line) as JsonRpcMessage;
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
    .replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, "$1[redacted]")
    .replace(/(OPENAI_API_KEY|CODEX_ACCESS_TOKEN)=\S+/g, "$1=[redacted]");
}

function errorMessage(error: unknown): string {
  return redactSecretText(error instanceof Error ? error.message : String(error));
}
