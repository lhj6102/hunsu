import { isAbsolute, resolve } from "node:path";
import { currentProcessEnv } from "@hunsu/config";
import { codexInstallPlan, runDefaultCodexInstaller, type CodexInstaller } from "./codexInstall.ts";
import {
  clearCodexLoginState,
  spawnCodexAction,
  spawnCodexChatGptLogin,
  spawnCodexDeviceLogin,
  type CodexLoginProcessState,
  type CodexLoginStateHost
} from "./codexLogin.ts";
import {
  getCodexRuntimeStatus,
  type CodexRuntimeStatus
} from "./codexStatus.ts";
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
} from "../types.ts";

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

export type CodexRuntimeProviderOptions = {
  env?: () => Record<string, string | undefined>;
  settings?: Record<string, unknown>;
  loginState?: CodexLoginStateHost;
  onConfigure?: (configuration: { binaryPath?: string }) => void;
  installer?: CodexInstaller;
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
    this.binaryPathOverride = stringSetting(options.settings, "binaryPath");
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
    if (codex.cli.installed && codex.cli.version && codex.appServer.available) {
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
      error: codex.cli.error,
      discovery: codex.cli.discovery
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

function stringSetting(settings: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = settings?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
