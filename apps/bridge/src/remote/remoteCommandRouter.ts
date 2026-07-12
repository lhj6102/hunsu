import { isAbsolute, normalize, resolve } from "node:path";
import {
  requiredScopesForRemoteCommand,
  type RemoteCommandName
} from "@hunsu/protocol";
import { BRIDGE_CONTROL_TOKEN_HEADER } from "../client/controlClient.ts";
import { assertDiagnosticsSafe, sanitizeDiagnostics } from "../diagnostics/redaction.ts";
import type { Workspace, WorkspaceService } from "../workspaces/workspaceService.ts";

export type RemoteBridgeCommandRequest = {
  requestId: string;
  workspaceId: string;
  command: RemoteCommandName;
  deadline: string;
  payload?: unknown;
};

export type RemoteBridgeCommandResult =
  | { ok: true; status: number; body?: unknown }
  | { ok: false; status: number; error: string };

type LocalRequestSpec = {
  method: "GET" | "POST";
  path: string;
  body?: unknown;
};

type LocalRequest = LocalRequestSpec & {
  authorizedRoot?: string;
  workspaceId: string;
  resultScope: "global" | "workspace";
};

export function createRemoteCommandRouter(input: {
  workspaceService: WorkspaceService;
  endpoint: () => string | undefined;
  controlToken: () => string;
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
          [BRIDGE_CONTROL_TOKEN_HEADER]: input.controlToken(),
          ...(local.body === undefined ? {} : { "content-type": "application/json" })
        },
        ...(local.body === undefined ? {} : { body: JSON.stringify(local.body) }),
        redirect: "error",
        signal: AbortSignal.timeout(9_000)
      });
      const body = await response.json().catch(() => undefined);
      if (!response.ok) return failure(response.status, "Local Bridge command failed.");
      const restricted = restrictResultToWorkspace(body, local.workspaceId);
      const safeBody = sanitizeDiagnostics(redactUnauthorizedPaths(
        restricted,
        local.resultScope === "workspace" ? local.authorizedRoot : undefined
      ));
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

export type RemoteCommandStreamEvent = {
  event: string;
  data?: unknown;
};

export type RemoteCommandStreamContext = {
  signal: AbortSignal;
  emit: (event: RemoteCommandStreamEvent) => void;
};

export function createRemoteCommandStreamRouter(input: {
  workspaceService: WorkspaceService;
  endpoint: () => string | undefined;
  controlToken: () => string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): (command: RemoteBridgeCommandRequest, context: RemoteCommandStreamContext) => Promise<RemoteBridgeCommandResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  return async (command, context) => {
    const endpoint = input.endpoint();
    if (!endpoint) return failure(503, "Bridge is still starting.");
    const granted = await grantedWorkspaceForCommand(input.workspaceService, command);
    if (!granted.ok || !granted.value) return granted.ok ? failure(403, "Remote command Workspace is not granted.") : granted.error;
    const workspace = granted.value;
    const request = localStreamRequest(command, workspace);
    if (!request) return failure(400, "Remote event command is not supported by this Bridge protocol.");
    const timeout = AbortSignal.timeout(input.timeoutMs ?? 5 * 60_000);
    const signal = AbortSignal.any([context.signal, timeout]);
    try {
      const response = await fetchImpl(new URL(request.path, endpoint), {
        method: "GET",
        headers: {
          [BRIDGE_CONTROL_TOKEN_HEADER]: input.controlToken(),
          accept: "text/event-stream"
        },
        redirect: "error",
        signal
      });
      if (!response.ok || !response.body) return failure(response.ok ? 502 : response.status, "Local Bridge event stream is unavailable.");
      await consumeLocalSse(response.body, event => {
        const safeData = sanitizeDiagnostics(redactUnauthorizedPaths(event.data, workspace.repositoryPath));
        assertDiagnosticsSafe(safeData);
        context.emit({ event: event.event, ...(event.data === undefined ? {} : { data: safeData }) });
      });
      return { ok: true, status: 200 };
    } catch (error) {
      if (context.signal.aborted) return failure(499, "Remote event stream was canceled.");
      if (timeout.aborted || (error instanceof Error && error.name === "TimeoutError")) return failure(504, "Remote event stream timed out.");
      return failure(503, "Local Bridge event stream is unavailable.");
    }
  };
}

