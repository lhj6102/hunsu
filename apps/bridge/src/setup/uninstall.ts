import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { HunsuPaths } from "../state/paths.ts";
import type { BridgeServiceManager, ServiceErrorCode } from "../service/types.ts";
import {
  createRuntimeInstallStore,
  type RuntimeInstallation,
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
  finalizeOwnedDataDeletion,
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

type RemoveBridgeOperationOutcome = {
  result: RemoveBridgeResult;
  cleanupPlan?: OwnedDataDeletionPlan;
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
  if (input.dryRun) return (await removeBridgeOperation(input, options)).result;
  if (input.deleteData) {
    const preflight = (await removeBridgeOperation({ ...input, dryRun: true }, options)).result;
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

  let outcome: RemoveBridgeOperationOutcome;
  try {
    outcome = await removeBridgeOperation(input, options, true);
  } catch (_error) {
    outcome = { result: runtimeRemovalFailure() };
  }
  try {
    await lease.release();
  } catch (_error) {
    return runtimeRemovalFailure();
  }

  if (!outcome.result.ok) return outcome.result;
  const fileSystem = options.fileSystem ?? defaultOwnedDataFileSystem;
  if (outcome.cleanupPlan) {
    try {
      const finalized = await finalizeOwnedDataDeletion(outcome.cleanupPlan, fileSystem);
      return success({
        removedRuntime: finalized.runtimeDirectoryRemoved,
        deletedData: input.deleteData === true,
        deleted: finalized.deleted,
        preservedUnknownEntries: finalized.preservedUnknownEntries,
        homeDirectoryRemoved: finalized.homeDirectoryRemoved,
        dryRun: false
      });
    } catch (error) {
      if (error instanceof OwnedDataSafetyError && input.deleteData) return dataDeleteRefused(error.message);
      return runtimeRemovalFailure();
    }
  }

  try {
    const homeStats = await fileSystem.lstat(options.paths.home);
    return success({ ...outcome.result.value, homeDirectoryRemoved: homeStats === undefined });
  } catch (_error) {
    return runtimeRemovalFailure();
  }
}

async function removeBridgeOperation(
  input: RemoveBridgeInput,
  options: RemoveBridgeOptions,
  preserveSetupLock = false
): Promise<RemoveBridgeOperationOutcome> {
  if (input.deleteData && input.confirmed !== true) {
    return {
      result: {
        ok: false,
        code: "CONFIRMATION_REQUIRED",
        message: "Deleting Hunsu Bridge data requires explicit confirmation."
      }
    };
  }

  const installStore = options.installStore ?? createRuntimeInstallStore(options.paths);
  const ownershipStore = options.ownershipStore ?? createHomeOwnershipStore(options.paths);
  const fileSystem = options.fileSystem ?? defaultOwnedDataFileSystem;
  let plan: OwnedDataDeletionPlan | undefined;
  let preservedUnknownEntries: string[] = [];
  let homeDirectoryRemoved = true;
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
      homeDirectoryRemoved = false;
      if (input.deleteData) {
        plan = await planOwnedDataDeletion({
          canonicalHome,
          entries: HUNSU_OWNED_HOME_ENTRIES,
          fileSystem,
          userHome: options.userHome,
          currentDirectory: options.currentDirectory
        });
        await verifyDestructiveRemovalOwnership({
          canonicalHome,
          installStore,
          ownershipStore,
          fileSystem
        });
        preservedUnknownEntries = plan.preservedUnknownEntries;
      } else {
        try {
          const preservation = await planOwnedDataDeletion({
            canonicalHome,
            entries: [],
            fileSystem,
            userHome: options.userHome,
            currentDirectory: options.currentDirectory
          });
          preservedUnknownEntries = preservation.preservedUnknownEntries;
        } catch (_error) {
          // Ordinary removal may still uninstall the service, but an
          // uninspectable home never grants permission to delete runtime data.
        }
        try {
          await verifyOrdinaryRuntimeOwnership({ canonicalHome, installStore, fileSystem });
          plan = await planOwnedDataDeletion({
            canonicalHome,
            entries: RUNTIME_ONLY_HOME_ENTRIES,
            fileSystem,
            userHome: options.userHome,
            currentDirectory: options.currentDirectory
          });
          preservedUnknownEntries = plan.preservedUnknownEntries;
        } catch (_error) {
          // Missing, malformed, linked, and mismatched install records all
          // preserve runtime and user data during ordinary removal.
          plan = undefined;
        }
      }
    } else if (input.deleteData) {
      return { result: dataDeleteRefused("Hunsu Bridge refused to delete data because installation ownership is unknown.") };
    }
  } catch (error) {
    if (error instanceof OwnedDataSafetyError || error instanceof HomeOwnershipError || input.deleteData) {
      return {
        result: dataDeleteRefused(
          error instanceof Error
            ? error.message
            : "Hunsu Bridge could not verify ownership of the data directory."
        )
      };
    }
    return { result: runtimeRemovalFailure() };
  }

  if (input.dryRun) {
    return {
      result: success({
        removedRuntime: plan !== undefined,
        deletedData: input.deleteData === true,
        deleted: previewDeletedEntries(plan),
        preservedUnknownEntries,
        homeDirectoryRemoved: plan?.homeDirectoryRemoved ?? homeDirectoryRemoved,
        dryRun: true
      })
    };
  }

  // BridgeServiceManager.uninstall owns the required authenticated-stop then
  // exact OS-service removal sequence. Calling stop separately would perform
  // the fallback twice on managers such as launchd.
  const uninstalled = await options.serviceManager.uninstall();
  if (!uninstalled.ok) {
    return { result: { ok: false, code: uninstalled.code, message: uninstalled.message } };
  }

  try {
    const deletion = plan
      ? await executeOwnedDataDeletion(
        plan,
        fileSystem,
        preserveSetupLock ? { preservePaths: [options.paths.setupLockFile] } : {}
      )
      : { deleted: [], preservedUnknownEntries, homeDirectoryRemoved };
    return {
      result: success({
        removedRuntime: plan !== undefined && !preserveSetupLock,
        deletedData: input.deleteData === true,
        deleted: deletion.deleted,
        preservedUnknownEntries: deletion.preservedUnknownEntries,
        homeDirectoryRemoved: deletion.homeDirectoryRemoved,
        dryRun: false
      }),
      ...(plan && preserveSetupLock ? { cleanupPlan: plan } : {})
    };
  } catch (error) {
    if (error instanceof OwnedDataSafetyError) return { result: dataDeleteRefused(error.message) };
    return { result: runtimeRemovalFailure() };
  }
}

