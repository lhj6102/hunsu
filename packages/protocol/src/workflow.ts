import type {
  ArtifactRecord,
  BoardProjection,
  Command,
  DomainEvent,
  HunsuId,
  HunsuRecord,
  LineId,
  LineRecord,
  MoveId,
  MoveRecord,
  NodeId,
  NodeRecord,
  RequestId,
  Destination,
  DestinationId,
  DraftSkillDraft,
  SkillDraftRecord,
  ValidatedCommand
} from "./model.ts";
import {
  abandonLine,
  blockDestination,
  claimDestination,
  completeLine,
  makeAccidentMoveRecord,
  makeArrivedMoveRecord,
  makeDraftSkillDraft,
  makePlayableLine,
  pauseLine,
  reachDestination,
  resumeLine,
  startDestinationWork,
  type DomainModelError
} from "./lifecycle.ts";
import {
  DomainInvariantError,
  toDomainWorkflowError,
  unwrapDomainModelResult,
  workflowError,
  type DomainWorkflowError
} from "./errors.ts";
import { decodeCommand } from "./command-decoder.ts";
import { decodeDomainEvent } from "./event-decoder.ts";
import {
  cloneHarness,
  createDefaultHarness,
  validateHarness
} from "./protocol-validation.ts";
import {
  emptyBoardProjection,
  projectBoard,
  tryProjectBoard,
  validateEventStream
} from "./projection.ts";
import {
  assertNonEmpty,
  assertSingleDestination,
  assertText,
  isClosedDestination,
  nextTeamName,
  nextNodeId,
  requireBlockableDestination,
  requireClaimableDestination,
  requireCurrentNode,
  requireExistingDestination,
  requireLine,
  requireMove,
  requireNode,
  requirePlayableLine,
  requireReachibleDestinationInNode,
  requireRequest,
  requireRootNode,
  requireSkillDraft,
  rootNodeId
} from "./workflow-helpers.ts";
import { err, ok, type Result } from "./result.ts";

export { DomainInvariantError, type DomainWorkflowError } from "./errors.ts";
export {
  cloneHarness,
  createDefaultHarness,
  createDefaultMemberConfig,
  getHarnessMemberConfig,
  isExecutableHarness,
  validateHarness,
  validateExecutableHarness
} from "./protocol-validation.ts";
export {
  emptyBoardProjection,
  projectBoard,
  projectEvent,
  tryProjectBoard,
  validateEventStream
} from "./projection.ts";

export function tryHandleCommand(command: Command, state: BoardProjection = emptyBoardProjection()): Result<DomainEvent[], DomainWorkflowError> {
  const validation = validateCommand(command);
  if (!validation.ok) {
    return validation;
  }
  const stateValidation = validateCommandState(validation.value, state);
  if (!stateValidation.ok) {
    return stateValidation;
  }
  try {
    return ok(handleValidatedCommand(stateValidation.value, state));
  } catch (error) {
    return err(toDomainWorkflowError(error));
  }
}

