import type { IncomingMessage } from "node:http";
import type { BridgeRuntimeConfig } from "@hunsu/config";
import type { RuntimeProviderRegistry, RuntimeProviderStatus } from "../runtime-providers/types.ts";
import { createLocalBackendStatus, type BridgeBackendStatus } from "../connections/localConnection.ts";
import {
  createRemoteBackendStatus,
  relayRequestConfig,
  remoteProviderStatusFromDevice,
  remoteWorkspaceSnapshotsFromDevice,
  safeListRemoteBridgeDevicesForRequest,
  type RemoteBridgeDeviceSummary,
  type RemoteWorkspaceProjectGrant
} from "../connections/remoteConnection.ts";
import {
  workspaceSummariesFromRoadmaps,
  type ConnectedWorkspaceSummary,
  type RoadmapRegistryWorkspaceEntry
} from "../workspaces/workspaceRegistry.ts";
import {
  bridgeStatusAccountEvidenceFromBridgeAppState,
  bridgeStatusProjectGrantsFromBridgeAppState,
  mergeBridgeStatusProjectGrants,
  parseBridgeStatusProjectGrants
} from "./bridgeAppState.ts";

export type BridgeStatusAccount = {
  signedIn: boolean;
  userId?: string;
  email?: string;
  source?: "bridge_app" | "relay" | "env" | "query" | "none";
};

export type BridgeStatusResponse = {
  provider: RuntimeProviderStatus;
  connections: BridgeBackendStatus[];
  workspaces: {
    active: ConnectedWorkspaceSummary[];
    managed: ConnectedWorkspaceSummary[];
  };
  account: BridgeStatusAccount;
};

export async function currentRuntimeProviderStatus(
  registry: RuntimeProviderRegistry,
  env: Record<string, string | undefined>,
  options: { force?: boolean } = {}
): Promise<RuntimeProviderStatus> {
  return registry.current().status({ env, force: options.force });
}

export function accountStatusForBridgeRequest(
  request: IncomingMessage,
  runtimeConfig: BridgeRuntimeConfig
): BridgeStatusResponse["account"] {
  const url = new URL(request.url ?? "/", "http://localhost");
  const queryUserId = url.searchParams.get("userId")?.trim() || undefined;
  const queryEmail = url.searchParams.get("email")?.trim() || undefined;
  const persisted = accountStatusFromProcessEnv(runtimeConfig.processEnv);
  const bridgeApp = bridgeStatusAccountEvidenceFromBridgeAppState(runtimeConfig.processEnv);
  const relay = relayRequestConfig(request, runtimeConfig);
  if (bridgeApp.signedIn) {
    return {
      signedIn: true,
      userId: bridgeApp.userId ?? persisted.userId,
      email: bridgeApp.email ?? persisted.email,
      source: "bridge_app"
    };
  }
  if (relay) {
    return {
      signedIn: true,
      userId: persisted.userId ?? queryUserId,
      email: persisted.email ?? queryEmail,
      source: "relay"
    };
  }
  if (persisted.signedIn) {
    return { ...persisted, source: "env" };
  }
  if (!bridgeApp.available && queryAccountEvidenceAllowed(runtimeConfig.processEnv) && (queryUserId || queryEmail)) {
    return { signedIn: true, userId: queryUserId, email: queryEmail, source: "query" };
  }
  if (bridgeApp.available) {
    return { signedIn: false, source: "bridge_app" };
  }
  return { signedIn: false, source: "none" };
}

export function projectGrantsForBridgeRequest(runtimeConfig: BridgeRuntimeConfig): RemoteWorkspaceProjectGrant[] {
  return mergeBridgeStatusProjectGrants([
    ...parseBridgeStatusProjectGrants(runtimeConfig.processEnv.HUNSU_BRIDGE_PROJECT_GRANTS_JSON),
    ...bridgeStatusProjectGrantsFromBridgeAppState(runtimeConfig.processEnv)
  ]);
}

export async function createBridgeStatusForRequest(input: {
  request: IncomingMessage;
  runtimeConfig: BridgeRuntimeConfig;
  providerRegistry: RuntimeProviderRegistry;
  managedRoadmaps: () => RoadmapRegistryWorkspaceEntry[];
  relayRegistryPath?: string;
}): Promise<BridgeStatusResponse> {
  const account = accountStatusForBridgeRequest(input.request, input.runtimeConfig);
  return createBridgeStatus({
    providerRegistry: input.providerRegistry,
    env: input.runtimeConfig.processEnv,
    managedRoadmaps: input.managedRoadmaps(),
    account,
    projectGrants: projectGrantsForBridgeRequest(input.runtimeConfig),
    listRemoteDevices: userId => safeListRemoteBridgeDevicesForRequest(input.request, input.runtimeConfig, {
      relayRegistryPath: input.relayRegistryPath ?? input.runtimeConfig.processEnv.HUNSU_RELAY_REGISTRY_PATH,
      userId
    })
  });
}

export async function createBridgeStatus(input: {
  providerRegistry: RuntimeProviderRegistry;
  env: Record<string, string | undefined>;
  managedRoadmaps: RoadmapRegistryWorkspaceEntry[];
  account: BridgeStatusAccount;
  projectGrants: RemoteWorkspaceProjectGrant[];
  listRemoteDevices: (userId: string | undefined) => Promise<RemoteBridgeDeviceSummary[]>;
}): Promise<BridgeStatusResponse> {
  const provider = await currentRuntimeProviderStatus(input.providerRegistry, input.env);
  const activeWorkspaces = workspaceSummariesFromRoadmaps(input.managedRoadmaps, {
    provider,
    activeOnly: true
  });
  const managedWorkspaces = workspaceSummariesFromRoadmaps(input.managedRoadmaps, {
    provider,
    activeOnly: false
  });
  const connections: BridgeBackendStatus[] = [
    createLocalBackendStatus({
      provider,
      workspaces: activeWorkspaces
    })
  ];

  if (input.account.signedIn) {
    const devices = await input.listRemoteDevices(input.account.userId);
    for (const device of devices) {
      const remoteProvider = remoteProviderStatusFromDevice(device);
      const deviceProjectGrants = device.projectGrants?.length ? device.projectGrants : input.projectGrants;
      const remoteWorkspaces = remoteWorkspaceSnapshotsFromDevice(device, {
        provider: remoteProvider,
        projectGrants: deviceProjectGrants
      });
      connections.push(createRemoteBackendStatus({
        device,
        provider: remoteProvider,
        workspaces: remoteWorkspaces,
        signedIn: true
      }));
    }
  }

  return {
    provider,
    connections,
    workspaces: {
      active: activeWorkspaces,
      managed: managedWorkspaces
    },
    account: input.account
  };
}

function accountStatusFromProcessEnv(env: Record<string, string | undefined>): BridgeStatusResponse["account"] {
  const userId = env.HUNSU_BRIDGE_ACCOUNT_USER_ID?.trim() || undefined;
  const email = env.HUNSU_BRIDGE_ACCOUNT_EMAIL?.trim() || undefined;
  return {
    signedIn: Boolean(userId || email),
    userId,
    email
  };
}

function queryAccountEvidenceAllowed(env: Record<string, string | undefined>): boolean {
  return env.HUNSU_BRIDGE_DEBUG_QUERY_ACCOUNT_EVIDENCE === "1"
    || env.HUNSU_BRIDGE_ALLOW_QUERY_ACCOUNT_EVIDENCE === "1";
}
