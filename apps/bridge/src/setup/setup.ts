import type { CredentialStore } from "../state/credentialStore.ts";
import type { HunsuPaths } from "../state/paths.ts";
import type { BridgeServiceManager, ServiceErrorCode, ServiceInstallInput, ServiceResult } from "../service/types.ts";
import {
  BRIDGE_PACKAGE_VERSION,
  RUNTIME_INSTALL_SCHEMA,
  createRuntimeInstallStore,
  defaultRuntimeFileSystem,
  installStableRuntime,
  planStableRuntimeInstall,
  serviceInputForInstallation,
  type RuntimeCommand,
  type RuntimeCommandRunner,
  type RuntimeFileSystem,
  type RuntimeInstallDocument,
  type RuntimeInstallation,
  type RuntimeInstallStore,
  type StableRuntimePlan
} from "./runtimeInstaller.ts";

export const MINIMUM_NODE_VERSION = Object.freeze({ major: 22, minor: 18, patch: 0 });

export type SetupVerification = {
  health: boolean;
  authenticated: boolean;
  version?: string;
};

export type SetupErrorCode =
  | "NODE_VERSION_UNSUPPORTED"
  | "RUNTIME_INSTALL_FAILED"
  | "SETUP_VERIFICATION_FAILED"
  | "ROLLBACK_FAILED"
  | ServiceErrorCode;

export type SetupResult =
  | {
      ok: true;
      code: "OK";
      message: string;
      value: {
        packageVersion: typeof BRIDGE_PACKAGE_VERSION;
        runtimePath: string;
        cliPath: string;
        npmCommand: RuntimeCommand;
        idempotent: boolean;
        upgraded: boolean;
        started: boolean;
        dryRun: boolean;
        commands: {
          status: string;
          doctor: string;
          remove: string;
        };
      };
    }
  | {
      ok: false;
      code: SetupErrorCode;
      message: string;
    };

export type BridgeSetupOptions = {
  paths: HunsuPaths;
  credentialStore: Pick<CredentialStore, "ensure">;
  serviceManager: BridgeServiceManager;
  verifyRuntime: (installation: RuntimeInstallation) => Promise<SetupVerification>;
  installStore?: RuntimeInstallStore;
  fileSystem?: RuntimeFileSystem;
  npmRunner?: RuntimeCommandRunner;
  npmCommand?: string;
  nodePath?: string;
  nodeVersion?: string;
  platform?: NodeJS.Platform;
  now?: () => Date;
  dryRun?: boolean;
};

