import {
  type BoardProjection,
  type Command
} from "@hunsu/protocol";
import { roadmapApiPath } from "@/app/routes";
import {
  BRIDGE_API_BASE_URL,
  CONNECT_API_BASE_URL,
  bridgeApiEventUrl,
  bridgeApiRequestHeaders,
  currentRemoteBridgeSession,
  hasBridgeApiAuthToken,
  hasConnectConfigured,
  storeRemoteBridgeSession,
  type RemoteBridgeSession
} from "@/shared/api/bridgeApiBase";
import { fetchConnectDevices, type ConnectDevice } from "@/shared/api/connectClient";
import {
  currentActiveRemotePeer,
  ensureActiveRemotePeer,
  type PeerCommandDescriptor,
  type PeerWorkspaceGrant
} from "@/shared/api/peerTransport";
import type {
  AgentSessionEvent,
  AgentSessionListResult,
  AgentSessionResult,
  ActionRunListResult,
  ActionRunResult,
  ArtifactActionListResult,
  CommandResult,
  FilesystemBrowseResult,
  HunsuDraftDiffArtifactResult,
  HunsuDraftResult,
  HunsuDraftListResult,
  MoveCompletionResult,
  RoadmapListResult,
  RoadmapOpenResult,
  RoadmapRegistryEntry,
  RunListResult,
  RunResult,
  SkillListResult,
  StudioLiveEvent,
  AgentSession,
  BridgeStatusResponse,
  FilesystemGrantResult,
  MoveFileBlob,
  MoveFileBlobResult,
  MoveFileDiff,
  MoveFileDiffResult,
  MoveFileTree,
  MoveFileTreeResult,
  ModelAlias,
  ModelAliasInventoryResult,
  ModelAliasResolutionResult,
  ModelAliasResolveRequest,
  ProviderInventory,
  ProjectInspectionResult,
  RemoteBridgeConnectRequest,
  RemoteBridgeConnectResult,
  RemoteBridgeDevice,
  RemoteBridgeDeviceListResult,
  StudioRunSummary,
  StudioSkillSummary,
  WorktreeStatus
} from "@/shared/api/bridgeTypes";
import { isUsableRemoteStudioConnectionStatus } from "@/shared/api/studioConnectionStatus";

const SERVER_URL = BRIDGE_API_BASE_URL;

export class BridgeRequestError extends Error {
  constructor(message: string, readonly status: number, readonly body: unknown) {
    super(message);
    this.name = "BridgeRequestError";
  }
}

async function requestJson<T>(path: string, init?: RequestInit, label = "Bridge API request"): Promise<T> {
  const method = init?.method?.toUpperCase() ?? "GET";
  const body = parseRequestBody(init?.body);
  const remoteCommand = remoteBridgeCommandForRequest(path, method, body, currentRoutableRemoteBridgeSessionForRequest(path, body));
  if (remoteCommand) {
    return requestRemoteJson<T>(remoteCommand, label);
  }
  const remoteStatusFallback = remoteBridgeStatusFallbackCommand(path, method, body);
  let response: Response;
  try {
    response = await fetch(`${SERVER_URL}${path}`, {
      ...init,
      headers: bridgeApiRequestHeaders(init?.headers)
    });
  } catch (error) {
    if (remoteStatusFallback) {
      return requestRemoteJson<T>(remoteStatusFallback, label);
    }
    throw error;
  }
  if (!response.ok) {
    const result = await response.json().catch(() => ({ error: `${label} failed with ${response.status}` }));
    if (remoteStatusFallback) {
      return requestRemoteJson<T>(remoteStatusFallback, label);
    }
    const message = typeof result.message === "string"
      ? result.message
      : typeof result.error === "string"
        ? result.error
        : `${label} failed with ${response.status}`;
    throw new BridgeRequestError(message, response.status, result);
  }
  return response.json() as Promise<T>;
}

function remoteBridgeStatusFallbackCommand(path: string, method: string, body: unknown): RemoteBridgeCommandRequest | undefined {
  if (method !== "GET") {
    return undefined;
  }
  const pathname = new URL(path, "http://hunsu.local").pathname;
  if (pathname !== "/api/bridge/status") {
    return undefined;
  }
  return remoteBridgeCommandForRequest(path, method, body, currentRemoteBridgeSession());
}

async function requestRemoteJson<T>(command: RemoteBridgeCommandRequest, label: string): Promise<T> {
  const peer = currentActiveRemotePeer();
  if (!peer || peer.device.deviceId !== command.deviceId) {
    throw new Error(`${label} requires an authenticated Remote Bridge peer.`);
  }
  const body = await peer.request<unknown>(command.workspaceId, command.command);
  return normalizeRemoteCommandBody<T>(command, body);
}

function normalizeRemoteCommandBody<T>(command: RemoteBridgeCommandRequest, body: unknown): T {
  if (command.command.name !== "bridge.status") {
    return sanitizeRemotePayload(body) as T;
  }
  return normalizeRemoteBridgeStatus(body, currentRemoteBridgeSession() ?? {
    deviceId: command.deviceId,
    workspaceId: command.workspaceId
  }) as T;
}

