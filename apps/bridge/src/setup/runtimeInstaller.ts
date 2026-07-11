import { execFile } from "node:child_process";
import { mkdir, rm, unlink } from "node:fs/promises";
import { isAbsolute, posix, win32 } from "node:path";
import type { HunsuPaths } from "../state/paths.ts";
import { invalidState, isNodeError, readJsonState, writeJsonStateAtomic } from "../state/atomicJsonStore.ts";
import type { ServiceInstallInput } from "../service/types.ts";

export const BRIDGE_PACKAGE_VERSION = "0.2.0-next.0" as const;
export const BRIDGE_PACKAGE_SPEC = `@hunsu/bridge@${BRIDGE_PACKAGE_VERSION}` as const;
export const RUNTIME_INSTALL_SCHEMA = "hunsu.bridge.runtime-install.v1" as const;

export type RuntimeInstallation = {
  packageVersion: string;
  runtimePath: string;
  nodePath: string;
  cliPath: string;
  installedAt: string;
};

export type RuntimeInstallDocument = {
  schema: typeof RUNTIME_INSTALL_SCHEMA;
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

export type RuntimeFileSystem = {
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  remove(path: string): Promise<void>;
};

export type RuntimeCommand = {
  command: string;
  args: string[];
};

export type RuntimeCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type RuntimeCommandRunner = (command: RuntimeCommand) => Promise<RuntimeCommandResult>;

export type StableRuntimePlan = {
  packageVersion: typeof BRIDGE_PACKAGE_VERSION;
  packageSpec: typeof BRIDGE_PACKAGE_SPEC;
  runtimePath: string;
  cliPath: string;
  nodePath: string;
  npmCommand: RuntimeCommand;
};

export class RuntimeInstallError extends Error {
  readonly code = "RUNTIME_INSTALL_FAILED" as const;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RuntimeInstallError";
  }
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

export const defaultRuntimeFileSystem: RuntimeFileSystem = {
  async exists(path) {
    try {
      const { access } = await import("node:fs/promises");
      await access(path);
      return true;
    } catch (_error) {
      return false;
    }
  },
  async mkdir(path) {
    await mkdir(path, { recursive: true, mode: 0o700 });
  },
  async remove(path) {
    await rm(path, { recursive: true, force: true });
  }
};

export const defaultRuntimeCommandRunner: RuntimeCommandRunner = command => new Promise(resolve => {
  execFile(command.command, command.args, {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 1024 * 1024
  }, (error, stdout, stderr) => {
    resolve({
      exitCode: error && "code" in error && typeof error.code === "number" ? error.code : error ? 1 : 0,
      stdout: stdout ?? "",
      stderr: stderr ?? (error instanceof Error ? error.message : "")
    });
  });
});

export function planStableRuntimeInstall(input: {
  paths: HunsuPaths;
  nodePath: string;
  platform?: NodeJS.Platform;
  npmCommand?: string;
}): StableRuntimePlan {
  const platform = input.platform ?? process.platform;
  const path = platform === "win32" ? win32 : posix;
  const absolute = platform === "win32" ? win32.isAbsolute : isAbsolute;
  if (!absolute(input.nodePath) || containsControlCharacter(input.nodePath)) {
    throw new RuntimeInstallError("The Node executable path must be absolute.");
  }
  const runtimePath = path.join(input.paths.runtimeVersionsDirectory, BRIDGE_PACKAGE_VERSION);
  const cliPath = path.join(runtimePath, "node_modules", "@hunsu", "bridge", "dist", "cli.js");
  return {
    packageVersion: BRIDGE_PACKAGE_VERSION,
    packageSpec: BRIDGE_PACKAGE_SPEC,
    runtimePath,
    cliPath,
    nodePath: input.nodePath,
    npmCommand: {
      command: input.npmCommand ?? "npm",
      args: ["install", "--omit=dev", "--prefix", runtimePath, BRIDGE_PACKAGE_SPEC]
    }
  };
}

export async function installStableRuntime(input: {
  plan: StableRuntimePlan;
  commandRunner?: RuntimeCommandRunner;
  fileSystem?: RuntimeFileSystem;
  now?: () => Date;
  dryRun?: boolean;
}): Promise<RuntimeInstallation> {
  const now = input.now ?? (() => new Date());
  const installation: RuntimeInstallation = {
    packageVersion: input.plan.packageVersion,
    runtimePath: input.plan.runtimePath,
    nodePath: input.plan.nodePath,
    cliPath: input.plan.cliPath,
    installedAt: now().toISOString()
  };
  if (input.dryRun) return installation;

  const fileSystem = input.fileSystem ?? defaultRuntimeFileSystem;
  const commandRunner = input.commandRunner ?? defaultRuntimeCommandRunner;
  await fileSystem.mkdir(input.plan.runtimePath);
  const result = await commandRunner(input.plan.npmCommand);
  if (result.exitCode !== 0) {
    throw new RuntimeInstallError("npm could not install the exact Hunsu Bridge runtime package.");
  }
  if (!await fileSystem.exists(input.plan.cliPath)) {
    throw new RuntimeInstallError("The installed Hunsu Bridge runtime does not contain dist/cli.js.");
  }
  return installation;
}

export function serviceInputForInstallation(
  installation: RuntimeInstallation,
  hunsuHome: string
): ServiceInstallInput {
  return {
    nodePath: installation.nodePath,
    cliPath: installation.cliPath,
    hunsuHome,
    packageVersion: installation.packageVersion,
    runtimePath: installation.runtimePath
  };
}

function decodeRuntimeInstallDocument(file: string, value: unknown): RuntimeInstallDocument {
  if (!isRecord(value) || value.schema !== RUNTIME_INSTALL_SCHEMA) {
    throw invalidState(file, `expected schema ${RUNTIME_INSTALL_SCHEMA}`);
  }
  return {
    schema: RUNTIME_INSTALL_SCHEMA,
    current: decodeInstallation(file, "current", value.current),
    previous: value.previous === null ? null : decodeInstallation(file, "previous", value.previous),
    serviceInput: decodeServiceInput(file, value.serviceInput),
    updatedAt: requiredString(file, "updatedAt", value.updatedAt)
  };
}

function decodeInstallation(file: string, field: string, value: unknown): RuntimeInstallation {
  if (!isRecord(value)) throw invalidState(file, `${field} must be an installation record`);
  return {
    packageVersion: requiredString(file, `${field}.packageVersion`, value.packageVersion),
    runtimePath: requiredAbsolutePath(file, `${field}.runtimePath`, value.runtimePath),
    nodePath: requiredAbsolutePath(file, `${field}.nodePath`, value.nodePath),
    cliPath: requiredAbsolutePath(file, `${field}.cliPath`, value.cliPath),
    installedAt: requiredString(file, `${field}.installedAt`, value.installedAt)
  };
}

function decodeServiceInput(file: string, value: unknown): ServiceInstallInput {
  if (!isRecord(value)) throw invalidState(file, "serviceInput must be an object");
  return {
    nodePath: requiredAbsolutePath(file, "serviceInput.nodePath", value.nodePath),
    cliPath: requiredAbsolutePath(file, "serviceInput.cliPath", value.cliPath),
    hunsuHome: requiredAbsolutePath(file, "serviceInput.hunsuHome", value.hunsuHome),
    packageVersion: requiredString(file, "serviceInput.packageVersion", value.packageVersion),
    runtimePath: requiredAbsolutePath(file, "serviceInput.runtimePath", value.runtimePath)
  };
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

