import { BridgeError } from "../client/cliResult.ts";
import {
  codexConfigFieldsFromSettings,
  codexProviderMetadata,
  codexSettingsFromRecord,
  settingsWithCodexConfigFields,
  type BridgeCodexSettings
} from "../runtime-providers/codex/codexConfig.ts";
import { CodexRuntimeProvider } from "../runtime-providers/codex/codexProvider.ts";
import type {
  RuntimeProviderAdapter,
  RuntimeProviderRegistry,
  RuntimeProviderStatus
} from "../runtime-providers/types.ts";
import {
  createConfigStore,
  type BridgeConfig,
  type BridgeProviderConfig,
  type ConfigStore
} from "../state/index.ts";

export type HeadlessProviderKind = "codex";

export type HeadlessProviderSummary = {
  providerId: HeadlessProviderKind;
  label: string;
  configured: boolean;
};

export type SetCodexProviderInput = {
  binaryPath?: string;
  home?: string;
  appServerCommand?: string;
  appServerArgs?: string;
  installChannel?: "stable" | "latest" | "manual";
  authenticationPreference?: "chatgpt" | "api_key" | "device_code";
};

export type HeadlessProviderService = {
  list(): Promise<HeadlessProviderSummary[]>;
  configuration(): Promise<BridgeProviderConfig>;
  status(force?: boolean): Promise<RuntimeProviderStatus>;
  setCodex(input: SetCodexProviderInput): Promise<RuntimeProviderStatus>;
  resetCodex(): Promise<RuntimeProviderStatus>;
  onConfigurationChange(listener: (configuration: BridgeProviderConfig) => void): () => void;
};

export function createHeadlessProviderService(input: {
  configStore: ConfigStore;
  env?: Record<string, string | undefined>;
}): HeadlessProviderService {
  const env = { ...(input.env ?? {}) };
  const configurationListeners = new Set<(configuration: BridgeProviderConfig) => void>();

  const providerFromConfig = (config: BridgeConfig): CodexRuntimeProvider => new CodexRuntimeProvider({
    env: () => env,
    settings: codexSettingsForBridgeProvider(config.provider)
  });

  const publishConfiguration = (configuration: BridgeProviderConfig): void => {
    for (const listener of configurationListeners) {
      try {
        listener(cloneProviderConfiguration(configuration));
      } catch (_error) {
        // Configuration is already durable. A compatibility listener must not
        // make the authoritative provider update appear to have failed.
      }
    }
  };

  return {
    async list() {
      const config = await input.configStore.read();
      return [{ providerId: "codex", label: "Codex", configured: config.provider.kind === "codex" }];
    },
    async configuration() {
      return cloneProviderConfiguration((await input.configStore.read()).provider);
    },
    async status(force = false) {
      const config = await input.configStore.read();
      return providerFromConfig(config).status({ force, env });
    },
    async setCodex(settings) {
      const config = await input.configStore.read();
      const next: BridgeConfig = {
        ...config,
        provider: {
          kind: "codex",
          ...(settings.binaryPath?.trim() ? { binaryPath: settings.binaryPath.trim() } : {}),
          ...(settings.home?.trim() ? { home: settings.home.trim() } : {}),
          ...(settings.appServerCommand?.trim() ? { appServerCommand: settings.appServerCommand.trim() } : {}),
          ...(settings.appServerArgs?.trim() ? { appServerArgs: settings.appServerArgs.trim() } : {}),
          ...(settings.installChannel ? { installChannel: settings.installChannel } : {}),
          ...(settings.authenticationPreference ? { authenticationPreference: settings.authenticationPreference } : {})
        }
      };
      const status = await providerFromConfig(next).status({ force: true, env });
      if (!status.installed) {
        throw new BridgeError("PROVIDER_BINARY_NOT_FOUND", status.safeMessage ?? "Codex was not found by Hunsu Bridge.");
      }
      if (!status.configured) {
        throw new BridgeError("PROVIDER_CHECK_FAILED", status.safeMessage ?? "Codex could not initialize its app-server.");
      }
      const persisted = await input.configStore.update(current => ({ ...current, provider: next.provider }));
      publishConfiguration(persisted.provider);
      return status;
    },
    async resetCodex() {
      const next = await input.configStore.update(config => ({ ...config, provider: { kind: "unconfigured" } }));
      publishConfiguration(next.provider);
      return providerFromConfig(next).status({ force: true, env });
    },
    onConfigurationChange(listener) {
      configurationListeners.add(listener);
      return () => configurationListeners.delete(listener);
    }
  };
}

