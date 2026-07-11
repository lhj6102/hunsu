import { homedir } from "node:os";
import { parse, relative, resolve } from "node:path";
import type { HunsuPaths } from "../state/paths.ts";
import type { BridgeServiceManager, ServiceErrorCode } from "../service/types.ts";
import {
  createRuntimeInstallStore,
  defaultRuntimeFileSystem,
  type RuntimeFileSystem,
  type RuntimeInstallStore
} from "./runtimeInstaller.ts";

export type RemoveBridgeInput = {
  deleteData?: boolean;
  confirmed?: boolean;
  dryRun?: boolean;
};

export type RemoveBridgeResult =
  | {
      ok: true;
      code: "OK";
      message: string;
      value: {
        removedRuntime: boolean;
        deletedData: boolean;
        preserved: string[];
        dryRun: boolean;
      };
    }
  | {
      ok: false;
      code: "CONFIRMATION_REQUIRED" | ServiceErrorCode | "RUNTIME_INSTALL_FAILED";
      message: string;
    };

export async function removeBridge(input: RemoveBridgeInput, options: {
  paths: HunsuPaths;
  serviceManager: BridgeServiceManager;
  fileSystem?: RuntimeFileSystem;
  installStore?: RuntimeInstallStore;
}): Promise<RemoveBridgeResult> {
  if (input.deleteData && input.confirmed !== true) {
    return {
      ok: false,
      code: "CONFIRMATION_REQUIRED",
      message: "Deleting Hunsu Bridge data requires explicit confirmation."
    };
  }

  const preserved = input.deleteData
    ? []
    : [options.paths.configFile, options.paths.workspacesFile, options.paths.credentialsFile];
  if (input.dryRun) {
    return success({
      removedRuntime: true,
      deletedData: input.deleteData === true,
      preserved,
      dryRun: true
    });
  }

  const installStore = options.installStore ?? createRuntimeInstallStore(options.paths);
  if (input.deleteData) {
    try {
      const installation = await installStore.read();
      if (!installation || !samePath(installation.serviceInput.hunsuHome, options.paths.home)) {
        return {
          ok: false,
          code: "RUNTIME_INSTALL_FAILED",
          message: "Hunsu Bridge refused to delete data without a matching verified runtime record."
        };
      }
      if (!safeDataRoot(options.paths.home)) {
        return {
          ok: false,
          code: "RUNTIME_INSTALL_FAILED",
          message: "Hunsu Bridge refused to delete data from a protected filesystem location."
        };
      }
    } catch (_error) {
      return {
        ok: false,
        code: "RUNTIME_INSTALL_FAILED",
        message: "Hunsu Bridge could not verify the data directory before removal."
      };
    }
  }

  // BridgeServiceManager.uninstall owns the required authenticated-stop then
  // exact OS-service removal sequence. Calling stop separately would perform
  // the fallback twice on managers such as launchd.
  const uninstalled = await options.serviceManager.uninstall();
  if (!uninstalled.ok) return { ok: false, code: uninstalled.code, message: uninstalled.message };

  const fileSystem = options.fileSystem ?? defaultRuntimeFileSystem;
  try {
    await installStore.clear();
    if (input.deleteData) {
      await fileSystem.remove(options.paths.home);
    } else {
      await fileSystem.remove(options.paths.runtimeDirectory);
      await fileSystem.remove(options.paths.runtimeFile);
    }
  } catch (_error) {
    return {
      ok: false,
      code: "RUNTIME_INSTALL_FAILED",
      message: "Hunsu Bridge runtime files could not be removed safely."
    };
  }

  return success({
    removedRuntime: true,
    deletedData: input.deleteData === true,
    preserved,
    dryRun: false
  });
}

function safeDataRoot(value: string): boolean {
  const target = resolve(value);
  if (samePath(target, parse(target).root) || samePath(target, homedir())) return false;
  return !containsPath(target, process.cwd());
}

function containsPath(parent: string, child: string): boolean {
  const candidate = relative(resolve(parent), resolve(child));
  return candidate === "" || (!candidate.startsWith("..") && !parse(candidate).root);
}

function samePath(left: string, right: string): boolean {
  const resolvedLeft = resolve(left);
  const resolvedRight = resolve(right);
  return process.platform === "win32"
    ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
    : resolvedLeft === resolvedRight;
}

function success(value: Extract<RemoveBridgeResult, { ok: true }>["value"]): RemoveBridgeResult {
  return {
    ok: true,
    code: "OK",
    message: value.dryRun
      ? "Hunsu Bridge removal dry run completed."
      : value.deletedData
        ? "Hunsu Bridge and its user data were removed."
        : "Hunsu Bridge runtime removed; config, Workspaces, and credentials were preserved.",
    value
  };
}
