import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { basename, normalize, resolve } from "node:path";
import { err, ok, type Brand, type Result } from "@hunsu/protocol";
import { BridgeStateError, isNodeError } from "../state/atomicJsonStore.ts";
import {
  WORKSPACE_STORE_SCHEMA,
  type BridgeRemoteWorkspaceScope,
  type StoredWorkspace,
  type WorkspaceStore
} from "../state/workspaceStore.ts";

export type WorkspaceId = Brand<string, "WorkspaceId">;

type WorkspaceBase = {
  workspaceId: WorkspaceId;
  displayName: string;
  repositoryPath: string;
  remoteAccess: { enabled: boolean; scopes: BridgeRemoteWorkspaceScope[] };
  createdAt: string;
  updatedAt: string;
};

export type Workspace =
  | (WorkspaceBase & { lifecycle: "active" | "inactive" })
  | (WorkspaceBase & { lifecycle: "missing" })
  | (WorkspaceBase & { lifecycle: "error"; issue: "unreadable" });

export type WorkspaceSafeMetadata = {
  workspaceId: WorkspaceId;
  displayName: string;
  lifecycle: Workspace["lifecycle"];
  pathRedacted: true;
};

export type WorkspaceOpenMetadata = {
  workspaceId: WorkspaceId;
  displayName: string;
  repositoryPath: string;
};

export type WorkspaceError =
  | { code: "WORKSPACE_PATH_INVALID"; message: string; reason: "empty" | "missing" | "not_directory" | "unreadable" }
  | { code: "WORKSPACE_ALREADY_REGISTERED"; message: string; workspaceId: WorkspaceId }
  | { code: "WORKSPACE_NOT_FOUND"; message: string; workspaceId: string }
  | { code: "BRIDGE_STATE_INVALID"; message: string };

export type WorkspaceService = {
  add(repositoryPath: string, options?: { displayName?: string }): Promise<Result<Workspace, WorkspaceError>>;
  list(): Promise<Result<Workspace[], WorkspaceError>>;
  get(workspaceId: string): Promise<Result<Workspace, WorkspaceError>>;
  remove(workspaceId: string): Promise<Result<Workspace, WorkspaceError>>;
  open(workspaceId: string): Promise<Result<WorkspaceOpenMetadata, WorkspaceError>>;
  setRemoteAccess(
    workspaceId: string,
    access: { enabled: boolean; scopes: BridgeRemoteWorkspaceScope[] }
  ): Promise<Result<Workspace, WorkspaceError>>;
};

export function createWorkspaceService(input: {
  store: WorkspaceStore;
  now?: () => Date;
  platform?: NodeJS.Platform;
}): WorkspaceService {
  const now = input.now ?? (() => new Date());
  const platform = input.platform ?? process.platform;
  let mutationQueue = Promise.resolve();
  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const task = mutationQueue.then(operation, operation);
    mutationQueue = task.then(() => undefined, () => undefined);
    return task;
  };

  const list = async (): Promise<Result<Workspace[], WorkspaceError>> => {
    try {
      await mutationQueue;
      const document = await input.store.read();
      return ok(await Promise.all(document.workspaces.map(workspace => projectWorkspace(workspace))));
    } catch (error) {
      return err(stateError(error));
    }
  };

  const get = async (workspaceId: string): Promise<Result<Workspace, WorkspaceError>> => {
    try {
      await mutationQueue;
      const document = await input.store.read();
      const stored = document.workspaces.find(workspace => workspace.workspaceId === workspaceId);
      return stored
        ? ok(await projectWorkspace(stored))
        : err(notFound(workspaceId));
    } catch (error) {
      return err(stateError(error));
    }
  };

  return {
    async add(repositoryPath, options = {}) {
      const canonical = await canonicalRepositoryPath(repositoryPath);
      if (!canonical.ok) return canonical;
      const workspaceId = workspaceIdForPath(canonical.value, platform);
      return serialize(async () => { try {
        const document = await input.store.read();
        const duplicate = document.workspaces.find(workspace =>
          workspace.workspaceId === workspaceId
          || comparablePath(workspace.repositoryPath, platform) === comparablePath(canonical.value, platform)
        );
        if (duplicate) {
          return err({
            code: "WORKSPACE_ALREADY_REGISTERED",
            message: "Workspace is already registered.",
            workspaceId: makeWorkspaceId(duplicate.workspaceId)
          });
        }
        const timestamp = now().toISOString();
        const displayName = options.displayName?.trim() || basename(canonical.value);
        const stored: StoredWorkspace = {
          workspaceId,
          displayName,
          repositoryPath: canonical.value,
          lifecycle: "active",
          remoteAccess: { enabled: false, scopes: [] },
          createdAt: timestamp,
          updatedAt: timestamp
        };
        await input.store.write({
          schema: WORKSPACE_STORE_SCHEMA,
          workspaces: [...document.workspaces, stored]
        });
        return ok(await projectWorkspace(stored));
      } catch (error) {
        return err(stateError(error));
      } });
    },
    list,
    get,
    async remove(workspaceId) {
      return serialize(async () => { try {
        const document = await input.store.read();
        const index = document.workspaces.findIndex(workspace => workspace.workspaceId === workspaceId);
        if (index < 0) return err(notFound(workspaceId));
        const stored = document.workspaces[index]!;
        await input.store.write({
          schema: WORKSPACE_STORE_SCHEMA,
          workspaces: document.workspaces.filter((_workspace, candidateIndex) => candidateIndex !== index)
        });
        return ok(await projectWorkspace(stored));
      } catch (error) {
        return err(stateError(error));
      } });
    },
    async open(workspaceId) {
      const found = await get(workspaceId);
      if (!found.ok) return found;
      if (found.value.lifecycle === "missing") {
        return err({
          code: "WORKSPACE_PATH_INVALID",
          message: "Workspace path no longer exists.",
          reason: "missing"
        });
      }
      if (found.value.lifecycle === "error") {
        return err({
          code: "WORKSPACE_PATH_INVALID",
          message: "Workspace path is not readable.",
          reason: "unreadable"
        });
      }
      return ok({
        workspaceId: found.value.workspaceId,
        displayName: found.value.displayName,
        repositoryPath: found.value.repositoryPath
      });
    },
    async setRemoteAccess(workspaceId, access) {
      return serialize(async () => { try {
        const document = await input.store.read();
        const index = document.workspaces.findIndex(workspace => workspace.workspaceId === workspaceId);
        if (index < 0) return err(notFound(workspaceId));
        const current = document.workspaces[index]!;
        const updated: StoredWorkspace = {
          ...current,
          remoteAccess: {
            enabled: access.enabled,
            scopes: [...new Set(access.scopes)]
          },
          updatedAt: now().toISOString()
        };
        await input.store.write({
          schema: WORKSPACE_STORE_SCHEMA,
          workspaces: document.workspaces.map((workspace, candidateIndex) => candidateIndex === index ? updated : workspace)
        });
        return ok(await projectWorkspace(updated));
      } catch (error) {
        return err(stateError(error));
      } });
    }
  };
}

