import { spawn } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import { currentProcessEnv } from "@hunsu/config";
import { detectCodexBinary, getCodexRuntimeStatus, type CodexRuntimeStatus } from "../runtimes/codex.ts";
import type {
  RuntimeProviderAdapter,
  RuntimeProviderAuthKind,
  RuntimeProviderCapabilities,
  RuntimeProviderConfigurationInput,
  RuntimeProviderInstallPlan,
  RuntimeProviderInstallResult,
  RuntimeProviderLoginResult,
  RuntimeProviderRecommendedAction,
  RuntimeProviderStatus
} from "./types.ts";

export const codexProviderCapabilities: RuntimeProviderCapabilities = {
  canExecute: true,
  canEditFiles: true,
  canRunShell: true,
  supportsWorktree: true,
  supportsEventStream: true,
  supportsUsage: true,
  supportsSubscriptionAuth: true,
  supportsDeviceAuth: true,
  supportsApiKeyAuth: true,
  supportsRemoteRelay: true,
  supportsAcp: false
};

export type CodexLoginProcessState = {
  kind: "chatgpt" | "device";
  pid?: number;
  startedAt: string;
  status: "starting" | "device_code" | "pending" | "completed" | "failed";
  verificationUri?: string;
  verificationUriComplete?: string;
  userCode?: string;
  lastOutput?: string;
  error?: string;
};

export type CodexLoginStateHost = {
  codexLogin?: CodexLoginProcessState;
};

type TrackedCodexLoginProcess = {
  child: ReturnType<typeof spawn>;
  startedAt: string;
  output: string;
  cleared: boolean;
};

const codexLoginTrackers = new WeakMap<CodexLoginStateHost, TrackedCodexLoginProcess>();

export type CodexRuntimeProviderOptions = {
  env?: () => Record<string, string | undefined>;
  loginState?: CodexLoginStateHost;
  onConfigure?: (configuration: { binaryPath?: string }) => void;
  installer?: (input: {
    env: Record<string, string | undefined>;
    dryRun?: boolean;
  }) => Promise<{ ok: boolean; command: string; args: string[]; exitCode?: number; output?: string; error?: string }>;
};

export class CodexRuntimeProvider implements RuntimeProviderAdapter {
  providerId = "codex";
  kind = "codex" as const;
  label = "Codex";
  private binaryPathOverride: string | undefined;
  private readonly internalLoginState: CodexLoginStateHost = {};
  private readonly options: CodexRuntimeProviderOptions;

  constructor(options: CodexRuntimeProviderOptions = {}) {
    this.options = options;
  }

  async status(input: { force?: boolean; env?: Record<string, string | undefined> } = {}): Promise<RuntimeProviderStatus> {
    const codex = await getCodexRuntimeStatus({
      force: input.force,
      env: this.statusEnv(input.env)
    });
    return normalizeCodexRuntimeStatus(codex);
  }

  async recheck(): Promise<RuntimeProviderStatus> {
    return this.status({ force: true });
  }

  async installPlan(): Promise<RuntimeProviderInstallPlan> {
    return codexInstallPlan();
  }

  async install(input: { confirmed?: boolean; dryRun?: boolean; env?: Record<string, string | undefined> } = {}): Promise<RuntimeProviderInstallResult> {
    const env = this.statusEnv(input.env);
    const before = await this.status({ force: true, env });
    const plan = await this.installPlan();
    if (before.installed) {
      return {
        providerId: this.providerId,
        confirmed: input.confirmed === true,
        started: false,
        status: "already_installed",
        message: "Codex is already installed.",
        plan,
        providerStatus: before
      };
    }
    if (input.confirmed !== true) {
      return {
        providerId: this.providerId,
        confirmed: false,
        started: false,
        status: "confirmation_required",
        message: "Confirm Codex installation before Hunsu Bridge runs the installer.",
        plan,
        providerStatus: before
      };
    }
    const installer = this.options.installer ?? runDefaultCodexInstaller;
    const result = await installer({ env, dryRun: input.dryRun === true || env.HUNSU_CODEX_INSTALL_DRY_RUN === "1" });
    const providerStatus = await this.status({ force: true, env });
    return {
      providerId: this.providerId,
      confirmed: true,
      started: true,
      status: result.ok
        ? result.exitCode === undefined
          ? "dry_run"
          : "completed"
        : "failed",
      message: result.ok
        ? result.exitCode === undefined
          ? "Codex install dry run completed. No installer was run."
          : "Codex installer completed. Provider status was rechecked."
        : result.error ?? "Codex installer failed.",
      plan,
      command: result.command,
      args: result.args,
      exitCode: result.exitCode,
      output: result.output,
      error: result.error,
      providerStatus
    };
  }

