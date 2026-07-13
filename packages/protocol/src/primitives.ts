import { err, ok, type Result } from "./result.ts";

declare const domainBrand: unique symbol;

export type Brand<T, Name extends string> = T & {
  readonly [domainBrand]: Name;
};

export type ProjectId = Brand<string, "ProjectId">;
export type GoalId = Brand<string, "GoalId">;
export type RunnerId = Brand<string, "RunnerId">;
export type CoachId = Brand<string, "CoachId">;
export type RunId = Brand<string, "RunId">;
export type WorkspaceId = Brand<string, "WorkspaceId">;
export type EventId = Brand<string, "EventId">;
export type EvidenceId = Brand<string, "EvidenceId">;
export type CheckpointId = Brand<string, "CheckpointId">;
export type CoachReviewId = Brand<string, "CoachReviewId">;
export type CoachProposalId = Brand<string, "CoachProposalId">;
export type DivergenceId = Brand<string, "DivergenceId">;
export type ComparisonId = Brand<string, "ComparisonId">;
export type DecisionId = Brand<string, "DecisionId">;
export type IdempotencyKey = Brand<string, "IdempotencyKey">;
export type CommandFingerprint = Brand<string, "CommandFingerprint">;
export type GitCommitSha = Brand<string, "GitCommitSha">;
export type GitRef = Brand<string, "GitRef">;
export type GitBranchName = Brand<string, "GitBranchName">;
export type RepositoryOwner = Brand<string, "RepositoryOwner">;
export type RepositoryName = Brand<string, "RepositoryName">;
export type IsoTimestamp = Brand<string, "IsoTimestamp">;
export type NonEmptyText = Brand<string, "NonEmptyText">;
export type ProjectTitle = Brand<string, "ProjectTitle">;
export type ProjectObjective = Brand<string, "ProjectObjective">;
export type GoalTitle = Brand<string, "GoalTitle">;
export type DesiredOutcome = Brand<string, "DesiredOutcome">;
export type AcceptanceCriterion = Brand<string, "AcceptanceCriterion">;
export type GoalConstraint = Brand<string, "GoalConstraint">;
export type PromptTemplate = Brand<string, "PromptTemplate">;
export type EvidenceSummary = Brand<string, "EvidenceSummary">;
export type ResourceName = Brand<string, "ResourceName">;
export type Reason = Brand<string, "Reason">;
export type PositiveInteger = Brand<number, "PositiveInteger">;
export type NonNegativeInteger = Brand<number, "NonNegativeInteger">;
export type NonEmptyArray<T> = readonly [T, ...T[]];

export type PrimitiveError = {
  readonly type: "PrimitiveError";
  readonly field: string;
  readonly message: string;
};

export function makeProjectId(value: unknown): Result<ProjectId, PrimitiveError> {
  return makeId(value, "projectId");
}

export function makeGoalId(value: unknown): Result<GoalId, PrimitiveError> {
  return makeId(value, "goalId");
}

export function makeRunnerId(value: unknown): Result<RunnerId, PrimitiveError> {
  return makeId(value, "runnerId");
}

export function makeCoachId(value: unknown): Result<CoachId, PrimitiveError> {
  return makeId(value, "coachId");
}

export function makeRunId(value: unknown): Result<RunId, PrimitiveError> {
  return makeId(value, "runId");
}

export function makeWorkspaceId(value: unknown): Result<WorkspaceId, PrimitiveError> {
  return makeId(value, "workspaceId");
}

export function makeEventId(value: unknown): Result<EventId, PrimitiveError> {
  return makeId(value, "eventId");
}

export function makeEvidenceId(value: unknown): Result<EvidenceId, PrimitiveError> {
  return makeId(value, "evidenceId");
}

export function makeCheckpointId(value: unknown): Result<CheckpointId, PrimitiveError> {
  return makeId(value, "checkpointId");
}

export function makeCoachReviewId(value: unknown): Result<CoachReviewId, PrimitiveError> {
  return makeId(value, "coachReviewId");
}

export function makeCoachProposalId(value: unknown): Result<CoachProposalId, PrimitiveError> {
  return makeId(value, "coachProposalId");
}

export function makeDivergenceId(value: unknown): Result<DivergenceId, PrimitiveError> {
  return makeId(value, "divergenceId");
}

export function makeComparisonId(value: unknown): Result<ComparisonId, PrimitiveError> {
  return makeId(value, "comparisonId");
}

export function makeDecisionId(value: unknown): Result<DecisionId, PrimitiveError> {
  return makeId(value, "decisionId");
}

export function makeIdempotencyKey(value: unknown): Result<IdempotencyKey, PrimitiveError> {
  if (typeof value !== "string" || !/^(?:sha256:)?[0-9a-f]{64}$/iu.test(value)) {
    return invalid("idempotencyKey", "idempotencyKey must be a SHA-256 hexadecimal digest");
  }
  return ok(value.toLowerCase() as IdempotencyKey);
}

export function makeCommandFingerprint(value: unknown): Result<CommandFingerprint, PrimitiveError> {
  if (typeof value !== "string" || !/^(?:sha256:)?[0-9a-f]{64}$/iu.test(value)) {
    return invalid("commandFingerprint", "commandFingerprint must be a SHA-256 hexadecimal digest");
  }
  return ok(value.toLowerCase() as CommandFingerprint);
}

