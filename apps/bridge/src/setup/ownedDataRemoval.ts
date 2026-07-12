import type { Stats } from "node:fs";
import { lstat, readdir, realpath, rmdir, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { isNodeError } from "../state/atomicJsonStore.ts";

export const HUNSU_OWNED_HOME_ENTRIES = Object.freeze([
  "config.json",
  "workspaces.json",
  "credentials.json",
  "runtime.json",
  "runtime",
  "logs",
  ".hunsu-bridge-home.json"
] as const);

export type HunsuOwnedHomeEntry = typeof HUNSU_OWNED_HOME_ENTRIES[number];

export const RUNTIME_ONLY_HOME_ENTRIES = Object.freeze([
  "runtime.json",
  "runtime"
] as const satisfies readonly HunsuOwnedHomeEntry[]);

type ExpectedEntryType = "file" | "directory" | "any";

const ENTRY_TYPES: Readonly<Record<HunsuOwnedHomeEntry, Exclude<ExpectedEntryType, "any">>> = {
  "config.json": "file",
  "workspaces.json": "file",
  "credentials.json": "file",
  "runtime.json": "file",
  runtime: "directory",
  logs: "directory",
  ".hunsu-bridge-home.json": "file"
};

export type OwnedDataFileSystem = {
  lstat(path: string): Promise<Stats | undefined>;
  realpath(path: string): Promise<string>;
  readdir(path: string): Promise<string[]>;
  unlink(path: string): Promise<void>;
  rmdir(path: string): Promise<void>;
};

export type OwnedDataDeletionPlan = {
  canonicalHome: string;
  entries: readonly HunsuOwnedHomeEntry[];
  existingEntries: HunsuOwnedHomeEntry[];
  preservedUnknownEntries: string[];
  homeDirectoryRemoved: boolean;
};

export type OwnedDataDeletionResult = {
  deleted: string[];
  preservedUnknownEntries: string[];
  homeDirectoryRemoved: boolean;
};

export class OwnedDataSafetyError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "OwnedDataSafetyError";
  }
}

export const defaultOwnedDataFileSystem: OwnedDataFileSystem = {
  async lstat(path) {
    try {
      return await lstat(path);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return undefined;
      throw error;
    }
  },
  realpath,
  readdir,
  unlink,
  rmdir
};

export async function planOwnedDataDeletion(input: {
  canonicalHome: string;
  entries: readonly HunsuOwnedHomeEntry[];
  fileSystem?: OwnedDataFileSystem;
  userHome?: string;
  currentDirectory?: string;
}): Promise<OwnedDataDeletionPlan> {
  const fileSystem = input.fileSystem ?? defaultOwnedDataFileSystem;
  const canonicalHome = resolve(input.canonicalHome);
  await assertHomeIsNotProtected({
    canonicalHome,
    fileSystem,
    userHome: input.userHome,
    currentDirectory: input.currentDirectory
  });
  const topLevelEntries = await safeReadDirectory(fileSystem, canonicalHome);
  const existingEntries: HunsuOwnedHomeEntry[] = [];
  for (const name of input.entries) {
    assertSafeBasename(name);
    if (await inspectOwnedEntry(fileSystem, canonicalHome, join(canonicalHome, name), ENTRY_TYPES[name])) {
      existingEntries.push(name);
    }
  }
  const preservedUnknownEntries = unknownEntries(topLevelEntries);
  const targeted = new Set(input.entries);
  const homeDirectoryRemoved = topLevelEntries.every(name => targeted.has(name as HunsuOwnedHomeEntry));
  return {
    canonicalHome,
    entries: [...input.entries],
    existingEntries,
    preservedUnknownEntries,
    homeDirectoryRemoved
  };
}

