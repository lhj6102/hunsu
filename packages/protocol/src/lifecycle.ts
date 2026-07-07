import type {
  AccidentMoveRecord,
  AbandonedLine,
  ActiveLine,
  ArrivedMoveRecord,
  BlockedDestination,
  CanceledDestination,
  ClaimedDestination,
  CompleteLine,
  ConfirmedHunsuDraft,
  Destination,
  DestinationBase,
  DestinationId,
  DestinationPatch,
  DestinationSeed,
  DestinationSource,
  DiscardedHunsuDraft,
  DomainRole,
  DraftHunsuDraft,
  DraftSkillDraft,
  FailedLine,
  HunsuDraftBase,
  HunsuDraftRecord,
  HunsuId,
  InProgressDestination,
  LineId,
  LineRecord,
  MoveId,
  MoveRecord,
  MoveRecordBase,
  PausedLine,
  PlayableLine,
  PendingDestination,
  ReadyHunsuDraft,
  ReachedDestination,
  RequestId,
  SkillBinding,
  SkillDraftBase,
  SkillDraftRecord,
  SupersededDestination
} from "./model.ts";
import { makeFailureReason, makeNonEmptyArray, makeSingleItemArray } from "./primitives.ts";
import { err, ok, type Result } from "./result.ts";

export type DomainModelError = {
  type: "DomainModelError";
  message: string;
};

export type DestinationTransitionMeta = {
  updatedBy: DomainRole;
  updatedAt?: string;
};

export type ClaimDestinationInput = DestinationTransitionMeta & {
  claimedBy: string;
};

export type StartDestinationWorkInput = DestinationTransitionMeta & {
  claimedBy: string;
};

export type BlockDestinationInput = DestinationTransitionMeta & {
  blockedReason: string;
};

export type ReachDestinationInput = DestinationTransitionMeta & {
  reachedByMoveId: MoveId;
};

export type CancelDestinationInput = DestinationTransitionMeta & {
  canceledReason: string;
};

export type SupersedeDestinationInput = DestinationTransitionMeta & {
  supersededByDestinationId: DestinationId;
};

export type UpdateDestinationDetailsInput = DestinationTransitionMeta & DestinationPatch;

export function createPendingDestination(
  requestId: RequestId,
  seed: DestinationSeed,
  source: DestinationSource,
  at?: string
): PendingDestination {
  const actor: DomainRole = source === "initial-execute-team" || source === "initial-request" ? "SYSTEM" : "DIRECTOR";
  return {
    ...seed,
    requestId,
    status: "pending",
    source,
    createdBy: actor,
    updatedBy: actor,
    createdAt: at,
    updatedAt: at
  };
}

export function makePendingDestination(input: Omit<PendingDestination, "status">): Result<PendingDestination, DomainModelError> {
  return ok({ ...input, status: "pending" });
}

export function claimDestination(destination: Destination, input: ClaimDestinationInput): Result<ClaimedDestination, DomainModelError> {
  if (!hasText(input.claimedBy)) {
    return invalid("Claim Destination requires claimedBy");
  }
  if (destination.status !== "pending" && destination.status !== "blocked") {
    return invalid(`Destination ${destination.id} cannot be claimed from status ${destination.status}`);
  }
  return ok({
    ...baseDestinationForTransition(destination, input),
    status: "claimed",
    claimedBy: input.claimedBy
  });
}

export function startDestinationWork(destination: Destination, input: StartDestinationWorkInput): Result<InProgressDestination, DomainModelError> {
  if (!hasText(input.claimedBy)) {
    return invalid("Start Destination work requires claimedBy");
  }
  if (destination.status === "blocked") {
    return invalid(`Destination ${destination.id} cannot start work from status blocked`);
  }
  if (isClosedDestination(destination)) {
    return invalid(`Destination ${destination.id} cannot start work from status ${destination.status}`);
  }
  return ok({
    ...baseDestinationForTransition(destination, input),
    status: "in_progress",
    claimedBy: input.claimedBy
  });
}

export function blockDestination(destination: Destination, input: BlockDestinationInput): Result<BlockedDestination, DomainModelError> {
  if (!hasText(input.blockedReason)) {
    return invalid("Block Destination requires blockedReason");
  }
  if (isClosedDestination(destination)) {
    return invalid(`Destination ${destination.id} cannot be blocked from status ${destination.status}`);
  }
  return ok({
    ...baseDestinationForTransition(destination, input),
    status: "blocked",
    claimedBy: "claimedBy" in destination ? destination.claimedBy : undefined,
    blockedReason: input.blockedReason
  });
}

