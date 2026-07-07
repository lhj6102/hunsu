import type { BoardProjection, Command } from "@hunsu/protocol";
import { roadmapApiPath } from "@/app/routes";
import { LOCAL_API_BASE_URL, localApiEventUrl, localApiRequestHeaders } from "@/shared/api/localApiBase";
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
  FilesystemGrantResult,
  MoveFileBlob,
  MoveFileBlobResult,
  MoveFileDiff,
  MoveFileDiffResult,
  MoveFileTree,
  MoveFileTreeResult,
  StudioRunSummary,
  StudioSkillSummary,
  WorktreeStatus
} from "@/shared/api/localTypes";

const SERVER_URL = LOCAL_API_BASE_URL;

async function requestJson<T>(path: string, init?: RequestInit, label = "Local API request"): Promise<T> {
  const response = await fetch(`${SERVER_URL}${path}`, {
    ...init,
    headers: localApiRequestHeaders(init?.headers)
  });
  if (!response.ok) {
    const result = await response.json().catch(() => ({ error: `${label} failed with ${response.status}` }));
    throw new Error(typeof result.error === "string" ? result.error : `${label} failed with ${response.status}`);
  }
  return response.json() as Promise<T>;
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

export function postRoadmapOpen(input: string | { browseToken: string; path?: string }): Promise<RoadmapOpenResult> {
  return postJson<RoadmapOpenResult>("/api/roadmaps/open", typeof input === "string" ? { path: input } : input, "Roadmap open");
}

export function postRoadmapCreate(input: string | { browseToken: string; path?: string }): Promise<RoadmapOpenResult> {
  return postJson<RoadmapOpenResult>("/api/roadmaps/create", typeof input === "string" ? { path: input } : input, "Roadmap create");
}

export function postRoadmapPortInspect(input: string | { browseToken: string; path?: string }): Promise<unknown> {
  return postJson<unknown>("/api/roadmaps/port/inspect", typeof input === "string" ? { path: input } : input, "Roadmap port inspect");
}

export function postRoadmapPortApply(body: unknown): Promise<RoadmapOpenResult> {
  return postJson<RoadmapOpenResult>("/api/roadmaps/port/apply", body, "Roadmap port apply");
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
  return postJson<RunResult>(roadmapApiPath(roadmapId, `/runs/${action}`), body, "Run action");
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
  const source = new EventSource(localApiEventUrl(roadmapApiPath(roadmapId, "/runs/events")));
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
  const source = new EventSource(localApiEventUrl(roadmapApiPath(roadmapId, `/agent-sessions/${encodeURIComponent(sessionId)}/events`)));
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
