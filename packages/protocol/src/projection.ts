import {
  abandonLine,
  acceptSkillDraft,
  blockDestination,
  claimDestination,
  completeLine,
  createPendingDestination,
  discardSkillDraft,
  failLine,
  normalizeMoveRecord,
  patchMoveRecordBase,
  pauseLine,
  reachDestination,
  resumeLine,
  startDestinationWork,
  type DomainModelError
} from "./lifecycle.ts";
import {
  toDomainWorkflowError,
  workflowError,
  type DomainWorkflowError
} from "./errors.ts";
import type {
  BoardEdge,
  BoardProjection,
  ArtifactActionDefinition,
  Destination,
  DestinationId,
  DestinationSeed,
  DestinationSource,
  DomainEvent,
  HarnessSnapshot,
  HunsuRecord,
  LineRecord,
  MoveRecord,
  NodeId,
  NodeRecord,
  RequestId
} from "./model.ts";
import { makeTeamName, makeNonEmptyArray } from "./primitives.ts";
import {
  cloneHarnessEntity,
  cloneHarness,
  createDefaultHarness,
  harnessEntityFromSnapshot
} from "./protocol-validation.ts";
import { unwrapDomainModelResult } from "./errors.ts";
import {
  nextTeamName,
  requireLine,
  requireNode,
  requireRootNode,
  rootNodeId,
  unique,
  upsertById
} from "./workflow-helpers.ts";
import { err, ok, type Result } from "./result.ts";

export function emptyBoardProjection(): BoardProjection {
  return {
    origins: [],
    requests: [],
    destinations: [],
    nodes: [],
    edges: [],
    lines: [],
    moves: [],
    hunsus: [],
    skillDrafts: [],
    artifacts: [],
    artifactActions: [],
    futureConstraints: []
  };
}

export function projectBoard(events: DomainEvent[]): BoardProjection {
  return refreshVisibleDestinations(events.reduce((state, event) => projectEvent(state, event), emptyBoardProjection()));
}

export function tryProjectBoard(events: DomainEvent[]): Result<BoardProjection, DomainWorkflowError> {
  const valid = validateEventStream(events);
  if (!valid.ok) {
    return valid;
  }
  try {
    return ok(projectBoard(events));
  } catch (error) {
    return err(toDomainWorkflowError(error));
  }
}

export function validateEventStream(events: DomainEvent[]): Result<DomainEvent[], DomainWorkflowError> {
  const seen = {
    requestIds: new Set<string>(),
    destinationIds: new Set<string>(),
    lineIds: new Set<string>(),
    moveIds: new Set<string>(),
    hunsuIds: new Set<string>(),
    skillDraftIds: new Set<string>(),
    artifactIds: new Set<string>()
  };
  let state = emptyBoardProjection();
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    const validation = validateEventAggregateIds(event, index, seen);
    if (!validation.ok) {
      return validation;
    }
    const stateValidation = validateEventState(event, index, state);
    if (!stateValidation.ok) {
      return stateValidation;
    }
    try {
      state = projectEvent(state, event);
    } catch (error) {
      return err(toDomainWorkflowError(error));
    }
    const edges = validateProjectedEdges(state, index);
    if (!edges.ok) {
      return edges;
    }
  }
  return ok(events);
}

export function projectEvent(state: BoardProjection, event: DomainEvent): BoardProjection {
  switch (event.type) {
    case "HunsuOriginRegistered":
      return { ...state, origins: upsertOrigin(state.origins, event.origin) };
    case "InitialTeamCreated":
      return projectInitialTeamCreated(state, event);
    case "RequestCreated":
      return refreshVisibleDestinations({ ...state, requests: upsertById(state.requests, event.request) });
    case "DestinationDeclared":
      return projectDestinationDeclared(state, event.requestId, event.destination, event.at);
    case "HarnessSeeded":
      return projectHarnessSeeded(state, event.requestId, event.harness, event.at);
    case "LineStarted":
      return refreshVisibleDestinations({ ...state, lines: upsertById(state.lines, normalizeStartedLine(state, event.line)) });
    case "SkillDraftCreated":
      return { ...state, skillDrafts: upsertById(state.skillDrafts, event.draft) };
    case "SkillDraftAccepted":
      return {
        ...state,
        skillDrafts: state.skillDrafts.map(draft => draft.id === event.draftId
          ? unwrapDomainModelResult(acceptSkillDraft(draft, { ...event.skill }))
          : draft)
      };
    case "SkillDraftDiscarded":
      return {
        ...state,
        skillDrafts: state.skillDrafts.map(draft => draft.id === event.draftId ? unwrapDomainModelResult(discardSkillDraft(draft)) : draft)
      };
    case "NodeCreated":
      return refreshVisibleDestinations({ ...state, nodes: upsertById(state.nodes, event.node) });
    case "LinePaused":
      return transitionLine(state, event.lineId, pauseLine);
    case "LineResumed":
      return transitionLine(state, event.lineId, resumeLine);
    case "LineAccepted":
      return transitionLine(state, event.lineId, completeLine);
    case "LineRejected":
      return transitionLine(state, event.lineId, abandonLine);
    case "DestinationClaimed":
      return transitionDestinationInCurrentNodes(state, event.destinationId, destination => claimDestination(destination, { claimedBy: event.actor, updatedBy: "TEAM", updatedAt: event.at }));
    case "DestinationWorkStarted":
      return transitionDestinationInCurrentNodes(state, event.destinationId, destination => startDestinationWork(destination, { claimedBy: event.actor, updatedBy: "TEAM", updatedAt: event.at }));
    case "DestinationBlocked":
      return transitionDestinationInCurrentNodes(state, event.destinationId, destination => blockDestination(destination, { blockedReason: event.reason, updatedBy: "TEAM", updatedAt: event.at }));
    case "MoveRecorded":
      return projectMoveRecorded(state, event.move);
    case "DestinationReached":
      return state;
    case "HunsuRecorded":
      return projectHunsuRecorded(state, event.hunsu);
    case "LineForkedByHunsu":
      return projectLineForkedByHunsu(state, event);
    case "ArtifactRecorded":
      return { ...state, artifacts: upsertById(state.artifacts, event.artifact) };
  }
}