async function grantedWorkspaceForCommand(
  workspaceService: WorkspaceService,
  command: RemoteBridgeCommandRequest
): Promise<{ ok: true; value?: Workspace } | { ok: false; error: RemoteBridgeCommandResult }> {
  const listed = await workspaceService.list();
  if (!listed.ok) return { ok: false, error: failure(503, "Workspace registry is unavailable.") };
  const workspace = listed.value.find(candidate =>
    candidate.lifecycle === "active"
    && candidate.remoteAccess.enabled
    && candidate.remoteAccess.scopes.includes("remote.access")
    && candidate.workspaceId === command.workspaceId
  );
  const requiredScopes = requiredScopesForRemoteCommand(command.command);
  if (workspace && requiredScopes.some(scope => !workspace.remoteAccess.scopes.includes(scope))) {
    return { ok: false, error: failure(403, "Remote command scope is not granted.") };
  }
  return workspace
    ? { ok: true, value: workspace }
    : { ok: false, error: failure(403, "Remote command Workspace is not granted.") };
}

function localRequest(command: RemoteBridgeCommandRequest, workspace: Workspace | undefined): LocalRequest | undefined {
  if (!workspace || command.workspaceId !== workspace.workspaceId) return undefined;
  const payload = objectPayload(command.payload);
  if (containsUntrustedCanonicalPath(payload)) return undefined;
  const global = globalRequest(command.command, payload, workspace);
  if (global) {
    return global;
  }
  const roadmapId = workspace.workspaceId;
  const payloadRoadmapId = stringField(payload, "roadmapId");
  if (payloadRoadmapId && payloadRoadmapId !== roadmapId) return undefined;
  const body = { ...(payload ?? {}), roadmapId };
  const prefix = `/api/roadmaps/${encodeURIComponent(roadmapId)}`;
  const request = scopedRequest(command.command, prefix, body);
  return request ? {
    ...request,
    authorizedRoot: workspace.repositoryPath,
    workspaceId: workspace.workspaceId,
    resultScope: "workspace"
  } : undefined;
}

function localStreamRequest(command: RemoteBridgeCommandRequest, workspace: Workspace): { path: string } | undefined {
  const payload = objectPayload(command.payload);
  if (containsUntrustedCanonicalPath(payload)) return undefined;
  const payloadRoadmapId = stringField(payload, "roadmapId");
  if (payloadRoadmapId && payloadRoadmapId !== workspace.workspaceId) return undefined;
  const prefix = `/api/roadmaps/${encodeURIComponent(workspace.workspaceId)}`;
  if (command.command === "live.events") return { path: `${prefix}/runs/events` };
  if (command.command === "agentSession.events") {
    const sessionId = stringField(payload, "sessionId");
    return sessionId ? { path: `${prefix}/agent-sessions/${encodeURIComponent(sessionId)}/events` } : undefined;
  }
  return undefined;
}

function globalRequest(
  command: RemoteCommandName,
  payload: Record<string, unknown> | undefined,
  workspace: Workspace
): LocalRequest | undefined {
  const global = (request: LocalRequestSpec): LocalRequest => ({
    ...request,
    workspaceId: workspace.workspaceId,
    resultScope: "global"
  });
  const scoped = (request: LocalRequestSpec): LocalRequest => ({
    ...request,
    authorizedRoot: workspace.repositoryPath,
    workspaceId: workspace.workspaceId,
    resultScope: "workspace"
  });
  switch (command) {
    case "health": return global({ method: "GET", path: "/health" });
    case "bridge.status": return global({ method: "GET", path: "/api/bridge/status" });
    case "connection.status": return global({ method: "GET", path: "/api/connection/status" });
    case "provider.inventory": {
      const backendId = stringField(payload, "backendId");
      return global({ method: "GET", path: `/api/providers/inventory${backendId ? `?backendId=${encodeURIComponent(backendId)}` : ""}` });
    }
    case "modelAlias.validate": return global({ method: "POST", path: "/api/model-aliases/validate", body: payload ?? {} });
    case "modelAlias.resolve": return global({ method: "POST", path: "/api/model-aliases/resolve", body: payload ?? {} });
    case "roadmap.registry.list": return global({ method: "GET", path: "/api/roadmaps/recent" });
    case "roadmap.registry.remove": return scoped({ method: "POST", path: "/api/roadmaps/recent/remove", body: { roadmapId: workspace.workspaceId } });
    case "roadmap.open": return scoped({ method: "POST", path: "/api/roadmaps/open", body: { path: workspace.repositoryPath } });
    case "roadmap.port.inspect": return scoped({
      method: "POST",
      path: "/api/roadmaps/port/inspect",
      body: { ...(payload ?? {}), path: workspace.repositoryPath }
    });
    case "roadmap.port.apply": return scoped({
      method: "POST",
      path: "/api/roadmaps/port/apply",
      body: { ...(payload ?? {}), path: workspace.repositoryPath }
    });
    case "roadmap.create": return scoped({
      method: "POST",
      path: "/api/roadmaps/create",
      body: { ...(payload ?? {}), path: workspace.repositoryPath }
    });
    default: return undefined;
  }
}

