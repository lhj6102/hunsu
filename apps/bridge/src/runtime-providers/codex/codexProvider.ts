import { isAbsolute, resolve } from "node:path";
import { currentProcessEnv } from "@hunsu/config";
import {
  codexConfigFieldsFromSettings,
  codexEffectiveEnvSummary,
  codexProviderEnv,
  codexProviderMetadata,
  codexSettingsFromRecord,
  settingsWithCodexConfigFields,
  type BridgeCodexSettings
} from "./codexConfig.ts";
import {
  codexInstallPlan,
  detectCodexInstallerPrerequisite,
  runDefaultCodexInstaller,
  type CodexInstaller,
  type CodexInstallerPrerequisite,
  type CodexInstallerPrerequisiteProbe
} from "./codexInstall.ts";
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
import { codexProviderModelInventory } from "./codexModelInventory.ts";
import type {
  RuntimeProviderAdapter,
  RuntimeProviderAuthKind,
  RuntimeProviderCapabilities,
  RuntimeProviderConfigField,
  RuntimeProviderConfigValidationError,
  RuntimeProviderMetadata,
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
  onConfigure?: (settings: BridgeCodexSettings) => void;
  installer?: CodexInstaller;
  installerPrerequisite?: CodexInstallerPrerequisiteProbe;
};

export class CodexRuntimeProvider implements RuntimeProviderAdapter {
  providerId = "codex";
  kind = "codex" as const;
  label = "Codex";
  private settings: BridgeCodexSettings;
  private readonly internalLoginState: CodexLoginStateHost = {};
  private readonly options: CodexRuntimeProviderOptions;

  constructor(options: CodexRuntimeProviderOptions = {}) {
    this.options = options;
    this.settings = codexSettingsFromRecord(options.settings);
  }

  metadata(): RuntimeProviderMetadata {
    return codexProviderMetadata;
  }

  async readConfig(): Promise<RuntimeProviderConfigField[]> {
    return codexConfigFieldsFromSettings(this.settings);
  }

  async validateConfig(fields: RuntimeProviderConfigField[]): Promise<{
    valid: boolean;
    provider: RuntimeProviderStatus;
    diagnostics: NonNullable<RuntimeProviderStatus["diagnostics"]>;
    errors: RuntimeProviderConfigValidationError[];
  }> {
    const settings = settingsWithCodexConfigFields(this.settings, fields);
    return this.validateSettings(settings);
  }

  async saveConfig(fields: RuntimeProviderConfigField[]): Promise<RuntimeProviderStatus> {
    const settings = settingsWithCodexConfigFields(this.settings, fields);
    const validation = await this.validateSettings(settings);
    if (!validation.valid) {
      throw new Error(validation.provider.safeMessage ?? validation.provider.auth.error ?? validation.provider.install?.error ?? "Codex provider configuration is invalid.");
    }
    this.settings = settings;
    this.options.onConfigure?.(this.settings);
    return validation.provider;
  }

  async deleteConfig(keys?: string[]): Promise<RuntimeProviderStatus> {
    this.settings = keys && keys.length > 0
      ? settingsWithCodexConfigFields(this.settings, keys.map(key => ({
          key,
          value: "",
          isSet: false,
          isSecret: false
        })))
      : {};
    this.options.onConfigure?.(this.settings);
    return this.status({ force: true });
  }

  effectiveEnv(inputEnv: Record<string, string | undefined> = {}): Record<string, string | undefined> {
    return this.statusEnv(inputEnv);
  }

  async status(input: { force?: boolean; env?: Record<string, string | undefined> } = {}): Promise<RuntimeProviderStatus> {
    const env = this.statusEnv(input.env);
    const codex = await getCodexRuntimeStatus({
      force: input.force,
      env
    });
    return normalizeCodexRuntimeStatus(codex, { effectiveEnv: codexEffectiveEnvSummary(env) });
  }

  async recheck(): Promise<RuntimeProviderStatus> {
    return this.status({ force: true });
  }

  async installPlan(): Promise<RuntimeProviderInstallPlan> {
    return codexInstallPlan(await this.installerPrerequisite(this.statusEnv()));
  }

