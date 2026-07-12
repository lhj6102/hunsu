import { join } from "node:path";
import type { HunsuPaths } from "../state/paths.ts";
import type { BridgeServiceManager, ServiceErrorCode } from "../service/types.ts";
import {
  createRuntimeInstallStore,
  type RuntimeInstallStore
} from "./runtimeInstaller.ts";
import {
  createHomeOwnershipStore,
  HomeOwnershipError,
  sameCanonicalPath,
  type HomeOwnershipStore
} from "./homeOwnership.ts";
import {
  assertRegularContainedFile,
  defaultOwnedDataFileSystem,
  executeOwnedDataDeletion,
  HUNSU_OWNED_HOME_ENTRIES,
  OwnedDataSafetyError,
  planOwnedDataDeletion,
  RUNTIME_ONLY_HOME_ENTRIES,
  type OwnedDataDeletionPlan,
  type OwnedDataFileSystem
} from "./ownedDataRemoval.ts";
import {
  SetupInProgressError,
  acquireSetupOperationLock,
  type SetupOperationLease
} from "./setupTransaction.ts";

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
        deleted: string[];
        preservedUnknownEntries: string[];
        homeDirectoryRemoved: boolean;
        dryRun: boolean;
      };
    }
  | {
      ok: false;
      code: "CONFIRMATION_REQUIRED" | "BRIDGE_DATA_DELETE_REFUSED" | "SETUP_IN_PROGRESS" | ServiceErrorCode | "RUNTIME_INSTALL_FAILED";
      message: string;
    };

export type RemoveBridgeOptions = {
  paths: HunsuPaths;
  serviceManager: BridgeServiceManager;
  fileSystem?: OwnedDataFileSystem;
  installStore?: RuntimeInstallStore;
  ownershipStore?: HomeOwnershipStore;
  userHome?: string;
  currentDirectory?: string;
  acquireOperationLock?: (paths: HunsuPaths) => Promise<SetupOperationLease>;
};

export async function removeBridge(
  input: RemoveBridgeInput,
  options: RemoveBridgeOptions
): Promise<RemoveBridgeResult> {
  if (input.deleteData && input.confirmed !== true) {
    return {
      ok: false,
      code: "CONFIRMATION_REQUIRED",
      message: "Deleting Hunsu Bridge data requires explicit confirmation."
    };
  }
  if (input.dryRun) return removeBridgeOperation(input, options);
  if (input.deleteData) {
    const preflight = await removeBridgeOperation({ ...input, dryRun: true }, options);
    if (!preflight.ok) return preflight;
  }

  let lease: SetupOperationLease;
  try {
    lease = await (options.acquireOperationLock
      ? options.acquireOperationLock(options.paths)
      : acquireSetupOperationLock(options.paths, "remove"));
  } catch (error) {
    if (error instanceof SetupInProgressError) return { ok: false, code: error.code, message: error.message };
    return runtimeRemovalFailure();
  }

  let result: RemoveBridgeResult;
  try {
    result = await removeBridgeOperation(input, options);
  } finally {
    try {
      await lease.release();
    } catch (_error) {
      return runtimeRemovalFailure();
    }
  }
  return result;
}

