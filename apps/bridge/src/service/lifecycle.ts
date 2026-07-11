import { execFile } from "node:child_process";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, win32 } from "node:path";
import type {
  AuthenticatedServiceStatus,
  BridgeServiceManager,
  BridgeServiceManagerKind,
  InstalledRuntimeInfo,
  ServiceCommandRunner,
  ServiceFileSystem,
  ServiceHealthState,
  ServiceInstallInput,
  ServiceLifecycleDependencies,
  ServiceManagerState,
  ServiceResult,
  ServiceStatus
} from "./types.ts";

export type ServiceAdapterStatus = {
  installed: boolean;
  state: ServiceManagerState;
  detail?: string;
};

export type BridgeServiceAdapter = {
  manager: BridgeServiceManagerKind;
  definitionPath: string;
  platform: NodeJS.Platform;
  install(input: ServiceInstallInput): Promise<{ changed: boolean }>;
  uninstall(): Promise<{ changed: boolean }>;
  start(): Promise<void>;
  stopOwned(): Promise<void>;
  status(): Promise<ServiceAdapterStatus>;
};

export type ServiceAdapterDependencies = ServiceLifecycleDependencies & {
  commandRunner?: ServiceCommandRunner;
  fileSystem?: ServiceFileSystem;
};

export function createManagedBridgeService(
  adapter: BridgeServiceAdapter,
  dependencies: ServiceLifecycleDependencies
): BridgeServiceManager {
  const sleep = dependencies.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
  const stopTimeoutMs = Math.max(1, dependencies.stopTimeoutMs ?? 8_000);
  const pollIntervalMs = Math.max(1, dependencies.pollIntervalMs ?? 100);
  let installedRuntime: InstalledRuntimeInfo | undefined;

  const status = async (): Promise<ServiceStatus> => {
    const [adapterStatus, health, runtime] = await Promise.all([
      safeAdapterStatus(adapter),
      probeHealthState(dependencies.probeHealth),
      installedRuntime
        ? Promise.resolve(installedRuntime)
        : dependencies.readInstalledRuntime?.().catch(() => undefined) ?? Promise.resolve(undefined)
    ]);
    const authentication = health === "healthy"
      ? await probeAuthenticationState(dependencies.probeAuthenticatedStatus)
      : "unavailable";
    return {
      installed: adapterStatus.installed,
      manager: adapter.manager,
      managerState: adapterStatus.state,
      health,
      authentication,
      definitionPath: adapter.definitionPath,
      packageVersion: runtime?.packageVersion,
      runtimePath: runtime?.runtimePath,
      detail: adapterStatus.detail
    };
  };

  const stop = async (): Promise<ServiceResult> => {
    let shutdownAccepted = false;
    try {
      shutdownAccepted = await dependencies.requestAuthenticatedShutdown();
    } catch (_error) {
      shutdownAccepted = false;
    }

    if (shutdownAccepted) {
      const health = await waitForHealthDown(
        dependencies.probeHealth,
        sleep,
        stopTimeoutMs,
        pollIntervalMs
      );
      if (health === "offline") {
        return success(adapter.manager, "Hunsu Bridge stopped through its authenticated control API.", true);
      }
    }

    try {
      await adapter.stopOwned();
    } catch (_error) {
      return failure(adapter.manager, "SERVICE_STOP_FAILED", "The owned Hunsu Bridge service could not be stopped.");
    }

    const finalHealth = await waitForHealthDown(
      dependencies.probeHealth,
      sleep,
      stopTimeoutMs,
      pollIntervalMs
    );
    if (finalHealth === "healthy") {
      return failure(adapter.manager, "SERVICE_STOP_FAILED", "The owned Hunsu Bridge service stopped, but the Bridge endpoint remained healthy.");
    }
    return success(adapter.manager, "Hunsu Bridge stopped through its OS user service manager.", true);
  };

  const manager: BridgeServiceManager = {
    async install(input) {
      try {
        assertServiceInstallInput(input, adapter.platform);
        const result = await adapter.install(input);
        installedRuntime = {
          packageVersion: input.packageVersion,
          runtimePath: input.runtimePath
        };
        return result.changed
          ? success(adapter.manager, "Hunsu Bridge user service installed. It was not started.", true)
          : success(adapter.manager, "Hunsu Bridge user service is already installed.", false, "SERVICE_ALREADY_INSTALLED");
      } catch (_error) {
        return failure(adapter.manager, "SERVICE_INSTALL_FAILED", "Hunsu Bridge user service installation failed.");
      }
    },
    async uninstall() {
      const current = await safeAdapterStatus(adapter);
      if (!current.installed) {
        return success(adapter.manager, "Hunsu Bridge user service is not installed.", false);
      }
      const stopped = await stop();
      if (!stopped.ok) {
        return failure(adapter.manager, "SERVICE_STOP_FAILED", "Hunsu Bridge must stop before its user service can be uninstalled.");
      }
      try {
        const result = await adapter.uninstall();
        return success(adapter.manager, "Hunsu Bridge user service uninstalled.", result.changed);
      } catch (_error) {
        return failure(adapter.manager, "SERVICE_INSTALL_FAILED", "Hunsu Bridge user service uninstallation failed.");
      }
    },
    async start() {
      const current = await safeAdapterStatus(adapter);
      if (!current.installed) {
        return failure(adapter.manager, "SERVICE_NOT_INSTALLED", "Install the Hunsu Bridge user service before starting it.");
      }
      try {
        await adapter.start();
        return success(adapter.manager, "Hunsu Bridge start requested through its OS user service manager.", true);
      } catch (_error) {
        return failure(adapter.manager, "SERVICE_START_FAILED", "The Hunsu Bridge user service could not be started.");
      }
    },
    stop,
    async restart() {
      const stopped = await stop();
      if (!stopped.ok) {
        return stopped;
      }
      return manager.start();
    },
    status
  };
  return manager;
}

