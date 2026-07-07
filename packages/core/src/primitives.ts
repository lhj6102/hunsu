import { err, ok, type Result } from "@hunsu/protocol";
import { HunsuError } from "./errors.ts";

export type CoreBrand<T, Name extends string> = T & { readonly __coreBrand: Name };

export type CommitSha = CoreBrand<string, "CommitSha">;
export type GitRef = CoreBrand<string, "GitRef">;
export type BranchName = CoreBrand<string, "BranchName">;
export type RuntimeChecksum = CoreBrand<string, "RuntimeChecksum">;
export type RuntimeSchemaName = CoreBrand<string, "RuntimeSchemaName">;
export type GitRunId = CoreBrand<string, "GitRunId">;
export type GitMoveNumber = CoreBrand<string, "GitMoveNumber">;
export type GitMoveId = CoreBrand<string, "GitMoveId">;
export type GitGoal = CoreBrand<string, "GitGoal">;
export type GitPriority = CoreBrand<string, "GitPriority">;
export type GitTrailerRole = CoreBrand<string, "GitTrailerRole">;
export type GitTrailerActor = CoreBrand<string, "GitTrailerActor">;
export type GitHunsuId = CoreBrand<string, "GitHunsuId">;

export type CorePrimitiveError = {
  type: "CorePrimitiveError";
  field: string;
  message: string;
};

export function makeCommitSha(value: unknown, field = "commitSha"): Result<CommitSha, CorePrimitiveError> {
  return typeof value === "string" && /^[0-9a-f]{40}$/i.test(value)
    ? ok(value as CommitSha)
    : corePrimitiveError(field, "must be a 40-character Git commit SHA");
}

export function makeGitRef(value: unknown, field = "gitRef"): Result<GitRef, CorePrimitiveError> {
  return makeGitToken(value, field, "must be a non-empty Git ref") as Result<GitRef, CorePrimitiveError>;
}

export function makeBranchName(value: unknown, field = "branchName"): Result<BranchName, CorePrimitiveError> {
  return makeGitToken(value, field, "must be a non-empty branch name") as Result<BranchName, CorePrimitiveError>;
}

export function makeRuntimeChecksum(value: unknown, field = "runtimeChecksum"): Result<RuntimeChecksum, CorePrimitiveError> {
  return typeof value === "string" && /^[0-9a-f]{64}$/i.test(value)
    ? ok(value as RuntimeChecksum)
    : corePrimitiveError(field, "must be a SHA-256 hex checksum");
}

export function makeRuntimeSchemaName(value: unknown, field = "runtimeSchemaName"): Result<RuntimeSchemaName, CorePrimitiveError> {
  return makeNonEmptyCoreString(value, field, "must be a non-empty runtime schema name") as Result<RuntimeSchemaName, CorePrimitiveError>;
}

export function makeGitRunId(value: unknown, field = "runId"): Result<GitRunId, CorePrimitiveError> {
  return makeNonEmptyCoreString(value, field, "must be a non-empty Hunsu run id") as Result<GitRunId, CorePrimitiveError>;
}

export function makeGitMoveNumber(value: unknown, field = "moveNumber"): Result<GitMoveNumber, CorePrimitiveError> {
  const raw = String(value).trim();
  const digits = /^M\d+$/i.test(raw) ? raw.slice(1) : raw;
  return /^\d+$/.test(digits)
    ? ok(digits.padStart(4, "0") as GitMoveNumber)
    : corePrimitiveError(field, "must be numeric");
}

export function makeGitMoveId(value: unknown, field = "moveId"): Result<GitMoveId, CorePrimitiveError> {
  const moveNumber = makeGitMoveNumber(value, field);
  return moveNumber.ok ? ok(`M${moveNumber.value}` as GitMoveId) : moveNumber;
}

export function makeGitGoal(value: unknown, field = "goal"): Result<GitGoal, CorePrimitiveError> {
  return makeGitToken(value, field, "must be a non-empty Hunsu goal") as Result<GitGoal, CorePrimitiveError>;
}