  async login(input: { method: "default" | "chatgpt" | "device" | "api_key" }): Promise<RuntimeProviderLoginResult> {
    const method = input.method === "default" ? "chatgpt" : input.method;
    const env = this.statusEnv();
    const state = this.options.loginState ?? this.internalLoginState;
    if (method === "device") {
      return {
        providerId: this.providerId,
        method,
        ...(await spawnCodexDeviceLogin(state, env))
      };
    }
    if (method === "api_key") {
      const result = await spawnCodexAction(["login", "--api-key"], env);
      return {
        providerId: this.providerId,
        method,
        ...result,
        message: result.started
          ? "Codex API-key login started."
          : result.message ?? "Codex API-key login could not start."
      };
    }
    return {
      providerId: this.providerId,
      method,
      ...(await spawnCodexChatGptLogin(state, env))
    };
  }

  async configure(input: RuntimeProviderConfigurationInput): Promise<RuntimeProviderStatus> {
    if (input.authMethod === "api_key") {
      return this.configureApiKey(input);
    }
    if (input.clearBinaryPath) {
      this.binaryPathOverride = undefined;
      this.options.onConfigure?.({ binaryPath: undefined });
      return this.status({ force: true, env: input.env });
    }
    const requestedPath = input.binaryPath?.trim() || input.selectBinaryPath?.trim();
    if (!requestedPath) {
      return this.status({ force: true, env: input.env });
    }
    const binaryPath = isAbsolute(requestedPath) ? requestedPath : resolve(requestedPath);
    const env = this.baseEnv({ ...input.env, HUNSU_CODEX_BINARY_PATH: binaryPath });
    const codex = await getCodexRuntimeStatus({
      force: true,
      env,
      customBinaryPath: binaryPath
    });
    if (codex.cli.installed) {
      this.binaryPathOverride = binaryPath;
      this.options.onConfigure?.({ binaryPath });
    }
    return normalizeCodexRuntimeStatus(codex);
  }

  private async configureApiKey(input: RuntimeProviderConfigurationInput): Promise<RuntimeProviderStatus> {
    const apiKey = input.apiKey?.trim();
    const env = apiKey
      ? this.statusEnv({ ...input.env, OPENAI_API_KEY: apiKey })
      : this.statusEnv(input.env);
    return this.status({ force: true, env });
  }

  private statusEnv(inputEnv: Record<string, string | undefined> = {}): Record<string, string | undefined> {
    return {
      ...this.baseEnv(inputEnv),
      ...(this.binaryPathOverride ? { HUNSU_CODEX_BINARY_PATH: this.binaryPathOverride } : {})
    };
  }

  private baseEnv(inputEnv: Record<string, string | undefined> = {}): Record<string, string | undefined> {
    return {
      ...currentProcessEnv(),
      ...(this.options.env?.() ?? {}),
      ...inputEnv
    };
  }
}

export function normalizeCodexRuntimeStatus(codex: CodexRuntimeStatus): RuntimeProviderStatus {
  const installed = codex.cli.installed;
  const configured = installed && codex.appServer.available;
  const authenticated = codex.auth.state === "authenticated"
    ? true
    : codex.auth.state === "unknown" || codex.auth.state === "error"
      ? "unknown"
      : false;
  return {
    providerId: "codex",
    kind: "codex",
    label: "Codex",
    description: "OpenAI Codex CLI through the local app-server boundary.",
    connectionKind: "local_cli",
    installed,
    configured,
    authenticated,
    ready: codex.ready,
    auth: {
      kind: codexAuthKind(codex),
      state: codex.auth.state,
      access: codex.auth.access,
      accountSummary: codex.auth.accountSummary,
      error: codex.auth.error
    },
    install: {
      installed,
      binaryPath: codex.cli.binaryPath,
      source: codex.cli.source,
      version: codex.cli.version,
      error: codex.cli.error
    },
    usage: {
      available: codex.usage.rateLimitsAvailable,
      rateLimited: codex.usage.rateLimited,
      summary: codex.usage.rateLimitSummary,
      lastRunUsage: codex.usage.lastRunUsage,
      error: codex.usage.error
    },
    capabilities: codexProviderCapabilities,
    recommendedAction: codexRecommendedAction(codex),
    safeMessage: codexSafeMessage(codex)
  };
}

