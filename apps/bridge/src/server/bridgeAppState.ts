import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { RemoteWorkspaceProjectGrant, BridgeCommandScope } from "../connections/remoteConnection.ts";
import type { BridgeStatusAccount } from "./bridgeStatus.ts";

export type BridgeAppAccountEvidence = BridgeStatusAccount & {
  available: boolean;
};

export function bridgeStatusAccountFromBridgeAppState(env: Record<string, string | undefined>): BridgeStatusAccount {
  const evidence = bridgeStatusAccountEvidenceFromBridgeAppState(env);
  return {
    signedIn: evidence.signedIn,
    userId: evidence.userId,
    email: evidence.email
  };
}

export function bridgeStatusAccountEvidenceFromBridgeAppState(env: Record<string, string | undefined>): BridgeAppAccountEvidence {
  const state = readBridgeAppStateForStatus(env);
  const account = state && isRecord(state.account) ? state.account : undefined;
  if (account?.status !== "signed-in") {
    return { available: Boolean(state && account), signedIn: false };
  }
  const userId = typeof account.userId === "string" && account.userId.trim() ? account.userId.trim() : undefined;
  const email = typeof account.email === "string" && account.email.trim() ? account.email.trim() : undefined;
  return {
    available: true,
    signedIn: Boolean(userId || email),
    userId,
    email
  };
}

export function bridgeStatusProjectGrantsFromBridgeAppState(env: Record<string, string | undefined>): RemoteWorkspaceProjectGrant[] {
  const state = readBridgeAppStateForStatus(env);
  if (!state || !Array.isArray(state.projectGrants)) {
    return [];
  }
  return state.projectGrants.flatMap(item => {
    if (!isRecord(item) || typeof item.path !== "string" || !item.path.trim() || !Array.isArray(item.scopes)) {
      return [];
    }
    const scopes = item.scopes.filter(isBridgeCommandScope);
    return [{
      path: normalizeRepositoryPath(item.path),
      scopes,
      active: item.active === false ? false : undefined
    }];
  });
}

export function parseBridgeStatusProjectGrants(value: string | undefined): RemoteWorkspaceProjectGrant[] {
  if (!value?.trim()) {
    return [];
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.flatMap(item => {
      if (!isRecord(item)) {
        return [];
      }
      if (typeof item.path !== "string" || !item.path.trim() || !Array.isArray(item.scopes)) {
        return [];
      }
      const scopes = item.scopes.filter(isBridgeCommandScope);
      return [{
        path: normalizeRepositoryPath(item.path),
        scopes,
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
    const normalizedPath = normalizeRepositoryPath(grant.path);
    const existing = byPath.get(normalizedPath);
    byPath.set(normalizedPath, {
      path: normalizedPath,
      scopes: [...new Set([...(existing?.scopes ?? []), ...grant.scopes])],
      active: existing?.active === false || grant.active === false ? false : undefined
    });
  }
  return [...byPath.values()];
}

function readBridgeAppStateForStatus(env: Record<string, string | undefined>): Record<string, unknown> | undefined {
  const statePath = resolve(env.HUNSU_BRIDGE_APP_STATE_PATH?.trim() || join(homedir(), ".config", "hunsu", "bridge-app.json"));
  if (!existsSync(statePath)) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(readFileSync(statePath, "utf8")) as unknown;
    return isRecord(parsed) ? parsed : undefined;
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
  return typeof value === "object" && value !== null;
}