function handleValidatedCommand(command: ValidatedCommand, state: BoardProjection = emptyBoardProjection()): DomainEvent[] {
  switch (command.type) {
    case "RegisterHunsuOrigin":
      return [{ type: "HunsuOriginRegistered", origin: { ...command.origin }, at: command.at }];
    case "CreateInitialTeam": {
      assertNonEmpty(command.destinations, "CreateInitialTeam requires at least one Destination");
      const harness = command.harness ? cloneHarness(command.harness) : createDefaultHarness();
      const rootNode = rootNodeId(command.requestId);
      return [
        {
          type: "InitialTeamCreated",
          request: {
            id: command.requestId,
            title: command.title,
            goal: command.goal,
            createdBy: "SYSTEM",
            createdAt: command.at
          },
          line: {
            id: command.lineId,
            requestId: command.requestId,
            teamName: command.teamName ?? nextTeamName(state),
            status: "active",
            moveIds: [],
            rootNodeId: rootNode,
            currentNodeId: rootNode,
            nodeIds: [rootNode]
          },
          destinations: command.destinations,
          harness,
          harnessLock: command.harnessLock,
          at: command.at
        }
      ];
    }
    case "StartLine": {
      requireRequest(state, command.requestId);
      const rootNode = requireRootNode(state, command.requestId);
      const teamName = command.teamName ?? nextTeamName(state);
      return [
        {
          type: "LineStarted",
          line: {
            id: command.lineId,
            requestId: command.requestId,
            teamName,
            status: "active",
            moveIds: [],
            rootNodeId: rootNode.id,
            currentNodeId: rootNode.id,
            nodeIds: [rootNode.id]
          }
        }
      ];
    }
    case "PauseLine":
      requireLine(state, command.lineId);
      return [{ type: "LinePaused", lineId: command.lineId, at: command.at }];
    case "ResumeLine":
      requireLine(state, command.lineId);
      return [{ type: "LineResumed", lineId: command.lineId, at: command.at }];
    case "AcceptLine":
      requireLine(state, command.lineId);
      return [{ type: "LineAccepted", lineId: command.lineId, reason: command.reason, at: command.at }];
    case "RejectLine":
      requireLine(state, command.lineId);
      return [{ type: "LineRejected", lineId: command.lineId, reason: command.reason, at: command.at }];
    case "ClaimDestination":
      requireClaimableDestination(state, command.destinationId);
      return [{ type: "DestinationClaimed", destinationId: command.destinationId, actor: command.actor, at: command.at }];
    case "StartDestinationWork":
      requireExistingDestination(state, command.destinationId);
      return [{ type: "DestinationWorkStarted", destinationId: command.destinationId, actor: command.actor, at: command.at }];
    case "ReportDestinationBlocked":
      requireBlockableDestination(state, command.destinationId);
      return [{ type: "DestinationBlocked", destinationId: command.destinationId, reason: command.reason, actor: command.actor, at: command.at }];
    case "RecordMove": {
      const line = requireLine(state, command.lineId);
      requirePlayableLine(line);
      const fromNode = requireCurrentNode(state, line);
      assertSingleDestination(command.reachedDestinationIds, "MOVE must reach exactly one Destination");
      for (const destinationId of command.reachedDestinationIds) {
        requireReachibleDestinationInNode(fromNode, destinationId);
      }
      const toNodeId = nextNodeId(state);
      const move = unwrapDomainModelResult(makeArrivedMoveRecord({
        id: command.moveId,
        lineId: command.lineId,
        fromNodeId: fromNode.id,
        toNodeId,
        executeId: command.executeId,
        conversationRef: command.conversationRef,
        worktree: command.worktree,
        summary: command.summary,
        commit: command.commit,
        reachedDestinationIds: command.reachedDestinationIds,
        evidence: command.evidence,
        risks: command.risks,
        recordedBy: "SYSTEM",
        recordedAt: command.at
      }));
      return [
        {
          type: "MoveRecorded",
          move
        }
      ];
    }
    case "RecordAccident": {
      const line = requireLine(state, command.lineId);
      requirePlayableLine(line);
      const fromNode = requireCurrentNode(state, line);
      assertNonEmpty(command.evidence, "A ACCIDENT must include evidence");
      assertText(command.failureReason, "A ACCIDENT must include a failure reason");
      const toNodeId = nextNodeId(state);
      const move = unwrapDomainModelResult(makeAccidentMoveRecord({
        id: command.moveId,
        lineId: command.lineId,
        fromNodeId: fromNode.id,
        toNodeId,
        executeId: command.executeId,
        conversationRef: command.conversationRef,
        worktree: command.worktree,
        failureReason: command.failureReason,
        summary: command.summary,
        commit: command.commit,
        evidence: command.evidence,
        risks: command.risks,
        recordedBy: "SYSTEM",
        recordedAt: command.at
      }));
      return [
        {
          type: "MoveRecorded",
          move
        }
      ];
    }
    case "AttachMoveEvidence":
      requireMove(state, command.moveId);
      return [{ type: "ArtifactRecorded", artifact: command.artifact, at: command.at }];
    case "ConfirmHunsuDraft": {
      const draft = command.draft;
      const line = requireLine(state, draft.sourceLineId);
      const fromNode = requireNode(state, draft.sourceNodeId);
      if (fromNode.requestId !== line.requestId) {
        throw new DomainInvariantError(`Node ${fromNode.id} does not belong to line ${line.id}`);
      }
      if (draft.sourceMoveId) {
        requireMove(state, draft.sourceMoveId);
      }
      assertNonEmpty(draft.changedFiles, "A confirmed HUNSU Draft must include at least one changed runtime file");
      return [
        hunsuRecorded(
          draft.hunsuId,
          draft.sourceLineId,
          fromNode.id,
          nextNodeId(state),
          draft.target,
          draft.summary,
          draft.teamSnapshot,
          draft.changedFiles,
          command.at,
          {
            hunsuDraftId: draft.id,
            conversationRef: draft.conversationRef,
            newLineId: draft.newLineId,
            sourceMoveId: draft.sourceMoveId,
            newTeamName: draft.newTeamName
          }
        ),
        {
          type: "LineForkedByHunsu",
          hunsuId: draft.hunsuId,
          fromLineId: draft.sourceLineId,
          newLineId: draft.newLineId,
          newTeamName: draft.newTeamName,
          fromMoveId: draft.sourceMoveId,
          requestId: fromNode.requestId,
          at: command.at
        }
      ];
    }
    case "CreateSkillDraft": {
      const line = requireLine(state, command.lineId);
      const fromNode = requireCurrentNode(state, line);
      return [{
        type: "SkillDraftCreated",
        draft: makeDraftSkillDraft({
          id: command.draftId,
          name: command.name,
          sourcePath: command.sourcePath,
          draftPath: command.draftPath,
          createdFromNodeId: fromNode.id,
          createdAt: command.at
        })
      }];
    }
    case "DiscardSkillDraft": {
      const draft = requireSkillDraft(state, command.draftId);
      if (draft.status !== "draft") {
        throw new DomainInvariantError(`Skill Draft ${command.draftId} cannot be discarded from status ${draft.status}`);
      }
      return [{ type: "SkillDraftDiscarded", draftId: command.draftId, at: command.at }];
    }
    case "RecordArtifact":
      return [{ type: "ArtifactRecorded", artifact: command.artifact, at: command.at }];
  }
}