export async function executeOwnedDataDeletion(
  plan: OwnedDataDeletionPlan,
  fileSystem: OwnedDataFileSystem = defaultOwnedDataFileSystem
): Promise<OwnedDataDeletionResult> {
  for (const name of plan.entries) {
    await removeOwnedEntry(fileSystem, plan.canonicalHome, join(plan.canonicalHome, name), ENTRY_TYPES[name]);
  }

  const remaining = await safeReadDirectory(fileSystem, plan.canonicalHome);
  let homeDirectoryRemoved = false;
  if (remaining.length === 0) {
    try {
      await fileSystem.rmdir(plan.canonicalHome);
      homeDirectoryRemoved = true;
    } catch (error) {
      if (!isNodeError(error) || (error.code !== "ENOENT" && error.code !== "ENOTEMPTY" && error.code !== "EEXIST")) {
        throw error;
      }
      homeDirectoryRemoved = error.code === "ENOENT";
    }
  }
  return {
    deleted: plan.existingEntries.filter(name => name !== ".hunsu-bridge-home.json"),
    preservedUnknownEntries: unknownEntries(remaining),
    homeDirectoryRemoved
  };
}

export async function assertRegularContainedFile(input: {
  canonicalHome: string;
  path: string;
  fileSystem?: OwnedDataFileSystem;
}): Promise<void> {
  const fileSystem = input.fileSystem ?? defaultOwnedDataFileSystem;
  assertLexicalContainment(input.canonicalHome, input.path);
  const components = relative(resolve(input.canonicalHome), resolve(input.path)).split(sep);
  let parent = resolve(input.canonicalHome);
  for (const component of components.slice(0, -1)) {
    assertSafeBasename(component);
    parent = join(parent, component);
    const parentStats = await safeLstat(fileSystem, parent);
    if (!parentStats?.isDirectory() || parentStats.isSymbolicLink()) {
      throw new OwnedDataSafetyError("An installation identity directory has an unsafe filesystem type.");
    }
    await assertCanonicalContainment(fileSystem, input.canonicalHome, parent);
  }
  const stats = await safeLstat(fileSystem, input.path);
  if (!stats || stats.isSymbolicLink() || !stats.isFile()) {
    throw new OwnedDataSafetyError("An installation identity file has an unsafe filesystem type.");
  }
  await assertCanonicalContainment(fileSystem, input.canonicalHome, input.path);
}

async function inspectOwnedEntry(
  fileSystem: OwnedDataFileSystem,
  canonicalHome: string,
  path: string,
  expectedType: ExpectedEntryType
): Promise<boolean> {
  assertLexicalContainment(canonicalHome, path);
  const stats = await safeLstat(fileSystem, path);
  if (!stats) return false;
  if (stats.isSymbolicLink()) return true;
  if (stats.isFile()) {
    if (expectedType === "directory") throw unexpectedType();
    await assertCanonicalContainment(fileSystem, canonicalHome, path);
    return true;
  }
  if (stats.isDirectory()) {
    if (expectedType === "file") throw unexpectedType();
    await assertCanonicalContainment(fileSystem, canonicalHome, path);
    const children = await safeReadDirectory(fileSystem, path);
    for (const child of children) {
      assertSafeBasename(child);
      await inspectOwnedEntry(fileSystem, canonicalHome, join(path, child), "any");
    }
    return true;
  }
  throw unexpectedType();
}

async function removeOwnedEntry(
  fileSystem: OwnedDataFileSystem,
  canonicalHome: string,
  path: string,
  expectedType: ExpectedEntryType
): Promise<void> {
  assertLexicalContainment(canonicalHome, path);
  const stats = await safeLstat(fileSystem, path);
  if (!stats) return;
  if (stats.isSymbolicLink()) {
    await fileSystem.unlink(path);
    return;
  }
  if (stats.isFile()) {
    if (expectedType === "directory") throw unexpectedType();
    await assertCanonicalContainment(fileSystem, canonicalHome, path);
    await fileSystem.unlink(path);
    return;
  }
  if (!stats.isDirectory() || expectedType === "file") throw unexpectedType();
  await assertCanonicalContainment(fileSystem, canonicalHome, path);
  for (const child of await safeReadDirectory(fileSystem, path)) {
    assertSafeBasename(child);
    await assertDirectoryStillContained(fileSystem, canonicalHome, path);
    await removeOwnedEntry(fileSystem, canonicalHome, join(path, child), "any");
  }
  await assertDirectoryStillContained(fileSystem, canonicalHome, path);
  await fileSystem.rmdir(path);
}

