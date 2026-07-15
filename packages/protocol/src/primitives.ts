import { err, ok, type Result } from "./result.ts";

declare const domainBrand: unique symbol;

export type Brand<T, Name extends string> = T & {
  readonly [domainBrand]: Name;
};

export type ProjectId = Brand<string, "ProjectId">;
export type GoalKey = Brand<string, "GoalKey">;
export type RunId = Brand<string, "RunId">;
export type WorkspaceId = Brand<string, "WorkspaceId">;
export type EventId = Brand<string, "EventId">;
export type EvidenceId = Brand<string, "EvidenceId">;
export type CheckpointId = Brand<string, "CheckpointId">;
export type CoachReviewId = Brand<string, "CoachReviewId">;
export type CoachingProposalId = Brand<string, "CoachingProposalId">;
export type ComparisonId = Brand<string, "ComparisonId">;
export type DecisionId = Brand<string, "DecisionId">;
export type IdempotencyKey = Brand<string, "IdempotencyKey">;
export type CommandFingerprint = Brand<string, "CommandFingerprint">;
export type GitCommitSha = Brand<string, "GitCommitSha">;
export type GitTreeSha = Brand<string, "GitTreeSha">;
export type GitTreePath = Brand<string, "GitTreePath">;
export type GitRef = Brand<string, "GitRef">;
export type GitBranchName = Brand<string, "GitBranchName">;
export type RepositoryOwner = Brand<string, "RepositoryOwner">;
export type RepositoryName = Brand<string, "RepositoryName">;
export type IsoTimestamp = Brand<string, "IsoTimestamp">;
export type NonEmptyText = Brand<string, "NonEmptyText">;
export type ProjectTitle = Brand<string, "ProjectTitle">;
export type GoalTitle = Brand<string, "GoalTitle">;
export type DesiredOutcome = Brand<string, "DesiredOutcome">;
export type AcceptanceCriterion = Brand<string, "AcceptanceCriterion">;
export type GoalConstraint = Brand<string, "GoalConstraint">;
export type PromptTemplate = Brand<string, "PromptTemplate">;
export type EvidenceSummary = Brand<string, "EvidenceSummary">;
export type ResourceName = Brand<string, "ResourceName">;
export type Reason = Brand<string, "Reason">;
export type RunnerTypeOrigin = Brand<string, "RunnerTypeOrigin">;
export type RunnerTypeKey = Brand<string, "RunnerTypeKey">;
export type RunnerSchemaVersion = Brand<string, "RunnerSchemaVersion">;
export type RunnerTypeIntegrity = Brand<string, "RunnerTypeIntegrity">;
export type GoalDigest = Brand<string, "GoalDigest">;
export type RunnerDigest = Brand<string, "RunnerDigest">;
export type NodePlanDigest = Brand<string, "NodePlanDigest">;
export type NodePayloadDigest = Brand<string, "NodePayloadDigest">;
export type Base64Payload = Brand<string, "Base64Payload">;
export type PositiveInteger = Brand<number, "PositiveInteger">;
export type NonNegativeInteger = Brand<number, "NonNegativeInteger">;
export type NonEmptyArray<T> = readonly [T, ...T[]];
export type AtLeastTwo<T> = readonly [T, T, ...T[]];

export type PrimitiveError = {
  readonly type: "PrimitiveError";
  readonly field: string;
  readonly message: string;
};

export function makeProjectId(value: unknown): Result<ProjectId, PrimitiveError> {
  return makeId(value, "projectId");
}

