import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { homedir, hostname } from "node:os";
import { dirname } from "node:path";
import { resolveRelayClientConfig, unwrapConfigResult, type BridgeRuntimeConfig } from "@hunsu/config";
import { unavailableProviderCapabilities, type RuntimeProviderStatus } from "../runtime-providers/types.ts";
import type { BridgeBackendStatus } from "./localConnection.ts";
import {
  workspaceLifecycle,
  workspaceSummaryFromRoadmap,
  type ConnectedWorkspaceSummary,
  type RoadmapRegistryWorkspaceEntry
} from "../workspaces/workspaceRegistry.ts";
import {
  DEFAULT_STUDIO_BRIDGE_REQUIREMENT,
  bridgeVersionInfo,
  createDisconnectedStudioConnectionStatus,
  createRemoteStudioConnectionStatus,
  type BridgeCompatibility,
  type StudioConnectionStatus
} from "./studioConnectionStatus.ts";

export type BridgeCommandScope =
  | "execute.start"
  | "artifactAction.run"
  | "env.read"
  | "hostAlias.expose"
  | "remoteRelay.access";

export type RemoteWorkspaceProjectGrant = {
  path: string;
  grantedAt?: string;
  scopes: BridgeCommandScope[];
  active?: boolean;
};

export type RemoteProjectGrantStatus = "granted" | "needs_grant" | "denied";

export type RemoteProjectGrantStatusRequest = {
  deviceId: string;
  projectPath: string;
  requestedScopes?: BridgeCommandScope[];
};

export type RemoteProjectGrantStatusResult = {
  projectAccess: RemoteProjectGrantStatus;
  missingScopes?: BridgeCommandScope[];
  message?: string;
};

export type RelayCommandName =
  | "health"
  | "bridge.status"
  | "connection.status"
  | "provider.inventory"
  | "modelAlias.validate"
  | "modelAlias.resolve"
  | "roadmap.registry.list"
  | "roadmap.registry.remove"
  | "roadmap.open"
  | "roadmap.port.inspect"
  | "roadmap.port.apply"
  | "roadmap.create"
  | "roadmap.board"
  | "roadmap.worktree"
  | "roadmap.skills"
  | "roadmap.commands"
  | "execute.start"
  | "execute.pause"
  | "execute.resume"
  | "execute.stop"
  | "execute.completeMove"
  | "execute.status"
  | "artifactAction.list"
  | "artifactAction.runs"
  | "artifactAction.start"
  | "artifactAction.stop"
  | "moveFile.tree"
  | "moveFile.blob"
  | "moveFile.diff"
  | "hunsuDraft.list"
  | "hunsuDraft.start"
  | "hunsuDraft.get"
  | "hunsuDraft.message"
  | "hunsuDraft.diffArtifact.create"
  | "hunsuDraft.diffArtifact.get"
  | "hunsuDraft.approve"
  | "hunsuDraft.discard"
  | "line.accept"
  | "line.reject"
  | "agentSession.list"
  | "agentSession.get"
  | "agentSession.events"
  | "live.events";

export type RemoteBridgeCommandRequest = {
  deviceId: string;
  command: RelayCommandName;
  projectPath?: string;
  requestedScopes?: BridgeCommandScope[];
  payload?: unknown;
};

export type RemoteBridgeCommandResult =
  | { ok: true; status: number; body?: unknown }
  | { ok: false; status?: number; error?: string; reason?: string; message?: string };

export const defaultRemoteWorkspaceScopes: BridgeCommandScope[] = [
  "remoteRelay.access",
  "execute.start",
  "artifactAction.run",
  "env.read",
  "hostAlias.expose"
];

export type RemoteBridgeDeviceSummary = {
  deviceId: string;
  deviceName?: string;
  name?: string;
  status?: "online" | "offline";
  lastSeenAt?: string;
  userId?: string;
  provider?: RuntimeProviderStatus;
  providerStatus?: RuntimeProviderStatus;
  workspaces?: ConnectedWorkspaceSummary[];
  projectGrants?: RemoteWorkspaceProjectGrant[];
  lastSnapshotAt?: string;
};

export type RemoteBridgeDeviceRecord = RemoteBridgeDeviceSummary & {
  deviceName: string;
  userId: string;
  registeredAt: string;
  status: "online" | "offline";
  remoteAccess?: "enabled" | "disabled";
  bridgeVersion?: string;
  protocolVersion?: string;
};

export type RemoteBridgeDevice = RemoteBridgeDeviceRecord;

export type RemoteBridgeDeviceStore = {
  schema: "hunsu.relay-registry.v1";
  devices: RemoteBridgeDeviceRecord[];
};

