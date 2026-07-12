import { existsSync, readFileSync } from "node:fs";
import { codexProviderEnv, codexSettingsFromRecord, type BridgeCodexSettings } from "../runtime-providers/codex.ts";
import type { BridgeStatusAccount } from "./bridgeStatus.ts";
import { decodeBridgeConfig, type BridgeConfig } from "../state/configStore.ts";
import { BRIDGE_CREDENTIALS_SCHEMA, type BridgeCredentials } from "../state/credentialStore.ts";
import { WORKSPACE_STORE_SCHEMA, type WorkspaceStoreDocument } from "../state/workspaceStore.ts";
import { resolveHunsuPaths } from "../state/paths.ts";
import type { BridgeRemoteWorkspaceScope } from "../workspaces/remoteScopes.ts";

export type BridgeCommandScope = BridgeRemoteWorkspaceScope;

export type RemoteWorkspaceProjectGrant = {
  workspaceId: string;
  scopes: BridgeCommandScope[];
  active?: boolean;
};

export type BridgeAccountEvidence = BridgeStatusAccount & { available: boolean };

export function bridgeStatusAccountEvidenceFromState(env: Record<string, string | undefined>): BridgeAccountEvidence {
  const credentials = readCredentials(env);
  if (!credentials?.connect || credentials.connect.state !== "registered") return { available: credentials !== undefined, signedIn: false };
  return credentials.connect.refreshToken
    ? { available: true, signedIn: true, userId: credentials.connect.accountId }
    : { available: true, signedIn: false };
}

export function bridgeStatusProjectGrantsFromState(env: Record<string, string | undefined>): RemoteWorkspaceProjectGrant[] {
  const config = readConfig(env);
  if (config?.remote.enabled !== true) return [];
  const paths = resolveHunsuPaths({ env });
  const workspaces = readJson<WorkspaceStoreDocument>(paths.workspacesFile);
  if (workspaces?.schema !== WORKSPACE_STORE_SCHEMA || !Array.isArray(workspaces.workspaces)) return [];
  return workspaces.workspaces
    .filter(workspace => workspace.lifecycle === "active"
      && workspace.remoteAccess?.enabled === true
      && workspace.remoteAccess.scopes.includes("remote.access"))
    .map(workspace => ({
      workspaceId: workspace.workspaceId,
      scopes: workspace.remoteAccess?.scopes.filter(isBridgeCommandScope) ?? ["remote.access"]
    }));
}

export function bridgeCodexSettingsFromState(env: Record<string, string | undefined>): BridgeCodexSettings {
  const provider = readConfig(env)?.provider;
  return provider?.kind === "codex"
    ? codexSettingsFromRecord({
        binaryPath: provider.binaryPath,
        codexHome: provider.home,
        appServerCommand: provider.appServerCommand,
        appServerArgs: provider.appServerArgs,
        installChannel: provider.installChannel,
        authenticationPreference: provider.authenticationPreference
      })
    : {};
}

export function bridgeCodexEffectiveEnvFromState(
  env: Record<string, string | undefined>
): Record<string, string | undefined> {
  return codexProviderEnv({ baseEnv: env, settings: bridgeCodexSettingsFromState(env) });
}

export function parseBridgeStatusProjectGrants(value: string | undefined): RemoteWorkspaceProjectGrant[] {
  if (!value?.trim()) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap(item => {
      if (!isRecord(item) || typeof item.workspaceId !== "string" || !item.workspaceId.trim() || !Array.isArray(item.scopes)) return [];
      return [{
        workspaceId: item.workspaceId.trim(),
        scopes: item.scopes.filter(isBridgeCommandScope),
        active: item.active === false ? false : undefined
      }];
    });
  } catch (_error) {
    return [];
  }
}

export function mergeBridgeStatusProjectGrants(projectGrants: RemoteWorkspaceProjectGrant[]): RemoteWorkspaceProjectGrant[] {
  const byWorkspaceId = new Map<string, RemoteWorkspaceProjectGrant>();
  for (const grant of projectGrants) {
    const workspaceId = grant.workspaceId.trim();
    if (!workspaceId) continue;
    const existing = byWorkspaceId.get(workspaceId);
    byWorkspaceId.set(workspaceId, {
      workspaceId,
      scopes: [...new Set([...(existing?.scopes ?? []), ...grant.scopes])],
      active: existing?.active === false || grant.active === false ? false : undefined
    });
  }
  return [...byWorkspaceId.values()];
}

function readConfig(env: Record<string, string | undefined>): BridgeConfig | undefined {
  const file = resolveHunsuPaths({ env }).configFile;
  const config = readJson<unknown>(file);
  if (config === undefined) return undefined;
  try {
    return decodeBridgeConfig(file, config);
  } catch (_error) {
    return undefined;
  }
}

function readCredentials(env: Record<string, string | undefined>): BridgeCredentials | undefined {
  const credentials = readJson<BridgeCredentials>(resolveHunsuPaths({ env }).credentialsFile);
  return credentials?.schema === BRIDGE_CREDENTIALS_SCHEMA ? credentials : undefined;
}

function readJson<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (_error) {
    return undefined;
  }
}

function isBridgeCommandScope(value: unknown): value is BridgeCommandScope {
  return value === "execute.start"
    || value === "artifactAction.run"
    || value === "env.read"
    || value === "hostAlias.expose"
    || value === "remote.access";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