function upsertOrigin(origins: BoardProjection["origins"], origin: BoardProjection["origins"][number]): BoardProjection["origins"] {
  if (origins.some(existing => existing.name === origin.name)) {
    return origins.map(existing => existing.name === origin.name ? { ...origin } : { ...existing });
  }
  return [...origins.map(existing => ({ ...existing })), { ...origin }];
}

function validateEventAggregateIds(
  event: DomainEvent,
  index: number,
  seen: {
    requestIds: Set<string>;
    destinationIds: Set<string>;
    lineIds: Set<string>;
    moveIds: Set<string>;
    hunsuIds: Set<string>;
    skillDraftIds: Set<string>;
    artifactIds: Set<string>;
  }
): Result<void, DomainWorkflowError> {
  switch (event.type) {
    case "InitialTeamCreated": {
      const request = rememberAggregateId(seen.requestIds, "RequestId", event.request.id, index);
      if (!request.ok) return request;
      const line = rememberAggregateId(seen.lineIds, "LineId", event.line.id, index);
      if (!line.ok) return line;
      return rememberDestinationSeeds(seen.destinationIds, event.destinations, index);
    }
    case "RequestCreated":
      return rememberAggregateId(seen.requestIds, "RequestId", event.request.id, index);
    case "DestinationDeclared":
      return rememberAggregateId(seen.destinationIds, "DestinationId", event.destination.id, index);
    case "LineStarted":
      return rememberAggregateId(seen.lineIds, "LineId", event.line.id, index);
    case "SkillDraftCreated":
      return rememberAggregateId(seen.skillDraftIds, "SkillDraftId", event.draft.id, index);
    case "MoveRecorded":
      return rememberAggregateId(seen.moveIds, "MoveId", event.move.id, index);
    case "HunsuRecorded": {
      return rememberAggregateId(seen.hunsuIds, "HunsuId", event.hunsu.id, index);
    }
    case "LineForkedByHunsu":
      return rememberAggregateId(seen.lineIds, "LineId", event.newLineId, index);
    case "ArtifactRecorded":
      return rememberAggregateId(seen.artifactIds, "ArtifactId", event.artifact.id, index);
    case "HunsuOriginRegistered":
    case "HarnessSeeded":
    case "SkillDraftAccepted":
    case "SkillDraftDiscarded":
    case "NodeCreated":
    case "LinePaused":
    case "LineResumed":
    case "LineAccepted":
    case "LineRejected":
    case "DestinationClaimed":
    case "DestinationWorkStarted":
    case "DestinationBlocked":
    case "DestinationReached":
      return ok(undefined);
  }
}

function validateEventState(event: DomainEvent, index: number, state: BoardProjection): Result<void, DomainWorkflowError> {
  switch (event.type) {
    case "InitialTeamCreated":
      return validateInitialTeamCreatedEvent(event, index);
    case "DestinationDeclared":
      return state.requests.some(request => request.id === event.requestId)
        ? ok(undefined)
        : eventStreamError(index, `Unknown request: ${event.requestId}`);
    case "HarnessSeeded":
      return state.nodes.some(node => node.id === rootNodeId(event.requestId))
        ? ok(undefined)
        : eventStreamError(index, `Unknown root node for request: ${event.requestId}`);
    case "LineStarted":
      return validateLineStartedEvent(state, event.line, index);
    case "SkillDraftAccepted":
      return validateSkillDraftTransitionEvent(state, event.draftId, index, draft => acceptSkillDraft(draft, event.skill));
    case "SkillDraftDiscarded":
      return validateSkillDraftTransitionEvent(state, event.draftId, index, discardSkillDraft);
    case "NodeCreated":
      return validateNodeCreatedEvent(state, event.node, index);
    case "LinePaused":
      return validateLineTransitionEvent(state, event.lineId, index, pauseLine);
    case "LineResumed":
      return validateLineTransitionEvent(state, event.lineId, index, resumeLine);
    case "LineAccepted":
      return validateLineTransitionEvent(state, event.lineId, index, completeLine);
    case "LineRejected":
      return validateLineTransitionEvent(state, event.lineId, index, abandonLine);
    case "DestinationClaimed":
      return validateDestinationTransitionEvent(state, event.destinationId, index, destination => claimDestination(destination, { claimedBy: event.actor, updatedBy: "TEAM", updatedAt: event.at }));
    case "DestinationWorkStarted":
      return validateDestinationTransitionEvent(state, event.destinationId, index, destination => startDestinationWork(destination, { claimedBy: event.actor, updatedBy: "TEAM", updatedAt: event.at }));
    case "DestinationBlocked":
      return validateDestinationTransitionEvent(state, event.destinationId, index, destination => blockDestination(destination, { blockedReason: event.reason, updatedBy: "TEAM", updatedAt: event.at }));
    case "MoveRecorded":
      return validateMoveRecordedEvent(state, event.move, index);
    case "HunsuRecorded":
      return validateHunsuRecordedEvent(state, event.hunsu, index);
    case "LineForkedByHunsu":
      return validateLineForkedByHunsuEvent(state, event, index);
    case "ArtifactRecorded":
      return validateArtifactRecordedEvent(state, event.artifact, index);
    case "DestinationReached":
      return eventStreamError(index, "DestinationReached is a legacy no-op event and cannot be projected");
    case "HunsuOriginRegistered":
    case "RequestCreated":
    case "SkillDraftCreated":
      return ok(undefined);
  }
}