export const defaultServiceFileSystem: ServiceFileSystem = {
  async exists(path) {
    try {
      await access(path);
      return true;
    } catch (_error) {
      return false;
    }
  },
  async readText(path) {
    try {
      return await readFile(path, "utf8");
    } catch (_error) {
      return undefined;
    }
  },
  async mkdir(path, options) {
    await mkdir(path, { recursive: true, mode: options?.mode });
  },
  async writeText(path, text, options) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, text, { encoding: "utf8", mode: options?.mode });
  },
  async remove(path) {
    await rm(path, { force: true });
  }
};

export const defaultServiceCommandRunner: ServiceCommandRunner = command => new Promise(resolve => {
  execFile(command.command, command.args, {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 1024 * 1024
  }, (error, stdout, stderr) => {
    const exitCode = error && "code" in error && typeof error.code === "number" ? error.code : error ? 1 : 0;
    resolve({
      exitCode,
      stdout: stdout ?? "",
      stderr: stderr ?? (error instanceof Error ? error.message : "")
    });
  });
});

export async function writeServiceDefinition(
  fileSystem: ServiceFileSystem,
  path: string,
  text: string
): Promise<boolean> {
  const existing = await fileSystem.readText(path);
  if (existing === text) {
    return false;
  }
  await fileSystem.mkdir(dirname(path), { mode: 0o700 });
  await fileSystem.writeText(path, text, { mode: 0o600 });
  return true;
}

export function assertServiceInstallInput(input: ServiceInstallInput, platform: NodeJS.Platform): void {
  const absolute = platform === "win32" ? win32.isAbsolute : isAbsolute;
  for (const [field, value] of Object.entries({
    nodePath: input.nodePath,
    cliPath: input.cliPath,
    hunsuHome: input.hunsuHome,
    runtimePath: input.runtimePath
  })) {
    if (!value || !absolute(value) || containsControlCharacter(value)) {
      throw new Error(`${field} must be an absolute path without control characters.`);
    }
  }
  if (!input.packageVersion.trim() || containsControlCharacter(input.packageVersion)) {
    throw new Error("packageVersion must be non-empty and contain no control characters.");
  }
}

export function systemdQuote(value: string): string {
  if (containsControlCharacter(value)) {
    throw new Error("systemd values cannot contain control characters.");
  }
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/%/g, "%%")}"`;
}

export function xmlEscape(value: string): string {
  if (containsControlCharacter(value)) {
    throw new Error("plist values cannot contain control characters.");
  }
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function powerShellQuote(value: string): string {
  if (containsControlCharacter(value)) {
    throw new Error("PowerShell values cannot contain control characters.");
  }
  return `'${value.replace(/'/g, "''")}'`;
}

export function windowsArgument(value: string): string {
  if (containsControlCharacter(value) || value.includes('"')) {
    throw new Error("Windows command arguments cannot contain control characters or quotes.");
  }
  return `"${value.replace(/(\\+)$/u, "$1$1")}"`;
}

async function safeAdapterStatus(adapter: BridgeServiceAdapter): Promise<ServiceAdapterStatus> {
  try {
    return await adapter.status();
  } catch (_error) {
    return { installed: false, state: "unknown", detail: "Service-manager status is unavailable." };
  }
}

async function probeHealthState(probe: () => Promise<boolean>): Promise<ServiceHealthState> {
  try {
    return await probe() ? "healthy" : "offline";
  } catch (_error) {
    return "unavailable";
  }
}

async function probeAuthenticationState(
  probe: (() => Promise<AuthenticatedServiceStatus>) | undefined
): Promise<ServiceStatus["authentication"]> {
  if (!probe) {
    return "unavailable";
  }
  try {
    const result = await probe();
    return result.state;
  } catch (_error) {
    return "unavailable";
  }
}

async function waitForHealthDown(
  probe: () => Promise<boolean>,
  sleep: (milliseconds: number) => Promise<void>,
  timeoutMs: number,
  intervalMs: number
): Promise<ServiceHealthState> {
  const attempts = Math.max(1, Math.ceil(timeoutMs / intervalMs));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const health = await probeHealthState(probe);
    if (health !== "healthy") {
      return health;
    }
    if (attempt + 1 < attempts) {
      await sleep(intervalMs);
    }
  }
  return "healthy";
}

function success(
  manager: BridgeServiceManagerKind,
  message: string,
  changed: boolean,
  code: "OK" | "SERVICE_ALREADY_INSTALLED" = "OK"
): ServiceResult {
  return { ok: true, code, message, manager, changed };
}

function failure(
  manager: BridgeServiceManagerKind,
  code: Extract<ServiceResult, { ok: false }>["code"],
  message: string
): ServiceResult {
  return { ok: false, code, message, manager };
}

function containsControlCharacter(value: string): boolean {
  return /[\u0000-\u001f\u007f]/u.test(value);
}

