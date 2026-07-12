import { unlink } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { HunsuPaths } from "./paths.ts";
import { invalidState, isNodeError, readJsonState, writeJsonStateAtomic } from "./atomicJsonStore.ts";

export const BRIDGE_RUNTIME_SCHEMA = "hunsu.bridge.runtime.v1" as const;

export type BridgeServiceManagerKind = "development" | "windows-task-scheduler" | "macos-launch-agent" | "linux-systemd-user";

export type BridgeRuntimeIdentity = {
  schema: typeof BRIDGE_RUNTIME_SCHEMA;
  instanceId: string;
  daemonPid: number;
  version: string;
  protocolVersion: "local-bridge-v1";
  startedAt: string;
  endpoint: string;
  runtimePath: string;
  serviceManager: BridgeServiceManagerKind;
  lastHealthyAt: string;
};

export type RuntimeStore = {
  read(): Promise<BridgeRuntimeIdentity | undefined>;
  write(identity: BridgeRuntimeIdentity): Promise<void>;
  clear(expectedInstanceId?: string): Promise<boolean>;
};

export function createRuntimeStore(paths: HunsuPaths): RuntimeStore {
  const read = async (): Promise<BridgeRuntimeIdentity | undefined> => {
    const value = await readJsonState(paths.runtimeFile);
    return value === undefined ? undefined : decodeRuntimeIdentity(paths.runtimeFile, value);
  };
  return {
    read,
    async write(identity) {
      await writeJsonStateAtomic(paths.runtimeFile, decodeRuntimeIdentity(paths.runtimeFile, identity));
    },
    async clear(expectedInstanceId) {
      if (expectedInstanceId !== undefined) {
        const current = await read();
        if (current === undefined || current.instanceId !== expectedInstanceId) return false;
      }
      try {
        await unlink(paths.runtimeFile);
        return true;
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") return false;
        throw error;
      }
    }
  };
}

function decodeRuntimeIdentity(file: string, value: unknown): BridgeRuntimeIdentity {
  if (!isRecord(value) || value.schema !== BRIDGE_RUNTIME_SCHEMA) {
    throw invalidState(file, `expected schema ${BRIDGE_RUNTIME_SCHEMA}`);
  }
  if (!Number.isInteger(value.daemonPid) || (value.daemonPid as number) <= 0) {
    throw invalidState(file, "daemonPid must be a positive integer");
  }
  const serviceManager = value.serviceManager;
  if (serviceManager !== "development"
    && serviceManager !== "windows-task-scheduler"
    && serviceManager !== "macos-launch-agent"
    && serviceManager !== "linux-systemd-user") {
    throw invalidState(file, "serviceManager is invalid");
  }
  return {
    schema: BRIDGE_RUNTIME_SCHEMA,
    instanceId: requiredString(file, "instanceId", value.instanceId),
    daemonPid: value.daemonPid as number,
    version: requiredString(file, "version", value.version),
    protocolVersion: requiredProtocolVersion(file, value.protocolVersion),
    startedAt: requiredString(file, "startedAt", value.startedAt),
    endpoint: requiredString(file, "endpoint", value.endpoint),
    runtimePath: requiredAbsolutePath(file, "runtimePath", value.runtimePath),
    serviceManager,
    lastHealthyAt: requiredString(file, "lastHealthyAt", value.lastHealthyAt)
  };
}

function requiredProtocolVersion(file: string, value: unknown): "local-bridge-v1" {
  if (value !== "local-bridge-v1") throw invalidState(file, "protocolVersion must be local-bridge-v1");
  return value;
}

function requiredString(file: string, field: string, value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") throw invalidState(file, `${field} must be non-empty`);
  return value;
}

function requiredAbsolutePath(file: string, field: string, value: unknown): string {
  const path = requiredString(file, field, value);
  if (!isAbsolute(path) || /[\u0000-\u001f\u007f]/u.test(path)) {
    throw invalidState(file, `${field} must be an absolute path without control characters`);
  }
  return path;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
