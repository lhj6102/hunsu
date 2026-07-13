import { err, ok, type Result } from "./result.ts";
import type {
  AcceptedCoachProposalDecision,
  AlternativeComparison,
  AlternativeDecision,
  Coach,
  CoachProposal,
  CoachProposalDecision,
  CoachReview,
  DomainActor,
  DomainEvent,
  EventMetadata,
  EvidenceRef,
  Goal,
  GoalPatch,
  HunsuDivergence,
  Player,
  Project,
  ProjectPatch,
  ProjectState,
  RejectedCoachProposalDecision,
  ResourceBinding,
  Run,
  Runner,
  RunnerSnapshot,
  Team
} from "./model.ts";
import {
  makeCommandFingerprint,
  makeEventId,
  makeGitBranchName,
  makeGitCommitSha,
  makeGitRef,
  makeIdempotencyKey,
  makeIsoTimestamp,
  makeRepositoryName,
  makeRepositoryOwner
} from "./primitives.ts";

export const PROJECT_EVENT_SCHEMA = "hunsu.project-event.v1" as const;
export const PROJECT_STATE_SCHEMA = "hunsu.project-state.v1" as const;

export type ProtocolCodecError = {
  readonly type: "ProtocolCodecError";
  readonly message: string;
};

export function encodeDomainEvent(event: DomainEvent): string {
  return canonicalJson({ schema: PROJECT_EVENT_SCHEMA, event }) + "\n";
}

export function decodeDomainEvent(text: string): Result<DomainEvent, ProtocolCodecError> {
  const value = parseJson(text);
  if (!value.ok) return value;
  if (!isRecord(value.value)
    || !onlyKeys(value.value, ["schema", "event"])
    || value.value.schema !== PROJECT_EVENT_SCHEMA
    || !isDomainEvent(value.value.event)) {
    return codecFailure("Invalid " + PROJECT_EVENT_SCHEMA + " payload");
  }
  return ok(value.value.event);
}

export function encodeProjectState(state: ProjectState): string {
  return canonicalJson({ schema: PROJECT_STATE_SCHEMA, state }) + "\n";
}