function validateInitialTeamCreatedEvent(
  event: Extract<DomainEvent, { type: "InitialTeamCreated" }>,
  index: number
): Result<void, DomainWorkflowError> {
  if (event.line.requestId !== event.request.id) {
    return eventStreamError(index, `Initial line ${event.line.id} request ${event.line.requestId} does not match request ${event.request.id}`);
  }
  if (event.line.status !== "active") {
    return eventStreamError(index, `Initial line ${event.line.id} cannot start from status ${event.line.status}`);
  }
  if (event.line.rootNodeId !== event.line.currentNodeId) {
    return eventStreamError(index, `Initial line ${event.line.id} currentNodeId must start at rootNodeId`);
  }
  if (!event.line.nodeIds.includes(event.line.rootNodeId)) {
    return eventStreamError(index, `Initial line ${event.line.id} nodeIds must include rootNodeId ${event.line.rootNodeId}`);
  }
  if (event.line.moveIds.length !== 0) {
    return eventStreamError(index, `Initial line ${event.line.id} cannot start with MOVEs`);
  }
  if ("parentLineId" in event.line || "forkedFromMoveId" in event.line) {
    return eventStreamError(index, `Initial line ${event.line.id} cannot carry fork metadata`);
  }
  return ok(undefined);
}

function validateLineStartedEvent(
  state: BoardProjection,
  line: LineRecord,
  index: number
): Result<void, DomainWorkflowError> {
  if (!state.requests.some(request => request.id === line.requestId)) {
    return eventStreamError(index, `Unknown request: ${line.requestId}`);
  }
  if (line.status !== "active") {
    return eventStreamError(index, `Line ${line.id} cannot start from status ${line.status}`);
  }
  const rootNode = state.nodes.find(node => node.id === rootNodeId(line.requestId));
  if (!rootNode) {
    return eventStreamError(index, `Unknown root node for request: ${line.requestId}`);
  }
  if (line.rootNodeId !== rootNode.id || line.currentNodeId !== rootNode.id || !line.nodeIds.includes(rootNode.id)) {
    return eventStreamError(index, `Line ${line.id} must start at request root node ${rootNode.id}`);
  }
  if (line.moveIds.length !== 0) {
    return eventStreamError(index, `Line ${line.id} cannot start with MOVEs`);
  }
  if ("parentLineId" in line || "forkedFromMoveId" in line) {
    return eventStreamError(index, `LineStarted ${line.id} cannot carry fork metadata`);
  }
  return ok(undefined);
}

function validateSkillDraftTransitionEvent(
  state: BoardProjection,
  draftId: string,
  index: number,
  transition: (draft: BoardProjection["skillDrafts"][number]) => Result<BoardProjection["skillDrafts"][number], DomainModelError>
): Result<void, DomainWorkflowError> {
  const draft = state.skillDrafts.find(candidate => candidate.id === draftId);
  if (!draft) {
    return eventStreamError(index, `Unknown Skill Draft: ${draftId}`);
  }
  return validateEventModelTransition(index, transition(draft));
}

function validateNodeCreatedEvent(
  state: BoardProjection,
  node: NodeRecord,
  index: number
): Result<void, DomainWorkflowError> {
  if (node.lineId) {
    const line = state.lines.find(candidate => candidate.id === node.lineId);
    if (!line) {
      return eventStreamError(index, `Unknown line: ${node.lineId}`);
    }
    if (line.requestId !== node.requestId) {
      return eventStreamError(index, `Node ${node.id} request ${node.requestId} does not match line ${line.id} request ${line.requestId}`);
    }
  }
  const source = node.source;
  switch (source.type) {
    case "initial-execute-team":
    case "request":
      return state.requests.some(request => request.id === source.requestId)
        ? ok(undefined)
        : eventStreamError(index, `Unknown request: ${source.requestId}`);
    case "move": {
      const move = state.moves.find(candidate => candidate.id === source.moveId);
      if (!move) {
        return eventStreamError(index, `Unknown MOVE: ${source.moveId}`);
      }
      return move.toNodeId === node.id && move.fromNodeId === source.fromNodeId
        ? ok(undefined)
        : eventStreamError(index, `Node ${node.id} does not match MOVE ${move.id} topology`);
    }
    case "hunsu": {
      const hunsu = state.hunsus.find(candidate => candidate.id === source.hunsuId);
      if (!hunsu) {
        return eventStreamError(index, `Unknown HUNSU: ${source.hunsuId}`);
      }
      return hunsu.toNodeId === node.id && hunsu.fromNodeId === source.fromNodeId
        ? ok(undefined)
        : eventStreamError(index, `Node ${node.id} does not match HUNSU ${hunsu.id} topology`);
    }
  }
}

function validateLineTransitionEvent(
  state: BoardProjection,
  lineId: string,
  index: number,
  transition: (line: LineRecord) => Result<LineRecord, DomainModelError>
): Result<void, DomainWorkflowError> {
  const line = state.lines.find(candidate => candidate.id === lineId);
  if (!line) {
    return eventStreamError(index, `Unknown line: ${lineId}`);
  }
  return validateEventModelTransition(index, transition(line));
}

function validateDestinationTransitionEvent(
  state: BoardProjection,
  destinationId: DestinationId,
  index: number,
  transition: (destination: Destination) => Result<Destination, DomainModelError>
): Result<void, DomainWorkflowError> {
  const activeNodeIds = new Set(state.lines.map(line => line.currentNodeId));
  const destinations = state.nodes
    .filter(node => activeNodeIds.has(node.id))
    .flatMap(node => node.destinations.filter(destination => destination.id === destinationId));
  if (destinations.length === 0) {
    return eventStreamError(index, `Unknown Destination in active route nodes: ${destinationId}`);
  }
  for (const destination of destinations) {
    const validation = validateEventModelTransition(index, transition(destination));
    if (!validation.ok) {
      return validation;
    }
  }
  return ok(undefined);
}