async function removeBridgeOperation(
  input: RemoveBridgeInput,
  options: RemoveBridgeOptions
): Promise<RemoveBridgeResult> {
  if (input.deleteData && input.confirmed !== true) {
    return {
      ok: false,
      code: "CONFIRMATION_REQUIRED",
      message: "Deleting Hunsu Bridge data requires explicit confirmation."
    };
  }

  const installStore = options.installStore ?? createRuntimeInstallStore(options.paths);
  const ownershipStore = options.ownershipStore ?? createHomeOwnershipStore(options.paths);
  const fileSystem = options.fileSystem ?? defaultOwnedDataFileSystem;
  let plan: OwnedDataDeletionPlan | undefined;
  try {
    const homeStats = await fileSystem.lstat(options.paths.home);
    if (homeStats) {
      if (homeStats.isSymbolicLink()) {
        throw new OwnedDataSafetyError("Hunsu Bridge refuses to remove data through a symbolic-link or junction home.");
      }
      if (!homeStats.isDirectory()) {
        throw new OwnedDataSafetyError("The configured Hunsu home has an unexpected filesystem type.");
      }
      const canonicalHome = await ownershipStore.canonicalHome(false);
      plan = await planOwnedDataDeletion({
        canonicalHome,
        entries: input.deleteData ? HUNSU_OWNED_HOME_ENTRIES : RUNTIME_ONLY_HOME_ENTRIES,
        fileSystem,
        userHome: options.userHome,
        currentDirectory: options.currentDirectory
      });
      if (input.deleteData) {
        await verifyDestructiveRemovalOwnership({
          canonicalHome,
          installStore,
          ownershipStore,
          fileSystem
        });
      }
    } else if (input.deleteData) {
      return dataDeleteRefused("Hunsu Bridge refused to delete data because installation ownership is unknown.");
    }
  } catch (error) {
    if (error instanceof OwnedDataSafetyError || error instanceof HomeOwnershipError || input.deleteData) {
      return dataDeleteRefused(
        error instanceof Error
          ? error.message
          : "Hunsu Bridge could not verify ownership of the data directory."
      );
    }
    return runtimeRemovalFailure();
  }

  if (input.dryRun) {
    return success({
      removedRuntime: true,
      deletedData: input.deleteData === true,
      deleted: previewDeletedEntries(plan),
      preservedUnknownEntries: plan?.preservedUnknownEntries ?? [],
      homeDirectoryRemoved: plan?.homeDirectoryRemoved ?? true,
      dryRun: true
    });
  }

  // BridgeServiceManager.uninstall owns the required authenticated-stop then
  // exact OS-service removal sequence. Calling stop separately would perform
  // the fallback twice on managers such as launchd.
  const uninstalled = await options.serviceManager.uninstall();
  if (!uninstalled.ok) return { ok: false, code: uninstalled.code, message: uninstalled.message };

  try {
    const deletion = plan
      ? await executeOwnedDataDeletion(plan, fileSystem)
      : { deleted: [], preservedUnknownEntries: [], homeDirectoryRemoved: true };
    return success({
      removedRuntime: true,
      deletedData: input.deleteData === true,
      deleted: deletion.deleted,
      preservedUnknownEntries: deletion.preservedUnknownEntries,
      homeDirectoryRemoved: deletion.homeDirectoryRemoved,
      dryRun: false
    });
  } catch (error) {
    if (error instanceof OwnedDataSafetyError) return dataDeleteRefused(error.message);
    return runtimeRemovalFailure();
  }
}

async function verifyDestructiveRemovalOwnership(input: {
  canonicalHome: string;
  installStore: RuntimeInstallStore;
  ownershipStore: HomeOwnershipStore;
  fileSystem: OwnedDataFileSystem;
}): Promise<void> {
  await assertRegularContainedFile({
    canonicalHome: input.canonicalHome,
    path: join(input.canonicalHome, "runtime", "install.json"),
    fileSystem: input.fileSystem
  });
  const installation = await input.installStore.read();
  if (!installation?.installationId) {
    throw new HomeOwnershipError("Hunsu Bridge refused to delete data because installation ownership is unknown.");
  }
  const marker = await input.ownershipStore.read();
  if (!marker) {
    throw new HomeOwnershipError("Hunsu Bridge refused to delete data because the ownership marker is missing.");
  }
  if (marker.installationId !== installation.installationId) {
    throw new HomeOwnershipError("Hunsu Bridge refused to delete data because the installation identity does not match.");
  }
  if (!sameCanonicalPath(marker.home, input.canonicalHome)) {
    throw new HomeOwnershipError("Hunsu Bridge refused to delete data because the canonical home does not match.");
  }
  let installedHome: string;
  try {
    installedHome = await input.fileSystem.realpath(installation.serviceInput.hunsuHome);
  } catch (error) {
    throw new HomeOwnershipError("Hunsu Bridge refused to delete data because the installed home cannot be verified.", { cause: error });
  }
  if (!sameCanonicalPath(installedHome, input.canonicalHome)) {
    throw new HomeOwnershipError("Hunsu Bridge refused to delete data because the installed home does not match.");
  }
}

function previewDeletedEntries(plan: OwnedDataDeletionPlan | undefined): string[] {
  return plan?.existingEntries.filter(name => name !== ".hunsu-bridge-home.json") ?? [];
}

function dataDeleteRefused(message: string): RemoveBridgeResult {
  return { ok: false, code: "BRIDGE_DATA_DELETE_REFUSED", message };
}

function runtimeRemovalFailure(): RemoveBridgeResult {
  return {
    ok: false,
    code: "RUNTIME_INSTALL_FAILED",
    message: "Hunsu Bridge runtime files could not be removed safely."
  };
}

function success(value: Extract<RemoveBridgeResult, { ok: true }>["value"]): RemoveBridgeResult {
  const unknownSuffix = value.preservedUnknownEntries.length > 0
    ? ` ${value.preservedUnknownEntries.length} unknown home entries were preserved.`
    : "";
  return {
    ok: true,
    code: "OK",
    message: value.dryRun
      ? `Hunsu Bridge removal dry run completed.${unknownSuffix}`
      : value.deletedData
        ? `Hunsu Bridge and its owned user data were removed.${unknownSuffix}`
        : `Hunsu Bridge runtime removed; config, Workspaces, and credentials were preserved.${unknownSuffix}`,
    value
  };
}