function normalizeRemoteBridgeStatus(body: unknown, session: RemoteBridgeSession): unknown {
  const safeBody = sanitizeRemotePayload(body);
  if (!isBridgeStatusLike(safeBody)) {
    return safeBody;
  }
  const local = safeBody.connections.find(connection => connection.mode === "local") ?? safeBody.connections[0];
  const label = session.deviceLabel ?? local?.label ?? "Remote Bridge";
  const normalizeWorkspace = (workspace: BridgeStatusResponse["workspaces"]["active"][number]) => {
    const granted = typeof session.workspaceId === "string" && workspace.workspaceId === session.workspaceId;
    return {
      ...workspace,
      backendId: `remote:${session.deviceId}`,
      connectionMode: "remote" as const,
      path: undefined,
      pathRedacted: true,
      displayName: granted && session.workspaceLabel ? session.workspaceLabel : workspace.displayName
    };
  };
  const workspaces = (local?.workspaces ?? safeBody.workspaces.active).map(normalizeWorkspace);
  return {
    ...safeBody,
    connections: [{
      ...(local ?? {}),
      backendId: `remote:${session.deviceId}`,
      mode: "remote" as const,
      label,
      device: {
        deviceId: session.deviceId,
        name: label,
        registered: true,
        online: true,
        lastSeenAt: new Date().toISOString()
      },
      connection: { state: "connected" as const },
      workspaces
    }],
    workspaces: {
      active: workspaces,
      managed: safeBody.workspaces.managed.map(normalizeWorkspace)
    },
    account: {
      signedIn: true
    }
  };
}

function isBridgeStatusLike(value: unknown): value is BridgeStatusResponse {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<BridgeStatusResponse>;
  return Boolean(candidate.provider)
    && Array.isArray(candidate.connections)
    && typeof candidate.workspaces === "object"
    && candidate.workspaces !== null;
}

function postJson<T>(path: string, body: unknown, label: string): Promise<T> {
  return requestJson<T>(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  }, label);
}

export async function fetchRoadmapRegistry(): Promise<RoadmapRegistryEntry[]> {
  const result = await requestJson<RoadmapListResult>("/api/roadmaps/recent", undefined, "Roadmap registry request");
  return result.roadmaps;
}

export async function fetchBridgeStatus(): Promise<BridgeStatusResponse> {
  const status = await requestJson<BridgeStatusResponse>("/api/bridge/status", undefined, "Bridge status request");
  const session = currentRemoteBridgeSession();
  if (!session || !status.connections.some(connection => connection.mode === "local")) {
    return status;
  }
  const command = remoteBridgeCommandForRequest("/api/bridge/status", "GET", undefined, session);
  if (!command) {
    return status;
  }
  try {
    const remoteStatus = await requestRemoteJson<BridgeStatusResponse>(command, "Remote Bridge status request");
    return mergeBridgeStatuses(status, remoteStatus);
  } catch (_error) {
    return status;
  }
}

export async function fetchModelInventory(backendId?: string): Promise<ProviderInventory> {
  const path = backendId?.trim()
    ? `/api/providers/inventory?backendId=${encodeURIComponent(backendId.trim())}`
    : "/api/providers/inventory";
  const result = await requestJson<ModelAliasInventoryResult>(path, undefined, "Provider model inventory request");
  if (!result.ok) {
    throw new BridgeRequestError(result.error.message, 409, result);
  }
  return result.value;
}

export function validateModelAliases(body: ModelAliasResolveRequest): Promise<ModelAliasResolutionResult> {
  return postJson<ModelAliasResolutionResult>("/api/model-aliases/validate", body, "Model alias validation request");
}

export function resolveModelAlias(body: ModelAliasResolveRequest): Promise<ModelAliasResolutionResult> {
  return postJson<ModelAliasResolutionResult>("/api/model-aliases/resolve", body, "Model alias resolve request");
}

function mergeBridgeStatuses(localStatus: BridgeStatusResponse, remoteStatus: BridgeStatusResponse): BridgeStatusResponse {
  const remoteConnections = remoteStatus.connections.filter(connection => connection.mode === "remote");
  if (remoteConnections.length === 0) {
    return localStatus;
  }
  const remoteBackendIds = new Set(remoteConnections.map(connection => connection.backendId));
  return {
    ...localStatus,
    connections: mergeByReplacing(localStatus.connections, remoteConnections, connection => connection.backendId),
    workspaces: {
      active: [
        ...localStatus.workspaces.active.filter(workspace => !remoteBackendIds.has(workspace.backendId)),
        ...remoteStatus.workspaces.active
      ],
      managed: [
        ...localStatus.workspaces.managed.filter(workspace => !remoteBackendIds.has(workspace.backendId)),
        ...remoteStatus.workspaces.managed
      ]
    },
    account: {
      signedIn: localStatus.account.signedIn || remoteStatus.account.signedIn,
      userId: localStatus.account.userId ?? remoteStatus.account.userId,
      email: localStatus.account.email ?? remoteStatus.account.email
    }
  };
}

function mergeByReplacing<T>(left: T[], right: T[], key: (value: T) => string): T[] {
  const replacements = new Map(right.map(item => [key(item), item]));
  const seen = new Set<string>();
  const merged = left.map(item => {
    const itemKey = key(item);
    const replacement = replacements.get(itemKey);
    seen.add(itemKey);
    return replacement ?? item;
  });
  for (const item of right) {
    const itemKey = key(item);
    if (!seen.has(itemKey)) {
      seen.add(itemKey);
      merged.push(item);
    }
  }
  return merged;
}

export async function postRoadmapRegistryRemove(input: { roadmapId?: string; path?: string }): Promise<RoadmapRegistryEntry[]> {
  const result = await postJson<RoadmapListResult & { removed?: boolean }>("/api/roadmaps/recent/remove", input, "Roadmap registry remove");
  return result.roadmaps;
}