export function unblockDestination(destination: Destination, input: DestinationTransitionMeta): Result<PendingDestination, DomainModelError> {
  if (destination.status !== "blocked") {
    return invalid(`Destination ${destination.id} cannot be unblocked from status ${destination.status}`);
  }
  return ok({
    ...baseDestinationForTransition(destination, input),
    status: "pending"
  });
}

export function reachDestination(destination: Destination, input: ReachDestinationInput): Result<ReachedDestination, DomainModelError> {
  if (!hasText(input.reachedByMoveId)) {
    return invalid("Reach Destination requires reachedByMoveId");
  }
  if (isClosedDestination(destination)) {
    return invalid(`Destination ${destination.id} cannot be reached from status ${destination.status}`);
  }
  return ok({
    ...baseDestinationForTransition(destination, input),
    status: "reached",
    claimedBy: "claimedBy" in destination ? destination.claimedBy : undefined,
    reachedByMoveId: input.reachedByMoveId
  });
}

export function cancelDestination(destination: Destination, input: CancelDestinationInput): Result<CanceledDestination, DomainModelError> {
  if (!hasText(input.canceledReason)) {
    return invalid("Cancel Destination requires canceledReason");
  }
  if (isClosedDestination(destination)) {
    return invalid(`Destination ${destination.id} cannot be canceled from status ${destination.status}`);
  }
  return ok({
    ...baseDestinationForTransition(destination, input),
    status: "canceled",
    claimedBy: "claimedBy" in destination ? destination.claimedBy : undefined,
    canceledReason: input.canceledReason
  });
}

export function supersedeDestination(destination: Destination, input: SupersedeDestinationInput): Result<SupersededDestination, DomainModelError> {
  if (!hasText(input.supersededByDestinationId)) {
    return invalid("Supersede Destination requires supersededByDestinationId");
  }
  if (isClosedDestination(destination)) {
    return invalid(`Destination ${destination.id} cannot be superseded from status ${destination.status}`);
  }
  return ok({
    ...baseDestinationForTransition(destination, input),
    status: "superseded",
    claimedBy: "claimedBy" in destination ? destination.claimedBy : undefined,
    supersededByDestinationId: input.supersededByDestinationId
  });
}

export function updateDestinationDetails(destination: Destination, input: UpdateDestinationDetailsInput): Result<Destination, DomainModelError> {
  const { updatedBy, updatedAt, ...patch } = input;
  return ok({
    ...destination,
    ...patch,
    updatedBy,
    updatedAt
  } as Destination);
}

export function pauseLine(line: LineRecord): Result<PausedLine, DomainModelError> {
  return line.status === "active"
    ? ok({ ...line, status: "paused" })
    : invalid(`Line ${line.id} cannot be paused from status ${line.status}`);
}

export function resumeLine(line: LineRecord): Result<ActiveLine, DomainModelError> {
  return line.status === "paused"
    ? ok({ ...line, status: "active" })
    : invalid(`Line ${line.id} cannot be resumed from status ${line.status}`);
}

export function completeLine(line: LineRecord): Result<CompleteLine, DomainModelError> {
  return line.status === "active" || line.status === "paused"
    ? ok({ ...line, status: "complete" })
    : invalid(`Line ${line.id} cannot be completed from status ${line.status}`);
}

export function abandonLine(line: LineRecord): Result<AbandonedLine, DomainModelError> {
  return line.status === "active" || line.status === "paused"
    ? ok({ ...line, status: "abandoned" })
    : invalid(`Line ${line.id} cannot be abandoned from status ${line.status}`);
}

export function failLine(line: LineRecord): Result<FailedLine, DomainModelError> {
  return line.status === "active"
    ? ok({ ...line, status: "failed" })
    : invalid(`Line ${line.id} cannot fail from status ${line.status}`);
}

export function makePlayableLine(line: LineRecord): Result<PlayableLine, DomainModelError> {
  return line.status === "active"
    ? ok(line)
    : invalid(`TEAM line ${line.id} cannot continue from status ${line.status}`);
}

export function makeArrivedMoveRecord(input: MoveRecordBase & { reachedDestinationIds: DestinationId[] }): Result<ArrivedMoveRecord, DomainModelError> {
  const reached = makeSingleItemArray(input.reachedDestinationIds, "reachedDestinationIds");
  if (!reached.ok) {
    return invalid("Arrived MOVE must reach exactly one Destination");
  }
  const evidence = makeNonEmptyArray(input.evidence, "evidence");
  if (!evidence.ok) {
    return invalid("Arrived MOVE requires evidence");
  }
  return ok({
    ...input,
    outcome: "arrived",
    reachedDestinationIds: reached.value,
    evidence: evidence.value
  });
}

