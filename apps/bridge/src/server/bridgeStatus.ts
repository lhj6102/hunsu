import type { IncomingMessage } from "node:http";
import type { BridgeRuntimeConfig } from "@hunsu/config";
import type { RuntimeProviderRegistry, RuntimeProviderStatus } from "../runtime-providers/types.ts";
import { createLocalBackendStatus, type BridgeBackendStatus } from "../connections/localConnection.ts";
import {
  workspaceSummariesFromRoadmaps,
  type ConnectedWorkspaceSummary,
  type RoadmapRegistryWorkspaceEntry
} from "../workspaces/workspaceRegistry.ts";
import { bridgeStatusAccountEvidenceFromState } from "./bridgeState.ts";

export type BridgeStatusAccount = {
  signedIn: boolean;
  userId?: string;
  email?: string;
  source?: "daemon" | "env" | "query" | "none";
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
  _request: IncomingMessage,
  runtimeConfig: BridgeRuntimeConfig
): BridgeStatusResponse["account"] {
  const evidence = bridgeStatusAccountEvidenceFromState(runtimeConfig.processEnv);
  if (evidence.signedIn) return { signedIn: true, userId: evidence.userId, source: "daemon" };
  return { signedIn: false, source: evidence.available ? "daemon" : "none" };
}

export async function createBridgeStatusForRequest(input: {
  request: IncomingMessage;
  runtimeConfig: BridgeRuntimeConfig;
  providerRegistry: RuntimeProviderRegistry;
  managedRoadmaps: () => RoadmapRegistryWorkspaceEntry[];
}): Promise<BridgeStatusResponse> {
  return createBridgeStatus({
    providerRegistry: input.providerRegistry,
    env: input.runtimeConfig.processEnv,
    managedRoadmaps: input.managedRoadmaps(),
    account: accountStatusForBridgeRequest(input.request, input.runtimeConfig)
  });
}

export async function createBridgeStatus(input: {
  providerRegistry: RuntimeProviderRegistry;
  env: Record<string, string | undefined>;
  managedRoadmaps: RoadmapRegistryWorkspaceEntry[];
  account: BridgeStatusAccount;
}): Promise<BridgeStatusResponse> {
  const provider = await currentRuntimeProviderStatus(input.providerRegistry, input.env);
  const activeWorkspaces = workspaceSummariesFromRoadmaps(input.managedRoadmaps, { provider, activeOnly: true });
  const managedWorkspaces = workspaceSummariesFromRoadmaps(input.managedRoadmaps, { provider, activeOnly: false });
  return {
    provider,
    connections: [createLocalBackendStatus({ provider, workspaces: activeWorkspaces })],
    workspaces: { active: activeWorkspaces, managed: managedWorkspaces },
    account: input.account
  };
}