export function fetchFilesystemBrowse(path?: string, rootId?: string): Promise<FilesystemBrowseResult> {
  const params = new URLSearchParams();
  if (path) params.set("path", path);
  if (rootId) params.set("rootId", rootId);
  const suffix = params.size > 0 ? `?${params.toString()}` : "";
  return requestJson<FilesystemBrowseResult>(`/api/filesystem/browse${suffix}`, undefined, "Folder browse");
}

export function postFilesystemGrant(rootId: string | undefined, path: string): Promise<FilesystemGrantResult> {
  return postJson<FilesystemGrantResult>("/api/filesystem/grants", { rootId, path }, "Folder grant");
}

type RoadmapPathInput = { browseToken: string; path?: string; title?: string };

export function postRoadmapOpen(input: string | RoadmapPathInput): Promise<RoadmapOpenResult> {
  return postJson<RoadmapOpenResult>("/api/roadmaps/open", typeof input === "string" ? { path: input } : input, "Roadmap open");
}

export function postRoadmapCreate(input: string | RoadmapPathInput): Promise<RoadmapOpenResult> {
  return postJson<RoadmapOpenResult>("/api/roadmaps/create", typeof input === "string" ? { path: input } : input, "Roadmap create");
}

export function postRoadmapPortInspect(input: string | RoadmapPathInput): Promise<unknown> {
  return postJson<unknown>("/api/roadmaps/port/inspect", typeof input === "string" ? { path: input } : input, "Roadmap port inspect");
}

export function postRoadmapPortApply(body: unknown): Promise<RoadmapOpenResult> {
  return postJson<RoadmapOpenResult>("/api/roadmaps/port/apply", body, "Roadmap port apply");
}

export async function postProjectInspect(input: string | { browseToken?: string; path?: string }): Promise<ProjectInspectionResult["project"]> {
  const result = await postJson<ProjectInspectionResult>("/api/projects/inspect", typeof input === "string" ? { path: input } : input, "Project inspection");
  return result.project;
}

export async function fetchRemoteBridgeDevices(): Promise<RemoteBridgeDeviceListResult["devices"]> {
  if (!hasConnectConfigured()) {
    return [];
  }
  return (await fetchConnectDevices()).map(device => remoteDeviceFromConnect(device));
}

export async function connectRemoteBridgeDevice(deviceId: string): Promise<RemoteBridgeDevice> {
  const devices = await fetchConnectDevices();
  const connectDevice = devices.find(candidate => candidate.deviceId === deviceId);
  if (!connectDevice) throw new Error("Remote Bridge device is not registered.");
  if (connectDevice.status !== "online") throw new Error("Remote Bridge device is offline.");
  const peer = await ensureActiveRemotePeer(connectDevice);
  return remoteDeviceFromConnect(connectDevice, peer.grantedWorkspaces());
}

export async function postRemoteBridgeConnect(input: RemoteBridgeConnectRequest): Promise<RemoteBridgeConnectResult> {
  if (!hasConnectConfigured()) {
    throw new Error("Hunsu Connect is not configured for this Studio deployment.");
  }
  const device = await connectRemoteBridgeDevice(input.deviceId);
  const workspace = device.workspaces?.find(candidate => candidate.workspaceId === input.workspaceId);
  if (!workspace) throw new Error("Bridge did not grant this Workspace to the peer session.");
  const compatibility = remoteCompatibility(device, input);
  const result: RemoteBridgeConnectResult = {
    device,
    compatibility,
    connection: {
      mode: "remote",
      transport: "p2p",
      health: compatibility.compatible ? "connected" : "error",
      auth: "paired",
      projectAccess: "granted",
      bridge: {
        id: device.deviceId,
        name: device.deviceName,
        version: device.bridgeVersion,
        protocolVersion: device.protocolVersion,
        lastSeenAt: device.lastSeenAt
      },
      endpoint: { connectLabel: CONNECT_API_BASE_URL || "Hunsu Connect" },
      project: { roadmapId: workspace.roadmapId, displayName: workspace.displayName },
      warnings: compatibility.compatible ? [] : ["version_mismatch"],
      error: compatibility.compatible ? undefined : compatibility.message,
      version: {
        bridgeVersion: device.bridgeVersion ?? "unknown",
        protocolVersion: device.protocolVersion,
        supportedFeatures: ["remote-peer"]
      },
      compatibility
    }
  };
  if (shouldStoreRemoteBridgeSession(result)) {
    storeRemoteBridgeSession({
      deviceId: result.device.deviceId,
      deviceLabel: result.device.deviceName,
      workspaceId: input.workspaceId,
      workspaceLabel: input.workspaceLabel
    });
  }
  return result;
}

function shouldStoreRemoteBridgeSession(result: RemoteBridgeConnectResult): result is RemoteBridgeConnectResult & { device: NonNullable<RemoteBridgeConnectResult["device"]> } {
  return Boolean(result.device)
    && result.compatibility.compatible
    && isUsableRemoteStudioConnectionStatus(result.connection);
}

export function fetchBoard(roadmapId: string): Promise<BoardProjection> {
  return requestJson<BoardProjection>(roadmapApiPath(roadmapId, "/board"), undefined, "Board request");
}

export async function fetchRuns(roadmapId: string): Promise<StudioRunSummary[]> {
  const result = await requestJson<RunListResult>(roadmapApiPath(roadmapId, "/runs"), undefined, "Runs request");
  return result.runs;
}

export async function fetchAgentSessions(roadmapId: string): Promise<AgentSession[]> {
  const result = await requestJson<AgentSessionListResult>(roadmapApiPath(roadmapId, "/agent-sessions"), undefined, "Agent sessions request");
  return result.sessions;
}

