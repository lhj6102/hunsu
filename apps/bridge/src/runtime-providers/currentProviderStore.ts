import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { currentProcessEnv } from "@hunsu/config";
import { resolveHunsuPaths } from "../state/paths.ts";
import {
  BRIDGE_CONFIG_SCHEMA,
  decodeBridgeConfig,
  type BridgeConfig
} from "../state/configStore.ts";
import { codexSettingsFromRecord, type BridgeCodexSettings } from "./codex/codexConfig.ts";

export type BridgeRuntimeProviderState = {
  currentProviderId: string;
  providers: Record<string, {
    enabled: boolean;
    settings: Record<string, unknown>;
  }>;
};

export type RuntimeProviderStateStore = {
  read(): BridgeRuntimeProviderState;
  write(state: BridgeRuntimeProviderState): void;
};

export function defaultBridgeRuntimeProviderState(): BridgeRuntimeProviderState {
  return {
    currentProviderId: "codex",
    providers: { codex: { enabled: true, settings: {} } }
  };
}

export function normalizeBridgeRuntimeProviderState(value: unknown): BridgeRuntimeProviderState {
  const defaults = defaultBridgeRuntimeProviderState();
  if (!isRecord(value)) return defaults;
  const providers = isRecord(value.providers)
    ? Object.fromEntries(Object.entries(value.providers).map(([providerId, provider]) => {
        const providerObject = isRecord(provider) ? provider : {};
        return [providerId, {
          enabled: providerId === "codex" && providerObject.enabled !== false,
          settings: isRecord(providerObject.settings) ? providerObject.settings : {}
        }];
      }))
    : {};
  providers.codex = {
    enabled: true,
    settings: isRecord(providers.codex?.settings) ? providers.codex.settings : {}
  };
  return {
    currentProviderId: value.currentProviderId === "codex" ? "codex" : defaults.currentProviderId,
    providers
  };
}

export function bridgeRuntimeProviderStatePath(env: Record<string, string | undefined> = currentProcessEnv()): string {
  return resolveHunsuPaths({ env }).configFile;
}

export function readBridgeRuntimeProviderState(env: Record<string, string | undefined> = currentProcessEnv()): BridgeRuntimeProviderState {
  const config = readHeadlessConfig(bridgeRuntimeProviderStatePath(env));
  if (!config || config.provider.kind !== "codex") return defaultBridgeRuntimeProviderState();
  return normalizeBridgeRuntimeProviderState({
    currentProviderId: "codex",
    providers: {
      codex: {
        enabled: true,
        settings: {
          ...(config.provider.binaryPath ? { binaryPath: config.provider.binaryPath } : {}),
          ...(config.provider.home ? { codexHome: config.provider.home } : {}),
          ...(config.provider.appServerCommand ? { appServerCommand: config.provider.appServerCommand } : {}),
          ...(config.provider.appServerArgs ? { appServerArgs: config.provider.appServerArgs } : {}),
          ...(config.provider.installChannel ? { installChannel: config.provider.installChannel } : {}),
          ...(config.provider.authenticationPreference
            ? { authenticationPreference: config.provider.authenticationPreference }
            : {})
        }
      }
    }
  });
}

export function createBridgeRuntimeProviderStore(
  env: Record<string, string | undefined> = currentProcessEnv()
): RuntimeProviderStateStore {
  const path = bridgeRuntimeProviderStatePath(env);
  return {
    read: () => readBridgeRuntimeProviderState(env),
    write(state) {
      const existing = readHeadlessConfig(path) ?? {
        schema: BRIDGE_CONFIG_SCHEMA,
        deploymentProfile: "production",
        host: "127.0.0.1",
        port: 19687,
        provider: { kind: "unconfigured" },
        remote: { enabled: false }
      } satisfies BridgeConfig;
      const settings = codexSettingsFromRecord(state.providers.codex?.settings);
      const next: BridgeConfig = {
        ...existing,
        provider: {
          kind: "codex",
          ...(settings.binaryPath ? { binaryPath: settings.binaryPath } : {}),
          ...(settings.codexHome ? { home: settings.codexHome } : {}),
          ...(settings.appServerCommand ? { appServerCommand: settings.appServerCommand } : {}),
          ...(settings.appServerArgs ? { appServerArgs: settings.appServerArgs } : {}),
          ...(settings.installChannel ? { installChannel: settings.installChannel } : {}),
          ...(settings.authenticationPreference
            ? { authenticationPreference: settings.authenticationPreference }
            : {})
        }
      };
      writeConfigAtomic(path, next);
    }
  };
}

function readHeadlessConfig(path: string): BridgeConfig | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return decodeBridgeConfig(path, value);
  } catch (_error) {
    return undefined;
  }
}

function writeConfigAtomic(path: string, config: BridgeConfig): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, path);
}

export function bridgeCodexSettingsFromRuntimeProviderState(state: BridgeRuntimeProviderState): BridgeCodexSettings {
  return codexSettingsFromRecord(state.providers.codex?.settings);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
