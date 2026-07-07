import { err, ok, type Result } from "@hunsu/protocol";
import { getTrailer, parseTrailers } from "./trailer.ts";
import { InvalidTrailerError } from "./errors.ts";
import type { Board, BoardEvent, CommitRecord, HunsuEvent, HunsuEventType, MoveEvent, MoveEventStatus, RunTimeline } from "./model.ts";
import {
  makeCommitSha,
  makeGitGoal,
  makeGitHunsuId,
  makeGitMoveId,
  makeGitMoveNumber,
  makeGitPriority,
  makeGitRunId,
  makeGitTrailerActor,
  makeGitTrailerRole
} from "./primitives.ts";

const HUNSU_EVENT_TYPES = ["move", "hunsu"] as const satisfies readonly HunsuEventType[];
const MOVE_EVENT_STATUSES = ["complete", "failed", "blocked"] as const satisfies readonly MoveEventStatus[];

export type TrailerParseErrorCode =
  | "invalid_trailer_block"
  | "missing_trailer"
  | "invalid_hunsu_event_type"
  | "invalid_move_number"
  | "invalid_move_status"
  | "invalid_trailer_value";

export type TrailerParseError = {
  type: "TrailerParseError";
  code: TrailerParseErrorCode;
  commitSha: string;
  trailer?: string;
  value?: string;
  message: string;
};

export function commitToBoardEvent(commit: CommitRecord): Result<BoardEvent | null, TrailerParseError> {
  const trailers = parseCommitTrailers(commit);
  if (!trailers.ok) return trailers;
  const eventType = tryParseHunsuEventType(getTrailer(trailers.value, "Hunsu-Event"), commit.sha);
  if (!eventType.ok) return eventType;

  if (eventType.value === "move") {
    const runId = parseRequiredTrailer(trailers.value, "Hunsu-Run", commit.sha, makeGitRunId);
    if (!runId.ok) return runId;
    const moveNumber = parseRequiredTrailer(trailers.value, "Hunsu-Move", commit.sha, makeGitMoveNumber, "invalid_move_number");
    if (!moveNumber.ok) return moveNumber;
    const moveId = parseRequiredTrailer(trailers.value, "Hunsu-Move", commit.sha, makeGitMoveId, "invalid_move_number");
    if (!moveId.ok) return moveId;
    const role = parseRequiredTrailer(trailers.value, "Hunsu-Role", commit.sha, makeGitTrailerRole);
    if (!role.ok) return role;
    const actor = parseRequiredTrailer(trailers.value, "Hunsu-Actor", commit.sha, makeGitTrailerActor);
    if (!actor.ok) return actor;
    const statusValue = requireTrailerResult(trailers.value, "Hunsu-Status", commit.sha);
    if (!statusValue.ok) return statusValue;
    const status = makeMoveEventStatus(statusValue.value, commit.sha);
    if (!status.ok) return status;
    const goal = parseRequiredTrailer(trailers.value, "Hunsu-Goal", commit.sha, makeGitGoal);
    if (!goal.ok) return goal;
    return ok({
      type: "move",
      commit,
      runId: runId.value,
      moveNumber: moveNumber.value,
      moveId: moveId.value,
      goal: goal.value,
      role: role.value,
      actor: actor.value,
      status: status.value,
      trailers: trailers.value
    });
  }

  if (eventType.value === "hunsu") {
    const hunsuId = parseRequiredTrailer(trailers.value, "Hunsu-ID", commit.sha, makeGitHunsuId);
    if (!hunsuId.ok) return hunsuId;
    const target = parseRequiredTrailer(trailers.value, "Hunsu-Target", commit.sha, makeCommitSha);
    if (!target.ok) return target;
    const sourceRun = parseRequiredTrailer(trailers.value, "Hunsu-Source-Run", commit.sha, makeGitRunId);
    if (!sourceRun.ok) return sourceRun;
    const newRun = parseRequiredTrailer(trailers.value, "Hunsu-New-Run", commit.sha, makeGitRunId);
    if (!newRun.ok) return newRun;
    const role = parseRequiredTrailer(trailers.value, "Hunsu-Role", commit.sha, makeGitTrailerRole);
    if (!role.ok) return role;
    const actor = parseRequiredTrailer(trailers.value, "Hunsu-Actor", commit.sha, makeGitTrailerActor);
    if (!actor.ok) return actor;
    const priority = parseOptionalTrailer(trailers.value, "Hunsu-Priority", commit.sha, makeGitPriority);
    if (!priority.ok) return priority;
    return ok({
      type: "hunsu",
      commit,
      hunsuId: hunsuId.value,
      target: target.value,
      sourceRun: sourceRun.value,
      newRun: newRun.value,
      role: role.value,
      actor: actor.value,
      priority: priority.value,
      trailers: trailers.value
    });
  }

  return ok(null);
}

