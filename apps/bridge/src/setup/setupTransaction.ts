import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { link, lstat, mkdir, open, readFile, realpath, rmdir, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { HunsuPaths } from "../state/paths.ts";
import {
  invalidState,
  isNodeError,
  readJsonState,
  writeJsonStateAtomic
} from "../state/atomicJsonStore.ts";
import type {
  RuntimeInstallDocument,
  RuntimeInstallation
} from "./runtimeInstaller.ts";
import {
  decodeRuntimeInstallDocument,
  decodeRuntimeInstallation
} from "./runtimeInstaller.ts";

export const SETUP_TRANSACTION_SCHEMA = "hunsu.bridge.setup-transaction.v1" as const;
export const SETUP_LOCK_SCHEMA = "hunsu.bridge.setup-lock.v1" as const;

export type SetupTransactionPhase =
  | "preparing"
  | "candidate-staged"
  | "previous-stopped"
  | "service-switched"
  | "candidate-started"
  | "candidate-verified"
  | "committing"
  | "rolling-back";

export type SetupTransaction = {
  schema: typeof SETUP_TRANSACTION_SCHEMA;
  transactionId: string;
  phase: SetupTransactionPhase;
  candidate: RuntimeInstallation;
  previous: RuntimeInstallDocument | null;
  createdAt: string;
  updatedAt: string;
};

export type SetupTransactionStore = {
  read(): Promise<SetupTransaction | undefined>;
  write(transaction: SetupTransaction): Promise<void>;
  clear(): Promise<void>;
};

export type SetupOperation = "setup" | "remove" | "service-mutation" | "runtime-upgrade";

export type SetupOperationLease = {
  operation: SetupOperation;
  release(): Promise<void>;
};

export class SetupInProgressError extends Error {
  readonly code = "SETUP_IN_PROGRESS" as const;

  constructor() {
    super("Another Hunsu Bridge setup, removal, or service mutation is already in progress.");
    this.name = "SetupInProgressError";
  }
}

type SetupLockDocument = {
  schema: typeof SETUP_LOCK_SCHEMA;
  token: string;
  operation: SetupOperation;
  pid: number;
  createdAt: string;
};

export function setupTransactionPath(paths: HunsuPaths): string {
  return paths.setupTransactionFile;
}

export function setupLockPath(paths: HunsuPaths): string {
  return paths.setupLockFile;
}

export function runtimeStagingPath(paths: HunsuPaths): string {
  return paths.runtimeStagingDirectory;
}

export function createSetupTransactionStore(paths: HunsuPaths): SetupTransactionStore {
  const file = setupTransactionPath(paths);
  return {
    async read() {
      const value = await readJsonState(file);
      return value === undefined ? undefined : decodeSetupTransaction(file, value);
    },
    async write(transaction) {
      await writeJsonStateAtomic(file, decodeSetupTransaction(file, transaction), { mode: 0o600 });
    },
    async clear() {
      try {
        await unlink(file);
      } catch (error) {
        if (!isNodeError(error) || error.code !== "ENOENT") throw error;
      }
    }
  };
}

export async function acquireSetupOperationLock(
  paths: HunsuPaths,
  operation: SetupOperation,
  options: {
    now?: () => Date;
    pid?: number;
    isProcessAlive?: (pid: number) => boolean;
  } = {}
): Promise<SetupOperationLease> {
  const file = setupLockPath(paths);
  const now = options.now ?? (() => new Date());
  const pid = options.pid ?? process.pid;
  const isProcessAlive = options.isProcessAlive ?? defaultProcessAlive;
  const document: SetupLockDocument = {
    schema: SETUP_LOCK_SCHEMA,
    token: randomUUID(),
    operation,
    pid,
    createdAt: now().toISOString()
  };
  const temporaryFile = `${file}.${pid}.${document.token}.tmp`;
  const directory = await prepareSafeLockDirectory(paths);
  let temporaryIdentity: FileIdentity | undefined;
  let createdLock = false;

  try {
    try {
      const handle = await open(temporaryFile, "wx", 0o600);
      try {
        temporaryIdentity = fileIdentity(await handle.stat());
        await handle.writeFile(`${JSON.stringify(document)}\n`, "utf8");
        await handle.sync();
        await handle.chmod(0o600);
      } finally {
        await handle.close();
      }

      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          await assertSafeLockDirectory(paths, directory);
          await link(temporaryFile, file);
          createdLock = true;
          const linked = await inspectSafeLockFile(file, directory.canonicalRuntime, 2);
          if (!linked || !sameFileIdentity(linked, temporaryIdentity)) {
            throw invalidState(file, "the atomic setup lock has an unexpected file identity");
          }

          let released = false;
          return {
            operation,
            async release() {
              if (released) return;
              const current = await readInspectedLockDocument(file, directory.canonicalRuntime, false);
              if (!current) {
                released = true;
                await cleanupCreatedLockDirectories(paths, directory);
                return;
              }
              if (current.document?.token !== document.token) {
                throw invalidState(file, "setup lock ownership changed before release");
              }
              await unlinkInspectedLock(file, directory.canonicalRuntime, current.identity);
              released = true;
              await cleanupCreatedLockDirectories(paths, directory);
            }
          };
        } catch (error) {
          if (!isNodeError(error) || error.code !== "EEXIST") throw error;
          const existing = await readInspectedLockDocument(file, directory.canonicalRuntime, true);
          if (!existing) continue;
          if (existing.document && isProcessAlive(existing.document.pid)) throw new SetupInProgressError();
          await unlinkInspectedLock(file, directory.canonicalRuntime, existing.identity);
        }
      }
    } finally {
      if (temporaryIdentity) {
        await unlinkOwnedTemporaryFile(temporaryFile, directory.canonicalRuntime, temporaryIdentity);
      }
    }
    throw new SetupInProgressError();
  } catch (error) {
    if (createdLock && temporaryIdentity) {
      await unlinkOwnedFailedLock(file, directory.canonicalRuntime, temporaryIdentity);
    }
    await cleanupCreatedLockDirectories(paths, directory);
    throw error;
  }
}

