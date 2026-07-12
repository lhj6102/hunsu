import { randomUUID } from "node:crypto";
import {
  bridgeSetupPackageTag,
  isBridgeDeploymentProfile,
  type BridgeDeploymentProfile
} from "../deploymentProfile.ts";
import type { BridgeServiceManager, ServiceErrorCode, ServiceInstallInput, ServiceResult } from "../service/types.ts";
import { createConfigStore, type ConfigStore } from "../state/configStore.ts";
import type { CredentialStore } from "../state/credentialStore.ts";
import type { HunsuPaths } from "../state/paths.ts";
import {
  createHomeOwnershipStore,
  ensureHomeOwnership,
  type HomeOwnershipStore
} from "./homeOwnership.ts";
import {
  BRIDGE_PACKAGE_VERSION,
  RUNTIME_INSTALL_SCHEMA,
  createRuntimeInstallStore,
  serviceInputForInstallation,
  type RuntimeInstallDocument,
  type RuntimeInstallation,
  type RuntimeInstallStore,
  type VerifiedRuntimeInstallation
} from "./runtimeInstaller.ts";
import {
  executingBridgeRuntimeSource,
  type RuntimePackageSource
} from "./runtimePackageSource.ts";
import {
  StagedRuntimeCleanupError,
  installStagedRuntime,
  planStagedRuntimeInstall,
  removeCandidateRuntime,
  verifyExistingStableRuntime,
  type StagedRuntimeCommand,
  type StagedRuntimeCommandRunner,
  type StagedRuntimeFileSystem,
  type StagedRuntimePlan
} from "./stagedRuntimeInstaller.ts";
import {
  SETUP_TRANSACTION_SCHEMA,
  SetupInProgressError,
  acquireSetupOperationLock,
  createSetupTransactionStore,
  type SetupOperationLease,
  type SetupTransaction,
  type SetupTransactionPhase,
  type SetupTransactionStore
} from "./setupTransaction.ts";

export const MINIMUM_NODE_VERSION = Object.freeze({ major: 24, minor: 18, patch: 0 });

export type SetupVerification = {
  health: boolean;
  authenticated: boolean;
  version: string;
  runtimePath: string;
  deploymentProfile: BridgeDeploymentProfile;
};

export type SetupFailurePhase =
  | "profile-persistence"
  | "ownership-marker"
  | "credential-ensure"
  | "npm-install"
  | "candidate-verification"
  | "staging-rename"
  | "transaction-write"
  | "previous-service-stop"
  | "service-definition-install"
  | "service-start"
  | "health-verification"
  | "authentication-verification"
  | "version-verification"
  | "profile-verification"
  | "install-record-commit"
  | "candidate-service-cleanup"
  | "candidate-runtime-cleanup"
  | "previous-definition-restore"
  | "previous-runtime-restart";

export type SetupErrorCode =
  | "NODE_VERSION_UNSUPPORTED"
  | "RUNTIME_INSTALL_FAILED"
  | "SETUP_IN_PROGRESS"
  | "SETUP_VERIFICATION_FAILED"
  | "ROLLBACK_FAILED"
  | ServiceErrorCode;

