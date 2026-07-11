import { resolve } from "node:path";
import { BRIDGE_CONTROL_TOKEN_HEADER } from "../client/controlClient.ts";
import { assertDiagnosticsSafe, sanitizeDiagnostics } from "../diagnostics/redaction.ts";
import type {
  RelayCommandName,
  RemoteBridgeCommandRequest,
  RemoteBridgeCommandResult
} from "../connections/remoteConnection.ts";
import { scopesForRemoteBridgeCommand } from "../connections/remoteConnection.ts";
import type { Workspace, WorkspaceService } from "../workspaces/workspaceService.ts";

type LocalRequest = {
  method: "GET" | "POST";
  path: string;
  body?: unknown;
  authorizedRoot?: string;
};

export function createRemoteCommandRouter(input: {
  workspaceService: WorkspaceService;
  endpoint: () => string | undefined;
  controlToken: string;
  fetchImpl?: typeof fetch;
}): (command: RemoteBridgeCommandRequest) => Promise<RemoteBridgeCommandResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  return async command => {
    const endpoint = input.endpoint();
    if (!endpoint) return failure(503, "Bridge is still starting.");
    const workspace = await grantedWorkspaceForCommand(input.workspaceService, command);
    if (!workspace.ok) return workspace.error;
    const local = localRequest(command, workspace.value);
    if (!local) return failure(400, "Remote command is not supported by this Bridge protocol.");
    try {
      const response = await fetchImpl(new URL(local.path, endpoint), {
        method: local.method,
        headers: {
          [BRIDGE_CONTROL_TOKEN_HEADER]: input.controlToken,
          ...(local.body === undefined ? {} : { "content-type": "application/json" })
        },
        ...(local.body === undefined ? {} : { body: JSON.stringify(local.body) }),
        redirect: "error",
        signal: AbortSignal.timeout(9_000)
      });
      const body = await response.json().catch(() => undefined);
      if (!response.ok) return failure(response.status, "Local Bridge command failed.");
      const safeBody = sanitizeDiagnostics(redactUnauthorizedPaths(body, local.authorizedRoot));
      assertDiagnosticsSafe(safeBody);
      return {
        ok: true,
        status: response.status,
        ...(body === undefined ? {} : { body: safeBody })
      };
    } catch (_error) {
      return failure(503, "Local Bridge command is unavailable.");
    }
  };
}

async function grantedWorkspaceForCommand(
  workspaceService: WorkspaceService,
  command: RemoteBridgeCommandRequest
): Promise<{ ok: true; value?: Workspace } | { ok: false; error: RemoteBridgeCommandResult }> {
  if (!command.projectPath) return { ok: true };
  const listed = await workspaceService.list();
  if (!listed.ok) return { ok: false, error: failure(503, "Workspace registry is unavailable.") };
  const normalized = comparableLocalPath(command.projectPath);
  const workspace = listed.value.find(candidate =>
    candidate.lifecycle === "active"
    && candidate.remoteAccess.enabled
    && candidate.remoteAccess.scopes.includes("remoteRelay.access")
    && comparableLocalPath(candidate.repositoryPath) === normalized
  );
  const requiredScopes = [...new Set([
    ...scopesForRemoteBridgeCommand(command.command),
    ...(command.requestedScopes ?? [])
  ])];
  if (workspace && requiredScopes.some(scope => !workspace.remoteAccess.scopes.includes(scope))) {
    return { ok: false, error: failure(403, "Remote command scope is not granted.") };
  }
  return workspace
    ? { ok: true, value: workspace }
    : { ok: false, error: failure(403, "Remote command Workspace is not granted.") };
}