export async function fetchAgentSession(roadmapId: string, sessionId: string): Promise<AgentSession> {
  const result = await requestJson<AgentSessionResult>(roadmapApiPath(roadmapId, `/agent-sessions/${encodeURIComponent(sessionId)}`), undefined, "Agent session request");
  return result.session;
}

export async function fetchSkills(roadmapId: string): Promise<StudioSkillSummary[]> {
  const result = await requestJson<SkillListResult>(roadmapApiPath(roadmapId, "/skills"), undefined, "Skills request");
  return result.skills;
}

export function fetchWorktree(roadmapId: string): Promise<WorktreeStatus> {
  return requestJson<WorktreeStatus>(roadmapApiPath(roadmapId, "/worktree"), undefined, "Worktree request");
}

export async function fetchMoveFileTree(roadmapId: string, moveId: string, path?: string): Promise<MoveFileTree> {
  const query = path ? `?path=${encodeURIComponent(path)}` : "";
  const result = await requestJson<MoveFileTreeResult>(roadmapApiPath(roadmapId, `/moves/${encodeURIComponent(moveId)}/files/tree${query}`), undefined, "MOVE file tree");
  return result.tree;
}

export async function fetchMoveFileBlob(roadmapId: string, moveId: string, path: string): Promise<MoveFileBlob> {
  const result = await requestJson<MoveFileBlobResult>(roadmapApiPath(roadmapId, `/moves/${encodeURIComponent(moveId)}/files/blob?path=${encodeURIComponent(path)}`), undefined, "MOVE file blob");
  return result.blob;
}

export async function fetchMoveFileDiff(roadmapId: string, moveId: string): Promise<MoveFileDiff> {
  const result = await requestJson<MoveFileDiffResult>(roadmapApiPath(roadmapId, `/moves/${encodeURIComponent(moveId)}/files/diff`), undefined, "MOVE file diff");
  return result.diff;
}

export function postCommands(roadmapId: string, commands: Command[]): Promise<CommandResult> {
  return postJson<CommandResult>(roadmapApiPath(roadmapId, "/commands"), { commands }, "Command");
}

export function postHunsuDraftStart(roadmapId: string, body: { sourceNodeId?: string; sourceMoveId?: string; sourceLineId?: string; message?: string; aliases?: ModelAlias[] }): Promise<HunsuDraftResult> {
  return postJson<HunsuDraftResult>(roadmapApiPath(roadmapId, "/hunsu/drafts"), body, "HUNSU Draft start");
}

export async function fetchHunsuDrafts(roadmapId: string): Promise<HunsuDraftResult["draft"][]> {
  const result = await requestJson<HunsuDraftListResult>(roadmapApiPath(roadmapId, "/hunsu/drafts"), undefined, "HUNSU Draft list");
  return result.drafts;
}

export function postHunsuDraftMessage(roadmapId: string, draftSessionId: string, message: string): Promise<HunsuDraftResult> {
  return postJson<HunsuDraftResult>(roadmapApiPath(roadmapId, `/hunsu/drafts/${encodeURIComponent(draftSessionId)}/messages`), { message }, "HUNSU Draft message");
}

export async function fetchHunsuDraftDiffArtifact(roadmapId: string, draftSessionId: string, diffArtifactId: string): Promise<HunsuDraftDiffArtifactResult["diffArtifact"]> {
  const result = await requestJson<HunsuDraftDiffArtifactResult>(roadmapApiPath(roadmapId, `/hunsu/drafts/${encodeURIComponent(draftSessionId)}/diff-artifacts/${encodeURIComponent(diffArtifactId)}`), undefined, "HUNSU Draft DiffArtifact");
  return result.diffArtifact;
}

export function postHunsuDraftApprove(roadmapId: string, draftSessionId: string, diffArtifactId: string, teamName: string): Promise<HunsuDraftResult> {
  return postJson<HunsuDraftResult>(roadmapApiPath(roadmapId, `/hunsu/drafts/${encodeURIComponent(draftSessionId)}/approve`), { diffArtifactId, teamName }, "HUNSU Draft approve");
}

export function postHunsuDraftDiscard(roadmapId: string, draftSessionId: string): Promise<HunsuDraftResult> {
  return postJson<HunsuDraftResult>(roadmapApiPath(roadmapId, `/hunsu/drafts/${encodeURIComponent(draftSessionId)}/discard`), {}, "HUNSU Draft discard");
}

export function postRunAction(roadmapId: string, action: "start" | "pause" | "resume" | "stop", body: unknown): Promise<RunResult> {
  const nextBody = action === "start" ? executeStartBodyWithSelectedBackend(roadmapId, body) : body;
  return postJson<RunResult>(roadmapApiPath(roadmapId, `/runs/${action}`), nextBody, "Run action");
}

export function postLineDecision(roadmapId: string, decision: "accept" | "reject", body: { lineId: string; reason?: string }): Promise<CommandResult> {
  return postJson<CommandResult>(roadmapApiPath(roadmapId, `/lines/${decision}`), body, `Line ${decision}`);
}

export function postMoveCompletion(roadmapId: string, body: {
  runId: string;
  fromRef: string;
  summary: string;
  destinationIds: string[];
  evidence: string[];
  risks: string[];
  approvedRisks: boolean;
}): Promise<MoveCompletionResult> {
  return postJson<MoveCompletionResult>(roadmapApiPath(roadmapId, "/runs/complete-move"), body, "MOVE completion");
}