export type SetupResult =
  | {
      ok: true;
      code: "OK";
      message: string;
      value: {
        packageVersion: string;
        deploymentProfile: BridgeDeploymentProfile;
        runtimePath: string;
        cliPath: string;
        npmCommand: StagedRuntimeCommand;
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
  deploymentProfile?: BridgeDeploymentProfile;
  configStore?: Pick<ConfigStore, "ensureDeploymentProfile">;
  credentialStore: Pick<CredentialStore, "ensure">;
  serviceManager: BridgeServiceManager;
  verifyRuntime: (installation: RuntimeInstallation) => Promise<SetupVerification>;
  runtimeSource?: RuntimePackageSource;
  installStore?: RuntimeInstallStore;
  transactionStore?: SetupTransactionStore;
  ownershipStore?: HomeOwnershipStore;
  stagedFileSystem?: StagedRuntimeFileSystem;
  npmRunner?: StagedRuntimeCommandRunner;
  npmCommand?: string;
  processEnv?: Readonly<Record<string, string | undefined>>;
  nodePath?: string;
  nodeVersion?: string;
  platform?: NodeJS.Platform;
  now?: () => Date;
  createInstallationId?: () => string;
  createTransactionId?: () => string;
  acquireOperationLock?: (paths: HunsuPaths) => Promise<SetupOperationLease>;
  onPhase?: (phase: SetupFailurePhase) => void | Promise<void>;
  dryRun?: boolean;
};

type SetupAbort = {
  code: SetupErrorCode;
  message: string;
};

export async function setupBridge(options: BridgeSetupOptions): Promise<SetupResult> {
  const deploymentProfile = options.deploymentProfile ?? "production";
  if (!isBridgeDeploymentProfile(deploymentProfile)) {
    return failure("RUNTIME_INSTALL_FAILED", "Bridge deployment profile must be production or preview.");
  }
  const nodeVersion = options.nodeVersion ?? process.version;
  if (!nodeVersionIsSupported(nodeVersion)) {
    return failure("NODE_VERSION_UNSUPPORTED", "Hunsu Bridge requires Node 24.18 or newer.");
  }

  const transactionId = options.createTransactionId?.() ?? `setup_${randomUUID()}`;
  let plan: StagedRuntimePlan;
  try {
    plan = planStagedRuntimeInstall({
      paths: options.paths,
      transactionId,
      nodePath: options.nodePath ?? process.execPath,
      source: options.runtimeSource ?? executingBridgeRuntimeSource(),
      ...(options.npmCommand ? { npmCommand: options.npmCommand } : {}),
      ...(options.platform ? { platform: options.platform } : {})
    });
  } catch (_error) {
    return failure("RUNTIME_INSTALL_FAILED", "The exact Hunsu Bridge runtime source or executable path is invalid.");
  }

  if (options.dryRun) {
    return success(plan, deploymentProfile, {
      idempotent: false,
      upgraded: false,
      started: false,
      dryRun: true
    });
  }

  let lease: SetupOperationLease;
  try {
    lease = await (options.acquireOperationLock
      ? options.acquireOperationLock(options.paths)
      : acquireSetupOperationLock(options.paths, "setup", options.now ? { now: options.now } : {}));
  } catch (error) {
    if (error instanceof SetupInProgressError) return failure(error.code, error.message);
    return failure("RUNTIME_INSTALL_FAILED", "The Bridge setup lock could not be acquired safely.");
  }

  let result: SetupResult;
  try {
    result = await setupWhileLocked(options, plan, nodeVersion, deploymentProfile);
  } catch (_error) {
    result = failure("RUNTIME_INSTALL_FAILED", "Hunsu Bridge setup failed unexpectedly before activation.");
  }
  try {
    await lease.release();
  } catch (_error) {
    return failure(
      "ROLLBACK_FAILED",
      "Bridge setup finished but its operation lock could not be released; run `hunsu-bridge doctor --json` before retrying."
    );
  }
  return result;
}

async function setupWhileLocked(
  options: BridgeSetupOptions,
  plan: StagedRuntimePlan,
  nodeVersion: string,
  deploymentProfile: BridgeDeploymentProfile
): Promise<SetupResult> {
  const installStore = options.installStore ?? createRuntimeInstallStore(options.paths);
  const transactionStore = options.transactionStore ?? createSetupTransactionStore(options.paths);
  const ownershipStore = options.ownershipStore ?? createHomeOwnershipStore(options.paths, {
    ...(options.platform ? { platform: options.platform } : {}),
    ...(options.processEnv ? { processEnv: options.processEnv } : {})
  });
  const now = options.now ?? (() => new Date());

  try {
    await runPhase(options, "profile-persistence");
    await (options.configStore ?? createConfigStore(options.paths)).ensureDeploymentProfile(deploymentProfile);
  } catch (_error) {
    return failure(
      "RUNTIME_INSTALL_FAILED",
      `HUNSU_HOME is already bound to a different Bridge deployment profile; use a clean home for ${deploymentProfile}.`
    );
  }

  let pending: SetupTransaction | undefined;
  try {
    pending = await transactionStore.read();
  } catch (_error) {
    return failure("RUNTIME_INSTALL_FAILED", "The pending Bridge setup transaction is invalid.");
  }
  if (pending) {
    const recovered = await compensateTransaction({
      options,
      transaction: pending,
      transactionStore,
      installStore,
      installationId: pending.previous?.installationId ?? null
    });
    if (!recovered.ok) return rollbackFailure(recovered.failures);
  }

  let existing: RuntimeInstallDocument | undefined;
  try {
    existing = await installStore.read();
  } catch (_error) {
    return failure("RUNTIME_INSTALL_FAILED", "The installed Hunsu Bridge runtime record is invalid.");
  }
  if (existing && existing.serviceInput.deploymentProfile !== deploymentProfile) {
    return failure(
      "RUNTIME_INSTALL_FAILED",
      `The installed Bridge runtime is ${existing.serviceInput.deploymentProfile} and cannot switch to ${deploymentProfile} in the same HUNSU_HOME.`
    );
  }

  let installationId: string;
  try {
    await runPhase(options, "ownership-marker");
    const marker = await ensureHomeOwnership({
      store: ownershipStore,
      ...(existing?.installationId ? { expectedInstallationId: existing.installationId } : {}),
      ...(options.now ? { now: options.now } : {}),
      ...(options.createInstallationId ? { createInstallationId: options.createInstallationId } : {})
    });
    installationId = marker.installationId;
  } catch (_error) {
    return failure("RUNTIME_INSTALL_FAILED", "The Hunsu home ownership marker could not be created or verified.");
  }

  try {
    await runPhase(options, "credential-ensure");
    await options.credentialStore.ensure();
  } catch (_error) {
    return failure("RUNTIME_INSTALL_FAILED", "Hunsu Bridge credentials could not be created or preserved.");
  }

  let candidate: VerifiedRuntimeInstallation | undefined;
  let transaction: SetupTransaction | undefined;
  let reusedStableRuntime = false;
  let replacedRecordedRuntime = false;
  try {
    if (existing
      && existing.current.packageVersion === plan.packageVersion
      && samePath(existing.current.runtimePath, plan.runtimePath)
      && samePath(existing.current.cliPath, plan.cliPath)) {
      try {
        const verified = await verifyExistingStableRuntime({
          plan,
          ...(options.stagedFileSystem ? { fileSystem: options.stagedFileSystem } : {}),
          nodeVersion
        });
        if (existing.current.cliSha256 !== null
          && existing.current.cliSha256 === verified.cliSha256) {
          candidate = {
            ...existing.current,
            nodePath: plan.nodePath,
            runtimePath: plan.runtimePath,
            cliPath: plan.cliPath,
            cliSha256: verified.cliSha256
          };
          reusedStableRuntime = true;
        }
      } catch (_error) {
        // A recorded same-version runtime is protected from automatic deletion;
        // the staged installer below will fail closed with repair guidance.
      }
    }

    if (!candidate) {
      const staged = await installStagedRuntime({
        plan,
        ...(options.npmRunner ? { commandRunner: options.npmRunner } : {}),
        ...(options.processEnv ? { processEnv: options.processEnv } : {}),
        ...(options.stagedFileSystem ? { fileSystem: options.stagedFileSystem } : {}),
        ...(options.now ? { now: options.now } : {}),
        nodeVersion,
        ...(existing ? { protectedRuntimePath: existing.current.runtimePath } : {}),
        onPhase: phase => runPhase(options, phase)
      });
      candidate = staged.installation;
      reusedStableRuntime = staged.reused;
      replacedRecordedRuntime = Boolean(
        existing
        && samePath(existing.current.runtimePath, candidate.runtimePath)
        && !staged.reused
      );
    }

    const timestamp = now().toISOString();
    transaction = {
      schema: SETUP_TRANSACTION_SCHEMA,
      transactionId: plan.transactionId,
      phase: "candidate-staged",
      candidate,
      previous: existing ?? null,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    await runPhase(options, "transaction-write");
    await transactionStore.write(transaction);

    const candidateServiceInput = serviceInputForInstallation(candidate, options.paths.home, deploymentProfile);
    if (existing && !sameServiceInput(existing.serviceInput, candidateServiceInput)) {
      await runPhase(options, "previous-service-stop");
      const stopped = await options.serviceManager.stop();
      if (!stopped.ok && stopped.code !== "SERVICE_NOT_INSTALLED") throw serviceAbort(stopped);
      transaction = await updateTransaction(transactionStore, transaction, "previous-stopped", now);
    }

    await runPhase(options, "service-definition-install");
    const installed = await options.serviceManager.install(candidateServiceInput);
    if (!installed.ok) throw serviceAbort(installed);
    transaction = await updateTransaction(transactionStore, transaction, "service-switched", now);

    let started = false;
    const status = await options.serviceManager.status().catch(() => undefined);
    if (!status) throw abort("SERVICE_STATUS_UNAVAILABLE", "The candidate service status could not be read.");
    if ((installed.changed || replacedRecordedRuntime)
      && (status.managerState === "running" || status.health === "healthy")) {
      await runPhase(options, "service-start");
      const restarted = await options.serviceManager.restart();
      if (!restarted.ok) throw serviceAbort(restarted);
      started = true;
    } else if (status.managerState !== "running" && status.health !== "healthy") {
      await runPhase(options, "service-start");
      const startResult = await options.serviceManager.start();
      if (!startResult.ok) throw serviceAbort(startResult);
      started = true;
    }
    transaction = await updateTransaction(transactionStore, transaction, "candidate-started", now);

    const verification = await safeVerify(options.verifyRuntime, candidate);
    await runPhase(options, "health-verification");
    if (!verification.health) throw abort("SETUP_VERIFICATION_FAILED", "The candidate runtime health check failed.");
    await runPhase(options, "authentication-verification");
    if (!verification.authenticated) {
      throw abort("SETUP_VERIFICATION_FAILED", "The candidate runtime control authentication check failed.");
    }
    await runPhase(options, "version-verification");
    if (verification.version !== candidate.packageVersion || !samePath(verification.runtimePath, candidate.runtimePath)) {
      throw abort("SETUP_VERIFICATION_FAILED", "The candidate runtime version or stable path check failed.");
    }
    await runPhase(options, "profile-verification");
    if (verification.deploymentProfile !== deploymentProfile) {
      throw abort("SETUP_VERIFICATION_FAILED", "The candidate runtime deployment profile check failed.");
    }
    transaction = await updateTransaction(transactionStore, transaction, "candidate-verified", now);
    transaction = await updateTransaction(transactionStore, transaction, "committing", now);

    const document = nextInstallDocument(
      installationId,
      candidate,
      existing,
      candidateServiceInput,
      now
    );
    await runPhase(options, "install-record-commit");
    await installStore.write(document);
    await transactionStore.clear();

    return success(plan, deploymentProfile, {
      idempotent: Boolean(existing && reusedStableRuntime && samePath(existing.current.runtimePath, candidate.runtimePath)),
      upgraded: Boolean(existing && existing.current.packageVersion !== candidate.packageVersion),
      started,
      dryRun: false
    });
  } catch (error) {
    const setupError = asSetupAbort(error);
    if (!candidate || !transaction) return failure(setupError.code, setupError.message);
    const compensated = await compensateTransaction({
      options,
      transaction,
      transactionStore,
      installStore,
      installationId
    });
    if (!compensated.ok) return rollbackFailure(compensated.failures);
    if (transaction.previous) {
      return failure(
        "SETUP_VERIFICATION_FAILED",
        `${setupError.message} The previous verified runtime was restored.`
      );
    }
    return failure(setupError.code, setupError.message);
  }
}

async function compensateTransaction(input: {
  options: BridgeSetupOptions;
  transaction: SetupTransaction;
  transactionStore: SetupTransactionStore;
  installStore: RuntimeInstallStore;
  installationId: string | null;
}): Promise<{ ok: true } | { ok: false; failures: string[] }> {
  const { options, transaction, transactionStore, installStore } = input;
  const failures: string[] = [];
  const now = options.now ?? (() => new Date());
  await transactionStore.write({
    ...transaction,
    phase: "rolling-back",
    updatedAt: now().toISOString()
  }).catch(() => undefined);

  const previous = transaction.previous;
  if (!previous) {
    await attemptRollback(failures, "candidate service cleanup", async () => {
      await runPhase(options, "candidate-service-cleanup");
      await options.serviceManager.stop().catch(() => undefined);
      await options.serviceManager.uninstall().catch(() => undefined);
      const status = await options.serviceManager.status();
      if (status.installed || status.managerState === "running" || status.health === "healthy") {
        throw new Error("candidate service remains active");
      }
    });
    await attemptRollback(failures, "install record cleanup", () => installStore.clear());
    await attemptRollback(failures, "candidate runtime cleanup", async () => {
      await runPhase(options, "candidate-runtime-cleanup");
      await removeCandidateRuntime({
        paths: options.paths,
        installation: transaction.candidate,
        previous: null,
        ...(options.stagedFileSystem ? { fileSystem: options.stagedFileSystem } : {})
      });
    });
  } else {
    await options.serviceManager.stop().catch(() => undefined);
    await attemptRollback(failures, "previous service definition restore", async () => {
      await runPhase(options, "previous-definition-restore");
      const restored = await options.serviceManager.install(previous.serviceInput);
      if (!restored.ok) throw new Error(restored.code);
    });
    await attemptRollback(failures, "previous runtime restart", async () => {
      await runPhase(options, "previous-runtime-restart");
      const restarted = await options.serviceManager.start();
      if (!restarted.ok) throw new Error(restarted.code);
    });
    await attemptRollback(failures, "previous runtime verification", async () => {
      const verification = await safeVerify(options.verifyRuntime, previous.current);
      if (!verificationSucceeded(
        verification,
        previous.current,
        previous.serviceInput.deploymentProfile
      )) throw new Error("previous runtime verification failed");
    });
    await attemptRollback(failures, "previous install record restore", () => installStore.write({
      ...previous,
      installationId: previous.installationId ?? input.installationId
    }));
    await attemptRollback(failures, "candidate runtime cleanup", async () => {
      await runPhase(options, "candidate-runtime-cleanup");
      await removeCandidateRuntime({
        paths: options.paths,
        installation: transaction.candidate,
        previous: previous.current,
        ...(options.stagedFileSystem ? { fileSystem: options.stagedFileSystem } : {})
      });
    });
  }

  if (failures.length === 0) {
    await attemptRollback(failures, "transaction journal cleanup", () => transactionStore.clear());
  }
  return failures.length === 0 ? { ok: true } : { ok: false, failures };
}

export function nodeVersionIsSupported(version: string): boolean {
  const match = version.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/u);
  if (!match) return false;
  const current = [Number(match[1]), Number(match[2]), Number(match[3])];
  const minimum = [MINIMUM_NODE_VERSION.major, MINIMUM_NODE_VERSION.minor, MINIMUM_NODE_VERSION.patch];
  for (let index = 0; index < minimum.length; index += 1) {
    if (current[index]! > minimum[index]!) return true;
    if (current[index]! < minimum[index]!) return false;
  }
  return true;
}

async function updateTransaction(
  store: SetupTransactionStore,
  transaction: SetupTransaction,
  phase: SetupTransactionPhase,
  now: () => Date
): Promise<SetupTransaction> {
  const next = { ...transaction, phase, updatedAt: now().toISOString() };
  await store.write(next);
  return next;
}

function nextInstallDocument(
  installationId: string,
  current: VerifiedRuntimeInstallation,
  existing: RuntimeInstallDocument | undefined,
  serviceInput: ServiceInstallInput,
  now: () => Date
): RuntimeInstallDocument {
  const sameRuntime = existing
    && existing.current.packageVersion === current.packageVersion
    && samePath(existing.current.runtimePath, current.runtimePath);
  return {
    schema: RUNTIME_INSTALL_SCHEMA,
    installationId,
    current,
    previous: sameRuntime ? existing.previous : existing?.current ?? null,
    serviceInput,
    updatedAt: now().toISOString()
  };
}

async function safeVerify(
  verify: BridgeSetupOptions["verifyRuntime"],
  installation: RuntimeInstallation
): Promise<SetupVerification> {
  try {
    return await verify(installation);
  } catch (_error) {
    return {
      health: false,
      authenticated: false,
      version: "unavailable",
      runtimePath: "unavailable",
      deploymentProfile: "production"
    };
  }
}

function verificationSucceeded(
  verification: SetupVerification,
  installation: RuntimeInstallation,
  deploymentProfile: BridgeDeploymentProfile
): boolean {
  return verification.health
    && verification.authenticated
    && verification.version === installation.packageVersion
    && samePath(verification.runtimePath, installation.runtimePath)
    && verification.deploymentProfile === deploymentProfile;
}

async function runPhase(options: BridgeSetupOptions, phase: SetupFailurePhase): Promise<void> {
  await options.onPhase?.(phase);
}

async function attemptRollback(
  failures: string[],
  label: string,
  action: () => void | Promise<void>
): Promise<void> {
  try {
    await action();
  } catch (_error) {
    failures.push(label);
  }
}

function serviceAbort(result: Extract<ServiceResult, { ok: false }>): SetupAbort {
  return abort(result.code, result.message);
}

function abort(code: SetupErrorCode, message: string): SetupAbort {
  return { code, message };
}

function asSetupAbort(error: unknown): SetupAbort {
  if (isSetupAbort(error)) return error;
  if (error instanceof StagedRuntimeCleanupError) return abort(error.code, error.message);
  if (error instanceof Error && "code" in error && typeof error.code === "string") {
    const code = error.code as SetupErrorCode;
    if (isSetupErrorCode(code)) return abort(code, safeErrorMessage(error));
  }
  return abort("RUNTIME_INSTALL_FAILED", "The Hunsu Bridge runtime transaction failed.");
}

function isSetupAbort(value: unknown): value is SetupAbort {
  return typeof value === "object"
    && value !== null
    && "code" in value
    && isSetupErrorCode((value as { code?: unknown }).code)
    && "message" in value
    && typeof (value as { message?: unknown }).message === "string";
}

function isSetupErrorCode(value: unknown): value is SetupErrorCode {
  return value === "NODE_VERSION_UNSUPPORTED"
    || value === "RUNTIME_INSTALL_FAILED"
    || value === "SETUP_IN_PROGRESS"
    || value === "SETUP_VERIFICATION_FAILED"
    || value === "ROLLBACK_FAILED"
    || value === "SERVICE_NOT_INSTALLED"
    || value === "SERVICE_ALREADY_INSTALLED"
    || value === "SERVICE_INSTALL_FAILED"
    || value === "SERVICE_START_FAILED"
    || value === "SERVICE_STOP_FAILED"
    || value === "SERVICE_STATUS_UNAVAILABLE";
}

function safeErrorMessage(error: Error): string {
  if (error instanceof StagedRuntimeCleanupError) return error.message;
  return error.message.includes("runtime") || error.message.includes("Bridge")
    ? error.message
    : "The Hunsu Bridge runtime transaction failed."
}

function sameServiceInput(left: ServiceInstallInput, right: ServiceInstallInput): boolean {
  return samePath(left.nodePath, right.nodePath)
    && samePath(left.cliPath, right.cliPath)
    && samePath(left.hunsuHome, right.hunsuHome)
    && left.packageVersion === right.packageVersion
    && samePath(left.runtimePath, right.runtimePath)
    && left.deploymentProfile === right.deploymentProfile;
}

function samePath(left: string, right: string): boolean {
  const resolvedLeft = resolvePortable(left);
  const resolvedRight = resolvePortable(right);
  return process.platform === "win32"
    ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
    : resolvedLeft === resolvedRight;
}

function resolvePortable(path: string): string {
  return path.replaceAll("\\", "/").replace(/\/$/u, "");
}

function rollbackFailure(failures: readonly string[]): SetupResult {
  return failure(
    "ROLLBACK_FAILED",
    `Bridge setup rollback could not restore: ${failures.join(", ")}. Run \`hunsu-bridge doctor --json\` before retrying.`
  );
}

function success(
  plan: StagedRuntimePlan,
  deploymentProfile: BridgeDeploymentProfile,
  state: Pick<Extract<SetupResult, { ok: true }>["value"], "idempotent" | "upgraded" | "started" | "dryRun">
): SetupResult {
  const packageTag = bridgeSetupPackageTag(deploymentProfile);
  return {
    ok: true,
    code: "OK",
    message: state.dryRun
      ? "Hunsu Bridge setup dry run completed."
      : state.idempotent
        ? "Hunsu Bridge is already installed and verified."
        : "Hunsu Bridge installed and verified.",
    value: {
      packageVersion: plan.packageVersion,
      deploymentProfile,
      runtimePath: plan.runtimePath,
      cliPath: plan.cliPath,
      npmCommand: plan.npmCommand,
      commands: {
        status: `npx @hunsu/bridge@${packageTag} status --profile ${deploymentProfile}`,
        doctor: `npx @hunsu/bridge@${packageTag} doctor --profile ${deploymentProfile}`,
        remove: `npx @hunsu/bridge@${packageTag} remove --profile ${deploymentProfile}`
      },
      ...state
    }
  };
}

function failure(code: SetupErrorCode, message: string): SetupResult {
  return { ok: false, code, message };
}