export function decodeProjectState(text: string): Result<ProjectState, ProtocolCodecError> {
  const value = parseJson(text);
  if (!value.ok) return value;
  if (!isRecord(value.value)
    || !onlyKeys(value.value, ["schema", "state"])
    || value.value.schema !== PROJECT_STATE_SCHEMA
    || !isProjectState(value.value.state)) {
    return codecFailure("Invalid " + PROJECT_STATE_SCHEMA + " payload");
  }
  return ok(value.value.state);
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function parseJson(text: string): Result<unknown, ProtocolCodecError> {
  try {
    return ok(JSON.parse(text) as unknown);
  } catch (error) {
    return codecFailure("Invalid JSON: " + (error instanceof Error ? error.message : String(error)));
  }
}

function isDomainEvent(value: unknown): value is DomainEvent {
  if (!isRecord(value) || typeof value.type !== "string" || !isEventMetadata(value.meta)) return false;
  switch (value.type) {
    case "ProjectCreated": return eventKeys(value, ["project", "coach"]) && isProject(value.project) && isCoach(value.coach);
    case "ProjectUpdated": return eventKeys(value, ["projectId", "patch"]) && isId(value.projectId) && isProjectPatch(value.patch);
    case "GoalCreated": return eventKeys(value, ["goal"]) && isGoal(value.goal) && value.goal.status === "active";
    case "GoalUpdated": return eventKeys(value, ["goalId", "patch"]) && isId(value.goalId) && isGoalPatch(value.patch);
    case "GoalPaused": return eventKeys(value, ["goalId", "reason"]) && isId(value.goalId) && isText(value.reason);
    case "GoalResumed": return eventKeys(value, ["goalId"]) && isId(value.goalId);
    case "GoalCompleted": return eventKeys(value, ["goalId", "selectedRunId"]) && isId(value.goalId) && isId(value.selectedRunId);
    case "PlayerCreated":
    case "PlayerUpdated": return eventKeys(value, ["player"]) && isPlayer(value.player);
    case "TeamCreated":
    case "TeamUpdated": return eventKeys(value, ["team"]) && isTeam(value.team);
    case "CoachUpdated": return eventKeys(value, ["coach"]) && isCoach(value.coach);
    case "RunStarted": return eventKeys(value, ["run"]) && isRun(value.run) && value.run.status === "running";
    case "RunCheckpointed": return eventKeys(value, ["checkpoint"]) && isCheckpoint(value.checkpoint);
    case "RunEvidenceAttached": return eventKeys(value, ["evidence"]) && isEvidence(value.evidence);
    case "RunCompleted": return eventKeys(value, ["result"]) && isVerifiedResult(value.result);
    case "RunFailed":
    case "RunCanceled": return eventKeys(value, ["runId", "reason"]) && isId(value.runId) && isText(value.reason);
    case "CoachReviewRecorded": return eventKeys(value, ["review"]) && isCoachReview(value.review);
    case "CoachProposalRecorded": return eventKeys(value, ["proposal"]) && isCoachProposal(value.proposal);
    case "CoachProposalAccepted": return eventKeys(value, ["decision"]) && isCoachProposalDecision(value.decision) && value.decision.status === "accepted";
    case "CoachProposalRejected": return eventKeys(value, ["decision"]) && isCoachProposalDecision(value.decision) && value.decision.status === "rejected";
    case "HunsuConfirmed": return eventKeys(value, ["divergence"]) && isDivergence(value.divergence);
    case "AlternativesCompared": return eventKeys(value, ["comparison"]) && isComparison(value.comparison);
    case "AlternativeSelected": return eventKeys(value, ["decision"]) && isDecision(value.decision) && value.decision.type === "selection";
    case "AlternativesRejected": return eventKeys(value, ["decision"]) && isDecision(value.decision) && value.decision.type === "rejection";
    default: return false;
  }
}

function isEventMetadata(value: unknown): value is EventMetadata {
  if (!isRecord(value)) return false;
  return onlyKeys(value, ["eventId", "idempotencyKey", "fingerprint", "actor", "recordedAt"])
    && makeEventId(value.eventId).ok
    && makeIdempotencyKey(value.idempotencyKey).ok
    && makeCommandFingerprint(value.fingerprint).ok
    && isActor(value.actor)
    && makeIsoTimestamp(value.recordedAt).ok;
}

function isActor(value: unknown): value is DomainActor {
  if (!isRecord(value)) return false;
  if (value.type === "system") return onlyKeys(value, ["type"]);
  if (value.type === "user" || value.type === "plugin") return isText(value.id) && onlyKeys(value, ["type", "id"]);
  return value.type === "coach" && isId(value.coachId) && onlyKeys(value, ["type", "coachId"]);
}

function isProject(value: unknown): value is Project {
  if (!isRecord(value) || !isRecord(value.repository)) return false;
  return onlyKeys(value, ["id", "workspaceId", "repository", "baseRef", "title", "objective", "coachId", "goalIds", "runnerIds", "createdAt", "updatedAt"])
    && onlyKeys(value.repository, ["owner", "name"])
    && isId(value.id)
    && isId(value.workspaceId)
    && makeRepositoryOwner(value.repository.owner).ok
    && makeRepositoryName(value.repository.name).ok
    && makeGitRef(value.baseRef).ok
    && isText(value.title)
    && isText(value.objective)
    && isId(value.coachId)
    && isArray(value.goalIds, isId)
    && isArray(value.runnerIds, isId)
    && makeIsoTimestamp(value.createdAt).ok
    && makeIsoTimestamp(value.updatedAt).ok;
}

function isProjectPatch(value: unknown): value is ProjectPatch {
  if (!isRecord(value)) return false;
  return optional(value.title, isText)
    && optional(value.objective, isText)
    && optional(value.baseRef, item => makeGitRef(item).ok)
    && onlyKeys(value, ["title", "objective", "baseRef"]);
}

function isGoal(value: unknown): value is Goal {
  if (!isRecord(value)) return false;
  const base = isId(value.id)
    && isId(value.projectId)
    && isText(value.title)
    && isText(value.desiredOutcome)
    && isNonEmptyArray(value.acceptanceCriteria, isText)
    && isArray(value.constraints, isText)
    && isNonNegativeInteger(value.priority)
    && isAssignment(value.assignment)
    && isGoalRelation(value.relation)
    && makeIsoTimestamp(value.createdAt).ok
    && makeIsoTimestamp(value.updatedAt).ok;
  if (!base) return false;
  const baseKeys = [
    "id", "projectId", "title", "desiredOutcome", "acceptanceCriteria", "constraints",
    "priority", "assignment", "relation", "createdAt", "updatedAt", "status"
  ];
  if (value.status === "active") return onlyKeys(value, baseKeys);
  if (value.status === "paused") {
    return makeIsoTimestamp(value.pausedAt).ok
      && isText(value.pauseReason)
      && onlyKeys(value, [...baseKeys, "pausedAt", "pauseReason"]);
  }
  return value.status === "completed"
    && makeIsoTimestamp(value.completedAt).ok
    && isId(value.selectedRunId)
    && onlyKeys(value, [...baseKeys, "completedAt", "selectedRunId"]);
}

function isGoalPatch(value: unknown): value is GoalPatch {
  if (!isRecord(value)) return false;
  return optional(value.title, isText)
    && optional(value.desiredOutcome, isText)
    && optional(value.acceptanceCriteria, item => isNonEmptyArray(item, isText))
    && optional(value.constraints, item => isArray(item, isText))
    && optional(value.priority, isNonNegativeInteger)
    && optional(value.assignment, isAssignment)
    && optional(value.relation, isGoalRelation)
    && onlyKeys(value, ["title", "desiredOutcome", "acceptanceCriteria", "constraints", "priority", "assignment", "relation"]);
}

function isAssignment(value: unknown): boolean {
  return isRecord(value) && (value.type === "unassigned"
    ? onlyKeys(value, ["type"])
    : value.type === "assigned" && isId(value.runnerId) && onlyKeys(value, ["type", "runnerId"]));
}

function isGoalRelation(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.type === "root") return onlyKeys(value, ["type"]);
  if (value.type === "child") return isId(value.parentGoalId) && onlyKeys(value, ["type", "parentGoalId"]);
  return value.type === "related" && isNonEmptyArray(value.goalIds, isId) && onlyKeys(value, ["type", "goalIds"]);
}