async function verifyOrdinaryRuntimeOwnership(input: {
  canonicalHome: string;
  installStore: RuntimeInstallStore;
  fileSystem: OwnedDataFileSystem;
}): Promise<void> {
  await assertRegularContainedFile({
    canonicalHome: input.canonicalHome,
    path: join(input.canonicalHome, "runtime", "install.json"),
    fileSystem: input.fileSystem
  });
  const installation = await input.installStore.read();
  if (!installation) {
    throw new HomeOwnershipError("Hunsu Bridge runtime ownership could not be established.");
  }
  let installedHome: string;
  try {
    installedHome = await input.fileSystem.realpath(installation.serviceInput.hunsuHome);
  } catch (error) {
    throw new HomeOwnershipError("The installed Hunsu home cannot be verified.", { cause: error });
  }
  if (!sameCanonicalPath(installedHome, input.canonicalHome)) {
    throw new HomeOwnershipError("The installed Hunsu home does not match the configured home.");
  }
  await verifyInstalledRuntimePaths({
    canonicalHome: input.canonicalHome,
    installation,
    fileSystem: input.fileSystem
  });
}

async function verifyInstalledRuntimePaths(input: {
  canonicalHome: string;
  installation: NonNullable<Awaited<ReturnType<RuntimeInstallStore["read"]>>>;
  fileSystem: OwnedDataFileSystem;
}): Promise<void> {
  const lexicalRuntimeRoot = join(input.installation.serviceInput.hunsuHome, "runtime");
  const runtimeRootStats = await input.fileSystem.lstat(lexicalRuntimeRoot);
  if (!runtimeRootStats?.isDirectory() || runtimeRootStats.isSymbolicLink()) {
    throw new HomeOwnershipError("The installed runtime root has an unsafe filesystem type.");
  }

  let canonicalRuntimeRoot: string;
  try {
    canonicalRuntimeRoot = resolve(await input.fileSystem.realpath(lexicalRuntimeRoot));
  } catch (error) {
    throw new HomeOwnershipError("The installed runtime root cannot be verified.", { cause: error });
  }
  if (!pathIsContained(input.canonicalHome, canonicalRuntimeRoot, false)) {
    throw new HomeOwnershipError("The installed runtime root is outside the configured home.");
  }

  await verifyRuntimeInstallationPaths({
    value: input.installation.current,
    lexicalRuntimeRoot,
    canonicalRuntimeRoot,
    fileSystem: input.fileSystem
  });
  if (input.installation.previous) {
    await verifyRuntimeInstallationPaths({
      value: input.installation.previous,
      lexicalRuntimeRoot,
      canonicalRuntimeRoot,
      fileSystem: input.fileSystem
    });
  }

  const serviceInput = input.installation.serviceInput;
  if (!sameCanonicalPath(serviceInput.runtimePath, input.installation.current.runtimePath)
    || !sameCanonicalPath(serviceInput.cliPath, input.installation.current.cliPath)
    || !sameCanonicalPath(serviceInput.nodePath, input.installation.current.nodePath)
    || serviceInput.packageVersion !== input.installation.current.packageVersion) {
    throw new HomeOwnershipError("The installed service paths do not match the current runtime.");
  }
}