export async function fetchArtifactActions(roadmapId: string) {
  const result = await requestJson<ArtifactActionListResult>(roadmapApiPath(roadmapId, "/artifact-actions"), undefined, "Artifact Action list");
  return result.actions;
}

export async function fetchActionRuns(roadmapId: string) {
  const result = await requestJson<ActionRunListResult>(roadmapApiPath(roadmapId, "/action-runs"), undefined, "Artifact Action Run list");
  return result.runs;
}

export function postArtifactActionRun(roadmapId: string, actionId: string, body: unknown): Promise<ActionRunResult> {
  return postJson<ActionRunResult>(roadmapApiPath(roadmapId, `/artifact-actions/${encodeURIComponent(actionId)}/runs`), body, "Artifact Action Run start");
}

export function postActionRunStop(roadmapId: string, runId: string): Promise<ActionRunResult> {
  return postJson<ActionRunResult>(roadmapApiPath(roadmapId, `/action-runs/${encodeURIComponent(runId)}/stop`), {}, "Artifact Action Run stop");
}

export function subscribeRunEvents(roadmapId: string, onEvent: (event: StudioLiveEvent) => void, onError: () => void): () => void {
  const remoteCommand = remoteBridgeCommandForRequest(roadmapApiPath(roadmapId, "/runs/events"), "GET", undefined, currentRemoteBridgeSession() ?? currentRoutableRemoteBridgeSession());
  if (remoteCommand) {
    return subscribeRemoteCommand(remoteCommand, onEvent, onError);
  }
  const source = new EventSource(bridgeApiEventUrl(roadmapApiPath(roadmapId, "/runs/events")));
  const handleEvent = (event: Event) => {
    const message = event as MessageEvent<string>;
    try {
      onEvent(JSON.parse(message.data) as StudioLiveEvent);
    } catch {
      onError();
    }
  };
  source.addEventListener("runs.snapshot", handleEvent);
  source.addEventListener("run.updated", handleEvent);
  source.addEventListener("message", handleEvent);
  source.onerror = () => onError();
  return () => {
    source.removeEventListener("runs.snapshot", handleEvent);
    source.removeEventListener("run.updated", handleEvent);
    source.removeEventListener("message", handleEvent);
    source.close();
  };
}

export function subscribeAgentSessionEvents(roadmapId: string, sessionId: string, onEvent: (event: AgentSessionEvent) => void, onError: () => void): () => void {
  const remoteCommand = remoteBridgeCommandForRequest(roadmapApiPath(roadmapId, `/agent-sessions/${encodeURIComponent(sessionId)}/events`), "GET", undefined, currentRemoteBridgeSession() ?? currentRoutableRemoteBridgeSession());
  if (remoteCommand) {
    return subscribeRemoteCommand(remoteCommand, onEvent, onError);
  }
  const source = new EventSource(bridgeApiEventUrl(roadmapApiPath(roadmapId, `/agent-sessions/${encodeURIComponent(sessionId)}/events`)));
  let closed = false;
  const handleEvent = (event: Event) => {
    if (closed) return;
    const message = event as MessageEvent<string>;
    try {
      onEvent(JSON.parse(message.data) as AgentSessionEvent);
    } catch {
      onError();
    }
  };
  source.addEventListener("agentSession.snapshot", handleEvent);
  source.addEventListener("agentSession.lifecycle", handleEvent);
  source.addEventListener("agentMessage.delta", handleEvent);
  source.addEventListener("agentMessage.completed", handleEvent);
  source.onerror = () => {
    if (!closed) {
      onError();
    }
  };
  return () => {
    closed = true;
    source.removeEventListener("agentSession.snapshot", handleEvent);
    source.removeEventListener("agentSession.lifecycle", handleEvent);
    source.removeEventListener("agentMessage.delta", handleEvent);
    source.removeEventListener("agentMessage.completed", handleEvent);
    source.onerror = null;
    source.close();
  };
}

export type RemoteBridgeCommandRequest = {
  deviceId: string;
  workspaceId: string;
  command: PeerCommandDescriptor;
};

