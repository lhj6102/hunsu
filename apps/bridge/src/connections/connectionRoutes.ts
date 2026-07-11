import type { IncomingMessage, ServerResponse } from "node:http";
import type { RuntimeProviderStatus } from "../runtime-providers/types.ts";
import type { BridgeStatusResponse } from "../server/bridgeStatus.ts";
import type { RoadmapRegistryWorkspaceEntry } from "../workspaces/workspaceRegistry.ts";
import {
  disableRemoteBridgePublication,
  enableRemoteBridgePublication,
  type BridgeCommandScope,
  type RemoteBridgeDeviceRecord,
  type RemoteBridgeDeviceStoreAccess,
  type RemoteWorkspaceProjectGrant
} from "./remoteConnection.ts";

type ConnectionRouteContext = {
  bridgeStatus: () => Promise<BridgeStatusResponse>;
  studioConnectionStatus: () => unknown;
  account: () => BridgeStatusResponse["account"];
  currentProvider: () => Promise<RuntimeProviderStatus>;
  remoteDevice: (input: {
    account: BridgeStatusResponse["account"];
    status: RemoteBridgeDeviceRecord["status"];
    provider?: RuntimeProviderStatus;
  }) => RemoteBridgeDeviceRecord;
  relay: () => { relayApiUrl: string; accessToken: string } | undefined;
  deviceStore: RemoteBridgeDeviceStoreAccess;
  managedRoadmaps: () => RoadmapRegistryWorkspaceEntry[];
  publishWorkspaceAccess: (publication: {
    roadmapIds: string[];
    projectGrants: RemoteWorkspaceProjectGrant[];
    scopes: BridgeCommandScope[];
  }) => void;
  deactivateWorkspaceAccess: () => void;
  headlessRemote?: {
    enable: () => Promise<{ deviceId?: string; connection?: string }>;
    disable: () => Promise<{ deviceId?: string; connection?: string }>;
  };
  connectRemote: (body: unknown) => Promise<unknown>;
  readJson: <T>(request: IncomingMessage) => Promise<T>;
  sendJson: (response: ServerResponse, status: number, body: unknown) => void;
};

export async function handleConnectionRoute(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  context: ConnectionRouteContext
): Promise<boolean> {
  if (request.method === "GET" && pathname === "/api/connection/status") {
    context.sendJson(response, 200, context.studioConnectionStatus());
    return true;
  }

  if (request.method === "GET" && pathname === "/api/bridge/status") {
    context.sendJson(response, 200, await context.bridgeStatus());
    return true;
  }

  if (request.method === "GET" && pathname === "/api/connections") {
    const status = await context.bridgeStatus();
    context.sendJson(response, 200, { connections: status.connections });
    return true;
  }

  if (request.method === "GET" && pathname === "/api/connections/local") {
    const status = await context.bridgeStatus();
    context.sendJson(response, 200, { connection: status.connections.find(connection => connection.mode === "local") });
    return true;
  }

  if (request.method === "GET" && pathname === "/api/connections/remote") {
    const status = await context.bridgeStatus();
    context.sendJson(response, 200, { connections: status.connections.filter(connection => connection.mode === "remote") });
    return true;
  }

  if (request.method === "POST" && pathname === "/api/connections/remote/enable") {
    await enableRemoteConnectionRoute(response, context);
    return true;
  }

  if (request.method === "POST" && pathname === "/api/connections/remote/disable") {
    await disableRemoteConnectionRoute(response, context);
    return true;
  }

  if (request.method === "POST" && pathname === "/api/connections/remote/connect") {
    context.sendJson(response, 202, await context.connectRemote(await context.readJson(request)));
    return true;
  }

  return false;
}

async function enableRemoteConnectionRoute(
  response: ServerResponse,
  context: ConnectionRouteContext
): Promise<void> {
  const account = context.account();
  if (!account.signedIn) {
    context.sendJson(response, 401, { error: "login_required", message: "Sign in to Hunsu before enabling Remote Bridge." });
    return;
  }
  if (context.headlessRemote) {
    const remote = await context.headlessRemote.enable();
    const provider = await context.currentProvider();
    const device = {
      ...context.remoteDevice({ account, status: remote.connection === "connected" ? "online" : "offline", provider }),
      ...(remote.deviceId ? { deviceId: remote.deviceId } : {}),
      remoteAccess: "enabled" as const
    };
    const status = await context.bridgeStatus();
    context.sendJson(response, 202, {
      enabled: true,
      device,
      connections: status.connections.filter(connection => connection.mode === "remote")
    });
    return;
  }
  const provider = await context.currentProvider();
  const device = await enableRemoteBridgePublication({
    device: context.remoteDevice({ account, status: "online", provider }),
    roadmaps: context.managedRoadmaps(),
    relay: context.relay(),
    store: context.deviceStore,
    publishWorkspaceAccess: context.publishWorkspaceAccess
  });
  const status = await context.bridgeStatus();
  context.sendJson(response, 202, {
    enabled: true,
    device,
    connections: status.connections.filter(connection => connection.mode === "remote")
  });
}

async function disableRemoteConnectionRoute(
  response: ServerResponse,
  context: ConnectionRouteContext
): Promise<void> {
  const account = context.account();
  if (context.headlessRemote) {
    const remote = await context.headlessRemote.disable();
    const device = {
      ...context.remoteDevice({ account, status: "offline" }),
      ...(remote.deviceId ? { deviceId: remote.deviceId } : {}),
      remoteAccess: "disabled" as const
    };
    const status = await context.bridgeStatus();
    context.sendJson(response, 202, {
      enabled: false,
      device,
      connections: status.connections.filter(connection => connection.mode === "remote")
    });
    return;
  }
  const device = await disableRemoteBridgePublication({
    device: context.remoteDevice({ account, status: "offline" }),
    relay: context.relay(),
    store: context.deviceStore,
    deactivateWorkspaceAccess: context.deactivateWorkspaceAccess
  });
  const status = await context.bridgeStatus();
  context.sendJson(response, 202, {
    enabled: false,
    device,
    connections: status.connections.filter(connection => connection.mode === "remote")
  });
}
