import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import { isAbsolute, win32 } from "node:path";
import {
  isBridgeDeploymentProfile,
  type BridgeDeploymentProfile
} from "../deploymentProfile.ts";
import type { HunsuPaths } from "../state/paths.ts";
import { invalidState, isNodeError, readJsonState, writeJsonStateAtomic } from "../state/atomicJsonStore.ts";
import type { ServiceInstallInput } from "../service/types.ts";
import { HUNSU_BRIDGE_VERSION } from "../version.ts";

export const BRIDGE_PACKAGE_VERSION = HUNSU_BRIDGE_VERSION;
export const BRIDGE_PACKAGE_SPEC = `@hunsu/bridge@${BRIDGE_PACKAGE_VERSION}` as const;
export const LEGACY_RUNTIME_INSTALL_SCHEMA = "hunsu.bridge.runtime-install.v1" as const;
export const RUNTIME_INSTALL_SCHEMA = "hunsu.bridge.runtime-install.v2" as const;

export type RuntimeInstallation = {
  packageVersion: string;
  runtimePath: string;
  nodePath: string;
  cliPath: string;
  cliSha256: string | null;
  installedAt: string;
};

export type VerifiedRuntimeInstallation = RuntimeInstallation & {
  cliSha256: string;
};

export type RuntimeInstallDocument = {
  schema: typeof RUNTIME_INSTALL_SCHEMA;
  installationId: string | null;
  current: RuntimeInstallation;
  previous: RuntimeInstallation | null;
  serviceInput: ServiceInstallInput;
  updatedAt: string;
};

export type RuntimeInstallStore = {
  read(): Promise<RuntimeInstallDocument | undefined>;
  write(document: RuntimeInstallDocument): Promise<void>;
  clear(): Promise<void>;
};

export class RuntimeInstallError extends Error {
  readonly code = "RUNTIME_INSTALL_FAILED" as const;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RuntimeInstallError";
  }
}

export function createRuntimeInstallationId(): string {
  return `install_${randomUUID()}`;
}

export function createRuntimeInstallStore(paths: HunsuPaths): RuntimeInstallStore {
  return {
    async read() {
      const value = await readJsonState(paths.runtimeInstallFile);
      return value === undefined ? undefined : decodeRuntimeInstallDocument(paths.runtimeInstallFile, value);
    },
    async write(document) {
      await writeJsonStateAtomic(
        paths.runtimeInstallFile,
        decodeRuntimeInstallDocument(paths.runtimeInstallFile, document),
        { mode: 0o600 }
      );
    },
    async clear() {
      try {
        await unlink(paths.runtimeInstallFile);
      } catch (error) {
        if (!isNodeError(error) || error.code !== "ENOENT") throw error;
      }
    }
  };
}

export function serviceInputForInstallation(
  installation: RuntimeInstallation,
  hunsuHome: string,
  deploymentProfile: BridgeDeploymentProfile = "production"
): ServiceInstallInput {
  return {
    nodePath: installation.nodePath,
    cliPath: installation.cliPath,
    hunsuHome,
    packageVersion: installation.packageVersion,
    runtimePath: installation.runtimePath,
    deploymentProfile
  };
}

export function decodeRuntimeInstallDocument(file: string, value: unknown): RuntimeInstallDocument {
  if (!isRecord(value)
    || (value.schema !== RUNTIME_INSTALL_SCHEMA && value.schema !== LEGACY_RUNTIME_INSTALL_SCHEMA)) {
    throw invalidState(file, `expected schema ${RUNTIME_INSTALL_SCHEMA} or ${LEGACY_RUNTIME_INSTALL_SCHEMA}`);
  }
  const legacy = value.schema === LEGACY_RUNTIME_INSTALL_SCHEMA;
  return {
    schema: RUNTIME_INSTALL_SCHEMA,
    installationId: decodeInstallationId(file, value.installationId),
    current: decodeRuntimeInstallation(file, "current", value.current, { legacy }),
    previous: value.previous === null
      ? null
      : decodeRuntimeInstallation(file, "previous", value.previous, { legacy }),
    serviceInput: decodeServiceInput(file, value.serviceInput),
    updatedAt: requiredString(file, "updatedAt", value.updatedAt)
  };
}

function decodeInstallationId(file: string, value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const installationId = requiredString(file, "installationId", value);
  if (!/^install_[A-Za-z0-9_-]{8,}$/u.test(installationId)) {
    throw invalidState(file, "installationId must be a Hunsu installation id");
  }
  return installationId;
}

export function decodeRuntimeInstallation(
  file: string,
  field: string,
  value: unknown,
  options: { legacy?: boolean; allowUnverified?: boolean } = {}
): RuntimeInstallation {
  if (!isRecord(value)) throw invalidState(file, `${field} must be an installation record`);
  return {
    packageVersion: requiredString(file, `${field}.packageVersion`, value.packageVersion),
    runtimePath: requiredAbsolutePath(file, `${field}.runtimePath`, value.runtimePath),
    nodePath: requiredAbsolutePath(file, `${field}.nodePath`, value.nodePath),
    cliPath: requiredAbsolutePath(file, `${field}.cliPath`, value.cliPath),
    cliSha256: decodeCliSha256(file, `${field}.cliSha256`, value.cliSha256, options),
    installedAt: requiredString(file, `${field}.installedAt`, value.installedAt)
  };
}

function decodeCliSha256(
  file: string,
  field: string,
  value: unknown,
  options: { legacy?: boolean; allowUnverified?: boolean }
): string | null {
  if (options.legacy) return null;
  if ((value === undefined || value === null) && options.allowUnverified) return null;
  if (value === null) return null;
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw invalidState(file, `${field} must be a lowercase SHA-256 digest or null`);
  }
  return value;
}

function decodeServiceInput(file: string, value: unknown): ServiceInstallInput {
  if (!isRecord(value)) throw invalidState(file, "serviceInput must be an object");
  return {
    nodePath: requiredAbsolutePath(file, "serviceInput.nodePath", value.nodePath),
    cliPath: requiredAbsolutePath(file, "serviceInput.cliPath", value.cliPath),
    hunsuHome: requiredAbsolutePath(file, "serviceInput.hunsuHome", value.hunsuHome),
    packageVersion: requiredString(file, "serviceInput.packageVersion", value.packageVersion),
    runtimePath: requiredAbsolutePath(file, "serviceInput.runtimePath", value.runtimePath),
    deploymentProfile: decodeDeploymentProfile(file, value.deploymentProfile)
  };
}

function decodeDeploymentProfile(file: string, value: unknown): BridgeDeploymentProfile {
  if (value === undefined) return "production";
  if (!isBridgeDeploymentProfile(value)) {
    throw invalidState(file, "serviceInput.deploymentProfile must be production or preview");
  }
  return value;
}

function requiredAbsolutePath(file: string, field: string, value: unknown): string {
  const path = requiredString(file, field, value);
  if (!isAbsolute(path) && !win32.isAbsolute(path)) throw invalidState(file, `${field} must be absolute`);
  return path;
}

function requiredString(file: string, field: string, value: unknown): string {
  if (typeof value !== "string" || !value.trim() || containsControlCharacter(value)) {
    throw invalidState(file, `${field} must be a non-empty safe string`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function containsControlCharacter(value: string): boolean {
  return /[\u0000-\u001f\u007f]/u.test(value);
}