export type RemoteBridgeDeviceStoreAccess = {
  read: () => RemoteBridgeDeviceRecord[];
  write: (devices: RemoteBridgeDeviceRecord[]) => void;
};

export type RemoteBridgeConnectRequest = {
  deviceId?: string;
  webUserId?: string;
  projectPath?: string;
  minBridgeVersion?: string;
  requiredProtocolVersion?: string;
  requiredFeatures?: string[];
};

export type RemoteBridgeConnectResult = {
  connection: StudioConnectionStatus;
  device?: RemoteBridgeDeviceRecord;
  compatibility: BridgeCompatibility;
};

export type RelayRequestConfig = {
  relayApiUrl: string;
  accessToken: string;
};

export function listRemoteBridgeDevices(options: { relayRegistryPath?: string; userId?: string } = {}): RemoteBridgeDeviceRecord[] {
  const devices = readRemoteBridgeDeviceStore(options).devices.filter(device => device.remoteAccess !== "disabled");
  return options.userId ? devices.filter(device => device.userId === options.userId) : devices;
}

export async function listRemoteBridgeDevicesForRequest(
  request: IncomingMessage,
  runtimeConfig: BridgeRuntimeConfig,
  options: { relayRegistryPath?: string; userId?: string } = {}
): Promise<RemoteBridgeDeviceRecord[]> {
  const relay = relayRequestConfig(request, runtimeConfig);
  if (!relay) {
    return listRemoteBridgeDevices(options);
  }
  const response = await fetch(new URL("/v1/devices", relay.relayApiUrl), {
    headers: {
      "authorization": `Bearer ${relay.accessToken}`
    }
  });
  const body = await response.json().catch(() => undefined) as { devices?: RemoteBridgeDeviceRecord[]; error?: string } | undefined;
  if (!response.ok) {
    throw new Error(body?.error ?? `Relay device list failed with HTTP ${response.status}.`);
  }
  const devices = Array.isArray(body?.devices) ? body.devices.filter(isRemoteBridgeDevice).filter(device => device.remoteAccess !== "disabled") : [];
  return options.userId ? devices.filter(device => device.userId === options.userId) : devices;
}

export async function safeListRemoteBridgeDevicesForRequest(
  request: IncomingMessage,
  runtimeConfig: BridgeRuntimeConfig,
  options: { relayRegistryPath?: string; userId?: string } = {}
): Promise<RemoteBridgeDeviceRecord[]> {
  try {
    return await listRemoteBridgeDevicesForRequest(request, runtimeConfig, options);
  } catch (_error) {
    return [];
  }
}

export function connectRemoteBridge(
  request: RemoteBridgeConnectRequest,
  options: { relayRegistryPath?: string } = {}
): RemoteBridgeConnectResult {
  const deviceId = request.deviceId?.trim();
  const requirement = studioBridgeRequirementFromRemoteConnectRequest(request);
  if (!deviceId) {
    const compatibility: BridgeCompatibility = { compatible: false, reason: "bridge_update_needed", message: "Choose a Remote Bridge device before connecting." };
    return {
      connection: {
        ...createDisconnectedStudioConnectionStatus("Choose a Remote Bridge device before connecting."),
        compatibility
      },
      compatibility
    };
  }
  const device = listRemoteBridgeDevices(options).find(candidate => candidate.deviceId === deviceId);
  if (!device) {
    const compatibility: BridgeCompatibility = { compatible: false, reason: "bridge_update_needed", message: "Remote Bridge device is not registered." };
    return {
      compatibility,
      connection: remoteBridgeUnavailableConnection(compatibility)
    };
  }
  const account = request.webUserId?.trim()
    ? {
        webUserId: request.webUserId.trim(),
        bridgeUserId: device.userId,
        sameUser: request.webUserId.trim() === device.userId
      }
    : {
        bridgeUserId: device.userId,
        sameUser: undefined
      };
  const connection = createRemoteStudioConnectionStatus({
    device,
    account,
    projectAccess: request.projectPath?.trim() ? "needs_grant" : "not_applicable",
    projectPath: request.projectPath?.trim() || undefined,
    requirement
  });
  return {
    connection,
    device,
    compatibility: connection.compatibility ?? { compatible: true }
  };
}