export function workspaceIdForPath(repositoryPath: string, platform: NodeJS.Platform = process.platform): WorkspaceId {
  const identityPath = comparablePath(resolve(repositoryPath), platform);
  return makeWorkspaceId(`ws_${createHash("sha256").update(identityPath).digest("hex")}`);
}

export function toWorkspaceSafeMetadata(workspace: Workspace): WorkspaceSafeMetadata {
  return {
    workspaceId: workspace.workspaceId,
    displayName: workspace.displayName,
    lifecycle: workspace.lifecycle,
    pathRedacted: true
  };
}

async function canonicalRepositoryPath(repositoryPath: string): Promise<Result<string, WorkspaceError>> {
  if (!repositoryPath.trim()) {
    return err({ code: "WORKSPACE_PATH_INVALID", message: "Workspace path is required.", reason: "empty" });
  }
  try {
    const canonical = await realpath(resolve(repositoryPath));
    const details = await stat(canonical);
    if (!details.isDirectory()) {
      return err({ code: "WORKSPACE_PATH_INVALID", message: "Workspace path must be a directory.", reason: "not_directory" });
    }
    return ok(canonical);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return err({ code: "WORKSPACE_PATH_INVALID", message: "Workspace path does not exist.", reason: "missing" });
    }
    return err({ code: "WORKSPACE_PATH_INVALID", message: "Workspace path is not readable.", reason: "unreadable" });
  }
}

async function projectWorkspace(stored: StoredWorkspace): Promise<Workspace> {
  const base: WorkspaceBase = {
    workspaceId: makeWorkspaceId(stored.workspaceId),
    displayName: stored.displayName,
    repositoryPath: stored.repositoryPath,
    remoteAccess: stored.remoteAccess ?? { enabled: false, scopes: [] },
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt
  };
  try {
    const details = await stat(stored.repositoryPath);
    return details.isDirectory()
      ? { ...base, lifecycle: stored.lifecycle }
      : { ...base, lifecycle: "error", issue: "unreadable" };
  } catch (error) {
    return isNodeError(error) && error.code === "ENOENT"
      ? { ...base, lifecycle: "missing" }
      : { ...base, lifecycle: "error", issue: "unreadable" };
  }
}

function comparablePath(repositoryPath: string, platform: NodeJS.Platform): string {
  const normalized = normalize(repositoryPath);
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

function makeWorkspaceId(value: string): WorkspaceId {
  return value as WorkspaceId;
}

function notFound(workspaceId: string): WorkspaceError {
  return { code: "WORKSPACE_NOT_FOUND", message: "Workspace was not found.", workspaceId };
}

function stateError(error: unknown): WorkspaceError {
  return {
    code: "BRIDGE_STATE_INVALID",
    message: error instanceof BridgeStateError ? error.message : "Workspace state is unavailable."
  };
}
