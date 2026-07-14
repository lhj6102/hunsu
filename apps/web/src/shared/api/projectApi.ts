import { getApi, postApi } from "@/shared/api/client";
import { eventDateBound } from "@/features/events/eventFilters";
import {
  decodeEventDetail,
  decodeEvents,
  decodeNodeDetail,
  decodeProjectGraph,
  decodeProjectList,
  decodeStartRun,
  unwrapPresentation
} from "@/shared/api/v2Decoders";
import type {
  EventDetailResponse,
  EventsResponse,
  NodeDetailResponse,
  ProjectGraphResponse,
  ProjectListResponse,
  SessionResponse,
  StartRunResponse
} from "@/shared/api/types";

export const PROJECT_LIST_QUERY_KEY = ["projects", "v2"] as const;

export function fetchSession(signal?: AbortSignal): Promise<SessionResponse> {
  return getApi<SessionResponse>("/api/session", signal);
}

export async function fetchProjects(signal?: AbortSignal): Promise<ProjectListResponse> {
  return unwrapPresentation(decodeProjectList(await getApi<unknown>("/api/projects", signal)));
}

export async function fetchProjectGraph(
  projectId: string,
  cursor: string | null,
  signal?: AbortSignal
): Promise<ProjectGraphResponse> {
  const query = new URLSearchParams({ limit: "300" });
  if (cursor !== null) query.set("cursor", cursor);
  const value = await getApi<unknown>(`${projectApiPath(projectId)}/graph?${query.toString()}`, signal);
  return unwrapPresentation(decodeProjectGraph(value));
}

export async function fetchNode(projectId: string, nodeSha: string, signal?: AbortSignal): Promise<NodeDetailResponse> {
  const value = await getApi<unknown>(`${projectApiPath(projectId)}/nodes/${encodeURIComponent(nodeSha)}`, signal);
  return unwrapPresentation(decodeNodeDetail(value));
}

export async function startNodeRun(projectId: string, nodeSha: string, body: {
  goalDigest: string;
  runId: string;
  expectedStateSha: string;
  idempotencyKey: string;
}): Promise<StartRunResponse> {
  const value = await postApi<unknown>(`${projectApiPath(projectId)}/nodes/${encodeURIComponent(nodeSha)}/runs`, body);
  return unwrapPresentation(decodeStartRun(value));
}

export type EventQuery = {
  cursor: string | null;
  type: string | null;
  nodeSha: string | null;
  actor: string | null;
  from: string | null;
  to: string | null;
  search: string | null;
};

export async function fetchEvents(projectId: string, options: EventQuery, signal?: AbortSignal): Promise<EventsResponse> {
  const query = new URLSearchParams({ limit: "50" });
  for (const [key, value] of Object.entries(options)) {
    if (value !== null) query.set(key, key === "from" || key === "to" ? eventDateBound(value, key) : value);
  }
  const response = await getApi<unknown>(`${projectApiPath(projectId)}/events?${query.toString()}`, signal);
  return unwrapPresentation(decodeEvents(response));
}

export async function fetchEvent(projectId: string, eventId: string, signal?: AbortSignal): Promise<EventDetailResponse> {
  const value = await getApi<unknown>(`${projectApiPath(projectId)}/events/${encodeURIComponent(eventId)}`, signal);
  return unwrapPresentation(decodeEventDetail(value));
}

function projectApiPath(projectId: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}`;
}
