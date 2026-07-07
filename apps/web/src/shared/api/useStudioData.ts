import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { emptyBoardProjection, type BoardProjection } from "@hunsu/protocol";
import {
  fetchActionRuns,
  fetchAgentSession,
  fetchAgentSessions,
  fetchArtifactActions,
  fetchBoard,
  fetchFilesystemBrowse,
  fetchHunsuDrafts,
  fetchRoadmapRegistry,
  fetchRuns,
  fetchSkills,
  fetchWorktree,
  subscribeAgentSessionEvents,
  subscribeRunEvents
} from "@/shared/api/bridgeClient";
import type {
  AgentMessage,
  AgentSession,
  AgentSessionEvent,
  StudioActionRun,
  StudioArtifactAction,
  ConnectionState,
  FilesystemBrowseResult,
  RoadmapRegistryEntry,
  StudioHunsuDraftSession,
  StudioRunSummary,
  StudioRunState,
  StudioSkillSummary,
  WorktreeStatus
} from "@/shared/api/bridgeTypes";
import {
  buildRoadmapViewModel,
  type RoadmapDetailPanel,
  type RoadmapSelection,
  type RoadmapViewModel
} from "@/shared/domain/roadmapViewModel";

type AsyncState<T> = {
  data: T;
  status: ConnectionState;
  error?: string;
};

type RoadmapSnapshot = {
  board: BoardProjection;
  runs: StudioRunState[];
  skills: StudioSkillSummary[];
  worktree?: WorktreeStatus;
  artifactActions: StudioArtifactAction[];
  actionRuns: StudioActionRun[];
  hunsuDrafts: StudioHunsuDraftSession[];
};

export type AgentSessionCache = {
  ids: string[];
  byId: Record<string, AgentSession>;
};

export const ROADMAP_REGISTRY_QUERY_KEY = ["roadmaps", "registry"] as const;

type RoadmapWorkspaceState =
  | { kind: "empty"; status: Extract<ConnectionState, "empty">; snapshot: RoadmapSnapshot }
  | { kind: "connecting"; status: Extract<ConnectionState, "connecting">; roadmapId: string; snapshot: RoadmapSnapshot; error?: string }
  | { kind: "live"; status: Extract<ConnectionState, "live">; roadmapId: string; snapshot: RoadmapSnapshot }
  | { kind: "offline"; status: Extract<ConnectionState, "offline">; roadmapId: string; snapshot: RoadmapSnapshot; source: "api" | "fixture"; error: string };

const emptyBrowse: FilesystemBrowseResult = {
  path: "/workspace",
  rootId: "root_fixture" as FilesystemBrowseResult["rootId"],
  roots: [
    { rootId: "root_fixture" as FilesystemBrowseResult["rootId"], path: "/workspace" as FilesystemBrowseResult["roots"][number]["path"], label: "workspace" },
    { rootId: "root_tmp" as FilesystemBrowseResult["rootId"], path: "/tmp" as FilesystemBrowseResult["roots"][number]["path"], label: "Temporary" }
  ],
  entries: [
    { kind: "directory", name: "hunsu-project", path: "/workspace/hunsu-project", rootId: "root_fixture" as FilesystemBrowseResult["rootId"], type: "directory", isGitRepository: true, isRoadmap: true },
    { kind: "directory", name: "new-roadmap", path: "/workspace/new-roadmap", rootId: "root_fixture" as FilesystemBrowseResult["rootId"], type: "directory", isGitRepository: false, isRoadmap: false }
  ]
};

export function useRoadmapRegistry(): AsyncState<RoadmapRegistryEntry[]> {
  const query = useQuery({
    queryKey: ROADMAP_REGISTRY_QUERY_KEY,
    queryFn: fetchRoadmapRegistry
  });
  const data = query.data ?? [];
  if (query.isError) {
    return {
      data,
      status: "offline",
      error: errorMessage(query.error, "Bridge API is offline.")
    };
  }
  if (query.isLoading && data.length === 0) {
    return { data, status: "connecting" };
  }
  return { data, status: data.length > 0 ? "live" : "empty" };
}