export function tryApplyCommand(events: DomainEvent[], command: Command): Result<DomainEvent[], DomainWorkflowError> {
  const projected = tryProjectBoard(events);
  if (!projected.ok) {
    return projected;
  }
  const state = projected.value;
  const accepted = tryHandleCommand(command, state);
  return accepted.ok ? ok([...events, ...accepted.value]) : accepted;
}

export function validateCommand(input: unknown): Result<ValidatedCommand, DomainWorkflowError> {
  return decodeCommand(input, validateHarness);
}

export function validateDomainEvent(value: unknown): Result<DomainEvent, DomainWorkflowError> {
  return decodeDomainEvent(value, validateHarness);
}

function validateCommandState(command: ValidatedCommand, state: BoardProjection): Result<ValidatedCommand, DomainWorkflowError> {
  const aggregateIds = validateCommandAggregateIdsAvailable(command, state);
  if (!aggregateIds.ok) {
    return aggregateIds;
  }
  switch (command.type) {
    case "RegisterHunsuOrigin":
    case "CreateInitialTeam":
      return ok(command);
    case "RecordArtifact":
      return firstStateValidationError([validateArtifactOwnerExists(state, command.artifact)], command);
    case "StartLine":
      return firstStateValidationError([
        validateRequestExists(state, command.requestId),
        validateRootNodeExists(state, command.requestId)
      ], command);
    case "PauseLine":
      return firstStateValidationError([validatePausableLine(state, command.lineId)], command);
    case "ResumeLine":
      return firstStateValidationError([validateResumableLine(state, command.lineId)], command);
    case "AcceptLine":
      return firstStateValidationError([validateCompletableLine(state, command.lineId)], command);
    case "RejectLine":
      return firstStateValidationError([validateAbandonableLine(state, command.lineId)], command);
    case "ClaimDestination":
      return firstStateValidationError([validateClaimableDestination(state, command.destinationId)], command);
    case "StartDestinationWork":
      return firstStateValidationError([validateStartableDestination(state, command.destinationId)], command);
    case "ReportDestinationBlocked":
      return firstStateValidationError([validateBlockableDestination(state, command.destinationId)], command);
    case "RecordMove":
      return firstStateValidationError([
        validatePlayableLineForCommand(state, command.lineId),
        validateCurrentNodeForLine(state, command.lineId),
        ...validateReachableDestinationsForCurrentNode(state, command.lineId, command.moveId, command.reachedDestinationIds)
      ], command);
    case "RecordAccident":
      return firstStateValidationError([
        validatePlayableLineForCommand(state, command.lineId),
        validateCurrentNodeForLine(state, command.lineId)
      ], command);
    case "AttachMoveEvidence":
      return firstStateValidationError([
        validateMoveExists(state, command.moveId),
        validateArtifactAttachedToMove(command.artifact, command.moveId)
      ], command);
    case "ConfirmHunsuDraft":
      return firstStateValidationError([
        validateNodeBelongsToExactLine(state, command.draft.sourceNodeId, command.draft.sourceLineId),
        validateHunsuTargetBelongsToLine(state, command.draft.sourceLineId, command.draft.target),
        ...(command.draft.sourceMoveId ? [validateMoveBelongsToLine(state, command.draft.sourceMoveId, command.draft.sourceLineId)] : [])
      ], command);
    case "CreateSkillDraft":
      return firstStateValidationError([validateCurrentNodeForLine(state, command.lineId)], command);
    case "DiscardSkillDraft":
      return firstStateValidationError([validateDraftSkillDraft(state, command.draftId, "discarded")], command);
  }
}