async function assertDirectoryStillContained(
  fileSystem: OwnedDataFileSystem,
  canonicalHome: string,
  path: string
): Promise<void> {
  const stats = await safeLstat(fileSystem, path);
  if (!stats?.isDirectory() || stats.isSymbolicLink()) {
    throw new OwnedDataSafetyError("A Hunsu-owned directory changed type during removal.");
  }
  await assertCanonicalContainment(fileSystem, canonicalHome, path);
}

async function assertCanonicalContainment(
  fileSystem: OwnedDataFileSystem,
  canonicalHome: string,
  path: string
): Promise<void> {
  let canonicalEntry: string;
  try {
    canonicalEntry = resolve(await fileSystem.realpath(path));
  } catch (error) {
    throw new OwnedDataSafetyError("Canonical containment could not be established for Hunsu-owned data.", { cause: error });
  }
  if (!isContained(canonicalHome, canonicalEntry, false)) {
    throw new OwnedDataSafetyError("A Hunsu-owned entry resolves outside the canonical Hunsu home.");
  }
}

async function assertHomeIsNotProtected(input: {
  canonicalHome: string;
  fileSystem: OwnedDataFileSystem;
  userHome?: string;
  currentDirectory?: string;
}): Promise<void> {
  const root = parse(input.canonicalHome).root;
  if (samePath(input.canonicalHome, root)) throw protectedDirectory();
  const canonicalUserHome = await canonicalizeIfPossible(input.fileSystem, input.userHome ?? homedir());
  if (samePath(input.canonicalHome, canonicalUserHome)) throw protectedDirectory();
  const canonicalCurrentDirectory = await canonicalizeIfPossible(
    input.fileSystem,
    input.currentDirectory ?? process.cwd()
  );
  if (isContained(input.canonicalHome, canonicalCurrentDirectory, true)) throw protectedDirectory();
}

async function canonicalizeIfPossible(fileSystem: OwnedDataFileSystem, path: string): Promise<string> {
  try {
    return resolve(await fileSystem.realpath(path));
  } catch (_error) {
    return resolve(path);
  }
}

async function safeLstat(fileSystem: OwnedDataFileSystem, path: string): Promise<Stats | undefined> {
  try {
    return await fileSystem.lstat(path);
  } catch (error) {
    throw new OwnedDataSafetyError("A Hunsu-owned entry could not be inspected safely.", { cause: error });
  }
}

async function safeReadDirectory(fileSystem: OwnedDataFileSystem, path: string): Promise<string[]> {
  try {
    const entries = await fileSystem.readdir(path);
    for (const entry of entries) assertSafeBasename(entry);
    return entries.sort((left, right) => left.localeCompare(right));
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    if (error instanceof OwnedDataSafetyError) throw error;
    throw new OwnedDataSafetyError("A Hunsu-owned directory could not be inspected safely.", { cause: error });
  }
}

function unknownEntries(entries: readonly string[]): string[] {
  const allowlist = new Set<string>(HUNSU_OWNED_HOME_ENTRIES);
  return entries.filter(name => !allowlist.has(name));
}

function assertLexicalContainment(canonicalHome: string, path: string): void {
  if (!isContained(canonicalHome, resolve(path), false)) {
    throw new OwnedDataSafetyError("A Hunsu-owned path is outside the canonical Hunsu home.");
  }
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

function assertSafeBasename(value: string): void {
  if (!value || value === "." || value === ".." || basename(value) !== value) {
    throw new OwnedDataSafetyError("A directory entry is not safe to report or remove.");
  }
}

function protectedDirectory(): OwnedDataSafetyError {
  return new OwnedDataSafetyError("Hunsu Bridge refuses to remove data from a protected directory.");
}

function unexpectedType(): OwnedDataSafetyError {
  return new OwnedDataSafetyError("A Hunsu-owned entry has an unexpected filesystem type.");
}