export function remoteBridgeCommandForRequest(
  path: string,
  method: string,
  body: unknown,
  session: RemoteBridgeSession | undefined
): RemoteBridgeCommandRequest | undefined {
  const requestUrl = new URL(path, "http://hunsu.local");
  const pathname = requestUrl.pathname;
  if (!session || !session.workspaceId?.trim() || pathname.startsWith("/api/remote/")) {
    return undefined;
  }
  const backendSelection = selectedWebBridgeBackend(requestUrl, body);
  if (backendSelection.explicit && !selectionTargetsRemoteSession(backendSelection, session)) {
    return undefined;
  }
  const payload = objectBody(body);
  const roadmapMatch = pathname.match(/^\/api\/roadmaps\/([^/]+)(\/.*)?$/);
  const roadmapId = roadmapMatch ? decodeURIComponent(roadmapMatch[1] ?? "") : undefined;
  const suffix = roadmapMatch?.[2] ?? "";
  const workspaceId = selectedWorkspaceId(payload, session, roadmapId);
  if (method === "GET" && pathname === "/api/roadmaps/recent") {
    return remoteCommand(session, "roadmap.registry.list");
  }
  if (method === "GET" && pathname === "/api/bridge/status") {
    return remoteCommand(session, "bridge.status");
  }
  if (method === "GET" && pathname === "/api/providers/inventory") {
    const backendId = requestUrl.searchParams.get("backendId")?.trim();
    return remoteCommand(session, "provider.inventory", backendId ? { backendId } : undefined);
  }
  if (method === "POST" && pathname === "/api/model-aliases/validate") {
    return remoteCommand(session, "modelAlias.validate", body);
  }
  if (method === "POST" && pathname === "/api/model-aliases/resolve") {
    return remoteCommand(session, "modelAlias.resolve", body);
  }
  if (method === "POST" && pathname === "/api/roadmaps/recent/remove") {
    return workspaceId ? remoteCommand(session, "roadmap.registry.remove", body, workspaceId) : undefined;
  }
  if (method === "POST" && pathname === "/api/roadmaps/open") {
    return workspaceId ? remoteCommand(session, "roadmap.open", body, workspaceId) : undefined;
  }
  if (method === "POST" && pathname === "/api/roadmaps/create") {
    return workspaceId ? remoteCommand(session, "roadmap.create", body, workspaceId) : undefined;
  }
  if (method === "POST" && pathname === "/api/roadmaps/port/inspect") {
    return workspaceId ? remoteCommand(session, "roadmap.port.inspect", body, workspaceId) : undefined;
  }
  if (method === "POST" && pathname === "/api/roadmaps/port/apply") {
    return workspaceId ? remoteCommand(session, "roadmap.port.apply", body, workspaceId) : undefined;
  }
  if (!roadmapId || !workspaceId) {
    return undefined;
  }
  if (method === "GET" && suffix === "/board") {
    return remoteCommand(session, "roadmap.board", { roadmapId }, workspaceId);
  }
  if (method === "GET" && suffix === "/worktree") {
    return remoteCommand(session, "roadmap.worktree", { roadmapId }, workspaceId);
  }
  if (method === "GET" && suffix === "/skills") {
    return remoteCommand(session, "roadmap.skills", { roadmapId }, workspaceId);
  }
  if (method === "POST" && suffix === "/commands") {
    return remoteCommand(session, "roadmap.commands", payloadWithRoadmapId(payload, roadmapId), workspaceId);
  }
  if (method === "GET" && suffix === "/runs") {
    return remoteCommand(session, "execute.status", { roadmapId }, workspaceId);
  }
  if (method === "GET" && suffix === "/runs/events") {
    return remoteCommand(session, "live.events", { roadmapId }, workspaceId);
  }
  if (method === "POST" && suffix === "/runs/start") {
    return remoteCommand(session, "execute.start", payloadWithRoadmapId(payload, roadmapId), workspaceId);
  }
  if (method === "POST" && suffix === "/runs/pause") {
    return remoteCommand(session, "execute.pause", payloadWithRoadmapId(payload, roadmapId), workspaceId);
  }
  if (method === "POST" && suffix === "/runs/resume") {
    return remoteCommand(session, "execute.resume", payloadWithRoadmapId(payload, roadmapId), workspaceId);
  }
  if (method === "POST" && suffix === "/runs/stop") {
    return remoteCommand(session, "execute.stop", payloadWithRoadmapId(payload, roadmapId), workspaceId);
  }
  if (method === "POST" && suffix === "/runs/complete-move") {
    return remoteCommand(session, "execute.completeMove", payloadWithRoadmapId(payload, roadmapId), workspaceId);
  }
  if (method === "GET" && suffix === "/artifact-actions") {
    return remoteCommand(session, "artifactAction.list", { roadmapId }, workspaceId);
  }
  if (method === "GET" && suffix === "/action-runs") {
    return remoteCommand(session, "artifactAction.runs", { roadmapId }, workspaceId);
  }
  const artifactStart = suffix.match(/^\/artifact-actions\/([^/]+)\/runs$/);
  if (method === "POST" && artifactStart) {
    return remoteCommand(session, "artifactAction.start", { ...(payload ?? {}), roadmapId, actionId: decodeURIComponent(artifactStart[1] ?? "") }, workspaceId);
  }
  const artifactStop = suffix.match(/^\/action-runs\/([^/]+)\/stop$/);
  if (method === "POST" && artifactStop) {
    return remoteCommand(session, "artifactAction.stop", { ...(payload ?? {}), roadmapId, runId: decodeURIComponent(artifactStop[1] ?? "") }, workspaceId);
  }
  const moveFilesRoute = suffix.match(/^\/moves\/([^/]+)\/files\/(tree|blob|diff)$/);
  if (method === "GET" && moveFilesRoute) {
    const action = moveFilesRoute[2];
    return remoteCommand(
      session,
      action === "tree" ? "moveFile.tree" : action === "blob" ? "moveFile.blob" : "moveFile.diff",
      {
        roadmapId,
        moveId: decodeURIComponent(moveFilesRoute[1] ?? ""),
        path: requestUrl.searchParams.get("path") ?? undefined
      },
      workspaceId
    );
  }
  if (method === "GET" && suffix === "/hunsu/drafts") {
    return remoteCommand(session, "hunsuDraft.list", { roadmapId }, workspaceId);
  }
  if (method === "POST" && suffix === "/hunsu/drafts") {
    return remoteCommand(session, "hunsuDraft.start", payloadWithRoadmapId(payload, roadmapId), workspaceId);
  }
  const hunsuDraft = suffix.match(/^\/hunsu\/drafts\/([^/]+)(?:\/(messages|diff-artifacts|approve|discard))?$/);
  if (hunsuDraft) {
    const draftSessionId = decodeURIComponent(hunsuDraft[1] ?? "");
    const action = hunsuDraft[2];
    if (method === "GET" && !action) {
      return remoteCommand(session, "hunsuDraft.get", { roadmapId, draftSessionId }, workspaceId);
    }
    if (method === "POST" && action === "messages") {
      return remoteCommand(session, "hunsuDraft.message", { ...(payload ?? {}), roadmapId, draftSessionId }, workspaceId);
    }
    if (method === "POST" && action === "diff-artifacts") {
      return remoteCommand(session, "hunsuDraft.diffArtifact.create", { ...(payload ?? {}), roadmapId, draftSessionId }, workspaceId);
    }
    if (method === "POST" && action === "approve") {
      return remoteCommand(session, "hunsuDraft.approve", { ...(payload ?? {}), roadmapId, draftSessionId }, workspaceId);
    }
    if (method === "POST" && action === "discard") {
      return remoteCommand(session, "hunsuDraft.discard", { ...(payload ?? {}), roadmapId, draftSessionId }, workspaceId);
    }
  }
  const hunsuDraftDiffArtifact = suffix.match(/^\/hunsu\/drafts\/([^/]+)\/diff-artifacts\/([^/]+)$/);
  if (method === "GET" && hunsuDraftDiffArtifact) {
    return remoteCommand(session, "hunsuDraft.diffArtifact.get", {
        roadmapId,
        draftSessionId: decodeURIComponent(hunsuDraftDiffArtifact[1] ?? ""),
        diffArtifactId: decodeURIComponent(hunsuDraftDiffArtifact[2] ?? "")
      }, workspaceId);
  }
  if (method === "POST" && suffix === "/lines/accept") {
    return remoteCommand(session, "line.accept", payloadWithRoadmapId(payload, roadmapId), workspaceId);
  }
  if (method === "POST" && suffix === "/lines/reject") {
    return remoteCommand(session, "line.reject", payloadWithRoadmapId(payload, roadmapId), workspaceId);
  }
  if (method === "GET" && suffix === "/agent-sessions") {
    return remoteCommand(session, "agentSession.list", { roadmapId }, workspaceId);
  }
  const agentSessionShow = suffix.match(/^\/agent-sessions\/([^/]+)$/);
  if (method === "GET" && agentSessionShow) {
    return remoteCommand(session, "agentSession.get", { roadmapId, sessionId: decodeURIComponent(agentSessionShow[1] ?? "") }, workspaceId);
  }
  const agentSessionEvents = suffix.match(/^\/agent-sessions\/([^/]+)\/events$/);
  if (method === "GET" && agentSessionEvents) {
    return remoteCommand(session, "agentSession.events", { roadmapId, sessionId: decodeURIComponent(agentSessionEvents[1] ?? "") }, workspaceId);
  }
  return undefined;
}