export async function connectRemoteBridgeForRequest(
  request: RemoteBridgeConnectRequest,
  httpRequest: IncomingMessage,
  runtimeConfig: BridgeRuntimeConfig,
  options: { relayRegistryPath?: string } = {}
): Promise<RemoteBridgeConnectResult> {
  const relay = relayRequestConfig(httpRequest, runtimeConfig);
  if (!relay) {
    return connectRemoteBridge(request, options);
  }
  const devices = await listRemoteBridgeDevicesForRequest(httpRequest, runtimeConfig, options);
  const device = devices.find(candidate => candidate.deviceId === request.deviceId?.trim());
  if (!device) {
    const compatibility: BridgeCompatibility = { compatible: false, reason: "bridge_update_needed", message: "Remote Bridge device is not registered." };
    return {
      compatibility,
      connection: remoteBridgeUnavailableConnection(compatibility)
    };
  }
  const connection = createRemoteStudioConnectionStatus({
    device,
    account: {
      webUserId: request.webUserId,
      bridgeUserId: device.userId,
      sameUser: request.webUserId ? request.webUserId === device.userId : undefined
    },
    projectAccess: await remoteProjectAccessForRequest(request, httpRequest, runtimeConfig),
    projectPath: request.projectPath?.trim() || undefined,
    requirement: studioBridgeRequirementFromRemoteConnectRequest(request)
  });
  return {
    connection,
    device,
    compatibility: connection.compatibility ?? { compatible: true }
  };
}