function validateMoveRecordedEvent(
  state: BoardProjection,
  move: MoveRecord,
  index: number
): Result<void, DomainWorkflowError> {
  const line = state.lines.find(candidate => candidate.id === move.lineId);
  if (!line) {
    return eventStreamError(index, `Unknown line: ${move.lineId}`);
  }
  if (line.status !== "active") {
    return eventStreamError(index, `TEAM line ${line.id} cannot continue from status ${line.status}`);
  }
  const fromNode = state.nodes.find(node => node.id === move.fromNodeId);
  if (!fromNode) {
    return eventStreamError(index, `Unknown node: ${move.fromNodeId}`);
  }
  if (fromNode.id !== line.currentNodeId || fromNode.requestId !== line.requestId) {
    return eventStreamError(index, `MOVE ${move.id} source node ${fromNode.id} does not match current node for line ${line.id}`);
  }
  if (move.toNodeId === move.fromNodeId) {
    return eventStreamError(index, `MOVE ${move.id} cannot be a self-loop`);
  }
  if (state.nodes.some(node => node.id === move.toNodeId)) {
    return eventStreamError(index, `MOVE ${move.id} target node already exists: ${move.toNodeId}`);
  }
  const normalized = normalizeMoveRecord(move);
  if (!normalized.ok) {
    return eventStreamError(index, normalized.error.message);
  }
  for (const destinationId of move.reachedDestinationIds) {
    const destination = validateDestinationInEventSourceNode(fromNode, destinationId, index);
    if (!destination.ok) {
      return destination;
    }
    const reachable = validateEventModelTransition(index, reachDestination(destination.value, { reachedByMoveId: move.id, updatedBy: "TEAM", updatedAt: move.recordedAt }));
    if (!reachable.ok) {
      return reachable;
    }
  }
  return ok(undefined);
}

function validateHunsuRecordedEvent(
  state: BoardProjection,
  hunsu: HunsuRecord,
  index: number
): Result<void, DomainWorkflowError> {
  const line = state.lines.find(candidate => candidate.id === hunsu.lineId);
  if (!line) {
    return eventStreamError(index, `Unknown line: ${hunsu.lineId}`);
  }
  const fromNode = state.nodes.find(candidate => candidate.id === hunsu.fromNodeId);
  if (!fromNode) {
    return eventStreamError(index, `Unknown node: ${hunsu.fromNodeId}`);
  }
  if (fromNode.requestId !== line.requestId || !line.nodeIds.includes(fromNode.id)) {
    return eventStreamError(index, `Node ${fromNode.id} does not belong to line ${line.id}`);
  }
  if (hunsu.toNodeId === hunsu.fromNodeId) {
    return eventStreamError(index, `HUNSU ${hunsu.id} cannot be a self-loop`);
  }
  if (state.nodes.some(node => node.id === hunsu.toNodeId)) {
    return eventStreamError(index, `HUNSU ${hunsu.id} target node already exists: ${hunsu.toNodeId}`);
  }
  const target = validateHunsuEventTarget(state, hunsu, line, fromNode, index);
  if (!target.ok) {
    return target;
  }
  return validateHunsuRuntimeSnapshot(state, hunsu, fromNode, index);
}

function validateHunsuEventTarget(
  state: BoardProjection,
  hunsu: HunsuRecord,
  line: LineRecord,
  fromNode: NodeRecord,
  index: number
): Result<void, DomainWorkflowError> {
  switch (hunsu.target.type) {
    case "line": {
      const targetLine = state.lines.find(candidate => candidate.id === hunsu.target.id);
      if (!targetLine) {
        return eventStreamError(index, `Unknown line: ${hunsu.target.id}`);
      }
      return targetLine.id === hunsu.lineId
        ? ok(undefined)
        : eventStreamError(index, `HUNSU target line ${targetLine.id} does not match event line ${hunsu.lineId}`);
    }
    case "node": {
      const targetNode = state.nodes.find(candidate => candidate.id === hunsu.target.id);
      if (!targetNode) {
        return eventStreamError(index, `Unknown node: ${hunsu.target.id}`);
      }
      return targetNode.requestId === line.requestId && line.nodeIds.includes(targetNode.id)
        ? ok(undefined)
        : eventStreamError(index, `Node ${targetNode.id} does not belong to line ${line.id}`);
    }
    case "move": {
      const move = validateMoveBelongsToEventLine(state, line, hunsu.target.id, index);
      return move.ok ? ok(undefined) : move;
    }
    case "destination":
      return fromNode.destinations.some(destination => destination.id === hunsu.target.id)
        ? ok(undefined)
        : eventStreamError(index, `Unknown Destination in node ${fromNode.id}: ${hunsu.target.id}`);
  }
  return eventStreamError(index, `Unsupported HUNSU target: ${JSON.stringify(hunsu.target)}`);
}

function validateHunsuRuntimeSnapshot(
  state: BoardProjection,
  hunsu: HunsuRecord,
  fromNode: NodeRecord,
  index: number
): Result<void, DomainWorkflowError> {
  if (hunsu.changedFiles.length === 0) {
    return eventStreamError(index, `HUNSU ${hunsu.id} must include changed runtime files`);
  }
  const changedPaths = new Set<string>();
  for (const file of hunsu.changedFiles) {
    const path = String(file.path);
    if (!path.startsWith(".hunsu-request/")) {
      return eventStreamError(index, `HUNSU changed file must be under .hunsu-request: ${path}`);
    }
    if (changedPaths.has(path)) {
      return eventStreamError(index, `Duplicate HUNSU changed file: ${path}`);
    }
    changedPaths.add(path);
  }
  if (hunsu.teamSnapshot.moveOrdinal !== fromNode.ordinal) {
    return eventStreamError(index, `HUNSU ${hunsu.id} Team snapshot ordinal ${hunsu.teamSnapshot.moveOrdinal} does not match source node ordinal ${fromNode.ordinal}`);
  }
  const existingSourceDestinationIds = new Set(fromNode.destinations.map(destination => String(destination.id)));
  const existingGlobalDestinationIds = new Set(state.destinations.map(destination => String(destination.id)));
  const snapshotDestinationIds = new Set<string>();
  for (const destination of hunsu.teamSnapshot.destinations) {
    const destinationId = String(destination.id);
    if (snapshotDestinationIds.has(destinationId)) {
      return eventStreamError(index, `Duplicate DestinationId in HUNSU Team snapshot: ${destinationId}`);
    }
    snapshotDestinationIds.add(destinationId);
    if (destination.requestId !== fromNode.requestId) {
      return eventStreamError(index, `Destination ${destination.id} request ${destination.requestId} does not match source request ${fromNode.requestId}`);
    }
    if (!existingSourceDestinationIds.has(destinationId) && existingGlobalDestinationIds.has(destinationId)) {
      return eventStreamError(index, `Duplicate DestinationId in HUNSU Team snapshot: ${destinationId}`);
    }
  }
  return ok(undefined);
}