function isResource(value: unknown): value is ResourceBinding {
  if (!isRecord(value) || !isText(value.name)) return false;
  return value.type === "skill"
    ? isText(value.source) && onlyKeys(value, ["type", "name", "source"])
    : value.type === "plugin" && isText(value.version) && onlyKeys(value, ["type", "name", "version"]);
}

function isPlayer(value: unknown): value is Player {
  if (!isRecord(value) || !isRecord(value.runtimePolicy)) return false;
  return onlyKeys(value, ["kind", "id", "projectId", "promptTemplate", "resources", "runtimePolicy", "createdAt", "updatedAt"])
    && value.kind === "player"
    && isId(value.id)
    && isId(value.projectId)
    && isText(value.promptTemplate)
    && isArray(value.resources, isResource)
    && (value.runtimePolicy.fileAccess === "read_only" || value.runtimePolicy.fileAccess === "project_write")
    && (value.runtimePolicy.network === "denied" || value.runtimePolicy.network === "allowed")
    && (value.runtimePolicy.approval === "user" || value.runtimePolicy.approval === "automatic")
    && makeIsoTimestamp(value.createdAt).ok
    && makeIsoTimestamp(value.updatedAt).ok;
}

function isTeam(value: unknown): value is Team {
  if (!isRecord(value) || !isRecord(value.strategy)) return false;
  return onlyKeys(value, ["kind", "id", "projectId", "strategy", "players", "createdAt", "updatedAt"])
    && onlyKeys(value.strategy, ["mode", "promptTemplate", "maxRounds"])
    && value.kind === "team"
    && isId(value.id)
    && isId(value.projectId)
    && (value.strategy.mode === "sequence" || value.strategy.mode === "parallel" || value.strategy.mode === "coordinated")
    && isText(value.strategy.promptTemplate)
    && isPositiveInteger(value.strategy.maxRounds)
    && isNonEmptyArray(value.players, isTeamPlayer)
    && makeIsoTimestamp(value.createdAt).ok
    && makeIsoTimestamp(value.updatedAt).ok;
}