export function makeGoalKey(value: unknown): Result<GoalKey, PrimitiveError> {
  return makeId(value, "goalKey");
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

export function makeCoachingProposalId(value: unknown): Result<CoachingProposalId, PrimitiveError> {
  return makeId(value, "coachingProposalId");
}

export function makeComparisonId(value: unknown): Result<ComparisonId, PrimitiveError> {
  return makeId(value, "comparisonId");
}

export function makeDecisionId(value: unknown): Result<DecisionId, PrimitiveError> {
  return makeId(value, "decisionId");
}

export function makeIdempotencyKey(value: unknown): Result<IdempotencyKey, PrimitiveError> {
  return makeSha256(value, "idempotencyKey") as Result<IdempotencyKey, PrimitiveError>;
}

export function makeCommandFingerprint(value: unknown): Result<CommandFingerprint, PrimitiveError> {
  return makeSha256(value, "commandFingerprint") as Result<CommandFingerprint, PrimitiveError>;
}

export function makeGoalDigest(value: unknown): Result<GoalDigest, PrimitiveError> {
  return makePrefixedDigest(value, "goalDigest", "hunsu-goal-v1:sha256:") as Result<GoalDigest, PrimitiveError>;
}

export function makeRunnerDigest(value: unknown): Result<RunnerDigest, PrimitiveError> {
  return makePrefixedDigest(value, "runnerDigest", "hunsu-runner-v1:sha256:") as Result<RunnerDigest, PrimitiveError>;
}

export function makeNodePlanDigest(value: unknown): Result<NodePlanDigest, PrimitiveError> {
  return makePrefixedDigest(value, "nodePlanDigest", "hunsu-node-plan-v1:sha256:") as Result<NodePlanDigest, PrimitiveError>;
}

export function makeNodePayloadDigest(value: unknown): Result<NodePayloadDigest, PrimitiveError> {
  return makePrefixedDigest(value, "nodePayloadDigest", "hunsu-node-payload-v1:sha256:") as Result<NodePayloadDigest, PrimitiveError>;
}

export function makeGitCommitSha(value: unknown, field = "sha"): Result<GitCommitSha, PrimitiveError> {
  return makeGitSha(value, field) as Result<GitCommitSha, PrimitiveError>;
}

export function makeGitTreeSha(value: unknown, field = "treeSha"): Result<GitTreeSha, PrimitiveError> {
  return makeGitSha(value, field) as Result<GitTreeSha, PrimitiveError>;
}

export function makeGitTreePath(value: unknown, field = "path"): Result<GitTreePath, PrimitiveError> {
  if (typeof value !== "string"
    || value.length === 0
    || value.length > 4096
    || value.startsWith("/")
    || value.endsWith("/")
    || value.includes("\\")
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    return invalid(field, field + " must be a normalized commit-relative Git tree path");
  }
  const segments = value.split("/");
  if (segments.some(segment => segment === "" || segment === "." || segment === "..")) {
    return invalid(field, field + " must be a normalized commit-relative Git tree path");
  }
  return ok(value as GitTreePath);
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

export function makeRunnerTypeOrigin(value: unknown, field = "runner.type.origin"): Result<RunnerTypeOrigin, PrimitiveError> {
  if (typeof value !== "string" || !/^[a-z0-9](?:[a-z0-9._-]{0,127})$/u.test(value)) {
    return invalid(field, field + " must be a lowercase committed origin");
  }
  return ok(value as RunnerTypeOrigin);
}

export function makeRunnerTypeKey(value: unknown, field = "runner.type.key"): Result<RunnerTypeKey, PrimitiveError> {
  if (typeof value !== "string" || value.length > 192 || !/^[a-z0-9](?:[a-z0-9._/-]*[a-z0-9])?$/u.test(value) || value.includes("//")) {
    return invalid(field, field + " must be a lowercase stable type key");
  }
  return ok(value as RunnerTypeKey);
}

export function makeRunnerSchemaVersion(value: unknown, field = "runner.type.schemaVersion"): Result<RunnerSchemaVersion, PrimitiveError> {
  if (typeof value !== "string" || !SEMVER.test(value)) {
    return invalid(field, field + " must be an exact semantic version");
  }
  return ok(value as RunnerSchemaVersion);
}

export function makeRunnerTypeIntegrity(value: unknown, field = "runner.type.integrity"): Result<RunnerTypeIntegrity, PrimitiveError> {
  return makePrefixedDigest(value, field, "hunsu-runner-type-v1:sha256:") as Result<RunnerTypeIntegrity, PrimitiveError>;
}

export function makeBase64Payload(value: unknown, field = "data"): Result<Base64Payload, PrimitiveError> {
  if (typeof value !== "string" || value.length === 0 || value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    return invalid(field, field + " must be canonical padded base64");
  }
  return ok(value as Base64Payload);
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

export function makeAtLeastTwo<T>(value: readonly T[], field = "items"): Result<AtLeastTwo<T>, PrimitiveError> {
  return value.length >= 2
    ? ok(value as AtLeastTwo<T>)
    : invalid(field, field + " must contain at least two items");
}

function makeId<T extends string>(value: unknown, field: string): Result<Brand<string, T>, PrimitiveError> {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(value) || value.includes("..")) {
    return invalid(field, field + " must be a branch-safe identifier");
  }
  return ok(value as Brand<string, T>);
}

function makeTextBrand<T extends string>(value: unknown, field: string): Result<Brand<string, T>, PrimitiveError> {
  const text = makeNonEmptyText(value, field);
  return text.ok ? ok(text.value as Brand<string, T>) : text;
}

function makeSha256<T extends string>(value: unknown, field: string): Result<Brand<string, T>, PrimitiveError> {
  if (typeof value !== "string" || !/^(?:sha256:)?[0-9a-f]{64}$/u.test(value)) {
    return invalid(field, field + " must be a lowercase SHA-256 hexadecimal digest");
  }
  return ok(value as Brand<string, T>);
}

function makePrefixedDigest<T extends string>(value: unknown, field: string, prefix: string): Result<Brand<string, T>, PrimitiveError> {
  if (typeof value !== "string" || !value.startsWith(prefix) || !/^[0-9a-f]{64}$/u.test(value.slice(prefix.length))) {
    return invalid(field, field + " must use " + prefix + " followed by 64 lowercase hexadecimal characters");
  }
  return ok(value as Brand<string, T>);
}

function makeGitSha<T extends string>(value: unknown, field: string): Result<Brand<string, T>, PrimitiveError> {
  if (typeof value !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value)) {
    return invalid(field, field + " must be a lowercase 40- or 64-character hexadecimal Git object SHA");
  }
  return ok(value as Brand<string, T>);
}

function isValidRefName(value: string): boolean {
  if (value.length > 1024 || value.endsWith("/") || value.endsWith(".") || value.endsWith(".lock")) return false;
  if (value.includes("..") || value.includes("@{") || value.includes("//")) return false;
  if (/[\u0000-\u0020\u007f~^:?*\[\\]/u.test(value)) return false;
  return value.split("/").every(part => part !== "" && part !== "." && part !== ".." && !part.startsWith(".") && !part.endsWith(".lock"));
}

function invalid(field: string, message: string): Result<never, PrimitiveError> {
  return err({ type: "PrimitiveError", field, message });
}

const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