export function upsertRoadmapRegistryCache(
  current: RoadmapRegistryEntry[] | undefined,
  roadmap: RoadmapRegistryEntry
): RoadmapRegistryEntry[] {
  return [
    roadmap,
    ...(current ?? []).filter(candidate => candidate.roadmapId !== roadmap.roadmapId)
  ];
}

export function useFilesystemBrowser(path?: string, rootId?: string): AsyncState<FilesystemBrowseResult> {
  const [state, setState] = useState<AsyncState<FilesystemBrowseResult>>({
    data: emptyBrowse,
    status: "connecting"
  });

  useEffect(() => {
    let active = true;
    fetchFilesystemBrowse(path, rootId)
      .then(data => active && setState({ data, status: "live" }))
      .catch(error => active && setState({
        data: emptyBrowse,
        status: "offline",
        error: error instanceof Error ? error.message : "Folder browser is offline."
      }));
    return () => {
      active = false;
    };
  }, [path, rootId]);

  return state;
}

export function useRoadmapWorkspace(roadmapId: string, selection?: RoadmapSelection, panel?: RoadmapDetailPanel, options: { enabled?: boolean; expandedConnectionIds?: string[] } = {}): {
  model: RoadmapViewModel;
  status: ConnectionState;
  error?: string;
  refresh: () => void;
} {
  const enabled = options.enabled ?? true;
  const queryClient = useQueryClient();
  const agentSessionQueryKey = useMemo(() => roadmapAgentSessionQueryKey(roadmapId), [roadmapId]);
  const [version, setVersion] = useState(0);
  const [workspace, setWorkspace] = useState<RoadmapWorkspaceState>(() => ({
    kind: "connecting",
    status: "connecting",
    roadmapId,
    snapshot: emptyRoadmapSnapshot()
  }));

  useEffect(() => {
    let active = true;
    if (!enabled) {
      setWorkspace(emptyRoadmapWorkspace());
      return () => {
        active = false;
      };
    }
    setWorkspace(previous => ({
      kind: "connecting",
      status: "connecting",
      roadmapId,
      snapshot: workspaceHasRoadmap(previous, roadmapId) ? previous.snapshot : emptyRoadmapSnapshot()
    }));
    fetchRoadmapSnapshot(roadmapId)
      .then(([nextBoard, nextRuns, nextSkills, nextWorktree, nextArtifactActions, nextActionRuns, nextHunsuDrafts]) => {
        if (!active) return;
        setWorkspace({
          kind: "live",
          status: "live",
          roadmapId,
          snapshot: {
            board: nextBoard,
            runs: nextRuns,
            skills: nextSkills,
            worktree: nextWorktree,
            artifactActions: nextArtifactActions,
            actionRuns: nextActionRuns,
            hunsuDrafts: nextHunsuDrafts
          }
        });
      })
      .catch(nextError => {
        if (!active) return;
        setWorkspace(apiOfflineRoadmapWorkspace(roadmapId, errorMessage(nextError, "Bridge API is offline.")));
      });
    return () => {
      active = false;
    };
  }, [enabled, roadmapId, version]);

  const shouldPollLiveSnapshot = workspace.status === "live"
    && workspace.snapshot.runs.some(run => !isTerminalRunStatus(run.status));

  useEffect(() => {
    if (!enabled || !shouldPollLiveSnapshot) return;
    let active = true;
    const refresh = () => {
      fetchLiveSnapshot(roadmapId)
        .then(next => {
          if (active) {
            setWorkspace(previous => mergeLiveSnapshot(previous, roadmapId, next));
          }
        })
        .catch(() => undefined);
    };
    const interval = setInterval(refresh, 3_000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [enabled, roadmapId, shouldPollLiveSnapshot]);

  useEffect(() => {
    if (!enabled) return;
    if (workspace.status !== "live") return;
    let active = true;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const refreshFromLiveSnapshot = (delayMs = 0, onError?: (error: unknown) => void) => {
      const run = () => {
        if (!active) return;
        fetchLiveSnapshot(roadmapId)
          .then(next => {
            if (active) {
              setWorkspace(previous => mergeLiveSnapshot(previous, roadmapId, next));
            }
          })
          .catch(error => {
            if (active) {
              onError?.(error);
            }
          });
      };
      if (delayMs <= 0) {
        run();
        return;
      }
      const timer = setTimeout(() => {
        timers.delete(timer);
        run();
      }, delayMs);
      timers.add(timer);
    };
    const unsubscribe = subscribeRunEvents(roadmapId, event => {
      if (event.type === "runs.snapshot") {
        setWorkspace(previous => mergeRoadmapRuns(previous, roadmapId, event.runs));
        queryClient.setQueryData<AgentSessionCache>(agentSessionQueryKey, previous => mergeAgentSessionSummaries(previous, event.runs.flatMap(run => run.agentSessions ?? [])));
      }
      if (event.type === "run.updated") {
        setWorkspace(previous => mergeRoadmapRun(previous, roadmapId, event.run, event.board));
        queryClient.setQueryData<AgentSessionCache>(agentSessionQueryKey, previous => mergeAgentSessionSummaries(previous, event.run.agentSessions ?? []));
        if (shouldReconcileRunEvent(event.run)) {
          refreshFromLiveSnapshot();
          refreshFromLiveSnapshot(1_000);
          refreshFromLiveSnapshot(3_000);
        }
      }
    }, () => {
      refreshFromLiveSnapshot(0, nextError => {
        setWorkspace(previous => {
          if (previous.kind !== "live" || previous.roadmapId !== roadmapId) return previous;
          return { kind: "connecting", status: "connecting", roadmapId, snapshot: previous.snapshot, error: errorMessage(nextError, "Bridge API is offline.") };
        });
      });
    });
    return () => {
      active = false;
      unsubscribe();
      for (const timer of timers) {
        clearTimeout(timer);
      }
      timers.clear();
    };
  }, [agentSessionQueryKey, enabled, queryClient, roadmapId, workspace.status]);

  const agentSessionQuery = useQuery({
    queryKey: agentSessionQueryKey,
    queryFn: async () => mergeAgentSessionSummaries(queryClient.getQueryData<AgentSessionCache>(agentSessionQueryKey), await fetchAgentSessions(roadmapId)),
    enabled,
    staleTime: 30_000
  });

	  const { board, runs, skills, worktree, artifactActions, actionRuns, hunsuDrafts } = workspace.snapshot;
	  const runAgentSessions = useMemo(() => normalizeAgentSessions(runs.flatMap(run => run.agentSessions ?? [])), [runs]);
	  const agentSessions = useMemo(
	    () => denormalizeAgentSessions(mergeAgentSessionCaches(runAgentSessions, agentSessionQuery.data)),
	    [agentSessionQuery.data, runAgentSessions]
	  );
	  const model = useMemo(() => buildRoadmapViewModel({
	    roadmapId,
	    board,
	    runs,
    agentSessions,
	    skills,
    worktree,
	    artifactActions,
    actionRuns,
    hunsuDrafts,
    selection,
    panel,
	    expandedConnectionIds: options.expandedConnectionIds
	  }), [roadmapId, board, runs, agentSessions, skills, worktree, artifactActions, actionRuns, hunsuDrafts, selection, panel, options.expandedConnectionIds]);

  const selectedAgentSession = selectedInspectorAgentSession(model.inspector);
  const selectedAgentSessionId = selectedAgentSession?.sessionId;

  useEffect(() => {
    if (!enabled || !selectedAgentSessionId) return;
    let active = true;
    const sessionId = selectedAgentSessionId;
    void fetchAgentSession(roadmapId, selectedAgentSessionId)
      .then(session => {
        if (!active) return;
        queryClient.setQueryData<AgentSessionCache>(agentSessionQueryKey, previous =>
          mergeAgentSessionCaches(previous ?? emptyAgentSessionCache(), normalizeAgentSessions([session]))
        );
      })
      .catch(() => {
        if (!active) return;
        void queryClient.invalidateQueries({ queryKey: agentSessionQueryKey });
      });
    const unsubscribe = subscribeAgentSessionEvents(roadmapId, sessionId, event => {
      if (!active) return;
      if ("sessionId" in event && event.sessionId !== sessionId) return;
      queryClient.setQueryData<AgentSessionCache>(agentSessionQueryKey, previous => applyAgentSessionEventToCache(previous ?? emptyAgentSessionCache(), event));
    }, () => {
      if (!active) return;
      void queryClient.invalidateQueries({ queryKey: agentSessionQueryKey });
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [agentSessionQueryKey, enabled, queryClient, roadmapId, selectedAgentSessionId]);

  return {
    model,
    status: workspace.status,
    error: "error" in workspace ? workspace.error : undefined,
    refresh: () => setVersion(current => current + 1)
  };
}

function fetchRoadmapSnapshot(roadmapId: string) {
  return Promise.all([
    fetchBoard(roadmapId),
    fetchRuns(roadmapId),
    fetchSkills(roadmapId),
    fetchWorktree(roadmapId),
    fetchArtifactActions(roadmapId),
    fetchActionRuns(roadmapId),
    fetchHunsuDrafts(roadmapId)
  ]);
}

function roadmapAgentSessionQueryKey(roadmapId: string) {
  return ["roadmap", roadmapId, "agentSessions"] as const;
}

function emptyAgentSessionCache(): AgentSessionCache {
  return { ids: [], byId: {} };
}

function normalizeAgentSessions(sessions: AgentSession[]): AgentSessionCache {
  const cache = emptyAgentSessionCache();
  for (const session of sessions) {
    cache.ids.push(session.sessionId);
    cache.byId[session.sessionId] = session;
  }
  return cache;
}

export function mergeAgentSessionCaches(base: AgentSessionCache | undefined, override: AgentSessionCache | undefined): AgentSessionCache {
  const cache = emptyAgentSessionCache();
  for (const source of [base, override]) {
    if (!source) continue;
    for (const id of source.ids) {
      const session = source.byId[id];
      if (!session) continue;
      const existing = cache.byId[id];
      const nextSession = existing ? mergeAgentSessions(existing, session) : session;
      if (!existing) {
        cache.ids.push(id);
      }
      cache.byId[id] = nextSession;
    }
  }
  return cache;
}

function mergeAgentSessionSummaries(cache: AgentSessionCache | undefined, sessions: AgentSession[]): AgentSessionCache {
  if (sessions.length === 0) {
    return cache ?? emptyAgentSessionCache();
  }
  const next = cache ?? emptyAgentSessionCache();
  return mergeAgentSessionCaches(next, normalizeAgentSessions(sessions));
}

function mergeAgentSessions(existing: AgentSession, incoming: AgentSession): AgentSession {
  const base = preferIncomingSession(existing, incoming) ? incoming : existing;
  return {
    ...base,
    messages: mergeAgentMessages(existing.messages, incoming.messages),
    revision: Math.max(existing.revision, incoming.revision),
    updatedAt: maxTimestamp(existing.updatedAt, incoming.updatedAt)
  };
}

function preferIncomingSession(existing: AgentSession, incoming: AgentSession): boolean {
  if (incoming.revision !== existing.revision) {
    return incoming.revision > existing.revision;
  }
  return incoming.updatedAt.localeCompare(existing.updatedAt) >= 0;
}

function mergeAgentMessages(existingMessages: AgentMessage[], incomingMessages: AgentMessage[]): AgentMessage[] {
  const order: string[] = [];
  const messagesById = new Map<string, AgentMessage>();
  for (const message of [...existingMessages, ...incomingMessages]) {
    const existing = messagesById.get(message.messageId);
    if (!existing) {
      order.push(message.messageId);
      messagesById.set(message.messageId, message);
      continue;
    }
    messagesById.set(message.messageId, mergeAgentMessage(existing, message));
  }
  return order
    .map(id => messagesById.get(id))
    .filter((message): message is AgentMessage => Boolean(message));
}

function mergeAgentMessage(existing: AgentMessage, incoming: AgentMessage): AgentMessage {
  const base = preferIncomingMessage(existing, incoming) ? incoming : existing;
  const alternate = base === incoming ? existing : incoming;
  return {
    ...base,
    text: richerText(base.text, alternate.text),
    output: richerText(base.output, alternate.output),
    summary: richerTextArray(base.summary, alternate.summary),
    content: richerTextArray(base.content, alternate.content),
    command: base.command ?? alternate.command,
    cwd: base.cwd ?? alternate.cwd,
    commandActions: base.commandActions ?? alternate.commandActions,
    changes: base.changes ?? alternate.changes,
    durationMs: valueFromDurationResolution(resolveDurationByPrecedence([
      { source: "previous", value: base.durationMs },
      { source: "previous", value: alternate.durationMs }
    ])),
    revision: Math.max(existing.revision, incoming.revision),
    updatedAt: maxTimestamp(existing.updatedAt, incoming.updatedAt)
  };
}

function preferIncomingMessage(existing: AgentMessage, incoming: AgentMessage): boolean {
  if (incoming.revision !== existing.revision) {
    return incoming.revision > existing.revision;
  }
  if (incoming.updatedAt !== existing.updatedAt) {
    return incoming.updatedAt.localeCompare(existing.updatedAt) >= 0;
  }
  return agentMessageBodySize(incoming) >= agentMessageBodySize(existing);
}

function richerText(preferred: string | undefined, alternate: string | undefined): string | undefined {
  if (!preferred) return alternate;
  if (!alternate) return preferred;
  return alternate.length > preferred.length ? alternate : preferred;
}

function richerTextArray(preferred: string[] | undefined, alternate: string[] | undefined): string[] | undefined {
  if (!preferred?.length) return alternate;
  if (!alternate?.length) return preferred;
  return textArraySize(alternate) > textArraySize(preferred) ? alternate : preferred;
}

function agentMessageBodySize(message: AgentMessage): number {
  return (message.text?.length ?? 0)
    + (message.output?.length ?? 0)
    + textArraySize(message.summary)
    + textArraySize(message.content);
}

function textArraySize(values: string[] | undefined): number {
  return values?.reduce((total, value) => total + value.length, 0) ?? 0;
}

function maxTimestamp(left: string, right: string): string {
  return right.localeCompare(left) > 0 ? right : left;
}

function denormalizeAgentSessions(cache: AgentSessionCache | undefined): AgentSession[] {
  if (!cache) {
    return [];
  }
  return cache.ids.map(id => cache.byId[id]).filter((session): session is AgentSession => Boolean(session));
}

export function applyAgentSessionEventToCache(cache: AgentSessionCache, event: AgentSessionEvent): AgentSessionCache {
  if (event.type === "agentSession.snapshot") {
    return mergeAgentSessionCaches(cache, normalizeAgentSessions(event.sessions));
  }
  if (event.type === "agentSession.lifecycle") {
    const session = cache.byId[event.sessionId] ?? createAgentSessionFromLifecycle(event);
    const nextSession = {
      ...session,
      roadmapId: event.roadmapId ?? session.roadmapId,
      routeRef: event.routeRef,
      runId: event.runId,
      executeId: event.executeId,
      owner: event.owner,
      state: event.state,
      provider: event.provider ?? session.provider,
      activeItemIds: event.activeItemIds,
      finalResponse: event.finalResponse,
      error: event.error,
      revision: Math.max(session.revision, event.sessionRevision),
      updatedAt: event.updatedAt
    };
    return upsertAgentSessionCache(cache, nextSession);
  }
  if (event.type === "agentMessage.completed") {
    const session = cache.byId[event.sessionId];
    if (!session) {
      return cache;
    }
    const nextSession = {
      ...session,
      messages: completeAgentMessage(session.messages, event),
      revision: Math.max(session.revision, event.sessionRevision),
      updatedAt: event.updatedAt
    };
    return upsertAgentSessionCache(cache, nextSession);
  }
  const session = cache.byId[event.sessionId];
  if (!session) {
    return cache;
  }
  const message = session.messages.find(candidate => candidate.messageId === event.messageId) ?? createStreamingMessageFromDelta(event);
  if (message.revision >= event.messageRevision) {
    return cache;
  }
  const nextMessage = appendAgentMessageDelta(message, event);
  const nextSession = {
    ...session,
    messages: upsertAgentMessage(session.messages, nextMessage),
    revision: Math.max(session.revision, event.sessionRevision),
    updatedAt: event.updatedAt
  };
  return upsertAgentSessionCache(cache, nextSession);
}

function upsertAgentSessionCache(cache: AgentSessionCache, session: AgentSession): AgentSessionCache {
  const exists = Boolean(cache.byId[session.sessionId]);
  const nextSession = exists ? mergeAgentSessions(cache.byId[session.sessionId], session) : session;
  return {
    ids: exists ? cache.ids : [...cache.ids, session.sessionId],
    byId: { ...cache.byId, [session.sessionId]: nextSession }
  };
}

function upsertAgentMessage(messages: AgentMessage[], message: AgentMessage): AgentMessage[] {
  const index = messages.findIndex(candidate => candidate.messageId === message.messageId);
  if (index === -1) {
    return [...messages, message];
  }
  const next = [...messages];
  next[index] = message;
  return next;
}

function completeAgentMessage(messages: AgentMessage[], event: Extract<AgentSessionEvent, { type: "agentMessage.completed" }>): AgentMessage[] {
  const existing = messages.find(candidate => candidate.messageId === event.messageId);
  const message: AgentMessage = existing ?? {
    sessionId: event.sessionId,
    messageId: event.messageId,
    itemId: event.itemId,
    role: event.role,
    type: event.messageType,
    status: "started",
    title: event.title,
    revision: 0,
    createdAt: event.createdAt,
    updatedAt: event.updatedAt
  };
  if (message.revision >= event.messageRevision) {
    return messages;
  }
  return upsertAgentMessage(messages, {
    ...message,
    role: event.role,
    type: event.messageType,
    title: event.title,
    status: "completed",
    text: message.text ?? event.text,
    summary: message.summary ?? event.summary,
    content: message.content ?? event.content,
    command: message.command ?? event.command,
    cwd: message.cwd ?? event.cwd,
    commandActions: message.commandActions ?? event.commandActions,
    output: message.output ?? event.output,
    changes: message.changes ?? event.changes,
    revision: event.messageRevision,
    createdAt: event.createdAt,
    completedAt: event.completedAt,
    durationMs: valueFromDurationResolution(resolveLifecycleDuration(message.createdAt ?? event.createdAt, event.completedAt, event.durationMs, message.durationMs)),
    updatedAt: event.updatedAt
  });
}

type DurationResolutionSource = "lifecycle" | "itemMetadata" | "previous";
type DurationResolution =
  | { ok: true; value: number; source: DurationResolutionSource }
  | { ok: false; error: "missing-duration" };

function resolveLifecycleDuration(
  startedAt: string | undefined,
  completedAt: string | undefined,
  itemDurationMs?: number,
  previousDurationMs?: number
): DurationResolution {
  const lifecycleDurationMs = durationBetweenIsoMs(startedAt, completedAt);
  return resolveDurationByPrecedence([
    { source: "lifecycle", value: lifecycleDurationMs },
    { source: "itemMetadata", value: itemDurationMs },
    { source: "previous", value: previousDurationMs }
  ]);
}

function resolveDurationByPrecedence(candidates: Array<{ source: DurationResolutionSource; value: number | undefined }>): DurationResolution {
  const positive = candidates.find(candidate => typeof candidate.value === "number" && Number.isFinite(candidate.value) && candidate.value > 0);
  if (positive?.value !== undefined) {
    return { ok: true, value: positive.value, source: positive.source };
  }
  const resolved = candidates.find(candidate => typeof candidate.value === "number" && Number.isFinite(candidate.value));
  return resolved?.value !== undefined
    ? { ok: true, value: resolved.value, source: resolved.source }
    : { ok: false, error: "missing-duration" };
}

function valueFromDurationResolution(resolution: DurationResolution): number | undefined {
  return resolution.ok ? resolution.value : undefined;
}

function durationBetweenIsoMs(startedAt: string | undefined, completedAt: string | undefined): number | undefined {
  if (!startedAt || !completedAt) {
    return undefined;
  }
  const startedAtMs = Date.parse(startedAt);
  const completedAtMs = Date.parse(completedAt);
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(completedAtMs)) {
    return undefined;
  }
  return Math.max(0, completedAtMs - startedAtMs);
}

function createStreamingMessageFromDelta(event: Extract<AgentSessionEvent, { type: "agentMessage.delta" }>): AgentMessage {
  return {
    sessionId: event.sessionId,
    messageId: event.messageId,
    itemId: event.itemId,
    role: event.role,
    type: event.messageType,
    status: "streaming",
    title: event.title,
    revision: 0,
    createdAt: event.createdAt,
    updatedAt: event.updatedAt
  };
}

function appendAgentMessageDelta(message: AgentMessage, event: Extract<AgentSessionEvent, { type: "agentMessage.delta" }>): AgentMessage {
  const next: AgentMessage = {
    ...message,
    role: event.role,
    type: event.messageType,
    title: event.title,
    status: message.status === "completed" ? "completed" : "streaming",
    revision: event.messageRevision,
    createdAt: event.createdAt,
    updatedAt: event.updatedAt
  };
  if (event.field === "text") {
    next.text = `${next.text ?? ""}${event.delta}`;
  } else if (event.field === "output") {
    next.output = `${next.output ?? ""}${event.delta}`;
  } else if (event.field === "summary") {
    next.summary = appendIndexedText(next.summary, event.delta, event.contentIndex);
  } else {
    next.content = appendIndexedText(next.content, event.delta, event.contentIndex);
  }
  return next;
}

function createAgentSessionFromLifecycle(event: Extract<AgentSessionEvent, { type: "agentSession.lifecycle" }>): AgentSession {
  return {
    sessionId: event.sessionId,
    roadmapId: event.roadmapId,
    routeRef: event.routeRef,
    runId: event.runId,
    executeId: event.executeId,
    owner: event.owner,
    state: event.state,
    provider: event.provider,
    messages: [],
    activeItemIds: event.activeItemIds,
    finalResponse: event.finalResponse,
    error: event.error,
    revision: event.sessionRevision,
    createdAt: event.updatedAt,
    updatedAt: event.updatedAt
  };
}

function selectedInspectorAgentSession(inspector: RoadmapViewModel["inspector"]) {
  if (!inspector) {
    return undefined;
  }
  if ("activeAgentSession" in inspector) {
    return inspector.activeAgentSession;
  }
  return undefined;
}

function appendIndexedText(values: string[] | undefined, delta: string, index: number | undefined): string[] {
  const next = [...(values ?? [])];
  const targetIndex = index ?? Math.max(next.length - 1, 0);
  next[targetIndex] = `${next[targetIndex] ?? ""}${delta}`;
  return next;
}

async function fetchLiveSnapshot(roadmapId: string): Promise<{ board: BoardProjection; runs: StudioRunSummary[]; artifactActions: StudioArtifactAction[]; actionRuns: StudioActionRun[]; hunsuDrafts: StudioHunsuDraftSession[] }> {
  const [board, runs, artifactActions, actionRuns, hunsuDrafts] = await Promise.all([
    fetchBoard(roadmapId),
    fetchRuns(roadmapId),
    fetchArtifactActions(roadmapId),
    fetchActionRuns(roadmapId),
    fetchHunsuDrafts(roadmapId)
  ]);
  return { board, runs, artifactActions, actionRuns, hunsuDrafts };
}

function isTerminalRunStatus(status: StudioRunSummary["status"]): boolean {
  return status === "arrived" || status === "accident" || status === "failed" || status === "discarded" || status === "finished" || status === "stopped";
}

function shouldReconcileRunEvent(run: StudioRunSummary): boolean {
  if (isTerminalRunStatus(run.status)) {
    return true;
  }
  const latestPathRun = (run.memberPathRuns ?? []).at(-1);
  if (latestPathRun?.status !== "completed") {
    return false;
  }
  const commit = "commit" in latestPathRun ? latestPathRun.commit : undefined;
  return !commit || !latestPathRun.currentExecutionTransition;
}

function emptyRoadmapSnapshot(): RoadmapSnapshot {
  return {
    board: emptyBoardProjection(),
    runs: [],
    skills: [],
    worktree: undefined,
    artifactActions: [],
    actionRuns: [],
    hunsuDrafts: []
  };
}

function emptyRoadmapWorkspace(): RoadmapWorkspaceState {
  return {
    kind: "empty",
    status: "empty",
    snapshot: emptyRoadmapSnapshot()
  };
}

function apiOfflineRoadmapWorkspace(roadmapId: string, error: string): RoadmapWorkspaceState {
  return {
    kind: "offline",
    status: "offline",
    roadmapId,
    source: "api",
    snapshot: emptyRoadmapSnapshot(),
    error
  };
}

function workspaceHasRoadmap(state: RoadmapWorkspaceState, roadmapId: string): state is Exclude<RoadmapWorkspaceState, { kind: "empty" }> {
  return "roadmapId" in state && state.roadmapId === roadmapId;
}

function mergeRoadmapRuns(state: RoadmapWorkspaceState, roadmapId: string, runs: StudioRunSummary[]): RoadmapWorkspaceState {
  if (!workspaceHasRoadmap(state, roadmapId)) return state;
  return { ...state, snapshot: { ...state.snapshot, runs } };
}

function mergeRoadmapRun(state: RoadmapWorkspaceState, roadmapId: string, run: StudioRunSummary, board?: BoardProjection): RoadmapWorkspaceState {
  if (!workspaceHasRoadmap(state, roadmapId)) return state;
  return {
    ...state,
    snapshot: {
      ...state.snapshot,
      board: board ?? state.snapshot.board,
      runs: [run, ...state.snapshot.runs.filter(previous => previous.runId !== run.runId)]
    }
  };
}

function mergeLiveSnapshot(
  state: RoadmapWorkspaceState,
  roadmapId: string,
  next: { board: BoardProjection; runs: StudioRunSummary[]; artifactActions: StudioArtifactAction[]; actionRuns: StudioActionRun[]; hunsuDrafts: StudioHunsuDraftSession[] }
): RoadmapWorkspaceState {
  if (!workspaceHasRoadmap(state, roadmapId)) return state;
  return {
    kind: "live",
    status: "live",
    roadmapId,
    snapshot: {
      ...state.snapshot,
      board: next.board,
      runs: next.runs,
      artifactActions: next.artifactActions,
      actionRuns: next.actionRuns,
      hunsuDrafts: next.hunsuDrafts
    }
  };
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
