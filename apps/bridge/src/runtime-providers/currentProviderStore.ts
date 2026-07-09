import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { currentProcessEnv } from "@hunsu/config";
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

const DEFAULT_APP_STATE_PATH = join(homedir(), ".config", "hunsu", "bridge-app.json");

export function defaultBridgeRuntimeProviderState(): BridgeRuntimeProviderState {
  return {
    currentProviderId: "codex",
    providers: {
      codex: {
        enabled: true,
        settings: {}
      }
    }
  };
}

export function normalizeBridgeRuntimeProviderState(value: unknown): BridgeRuntimeProviderState {
  const defaults = defaultBridgeRuntimeProviderState();
  if (!isRecord(value)) {
    return defaults;
  }
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
    currentProviderId: typeof value.currentProviderId === "string" && value.currentProviderId.trim()
      ? value.currentProviderId.trim()
      : defaults.currentProviderId,
    providers
  };
}

export function bridgeRuntimeProviderStatePath(env: Record<string, string | undefined> = currentProcessEnv()): string {
  return env.HUNSU_BRIDGE_APP_STATE_PATH?.trim() || DEFAULT_APP_STATE_PATH;
}

export function readBridgeRuntimeProviderState(env: Record<string, string | undefined> = currentProcessEnv()): BridgeRuntimeProviderState {
  const path = bridgeRuntimeProviderStatePath(env);
  if (!existsSync(path)) {
    return defaultBridgeRuntimeProviderState();
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    return migrateLegacyCodexSettings(normalizeBridgeRuntimeProviderState(parsed.runtimeProviders), parsed);
  } catch (_error) {
    return defaultBridgeRuntimeProviderState();
  }
}

export function createBridgeAppRuntimeProviderStore(
  env: Record<string, string | undefined> = currentProcessEnv()
): RuntimeProviderStateStore {
  const path = bridgeRuntimeProviderStatePath(env);
  return {
    read: () => readBridgeRuntimeProviderState(env),
    write: state => {
      const existing = readRawBridgeAppState(path);
      const existingCodex = isRecord(existing.codex)
        ? omitRecordKeys(existing.codex, ["binaryPath", "codexHome", "appServerCommand", "appServerArgs", "environment", "installChannel", "authenticationPreference"])
        : existing.codex;
      const next = {
        ...existing,
        ...(existingCodex && isRecord(existingCodex) ? { codex: existingCodex } : {}),
        schema: "hunsu.bridge-app-state.v1",
        runtimeProviders: normalizeBridgeRuntimeProviderState(state)
      };
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    }
  };
}

function migrateLegacyCodexSettings(state: BridgeRuntimeProviderState, rawState: Record<string, unknown>): BridgeRuntimeProviderState {
  const settings = codexSettingsFromRecord(state.providers.codex?.settings);
  const legacyCodex = isRecord(rawState.codex) ? rawState.codex : undefined;
  const legacyEnvironment = isRecord(legacyCodex?.environment) ? legacyCodex.environment : undefined;
  const legacyBinaryPath = typeof legacyCodex?.binaryPath === "string" && legacyCodex.binaryPath.trim()
    ? legacyCodex.binaryPath.trim()
    : undefined;
  const legacySettings: BridgeCodexSettings = {
    ...(legacyBinaryPath && !settings.binaryPath ? { binaryPath: legacyBinaryPath } : {}),
    ...legacyCodexEnvironmentSettings(legacyEnvironment, settings),
    ...(legacyCodex?.installChannel === "stable" || legacyCodex?.installChannel === "latest" || legacyCodex?.installChannel === "manual"
      ? { installChannel: legacyCodex.installChannel }
      : {}),
    ...(legacyCodex?.authenticationPreference === "chatgpt" || legacyCodex?.authenticationPreference === "api_key" || legacyCodex?.authenticationPreference === "device_code"
      ? { authenticationPreference: legacyCodex.authenticationPreference }
      : {})
  };
  const nextSettings = {
    ...state.providers.codex?.settings,
    ...legacySettings,
    ...settings
  };
  return normalizeBridgeRuntimeProviderState({
    ...state,
    providers: {
      ...state.providers,
      codex: {
        enabled: true,
        settings: nextSettings
      }
    }
  });
}

function legacyCodexEnvironmentSettings(
  environment: Record<string, unknown> | undefined,
  current: BridgeCodexSettings
): BridgeCodexSettings {
  const codexHome = typeof environment?.CODEX_HOME === "string" && environment.CODEX_HOME.trim() && !current.codexHome
    ? environment.CODEX_HOME.trim()
    : undefined;
  const appServerCommand = typeof environment?.HUNSU_CODEX_APP_SERVER_COMMAND === "string"
    && environment.HUNSU_CODEX_APP_SERVER_COMMAND.trim()
    && !current.appServerCommand
    ? environment.HUNSU_CODEX_APP_SERVER_COMMAND.trim()
    : undefined;
  const appServerArgs = typeof environment?.HUNSU_CODEX_APP_SERVER_ARGS === "string"
    && environment.HUNSU_CODEX_APP_SERVER_ARGS.trim()
    && !current.appServerArgs
    ? environment.HUNSU_CODEX_APP_SERVER_ARGS.trim()
    : undefined;
  return {
    ...(codexHome ? { codexHome } : {}),
    ...(appServerCommand ? { appServerCommand } : {}),
    ...(appServerArgs ? { appServerArgs } : {})
  };
}

function omitRecordKeys(record: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const next = { ...record };
  for (const key of keys) {
    delete next[key];
  }
  return next;
}

function readRawBridgeAppState(path: string): Record<string, unknown> {
  if (!existsSync(path)) {
    return {};
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return isRecord(parsed) ? parsed : {};
  } catch (_error) {
    return {};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