export function makeGitCommitSha(value: unknown, field = "sha"): Result<GitCommitSha, PrimitiveError> {
  if (typeof value !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu.test(value)) {
    return invalid(field, field + " must be a 40- or 64-character hexadecimal Git commit SHA");
  }
  return ok(value.toLowerCase() as GitCommitSha);
}

export function makeGitRef(value: unknown, field = "ref"): Result<GitRef, PrimitiveError> {
  if (typeof value !== "string" || !value.startsWith("refs/") || !isValidRefName(value)) {
    return invalid(field, field + " must be a fully qualified, safe Git ref");
  }
  return ok(value as GitRef);
}

export function makeGitBranchName(value: unknown, field = "branch"): Result<GitBranchName, PrimitiveError> {
  if (typeof value !== "string" || value.startsWith("refs/") || !isValidRefName("refs/heads/" + value)) {
    return invalid(field, field + " must be a safe Git branch name without refs/heads/");
  }
  return ok(value as GitBranchName);
}

export function makeRepositoryOwner(value: unknown): Result<RepositoryOwner, PrimitiveError> {
  if (typeof value !== "string" || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u.test(value)) {
    return invalid("repository.owner", "repository.owner must be a safe account or organization name");
  }
  return ok(value as RepositoryOwner);
}

export function makeRepositoryName(value: unknown): Result<RepositoryName, PrimitiveError> {
  if (typeof value !== "string" || value.length > 100 || !/^[A-Za-z0-9._-]+$/u.test(value) || value === "." || value === "..") {
    return invalid("repository.name", "repository.name must be a safe repository name");
  }
  return ok(value as RepositoryName);
}

export function makeIsoTimestamp(value: unknown, field = "timestamp"): Result<IsoTimestamp, PrimitiveError> {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u.test(value) || !Number.isFinite(Date.parse(value))) {
    return invalid(field, field + " must be a valid RFC 3339 timestamp");
  }
  return ok(value as IsoTimestamp);
}

export function makeNonEmptyText(value: unknown, field = "text"): Result<NonEmptyText, PrimitiveError> {
  if (typeof value !== "string" || value.trim() === "") {
    return invalid(field, field + " must be non-empty text");
  }
  return ok(value as NonEmptyText);
}

export function makeProjectTitle(value: unknown): Result<ProjectTitle, PrimitiveError> {
  return makeTextBrand(value, "title");
}

export function makeProjectObjective(value: unknown): Result<ProjectObjective, PrimitiveError> {
  return makeTextBrand(value, "objective");
}

export function makeGoalTitle(value: unknown): Result<GoalTitle, PrimitiveError> {
  return makeTextBrand(value, "title");
}

export function makeDesiredOutcome(value: unknown): Result<DesiredOutcome, PrimitiveError> {
  return makeTextBrand(value, "desiredOutcome");
}

export function makeAcceptanceCriterion(value: unknown, field = "acceptanceCriterion"): Result<AcceptanceCriterion, PrimitiveError> {
  return makeTextBrand(value, field);
}

export function makeGoalConstraint(value: unknown, field = "constraint"): Result<GoalConstraint, PrimitiveError> {
  return makeTextBrand(value, field);
}

export function makePromptTemplate(value: unknown, field = "promptTemplate"): Result<PromptTemplate, PrimitiveError> {
  return makeTextBrand(value, field);
}

export function makeEvidenceSummary(value: unknown, field = "summary"): Result<EvidenceSummary, PrimitiveError> {
  return makeTextBrand(value, field);
}

export function makeResourceName(value: unknown, field = "resourceName"): Result<ResourceName, PrimitiveError> {
  return makeTextBrand(value, field);
}

export function makeReason(value: unknown, field = "reason"): Result<Reason, PrimitiveError> {
  return makeTextBrand(value, field);
}

export function makePositiveInteger(value: unknown, field = "number"): Result<PositiveInteger, PrimitiveError> {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    return invalid(field, field + " must be a positive safe integer");
  }
  return ok(value as PositiveInteger);
}

export function makeNonNegativeInteger(value: unknown, field = "number"): Result<NonNegativeInteger, PrimitiveError> {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    return invalid(field, field + " must be a non-negative safe integer");
  }
  return ok(value as NonNegativeInteger);
}

export function makeNonEmptyArray<T>(value: readonly T[], field = "items"): Result<NonEmptyArray<T>, PrimitiveError> {
  return value.length > 0
    ? ok(value as NonEmptyArray<T>)
    : invalid(field, field + " must contain at least one item");
}

function makeId<T extends string>(value: unknown, field: string): Result<Brand<string, T>, PrimitiveError> {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(value)) {
    return invalid(field, field + " must be a branch-safe identifier");
  }
  return ok(value as Brand<string, T>);
}

function makeTextBrand<T extends string>(value: unknown, field: string): Result<Brand<string, T>, PrimitiveError> {
  const text = makeNonEmptyText(value, field);
  return text.ok ? ok(text.value as Brand<string, T>) : text;
}

function isValidRefName(value: string): boolean {
  if (value.length > 1024 || value.endsWith("/") || value.endsWith(".") || value.endsWith(".lock")) return false;
  if (value.includes("..") || value.includes("@{") || value.includes("//")) return false;
  if (/[\u0000-\u0020\u007f~^:?*\\[\\\\]/u.test(value)) return false;
  return value.split("/").every(part => part !== "" && part !== "." && part !== ".." && !part.startsWith(".") && !part.endsWith(".lock"));
}

function invalid(field: string, message: string): Result<never, PrimitiveError> {
  return err({ type: "PrimitiveError", field, message });
}
