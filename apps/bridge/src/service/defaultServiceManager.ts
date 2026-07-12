import { homedir } from "node:os";
import type { BridgeControlClient } from "../client/controlClient.ts";
import type { HunsuPaths } from "../state/index.ts";
import { createRuntimeInstallStore } from "../setup/runtimeInstaller.ts";
import { createBridgeServiceManager } from "./serviceManager.ts";
import type { BridgeServiceManager, ServiceLifecycleDependencies } from "./types.ts";

export function createDefaultBridgeServiceManager(input: {
  paths: HunsuPaths;
  controlClient: BridgeControlClient;
  processEnv: Readonly<Record<string, string | undefined>>;
  platform?: NodeJS.Platform;
  userHome?: string;
}): BridgeServiceManager {
  const platform = input.platform ?? process.platform;
  const dependencies: ServiceLifecycleDependencies = {
    requestAuthenticatedShutdown: async () => (await input.controlClient.request("/v1/control/shutdown", { method: "POST" })).ok,
    probeHealth: async () => (await input.controlClient.health()) !== undefined,
    probeAuthenticatedStatus: async () => {
      const result = await input.controlClient.request("/v1/control/status");
      return result.ok
        ? { state: "authenticated", value: result.value }
        : result.code === "BRIDGE_CONTROL_UNAUTHORIZED"
          ? { state: "unauthorized" }
          : { state: "unavailable" };
    },
    readInstalledRuntime: async () => {
      const install = await createRuntimeInstallStore(input.paths).read();
      return install ? {
        packageVersion: install.current.packageVersion,
        runtimePath: install.current.runtimePath,
        deploymentProfile: install.serviceInput.deploymentProfile
      } : undefined;
    }
  };
  const userHome = input.userHome ?? homedir();
  return createBridgeServiceManager({
    platform,
    ...(platform === "linux" ? { linux: { ...dependencies, homeDirectory: userHome } } : {}),
    ...(platform === "darwin" ? { macos: { ...dependencies, homeDirectory: userHome } } : {}),
    ...(platform === "win32" ? { windows: { ...dependencies, processEnv: input.processEnv } } : {})
  });
}