function decodeSetupTransaction(file: string, value: unknown): SetupTransaction {
  if (!isRecord(value) || value.schema !== SETUP_TRANSACTION_SCHEMA) {
    throw invalidState(file, `expected schema ${SETUP_TRANSACTION_SCHEMA}`);
  }
  if (!isSetupPhase(value.phase)) throw invalidState(file, "phase is invalid");
  return {
    schema: SETUP_TRANSACTION_SCHEMA,
    transactionId: requiredSafeString(file, "transactionId", value.transactionId),
    phase: value.phase,
    // v1 journals predate persisted CLI integrity. An unverified candidate is
    // accepted only so setup can compensate and clear that interrupted journal.
    candidate: decodeRuntimeInstallation(file, "candidate", value.candidate, { allowUnverified: true }),
    previous: value.previous === null ? null : decodeRuntimeInstallDocument(file, value.previous),
    createdAt: requiredIsoTimestamp(file, "createdAt", value.createdAt),
    updatedAt: requiredIsoTimestamp(file, "updatedAt", value.updatedAt)
  };
}

function decodeLockDocument(file: string, raw: string): SetupLockDocument {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw invalidState(file, "setup lock is not valid JSON");
  }
  if (!isRecord(value)
    || value.schema !== SETUP_LOCK_SCHEMA
    || !isSetupOperation(value.operation)
    || !Number.isSafeInteger(value.pid)
    || Number(value.pid) <= 0) {
    throw invalidState(file, "setup lock has an invalid schema");
  }
  return {
    schema: SETUP_LOCK_SCHEMA,
    token: requiredSafeString(file, "token", value.token),
    operation: value.operation,
    pid: Number(value.pid),
    createdAt: requiredIsoTimestamp(file, "createdAt", value.createdAt)
  };
}

type FileIdentity = {
  dev: number | bigint;
  ino: number | bigint;
};

type SafeLockDirectory = {
  canonicalHome: string;
  canonicalRuntime: string;
  createdHome: boolean;
  createdRuntime: boolean;
};

async function prepareSafeLockDirectory(paths: HunsuPaths): Promise<SafeLockDirectory> {
  assertSafeLockLayout(paths);
  const homeBefore = await lstatIfPresent(paths.home);
  if (homeBefore) assertSafeDirectoryType(paths.home, homeBefore, "Hunsu home");
  if (!homeBefore) await mkdir(paths.home, { recursive: true, mode: 0o700 });

  const homeStats = await requiredLstat(paths.home, "Hunsu home");
  assertSafeDirectoryType(paths.home, homeStats, "Hunsu home");
  const canonicalHome = resolve(await realpath(paths.home));
  await assertDirectCanonicalChild(paths.home, canonicalHome);

  const runtimeBefore = await lstatIfPresent(paths.runtimeDirectory);
  if (runtimeBefore) assertSafeDirectoryType(paths.runtimeDirectory, runtimeBefore, "setup runtime directory");
  if (!runtimeBefore) {
    try {
      await mkdir(paths.runtimeDirectory, { mode: 0o700 });
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;
    }
  }

  const runtimeStats = await requiredLstat(paths.runtimeDirectory, "setup runtime directory");
  assertSafeDirectoryType(paths.runtimeDirectory, runtimeStats, "setup runtime directory");
  const canonicalRuntime = resolve(await realpath(paths.runtimeDirectory));
  if (!samePath(canonicalRuntime, join(canonicalHome, basename(paths.runtimeDirectory)))) {
    throw invalidState(paths.runtimeDirectory, "setup runtime directory is not a direct contained directory");
  }
  await inspectSafeLockFile(paths.setupLockFile, canonicalRuntime, 1);
  return {
    canonicalHome,
    canonicalRuntime,
    createdHome: !homeBefore,
    createdRuntime: !runtimeBefore
  };
}

