import { access } from "node:fs/promises";
import {
  isBridgeDeploymentProfile,
  type BridgeDeploymentProfile
} from "../deploymentProfile.ts";
import type { HunsuPaths } from "./paths.ts";
import { invalidState, isNodeError, readJsonState, writeJsonStateAtomic } from "./atomicJsonStore.ts";

export const LEGACY_BRIDGE_CONFIG_SCHEMA = "hunsu.bridge.config.v1" as const;
export const BRIDGE_CONFIG_SCHEMA = "hunsu.bridge.config.v2" as const;

export type BridgeProviderConfig =
  | { kind: "unconfigured" }
  | {
      kind: "codex";
      binaryPath?: string;
      home?: string;
      appServerCommand?: string;
      appServerArgs?: string;
      installChannel?: "stable" | "latest" | "manual";
      authenticationPreference?: "chatgpt" | "api_key" | "device_code";
    };

export type BridgeConfig = {
  schema: typeof BRIDGE_CONFIG_SCHEMA;
  deploymentProfile: BridgeDeploymentProfile;
  host: string;
  port: number;
  provider: BridgeProviderConfig;
  remote: { enabled: boolean };
};

export const DEFAULT_BRIDGE_CONFIG: Readonly<BridgeConfig> = Object.freeze({
  schema: BRIDGE_CONFIG_SCHEMA,
  deploymentProfile: "production",
  host: "127.0.0.1",
  port: 19687,
  provider: Object.freeze({ kind: "unconfigured" }),
  remote: Object.freeze({ enabled: false })
});

export type ConfigStore = {
  read(): Promise<BridgeConfig>;
  write(config: BridgeConfig): Promise<void>;
  update(change: (config: BridgeConfig) => BridgeConfig): Promise<BridgeConfig>;
  ensureDeploymentProfile(profile: BridgeDeploymentProfile): Promise<BridgeConfig>;
};

export function createConfigStore(paths: HunsuPaths): ConfigStore {
  let writeQueue = Promise.resolve();
  const readCurrent = async (): Promise<BridgeConfig> => {
    const value = await readJsonState(paths.configFile);
    return value === undefined ? cloneConfig(DEFAULT_BRIDGE_CONFIG) : decodeBridgeConfig(paths.configFile, value);
  };
  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const task = writeQueue.then(operation, operation);
    writeQueue = task.then(() => undefined, () => undefined);
    return task;
  };
  return {
    async read() {
      await writeQueue;
      return readCurrent();
    },
    async write(config) {
      await serialize(async () => {
        await writeJsonStateAtomic(paths.configFile, decodeBridgeConfig(paths.configFile, config));
      });
    },
    async update(change) {
      return serialize(async () => {
        const next = decodeBridgeConfig(paths.configFile, change(await readCurrent()));
        await writeJsonStateAtomic(paths.configFile, next);
        return next;
      });
    },
    async ensureDeploymentProfile(profile) {
      return serialize(async () => {
        const persisted = await readJsonState(paths.configFile);
        if (persisted === undefined) {
          if (profile !== "production" && await hasDurableBridgeState(paths)) {
            throw invalidState(
              paths.configFile,
              "a populated HUNSU_HOME without an explicit profile is treated as production and cannot switch to preview"
            );
          }
          const initialized = { ...cloneConfig(DEFAULT_BRIDGE_CONFIG), deploymentProfile: profile };
          await writeJsonStateAtomic(paths.configFile, initialized);
          return initialized;
        }
        const current = decodeBridgeConfig(paths.configFile, persisted);
        if (current.deploymentProfile !== profile) {
          throw invalidState(
            paths.configFile,
            `deploymentProfile is ${current.deploymentProfile} and cannot switch to ${profile} in a populated HUNSU_HOME`
          );
        }
        if (isLegacyConfig(persisted)) {
          await writeJsonStateAtomic(paths.configFile, current);
        }
        return current;
      });
    }
  };
}

