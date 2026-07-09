import type { BoardProjection, Command } from "@hunsu/protocol";
import { roadmapApiPath } from "@/app/routes";
import {
  BRIDGE_API_BASE_URL,
  RELAY_API_BASE_URL,
  bridgeApiEventUrl,
  bridgeApiRequestHeaders,
  currentRelayAccessToken,
  currentRemoteBridgeSession,
  hasBridgeApiAuthToken,
  hasDirectRelaySession,
  relayApiHttpUrl,
  relayApiRequestHeaders,
  storeRemoteBridgeSession,
  type RemoteBridgeSession
} from "@/shared/api/bridgeApiBase";
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
  ProjectInspectionResult,
  RemoteBridgeConnectRequest,
  RemoteBridgeConnectResult,
  RemoteBridgeDeviceListResult,
  RemoteProjectGrantStatusResult,
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
  const remoteCommand = remoteBridgeCommandForRequest(path, method, body, currentRoutableRemoteBridgeSessionForRequest(body));
  if (remoteCommand) {
    return requestRemoteJson<T>(remoteCommand, label);
  }
  const remoteStatusFallback = remoteBridgeStatusFallbackCommand(path, method, body);
  let response: Response;
  try {
    response = await fetch(`${SERVER_URL}${path}`, {
      ...init,
      headers: bridgeClientRequestHeaders(path, init?.headers)
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

function bridgeClientRequestHeaders(path: string, headers: HeadersInit = {}): HeadersInit {
  const next = new Headers(bridgeApiRequestHeaders(headers));
  const relayToken = currentRelayAccessToken();
  if (path.startsWith("/api/remote/") && relayToken) {
    next.set("x-hunsu-relay-token", relayToken);
  }
  return next;
}

async function requestRemoteJson<T>(command: RemoteBridgeCommandRequest, label: string): Promise<T> {
  if (hasDirectRelaySession()) {
    const response = await fetch(relayApiHttpUrl("/v1/commands"), {
      method: "POST",
      headers: relayApiRequestHeaders({ "content-type": "application/json" }),
      body: JSON.stringify(command)
    });
    const result = await response.json().catch(() => ({ ok: false, error: `${label} failed through Relay with ${response.status}` })) as RemoteBridgeCommandResult;
    if (result.ok === false) {
      throw new Error(result.error ?? result.message ?? `${label} failed through Relay with ${response.status}`);
    }
    if (!response.ok) {
      throw new Error(`${label} failed through Relay with ${response.status}`);
    }
    return normalizeRemoteCommandBody<T>(command, result.body);
  }
  const session = currentRemoteBridgeSession();
  const nextHeaders = new Headers(bridgeApiRequestHeaders({ "content-type": "application/json" }));
  if (session?.relayAccessToken) {
    nextHeaders.set("x-hunsu-relay-token", session.relayAccessToken);
  }
  const response = await fetch(`${SERVER_URL}/api/remote/commands`, {
    method: "POST",
    headers: nextHeaders,
    body: JSON.stringify(command)
  });
  const result = await response.json().catch(() => ({ ok: false, error: `${label} failed through Relay with ${response.status}` })) as RemoteBridgeCommandResult;
  if (result.ok === false) {
    throw new Error(result.error ?? result.message ?? `${label} failed through Relay with ${response.status}`);
  }
  if (!response.ok) {
    throw new Error(`${label} failed through Relay with ${response.status}`);
  }
  return normalizeRemoteCommandBody<T>(command, result.body);
}

function normalizeRemoteCommandBody<T>(command: RemoteBridgeCommandRequest, body: unknown): T {
  if (command.command !== "bridge.status") {
    return body as T;
  }
  return normalizeRemoteBridgeStatus(body, currentRemoteBridgeSession() ?? { deviceId: command.deviceId }) as T;
}

function normalizeRemoteBridgeStatus(body: unknown, session: RemoteBridgeSession): unknown {
  if (!isBridgeStatusLike(body)) {
    return body;
  }
  const local = body.connections.find(connection => connection.mode === "local") ?? body.connections[0];
  const label = session.deviceName ?? local?.label ?? "Remote Bridge";
  const normalizeWorkspace = (workspace: BridgeStatusResponse["workspaces"]["active"][number]) => {
    const granted = typeof session.projectPath === "string"
      && typeof workspace.path === "string"
      && normalizePathForRemoteSession(workspace.path) === normalizePathForRemoteSession(session.projectPath);
    return {
      ...workspace,
      backendId: `remote:${session.deviceId}`,
      connectionMode: "remote" as const,
      path: granted ? workspace.path : undefined,
      pathRedacted: granted ? undefined : true
    };
  };
  const workspaces = (local?.workspaces ?? body.workspaces.active).map(normalizeWorkspace);
  return {
    ...body,
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
      managed: body.workspaces.managed.map(normalizeWorkspace)
    },
    account: {
      ...body.account,
      signedIn: true,
      userId: body.account.userId ?? session.webUserId
    }
  };
}

function normalizePathForRemoteSession(path: string): string {
  return path.replace(/[\\/]+$/, "");
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
  if (hasDirectRelaySession()) {
    const result = await requestDirectRelayJson<RemoteBridgeDeviceListResult>("/v1/devices", undefined, "Remote Bridge devices request");
    return result.devices;
  }
  const result = await requestJson<RemoteBridgeDeviceListResult>("/api/remote/devices", undefined, "Remote Bridge devices request");
  return result.devices;
}

export async function postRemoteBridgeConnect(input: RemoteBridgeConnectRequest): Promise<RemoteBridgeConnectResult> {
  if (hasDirectRelaySession()) {
    const result = await connectRemoteBridgeThroughRelay(input);
    if (shouldStoreRemoteBridgeSession(result)) {
      storeRemoteBridgeSession({
        deviceId: result.device.deviceId,
        deviceName: result.device.deviceName,
        projectPath: input.projectPath,
        webUserId: input.webUserId,
        relayAccessToken: currentRelayAccessToken()
      });
    }
    return result;
  }
  const result = await postJson<RemoteBridgeConnectResult>("/api/remote/connect", input, "Remote Bridge connect");
  if (shouldStoreRemoteBridgeSession(result)) {
      storeRemoteBridgeSession({
        deviceId: result.device.deviceId,
        deviceName: result.device.deviceName,
        projectPath: input.projectPath,
        webUserId: input.webUserId
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

export function postHunsuDraftStart(roadmapId: string, body: { sourceNodeId?: string; sourceMoveId?: string; sourceLineId?: string; message?: string }): Promise<HunsuDraftResult> {
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
  command:
    | "health"
    | "bridge.status"
    | "connection.status"
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
  projectPath?: string;
  payload?: unknown;
};

type RemoteBridgeCommandResult =
  | { ok: true; status: number; body?: unknown }
  | { ok: false; status?: number; error?: string; reason?: string; message?: string };

export function remoteBridgeCommandForRequest(
  path: string,
  method: string,
  body: unknown,
  session: RemoteBridgeSession | undefined
): RemoteBridgeCommandRequest | undefined {
  const requestUrl = new URL(path, "http://hunsu.local");
  const pathname = requestUrl.pathname;
  if (!session || pathname.startsWith("/api/remote/")) {
    return undefined;
  }
  const payload = objectBody(body);
  const roadmapMatch = pathname.match(/^\/api\/roadmaps\/([^/]+)(\/.*)?$/);
  const roadmapId = roadmapMatch ? decodeURIComponent(roadmapMatch[1] ?? "") : undefined;
  const suffix = roadmapMatch?.[2] ?? "";
  const projectPath = stringField(payload, "path") ?? session.projectPath;
  if (method === "GET" && pathname === "/api/roadmaps/recent") {
    return { deviceId: session.deviceId, command: "roadmap.registry.list" };
  }
  if (method === "GET" && pathname === "/api/bridge/status") {
    return { deviceId: session.deviceId, command: "bridge.status" };
  }
  if (method === "POST" && pathname === "/api/roadmaps/recent/remove") {
    return { deviceId: session.deviceId, command: "roadmap.registry.remove", projectPath, payload: body };
  }
  if (method === "POST" && pathname === "/api/roadmaps/open") {
    return { deviceId: session.deviceId, command: "roadmap.open", projectPath, payload: body };
  }
  if (method === "POST" && pathname === "/api/roadmaps/create") {
    return { deviceId: session.deviceId, command: "roadmap.create", projectPath, payload: body };
  }
  if (method === "POST" && pathname === "/api/roadmaps/port/inspect") {
    return { deviceId: session.deviceId, command: "roadmap.port.inspect", projectPath, payload: body };
  }
  if (method === "POST" && pathname === "/api/roadmaps/port/apply") {
    return { deviceId: session.deviceId, command: "roadmap.port.apply", projectPath, payload: body };
  }
  if (!roadmapId) {
    return undefined;
  }
  if (method === "GET" && suffix === "/board") {
    return { deviceId: session.deviceId, command: "roadmap.board", projectPath, payload: { roadmapId } };
  }
  if (method === "GET" && suffix === "/worktree") {
    return { deviceId: session.deviceId, command: "roadmap.worktree", projectPath, payload: { roadmapId } };
  }
  if (method === "GET" && suffix === "/skills") {
    return { deviceId: session.deviceId, command: "roadmap.skills", projectPath, payload: { roadmapId } };
  }
  if (method === "POST" && suffix === "/commands") {
    return { deviceId: session.deviceId, command: "roadmap.commands", projectPath, payload: payloadWithRoadmapId(payload, roadmapId) };
  }
  if (method === "GET" && suffix === "/runs") {
    return { deviceId: session.deviceId, command: "execute.status", projectPath, payload: { roadmapId } };
  }
  if (method === "GET" && suffix === "/runs/events") {
    return { deviceId: session.deviceId, command: "live.events", projectPath, payload: { roadmapId } };
  }
  if (method === "POST" && suffix === "/runs/start") {
    return { deviceId: session.deviceId, command: "execute.start", projectPath, payload: payloadWithRoadmapId(payload, roadmapId) };
  }
  if (method === "POST" && suffix === "/runs/pause") {
    return { deviceId: session.deviceId, command: "execute.pause", projectPath, payload: payloadWithRoadmapId(payload, roadmapId) };
  }
  if (method === "POST" && suffix === "/runs/resume") {
    return { deviceId: session.deviceId, command: "execute.resume", projectPath, payload: payloadWithRoadmapId(payload, roadmapId) };
  }
  if (method === "POST" && suffix === "/runs/stop") {
    return { deviceId: session.deviceId, command: "execute.stop", projectPath, payload: payloadWithRoadmapId(payload, roadmapId) };
  }
  if (method === "POST" && suffix === "/runs/complete-move") {
    return { deviceId: session.deviceId, command: "execute.completeMove", projectPath, payload: payloadWithRoadmapId(payload, roadmapId) };
  }
  if (method === "GET" && suffix === "/artifact-actions") {
    return { deviceId: session.deviceId, command: "artifactAction.list", projectPath, payload: { roadmapId } };
  }
  if (method === "GET" && suffix === "/action-runs") {
    return { deviceId: session.deviceId, command: "artifactAction.runs", projectPath, payload: { roadmapId } };
  }
  const artifactStart = suffix.match(/^\/artifact-actions\/([^/]+)\/runs$/);
  if (method === "POST" && artifactStart) {
    return { deviceId: session.deviceId, command: "artifactAction.start", projectPath, payload: { ...(payload ?? {}), roadmapId, actionId: decodeURIComponent(artifactStart[1] ?? "") } };
  }
  const artifactStop = suffix.match(/^\/action-runs\/([^/]+)\/stop$/);
  if (method === "POST" && artifactStop) {
    return { deviceId: session.deviceId, command: "artifactAction.stop", projectPath, payload: { ...(payload ?? {}), roadmapId, runId: decodeURIComponent(artifactStop[1] ?? "") } };
  }
  const moveFilesRoute = suffix.match(/^\/moves\/([^/]+)\/files\/(tree|blob|diff)$/);
  if (method === "GET" && moveFilesRoute) {
    const action = moveFilesRoute[2];
    return {
      deviceId: session.deviceId,
      command: action === "tree" ? "moveFile.tree" : action === "blob" ? "moveFile.blob" : "moveFile.diff",
      projectPath,
      payload: {
        roadmapId,
        moveId: decodeURIComponent(moveFilesRoute[1] ?? ""),
        path: requestUrl.searchParams.get("path") ?? undefined
      }
    };
  }
  if (method === "GET" && suffix === "/hunsu/drafts") {
    return { deviceId: session.deviceId, command: "hunsuDraft.list", projectPath, payload: { roadmapId } };
  }
  if (method === "POST" && suffix === "/hunsu/drafts") {
    return { deviceId: session.deviceId, command: "hunsuDraft.start", projectPath, payload: payloadWithRoadmapId(payload, roadmapId) };
  }
  const hunsuDraft = suffix.match(/^\/hunsu\/drafts\/([^/]+)(?:\/(messages|diff-artifacts|approve|discard))?$/);
  if (hunsuDraft) {
    const draftSessionId = decodeURIComponent(hunsuDraft[1] ?? "");
    const action = hunsuDraft[2];
    if (method === "GET" && !action) {
      return { deviceId: session.deviceId, command: "hunsuDraft.get", projectPath, payload: { roadmapId, draftSessionId } };
    }
    if (method === "POST" && action === "messages") {
      return { deviceId: session.deviceId, command: "hunsuDraft.message", projectPath, payload: { ...(payload ?? {}), roadmapId, draftSessionId } };
    }
    if (method === "POST" && action === "diff-artifacts") {
      return { deviceId: session.deviceId, command: "hunsuDraft.diffArtifact.create", projectPath, payload: { ...(payload ?? {}), roadmapId, draftSessionId } };
    }
    if (method === "POST" && action === "approve") {
      return { deviceId: session.deviceId, command: "hunsuDraft.approve", projectPath, payload: { ...(payload ?? {}), roadmapId, draftSessionId } };
    }
    if (method === "POST" && action === "discard") {
      return { deviceId: session.deviceId, command: "hunsuDraft.discard", projectPath, payload: { ...(payload ?? {}), roadmapId, draftSessionId } };
    }
  }
  const hunsuDraftDiffArtifact = suffix.match(/^\/hunsu\/drafts\/([^/]+)\/diff-artifacts\/([^/]+)$/);
  if (method === "GET" && hunsuDraftDiffArtifact) {
    return {
      deviceId: session.deviceId,
      command: "hunsuDraft.diffArtifact.get",
      projectPath,
      payload: {
        roadmapId,
        draftSessionId: decodeURIComponent(hunsuDraftDiffArtifact[1] ?? ""),
        diffArtifactId: decodeURIComponent(hunsuDraftDiffArtifact[2] ?? "")
      }
    };
  }
  if (method === "POST" && suffix === "/lines/accept") {
    return { deviceId: session.deviceId, command: "line.accept", projectPath, payload: payloadWithRoadmapId(payload, roadmapId) };
  }
  if (method === "POST" && suffix === "/lines/reject") {
    return { deviceId: session.deviceId, command: "line.reject", projectPath, payload: payloadWithRoadmapId(payload, roadmapId) };
  }
  if (method === "GET" && suffix === "/agent-sessions") {
    return { deviceId: session.deviceId, command: "agentSession.list", projectPath, payload: { roadmapId } };
  }
  const agentSessionShow = suffix.match(/^\/agent-sessions\/([^/]+)$/);
  if (method === "GET" && agentSessionShow) {
    return { deviceId: session.deviceId, command: "agentSession.get", projectPath, payload: { roadmapId, sessionId: decodeURIComponent(agentSessionShow[1] ?? "") } };
  }
  const agentSessionEvents = suffix.match(/^\/agent-sessions\/([^/]+)\/events$/);
  if (method === "GET" && agentSessionEvents) {
    return { deviceId: session.deviceId, command: "agentSession.events", projectPath, payload: { roadmapId, sessionId: decodeURIComponent(agentSessionEvents[1] ?? "") } };
  }
  return undefined;
}

function payloadWithRoadmapId(payload: Record<string, unknown> | undefined, roadmapId: string): Record<string, unknown> {
  return { ...(payload ?? {}), roadmapId };
}

function subscribeRemoteCommand<T>(command: RemoteBridgeCommandRequest, onEvent: (event: T) => void, onError: () => void): () => void {
  const source = new EventSource(remoteBridgeCommandEventUrl(command));
  const handleEvent = (event: Event) => {
    const message = event as MessageEvent<string>;
    if (message.type === "relay.error") {
      onError();
      return;
    }
    try {
      onEvent(JSON.parse(message.data) as T);
    } catch {
      onError();
    }
  };
  for (const eventName of REMOTE_STREAM_EVENT_NAMES) {
    source.addEventListener(eventName, handleEvent);
  }
  source.onerror = () => onError();
  return () => {
    for (const eventName of REMOTE_STREAM_EVENT_NAMES) {
      source.removeEventListener(eventName, handleEvent);
    }
    source.close();
  };
}

const REMOTE_STREAM_EVENT_NAMES = [
  "runs.snapshot",
  "run.updated",
  "agentSession.snapshot",
  "agentSession.lifecycle",
  "agentMessage.delta",
  "agentMessage.completed",
  "relay.error",
  "message"
] as const;

function remoteBridgeCommandEventUrl(command: RemoteBridgeCommandRequest): string {
  if (hasDirectRelaySession()) {
    const url = new URL(relayApiHttpUrl("/v1/commands/events"));
    url.searchParams.set("command", JSON.stringify(command));
    const relayToken = currentRemoteBridgeSession()?.relayAccessToken || currentRelayAccessToken();
    if (relayToken) {
      url.searchParams.set("access_token", relayToken);
    }
    return url.toString();
  }
  const url = new URL(bridgeApiEventUrl("/api/remote/commands/events"), window.location.origin);
  url.searchParams.set("command", JSON.stringify(command));
  const relayToken = currentRemoteBridgeSession()?.relayAccessToken || currentRelayAccessToken();
  if (relayToken) {
    url.searchParams.set("hunsuRelayToken", relayToken);
  }
  return BRIDGE_API_BASE_URL ? url.toString() : `${url.pathname}${url.search}`;
}

function currentRoutableRemoteBridgeSessionForRequest(body: unknown): RemoteBridgeSession | undefined {
  const selectedSession = selectedRemoteBridgeSessionFromRequestBody(body);
  if (selectedSession) {
    return selectedSession;
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
  const backendId = stringField(payload, "backendId") ?? (session?.deviceId ? `remote:${session.deviceId}` : "local");
  const connectionMode = payload.connectionMode === "remote" || backendId.startsWith("remote:") ? "remote" : "local";
  const existingWorkspace = objectBody(payload.workspace);
  return {
    ...payload,
    backendId,
    connectionMode,
    workspace: {
      ...(existingWorkspace ?? {}),
      workspaceId: stringField(existingWorkspace, "workspaceId") ?? roadmapId,
      backendId: stringField(existingWorkspace, "backendId") ?? backendId,
      connectionMode: existingWorkspace?.connectionMode === "remote" || connectionMode === "remote" ? "remote" : "local"
    }
  };
}

function selectedRemoteBridgeSessionFromRequestBody(body: unknown): RemoteBridgeSession | undefined {
  const session = currentRemoteBridgeSession();
  if (!session?.deviceId) {
    return undefined;
  }
  const payload = objectBody(body);
  const workspace = objectBody(payload?.workspace);
  const backendId = stringField(payload, "backendId") ?? stringField(workspace, "backendId");
  const connectionMode = payload?.connectionMode ?? workspace?.connectionMode;
  const selectedRemote = connectionMode === "remote" || backendId === `remote:${session.deviceId}`;
  return selectedRemote ? session : undefined;
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

async function requestDirectRelayJson<T>(path: string, init: RequestInit | undefined, label: string): Promise<T> {
  const response = await fetch(relayApiHttpUrl(path), {
    ...init,
    headers: relayApiRequestHeaders(init?.headers)
  });
  if (!response.ok) {
    const result = await response.json().catch(() => ({ error: `${label} failed with ${response.status}` })) as { error?: string; message?: string };
    throw new Error(result.error ?? result.message ?? `${label} failed with ${response.status}`);
  }
  return response.json() as Promise<T>;
}

async function connectRemoteBridgeThroughRelay(input: RemoteBridgeConnectRequest): Promise<RemoteBridgeConnectResult> {
  const devices = await fetchRemoteBridgeDevices();
  const device = devices.find(candidate => candidate.deviceId === input.deviceId);
  if (!device) {
    const compatibility = {
      compatible: false as const,
      reason: "bridge_update_needed" as const,
      message: "Remote Bridge device is not registered."
    };
    return {
      compatibility,
      connection: {
        mode: "remote",
        transport: "relay",
        health: "disconnected",
        auth: "unknown",
        projectAccess: "not_applicable",
        warnings: ["relay_unavailable"],
        error: "Remote Bridge device is not registered.",
        version: unknownRemoteVersion(),
        compatibility
      }
    };
  }
  const projectAccess = input.projectPath?.trim()
    ? await directRemoteProjectAccess(input)
    : "not_applicable";
  const compatibility = remoteCompatibility(device, input);
  const sameUser = input.webUserId?.trim() ? input.webUserId.trim() === device.userId : undefined;
  const version = {
    bridgeVersion: device.bridgeVersion ?? "unknown",
    bridgeAppVersion: device.bridgeAppVersion,
    protocolVersion: device.protocolVersion ?? "unknown",
    supportedFeatures: ["remote-ready"]
  };
  return {
    device,
    compatibility,
    connection: {
      mode: "remote",
      transport: "relay",
      health: device.status === "online" ? "connected" : "disconnected",
      auth: sameUser === false ? "account_mismatch" : "paired",
      projectAccess,
      bridge: {
        id: device.deviceId,
        name: device.deviceName,
        version: device.bridgeVersion,
        protocolVersion: device.protocolVersion,
        lastSeenAt: device.lastSeenAt
      },
      endpoint: {
        relayLabel: RELAY_API_BASE_URL || "Hunsu Relay"
      },
      account: {
        webUserId: input.webUserId,
        bridgeUserId: device.userId,
        sameUser
      },
      project: input.projectPath?.trim() ? { repositoryPath: input.projectPath.trim() } : undefined,
      warnings: [
        ...(device.status === "online" ? [] : ["relay_unavailable" as const]),
        ...(compatibility.compatible ? [] : ["version_mismatch" as const])
      ],
      error: device.status === "online"
        ? compatibility.compatible ? undefined : compatibility.message
        : "Remote Bridge device is offline.",
      version,
      compatibility
    }
  };
}

async function directRemoteProjectAccess(input: RemoteBridgeConnectRequest): Promise<RemoteBridgeConnectResult["connection"]["projectAccess"]> {
  const result = await requestDirectRelayJson<RemoteProjectGrantStatusResult>("/v1/project-grants/status", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      deviceId: input.deviceId,
      projectPath: input.projectPath,
      requestedScopes: ["remoteRelay.access"]
    })
  }, "Remote Project Grant status");
  return result.projectAccess;
}

function unknownRemoteVersion() {
  return {
    bridgeVersion: "unknown",
    protocolVersion: "unknown",
    supportedFeatures: []
  };
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