async function assertSafeLockDirectory(paths: HunsuPaths, expected: SafeLockDirectory): Promise<void> {
  const homeStats = await requiredLstat(paths.home, "Hunsu home");
  assertSafeDirectoryType(paths.home, homeStats, "Hunsu home");
  const canonicalHome = resolve(await realpath(paths.home));
  if (!samePath(canonicalHome, expected.canonicalHome)) {
    throw invalidState(paths.home, "Hunsu home changed while acquiring the setup lock");
  }

  const runtimeStats = await requiredLstat(paths.runtimeDirectory, "setup runtime directory");
  assertSafeDirectoryType(paths.runtimeDirectory, runtimeStats, "setup runtime directory");
  const canonicalRuntime = resolve(await realpath(paths.runtimeDirectory));
  if (!samePath(canonicalRuntime, expected.canonicalRuntime)
    || !isContained(expected.canonicalHome, canonicalRuntime, false)) {
    throw invalidState(paths.runtimeDirectory, "setup runtime directory changed while acquiring the setup lock");
  }
}

function assertSafeLockLayout(paths: HunsuPaths): void {
  if (!isAbsolute(paths.home)
    || !isAbsolute(paths.runtimeDirectory)
    || !isAbsolute(paths.setupLockFile)
    || !samePath(dirname(paths.runtimeDirectory), paths.home)
    || !samePath(dirname(paths.setupLockFile), paths.runtimeDirectory)) {
    throw invalidState(paths.setupLockFile, "setup lock paths are not absolute direct children of the Hunsu home");
  }
}

async function assertDirectCanonicalChild(path: string, canonicalPath: string): Promise<void> {
  const canonicalParent = resolve(await realpath(dirname(path)));
  if (!samePath(canonicalPath, join(canonicalParent, basename(path)))) {
    throw invalidState(path, "directory resolves through a symbolic link, junction, or reparse point");
  }
}

function assertSafeDirectoryType(path: string, stats: Stats, label: string): void {
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw invalidState(path, `${label} has an unsafe filesystem type`);
  }
}

async function inspectSafeLockFile(
  file: string,
  canonicalRuntime: string,
  expectedLinks: number
): Promise<FileIdentity | undefined> {
  const stats = await lstatIfPresent(file);
  if (!stats) return undefined;
  if (stats.isSymbolicLink() || !stats.isFile() || stats.nlink !== expectedLinks) {
    throw invalidState(file, "setup lock has an unsafe linked or non-file filesystem type");
  }
  const canonicalFile = resolve(await realpath(file));
  if (!isContained(canonicalRuntime, canonicalFile, false)) {
    throw invalidState(file, "setup lock resolves outside the setup runtime directory");
  }
  return fileIdentity(stats);
}

async function readInspectedLockDocument(
  file: string,
  canonicalRuntime: string,
  allowInvalidDocument: boolean
): Promise<{ document: SetupLockDocument | undefined; identity: FileIdentity } | undefined> {
  const identity = await inspectSafeLockFile(file, canonicalRuntime, 1);
  if (!identity) return undefined;
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
  const afterRead = await inspectSafeLockFile(file, canonicalRuntime, 1);
  if (!afterRead || !sameFileIdentity(identity, afterRead)) {
    throw invalidState(file, "setup lock changed while it was being inspected");
  }
  try {
    return { document: decodeLockDocument(file, raw), identity };
  } catch (error) {
    if (!allowInvalidDocument) throw error;
    return { document: undefined, identity };
  }
}

async function unlinkInspectedLock(
  file: string,
  canonicalRuntime: string,
  expectedIdentity: FileIdentity
): Promise<void> {
  const current = await inspectSafeLockFile(file, canonicalRuntime, 1);
  if (!current || !sameFileIdentity(current, expectedIdentity)) {
    throw invalidState(file, "setup lock changed before safe unlink");
  }
  await unlink(file);
}