export function codexInstallPlan(): RuntimeProviderInstallPlan {
  return {
    providerId: "codex",
    available: true,
    label: "Install Codex",
    command: process.platform === "win32" ? "npm.cmd" : "npm",
    args: ["install", "-g", "@openai/codex@latest"],
    confirmationRequired: true,
    instructions: [
      "Hunsu Bridge can run the Codex npm installer after you confirm.",
      "If Codex is already installed in a custom location, select that binary in Advanced settings."
    ]
  };
}

async function runDefaultCodexInstaller(input: {
  env: Record<string, string | undefined>;
  dryRun?: boolean;
}): Promise<{ ok: boolean; command: string; args: string[]; exitCode?: number; output?: string; error?: string }> {
  const command = process.platform === "win32" ? "npm.cmd" : "npm";
  const args = ["install", "-g", "@openai/codex@latest"];
  if (input.dryRun) {
    return { ok: true, command, args };
  }
  return new Promise(resolve => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...currentProcessEnv(), ...input.env },
      windowsHide: true
    });
    let output = "";
    const append = (chunk: Buffer | string) => {
      output = `${output}${chunk.toString()}`.slice(-16 * 1024);
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.once("error", error => {
      resolve({ ok: false, command, args, output: output.trim(), error: error.message });
    });
    child.once("close", code => {
      resolve({
        ok: code === 0,
        command,
        args,
        exitCode: code ?? undefined,
        output: output.trim(),
        error: code === 0 ? undefined : `Codex installer exited with status ${code ?? "unknown"}.`
      });
    });
  });
}

function codexAuthKind(codex: CodexRuntimeStatus): RuntimeProviderAuthKind {
  if (codex.auth.method === "chatgpt") return "chatgpt_oauth";
  if (codex.auth.method === "api_key" || codex.auth.method === "access_token") return "api_key";
  if (codex.auth.state === "not_authenticated") return "chatgpt_oauth";
  return "unknown";
}

function codexRecommendedAction(codex: CodexRuntimeStatus): RuntimeProviderRecommendedAction {
  if (codex.recommendedAction === "install_codex") return "install";
  if (codex.recommendedAction === "select_binary") return "select_binary";
  if (codex.recommendedAction === "login_codex") return "login";
  if (codex.recommendedAction === "recheck") return "recheck";
  return "none";
}

function codexSafeMessage(codex: CodexRuntimeStatus): string {
  if (codex.recommendedAction === "select_binary") return "Select the real Codex binary path. WindowsApps aliases cannot be used for Execute.";
  if (!codex.cli.installed) return "Codex was not found by Hunsu Bridge.";
  if (!codex.appServer.available) return "Codex is installed, but the app-server is not available.";
  if (codex.auth.state === "not_authenticated") return "Sign in to Codex to enable Execute.";
  if (codex.auth.state === "expired" || codex.auth.state === "invalid") return "Codex sign-in needs to be refreshed.";
  if (codex.usage.rateLimited) return "Codex is temporarily rate limited.";
  if (codex.ready) return "Codex is ready.";
  return "Codex needs attention.";
}

export async function spawnCodexAction(args: string[], env: Record<string, string | undefined>): Promise<{
  started: boolean;
  command?: string;
  args: string[];
  message?: string;
}> {
  const cli = await detectCodexBinary({ env });
  if (!cli.installed || !cli.binaryPath) {
    return { started: false, args, message: cli.error ?? "Codex CLI was not found." };
  }
  const child = spawn(cli.binaryPath, args, {
    detached: true,
    stdio: "ignore",
    env: { ...currentProcessEnv(), ...env },
    windowsHide: true
  });
  child.unref();
  return { started: true, command: cli.binaryPath, args };
}