function isTeamPlayer(value: unknown): boolean {
  return isRecord(value)
    && onlyKeys(value, ["playerId", "role", "order"])
    && isId(value.playerId)
    && isText(value.role)
    && isPositiveInteger(value.order);
}

function isCoach(value: unknown): value is Coach {
  if (!isRecord(value) || !isRecord(value.policy)) return false;
  return onlyKeys(value, ["id", "projectId", "promptTemplate", "resources", "policy", "createdAt", "updatedAt"])
    && onlyKeys(value.policy, ["goalChanges", "runnerChanges", "hunsu", "selection"])
    && isId(value.id)
    && isId(value.projectId)
    && isText(value.promptTemplate)
    && isArray(value.resources, isResource)
    && value.policy.goalChanges === "propose_only"
    && value.policy.runnerChanges === "propose_only"
    && value.policy.hunsu === "propose_only"
    && value.policy.selection === "user_only"
    && makeIsoTimestamp(value.createdAt).ok
    && makeIsoTimestamp(value.updatedAt).ok;
}

function isRunner(value: unknown): value is Runner {
  return isRecord(value) && (value.kind === "player" ? isPlayer(value) : value.kind === "team" && isTeam(value));
}

function isRunnerSnapshot(value: unknown): value is RunnerSnapshot {
  if (!isRecord(value) || !makeIsoTimestamp(value.capturedAt).ok) return false;
  if (value.kind === "player") {
    return onlyKeys(value, ["kind", "id", "projectId", "promptTemplate", "resources", "runtimePolicy", "capturedAt"])
      && isId(value.id)
      && isId(value.projectId)
      && isText(value.promptTemplate)
      && isArray(value.resources, isResource)
      && isRuntimePolicy(value.runtimePolicy);
  }
  if (value.kind !== "team" || !isRecord(value.strategy)) return false;
  return onlyKeys(value, ["kind", "id", "projectId", "strategy", "players", "capturedAt"])
    && onlyKeys(value.strategy, ["mode", "promptTemplate", "maxRounds"])
    && isId(value.id)
    && isId(value.projectId)
    && (value.strategy.mode === "sequence" || value.strategy.mode === "parallel" || value.strategy.mode === "coordinated")
    && isText(value.strategy.promptTemplate)
    && isPositiveInteger(value.strategy.maxRounds)
    && isNonEmptyArray(value.players, item => isRecord(item)
      && onlyKeys(item, ["slot", "player"])
      && isTeamPlayer(item.slot)
      && isRunnerSnapshot(item.player)
      && item.player.kind === "player");
}

function isRuntimePolicy(value: unknown): boolean {
  return isRecord(value)
    && onlyKeys(value, ["fileAccess", "network", "approval"])
    && (value.fileAccess === "read_only" || value.fileAccess === "project_write")
    && (value.network === "denied" || value.network === "allowed")
    && (value.approval === "user" || value.approval === "automatic");
}

