import { lstat, mkdir, realpath } from "node:fs/promises";
import { isAbsolute, resolve, win32 } from "node:path";
import type { HunsuPaths } from "../state/paths.ts";
import {
  invalidState,
  isNodeError,
  readJsonState,
  writeJsonStateAtomic
} from "../state/atomicJsonStore.ts";
import { createRuntimeInstallationId } from "./runtimeInstaller.ts";

export const HOME_OWNERSHIP_SCHEMA = "hunsu.bridge.home-ownership.v1" as const;

export type HomeOwnershipMarker = {
  schema: typeof HOME_OWNERSHIP_SCHEMA;
  installationId: string;
  createdAt: string;
  home: string;
};

export type HomeOwnershipStore = {
  read(): Promise<HomeOwnershipMarker | undefined>;
  write(marker: HomeOwnershipMarker): Promise<void>;
  canonicalHome(create: boolean): Promise<string>;
};

export class HomeOwnershipError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "HomeOwnershipError";
  }
}

export function createHomeOwnershipStore(paths: HunsuPaths): HomeOwnershipStore {
  return {
    async read() {
      let stats;
      try {
        stats = await lstat(paths.homeOwnershipFile);
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") return undefined;
        throw new HomeOwnershipError("The Hunsu home ownership marker could not be inspected.", { cause: error });
      }
      if (!stats.isFile() || stats.isSymbolicLink()) {
        throw new HomeOwnershipError("The Hunsu home ownership marker has an unsafe filesystem type.");
      }
      const value = await readJsonState(paths.homeOwnershipFile);
      return value === undefined ? undefined : decodeHomeOwnershipMarker(paths.homeOwnershipFile, value);
    },
    async write(marker) {
      await writeJsonStateAtomic(
        paths.homeOwnershipFile,
        decodeHomeOwnershipMarker(paths.homeOwnershipFile, marker),
        { mode: 0o600 }
      );
    },
    async canonicalHome(create) {
      try {
        if (create) await mkdir(paths.home, { recursive: true, mode: 0o700 });
        const stats = await lstat(paths.home);
        if (!stats.isDirectory() || stats.isSymbolicLink()) {
          throw new HomeOwnershipError("The configured Hunsu home has an unsafe filesystem type.");
        }
        return resolve(await realpath(paths.home));
      } catch (error) {
        if (error instanceof HomeOwnershipError) throw error;
        throw new HomeOwnershipError("The canonical Hunsu home could not be established.", { cause: error });
      }
    }
  };
}

export async function ensureHomeOwnership(input: {
  store: HomeOwnershipStore;
  expectedInstallationId?: string;
  now?: () => Date;
  createInstallationId?: () => string;
}): Promise<HomeOwnershipMarker> {
  const canonicalHome = await input.store.canonicalHome(true);
  const existing = await input.store.read();
  if (existing) {
    if (!sameCanonicalPath(existing.home, canonicalHome)) {
      throw new HomeOwnershipError("The Hunsu home ownership marker does not match the canonical home.");
    }
    if (input.expectedInstallationId && existing.installationId !== input.expectedInstallationId) {
      throw new HomeOwnershipError("The Hunsu home ownership marker does not match the installed runtime.");
    }
    return existing;
  }

  const installationId = input.expectedInstallationId
    ?? (input.createInstallationId ?? createRuntimeInstallationId)();
  assertInstallationId(installationId);
  const marker: HomeOwnershipMarker = {
    schema: HOME_OWNERSHIP_SCHEMA,
    installationId,
    createdAt: (input.now ?? (() => new Date()))().toISOString(),
    home: canonicalHome
  };
  await input.store.write(marker);
  return marker;
}

export function sameCanonicalPath(left: string, right: string): boolean {
  const resolvedLeft = resolve(left);
  const resolvedRight = resolve(right);
  return process.platform === "win32"
    ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
    : resolvedLeft === resolvedRight;
}

function decodeHomeOwnershipMarker(file: string, value: unknown): HomeOwnershipMarker {
  if (!isRecord(value) || value.schema !== HOME_OWNERSHIP_SCHEMA) {
    throw invalidState(file, `expected schema ${HOME_OWNERSHIP_SCHEMA}`);
  }
  const installationId = requiredString(file, "installationId", value.installationId);
  assertInstallationId(installationId, file);
  const createdAt = requiredString(file, "createdAt", value.createdAt);
  if (!Number.isFinite(Date.parse(createdAt))) throw invalidState(file, "createdAt must be an ISO timestamp");
  const home = requiredString(file, "home", value.home);
  if (!isAbsolute(home) && !win32.isAbsolute(home)) throw invalidState(file, "home must be an absolute path");
  return { schema: HOME_OWNERSHIP_SCHEMA, installationId, createdAt, home };
}

function assertInstallationId(value: string, file?: string): void {
  if (!/^install_[A-Za-z0-9_-]{8,}$/u.test(value)) {
    if (file) throw invalidState(file, "installationId must be a Hunsu installation id");
    throw new HomeOwnershipError("The Hunsu installation identity is invalid.");
  }
}

function requiredString(file: string, field: string, value: unknown): string {
  if (typeof value !== "string" || !value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw invalidState(file, `${field} must be a non-empty safe string`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