function remoteCommand(
  session: RemoteBridgeSession,
  name: string,
  payload?: unknown,
  workspaceId?: string
): RemoteBridgeCommandRequest {
  return {
    deviceId: session.deviceId,
    workspaceId: workspaceId ?? session.workspaceId,
    command: {
      name,
      ...(payload === undefined ? {} : { payload: sanitizeRemotePayload(payload) })
    }
  };
}

function selectedWorkspaceId(
  payload: Record<string, unknown> | undefined,
  session: RemoteBridgeSession,
  roadmapId?: string
): string {
  return stringField(objectBody(payload?.workspace), "workspaceId")
    ?? stringField(payload, "workspaceId")
    ?? stringField(payload, "roadmapId")
    ?? session.workspaceId
    ?? roadmapId;
}

function payloadWithRoadmapId(payload: Record<string, unknown> | undefined, roadmapId: string): Record<string, unknown> {
  return { ...(payload ?? {}), roadmapId };
}

function subscribeRemoteCommand<T>(command: RemoteBridgeCommandRequest, onEvent: (event: T) => void, onError: () => void): () => void {
  const peer = currentActiveRemotePeer();
  if (!peer || peer.device.deviceId !== command.deviceId) {
    queueMicrotask(onError);
    return () => undefined;
  }
  return peer.subscribe(command.workspaceId, command.command, value => onEvent(sanitizeRemotePayload(value) as T), onError);
}

type WebBridgeBackendSelection = {
  backendId?: string;
  connectionMode?: "local" | "remote";
  remoteRequested: boolean;
  explicit: boolean;
};

function currentRoutableRemoteBridgeSessionForRequest(path: string, body: unknown): RemoteBridgeSession | undefined {
  const selection = selectedWebBridgeBackend(new URL(path, "http://hunsu.local"), body);
  if (selection.explicit) {
    const session = currentRemoteBridgeSession();
    return session && selectionTargetsRemoteSession(selection, session) ? session : undefined;
  }
  return currentRoutableRemoteBridgeSession();
}

function currentRoutableRemoteBridgeSession(): RemoteBridgeSession | undefined {
  return hasBridgeApiAuthToken() ? undefined : currentRemoteBridgeSession();
}

function executeStartBodyWithSelectedBackend(roadmapId: string, body: unknown): unknown {
  const payload = objectBody(body);
  if (!payload) {
    return body;
  }
  const session = currentRemoteBridgeSession();
  const selection = selectedWebBridgeBackend(new URL(`/api/roadmaps/${encodeURIComponent(roadmapId)}/runs/start`, "http://hunsu.local"), payload);
  const backendId = selection.backendId
    ?? (selection.connectionMode === "remote"
      ? session?.deviceId ? `remote:${session.deviceId}` : undefined
      : selection.connectionMode === "local"
        ? "local"
        : session?.deviceId ? `remote:${session.deviceId}` : "local");
  const connectionMode = backendId
    ? isRemoteBackendId(backendId) ? "remote" : "local"
    : selection.connectionMode ?? "local";
  const existingWorkspace = objectBody(payload.workspace);
  return {
    ...payload,
    backendId,
    connectionMode,
    workspace: {
      ...(existingWorkspace ?? {}),
      workspaceId: stringField(existingWorkspace, "workspaceId") ?? roadmapId,
      backendId,
      connectionMode
    }
  };
}

