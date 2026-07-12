import type { HunsuPaths } from "./paths.ts";
import { invalidState, readJsonState, writeJsonStateAtomic } from "./atomicJsonStore.ts";
import {
  BRIDGE_REMOTE_WORKSPACE_SCOPES,
  type BridgeRemoteWorkspaceScope
} from "../workspaces/remoteScopes.ts";

export const WORKSPACE_STORE_SCHEMA = "hunsu.bridge.workspaces.v1" as const;

export type StoredWorkspace = {
  workspaceId: string;
  displayName: string;
  repositoryPath: string;
  lifecycle: "active" | "inactive";
  remoteAccess?: {
    enabled: boolean;
    scopes: BridgeRemoteWorkspaceScope[];
  };
  createdAt: string;
  updatedAt: string;
};

export type WorkspaceStoreDocument = {
  schema: typeof WORKSPACE_STORE_SCHEMA;
  workspaces: StoredWorkspace[];
};

export type WorkspaceStore = {
  read(): Promise<WorkspaceStoreDocument>;
  write(document: WorkspaceStoreDocument): Promise<void>;
};

export function createWorkspaceStore(paths: HunsuPaths): WorkspaceStore {
  return {
    async read() {
      const value = await readJsonState(paths.workspacesFile);
      return value === undefined
        ? { schema: WORKSPACE_STORE_SCHEMA, workspaces: [] }
        : decodeWorkspaceDocument(paths.workspacesFile, value);
    },
    async write(document) {
      await writeJsonStateAtomic(
        paths.workspacesFile,
        decodeWorkspaceDocument(paths.workspacesFile, document)
      );
    }
  };
}

function decodeWorkspaceDocument(file: string, value: unknown): WorkspaceStoreDocument {
  if (!isRecord(value) || value.schema !== WORKSPACE_STORE_SCHEMA || !Array.isArray(value.workspaces)) {
    throw invalidState(file, `expected schema ${WORKSPACE_STORE_SCHEMA} and a workspaces array`);
  }
  const workspaces = value.workspaces.map((workspace, index) => decodeWorkspace(file, workspace, index));
  const ids = new Set<string>();
  const paths = new Set<string>();
  for (const workspace of workspaces) {
    if (ids.has(workspace.workspaceId)) throw invalidState(file, `duplicate workspaceId ${workspace.workspaceId}`);
    if (paths.has(workspace.repositoryPath)) throw invalidState(file, "duplicate repositoryPath");
    ids.add(workspace.workspaceId);
    paths.add(workspace.repositoryPath);
  }
  return { schema: WORKSPACE_STORE_SCHEMA, workspaces };
}

function decodeWorkspace(file: string, value: unknown, index: number): StoredWorkspace {
  if (!isRecord(value)) throw invalidState(file, `workspaces[${index}] must be an object`);
  const lifecycle = value.lifecycle;
  if (lifecycle !== "active" && lifecycle !== "inactive") {
    throw invalidState(file, `workspaces[${index}].lifecycle is invalid`);
  }
  return {
    workspaceId: requiredString(file, `workspaces[${index}].workspaceId`, value.workspaceId),
    displayName: requiredString(file, `workspaces[${index}].displayName`, value.displayName),
    repositoryPath: requiredString(file, `workspaces[${index}].repositoryPath`, value.repositoryPath),
    lifecycle,
    ...decodeRemoteAccess(file, value.remoteAccess, index),
    createdAt: requiredString(file, `workspaces[${index}].createdAt`, value.createdAt),
    updatedAt: requiredString(file, `workspaces[${index}].updatedAt`, value.updatedAt)
  };
}

function decodeRemoteAccess(
  file: string,
  value: unknown,
  index: number
): { remoteAccess?: StoredWorkspace["remoteAccess"] } {
  if (value === undefined) return {};
  if (!isRecord(value) || typeof value.enabled !== "boolean" || !Array.isArray(value.scopes)) {
    throw invalidState(file, `workspaces[${index}].remoteAccess must contain enabled and scopes`);
  }
  const scopes = value.scopes.map((scope, scopeIndex) => {
    const parsed = requiredString(file, `workspaces[${index}].remoteAccess.scopes[${scopeIndex}]`, scope);
    if (!BRIDGE_REMOTE_WORKSPACE_SCOPES.includes(parsed as BridgeRemoteWorkspaceScope)) {
      throw invalidState(file, `workspaces[${index}].remoteAccess.scopes[${scopeIndex}] is unsupported`);
    }
    return parsed as BridgeRemoteWorkspaceScope;
  });
  return { remoteAccess: { enabled: value.enabled, scopes: [...new Set(scopes)] } };
}

function requiredString(file: string, field: string, value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") throw invalidState(file, `${field} must be non-empty`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