async function unlinkOwnedTemporaryFile(
  file: string,
  canonicalRuntime: string,
  expectedIdentity: FileIdentity
): Promise<void> {
  const stats = await lstatIfPresent(file);
  if (!stats) return;
  if (stats.isSymbolicLink() || !stats.isFile() || !sameFileIdentity(fileIdentity(stats), expectedIdentity)) {
    throw invalidState(file, "temporary setup lock changed before cleanup");
  }
  const canonicalFile = resolve(await realpath(file));
  if (!isContained(canonicalRuntime, canonicalFile, false)) {
    throw invalidState(file, "temporary setup lock resolves outside the setup runtime directory");
  }
  await unlink(file);
}

async function unlinkOwnedFailedLock(
  file: string,
  canonicalRuntime: string,
  expectedIdentity: FileIdentity
): Promise<void> {
  const stats = await lstatIfPresent(file);
  if (!stats) return;
  if (stats.isSymbolicLink()
    || !stats.isFile()
    || (stats.nlink !== 1 && stats.nlink !== 2)
    || !sameFileIdentity(fileIdentity(stats), expectedIdentity)) {
    throw invalidState(file, "failed setup lock changed before cleanup");
  }
  const canonicalFile = resolve(await realpath(file));
  if (!isContained(canonicalRuntime, canonicalFile, false)) {
    throw invalidState(file, "failed setup lock resolves outside the setup runtime directory");
  }
  await unlink(file);
}

async function cleanupCreatedLockDirectories(paths: HunsuPaths, directory: SafeLockDirectory): Promise<void> {
  if (directory.createdRuntime) {
    await removeCreatedDirectoryIfEmpty(paths.runtimeDirectory, directory.canonicalRuntime);
  }
  if (directory.createdHome) {
    await removeCreatedDirectoryIfEmpty(paths.home, directory.canonicalHome);
  }
}

async function removeCreatedDirectoryIfEmpty(path: string, expectedCanonicalPath: string): Promise<void> {
  const stats = await lstatIfPresent(path);
  if (!stats) return;
  assertSafeDirectoryType(path, stats, "created setup lock directory");
  const canonicalPath = resolve(await realpath(path));
  if (!samePath(canonicalPath, expectedCanonicalPath)) {
    throw invalidState(path, "created setup lock directory changed before cleanup");
  }
  try {
    await rmdir(path);
  } catch (error) {
    if (!isNodeError(error)
      || (error.code !== "ENOENT" && error.code !== "ENOTEMPTY" && error.code !== "EEXIST")) {
      throw error;
    }
  }
}

async function lstatIfPresent(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function requiredLstat(path: string, label: string): Promise<Stats> {
  const stats = await lstatIfPresent(path);
  if (!stats) throw invalidState(path, `${label} disappeared during setup lock acquisition`);
  return stats;
}

function fileIdentity(stats: Stats): FileIdentity {
  return { dev: stats.dev, ino: stats.ino };
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity | undefined): boolean {
  return right !== undefined && left.dev === right.dev && left.ino === right.ino;
}

function isContained(parent: string, child: string, includeParent: boolean): boolean {
  const candidate = relative(resolve(parent), resolve(child));
  if (candidate === "") return includeParent;
  return candidate !== ".." && !candidate.startsWith(`..${sep}`) && !isAbsolute(candidate);
}

function samePath(left: string, right: string): boolean {
  const resolvedLeft = resolve(left);
  const resolvedRight = resolve(right);
  return process.platform === "win32"
    ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
    : resolvedLeft === resolvedRight;
}

function requiredSafeString(file: string, field: string, value: unknown): string {
  if (typeof value !== "string" || !value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw invalidState(file, `${field} must be a non-empty safe string`);
  }
  return value;
}

function requiredIsoTimestamp(file: string, field: string, value: unknown): string {
  const text = requiredSafeString(file, field, value);
  if (!Number.isFinite(Date.parse(text))) throw invalidState(file, `${field} must be an ISO timestamp`);
  return text;
}

function isSetupPhase(value: unknown): value is SetupTransactionPhase {
  return value === "preparing"
    || value === "candidate-staged"
    || value === "previous-stopped"
    || value === "service-switched"
    || value === "candidate-started"
    || value === "candidate-verified"
    || value === "committing"
    || value === "rolling-back";
}

function isSetupOperation(value: unknown): value is SetupOperation {
  return value === "setup"
    || value === "remove"
    || value === "service-mutation"
    || value === "runtime-upgrade";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function defaultProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isNodeError(error) && error.code === "EPERM";
  }
}
