import { createLinuxSystemdUserServiceManager, type LinuxSystemdUserOptions } from "./linuxSystemdUser.ts";
import { createMacosLaunchAgentServiceManager, type MacosLaunchAgentOptions } from "./macosLaunchAgent.ts";
import type { BridgeServiceManager } from "./types.ts";
import { createWindowsTaskSchedulerServiceManager, type WindowsTaskSchedulerOptions } from "./windowsTaskScheduler.ts";

export type BridgeServiceManagerOptions = {
  platform?: NodeJS.Platform;
  linux?: LinuxSystemdUserOptions;
  macos?: MacosLaunchAgentOptions;
  windows?: WindowsTaskSchedulerOptions;
};

export function createBridgeServiceManager(options: BridgeServiceManagerOptions): BridgeServiceManager {
  const platform = options.platform ?? process.platform;
  if (platform === "linux" && options.linux) {
    return createLinuxSystemdUserServiceManager(options.linux);
  }
  if (platform === "darwin" && options.macos) {
    return createMacosLaunchAgentServiceManager(options.macos);
  }
  if (platform === "win32" && options.windows) {
    return createWindowsTaskSchedulerServiceManager(options.windows);
  }
  throw new Error(`Hunsu Bridge does not have a configured user service manager for ${platform}.`);
}

export type {
  AuthenticatedServiceStatus,
  BridgeServiceManager,
  BridgeServiceManagerKind,
  InstalledRuntimeInfo,
  ServiceAuthenticationState,
  ServiceCommand,
  ServiceCommandResult,
  ServiceCommandRunner,
  ServiceErrorCode,
  ServiceFileSystem,
  ServiceHealthState,
  ServiceInstallInput,
  ServiceLifecycleDependencies,
  ServiceManagerState,
  ServiceResult,
  ServiceStatus
} from "./types.ts";