function validateDestinationInEventSourceNode(
  node: NodeRecord,
  destinationId: DestinationId,
  index: number
): Result<Destination, DomainWorkflowError> {
  const destination = node.destinations.find(candidate => candidate.id === destinationId);
  return destination
    ? ok(destination)
    : eventStreamError(index, `Unknown Destination in node ${node.id}: ${destinationId}`);
}

function validateMoveBelongsToEventLine(
  state: BoardProjection,
  line: LineRecord,
  moveId: string,
  index: number
): Result<MoveRecord, DomainWorkflowError> {
  const move = state.moves.find(candidate => candidate.id === moveId);
  if (!move) {
    return eventStreamError(index, `Unknown MOVE: ${moveId}`);
  }
  return move.lineId === line.id || line.moveIds.includes(move.id)
    ? ok(move)
    : eventStreamError(index, `MOVE ${move.id} does not belong to line ${line.id}`);
}

function validateMoveEndsAtEventSourceNode(
  state: BoardProjection,
  line: LineRecord,
  moveId: string,
  fromNode: NodeRecord,
  index: number
): Result<void, DomainWorkflowError> {
  const move = validateMoveBelongsToEventLine(state, line, moveId, index);
  if (!move.ok) {
    return move;
  }
  return move.value.toNodeId === fromNode.id
    ? ok(undefined)
    : eventStreamError(index, `MOVE ${move.value.id} does not end at HUNSU source node ${fromNode.id}`);
}

function validateLineForkedByHunsuEvent(
  state: BoardProjection,
  event: Extract<DomainEvent, { type: "LineForkedByHunsu" }>,
  index: number
): Result<void, DomainWorkflowError> {
  const parentLine = state.lines.find(candidate => candidate.id === event.fromLineId);
  if (!parentLine) {
    return eventStreamError(index, `Unknown line: ${event.fromLineId}`);
  }
  if (event.requestId !== parentLine.requestId) {
    return eventStreamError(index, `LineForkedByHunsu request ${event.requestId} does not match parent line ${parentLine.id}`);
  }
  const hunsu = state.hunsus.find(candidate => candidate.id === event.hunsuId);
  if (!hunsu) {
    return eventStreamError(index, `Unknown HUNSU: ${event.hunsuId}`);
  }
  if (hunsu.lineId !== event.fromLineId) {
    return eventStreamError(index, `HUNSU ${hunsu.id} does not belong to parent line ${event.fromLineId}`);
  }
  if (hunsu.newLineId !== event.newLineId) {
    return eventStreamError(index, `Line fork ${event.newLineId} does not match HUNSU recorded new line ${hunsu.newLineId}`);
  }
  if (hunsu.sourceMoveId !== event.fromMoveId) {
    return eventStreamError(index, `Line fork ${event.newLineId} fromMoveId does not match HUNSU source move`);
  }
  if (hunsu.newTeamName !== event.newTeamName) {
    return eventStreamError(index, `Line fork ${event.newLineId} Team name does not match HUNSU record`);
  }
  if (event.fromMoveId) {
    const move = validateMoveBelongsToEventLine(state, parentLine, event.fromMoveId, index);
    if (!move.ok) {
      return move;
    }
    if (move.value.toNodeId !== hunsu.fromNodeId) {
      return eventStreamError(index, `Line fork source MOVE ${move.value.id} does not end at HUNSU source node ${hunsu.fromNodeId}`);
    }
  }
  return state.nodes.some(node => node.id === hunsu.toNodeId)
    ? ok(undefined)
    : eventStreamError(index, `Unknown HUNSU target node: ${hunsu.toNodeId}`);
}

function validateArtifactRecordedEvent(
  state: BoardProjection,
  artifact: BoardProjection["artifacts"][number],
  index: number
): Result<void, DomainWorkflowError> {
  switch (artifact.owner.type) {
    case "move":
      return state.moves.some(move => move.id === artifact.owner.id)
        ? ok(undefined)
        : eventStreamError(index, `Unknown MOVE: ${artifact.owner.id}`);
    case "hunsu":
      return state.hunsus.some(hunsu => hunsu.id === artifact.owner.id)
        ? ok(undefined)
        : eventStreamError(index, `Unknown HUNSU: ${artifact.owner.id}`);
    case "line":
      return state.lines.some(line => line.id === artifact.owner.id)
        ? ok(undefined)
        : eventStreamError(index, `Unknown line: ${artifact.owner.id}`);
  }
}