export async function setupBridge(options: BridgeSetupOptions): Promise<SetupResult> {
  const nodeVersion = options.nodeVersion ?? process.version;
  if (!nodeVersionIsSupported(nodeVersion)) {
    return failure("NODE_VERSION_UNSUPPORTED", "Hunsu Bridge requires Node 22.18 or newer.");
  }

  let plan: StableRuntimePlan;
  try {
    plan = planStableRuntimeInstall({
      paths: options.paths,
      nodePath: options.nodePath ?? process.execPath,
      platform: options.platform,
      npmCommand: options.npmCommand
    });
  } catch (_error) {
    return failure("RUNTIME_INSTALL_FAILED", "Hunsu Bridge requires an absolute Node executable path.");
  }

  if (options.dryRun) {
    return success(plan, {
      idempotent: false,
      upgraded: false,
      started: false,
      dryRun: true
    });
  }

  const installStore = options.installStore ?? createRuntimeInstallStore(options.paths);
  const fileSystem = options.fileSystem ?? defaultRuntimeFileSystem;
  let existing: RuntimeInstallDocument | undefined;
  try {
    existing = await installStore.read();
  } catch (_error) {
    return failure("RUNTIME_INSTALL_FAILED", "The installed Hunsu Bridge runtime record is invalid.");
  }

  const sameRuntimeReady = existing !== undefined
    && existing.current.packageVersion === BRIDGE_PACKAGE_VERSION
    && existing.current.runtimePath === plan.runtimePath
    && existing.current.cliPath === plan.cliPath
    && await fileSystem.exists(plan.cliPath);

  if (sameRuntimeReady && existing) {
    return reconcileSameVersion(options, plan, existing, installStore);
  }

  let candidate: RuntimeInstallation;
  try {
    candidate = await installStableRuntime({
      plan,
      commandRunner: options.npmRunner,
      fileSystem,
      now: options.now
    });
  } catch (_error) {
    return failure("RUNTIME_INSTALL_FAILED", "The exact Hunsu Bridge runtime package could not be installed.");
  }

  try {
    await options.credentialStore.ensure();
  } catch (_error) {
    return failure("RUNTIME_INSTALL_FAILED", "Hunsu Bridge credentials could not be created or preserved.");
  }

  const upgraded = Boolean(existing && existing.current.packageVersion !== candidate.packageVersion);
  if (upgraded) {
    const stopped = await options.serviceManager.stop();
    if (!stopped.ok) return serviceFailure(stopped);
  }

  const candidateServiceInput = serviceInputForInstallation(candidate, options.paths.home);
  const installed = await options.serviceManager.install(candidateServiceInput);
  if (!installed.ok) {
    if (existing) {
      return rollbackAfterFailure(options, existing, "The candidate Hunsu Bridge service definition could not be installed.");
    }
    return serviceFailure(installed);
  }
  const started = await options.serviceManager.start();
  if (!started.ok) {
    if (existing) return rollbackAfterFailure(options, existing, "The candidate Hunsu Bridge service could not start.");
    return serviceFailure(started);
  }

  const verification = await safeVerify(options.verifyRuntime, candidate);
  if (!verificationSucceeded(verification, candidate.packageVersion)) {
    if (existing) return rollbackAfterFailure(options, existing, "The candidate Hunsu Bridge runtime failed verification.");
    await options.serviceManager.uninstall().catch(() => undefined);
    return failure("SETUP_VERIFICATION_FAILED", "The candidate Hunsu Bridge runtime failed health or authenticated status verification.");
  }

  const document = nextInstallDocument(candidate, existing?.current ?? null, candidateServiceInput, options.now);
  try {
    await installStore.write(document);
  } catch (_error) {
    if (existing) return rollbackAfterFailure(options, existing, "The verified runtime record could not be persisted.");
    return failure("RUNTIME_INSTALL_FAILED", "The verified Hunsu Bridge runtime record could not be persisted.");
  }

  return success(plan, {
    idempotent: false,
    upgraded,
    started: true,
    dryRun: false
  });
}

export function nodeVersionIsSupported(version: string): boolean {
  const match = version.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/u);
  if (!match) return false;
  const [, majorText, minorText, patchText] = match;
  const current = [Number(majorText), Number(minorText), Number(patchText)];
  const minimum = [MINIMUM_NODE_VERSION.major, MINIMUM_NODE_VERSION.minor, MINIMUM_NODE_VERSION.patch];
  for (let index = 0; index < minimum.length; index += 1) {
    if (current[index]! > minimum[index]!) return true;
    if (current[index]! < minimum[index]!) return false;
  }
  return true;
}

async function reconcileSameVersion(
  options: BridgeSetupOptions,
  plan: StableRuntimePlan,
  existing: RuntimeInstallDocument,
  installStore: RuntimeInstallStore
): Promise<SetupResult> {
  try {
    await options.credentialStore.ensure();
  } catch (_error) {
    return failure("RUNTIME_INSTALL_FAILED", "Hunsu Bridge credentials could not be preserved.");
  }

  const current: RuntimeInstallation = {
    ...existing.current,
    nodePath: plan.nodePath,
    runtimePath: plan.runtimePath,
    cliPath: plan.cliPath
  };
  const serviceInput = serviceInputForInstallation(current, options.paths.home);
  const installed = await options.serviceManager.install(serviceInput);
  if (!installed.ok) return serviceFailure(installed);
  const status = await options.serviceManager.status();
  let started = false;
  if (installed.changed && (status.managerState === "running" || status.health === "healthy")) {
    const restarted = await options.serviceManager.restart();
    if (!restarted.ok) return serviceFailure(restarted);
    started = true;
  } else if (status.managerState !== "running" && status.health !== "healthy") {
    const startResult = await options.serviceManager.start();
    if (!startResult.ok) return serviceFailure(startResult);
    started = true;
  }

  const verification = await safeVerify(options.verifyRuntime, current);
  if (!verificationSucceeded(verification, current.packageVersion)) {
    return failure("SETUP_VERIFICATION_FAILED", "The installed Hunsu Bridge runtime failed health or authenticated status verification.");
  }

  const nextDocument: RuntimeInstallDocument = {
    ...existing,
    current,
    serviceInput,
    updatedAt: (options.now ?? (() => new Date()))().toISOString()
  };
  try {
    await installStore.write(nextDocument);
  } catch (_error) {
    return failure("RUNTIME_INSTALL_FAILED", "The Hunsu Bridge runtime record could not be refreshed.");
  }
  return success(plan, {
    idempotent: true,
    upgraded: false,
    started,
    dryRun: false
  });
}