function isRun(value: unknown): value is Run {
  if (!isRecord(value) || !isRecord(value.goalSnapshot)) return false;
  const base = isId(value.id)
    && isId(value.projectId)
    && isId(value.goalId)
    && isId(value.runnerId)
    && makeGitCommitSha(value.baseSha).ok
    && makeGitBranchName(value.branch).ok
    && isRunOrigin(value.origin)
    && isGoalSnapshot(value.goalSnapshot)
    && isRunnerSnapshot(value.runnerSnapshot)
    && isArray(value.checkpoints, isCheckpoint)
    && isArray(value.evidenceIds, isId)
    && makeIsoTimestamp(value.startedAt).ok;
  if (!base) return false;
  const baseKeys = [
    "id", "projectId", "goalId", "runnerId", "baseSha", "branch", "origin",
    "goalSnapshot", "runnerSnapshot", "checkpoints", "evidenceIds", "startedAt", "status"
  ];
  if (value.status === "running") return onlyKeys(value, baseKeys);
  if (value.status === "completed") {
    return makeGitCommitSha(value.resultSha).ok
      && makeIsoTimestamp(value.verifiedAt).ok
      && makeIsoTimestamp(value.completedAt).ok
      && onlyKeys(value, [...baseKeys, "resultSha", "verifiedAt", "completedAt"]);
  }
  if (value.status === "failed") {
    return makeIsoTimestamp(value.failedAt).ok
      && isText(value.failureReason)
      && onlyKeys(value, [...baseKeys, "failedAt", "failureReason"]);
  }
  return value.status === "canceled"
    && makeIsoTimestamp(value.canceledAt).ok
    && isText(value.cancellationReason)
    && onlyKeys(value, [...baseKeys, "canceledAt", "cancellationReason"]);
}

function isRunOrigin(value: unknown): boolean {
  return isRecord(value) && (value.type === "primary"
    ? onlyKeys(value, ["type"])
    : value.type === "hunsu_alternative"
      && isId(value.divergenceId)
      && isId(value.sourceRunId)
      && onlyKeys(value, ["type", "divergenceId", "sourceRunId"]));
}

function isGoalSnapshot(value: unknown): boolean {
  return isRecord(value)
    && onlyKeys(value, ["id", "projectId", "title", "desiredOutcome", "acceptanceCriteria", "constraints", "priority", "assignment", "relation", "capturedAt"])
    && isId(value.id)
    && isId(value.projectId)
    && isText(value.title)
    && isText(value.desiredOutcome)
    && isNonEmptyArray(value.acceptanceCriteria, isText)
    && isArray(value.constraints, isText)
    && isNonNegativeInteger(value.priority)
    && isAssignment(value.assignment)
    && isGoalRelation(value.relation)
    && makeIsoTimestamp(value.capturedAt).ok;
}

function isCheckpoint(value: unknown): boolean {
  return isRecord(value)
    && onlyKeys(value, ["id", "runId", "summary", "commitSha", "recordedAt"])
    && isId(value.id)
    && isId(value.runId)
    && isText(value.summary)
    && optional(value.commitSha, item => makeGitCommitSha(item).ok)
    && makeIsoTimestamp(value.recordedAt).ok;
}

function isEvidence(value: unknown): value is EvidenceRef {
  if (!isRecord(value) || !isRecord(value.location)) return false;
  const location = value.location.type === "git"
    ? makeGitCommitSha(value.location.commitSha).ok
      && isText(value.location.path)
      && onlyKeys(value.location, ["type", "commitSha", "path"])
    : value.location.type === "url"
      ? isText(value.location.url) && onlyKeys(value.location, ["type", "url"])
      : value.location.type === "text"
        && isText(value.location.text)
        && onlyKeys(value.location, ["type", "text"]);
  return onlyKeys(value, ["id", "projectId", "runId", "criterion", "kind", "summary", "location", "recordedAt"])
    && isId(value.id)
    && isId(value.projectId)
    && isId(value.runId)
    && optional(value.criterion, isText)
    && (value.kind === "diff" || value.kind === "check" || value.kind === "screenshot" || value.kind === "report" || value.kind === "note")
    && isText(value.summary)
    && location
    && makeIsoTimestamp(value.recordedAt).ok;
}

function isVerifiedResult(value: unknown): boolean {
  return isRecord(value)
    && onlyKeys(value, ["runId", "branch", "resultSha", "verifiedAt"])
    && isId(value.runId)
    && makeGitBranchName(value.branch).ok
    && makeGitCommitSha(value.resultSha).ok
    && makeIsoTimestamp(value.verifiedAt).ok;
}