function validateProjectedEdges(state: BoardProjection, index: number): Result<void, DomainWorkflowError> {
  for (const edge of state.edges) {
    const fromNode = state.nodes.find(node => node.id === edge.fromNodeId);
    if (!fromNode) {
      return eventStreamError(index, `Edge ${edge.id} references missing fromNode ${edge.fromNodeId}`);
    }
    const toNode = state.nodes.find(node => node.id === edge.toNodeId);
    if (!toNode) {
      return eventStreamError(index, `Edge ${edge.id} references missing toNode ${edge.toNodeId}`);
    }
    switch (edge.type) {
      case "move": {
        const move = state.moves.find(candidate => candidate.id === edge.moveId);
        if (!move) {
          return eventStreamError(index, `MOVE edge ${edge.id} references missing MOVE ${edge.moveId}`);
        }
        if (move.lineId !== edge.lineId || move.fromNodeId !== edge.fromNodeId || move.toNodeId !== edge.toNodeId || move.id !== edge.id) {
          return eventStreamError(index, `MOVE edge ${edge.id} does not match MOVE ${move.id}`);
        }
        break;
      }
      case "hunsu": {
        const hunsu = state.hunsus.find(candidate => candidate.id === edge.hunsuId);
        if (!hunsu) {
          return eventStreamError(index, `HUNSU edge ${edge.id} references missing HUNSU ${edge.hunsuId}`);
        }
        if (hunsu.lineId !== edge.lineId || hunsu.fromNodeId !== edge.fromNodeId || hunsu.toNodeId !== edge.toNodeId || hunsu.id !== edge.id) {
          return eventStreamError(index, `HUNSU edge ${edge.id} does not match HUNSU ${hunsu.id}`);
        }
        break;
      }
    }
  }
  return ok(undefined);
}

function validateEventModelTransition<T>(
  index: number,
  transition: Result<T, DomainModelError>
): Result<void, DomainWorkflowError> {
  return transition.ok ? ok(undefined) : eventStreamError(index, transition.error.message);
}

function eventStreamError(index: number, message: string): Result<never, DomainWorkflowError> {
  return workflowError(`Invalid event stream at event ${index}: ${message}`);
}

function rememberDestinationSeeds(
  seen: Set<string>,
  destinations: DestinationSeed[],
  index: number
): Result<void, DomainWorkflowError> {
  for (const destination of destinations) {
    const remembered = rememberAggregateId(seen, "DestinationId", destination.id, index);
    if (!remembered.ok) {
      return remembered;
    }
  }
  return ok(undefined);
}

function rememberAggregateId(seen: Set<string>, label: string, id: string, index: number): Result<void, DomainWorkflowError> {
  if (seen.has(id)) {
    return workflowError(`Duplicate ${label} in event stream at event ${index}: ${id}`);
  }
  seen.add(id);
  return ok(undefined);
}

function projectInitialTeamCreated(
  state: BoardProjection,
  event: Extract<DomainEvent, { type: "InitialTeamCreated" }>
): BoardProjection {
  const destinations = event.destinations.map(destination => createDestination(event.request.id, destination, "initial-execute-team", event.at));
  const harness = cloneHarness(event.harness ?? createDefaultHarness());
  const rootNode: NodeRecord = {
    id: event.line.rootNodeId,
    requestId: event.request.id,
    lineId: event.line.id,
    teamName: event.line.teamName,
    ordinal: 0,
    destinations,
    harness,
    harnessGraph: harnessEntityFromSnapshot(harness),
    harnessLock: event.harnessLock ? { ...event.harnessLock } : undefined,
    executorPackageBindings: [],
    resourcePackageBindings: [],
    artifactActions: [],
    source: { type: "initial-execute-team", requestId: event.request.id },
    createdAt: event.at ?? event.request.createdAt
  };
  const line = normalizeStartedLine({ ...state, requests: upsertById(state.requests, event.request), nodes: upsertById(state.nodes, rootNode) }, {
    ...event.line,
    rootNodeId: rootNode.id,
    currentNodeId: event.line.currentNodeId,
    nodeIds: event.line.nodeIds
  });
  return refreshVisibleDestinations({
    ...state,
    requests: upsertById(state.requests, event.request),
    nodes: upsertById(state.nodes, rootNode),
    lines: upsertById(state.lines, line)
  });
}

function projectDestinationDeclared(state: BoardProjection, requestId: RequestId, seed: DestinationSeed, at?: string): BoardProjection {
  const destination = createDestination(requestId, seed, "initial-request", at);
  const existing = state.nodes.find(node => node.id === rootNodeId(requestId));
  const rootNode: NodeRecord = existing
    ? { ...existing, destinations: upsertById(existing.destinations, destination) }
    : {
        id: rootNodeId(requestId),
        requestId,
        ordinal: 0,
        destinations: [destination],
        harness: createDefaultHarness(),
        harnessGraph: harnessEntityFromSnapshot(createDefaultHarness()),
        artifactActions: [],
        source: { type: "request", requestId },
        createdAt: at
      };
  return refreshVisibleDestinations({ ...state, nodes: upsertById(state.nodes, rootNode) });
}

function projectHarnessSeeded(
  state: BoardProjection,
  requestId: RequestId,
  harness: HarnessSnapshot,
  at?: string
): BoardProjection {
  const rootNode = requireRootNode(state, requestId);
  return refreshVisibleDestinations({
    ...state,
    nodes: upsertById(state.nodes, {
      ...rootNode,
      harness: cloneHarness(harness),
      harnessGraph: harnessEntityFromSnapshot(harness),
      createdAt: rootNode.createdAt ?? at
    })
  });
}