  async install(input: { confirmed?: boolean; dryRun?: boolean; env?: Record<string, string | undefined> } = {}): Promise<RuntimeProviderInstallResult> {
    const env = this.statusEnv(input.env);
    const before = await this.status({ force: true, env });
    const prerequisite = await this.installerPrerequisite(env);
    const plan = codexInstallPlan(prerequisite);
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
    if (!prerequisite.available) {
      return {
        providerId: this.providerId,
        confirmed: input.confirmed === true,
        started: false,
        status: "prerequisite_missing",
        message: prerequisite.message,
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
    const method = input.method === "default" ? loginMethodFromPreference(this.settings.authenticationPreference) : input.method;
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
      const next = { ...this.settings };
      delete next.binaryPath;
      this.settings = next;
      this.options.onConfigure?.(this.settings);
      return this.status({ force: true, env: input.env });
    }
    const requestedPath = input.binaryPath?.trim() || input.selectBinaryPath?.trim();
    if (!requestedPath) {
      return this.status({ force: true, env: input.env });
    }
    const binaryPath = isAbsolute(requestedPath) ? requestedPath : resolve(requestedPath);
    return this.saveConfig([{ key: "binaryPath", value: binaryPath, isSet: true, isSecret: false }]);
  }

  private async configureApiKey(input: RuntimeProviderConfigurationInput): Promise<RuntimeProviderStatus> {
    const apiKey = input.apiKey?.trim();
    const env = apiKey
      ? this.statusEnv({ ...input.env, OPENAI_API_KEY: apiKey })
      : this.statusEnv(input.env);
    return this.status({ force: true, env });
  }

  private statusEnv(inputEnv: Record<string, string | undefined> = {}): Record<string, string | undefined> {
    return codexProviderEnv({
      baseEnv: this.baseEnv(inputEnv),
      settings: this.settings
    });
  }

  private installerPrerequisite(env: Record<string, string | undefined>): Promise<CodexInstallerPrerequisite> {
    return Promise.resolve((this.options.installerPrerequisite ?? detectCodexInstallerPrerequisite)({ env }));
  }

  private baseEnv(inputEnv: Record<string, string | undefined> = {}): Record<string, string | undefined> {
    return {
      ...currentProcessEnv(),
      ...(this.options.env?.() ?? {}),
      ...inputEnv
    };
  }

  private async validateSettings(settings: BridgeCodexSettings): Promise<{
    valid: boolean;
    provider: RuntimeProviderStatus;
    diagnostics: NonNullable<RuntimeProviderStatus["diagnostics"]>;
    errors: RuntimeProviderConfigValidationError[];
  }> {
    const env = codexProviderEnv({ baseEnv: this.baseEnv(), settings });
    const codex = await getCodexRuntimeStatus({
      force: true,
      env,
      customBinaryPath: settings.binaryPath
    });
    const provider = normalizeCodexRuntimeStatus(codex, { effectiveEnv: codexEffectiveEnvSummary(env) });
    const valid = codex.cli.installed === true && Boolean(codex.cli.version) && codex.appServer.available === true;
    return {
      valid,
      provider,
      diagnostics: provider.diagnostics ?? { effectiveEnv: codexEffectiveEnvSummary(env) },
      errors: valid ? [] : codexConfigValidationErrors(settings, codex)
    };
  }
}

function codexConfigValidationErrors(
  settings: BridgeCodexSettings,
  codex: CodexRuntimeStatus
): RuntimeProviderConfigValidationError[] {
  if (!codex.cli.installed || !codex.cli.version) {
    return [{
      field: "binaryPath",
      message: settings.binaryPath
        ? "Select a Codex executable that Hunsu Bridge can run."
        : "Select an existing Codex executable or install Codex first."
    }];
  }
  if (!codex.appServer.available) {
    const field = settings.appServerCommand
      ? "appServerCommand"
      : settings.appServerArgs
        ? "appServerArgs"
        : "binaryPath";
    return [{
      field,
      message: "Codex app-server could not be started with this setting."
    }];
  }
  return [];
}

export function normalizeCodexRuntimeStatus(
  codex: CodexRuntimeStatus,
  options: { effectiveEnv?: Record<string, string | null> } = {}
): RuntimeProviderStatus {
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
      error: codex.auth.error,
      homeDiagnostic: codex.auth.homeDiagnostic
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
    modelInventory: {
      state: "available",
      models: codexProviderModelInventory()
    },
    recommendedAction: codexRecommendedAction(codex),
    diagnostics: {
      ...(options.effectiveEnv ? { effectiveEnv: options.effectiveEnv } : {}),
      ...(codex.auth.homeDiagnostic ? { codexHome: codex.auth.homeDiagnostic } : {})
    },
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
  if (codex.auth.homeDiagnostic?.likelyHomeMismatch && codex.auth.homeDiagnostic.remediation?.message) return codex.auth.homeDiagnostic.remediation.message;
  if (codex.auth.state === "not_authenticated") return "Sign in to Codex to enable Execute.";
  if (codex.auth.state === "expired" || codex.auth.state === "invalid") return "Codex sign-in needs to be refreshed.";
  if (codex.usage.rateLimited) return "Codex is temporarily rate limited.";
  if (codex.ready) return "Codex is ready.";
  return "Codex needs attention.";
}

function loginMethodFromPreference(preference: BridgeCodexSettings["authenticationPreference"]): "chatgpt" | "device" | "api_key" {
  if (preference === "device_code") return "device";
  if (preference === "api_key") return "api_key";
  return "chatgpt";
}