function isCoachReview(value: unknown): value is CoachReview {
  return isRecord(value)
    && onlyKeys(value, ["id", "projectId", "coachId", "target", "assessment", "recommendations", "recordedAt"])
    && isId(value.id)
    && isId(value.projectId)
    && isId(value.coachId)
    && isReviewTarget(value.target)
    && isText(value.assessment)
    && isArray(value.recommendations, isText)
    && makeIsoTimestamp(value.recordedAt).ok;
}

function isReviewTarget(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.type === "project") return isId(value.projectId) && onlyKeys(value, ["type", "projectId"]);
  if (value.type === "goal") return isId(value.goalId) && onlyKeys(value, ["type", "goalId"]);
  if (value.type === "run") return isId(value.runId) && onlyKeys(value, ["type", "runId"]);
  return value.type === "comparison" && isId(value.comparisonId) && onlyKeys(value, ["type", "comparisonId"]);
}

function isCoachProposal(value: unknown): value is CoachProposal {
  if (!isRecord(value)) return false;
  const base = isId(value.id) && isId(value.projectId) && isId(value.coachId) && isText(value.reason) && makeIsoTimestamp(value.proposedAt).ok;
  if (!base) return false;
  const common = ["type", "id", "projectId", "coachId", "reason", "proposedAt"];
  if (value.type === "goal_change") return isId(value.goalId) && isGoalPatch(value.change) && onlyKeys(value, [...common, "goalId", "change"]);
  if (value.type === "runner_change") return isId(value.goalId) && isId(value.runnerId) && onlyKeys(value, [...common, "goalId", "runnerId"]);
  return value.type === "hunsu"
    && isId(value.goalId)
    && isId(value.sourceRunId)
    && isRecord(value.alternative)
    && (value.alternative.type === "goal_change"
      ? isGoalPatch(value.alternative.change) && onlyKeys(value.alternative, ["type", "change"])
      : value.alternative.type === "runner_change"
        && isId(value.alternative.runnerId)
        && onlyKeys(value.alternative, ["type", "runnerId"]))
    && onlyKeys(value, [...common, "goalId", "sourceRunId", "alternative"]);
}

function isCoachProposalDecision(value: unknown): value is CoachProposalDecision {
  if (!isRecord(value)
    || !isId(value.id)
    || !isId(value.proposalId)
    || !isText(value.reason)
    || !makeIsoTimestamp(value.decidedAt).ok) return false;
  if (value.status === "rejected") {
    return onlyKeys(value, ["status", "id", "proposalId", "reason", "decidedAt"]);
  }
  if (value.status !== "accepted" || !isRecord(value.application)) return false;
  const application = value.application.type === "goal_change" || value.application.type === "runner_change"
    ? isGoal(value.application.goal)
      && value.application.goal.status !== "completed"
      && onlyKeys(value.application, ["type", "goal"])
    : value.application.type === "hunsu"
      && isDivergence(value.application.divergence)
      && isGoal(value.application.goal)
      && value.application.goal.status !== "completed"
      && onlyKeys(value.application, ["type", "divergence", "goal"]);
  return application && onlyKeys(value, ["status", "id", "proposalId", "reason", "decidedAt", "application"]);
}

function isDivergence(value: unknown): value is HunsuDivergence {
  return isRecord(value)
    && onlyKeys(value, ["id", "projectId", "goalId", "sourceRunId", "baseSha", "basis", "alternativeRunIds", "confirmedAt"])
    && isId(value.id)
    && isId(value.projectId)
    && isId(value.goalId)
    && isId(value.sourceRunId)
    && makeGitCommitSha(value.baseSha).ok
    && isHunsuBasis(value.basis)
    && isArray(value.alternativeRunIds, isId)
    && makeIsoTimestamp(value.confirmedAt).ok;
}

function isHunsuBasis(value: unknown): boolean {
  return isRecord(value) && (value.type === "user"
    ? isText(value.reason) && onlyKeys(value, ["type", "reason"])
    : value.type === "coach_proposal" && isId(value.proposalId) && onlyKeys(value, ["type", "proposalId"]));
}