export function decodeBridgeConfig(file: string, value: unknown): BridgeConfig {
  if (!isRecord(value)
    || (value.schema !== BRIDGE_CONFIG_SCHEMA && value.schema !== LEGACY_BRIDGE_CONFIG_SCHEMA)) {
    throw invalidState(file, `expected schema ${BRIDGE_CONFIG_SCHEMA} or ${LEGACY_BRIDGE_CONFIG_SCHEMA}`);
  }
  const deploymentProfile = value.schema === LEGACY_BRIDGE_CONFIG_SCHEMA
    ? "production"
    : decodeDeploymentProfile(file, value.deploymentProfile);
  if (typeof value.host !== "string" || value.host.trim() === "") {
    throw invalidState(file, "host must be a non-empty string");
  }
  if (!Number.isInteger(value.port) || (value.port as number) < 0 || (value.port as number) > 65_535) {
    throw invalidState(file, "port must be an integer from 0 through 65535");
  }
  if (!isRecord(value.remote) || typeof value.remote.enabled !== "boolean") {
    throw invalidState(file, "remote.enabled must be a boolean");
  }
  const provider = decodeProvider(file, value.provider);
  return {
    schema: BRIDGE_CONFIG_SCHEMA,
    deploymentProfile,
    host: value.host.trim(),
    port: value.port as number,
    provider,
    remote: { enabled: value.remote.enabled }
  };
}

function decodeDeploymentProfile(file: string, value: unknown): BridgeDeploymentProfile {
  if (!isBridgeDeploymentProfile(value)) {
    throw invalidState(file, "deploymentProfile must be production or preview");
  }
  return value;
}

function decodeProvider(file: string, value: unknown): BridgeProviderConfig {
  if (!isRecord(value)) {
    throw invalidState(file, "provider must be configured explicitly");
  }
  if (value.kind === "unconfigured") {
    return { kind: "unconfigured" };
  }
  if (value.kind !== "codex") {
    throw invalidState(file, "provider.kind must be unconfigured or codex");
  }
  const binaryPath = optionalNonEmptyString(file, "provider.binaryPath", value.binaryPath);
  const home = optionalNonEmptyString(file, "provider.home", value.home);
  const appServerCommand = optionalNonEmptyString(file, "provider.appServerCommand", value.appServerCommand);
  const appServerArgs = optionalNonEmptyString(file, "provider.appServerArgs", value.appServerArgs);
  const installChannel = optionalEnum(file, "provider.installChannel", value.installChannel, ["stable", "latest", "manual"] as const);
  const authenticationPreference = optionalEnum(
    file,
    "provider.authenticationPreference",
    value.authenticationPreference,
    ["chatgpt", "api_key", "device_code"] as const
  );
  return {
    kind: "codex",
    ...(binaryPath ? { binaryPath } : {}),
    ...(home ? { home } : {}),
    ...(appServerCommand ? { appServerCommand } : {}),
    ...(appServerArgs ? { appServerArgs } : {}),
    ...(installChannel ? { installChannel } : {}),
    ...(authenticationPreference ? { authenticationPreference } : {})
  };
}

function optionalEnum<const T extends readonly string[]>(
  file: string,
  field: string,
  value: unknown,
  allowed: T
): T[number] | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw invalidState(file, `${field} must be one of ${allowed.join(", ")} when present`);
  }
  return value as T[number];
}

function optionalNonEmptyString(file: string, field: string, value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw invalidState(file, `${field} must be a non-empty string when present`);
  }
  return value;
}

function cloneConfig(config: Readonly<BridgeConfig>): BridgeConfig {
  return {
    ...config,
    provider: { ...config.provider },
    remote: { ...config.remote }
  };
}

async function hasDurableBridgeState(paths: HunsuPaths): Promise<boolean> {
  const durableFiles = [
    paths.homeOwnershipFile,
    paths.credentialsFile,
    paths.workspacesFile,
    paths.runtimeFile,
    paths.runtimeInstallFile,
    paths.setupTransactionFile
  ];
  const present = await Promise.all(durableFiles.map(async file => {
    try {
      await access(file);
      return true;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return false;
      throw invalidState(file, "durable Bridge state could not be inspected safely");
    }
  }));
  return present.some(Boolean);
}

function isLegacyConfig(value: unknown): boolean {
  return isRecord(value) && value.schema === LEGACY_BRIDGE_CONFIG_SCHEMA;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