export async function routeRemoteBridgeCommand(
  command: RemoteBridgeCommandRequest,
  request: IncomingMessage,
  runtimeConfig: BridgeRuntimeConfig
): Promise<RemoteBridgeCommandResult> {
  const relay = relayRequestConfig(request, runtimeConfig);
  if (!relay) {
    return { ok: false, status: 503, error: "Remote Relay is not configured for this Bridge API." };
  }
  const response = await fetch(new URL("/v1/commands", relay.relayApiUrl), {
    method: "POST",
    headers: {
      "authorization": `Bearer ${relay.accessToken}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(command)
  });
  const body = await response.json().catch(() => undefined) as RemoteBridgeCommandResult | undefined;
  if (!body) {
    return { ok: false, status: response.status, error: `Relay command returned HTTP ${response.status}.` };
  }
  return body.status === undefined ? { ...body, status: response.status } : body;
}

export async function streamRemoteBridgeCommand(
  command: RemoteBridgeCommandRequest,
  request: IncomingMessage,
  response: ServerResponse,
  runtimeConfig: BridgeRuntimeConfig,
  options: {
    sendJson: (response: ServerResponse, status: number, body: unknown) => void;
    responseHeaders?: (response: ServerResponse) => Record<string, string>;
  }
): Promise<void> {
  const relay = relayRequestConfig(request, runtimeConfig);
  if (!relay) {
    options.sendJson(response, 503, { ok: false, error: "Remote Relay is not configured for this Bridge API." });
    return;
  }
  const controller = new AbortController();
  request.on("close", () => controller.abort());
  const upstream = await fetch(new URL("/v1/commands/events", relay.relayApiUrl), {
    method: "POST",
    headers: {
      "authorization": `Bearer ${relay.accessToken}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(command),
    signal: controller.signal
  }).catch(error => {
    if (error instanceof Error && error.name === "AbortError") {
      return undefined;
    }
    throw error;
  });
  if (!upstream) {
    return;
  }
  if (!upstream.ok) {
    const body = await upstream.json().catch(() => undefined) as { error?: string; message?: string } | undefined;
    options.sendJson(response, upstream.status, { ok: false, error: body?.error ?? body?.message ?? `Relay event stream returned HTTP ${upstream.status}.` });
    return;
  }
  if (!upstream.body) {
    options.sendJson(response, 502, { ok: false, error: "Relay did not return an event stream." });
    return;
  }
  response.writeHead(200, {
    ...(options.responseHeaders?.(response) ?? {}),
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    "connection": "keep-alive"
  });
  response.flushHeaders?.();
  const reader = upstream.body.getReader();
  try {
    while (!response.destroyed) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      response.write(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
    if (!response.destroyed) {
      response.end();
    }
  }
}

export function remoteBridgeCommandFromEventUrl(url: URL): RemoteBridgeCommandRequest | undefined {
  const raw = url.searchParams.get("command");
  if (!raw) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<RemoteBridgeCommandRequest>;
    return isRemoteBridgeCommandRequest(parsed) ? parsed : undefined;
  } catch (_error) {
    return undefined;
  }
}

export function localRemoteBridgeDevice(
  runtimeConfig: BridgeRuntimeConfig,
  account: { userId?: string; email?: string },
  status: RemoteBridgeDeviceRecord["status"],
  provider?: RuntimeProviderStatus
): RemoteBridgeDeviceRecord {
  const deviceName = runtimeConfig.processEnv.HUNSU_BRIDGE_DEVICE_NAME?.trim() || hostname() || "This computer";
  const deviceId = runtimeConfig.processEnv.HUNSU_BRIDGE_DEVICE_ID?.trim()
    || `local_${createHash("sha256").update(`${deviceName}:${homedir()}`).digest("hex").slice(0, 16)}`;
  return {
    deviceId,
    deviceName,
    userId: account.userId ?? account.email ?? "signed-in-user",
    registeredAt: new Date().toISOString(),
    lastSeenAt: status === "online" ? new Date().toISOString() : undefined,
    status,
    remoteAccess: status === "online" ? "enabled" : "disabled",
    provider,
    bridgeVersion: bridgeVersionInfo().bridgeVersion,
    protocolVersion: bridgeVersionInfo().protocolVersion
  };
}

export function publishRemoteWorkspaceAccess(
  publication: {
    roadmapIds: string[];
    scopes: BridgeCommandScope[];
  },
  options: {
    setWorkspaceRemoteAccess: (request: { roadmapId: string }, remoteAccess: { enabled: boolean; scopes: BridgeCommandScope[] }) => void;
  }
): void {
  for (const roadmapId of publication.roadmapIds) {
    options.setWorkspaceRemoteAccess({ roadmapId }, {
      enabled: true,
      scopes: publication.scopes
    });
  }
}

export function deactivateRemoteWorkspaceAccess(
  roadmaps: RoadmapRegistryWorkspaceEntry[],
  options: {
    setWorkspaceRemoteAccess: (request: { roadmapId: string }, remoteAccess: { enabled: boolean; scopes: BridgeCommandScope[] }) => void;
  }
): void {
  for (const roadmap of roadmaps) {
    if (roadmap.remoteAccess?.enabled !== true && !(roadmap.remoteAccess?.scopes ?? []).includes("remoteRelay.access")) {
      continue;
    }
    options.setWorkspaceRemoteAccess({ roadmapId: roadmap.roadmapId }, {
      enabled: false,
      scopes: (roadmap.remoteAccess?.scopes ?? []).filter(isBridgeCommandScope)
        .filter(scope => scope !== "remoteRelay.access")
    });
  }
}

export function remoteBridgeDeviceStoreAccess(options: { relayRegistryPath?: string } = {}): RemoteBridgeDeviceStoreAccess {
  return {
    read: () => readRemoteBridgeDeviceStore(options).devices,
    write: devices => writeRemoteBridgeDeviceStore({ schema: "hunsu.relay-registry.v1", devices }, options)
  };
}

export function relayRequestConfig(request: IncomingMessage, runtimeConfig: BridgeRuntimeConfig): RelayRequestConfig | undefined {
  const relayConfig = unwrapConfigResult(resolveRelayClientConfig(runtimeConfig.processEnv));
  const relayApiUrl = relayConfig.relayApiUrl;
  const accessToken = requestHeader(request, "x-hunsu-relay-token")
    ?? relayAccessTokenFromAuthorization(request)
    ?? relayAccessTokenFromQuery(request)
    ?? runtimeConfig.processEnv.HUNSU_RELAY_WEB_TOKEN?.trim();
  return relayApiUrl && accessToken
    ? { relayApiUrl, accessToken }
    : undefined;
}

export function createRemoteBackendStatus(input: {
  device: RemoteBridgeDeviceSummary;
  provider?: RuntimeProviderStatus;
  workspaces: ConnectedWorkspaceSummary[];
  signedIn: boolean;
}): BridgeBackendStatus {
  const label = input.device.deviceName ?? input.device.name ?? "Remote Bridge";
  const online = input.device.status === "online";
  return {
    backendId: `remote:${input.device.deviceId}`,
    mode: "remote",
    label,
    device: {
      deviceId: input.device.deviceId,
      name: label,
      registered: true,
      online,
      lastSeenAt: input.device.lastSeenAt
    },
    provider: input.provider ?? remoteProviderStatusFromDevice(input.device),
    connection: !input.signedIn
      ? { state: "login_required" }
      : online
        ? { state: "connected" }
        : { state: "relay_offline" },
    workspaces: input.workspaces
  };
}

export function remoteWorkspaceSnapshotsFromDevice(
  device: RemoteBridgeDeviceSummary,
  input: {
    provider?: RuntimeProviderStatus;
    projectGrants?: RemoteWorkspaceProjectGrant[];
  } = {}
): ConnectedWorkspaceSummary[] {
  const provider = input.provider ?? remoteProviderStatusFromDevice(device);
  const backendId = `remote:${device.deviceId}`;
  const grants = input.projectGrants ?? device.projectGrants ?? [];
  const snapshots = Array.isArray(device.workspaces) ? device.workspaces : [];
  return snapshots.filter(isConnectedWorkspaceSummary).map(workspace => {
    const path = typeof workspace.path === "string" && remoteWorkspacePathGranted(workspace.path, grants)
      ? workspace.path
      : undefined;
    return {
      ...workspace,
      backendId,
      connectionMode: "remote" as const,
      path,
      pathRedacted: workspace.path ? (path === undefined ? true : undefined) : workspace.pathRedacted,
      provider: {
        providerId: provider.providerId,
        label: provider.label,
        readyForExecute: provider.ready
      }
    };
  });
}

export function remoteProviderStatusFromDevice(device: RemoteBridgeDeviceSummary): RuntimeProviderStatus {
  if (isRuntimeProviderStatus(device.provider)) {
    return device.provider;
  }
  if (isRuntimeProviderStatus(device.providerStatus)) {
    return device.providerStatus;
  }
  const label = device.deviceName ?? device.name ?? "Remote Bridge";
  return {
    providerId: `remote:${device.deviceId}:provider`,
    kind: "custom",
    label: "Remote provider",
    description: `Provider status for ${label} has not been reported by Relay yet.`,
    connectionKind: "remote_agent_server",
    installed: false,
    configured: false,
    authenticated: "unknown",
    ready: false,
    auth: {
      kind: "unknown",
      state: "unknown",
      access: "unknown"
    },
    install: {
      installed: false
    },
    usage: {
      available: false
    },
    capabilities: {
      ...unavailableProviderCapabilities,
      supportsRemoteRelay: true
    },
    modelInventory: {
      state: "unavailable",
      reason: "not_reported",
      message: "Remote provider model inventory has not been reported by this Bridge."
    },
    recommendedAction: "recheck",
    safeMessage: "Remote provider status is not available until that Bridge reports it."
  };
}

export function createRemoteWorkspacePublication(
  roadmaps: RoadmapRegistryWorkspaceEntry[],
  input: {
    provider?: RuntimeProviderStatus;
    grantedAt?: string;
    scopes?: BridgeCommandScope[];
  } = {}
): { roadmapIds: string[]; workspaces: ConnectedWorkspaceSummary[]; projectGrants: RemoteWorkspaceProjectGrant[]; scopes: BridgeCommandScope[]; lastSnapshotAt: string } {
  const scopes = uniqueScopes(input.scopes ?? defaultRemoteWorkspaceScopes);
  const grantedAt = input.grantedAt ?? new Date().toISOString();
  const activeRoadmaps = roadmaps.filter(roadmap => workspaceLifecycle(roadmap.lifecycle) === "active");
  const provider = input.provider ?? remoteProviderStatusFromDevice({
    deviceId: "local",
    deviceName: "This computer",
    provider: undefined
  });
  return {
    roadmapIds: activeRoadmaps.map(roadmap => roadmap.roadmapId),
    workspaces: activeRoadmaps.map(roadmap => workspaceSummaryFromRoadmap(roadmap, {
      provider,
      backendId: "local",
      connectionMode: "local",
      redactPath: true
    })),
    projectGrants: activeRoadmaps.map(roadmap => ({
      path: roadmap.repositoryPath,
      grantedAt,
      scopes,
      active: true
    })),
    scopes,
    lastSnapshotAt: grantedAt
  };
}

export async function enableRemoteBridgePublication(input: {
  device: RemoteBridgeDeviceRecord;
  roadmaps: RoadmapRegistryWorkspaceEntry[];
  relay?: {
    relayApiUrl: string;
    accessToken: string;
  };
  store?: RemoteBridgeDeviceStoreAccess;
  publishWorkspaceAccess: (publication: ReturnType<typeof createRemoteWorkspacePublication>) => void;
}): Promise<RemoteBridgeDeviceRecord> {
  const publication = createRemoteWorkspacePublication(input.roadmaps, {
    provider: input.device.provider
  });
  const deviceWithSnapshot: RemoteBridgeDeviceRecord = {
    ...input.device,
    workspaces: publication.workspaces,
    projectGrants: publication.projectGrants,
    lastSnapshotAt: publication.lastSnapshotAt
  };
  if (input.relay) {
    const registered = await registerRemoteBridgeDeviceThroughRelay(input.relay, deviceWithSnapshot, publication);
    input.publishWorkspaceAccess(publication);
    return registered;
  }

  if (!input.store) {
    throw new Error("Remote Bridge device store is required when Relay is not available.");
  }
  const devices = input.store.read();
  const existing = devices.find(candidate => candidate.deviceId === input.device.deviceId);
  const registered: RemoteBridgeDeviceRecord = {
    ...deviceWithSnapshot,
    registeredAt: existing?.registeredAt ?? input.device.registeredAt,
    lastSeenAt: new Date().toISOString(),
    status: "online",
    remoteAccess: "enabled",
    projectGrants: publication.projectGrants,
    workspaces: publication.workspaces,
    lastSnapshotAt: publication.lastSnapshotAt
  };
  input.store.write([registered, ...devices.filter(candidate => candidate.deviceId !== registered.deviceId)]);
  input.publishWorkspaceAccess(publication);
  return registered;
}

export async function disableRemoteBridgePublication(input: {
  device: RemoteBridgeDeviceRecord;
  relay?: {
    relayApiUrl: string;
    accessToken: string;
  };
  store?: RemoteBridgeDeviceStoreAccess;
  deactivateWorkspaceAccess: () => void;
}): Promise<RemoteBridgeDeviceRecord | undefined> {
  const disabledDevice: RemoteBridgeDeviceRecord = {
    ...input.device,
    status: "offline",
    remoteAccess: "disabled",
    projectGrants: [],
    workspaces: [],
    lastSnapshotAt: new Date().toISOString()
  };
  if (input.relay) {
    await disableRemoteBridgeDeviceThroughRelay(input.relay, disabledDevice);
    input.deactivateWorkspaceAccess();
    return disabledDevice;
  }

  if (!input.store) {
    input.deactivateWorkspaceAccess();
    return disabledDevice;
  }
  const devices = input.store.read();
  let updated: RemoteBridgeDeviceRecord | undefined;
  const nextDevices = devices.map(candidate => {
    if (candidate.deviceId !== disabledDevice.deviceId) {
      return candidate;
    }
    updated = {
      ...candidate,
      status: "offline",
      remoteAccess: "disabled",
      projectGrants: [],
      workspaces: [],
      lastSnapshotAt: new Date().toISOString()
    };
    return updated;
  });
  if (!updated) {
    updated = disabledDevice;
    nextDevices.unshift(updated);
  }
  input.store.write(nextDevices);
  input.deactivateWorkspaceAccess();
  return updated;
}

async function registerRemoteBridgeDeviceThroughRelay(
  relay: { relayApiUrl: string; accessToken: string },
  device: RemoteBridgeDeviceRecord,
  publication: ReturnType<typeof createRemoteWorkspacePublication>
): Promise<RemoteBridgeDeviceRecord> {
  const response = await fetch(new URL("/v1/devices", relay.relayApiUrl), {
    method: "POST",
    headers: {
      "authorization": `Bearer ${relay.accessToken}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      device,
      projectGrants: publication.projectGrants,
      workspaces: publication.workspaces,
      lastSnapshotAt: publication.lastSnapshotAt
    })
  });
  const body = await response.json().catch(() => undefined) as { device?: RemoteBridgeDeviceRecord; error?: string; message?: string } | undefined;
  if (!response.ok || !body?.device) {
    throw new Error(body?.error ?? body?.message ?? `Remote Bridge registration failed with HTTP ${response.status}.`);
  }
  return body.device;
}

function remoteWorkspacePathGranted(path: string, projectGrants: RemoteWorkspaceProjectGrant[]): boolean {
  const normalized = normalizeRepositoryPath(path);
  return projectGrants.some(grant =>
    grant.active !== false
    && normalizeRepositoryPath(grant.path) === normalized
    && grant.scopes.includes("remoteRelay.access")
  );
}

function normalizeRepositoryPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

async function disableRemoteBridgeDeviceThroughRelay(
  relay: { relayApiUrl: string; accessToken: string },
  device: RemoteBridgeDeviceRecord
): Promise<void> {
  const response = await fetch(new URL("/v1/devices", relay.relayApiUrl), {
    method: "POST",
    headers: {
      "authorization": `Bearer ${relay.accessToken}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({ device, projectGrants: [] })
  });
  if (!response.ok) {
    const body = await response.json().catch(() => undefined) as { error?: string; message?: string } | undefined;
    throw new Error(body?.error ?? body?.message ?? `Remote Bridge disable failed with HTTP ${response.status}.`);
  }
}

async function remoteProjectAccessForRequest(
  request: RemoteBridgeConnectRequest,
  httpRequest: IncomingMessage,
  runtimeConfig: BridgeRuntimeConfig
): Promise<StudioConnectionStatus["projectAccess"]> {
  const projectPath = request.projectPath?.trim();
  if (!projectPath) {
    return "not_applicable";
  }
  const relay = relayRequestConfig(httpRequest, runtimeConfig);
  if (!relay || !request.deviceId?.trim()) {
    return "needs_grant";
  }
  const response = await fetch(new URL("/v1/project-grants/status", relay.relayApiUrl), {
    method: "POST",
    headers: {
      "authorization": `Bearer ${relay.accessToken}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      deviceId: request.deviceId.trim(),
      projectPath,
      requestedScopes: ["remoteRelay.access"]
    } satisfies RemoteProjectGrantStatusRequest)
  });
  const body = await response.json().catch(() => undefined) as Partial<RemoteProjectGrantStatusResult> | undefined;
  if (!response.ok || (body?.projectAccess !== "granted" && body?.projectAccess !== "needs_grant" && body?.projectAccess !== "denied")) {
    return "denied";
  }
  return body.projectAccess;
}

function studioBridgeRequirementFromRemoteConnectRequest(request: RemoteBridgeConnectRequest) {
  return {
    minBridgeVersion: request.minBridgeVersion?.trim() || DEFAULT_STUDIO_BRIDGE_REQUIREMENT.minBridgeVersion,
    requiredProtocolVersion: request.requiredProtocolVersion?.trim() || DEFAULT_STUDIO_BRIDGE_REQUIREMENT.requiredProtocolVersion,
    requiredFeatures: request.requiredFeatures?.length ? request.requiredFeatures : DEFAULT_STUDIO_BRIDGE_REQUIREMENT.requiredFeatures
  };
}

function remoteBridgeUnavailableConnection(compatibility: BridgeCompatibility): StudioConnectionStatus {
  return {
    mode: "remote",
    transport: "relay",
    health: "disconnected",
    auth: "unknown",
    projectAccess: "not_applicable",
    warnings: ["relay_unavailable"],
    error: "Remote Bridge device is not registered.",
    version: bridgeVersionInfo(),
    compatibility
  };
}

function readRemoteBridgeDeviceStore(options: { relayRegistryPath?: string } = {}): RemoteBridgeDeviceStore {
  const path = remoteBridgeDeviceRegistryPath(options);
  if (!existsSync(path)) {
    return { schema: "hunsu.relay-registry.v1", devices: [] };
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<RemoteBridgeDeviceStore>;
    return {
      schema: "hunsu.relay-registry.v1",
      devices: Array.isArray(parsed.devices) ? parsed.devices.filter(isRemoteBridgeDevice) : []
    };
  } catch (_error) {
    return { schema: "hunsu.relay-registry.v1", devices: [] };
  }
}

function writeRemoteBridgeDeviceStore(store: RemoteBridgeDeviceStore, options: { relayRegistryPath?: string } = {}): void {
  const path = remoteBridgeDeviceRegistryPath(options);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

function remoteBridgeDeviceRegistryPath(options: { relayRegistryPath?: string } = {}): string {
  return options.relayRegistryPath ?? `${homedir()}/.config/hunsu/relay-devices.json`;
}

function isRemoteBridgeCommandRequest(value: unknown): value is RemoteBridgeCommandRequest {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<RemoteBridgeCommandRequest>;
  return typeof candidate.deviceId === "string"
    && candidate.deviceId.trim().length > 0
    && typeof candidate.command === "string"
    && isRelayCommandName(candidate.command);
}

function isRemoteBridgeDevice(value: unknown): value is RemoteBridgeDeviceRecord {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<RemoteBridgeDeviceRecord>;
  return typeof candidate.deviceId === "string"
    && typeof candidate.deviceName === "string"
    && typeof candidate.userId === "string"
    && typeof candidate.registeredAt === "string"
    && (candidate.status === "online" || candidate.status === "offline");
}

function relayAccessTokenFromAuthorization(request: IncomingMessage): string | undefined {
  const authorization = requestHeader(request, "authorization");
  const match = authorization?.match(/^Relay\s+(.+)$/i);
  return match?.[1]?.trim();
}

function relayAccessTokenFromQuery(request: IncomingMessage): string | undefined {
  try {
    const url = new URL(request.url ?? "/", "http://localhost");
    return url.searchParams.get("hunsuRelayToken")?.trim() || undefined;
  } catch (_error) {
    return undefined;
  }
}

function requestHeader(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name.toLowerCase()];
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

export function isRelayCommandName(value: string): value is RelayCommandName {
  return [
    "health",
    "bridge.status",
    "connection.status",
    "provider.inventory",
    "modelAlias.validate",
    "modelAlias.resolve",
    "roadmap.registry.list",
    "roadmap.registry.remove",
    "roadmap.open",
    "roadmap.port.inspect",
    "roadmap.port.apply",
    "roadmap.create",
    "roadmap.board",
    "roadmap.worktree",
    "roadmap.skills",
    "roadmap.commands",
    "execute.start",
    "execute.pause",
    "execute.resume",
    "execute.stop",
    "execute.completeMove",
    "execute.status",
    "artifactAction.list",
    "artifactAction.runs",
    "artifactAction.start",
    "artifactAction.stop",
    "moveFile.tree",
    "moveFile.blob",
    "moveFile.diff",
    "hunsuDraft.list",
    "hunsuDraft.start",
    "hunsuDraft.get",
    "hunsuDraft.message",
    "hunsuDraft.diffArtifact.create",
    "hunsuDraft.diffArtifact.get",
    "hunsuDraft.approve",
    "hunsuDraft.discard",
    "line.accept",
    "line.reject",
    "agentSession.list",
    "agentSession.get",
    "agentSession.events",
    "live.events"
  ].includes(value);
}

export function scopesForRemoteBridgeCommand(command: RelayCommandName): BridgeCommandScope[] {
  switch (command) {
    case "execute.start":
    case "execute.pause":
    case "execute.resume":
    case "execute.stop":
    case "execute.completeMove":
      return ["execute.start", "remoteRelay.access"];
    case "artifactAction.list":
    case "artifactAction.runs":
      return ["env.read", "hostAlias.expose", "remoteRelay.access"];
    case "artifactAction.start":
    case "artifactAction.stop":
      return ["artifactAction.run", "env.read", "hostAlias.expose", "remoteRelay.access"];
    case "health":
    case "bridge.status":
    case "connection.status":
    case "provider.inventory":
    case "modelAlias.validate":
    case "modelAlias.resolve":
    case "roadmap.registry.list":
      return [];
    default:
      return ["remoteRelay.access"];
  }
}

function isRuntimeProviderStatus(value: unknown): value is RuntimeProviderStatus {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<RuntimeProviderStatus>;
  return typeof candidate.providerId === "string"
    && typeof candidate.label === "string"
    && typeof candidate.kind === "string"
    && typeof candidate.ready === "boolean"
    && typeof candidate.auth === "object"
    && candidate.auth !== null
    && typeof candidate.capabilities === "object"
    && candidate.capabilities !== null
    && isRuntimeProviderModelInventory(candidate.modelInventory);
}

function isRuntimeProviderModelInventory(value: unknown): boolean {
  if (typeof value !== "object" || value === null || !("state" in value)) {
    return false;
  }
  const candidate = value as { state?: unknown; models?: unknown; reason?: unknown; message?: unknown };
  if (candidate.state === "available") {
    return Array.isArray(candidate.models) && candidate.models.every(model => {
      if (typeof model !== "object" || model === null) return false;
      const descriptor = model as { model?: unknown; label?: unknown; capabilities?: unknown };
      return typeof descriptor.model === "string"
        && typeof descriptor.label === "string"
        && typeof descriptor.capabilities === "object"
        && descriptor.capabilities !== null;
    });
  }
  return candidate.state === "unavailable"
    && (candidate.reason === "not_reported" || candidate.reason === "not_supported")
    && typeof candidate.message === "string";
}

function isConnectedWorkspaceSummary(value: unknown): value is ConnectedWorkspaceSummary {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<ConnectedWorkspaceSummary>;
  return typeof candidate.workspaceId === "string"
    && typeof candidate.roadmapId === "string"
    && typeof candidate.displayName === "string"
    && (candidate.path === undefined || typeof candidate.path === "string")
    && (candidate.lifecycle === "active"
      || candidate.lifecycle === "inactive"
      || candidate.lifecycle === "missing"
      || candidate.lifecycle === "needs_upgrade"
      || candidate.lifecycle === "error")
    && (candidate.health === "ok"
      || candidate.health === "missing"
      || candidate.health === "needs_upgrade"
      || candidate.health === "error"
      || candidate.health === "unknown")
    && typeof candidate.backendId === "string"
    && (candidate.connectionMode === "local" || candidate.connectionMode === "remote")
    && typeof candidate.provider === "object"
    && candidate.provider !== null
    && typeof candidate.provider.providerId === "string"
    && typeof candidate.provider.label === "string"
    && typeof candidate.provider.readyForExecute === "boolean"
    && Array.isArray(candidate.actions);
}

function uniqueScopes(scopes: BridgeCommandScope[]): BridgeCommandScope[] {
  return [...new Set(scopes)];
}

function isBridgeCommandScope(value: unknown): value is BridgeCommandScope {
  return value === "execute.start"
    || value === "artifactAction.run"
    || value === "env.read"
    || value === "hostAlias.expose"
    || value === "remoteRelay.access";
}
