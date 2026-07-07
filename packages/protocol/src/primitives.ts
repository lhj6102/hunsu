import { err, ok, type Result } from "./result.ts";

export type Brand<T, Name extends string> = T & { readonly __brand: Name };
export type NonEmptyText = Brand<string, "NonEmptyText">;
export type RequestTitle = Brand<string, "RequestTitle">;
export type RequestGoal = Brand<string, "RequestGoal">;
export type DestinationTitle = Brand<string, "DestinationTitle">;
export type DestinationAcceptanceCriterion = Brand<string, "DestinationAcceptanceCriterion">;
export type DestinationConstraint = Brand<string, "DestinationConstraint">;
export type DestinationNotes = Brand<string, "DestinationNotes">;
export type Summary = Brand<string, "Summary">;
export type EvidenceText = Brand<string, "EvidenceText">;
export type FailureReason = Brand<string, "FailureReason">;
export type RiskText = Brand<string, "RiskText">;
export type MoveCommit = Brand<string, "MoveCommit">;
export type TeamName = Brand<string, "TeamName">;
export type PositiveInteger = Brand<number, "PositiveInteger">;
export type NonNegativeInteger = Brand<number, "NonNegativeInteger">;
export type NonEmptyArray<T> = [T, ...T[]];
export type SingleItemArray<T> = [T];

export type PrimitiveValidationError = {
  type: "PrimitiveValidationError";
  field: string;
  message: string;
};

export function makeNonEmptyText(value: unknown, field = "text"): Result<NonEmptyText, PrimitiveValidationError> {
  if (typeof value !== "string" || value.trim() === "") {
    return invalid(field, `${field} must be a non-empty string`);
  }
  return ok(value as NonEmptyText);
}

export function makeRequestTitle(value: unknown): Result<RequestTitle, PrimitiveValidationError> {
  return makeTextBrand(value, "title");
}

export function makeRequestGoal(value: unknown): Result<RequestGoal, PrimitiveValidationError> {
  return makeTextBrand(value, "goal");
}

export function makeDestinationTitle(value: unknown, field = "title"): Result<DestinationTitle, PrimitiveValidationError> {
  return makeTextBrand(value, field);
}

export function makeDestinationAcceptanceCriterion(value: unknown, field = "acceptanceCriterion"): Result<DestinationAcceptanceCriterion, PrimitiveValidationError> {
  return makeTextBrand(value, field);
}

export function makeDestinationConstraint(value: unknown, field = "constraint"): Result<DestinationConstraint, PrimitiveValidationError> {
  return makeTextBrand(value, field);
}

export function makeDestinationNotes(value: unknown, field = "notes"): Result<DestinationNotes, PrimitiveValidationError> {
  return makeTextBrand(value, field);
}

export function makeSummary(value: unknown, field = "summary"): Result<Summary, PrimitiveValidationError> {
  return makeTextBrand(value, field);
}

export function makeEvidenceText(value: unknown, field = "evidence"): Result<EvidenceText, PrimitiveValidationError> {
  return makeTextBrand(value, field);
}

export function makeFailureReason(value: unknown, field = "failureReason"): Result<FailureReason, PrimitiveValidationError> {
  return makeTextBrand(value, field);
}

export function makeRiskText(value: unknown, field = "risk"): Result<RiskText, PrimitiveValidationError> {
  return makeTextBrand(value, field);
}

export function makeMoveCommit(value: unknown, field = "commit"): Result<MoveCommit, PrimitiveValidationError> {
  return makeTextBrand(value, field);
}

export function makeTeamName(value: unknown, field = "teamName"): Result<TeamName, PrimitiveValidationError> {
  return makeTextBrand(value, field);
}

export function makePositiveInteger(value: unknown, field = "number"): Result<PositiveInteger, PrimitiveValidationError> {
  if (!Number.isInteger(value) || Number(value) < 1) {
    return invalid(field, `${field} must be a positive integer`);
  }
  return ok(value as PositiveInteger);
}

export function makeNonNegativeInteger(value: unknown, field = "number"): Result<NonNegativeInteger, PrimitiveValidationError> {
  if (!Number.isInteger(value) || Number(value) < 0) {
    return invalid(field, `${field} must be a non-negative integer`);
  }
  return ok(value as NonNegativeInteger);
}