async function verifyRuntimeInstallationPaths(input: {
  value: RuntimeInstallation;
  lexicalRuntimeRoot: string;
  canonicalRuntimeRoot: string;
  fileSystem: OwnedDataFileSystem;
}): Promise<void> {
  if (!pathIsContained(input.lexicalRuntimeRoot, input.value.runtimePath, false)
    || !pathIsContained(input.value.runtimePath, input.value.cliPath, false)) {
    throw new HomeOwnershipError("An installed runtime path is outside the Hunsu runtime root.");
  }

  const runtimeStats = await input.fileSystem.lstat(input.value.runtimePath);
  if (!runtimeStats?.isDirectory() || runtimeStats.isSymbolicLink()) {
    throw new HomeOwnershipError("An installed runtime directory has an unsafe filesystem type.");
  }
  const cliStats = await input.fileSystem.lstat(input.value.cliPath);
  if (!cliStats?.isFile() || cliStats.isSymbolicLink()) {
    throw new HomeOwnershipError("An installed runtime CLI has an unsafe filesystem type.");
  }

  let canonicalRuntime: string;
  let canonicalCli: string;
  try {
    canonicalRuntime = resolve(await input.fileSystem.realpath(input.value.runtimePath));
    canonicalCli = resolve(await input.fileSystem.realpath(input.value.cliPath));
  } catch (error) {
    throw new HomeOwnershipError("An installed runtime path cannot be verified.", { cause: error });
  }
  if (!pathIsContained(input.canonicalRuntimeRoot, canonicalRuntime, false)
    || !pathIsContained(canonicalRuntime, canonicalCli, false)) {
    throw new HomeOwnershipError("An installed runtime path resolves outside the Hunsu runtime root.");
  }
}

function pathIsContained(parent: string, child: string, includeParent: boolean): boolean {
  const candidate = relative(resolve(parent), resolve(child));
  if (candidate === "") return includeParent;
  return candidate !== ".." && !candidate.startsWith(`..${sep}`) && !isAbsolute(candidate);
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
        : value.removedRuntime
          ? `Hunsu Bridge runtime removed; config, Workspaces, and credentials were preserved.${unknownSuffix}`
          : `Hunsu Bridge service removed; runtime and user data were preserved because runtime ownership was not verified.${unknownSuffix}`,
    value
  };
}