function selectedWebBridgeBackend(requestUrl: URL, body: unknown): WebBridgeBackendSelection {
  const payload = objectBody(body);
  const workspace = objectBody(payload?.workspace);
  const queryBackendId = requestUrl.pathname === "/api/providers/inventory"
    ? requestUrl.searchParams.get("backendId")?.trim() || undefined
    : undefined;
  const backendId = stringField(payload, "backendId") ?? stringField(workspace, "backendId") ?? queryBackendId;
  const requestedMode = connectionModeField(payload) ?? connectionModeField(workspace);
  const connectionMode = backendId
    ? isRemoteBackendId(backendId) ? "remote" : "local"
    : requestedMode;
  return {
    backendId,
    connectionMode,
    remoteRequested: connectionMode === "remote",
    explicit: Boolean(backendId || requestedMode)
  };
}

function selectionTargetsRemoteSession(selection: WebBridgeBackendSelection, session: RemoteBridgeSession): boolean {
  if (!selection.remoteRequested) {
    return false;
  }
  return !selection.backendId
    || selection.backendId === "remote"
    || selection.backendId === `remote:${session.deviceId}`;
}

function connectionModeField(value: Record<string, unknown> | undefined): "local" | "remote" | undefined {
  return value?.connectionMode === "local" || value?.connectionMode === "remote"
    ? value.connectionMode
    : undefined;
}

function isRemoteBackendId(backendId: string): boolean {
  return backendId === "remote" || backendId.startsWith("remote:");
}

function parseRequestBody(body: BodyInit | null | undefined): unknown {
  if (typeof body !== "string" || !body.trim()) {
    return undefined;
  }
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
}

function objectBody(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringField(value: Record<string, unknown> | undefined, field: string): string | undefined {
  const candidate = value?.[field];
  return typeof candidate === "string" && candidate.trim() ? candidate.trim() : undefined;
}

function remoteDeviceFromConnect(device: ConnectDevice, grants?: PeerWorkspaceGrant[]): RemoteBridgeDeviceListResult["devices"][number] {
  return {
    deviceId: device.deviceId,
    deviceName: device.deviceName,
    status: device.status,
    signingPublicKeyJwk: device.signingPublicKeyJwk,
    agreementPublicKeyJwk: device.agreementPublicKeyJwk,
    lastSeenAt: device.lastSeenAt,
    protocolVersion: device.protocolVersion,
    ...(grants ? {
      workspaces: grants.map(grant => ({
        workspaceId: grant.workspaceId,
        roadmapId: grant.workspaceId,
        displayName: grant.displayName,
        pathRedacted: true,
        lifecycle: "active",
        health: "ok",
        backendId: `remote:${device.deviceId}`,
        connectionMode: "remote",
        provider: { providerId: "remote", label: "Remote provider", readyForExecute: grant.scopes.includes("execute.start") },
        actions: ["open_studio"]
      }))
    } : {})
  };
}

function sanitizeRemotePayload(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sanitizeRemotePayload);
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  const sanitized: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (isHostedSecretField(key) || isCanonicalLocationField(key, child)) {
      continue;
    }
    sanitized[key] = sanitizeRemotePayload(child);
  }
  return sanitized;
}

function isHostedSecretField(field: string): boolean {
  const normalized = field.toLowerCase();
  return normalized.includes("token") || normalized.includes("authorization") || normalized.includes("credential");
}

function isCanonicalLocationField(field: string, value: unknown): boolean {
  const normalized = field.toLowerCase();
  if (normalized.endsWith("path")
    && (normalized.includes("repository") || normalized.includes("project") || normalized.includes("canonical") || normalized.includes("workspace") || normalized.includes("root"))) {
    return true;
  }
  if ((normalized === "path" || normalized === "root" || normalized === "cwd") && typeof value === "string") {
    return /^(?:\/|[a-z]:[\\/]|\\\\)/iu.test(value.trim());
  }
  return false;
}

function remoteCompatibility(device: RemoteBridgeDeviceListResult["devices"][number], input: RemoteBridgeConnectRequest): RemoteBridgeConnectResult["compatibility"] {
  if (input.minBridgeVersion && compareDottedVersions(device.bridgeVersion ?? "0", input.minBridgeVersion) < 0) {
    return {
      compatible: false,
      reason: "bridge_update_needed",
      message: `Bridge ${device.bridgeVersion ?? "unknown"} is older than required ${input.minBridgeVersion}.`
    };
  }
  if (input.requiredProtocolVersion && device.protocolVersion !== input.requiredProtocolVersion) {
    return {
      compatible: false,
      reason: "bridge_update_needed",
      message: `Bridge protocol ${device.protocolVersion ?? "unknown"} does not match required ${input.requiredProtocolVersion}.`
    };
  }
  return { compatible: true };
}

function compareDottedVersions(left: string, right: string): number {
  const leftParts = left.split(".").map(part => Number.parseInt(part, 10));
  const rightParts = right.split(".").map(part => Number.parseInt(part, 10));
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = Number.isFinite(leftParts[index]) ? leftParts[index] : 0;
    const rightPart = Number.isFinite(rightParts[index]) ? rightParts[index] : 0;
    if (leftPart !== rightPart) {
      return leftPart < rightPart ? -1 : 1;
    }
  }
  return 0;
}