function localRequest(command: RemoteBridgeCommandRequest, workspace: Workspace | undefined): LocalRequest | undefined {
  const payload = objectPayload(command.payload);
  const global = globalRequest(command.command, payload);
  if (global) {
    if ((command.projectPath || scopesForRemoteBridgeCommand(command.command).length > 0) && !workspace) return undefined;
    return { ...global, ...(workspace ? { authorizedRoot: workspace.repositoryPath } : {}) };
  }
  if (!workspace) return undefined;
  const roadmapId = workspace.workspaceId;
  const payloadRoadmapId = stringField(payload, "roadmapId");
  if (payloadRoadmapId && payloadRoadmapId !== roadmapId) return undefined;
  const payloadRoot = stringField(payload, "path");
  if (payloadRoot && comparableLocalPath(payloadRoot) !== comparableLocalPath(workspace.repositoryPath)) return undefined;
  const body = { ...(payload ?? {}), roadmapId, ...(payloadRoot ? { path: workspace.repositoryPath } : {}) };
  const prefix = `/api/roadmaps/${encodeURIComponent(roadmapId)}`;
  const request = scopedRequest(command.command, prefix, body);
  return request ? { ...request, authorizedRoot: workspace.repositoryPath } : undefined;
}

function globalRequest(command: RelayCommandName, payload: Record<string, unknown> | undefined): LocalRequest | undefined {
  switch (command) {
    case "health": return { method: "GET", path: "/health" };
    case "bridge.status": return { method: "GET", path: "/api/bridge/status" };
    case "connection.status": return { method: "GET", path: "/api/connection/status" };
    case "provider.inventory": {
      const backendId = stringField(payload, "backendId");
      return { method: "GET", path: `/api/providers/inventory${backendId ? `?backendId=${encodeURIComponent(backendId)}` : ""}` };
    }
    case "modelAlias.validate": return { method: "POST", path: "/api/model-aliases/validate", body: payload ?? {} };
    case "modelAlias.resolve": return { method: "POST", path: "/api/model-aliases/resolve", body: payload ?? {} };
    case "roadmap.registry.list": return { method: "GET", path: "/api/roadmaps/recent" };
    case "roadmap.registry.remove": return { method: "POST", path: "/api/roadmaps/recent/remove", body: payload ?? {} };
    case "roadmap.open": return { method: "POST", path: "/api/roadmaps/open", body: payload ?? {} };
    case "roadmap.port.inspect": return { method: "POST", path: "/api/roadmaps/port/inspect", body: payload ?? {} };
    case "roadmap.port.apply": return { method: "POST", path: "/api/roadmaps/port/apply", body: payload ?? {} };
    case "roadmap.create": return { method: "POST", path: "/api/roadmaps/create", body: payload ?? {} };
    default: return undefined;
  }
}