function validateCommandAggregateIdsAvailable(command: ValidatedCommand, state: BoardProjection): Result<void, DomainWorkflowError> {
  switch (command.type) {
    case "CreateInitialTeam": {
      const request = validateRequestIdAvailable(state, command.requestId);
      if (!request.ok) return request;
      const line = validateLineIdAvailable(state, command.lineId);
      if (!line.ok) return line;
      return validateDestinationIdsAvailable(state, command.destinations.map(destination => destination.id));
    }
    case "StartLine":
      return validateLineIdAvailable(state, command.lineId);
    case "RecordMove":
    case "RecordAccident":
      return validateMoveIdAvailable(state, command.moveId);
    case "AttachMoveEvidence":
    case "RecordArtifact":
      return validateArtifactIdAvailable(state, command.artifact.id);
    case "CreateSkillDraft":
      return validateSkillDraftIdAvailable(state, command.draftId);
    case "ConfirmHunsuDraft": {
      const hunsu = validateHunsuIdAvailable(state, command.draft.hunsuId);
      if (!hunsu.ok) return hunsu;
      return validateLineIdAvailable(state, command.draft.newLineId);
    }
    case "RegisterHunsuOrigin":
    case "PauseLine":
    case "ResumeLine":
    case "AcceptLine":
    case "RejectLine":
    case "ClaimDestination":
    case "StartDestinationWork":
    case "ReportDestinationBlocked":
    case "DiscardSkillDraft":
      return ok(undefined);
  }
}

function firstStateValidationError<T extends ValidatedCommand["type"]>(
  validations: Result<unknown, DomainWorkflowError>[],
  command: Extract<ValidatedCommand, { type: T }>
): Result<Extract<ValidatedCommand, { type: T }>, DomainWorkflowError> {
  const failed = validations.find(validation => !validation.ok);
  if (failed && !failed.ok) {
    return err(failed.error);
  }
  return ok(command);
}

function hunsuRecorded(
  id: HunsuId,
  lineId: LineId,
  fromNodeId: NodeId,
  toNodeId: NodeId,
  target: HunsuRecord["target"],
  summary: HunsuRecord["summary"],
  teamSnapshot: HunsuRecord["teamSnapshot"],
  changedFiles: HunsuRecord["changedFiles"],
  at?: string,
  metadata: Pick<HunsuRecord, "hunsuDraftId" | "conversationRef" | "newLineId" | "sourceMoveId" | "newTeamName"> = {}
): DomainEvent {
  assertNonEmpty(changedFiles, "A HUNSU must include at least one changed runtime file");
  return {
    type: "HunsuRecorded",
    hunsu: { id, ...metadata, lineId, fromNodeId, toNodeId, target, summary, teamSnapshot, changedFiles, recordedBy: "DIRECTOR", recordedAt: at }
  };
}

function requireModelTransition<T, U>(value: T, transition: Result<U, DomainModelError>): Result<T, DomainWorkflowError> {
  return transition.ok ? ok(value) : workflowError(transition.error.message);
}