export async function spawnCodexChatGptLogin(
  state: CodexLoginStateHost,
  env: Record<string, string | undefined>
): Promise<Omit<RuntimeProviderLoginResult, "providerId" | "method">> {
  const args = ["login"];
  const cli = await detectCodexBinary({ env });
  const startedAt = new Date().toISOString();
  if (!cli.installed || !cli.binaryPath) {
    const failed = updateCodexLoginState(state, {
      kind: "chatgpt",
      startedAt,
      status: "failed",
      error: cli.error ?? "Codex CLI was not found.",
      lastOutput: "Browser login failed to start."
    });
    return codexChatGptLoginResult(undefined, args, failed, false);
  }
  try {
    const child = spawn(cli.binaryPath, args, {
      detached: true,
      stdio: "ignore",
      env: { ...currentProcessEnv(), ...env },
      windowsHide: true
    });
    child.unref();
    const pending = updateCodexLoginState(state, {
      kind: "chatgpt",
      pid: child.pid,
      startedAt,
      status: "pending",
      lastOutput: "Browser login started. Complete sign-in, then click Recheck."
    });
    return codexChatGptLoginResult(cli.binaryPath, args, pending);
  } catch (error) {
    const failed = updateCodexLoginState(state, {
      kind: "chatgpt",
      startedAt,
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
      lastOutput: "Browser login failed to start."
    });
    return codexChatGptLoginResult(cli.binaryPath, args, failed, false);
  }
}

export async function spawnCodexDeviceLogin(
  state: CodexLoginStateHost,
  env: Record<string, string | undefined>,
  timeoutMs = 3_000
): Promise<Omit<RuntimeProviderLoginResult, "providerId" | "method">> {
  const args = ["login", "--device-auth"];
  const existing = codexLoginTrackers.get(state);
  if (existing && !existing.cleared) {
    return codexDeviceLoginResult(existing.child.spawnfile, args, state.codexLogin);
  }
  const cli = await detectCodexBinary({ env });
  if (!cli.installed || !cli.binaryPath) {
    const failed = updateCodexLoginState(state, {
      kind: "device",
      startedAt: new Date().toISOString(),
      status: "failed",
      error: cli.error ?? "Codex CLI was not found."
    });
    return codexDeviceLoginResult(undefined, args, failed, false);
  }

  const child = spawn(cli.binaryPath, args, {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...currentProcessEnv(), ...env },
    windowsHide: true
  });
  const tracker: TrackedCodexLoginProcess = {
    child,
    startedAt: new Date().toISOString(),
    output: "",
    cleared: false
  };
  codexLoginTrackers.set(state, tracker);
  updateCodexLoginState(state, {
    kind: "device",
    pid: child.pid,
    startedAt: tracker.startedAt,
    status: "starting"
  });
  const append = (chunk: Buffer | string) => {
    if (tracker.cleared) return;
    tracker.output = `${tracker.output}${chunk.toString()}`.slice(-64 * 1024);
    const details = parseCodexDeviceAuthOutput(tracker.output);
    updateCodexLoginState(state, {
      kind: "device",
      pid: child.pid,
      startedAt: tracker.startedAt,
      status: details.verificationUri || details.userCode ? "device_code" : "pending",
      ...details,
      lastOutput: tracker.output.trim().slice(-4096)
    });
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  child.once("error", error => {
    if (tracker.cleared) return;
    updateCodexLoginState(state, {
      kind: "device",
      pid: child.pid,
      startedAt: tracker.startedAt,
      status: "failed",
      error: error.message,
      lastOutput: tracker.output.trim().slice(-4096)
    });
    codexLoginTrackers.delete(state);
  });
  child.once("close", (code, signal) => {
    if (tracker.cleared) return;
    const details = parseCodexDeviceAuthOutput(tracker.output);
    const failed = code !== 0;
    updateCodexLoginState(state, {
      kind: "device",
      pid: child.pid,
      startedAt: tracker.startedAt,
      status: failed ? "failed" : details.verificationUri || details.userCode ? "device_code" : "completed",
      ...details,
      lastOutput: tracker.output.trim().slice(-4096),
      error: failed ? `Codex device login exited with status ${code ?? signal ?? "unknown"}.` : undefined
    });
    codexLoginTrackers.delete(state);
  });

  await waitForCodexLoginInitialState(state, timeoutMs);
  return codexDeviceLoginResult(cli.binaryPath, args, state.codexLogin);
}

function codexChatGptLoginResult(
  command: string | undefined,
  args: string[],
  state: CodexLoginProcessState,
  started = true
): Omit<RuntimeProviderLoginResult, "providerId" | "method"> {
  return {
    started,
    command,
    args,
    state: state.status,
    status: state.status,
    lastOutput: state.lastOutput,
    error: state.error,
    message: state.status === "failed"
      ? state.error ?? "Codex login failed to start."
      : "Codex login started. Complete sign-in in your browser, then click Recheck."
  };
}