function projectMoveRecorded(state: BoardProjection, move: MoveRecord): BoardProjection {
  const line = requireLine(state, move.lineId);
  const fromNode = requireNode(state, move.fromNodeId);
  const toNodeId = move.toNodeId;
  const baseMove = unwrapDomainModelResult(normalizeMoveRecord(patchMoveRecordBase(move, {
    fromNodeId: fromNode.id,
    toNodeId,
    teamName: move.teamName ?? line.teamName ?? fromNode.teamName ?? nextTeamName(state),
    ordinal: move.ordinal ?? fromNode.ordinal + 1
  })));
  const targetNode = state.nodes.find(node => node.id === toNodeId) ?? createMoveNode(fromNode, baseMove, toNodeId);
  const recordedMove = unwrapDomainModelResult(normalizeMoveRecord(patchMoveRecordBase(baseMove, { snapshot: baseMove.snapshot ?? snapshotForNode(targetNode) })));
  const edge: BoardEdge = { id: recordedMove.id, type: "move", lineId: recordedMove.lineId, fromNodeId: fromNode.id, toNodeId, moveId: recordedMove.id };
  const withRecord = {
    ...state,
    nodes: upsertById(state.nodes, targetNode),
    moves: upsertById(state.moves, recordedMove),
    edges: upsertById(state.edges, edge)
  };
  const advanced = advanceLineToNode(appendMoveToLine(withRecord, recordedMove), recordedMove.lineId, toNodeId);
  return refreshVisibleDestinations(recordedMove.outcome === "accident" ? transitionLine(advanced, recordedMove.lineId, failLine) : advanced);
}

function projectHunsuRecorded(state: BoardProjection, hunsu: HunsuRecord): BoardProjection {
  requireLine(state, hunsu.lineId);
  const fromNode = requireNode(state, hunsu.fromNodeId);
  const toNodeId = hunsu.toNodeId;
  const recordedHunsu: HunsuRecord = { ...hunsu, fromNodeId: fromNode.id, toNodeId };
  const targetNode = state.nodes.find(node => node.id === toNodeId) ?? createHunsuNode(fromNode, recordedHunsu, toNodeId);
  const edge: BoardEdge = { id: recordedHunsu.id, type: "hunsu", lineId: recordedHunsu.lineId, fromNodeId: fromNode.id, toNodeId, hunsuId: recordedHunsu.id };
  const withRecord = {
    ...state,
    nodes: upsertById(state.nodes, targetNode),
    hunsus: upsertById(state.hunsus, recordedHunsu),
    edges: upsertById(state.edges, edge)
  };
  if (recordedHunsu.newLineId) {
    return refreshVisibleDestinations(withRecord);
  }
  return refreshVisibleDestinations(advanceLineToNode(withRecord, recordedHunsu.lineId, toNodeId));
}

function projectLineForkedByHunsu(
  state: BoardProjection,
  event: Extract<DomainEvent, { type: "LineForkedByHunsu" }>
): BoardProjection {
  const parentLine = requireLine(state, event.fromLineId);
  const hunsu = state.hunsus.find(candidate => candidate.id === event.hunsuId);
  const move = event.fromMoveId ? state.moves.find(candidate => candidate.id === event.fromMoveId) : undefined;
  const branchNodeId = hunsu?.toNodeId ?? move?.toNodeId ?? parentLine.currentNodeId;
  const fromMoveIndex = event.fromMoveId ? parentLine.moveIds.indexOf(event.fromMoveId) : -1;
  const inheritedMoveIds = fromMoveIndex >= 0 ? parentLine.moveIds.slice(0, fromMoveIndex + 1) : [];
  return refreshVisibleDestinations({
    ...state,
    lines: upsertById(state.lines, {
      id: event.newLineId,
      requestId: event.requestId,
      teamName: event.newTeamName ?? nextTeamName(state),
      status: "active",
      moveIds: inheritedMoveIds,
      rootNodeId: parentLine.rootNodeId,
      currentNodeId: branchNodeId,
      nodeIds: [branchNodeId],
      parentLineId: event.fromLineId,
      forkedFromMoveId: event.fromMoveId
    })
  });
}

function normalizeStartedLine(state: BoardProjection, line: LineRecord): LineRecord {
  return {
    ...line,
    teamName: line.teamName ?? nextTeamName(state)
  };
}

function createMoveNode(fromNode: NodeRecord, move: MoveRecord, toNodeId: NodeId): NodeRecord {
  const reachedDestinationIds = new Set<DestinationId>(move.reachedDestinationIds);
  return {
    id: toNodeId,
    requestId: fromNode.requestId,
    lineId: move.lineId,
    teamName: move.teamName ?? fromNode.teamName,
    ordinal: move.ordinal ?? fromNode.ordinal + 1,
    destinations: fromNode.destinations.map(destination => reachedDestinationIds.has(destination.id)
      ? unwrapDomainModelResult(reachDestination(destination, {
          reachedByMoveId: move.id,
          updatedBy: "TEAM",
          updatedAt: move.recordedAt
        }))
      : { ...destination }),
    harness: cloneHarness(fromNode.harness),
    harnessGraph: cloneHarnessEntity(fromNode.harnessGraph),
    harnessLock: fromNode.harnessLock ? { ...fromNode.harnessLock } : undefined,
    executorPackageBindings: fromNode.executorPackageBindings?.map(binding => ({ executorId: binding.executorId, lock: { ...binding.lock } })),
    resourcePackageBindings: fromNode.resourcePackageBindings?.map(binding => ({ name: binding.name, lock: { ...binding.lock } })),
    artifactActions: cloneArtifactActions(fromNode.artifactActions),
    source: { type: "move", moveId: move.id, fromNodeId: fromNode.id },
    createdAt: move.recordedAt
  };
}

function createHunsuNode(fromNode: NodeRecord, hunsu: HunsuRecord, toNodeId: NodeId): NodeRecord {
  const snapshot = hunsu.teamSnapshot;
  return {
    id: toNodeId,
    requestId: fromNode.requestId,
    lineId: hunsu.newLineId ?? hunsu.lineId,
    teamName: snapshot.teamName,
    ordinal: snapshot.moveOrdinal,
    destinations: snapshot.destinations.map(destination => ({ ...destination })),
    harness: cloneHarness(snapshot.harness),
    harnessGraph: cloneHarnessEntity(snapshot.harnessGraph),
    harnessLock: snapshot.harnessLock ? { ...snapshot.harnessLock } : undefined,
    executorPackageBindings: snapshot.executorPackageBindings?.map(binding => ({ executorId: binding.executorId, lock: { ...binding.lock } })),
    resourcePackageBindings: snapshot.resourcePackageBindings?.map(binding => ({ name: binding.name, lock: { ...binding.lock } })),
    artifactActions: cloneArtifactActions(snapshot.artifactActions),
    source: { type: "hunsu", hunsuId: hunsu.id, fromNodeId: fromNode.id },
    createdAt: hunsu.recordedAt
  };
}