function validateRequestIdAvailable(state: BoardProjection, requestId: RequestId): Result<void, DomainWorkflowError> {
  return state.requests.some(request => request.id === requestId)
    ? workflowError(`Duplicate RequestId: ${requestId}`)
    : ok(undefined);
}

function validateLineIdAvailable(state: BoardProjection, lineId: LineId): Result<void, DomainWorkflowError> {
  return state.lines.some(line => line.id === lineId)
    ? workflowError(`Duplicate LineId: ${lineId}`)
    : ok(undefined);
}

function validateMoveIdAvailable(state: BoardProjection, moveId: MoveId): Result<void, DomainWorkflowError> {
  return state.moves.some(move => move.id === moveId)
    ? workflowError(`Duplicate MoveId: ${moveId}`)
    : ok(undefined);
}

function validateHunsuIdAvailable(state: BoardProjection, hunsuId: HunsuId): Result<void, DomainWorkflowError> {
  return state.hunsus.some(hunsu => hunsu.id === hunsuId)
    ? workflowError(`Duplicate HunsuId: ${hunsuId}`)
    : ok(undefined);
}

function validateSkillDraftIdAvailable(state: BoardProjection, draftId: string): Result<void, DomainWorkflowError> {
  return state.skillDrafts.some(draft => draft.id === draftId)
    ? workflowError(`Duplicate SkillDraftId: ${draftId}`)
    : ok(undefined);
}

function validateArtifactIdAvailable(state: BoardProjection, artifactId: string): Result<void, DomainWorkflowError> {
  return state.artifacts.some(artifact => artifact.id === artifactId)
    ? workflowError(`Duplicate ArtifactId: ${artifactId}`)
    : ok(undefined);
}

function validateDestinationIdsAvailable(state: BoardProjection, destinationIds: DestinationId[]): Result<void, DomainWorkflowError> {
  const seen = new Set<string>();
  const existing = destinationIdsInBoard(state);
  for (const destinationId of destinationIds) {
    if (seen.has(destinationId)) {
      return workflowError(`Duplicate DestinationId in command: ${destinationId}`);
    }
    if (existing.has(destinationId)) {
      return workflowError(`Duplicate DestinationId: ${destinationId}`);
    }
    seen.add(destinationId);
  }
  return ok(undefined);
}

function destinationIdsInBoard(state: BoardProjection): Set<string> {
  return new Set([
    ...state.destinations.map(destination => destination.id),
    ...state.nodes.flatMap(node => node.destinations.map(destination => destination.id))
  ]);
}

function validateRequestExists(state: BoardProjection, requestId: RequestId): Result<void, DomainWorkflowError> {
  return state.requests.some(request => request.id === requestId) ? ok(undefined) : workflowError(`Unknown request: ${requestId}`);
}

function validateLineExists(state: BoardProjection, lineId: LineId): Result<LineRecord, DomainWorkflowError> {
  return lineResult(state, lineId);
}

function validatePausableLine(state: BoardProjection, lineId: LineId): Result<LineRecord, DomainWorkflowError> {
  const line = lineResult(state, lineId);
  return line.ok ? requireModelTransition(line.value, pauseLine(line.value)) : line;
}

function validateResumableLine(state: BoardProjection, lineId: LineId): Result<LineRecord, DomainWorkflowError> {
  const line = lineResult(state, lineId);
  return line.ok ? requireModelTransition(line.value, resumeLine(line.value)) : line;
}

function validateCompletableLine(state: BoardProjection, lineId: LineId): Result<LineRecord, DomainWorkflowError> {
  const line = lineResult(state, lineId);
  return line.ok ? requireModelTransition(line.value, completeLine(line.value)) : line;
}

function validateAbandonableLine(state: BoardProjection, lineId: LineId): Result<LineRecord, DomainWorkflowError> {
  const line = lineResult(state, lineId);
  return line.ok ? requireModelTransition(line.value, abandonLine(line.value)) : line;
}

function validateRootNodeExists(state: BoardProjection, requestId: RequestId): Result<NodeRecord, DomainWorkflowError> {
  return nodeResult(state, rootNodeId(requestId));
}

function validateMoveExists(state: BoardProjection, moveId: MoveId): Result<MoveRecord, DomainWorkflowError> {
  return moveResult(state, moveId);
}