function codexDeviceLoginResult(
  command: string | undefined,
  args: string[],
  state: CodexLoginProcessState | undefined,
  started = true
): Omit<RuntimeProviderLoginResult, "providerId" | "method"> {
  const status = state?.status ?? "pending";
  return {
    started,
    command,
    args,
    state: status,
    status,
    verificationUri: state?.verificationUri,
    verificationUriComplete: state?.verificationUriComplete,
    userCode: state?.userCode,
    lastOutput: state?.lastOutput,
    error: state?.error,
    message: status === "failed"
      ? state?.error ?? "Codex device login failed."
      : state?.verificationUri || state?.userCode
        ? "Codex device login started. Complete authorization in your browser."
        : status === "completed"
          ? "Codex device login completed."
          : "Codex device login started."
  };
}

function updateCodexLoginState(state: CodexLoginStateHost, codexLogin: CodexLoginProcessState): CodexLoginProcessState {
  state.codexLogin = codexLogin;
  return codexLogin;
}

export function clearCodexLoginState(state: CodexLoginStateHost): void {
  const tracker = codexLoginTrackers.get(state);
  if (tracker) {
    tracker.cleared = true;
    codexLoginTrackers.delete(state);
  }
  state.codexLogin = undefined;
}

export async function codexRuntimeStatusForResponse(
  env: Record<string, string | undefined>,
  state: CodexLoginStateHost,
  options: { force?: boolean; lastRunUsage?: CodexRuntimeStatus["usage"]["lastRunUsage"] } = {}
): Promise<CodexRuntimeStatus & { codexLogin?: CodexLoginProcessState }> {
  const status = await getCodexRuntimeStatus({ env, force: options.force, lastRunUsage: options.lastRunUsage });
  if (status.auth.state === "authenticated" && state.codexLogin) {
    clearCodexLoginState(state);
  }
  return state.codexLogin ? { ...status, codexLogin: state.codexLogin } : status;
}

async function waitForCodexLoginInitialState(state: CodexLoginStateHost, timeoutMs: number): Promise<void> {
  const startedAt = state.codexLogin?.startedAt;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const codexLogin = state.codexLogin;
    const status = codexLogin && codexLogin.startedAt === startedAt ? codexLogin.status : undefined;
    if (status === "device_code") {
      await waitForCodexLoginTerminalSettle(state, startedAt);
      return;
    }
    if (status === "failed" || status === "completed") {
      return;
    }
    await sleep(50);
  }
  const tracker = codexLoginTrackers.get(state);
  if (tracker && !tracker.cleared && state.codexLogin?.startedAt === tracker.startedAt && state.codexLogin.status === "starting") {
    updateCodexLoginState(state, { ...state.codexLogin, status: "pending" });
  }
}

async function waitForCodexLoginTerminalSettle(
  state: CodexLoginStateHost,
  startedAt: string | undefined,
  settleMs = 100
): Promise<void> {
  const deadline = Date.now() + settleMs;
  while (Date.now() < deadline) {
    const codexLogin = state.codexLogin;
    const status = codexLogin && codexLogin.startedAt === startedAt ? codexLogin.status : undefined;
    if (status !== "device_code") {
      return;
    }
    if (!codexLoginTrackers.has(state)) {
      return;
    }
    await sleep(10);
  }
}

export function parseCodexDeviceAuthOutput(output: string): Pick<RuntimeProviderLoginResult, "verificationUri" | "verificationUriComplete" | "userCode"> {
  const urls = [...output.matchAll(/https?:\/\/[^\s)'"]+/g)].map(match => match[0].replace(/[.,;:]+$/, ""));
  const verificationUriComplete = urls.find(url => /[?&](user_?code|code)=/i.test(url));
  const verificationUri = urls.find(url => url !== verificationUriComplete) ?? verificationUriComplete;
  const codeFromUrl = verificationUriComplete ? codeFromVerificationUrl(verificationUriComplete) : undefined;
  const codeFromText = output.match(/(?:user\s+code|one[-\s]?code|one[-\s]?time\s+code|code)[:\s]+([A-Z0-9][A-Z0-9\-\s]{3,}[A-Z0-9])/i)?.[1]
    ?.trim()
    .replace(/\s+/g, "-");
  return {
    ...(verificationUri ? { verificationUri } : {}),
    ...(verificationUriComplete ? { verificationUriComplete } : {}),
    ...(codeFromUrl ?? codeFromText ? { userCode: codeFromUrl ?? codeFromText } : {})
  };
}

function codeFromVerificationUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.searchParams.get("user_code") ?? url.searchParams.get("user-code") ?? url.searchParams.get("code") ?? undefined;
  } catch (_error) {
    return undefined;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