function scopedRequest(
  command: RelayCommandName,
  prefix: string,
  body: Record<string, unknown>
): LocalRequest | undefined {
  switch (command) {
    case "roadmap.board": return { method: "GET", path: `${prefix}/board` };
    case "roadmap.worktree": return { method: "GET", path: `${prefix}/worktree` };
    case "roadmap.skills": return { method: "GET", path: `${prefix}/skills` };
    case "roadmap.commands": return { method: "POST", path: `${prefix}/commands`, body };
    case "execute.status": return { method: "GET", path: `${prefix}/runs` };
    case "execute.start": return { method: "POST", path: `${prefix}/runs/start`, body };
    case "execute.pause": return { method: "POST", path: `${prefix}/runs/pause`, body };
    case "execute.resume": return { method: "POST", path: `${prefix}/runs/resume`, body };
    case "execute.stop": return { method: "POST", path: `${prefix}/runs/stop`, body };
    case "execute.completeMove": return { method: "POST", path: `${prefix}/runs/complete-move`, body };
    case "artifactAction.list": return { method: "GET", path: `${prefix}/artifact-actions` };
    case "artifactAction.runs": return { method: "GET", path: `${prefix}/action-runs` };
    case "artifactAction.start": {
      const actionId = stringField(body, "actionId");
      return actionId ? { method: "POST", path: `${prefix}/artifact-actions/${encodeURIComponent(actionId)}/runs`, body } : undefined;
    }
    case "artifactAction.stop": {
      const runId = stringField(body, "runId");
      return runId ? { method: "POST", path: `${prefix}/action-runs/${encodeURIComponent(runId)}/stop`, body } : undefined;
    }
    case "moveFile.tree":
    case "moveFile.blob":
    case "moveFile.diff": {
      const moveId = stringField(body, "moveId");
      if (!moveId) return undefined;
      const action = command.slice("moveFile.".length);
      const filePath = stringField(body, "path");
      return {
        method: "GET",
        path: `${prefix}/moves/${encodeURIComponent(moveId)}/files/${action}${filePath ? `?path=${encodeURIComponent(filePath)}` : ""}`
      };
    }
    case "hunsuDraft.list": return { method: "GET", path: `${prefix}/hunsu/drafts` };
    case "hunsuDraft.start": return { method: "POST", path: `${prefix}/hunsu/drafts`, body };
    case "hunsuDraft.get": return draftRequest("GET", prefix, body);
    case "hunsuDraft.message": return draftRequest("POST", prefix, body, "messages");
    case "hunsuDraft.diffArtifact.create": return draftRequest("POST", prefix, body, "diff-artifacts");
    case "hunsuDraft.diffArtifact.get": {
      const draftSessionId = stringField(body, "draftSessionId");
      const diffArtifactId = stringField(body, "diffArtifactId");
      return draftSessionId && diffArtifactId
        ? { method: "GET", path: `${prefix}/hunsu/drafts/${encodeURIComponent(draftSessionId)}/diff-artifacts/${encodeURIComponent(diffArtifactId)}` }
        : undefined;
    }
    case "hunsuDraft.approve": return draftRequest("POST", prefix, body, "approve");
    case "hunsuDraft.discard": return draftRequest("POST", prefix, body, "discard");
    case "line.accept": return { method: "POST", path: `${prefix}/lines/accept`, body };
    case "line.reject": return { method: "POST", path: `${prefix}/lines/reject`, body };
    case "agentSession.list": return { method: "GET", path: `${prefix}/agent-sessions` };
    case "agentSession.get": {
      const sessionId = stringField(body, "sessionId");
      return sessionId ? { method: "GET", path: `${prefix}/agent-sessions/${encodeURIComponent(sessionId)}` } : undefined;
    }
    case "agentSession.events":
    case "live.events":
      return undefined;
    default: return undefined;
  }
}

function draftRequest(
  method: "GET" | "POST",
  prefix: string,
  body: Record<string, unknown>,
  action?: string
): LocalRequest | undefined {
  const draftSessionId = stringField(body, "draftSessionId");
  return draftSessionId
    ? {
        method,
        path: `${prefix}/hunsu/drafts/${encodeURIComponent(draftSessionId)}${action ? `/${action}` : ""}`,
        ...(method === "POST" ? { body } : {})
      }
    : undefined;
}

function redactUnauthorizedPaths(value: unknown, authorizedRoot?: string): unknown {
  if (Array.isArray(value)) return value.map(item => redactUnauthorizedPaths(item, authorizedRoot));
  if (!isRecord(value)) return value;
  const result: Record<string, unknown> = {};
  let pathRedacted = false;
  for (const [key, child] of Object.entries(value)) {
    if ((key === "path" || key === "repositoryPath") && typeof child === "string" && !pathWithinRoot(child, authorizedRoot)) {
      pathRedacted = true;
      continue;
    }
    result[key] = redactUnauthorizedPaths(child, authorizedRoot);
  }
  if (pathRedacted) result.pathRedacted = true;
  return result;
}

function pathWithinRoot(path: string, authorizedRoot: string | undefined): boolean {
  if (!authorizedRoot) return false;
  const root = comparableLocalPath(authorizedRoot);
  const candidate = comparableLocalPath(path);
  return candidate === root || candidate.startsWith(`${root}/`) || candidate.startsWith(`${root}\\`);
}

function comparableLocalPath(value: string): string {
  const normalized = resolve(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function failure(status: number, error: string): RemoteBridgeCommandResult {
  return { ok: false, status, error };
}

function objectPayload(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function stringField(value: Record<string, unknown> | undefined, key: string): string | undefined {
  const field = value?.[key];
  return typeof field === "string" && field.trim() ? field.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