function validateHunsuExists(state: BoardProjection, hunsuId: HunsuId): Result<HunsuRecord, DomainWorkflowError> {
  return hunsuResult(state, hunsuId);
}

function validateExistingDestination(state: BoardProjection, destinationId: DestinationId): Result<Destination, DomainWorkflowError> {
  return destinationResult(state, destinationId);
}

function validateStartableDestination(state: BoardProjection, destinationId: DestinationId): Result<Destination, DomainWorkflowError> {
  const destination = destinationResult(state, destinationId);
  return destination.ok
    ? requireModelTransition(destination.value, startDestinationWork(destination.value, { claimedBy: "validation", updatedBy: "TEAM" }))
    : destination;
}

function validateCurrentNodeForLine(state: BoardProjection, lineId: LineId): Result<NodeRecord, DomainWorkflowError> {
  return currentNodeForLineResult(state, lineId);
}

function validatePlayableLineForCommand(state: BoardProjection, lineId: LineId): Result<LineRecord, DomainWorkflowError> {
  const line = lineResult(state, lineId);
  if (!line.ok) {
    return line;
  }
  return requireModelTransition(line.value, makePlayableLine(line.value));
}

function validateClaimableDestination(state: BoardProjection, destinationId: DestinationId): Result<Destination, DomainWorkflowError> {
  const destination = destinationResult(state, destinationId);
  if (!destination.ok) {
    return destination;
  }
  return requireModelTransition(destination.value, claimDestination(destination.value, { claimedBy: "validation", updatedBy: "TEAM" }));
}

function validateBlockableDestination(state: BoardProjection, destinationId: DestinationId): Result<Destination, DomainWorkflowError> {
  const destination = destinationResult(state, destinationId);
  if (!destination.ok) {
    return destination;
  }
  return requireModelTransition(destination.value, blockDestination(destination.value, { blockedReason: "validation", updatedBy: "TEAM" }));
}

function validateDestinationInCurrentNode(state: BoardProjection, lineId: LineId, destinationId: DestinationId): Result<Destination, DomainWorkflowError> {
  const node = currentNodeForLineResult(state, lineId);
  return node.ok ? destinationInNodeResult(node.value, destinationId) : node;
}

function validateReachableDestinationsForCurrentNode(state: BoardProjection, lineId: LineId, moveId: MoveId, destinationIds: DestinationId[]): Result<unknown, DomainWorkflowError>[] {
  const node = currentNodeForLineResult(state, lineId);
  if (!node.ok) {
    return [node];
  }
  if (destinationIds.length !== 1) {
    return [workflowError("MOVE must reach exactly one Destination")];
  }
  return destinationIds.map(destinationId => validateReachableDestinationInNode(node.value, destinationId, moveId));
}

function validateReachableDestinationInNode(node: NodeRecord, destinationId: DestinationId, moveId: MoveId): Result<Destination, DomainWorkflowError> {
  const destination = destinationInNodeResult(node, destinationId);
  if (!destination.ok) {
    return destination;
  }
  return requireModelTransition(destination.value, reachDestination(destination.value, { reachedByMoveId: moveId, updatedBy: "TEAM" }));
}

function validateArtifactOwnerExists(state: BoardProjection, artifact: ArtifactRecord): Result<unknown, DomainWorkflowError> {
  switch (artifact.owner.type) {
    case "move":
      return validateMoveExists(state, artifact.owner.id);
    case "hunsu":
      return validateHunsuExists(state, artifact.owner.id);
    case "line":
      return validateLineExists(state, artifact.owner.id);
  }
}

function validateArtifactAttachedToMove(artifact: ArtifactRecord, moveId: MoveId): Result<void, DomainWorkflowError> {
  return artifact.owner.type !== "move" || artifact.owner.id !== moveId
    ? workflowError(`AttachMoveEvidence artifact owner must be move ${moveId}`)
    : ok(undefined);
}

function validateNodeBelongsToExactLine(state: BoardProjection, nodeId: NodeId, lineId: LineId): Result<NodeRecord, DomainWorkflowError> {
  const line = lineResult(state, lineId);
  if (!line.ok) {
    return line;
  }
  const node = nodeResult(state, nodeId);
  if (!node.ok) {
    return node;
  }
  return !line.value.nodeIds.includes(node.value.id)
    ? workflowError(`Node ${node.value.id} does not belong to line ${line.value.id}`)
    : node;
}