function isComparison(value: unknown): value is AlternativeComparison {
  return isRecord(value)
    && onlyKeys(value, ["id", "projectId", "goalId", "divergenceId", "baseSha", "runIds", "findings", "summary", "recordedAt"])
    && isId(value.id)
    && isId(value.projectId)
    && isId(value.goalId)
    && isId(value.divergenceId)
    && makeGitCommitSha(value.baseSha).ok
    && isArray(value.runIds, isId)
    && value.runIds.length >= 2
    && isArray(value.findings, isFinding)
    && isText(value.summary)
    && makeIsoTimestamp(value.recordedAt).ok;
}

function isFinding(value: unknown): boolean {
  return isRecord(value)
    && onlyKeys(value, ["criterion", "summaries"])
    && isText(value.criterion)
    && isNonEmptyArray(value.summaries, item => isRecord(item)
      && onlyKeys(item, ["runId", "summary"])
      && isId(item.runId)
      && isText(item.summary));
}

function isDecision(value: unknown): value is AlternativeDecision {
  if (!isRecord(value) || !isId(value.id) || !isId(value.comparisonId) || !isText(value.rationale) || !makeIsoTimestamp(value.decidedAt).ok) return false;
  if (value.type === "selection") {
    return isId(value.selectedRunId)
      && isArray(value.rejectedRunIds, isId)
      && onlyKeys(value, ["type", "id", "comparisonId", "selectedRunId", "rejectedRunIds", "rationale", "decidedAt"]);
  }
  return value.type === "rejection"
    && isNonEmptyArray(value.rejectedRunIds, isId)
    && onlyKeys(value, ["type", "id", "comparisonId", "rejectedRunIds", "rationale", "decidedAt"]);
}

function isProjectState(value: unknown): value is ProjectState {
  return isRecord(value)
    && onlyKeys(value, [
      "projects", "goals", "runners", "coaches", "runs", "evidence", "coachReviews",
      "coachProposals", "coachProposalDecisions", "divergences", "comparisons", "decisions",
      "processedCommands"
    ])
    && isArray(value.projects, isProject)
    && isArray(value.goals, isGoal)
    && isArray(value.runners, isRunner)
    && isArray(value.coaches, isCoach)
    && isArray(value.runs, isRun)
    && isArray(value.evidence, isEvidence)
    && isArray(value.coachReviews, isCoachReview)
    && isArray(value.coachProposals, isCoachProposal)
    && isArray(value.coachProposalDecisions, isCoachProposalDecision)
    && isArray(value.divergences, isDivergence)
    && isArray(value.comparisons, isComparison)
    && isArray(value.decisions, isDecision)
    && isArray(value.processedCommands, item => isRecord(item)
      && onlyKeys(item, ["idempotencyKey", "fingerprint", "eventId"])
      && makeIdempotencyKey(item.idempotencyKey).ok
      && makeCommandFingerprint(item.fingerprint).ok
      && makeEventId(item.eventId).ok);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isArray<T>(value: unknown, guard: (item: unknown) => item is T): value is T[];
function isArray(value: unknown, guard: (item: unknown) => boolean): value is unknown[];
function isArray(value: unknown, guard: (item: unknown) => boolean): value is unknown[] {
  return Array.isArray(value) && value.every(guard);
}

function isNonEmptyArray(value: unknown, guard: (item: unknown) => boolean): value is [unknown, ...unknown[]] {
  return Array.isArray(value) && value.length > 0 && value.every(guard);
}

function isId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(value);
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function optional(value: unknown, guard: (item: unknown) => boolean): boolean {
  return value === undefined || guard(value);
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every(key => keys.includes(key));
}

function eventKeys(value: Record<string, unknown>, payloadKeys: readonly string[]): boolean {
  return onlyKeys(value, ["type", "meta", ...payloadKeys]);
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, item]) => [key, sortJson(item)]));
}

function codecFailure(message: string): Result<never, ProtocolCodecError> {
  return err({ type: "ProtocolCodecError", message });
}