function scopedRequest(
  command: RemoteCommandName,
  prefix: string,
  body: Record<string, unknown>
): LocalRequestSpec | undefined {
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
): LocalRequestSpec | undefined {
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
  if (typeof value === "string") return redactCanonicalPathText(value, authorizedRoot);
  if (!isRecord(value)) return value;
  const result: Record<string, unknown> = {};
  let pathRedacted = false;
  for (const [key, child] of Object.entries(value)) {
    if (isPathField(key) && typeof child === "string" && !pathWithinRoot(child, authorizedRoot)) {
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
  // Peer results never contain canonical local paths, including paths inside
  // the granted Workspace. Relative repository file paths are safe.
  if (isAbsolute(path)) return false;
  const normalized = normalize(path);
  return normalized !== ".." && !normalized.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`);
}

function redactCanonicalPathText(value: string, authorizedRoot: string | undefined): string {
  let redacted = value;
  if (authorizedRoot) {
    redacted = redacted.replaceAll(authorizedRoot, "[redacted-path]");
    const slashRoot = authorizedRoot.replace(/\\/gu, "/");
    if (slashRoot !== authorizedRoot) redacted = redacted.replaceAll(slashRoot, "[redacted-path]");
  }
  return redacted
    .replace(/(?<![:\w])\/(?:home|Users|tmp|var|private|opt|srv|mnt|Volumes)\/[^\s"'<>]+/gu, "[redacted-path]")
    .replace(/\b[A-Za-z]:\\[^\r\n"'<>]+/gu, "[redacted-path]");
}

async function consumeLocalSse(
  body: ReadableStream<Uint8Array>,
  emit: (event: RemoteCommandStreamEvent) => void
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const next = await reader.read();
      buffer += next.value ? decoder.decode(next.value, { stream: !next.done }) : decoder.decode();
      if (buffer.length > 1_048_576) throw new Error("Remote event buffer exceeded its bound.");
      while (true) {
        const boundary = sseBoundary(buffer);
        if (!boundary) break;
        const block = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary.length);
        const event = parseSseBlock(block);
        if (event) emit(event);
      }
      if (next.done) {
        const event = parseSseBlock(buffer);
        if (event) emit(event);
        return;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function sseBoundary(value: string): { index: number; length: number } | undefined {
  const lf = value.indexOf("\n\n");
  const crlf = value.indexOf("\r\n\r\n");
  if (lf < 0 && crlf < 0) return undefined;
  if (crlf >= 0 && (lf < 0 || crlf < lf)) return { index: crlf, length: 4 };
  return { index: lf, length: 2 };
}

function parseSseBlock(block: string): RemoteCommandStreamEvent | undefined {
  let event = "message";
  const data: string[] = [];
  for (const rawLine of block.split(/\r?\n/gu)) {
    if (!rawLine || rawLine.startsWith(":")) continue;
    const separator = rawLine.indexOf(":");
    const field = separator < 0 ? rawLine : rawLine.slice(0, separator);
    const value = separator < 0 ? "" : rawLine.slice(separator + 1).replace(/^ /u, "");
    if (field === "event" && value.trim()) event = value.trim().slice(0, 128);
    if (field === "data") data.push(value);
  }
  if (data.length === 0) return undefined;
  const text = data.join("\n");
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (_error) {
    // Plain text is valid SSE data and is sanitized before leaving Bridge.
  }
  return { event, data: parsed };
}

function restrictResultToWorkspace(value: unknown, workspaceId: string): unknown {
  if (Array.isArray(value)) {
    return value
      .filter(item => !isRecord(item)
        || (stringField(item, "workspaceId") ?? stringField(item, "roadmapId")) === undefined
        || (stringField(item, "workspaceId") ?? stringField(item, "roadmapId")) === workspaceId)
      .map(item => restrictResultToWorkspace(item, workspaceId));
  }
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, restrictResultToWorkspace(child, workspaceId)]));
}

function containsUntrustedCanonicalPath(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsUntrustedCanonicalPath);
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, child]) => {
    if (typeof child === "string") {
      if (key === "repositoryPath" || key === "projectPath" || key === "repositoryRoot" || key === "cwd" || key === "worktreePath") return true;
      if (key === "path" && isAbsolute(child)) return true;
    }
    return containsUntrustedCanonicalPath(child);
  });
}

function isPathField(key: string): boolean {
  return key === "path"
    || key === "repositoryPath"
    || key === "projectPath"
    || key === "repositoryRoot"
    || key === "root"
    || key === "cwd"
    || key === "worktreePath"
    || key === "runtimePath";
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