export function makeAccidentMoveRecord(input: MoveRecordBase & { failureReason: string }): Result<AccidentMoveRecord, DomainModelError> {
  const failureReason = makeFailureReason(input.failureReason, "failureReason");
  if (!failureReason.ok) {
    return invalid("Accident MOVE requires failureReason");
  }
  const evidence = makeNonEmptyArray(input.evidence, "evidence");
  if (!evidence.ok) {
    return invalid("Accident MOVE requires evidence");
  }
  return ok({
    ...input,
    outcome: "accident",
    reachedDestinationIds: [],
    failureReason: failureReason.value,
    evidence: evidence.value
  });
}

export type MoveRecordBasePatch = Partial<Pick<MoveRecordBase, "fromNodeId" | "toNodeId" | "teamName" | "ordinal" | "snapshot" | "commit">>;

export function patchMoveRecordBase(move: MoveRecord, patch: MoveRecordBasePatch): MoveRecord {
  if (move.outcome === "accident") {
    return {
      ...move,
      ...patch,
      outcome: "accident",
      reachedDestinationIds: [],
      failureReason: move.failureReason
    };
  }
  return {
    ...move,
    ...patch,
    outcome: "arrived",
    reachedDestinationIds: move.reachedDestinationIds
  };
}

export function normalizeMoveRecord(move: MoveRecord): Result<MoveRecord, DomainModelError> {
  if (move.outcome === "accident") {
    return makeAccidentMoveRecord(move);
  }
  return makeArrivedMoveRecord({
    ...move,
    reachedDestinationIds: move.reachedDestinationIds
  });
}

export function makeDraftSkillDraft(input: Omit<SkillDraftBase, "status">): DraftSkillDraft {
  return { ...input, status: "draft" };
}

export function makeDraftHunsuDraft(input: Omit<HunsuDraftBase, "status">): DraftHunsuDraft {
  return { ...input, status: "draft" };
}

export function makeReadyHunsuDraft(input: Omit<ReadyHunsuDraft, "status">): ReadyHunsuDraft {
  return { ...input, status: "ready" };
}

export function confirmHunsuDraftRecord(
  draft: HunsuDraftRecord,
  input: { hunsuId?: HunsuId; newLineId?: LineId; updatedAt?: string } = {}
): Result<ConfirmedHunsuDraft, DomainModelError> {
  if (draft.status !== "ready") {
    return invalid(`HUNSU Draft ${draft.id} cannot be confirmed from status ${draft.status}`);
  }
  return ok({
    ...draft,
    status: "confirmed",
    hunsuId: input.hunsuId ?? draft.hunsuId,
    newLineId: input.newLineId ?? draft.newLineId,
    updatedAt: input.updatedAt ?? draft.updatedAt
  });
}

export function discardHunsuDraftRecord(
  draft: HunsuDraftRecord,
  input: { updatedAt?: string } = {}
): Result<DiscardedHunsuDraft, DomainModelError> {
  if (draft.status !== "draft" && draft.status !== "ready") {
    return invalid(`HUNSU Draft ${draft.id} cannot be discarded from status ${draft.status}`);
  }
  const {
    hunsuId: _hunsuId,
    newLineId: _newLineId,
    ...base
  } = draft;
  return ok({
    ...base,
    status: "discarded",
    updatedAt: input.updatedAt ?? draft.updatedAt
  });
}

export function acceptSkillDraft(draft: SkillDraftRecord, acceptedSnapshot: SkillBinding): Result<SkillDraftRecord, DomainModelError> {
  if (draft.status !== "draft") {
    return invalid(`Skill Draft ${draft.id} cannot be accepted from status ${draft.status}`);
  }
  return ok({ ...draft, status: "accepted", acceptedSnapshot });
}

export function discardSkillDraft(draft: SkillDraftRecord): Result<SkillDraftRecord, DomainModelError> {
  if (draft.status !== "draft") {
    return invalid(`Skill Draft ${draft.id} cannot be discarded from status ${draft.status}`);
  }
  return ok({ ...draft, status: "discarded" });
}

function baseDestinationForTransition(destination: Destination, input: DestinationTransitionMeta): DestinationBase {
  const {
    claimedBy: _claimedBy,
    reachedByMoveId: _reachedByMoveId,
    blockedReason: _blockedReason,
    canceledReason: _canceledReason,
    supersededByDestinationId: _supersededByDestinationId,
    ...base
  } = destination;
  return {
    ...base,
    updatedBy: input.updatedBy,
    updatedAt: input.updatedAt
  };
}

function isClosedDestination(destination: Destination): boolean {
  return destination.status === "reached" || destination.status === "canceled" || destination.status === "superseded";
}

function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function invalid(message: string): Result<never, DomainModelError> {
  return err({ type: "DomainModelError", message });
}