export function createHeadlessRuntimeProviderRegistry(input: {
  service: HeadlessProviderService;
  fallback: RuntimeProviderRegistry;
  env: () => Record<string, string | undefined>;
}): RuntimeProviderRegistry {
  const providerForCurrentConfiguration = async (): Promise<CodexRuntimeProvider> => new CodexRuntimeProvider({
    env: input.env,
    settings: codexSettingsForBridgeProvider(await input.service.configuration())
  });
  const codex: RuntimeProviderAdapter & {
    effectiveEnv: (env?: Record<string, string | undefined>) => Record<string, string | undefined>;
  } = {
    providerId: "codex",
    kind: "codex",
    label: "Codex",
    metadata: () => codexProviderMetadata,
    async readConfig() {
      return codexConfigFieldsFromSettings(codexSettingsForBridgeProvider(await input.service.configuration()));
    },
    async validateConfig(fields) {
      return (await providerForCurrentConfiguration()).validateConfig(fields);
    },
    async saveConfig(fields) {
      const current = codexSettingsForBridgeProvider(await input.service.configuration());
      return input.service.setCodex(setCodexInputFromSettings(settingsWithCodexConfigFields(current, fields)));
    },
    async deleteConfig(keys) {
      if (!keys?.length) return input.service.resetCodex();
      const current = codexSettingsForBridgeProvider(await input.service.configuration());
      const next = settingsWithCodexConfigFields(current, keys.map(key => ({
        key,
        value: "",
        isSet: false,
        isSecret: false
      })));
      return input.service.setCodex(setCodexInputFromSettings(next));
    },
    status: options => input.service.status(options?.force),
    async installPlan() {
      return (await providerForCurrentConfiguration()).installPlan();
    },
    async install(options) {
      return (await providerForCurrentConfiguration()).install(options);
    },
    async login(options) {
      return (await providerForCurrentConfiguration()).login(options);
    },
    recheck: () => input.service.status(true),
    async configure(options) {
      if (options.authMethod === "api_key") {
        return (await providerForCurrentConfiguration()).configure(options);
      }
      const current = codexSettingsForBridgeProvider(await input.service.configuration());
      const requestedBinaryPath = options.binaryPath?.trim() || options.selectBinaryPath?.trim();
      const next = {
        ...current,
        ...(requestedBinaryPath ? { binaryPath: requestedBinaryPath } : {})
      };
      if (options.clearBinaryPath) delete next.binaryPath;
      return input.service.setCodex(setCodexInputFromSettings(next));
    },
    effectiveEnv: env => ({ ...input.env(), ...(env ?? {}) })
  };
  const providers = input.fallback.list().map(provider => provider.providerId === "codex" ? codex : provider);
  if (!providers.some(provider => provider.providerId === "codex")) providers.unshift(codex);
  return {
    list: () => [...providers],
    get: providerId => providerId === "codex"
      ? codex
      : providers.find(provider => provider.providerId === providerId),
    current: () => codex,
    async setCurrent(providerId) {
      if (providerId === "codex") return;
      await input.fallback.setCurrent(providerId);
    }
  };
}

export function codexSettingsForBridgeProvider(configuration: BridgeProviderConfig): BridgeCodexSettings {
  return configuration.kind === "codex"
    ? codexSettingsFromRecord({
        binaryPath: configuration.binaryPath,
        codexHome: configuration.home,
        appServerCommand: configuration.appServerCommand,
        appServerArgs: configuration.appServerArgs,
        installChannel: configuration.installChannel,
        authenticationPreference: configuration.authenticationPreference
      })
    : {};
}

function setCodexInputFromSettings(settings: BridgeCodexSettings): SetCodexProviderInput {
  return {
    ...(settings.binaryPath ? { binaryPath: settings.binaryPath } : {}),
    ...(settings.codexHome ? { home: settings.codexHome } : {}),
    ...(settings.appServerCommand ? { appServerCommand: settings.appServerCommand } : {}),
    ...(settings.appServerArgs ? { appServerArgs: settings.appServerArgs } : {}),
    ...(settings.installChannel ? { installChannel: settings.installChannel } : {}),
    ...(settings.authenticationPreference ? { authenticationPreference: settings.authenticationPreference } : {})
  };
}

function cloneProviderConfiguration(configuration: BridgeProviderConfig): BridgeProviderConfig {
  return { ...configuration };
}

export function createHeadlessProviderServiceForPaths(
  paths: Parameters<typeof createConfigStore>[0],
  env?: Record<string, string | undefined>
): HeadlessProviderService {
  return createHeadlessProviderService({ configStore: createConfigStore(paths), env });
}
