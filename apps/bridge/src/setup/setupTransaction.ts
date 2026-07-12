import { randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, unlink } from "node:fs/promises";
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

  await mkdir(paths.runtimeDirectory, { recursive: true, mode: 0o700 });
  const handle = await open(temporaryFile, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(document)}\n`, "utf8");
    await handle.sync();
    await handle.chmod(0o600);
  } finally {
    await handle.close();
  }
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await link(temporaryFile, file);
      let released = false;
      return {
        operation,
        async release() {
          if (released) return;
          const current = await readLockDocument(file).catch(error => {
            if (isNodeError(error) && error.code === "ENOENT") return undefined;
            throw error;
          });
          if (current && current.token !== document.token) {
            throw invalidState(file, "setup lock ownership changed before release");
          }
          if (current) await unlink(file);
          released = true;
        }
      };
      } catch (error) {
        if (!isNodeError(error) || error.code !== "EEXIST") throw error;
        const existing = await readLockDocument(file).catch(() => undefined);
        if (existing && isProcessAlive(existing.pid)) throw new SetupInProgressError();
        try {
          await unlink(file);
        } catch (unlinkError) {
          if (!isNodeError(unlinkError) || unlinkError.code !== "ENOENT") {
            throw new SetupInProgressError();
          }
        }
      }
    }
  } finally {
    await unlink(temporaryFile).catch(error => {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    });
  }
  throw new SetupInProgressError();
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
    candidate: decodeRuntimeInstallation(file, "candidate", value.candidate),
    previous: value.previous === null ? null : decodeRuntimeInstallDocument(file, value.previous),
    createdAt: requiredIsoTimestamp(file, "createdAt", value.createdAt),
    updatedAt: requiredIsoTimestamp(file, "updatedAt", value.updatedAt)
  };
}

async function readLockDocument(file: string): Promise<SetupLockDocument | undefined> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
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
