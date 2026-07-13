import { getApi, patchApi, postApi } from "@/shared/api/client";
import { alternativeDecisionRequest } from "@/shared/api/alternativeDecision";
import type {
  CoachResponse,
  GoalResponse,
  MutationResponse,
  ProjectListResponse,
  ProjectResponse,
  RepositoryListResponse,
  RunResponse,
  RunnerListResponse,
  SessionResponse
} from "@/shared/api/types";

export const PROJECT_LIST_QUERY_KEY = ["projects"] as const;

export function fetchSession(signal?: AbortSignal): Promise<SessionResponse> {
  return getApi<SessionResponse>("/api/session", signal);
}

export function fetchRepositories(signal?: AbortSignal): Promise<RepositoryListResponse> {
  return getApi<RepositoryListResponse>("/api/repositories", signal);
}

export function fetchProjects(signal?: AbortSignal): Promise<ProjectListResponse> {
  return getApi<ProjectListResponse>("/api/projects", signal);
}

export function createProject(body: {
  repository: { owner: string; name: string };
  title: string;
  objective: string;
  baseRef: string;
  expectedStateSha: string;
  idempotencyKey: string;
}): Promise<MutationResponse<{ projectId: string }>> {
  return postApi("/api/projects", body);
}

export function fetchProject(projectId: string, signal?: AbortSignal): Promise<ProjectResponse> {
  return getApi<ProjectResponse>(projectPath(projectId), signal);
}

export function createGoal(projectId: string, body: {
  title: string;
  desiredOutcome: string;
  acceptanceCriteria: string[];
  constraints: string[];
  priority: "low" | "normal" | "high" | "urgent";
  runnerId?: string;
  expectedStateSha: string;
  idempotencyKey: string;
}): Promise<MutationResponse<{ goalId: string }>> {
  return postApi(`${projectPath(projectId)}/goals`, body);
}

export function fetchGoal(projectId: string, goalId: string, signal?: AbortSignal): Promise<GoalResponse> {
  return getApi<GoalResponse>(`${projectPath(projectId)}/goals/${encodeURIComponent(goalId)}`, signal);
}

export function updateGoal(projectId: string, goalId: string, body: Record<string, unknown>): Promise<MutationResponse<{ goalId: string }>> {
  return patchApi(`${projectPath(projectId)}/goals/${encodeURIComponent(goalId)}`, body);
}

export function requestHunsu(projectId: string, goalId: string, body: {
  sourceRunId: string;
  summary?: string;
  expectedStateSha: string;
  idempotencyKey: string;
}): Promise<MutationResponse<{ alternativeId: string }>> {
  return postApi(`${projectPath(projectId)}/goals/${encodeURIComponent(goalId)}/hunsu`, body);
}

export function selectAlternative(projectId: string, goalId: string, runId: string, comparisonId: string, expectedStateSha: string, idempotencyKey: string): Promise<MutationResponse<{ decisionId: string }>> {
  return postApi(
    `${projectPath(projectId)}/goals/${encodeURIComponent(goalId)}/alternatives/${encodeURIComponent(runId)}/select`,
    alternativeDecisionRequest(comparisonId, expectedStateSha, idempotencyKey)
  );
}

export function rejectAlternative(projectId: string, goalId: string, runId: string, comparisonId: string, expectedStateSha: string, idempotencyKey: string): Promise<MutationResponse<{ decisionId: string }>> {
  return postApi(
    `${projectPath(projectId)}/goals/${encodeURIComponent(goalId)}/alternatives/${encodeURIComponent(runId)}/reject`,
    alternativeDecisionRequest(comparisonId, expectedStateSha, idempotencyKey)
  );
}

export function fetchRunners(projectId: string, signal?: AbortSignal): Promise<RunnerListResponse> {
  return getApi<RunnerListResponse>(`${projectPath(projectId)}/runners`, signal);
}

export function fetchRun(projectId: string, runId: string, signal?: AbortSignal): Promise<RunResponse> {
  return getApi<RunResponse>(`${projectPath(projectId)}/runs/${encodeURIComponent(runId)}`, signal);
}

export function fetchCoach(projectId: string, signal?: AbortSignal): Promise<CoachResponse> {
  return getApi<CoachResponse>(`${projectPath(projectId)}/coach`, signal);
}

export function requestCoachReview(projectId: string, expectedStateSha: string, idempotencyKey: string): Promise<MutationResponse<{ reviewId: string }>> {
  return postApi(`${projectPath(projectId)}/coach/review`, { expectedStateSha, idempotencyKey });
}

export function confirmCoachProposal(projectId: string, proposalId: string, expectedStateSha: string, idempotencyKey: string): Promise<MutationResponse<{ proposalId: string }>> {
  return postApi(
    `${projectPath(projectId)}/coach/proposals/${encodeURIComponent(proposalId)}/confirm`,
    { expectedStateSha, idempotencyKey }
  );
}

export function rejectCoachProposal(projectId: string, proposalId: string, expectedStateSha: string, idempotencyKey: string): Promise<MutationResponse<{ proposalId: string }>> {
  return postApi(
    `${projectPath(projectId)}/coach/proposals/${encodeURIComponent(proposalId)}/reject`,
    { expectedStateSha, idempotencyKey }
  );
}

export function rebuildProject(projectId: string, expectedStateSha: string, idempotencyKey: string): Promise<MutationResponse<{ projectId: string }>> {
  return postApi(`${projectPath(projectId)}/rebuild`, { expectedStateSha, idempotencyKey });
}

function projectPath(projectId: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}`;
}