export function makeGitPriority(value: unknown, field = "priority"): Result<GitPriority, CorePrimitiveError> {
  return makeGitToken(value, field, "must be a non-empty Hunsu priority") as Result<GitPriority, CorePrimitiveError>;
}

export function makeGitTrailerRole(value: unknown, field = "role"): Result<GitTrailerRole, CorePrimitiveError> {
  return makeNonEmptyCoreString(value, field, "must be a non-empty Hunsu role") as Result<GitTrailerRole, CorePrimitiveError>;
}

export function makeGitTrailerActor(value: unknown, field = "actor"): Result<GitTrailerActor, CorePrimitiveError> {
  return makeNonEmptyCoreString(value, field, "must be a non-empty Hunsu actor") as Result<GitTrailerActor, CorePrimitiveError>;
}

export function makeGitHunsuId(value: unknown, field = "hunsuId"): Result<GitHunsuId, CorePrimitiveError> {
  return makeNonEmptyCoreString(value, field, "must be a non-empty HUNSU id") as Result<GitHunsuId, CorePrimitiveError>;
}

export function parseCommitSha(value: string, field = "commitSha"): CommitSha {
  return unwrapCorePrimitive(makeCommitSha(value, field));
}

export function parseGitRef(value: string, field = "gitRef"): GitRef {
  return unwrapCorePrimitive(makeGitRef(value, field));
}

export function parseBranchName(value: string, field = "branchName"): BranchName {
  return unwrapCorePrimitive(makeBranchName(value, field));
}

export function parseRuntimeChecksum(value: string, field = "runtimeChecksum"): RuntimeChecksum {
  return unwrapCorePrimitive(makeRuntimeChecksum(value, field));
}

export function parseRuntimeSchemaName(value: string, field = "runtimeSchemaName"): RuntimeSchemaName {
  return unwrapCorePrimitive(makeRuntimeSchemaName(value, field));
}

export function parseGitRunId(value: string, field = "runId"): GitRunId {
  return unwrapCorePrimitive(makeGitRunId(value, field));
}

export function parseGitMoveNumber(value: string | number, field = "moveNumber"): GitMoveNumber {
  return unwrapCorePrimitive(makeGitMoveNumber(value, field));
}

export function parseGitMoveId(value: string | number, field = "moveId"): GitMoveId {
  return unwrapCorePrimitive(makeGitMoveId(value, field));
}

export function parseGitGoal(value: string, field = "goal"): GitGoal {
  return unwrapCorePrimitive(makeGitGoal(value, field));
}

export function parseGitPriority(value: string, field = "priority"): GitPriority {
  return unwrapCorePrimitive(makeGitPriority(value, field));
}

export function parseGitTrailerRole(value: string, field = "role"): GitTrailerRole {
  return unwrapCorePrimitive(makeGitTrailerRole(value, field));
}

export function parseGitTrailerActor(value: string, field = "actor"): GitTrailerActor {
  return unwrapCorePrimitive(makeGitTrailerActor(value, field));
}

export function parseGitHunsuId(value: string, field = "hunsuId"): GitHunsuId {
  return unwrapCorePrimitive(makeGitHunsuId(value, field));
}

function unwrapCorePrimitive<T>(result: Result<T, CorePrimitiveError>): T {
  if (result.ok) {
    return result.value;
  }
  throw new HunsuError(`${result.error.field} ${result.error.message}`);
}

function makeGitToken<T extends string>(value: unknown, field: string, message: string): Result<CoreBrand<T, string>, CorePrimitiveError> {
  return typeof value === "string" && value.trim().length > 0 && !/[\0\r\n]/.test(value)
    ? ok(value as CoreBrand<T, string>)
    : corePrimitiveError(field, message);
}

function makeNonEmptyCoreString<T extends string>(value: unknown, field: string, message: string): Result<CoreBrand<T, string>, CorePrimitiveError> {
  return typeof value === "string" && value.trim().length > 0
    ? ok(value as CoreBrand<T, string>)
    : corePrimitiveError(field, message);
}

function corePrimitiveError(field: string, message: string): Result<never, CorePrimitiveError> {
  return err({ type: "CorePrimitiveError", field, message });
}