export function createBoardFromCommits(commits: CommitRecord[]): Board {
  const events = commits
    .map(commitToBoardEvent)
    .map(unwrapTrailerParseResult)
    .filter((event): event is BoardEvent => event !== null)
    .sort(compareEvents);

  const runsById = new Map<string, RunTimeline>();
  const moves: MoveEvent[] = [];
  const hunsus: HunsuEvent[] = [];
  const positions = new Map<string, MoveEvent>();

  for (const event of events) {
    if (event.type === "move") {
      moves.push(event);
      const run = getOrCreateRun(runsById, event.runId);
      run.moves.push(event);
      run.events.push(event);
      positions.set(event.commit.sha, event);
      positions.set(event.commit.shortSha, event);
      positions.set(event.moveId, event);
      positions.set(`${event.runId}:${event.moveId}`, event);
    } else {
      hunsus.push(event);
      const sourceRun = getOrCreateRun(runsById, event.sourceRun);
      sourceRun.hunsus.push(event);
      sourceRun.events.push(event);
      const newRun = getOrCreateRun(runsById, event.newRun);
      newRun.hunsus.push(event);
      newRun.events.push(event);
    }
  }

  for (const run of runsById.values()) {
    run.moves.sort(compareEvents);
    run.hunsus.sort(compareEvents);
    run.events.sort(compareEvents);
  }

  return {
    runs: [...runsById.values()].sort((left, right) => left.runId.localeCompare(right.runId)),
    moves,
    hunsus,
    positions
  };
}

function getOrCreateRun(runsById: Map<string, RunTimeline>, runId: string): RunTimeline {
  const existing = runsById.get(runId);
  if (existing) {
    return existing;
  }
  const run = { runId, moves: [], hunsus: [], events: [] };
  runsById.set(runId, run);
  return run;
}

function compareEvents(left: BoardEvent, right: BoardEvent): number {
  const leftTime = Date.parse(left.commit.authoredAt);
  const rightTime = Date.parse(right.commit.authoredAt);
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
    return leftTime - rightTime;
  }
  if (left.type === "move" && right.type === "move") {
    const moveOrder = compareMoveNumbers(left.moveNumber, right.moveNumber);
    if (moveOrder !== 0) {
      return moveOrder;
    }
  }
  return left.commit.sha.localeCompare(right.commit.sha);
}

function compareMoveNumbers(left: string, right: string): number {
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber) && leftNumber !== rightNumber) {
    return leftNumber - rightNumber;
  }
  return left.localeCompare(right);
}

export function parseHunsuEventType(value: string | undefined, commitSha: string): HunsuEventType | undefined {
  return unwrapTrailerParseResult(tryParseHunsuEventType(value, commitSha));
}

export function parseMoveEventStatus(value: string, commitSha: string): MoveEventStatus {
  return unwrapTrailerParseResult(makeMoveEventStatus(value, commitSha));
}

function parseCommitTrailers(commit: CommitRecord): Result<ReturnType<typeof parseTrailers>, TrailerParseError> {
  try {
    return ok(parseTrailers(commit.body));
  } catch (error) {
    return trailerParseError("invalid_trailer_block", commit.sha, undefined, undefined, error instanceof Error ? error.message : String(error));
  }
}

function tryParseHunsuEventType(value: string | undefined, commitSha: string): Result<HunsuEventType | undefined, TrailerParseError> {
  if (value === undefined) {
    return ok(undefined);
  }
  if (HUNSU_EVENT_TYPES.includes(value as HunsuEventType)) {
    return ok(value as HunsuEventType);
  }
  return trailerParseError("invalid_hunsu_event_type", commitSha, "Hunsu-Event", value, `Commit ${commitSha} has unsupported Hunsu-Event ${value}`);
}

function makeMoveEventStatus(value: unknown, commitSha: string): Result<MoveEventStatus, TrailerParseError> {
  if (typeof value === "string" && MOVE_EVENT_STATUSES.includes(value as MoveEventStatus)) {
    return ok(value as MoveEventStatus);
  }
  return trailerParseError("invalid_move_status", commitSha, "Hunsu-Status", String(value), `Commit ${commitSha} has unsupported Hunsu-Status ${String(value)}`);
}

function requireTrailerResult(trailers: ReturnType<typeof parseTrailers>, key: string, commitSha: string): Result<string, TrailerParseError> {
  const value = getTrailer(trailers, key);
  return value ? ok(value) : trailerParseError("missing_trailer", commitSha, key, undefined, `Commit ${commitSha} is missing required trailer ${key}`);
}

function parseRequiredTrailer<T>(
  trailers: ReturnType<typeof parseTrailers>,
  key: string,
  commitSha: string,
  parser: (value: unknown, field?: string) => Result<T, { message: string }>,
  code: TrailerParseErrorCode = "invalid_trailer_value"
): Result<T, TrailerParseError> {
  const value = requireTrailerResult(trailers, key, commitSha);
  if (!value.ok) return value;
  const parsed = parser(value.value, key);
  return parsed.ok
    ? ok(parsed.value)
    : trailerParseError(code, commitSha, key, value.value, `Commit ${commitSha} has invalid ${key}: ${parsed.error.message}`);
}

function parseOptionalTrailer<T>(
  trailers: ReturnType<typeof parseTrailers>,
  key: string,
  commitSha: string,
  parser: (value: unknown, field?: string) => Result<T, { message: string }>,
  code: TrailerParseErrorCode = "invalid_trailer_value"
): Result<T | undefined, TrailerParseError> {
  const value = getTrailer(trailers, key);
  if (value === undefined) {
    return ok(undefined);
  }
  const parsed = parser(value, key);
  return parsed.ok
    ? ok(parsed.value)
    : trailerParseError(code, commitSha, key, value, `Commit ${commitSha} has invalid ${key}: ${parsed.error.message}`);
}

function trailerParseError(
  code: TrailerParseErrorCode,
  commitSha: string,
  trailer: string | undefined,
  value: string | undefined,
  message: string
): Result<never, TrailerParseError> {
  return err({ type: "TrailerParseError", code, commitSha, trailer, value, message });
}

function unwrapTrailerParseResult<T>(result: Result<T, TrailerParseError>): T {
  if (result.ok) {
    return result.value;
  }
  throw new InvalidTrailerError(result.error.message);
}
