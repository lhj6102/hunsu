import { existsSync, readFileSync } from "node:fs";
import { codexProviderEnv, codexSettingsFromRecord, type BridgeCodexSettings } from "../runtime-providers/codex.ts";
import type { BridgeCommandScope, RemoteWorkspaceProjectGrant } from "../connections/remoteConnection.ts";
import type { BridgeStatusAccount } from "./bridgeStatus.ts";
import { BRIDGE_CONFIG_SCHEMA, type BridgeConfig } from "../state/configStore.ts";
import { BRIDGE_CREDENTIALS_SCHEMA, type BridgeCredentials } from "../state/credentialStore.ts";
import { WORKSPACE_STORE_SCHEMA, type WorkspaceStoreDocument } from "../state/workspaceStore.ts";
import { resolveHunsuPaths } from "../state/paths.ts";

export type BridgeAccountEvidence = BridgeStatusAccount & { available: boolean };

export function bridgeStatusAccountEvidenceFromState(env: Record<string, string | undefined>): BridgeAccountEvidence {
  const credentials = readCredentials(env);
  if (!credentials?.account) return { available: credentials !== undefined, signedIn: false };
  const expired = credentials.account.expiresAt !== null && Date.parse(credentials.account.expiresAt) <= Date.now();
  return expired
    ? { available: true, signedIn: false }
    : { available: true, signedIn: true, userId: credentials.account.accountId };
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
      && workspace.remoteAccess.scopes.includes("remoteRelay.access"))
    .map(workspace => ({
      path: normalizeRepositoryPath(workspace.repositoryPath),
      scopes: workspace.remoteAccess?.scopes.filter(isBridgeCommandScope) ?? ["remoteRelay.access"]
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
      if (!isRecord(item) || typeof item.path !== "string" || !item.path.trim() || !Array.isArray(item.scopes)) return [];
      return [{
        path: normalizeRepositoryPath(item.path),
        scopes: item.scopes.filter(isBridgeCommandScope),
        active: item.active === false ? false : undefined
      }];
    });
  } catch (_error) {
    return [];
  }
}

export function mergeBridgeStatusProjectGrants(projectGrants: RemoteWorkspaceProjectGrant[]): RemoteWorkspaceProjectGrant[] {
  const byPath = new Map<string, RemoteWorkspaceProjectGrant>();
  for (const grant of projectGrants) {
    const path = normalizeRepositoryPath(grant.path);
    const existing = byPath.get(path);
    byPath.set(path, {
      path,
      scopes: [...new Set([...(existing?.scopes ?? []), ...grant.scopes])],
      active: existing?.active === false || grant.active === false ? false : undefined
    });
  }
  return [...byPath.values()];
}

function readConfig(env: Record<string, string | undefined>): BridgeConfig | undefined {
  const config = readJson<BridgeConfig>(resolveHunsuPaths({ env }).configFile);
  return config?.schema === BRIDGE_CONFIG_SCHEMA ? config : undefined;
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
    || value === "remoteRelay.access";
}

function normalizeRepositoryPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