function cloneArtifactActions(actions: ArtifactActionDefinition[] | undefined): ArtifactActionDefinition[] {
  return sortArtifactActions((actions ?? []).map(cloneArtifactAction));
}

function cloneArtifactAction(action: ArtifactActionDefinition): ArtifactActionDefinition {
  return {
    ...action,
    env: action.env ? Object.fromEntries(Object.entries(action.env).map(([key, value]) => [key, { ...value }])) : undefined,
    runner: { ...action.runner },
    aliases: action.aliases ? Object.fromEntries(Object.entries(action.aliases).map(([key, value]) => [key, { ...value }])) : undefined,
    evidence: action.evidence ? { ...action.evidence, paths: action.evidence.paths?.slice() } : undefined
  };
}

function sortArtifactActions(actions: ArtifactActionDefinition[]): ArtifactActionDefinition[] {
  return actions.slice().sort((left, right) => left.displayOrder - right.displayOrder || String(left.id).localeCompare(String(right.id)));
}

function uniqueArtifactActions(actions: ArtifactActionDefinition[]): ArtifactActionDefinition[] {
  const seen = new Set<string>();
  const uniqueActions: ArtifactActionDefinition[] = [];
  for (const action of actions) {
    if (seen.has(action.id)) {
      continue;
    }
    seen.add(action.id);
    uniqueActions.push(cloneArtifactAction(action));
  }
  return uniqueActions;
}

function snapshotForNode(node: NodeRecord) {
  return {
    teamName: node.teamName ?? unwrapDomainModelResult(makeTeamName("Team")),
    moveOrdinal: node.ordinal,
    destinations: node.destinations.map(destination => ({ ...destination })),
    harness: cloneHarness(node.harness),
    harnessGraph: cloneHarnessEntity(node.harnessGraph),
    harnessLock: node.harnessLock ? { ...node.harnessLock } : undefined,
    executorPackageBindings: node.executorPackageBindings?.map(binding => ({ executorId: binding.executorId, lock: { ...binding.lock } })),
    resourcePackageBindings: node.resourcePackageBindings?.map(binding => ({ name: binding.name, lock: { ...binding.lock } })),
    artifactActions: cloneArtifactActions(node.artifactActions)
  };
}

function createDestination(requestId: RequestId, destination: DestinationSeed, source: DestinationSource, at?: string): Destination {
  return createPendingDestination(requestId, destination, source, at);
}

function updateDestination(
  destinations: Destination[],
  destinationId: DestinationId,
  transition: (destination: Destination) => Result<Destination, DomainModelError>
): Destination[] {
  return destinations.map(destination => (destination.id === destinationId ? unwrapDomainModelResult(transition(destination)) : { ...destination }));
}

function transitionDestinationInCurrentNodes(
  state: BoardProjection,
  destinationId: DestinationId,
  transition: (destination: Destination) => Result<Destination, DomainModelError>
): BoardProjection {
  const activeNodeIds = new Set(state.lines.map(line => line.currentNodeId));
  const nodes = state.nodes.map(node => {
    if (!activeNodeIds.has(node.id) || !node.destinations.some(destination => destination.id === destinationId)) {
      return node;
    }
    return { ...node, destinations: updateDestination(node.destinations, destinationId, transition) };
  });
  return refreshVisibleDestinations({ ...state, nodes });
}

function transitionLine(
  state: BoardProjection,
  lineId: string,
  transition: (line: LineRecord) => Result<LineRecord, DomainModelError>
): BoardProjection {
  requireLine(state, lineId);
  return refreshVisibleDestinations({
    ...state,
    lines: state.lines.map(line => (line.id === lineId ? unwrapDomainModelResult(transition(line)) : line))
  });
}

function appendMoveToLine(state: BoardProjection, move: MoveRecord): BoardProjection {
  requireLine(state, move.lineId);
  return {
    ...state,
    lines: state.lines.map(line => (line.id === move.lineId ? { ...line, moveIds: unique([...line.moveIds, move.id]) } : line))
  };
}

function advanceLineToNode(state: BoardProjection, lineId: string, nodeId: NodeId): BoardProjection {
  requireLine(state, lineId);
  return {
    ...state,
    lines: state.lines.map(line => (line.id === lineId
      ? { ...line, currentNodeId: nodeId, nodeIds: unwrapDomainModelResult(makeNonEmptyArray(unique([...line.nodeIds, nodeId]), "nodeIds")) }
      : line))
  };
}

function refreshVisibleDestinations(state: BoardProjection): BoardProjection {
  const visibleNodes = state.requests.flatMap(request => {
    const node = visibleNodeForRequest(state, request.id);
    return node ? [node] : [];
  });
  const visibleDestinations = visibleNodes.flatMap(node => node.destinations);
  const artifactActions = visibleNodes.flatMap(node => node.artifactActions);
  return {
    ...state,
    destinations: visibleDestinations.map(destination => ({ ...destination })),
    artifactActions: sortArtifactActions(uniqueArtifactActions(artifactActions))
  };
}

function visibleNodeForRequest(state: BoardProjection, requestId: RequestId): NodeRecord | undefined {
  const requestLines = state.lines.filter(line => line.requestId === requestId && line.status !== "abandoned");
  const line = requestLines.findLast(candidate => candidate.status === "active") ?? requestLines.at(-1);
  if (line) {
    return state.nodes.find(node => node.id === line.currentNodeId);
  }
  return state.nodes.find(node => node.id === rootNodeId(requestId));
}
