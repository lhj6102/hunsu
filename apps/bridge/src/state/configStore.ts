import type { HunsuPaths } from "./paths.ts";
import { invalidState, readJsonState, writeJsonStateAtomic } from "./atomicJsonStore.ts";

export const BRIDGE_CONFIG_SCHEMA = "hunsu.bridge.config.v1" as const;

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
  host: string;
  port: number;
  provider: BridgeProviderConfig;
  remote: { enabled: boolean };
};

export const DEFAULT_BRIDGE_CONFIG: Readonly<BridgeConfig> = Object.freeze({
  schema: BRIDGE_CONFIG_SCHEMA,
  host: "127.0.0.1",
  port: 19687,
  provider: Object.freeze({ kind: "unconfigured" }),
  remote: Object.freeze({ enabled: false })
});

export type ConfigStore = {
  read(): Promise<BridgeConfig>;
  write(config: BridgeConfig): Promise<void>;
  update(change: (config: BridgeConfig) => BridgeConfig): Promise<BridgeConfig>;
};

export function createConfigStore(paths: HunsuPaths): ConfigStore {
  let writeQueue = Promise.resolve();
  const readCurrent = async (): Promise<BridgeConfig> => {
    const value = await readJsonState(paths.configFile);
    return value === undefined ? cloneConfig(DEFAULT_BRIDGE_CONFIG) : decodeConfig(paths.configFile, value);
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
        await writeJsonStateAtomic(paths.configFile, decodeConfig(paths.configFile, config));
      });
    },
    async update(change) {
      return serialize(async () => {
        const next = decodeConfig(paths.configFile, change(await readCurrent()));
        await writeJsonStateAtomic(paths.configFile, next);
        return next;
      });
    }
  };
}

function decodeConfig(file: string, value: unknown): BridgeConfig {
  if (!isRecord(value) || value.schema !== BRIDGE_CONFIG_SCHEMA) {
    throw invalidState(file, `expected schema ${BRIDGE_CONFIG_SCHEMA}`);
  }
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
    host: value.host.trim(),
    port: value.port as number,
    provider,
    remote: { enabled: value.remote.enabled }
  };
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