async function rollbackAfterFailure(
  options: BridgeSetupOptions,
  previousDocument: RuntimeInstallDocument,
  reason: string
): Promise<SetupResult> {
  const previous = previousDocument.current;
  const previousServiceInput = previousDocument.serviceInput;
  const stopped = await options.serviceManager.stop();
  if (!stopped.ok) return failure("ROLLBACK_FAILED", "The failed candidate could not be stopped for rollback.");
  const restored = await options.serviceManager.install(previousServiceInput);
  if (!restored.ok) return failure("ROLLBACK_FAILED", "The previous Hunsu Bridge service definition could not be restored.");
  const restarted = await options.serviceManager.start();
  if (!restarted.ok) return failure("ROLLBACK_FAILED", "The previous Hunsu Bridge runtime could not be restarted.");
  const verification = await safeVerify(options.verifyRuntime, previous);
  if (!verificationSucceeded(verification, previous.packageVersion)) {
    return failure("ROLLBACK_FAILED", "The previous Hunsu Bridge runtime failed rollback verification.");
  }
  return failure("SETUP_VERIFICATION_FAILED", `${reason} The previous runtime was restored.`);
}

function nextInstallDocument(
  current: RuntimeInstallation,
  previous: RuntimeInstallation | null,
  serviceInput: ServiceInstallInput,
  now: (() => Date) | undefined
): RuntimeInstallDocument {
  return {
    schema: RUNTIME_INSTALL_SCHEMA,
    current,
    previous,
    serviceInput,
    updatedAt: (now ?? (() => new Date()))().toISOString()
  };
}

async function safeVerify(
  verify: BridgeSetupOptions["verifyRuntime"],
  installation: RuntimeInstallation
): Promise<SetupVerification> {
  try {
    return await verify(installation);
  } catch (_error) {
    return { health: false, authenticated: false, version: "unavailable" };
  }
}

function verificationSucceeded(verification: SetupVerification, expectedVersion: string): boolean {
  return verification.health
    && verification.authenticated
    && verification.version === expectedVersion;
}

function serviceFailure(result: Extract<ServiceResult, { ok: false }>): SetupResult {
  return failure(result.code, result.message);
}

function success(
  plan: StableRuntimePlan,
  state: Pick<Extract<SetupResult, { ok: true }>["value"], "idempotent" | "upgraded" | "started" | "dryRun">
): SetupResult {
  return {
    ok: true,
    code: "OK",
    message: state.dryRun
      ? "Hunsu Bridge setup dry run completed."
      : state.idempotent
        ? "Hunsu Bridge is already installed and verified."
        : "Hunsu Bridge installed and verified.",
    value: {
      packageVersion: BRIDGE_PACKAGE_VERSION,
      runtimePath: plan.runtimePath,
      cliPath: plan.cliPath,
      npmCommand: plan.npmCommand,
      commands: {
        status: "npx @hunsu/bridge@next status",
        doctor: "npx @hunsu/bridge@next doctor",
        remove: "npx @hunsu/bridge@next remove"
      },
      ...state
    }
  };
}

function failure(code: SetupErrorCode, message: string): SetupResult {
  return { ok: false, code, message };
}