function validateMoveBelongsToLine(state: BoardProjection, moveId: MoveId, lineId: LineId): Result<MoveRecord, DomainWorkflowError> {
  const line = lineResult(state, lineId);
  if (!line.ok) {
    return line;
  }
  const move = moveResult(state, moveId);
  if (!move.ok) {
    return move;
  }
  return move.value.lineId !== line.value.id && !line.value.moveIds.includes(move.value.id)
    ? workflowError(`MOVE ${move.value.id} does not belong to line ${line.value.id}`)
    : move;
}

function validateHunsuTargetBelongsToLine(
  state: BoardProjection,
  lineId: LineId,
  target: HunsuRecord["target"]
): Result<unknown, DomainWorkflowError> {
  switch (target.type) {
    case "line": {
      const line = lineResult(state, lineId);
      if (!line.ok) {
        return line;
      }
      const targetLine = lineResult(state, target.id);
      if (!targetLine.ok) {
        return targetLine;
      }
      return targetLine.value.id === line.value.id
        ? ok(line.value)
        : workflowError(`HUNSU target line ${targetLine.value.id} does not match command line ${line.value.id}`);
    }
    case "node":
      return validateNodeBelongsToExactLine(state, target.id, lineId);
    case "move":
      return validateMoveBelongsToLine(state, target.id, lineId);
    case "destination":
      return validateDestinationInCurrentNode(state, lineId, target.id);
  }
}

function validateDraftSkillDraft(state: BoardProjection, draftId: string, action: "accepted" | "discarded"): Result<DraftSkillDraft, DomainWorkflowError> {
  const draft = skillDraftResult(state, draftId);
  if (!draft.ok) {
    return draft;
  }
  return draft.value.status !== "draft"
    ? workflowError(`Skill Draft ${draftId} cannot be ${action} from status ${draft.value.status}`)
    : ok(draft.value);
}

function lineResult(state: BoardProjection, lineId: string): Result<LineRecord, DomainWorkflowError> {
  const line = state.lines.find(candidate => candidate.id === lineId);
  return line ? ok(line) : workflowError(`Unknown line: ${lineId}`);
}

function nodeResult(state: BoardProjection, nodeId: NodeId): Result<NodeRecord, DomainWorkflowError> {
  const node = state.nodes.find(candidate => candidate.id === nodeId);
  return node ? ok(node) : workflowError(`Unknown node: ${nodeId}`);
}

function currentNodeForLineResult(state: BoardProjection, lineId: LineId): Result<NodeRecord, DomainWorkflowError> {
  const line = lineResult(state, lineId);
  return line.ok ? nodeResult(state, line.value.currentNodeId) : line;
}

function moveResult(state: BoardProjection, moveId: string): Result<MoveRecord, DomainWorkflowError> {
  const move = state.moves.find(candidate => candidate.id === moveId);
  return move ? ok(move) : workflowError(`Unknown MOVE: ${moveId}`);
}

function hunsuResult(state: BoardProjection, hunsuId: string): Result<HunsuRecord, DomainWorkflowError> {
  const hunsu = state.hunsus.find(candidate => candidate.id === hunsuId);
  return hunsu ? ok(hunsu) : workflowError(`Unknown HUNSU: ${hunsuId}`);
}

function skillDraftResult(state: BoardProjection, draftId: string): Result<SkillDraftRecord, DomainWorkflowError> {
  const draft = state.skillDrafts.find(candidate => candidate.id === draftId);
  return draft ? ok(draft) : workflowError(`Unknown Skill Draft: ${draftId}`);
}

function destinationResult(state: BoardProjection, destinationId: DestinationId): Result<Destination, DomainWorkflowError> {
  const destination = state.destinations.find(candidate => candidate.id === destinationId);
  return destination ? ok(destination) : workflowError(`Unknown Destination: ${destinationId}`);
}

function destinationInNodeResult(node: NodeRecord, destinationId: DestinationId): Result<Destination, DomainWorkflowError> {
  const destination = node.destinations.find(candidate => candidate.id === destinationId);
  return destination ? ok(destination) : workflowError(`Unknown Destination in node ${node.id}: ${destinationId}`);
}