export function makeNonEmptyArray<T>(value: T[], field = "array"): Result<NonEmptyArray<T>, PrimitiveValidationError> {
  if (value.length === 0) {
    return invalid(field, `${field} must include at least one item`);
  }
  return ok(value as NonEmptyArray<T>);
}

export function makeSingleItemArray<T>(value: T[], field = "array"): Result<SingleItemArray<T>, PrimitiveValidationError> {
  if (value.length !== 1) {
    return invalid(field, `${field} must include exactly one item`);
  }
  return ok(value as SingleItemArray<T>);
}

export function makeDomainId<T extends string>(value: unknown, field: string): Result<Brand<string, T>, PrimitiveValidationError> {
  const text = makeNonEmptyText(value, field);
  if (!text.ok) {
    return text;
  }
  if (/\s/.test(text.value)) {
    return invalid(field, `${field} must not contain whitespace`);
  }
  return ok(text.value as Brand<string, T>);
}

export function makeRequestId(value: unknown): Result<Brand<string, "RequestId">, PrimitiveValidationError> {
  return makeDomainId(value, "requestId");
}

export function makeDestinationId(value: unknown): Result<Brand<string, "DestinationId">, PrimitiveValidationError> {
  return makeDomainId(value, "destinationId");
}

export function makeMoveId(value: unknown): Result<Brand<string, "MoveId">, PrimitiveValidationError> {
  return makeDomainId(value, "moveId");
}

export function makeHunsuId(value: unknown): Result<Brand<string, "HunsuId">, PrimitiveValidationError> {
  return makeDomainId(value, "hunsuId");
}

export function makeHunsuDraftId(value: unknown): Result<Brand<string, "HunsuDraftId">, PrimitiveValidationError> {
  return makeDomainId(value, "hunsuDraftId");
}

export function makeLineId(value: unknown): Result<Brand<string, "LineId">, PrimitiveValidationError> {
  return makeDomainId(value, "lineId");
}

export function makeNodeId(value: unknown): Result<Brand<string, "NodeId">, PrimitiveValidationError> {
  return makeDomainId(value, "nodeId");
}

export function makeArtifactId(value: unknown): Result<Brand<string, "ArtifactId">, PrimitiveValidationError> {
  return makeDomainId(value, "artifactId");
}

export function makeArtifactActionId(value: unknown): Result<Brand<string, "ArtifactActionId">, PrimitiveValidationError> {
  return makeDomainId(value, "artifactActionId");
}

export function makeTeamId(value: unknown): Result<Brand<string, "TeamId">, PrimitiveValidationError> {
  return makeDomainId(value, "teamId");
}

export function makeSkillDraftId(value: unknown): Result<Brand<string, "SkillDraftId">, PrimitiveValidationError> {
  return makeDomainId(value, "skillDraftId");
}

export function makeAgentConversationHash(value: unknown): Result<Brand<string, "AgentConversationHash">, PrimitiveValidationError> {
  return makeDomainId(value, "agentConversationHash");
}

export function makeExecuteId(value: unknown): Result<Brand<string, "ExecuteId">, PrimitiveValidationError> {
  return makeDomainId(value, "executeId");
}

export function makeRouteId(value: unknown): Result<Brand<string, "RouteId">, PrimitiveValidationError> {
  return makeDomainId(value, "routeId");
}

export function makeWorktreeHash(value: unknown): Result<Brand<string, "WorktreeHash">, PrimitiveValidationError> {
  return makeDomainId(value, "worktreeHash");
}

function invalid(field: string, message: string): Result<never, PrimitiveValidationError> {
  return err({ type: "PrimitiveValidationError", field, message });
}

function makeTextBrand<T extends string>(value: unknown, field: string): Result<Brand<string, T>, PrimitiveValidationError> {
  const text = makeNonEmptyText(value, field);
  return text.ok ? ok(text.value as Brand<string, T>) : text;
}

function makeStringBrand<T extends string>(value: unknown, field: string): Result<Brand<string, T>, PrimitiveValidationError> {
  if (typeof value !== "string") {
    return invalid(field, `${field} must be a string`);
  }
  return ok(value as Brand<string, T>);
}
