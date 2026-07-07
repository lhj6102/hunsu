import {
  workflowError,
  type DomainWorkflowError
} from "./errors.ts";
import type {
  DomainEvent
} from "./model.ts";
import {
  makeDestinationId,
  makeTeamName,
  makeFailureReason,
  makeHunsuId,
  makeLineId,
  makeMoveId,
  makeRequestId,
  makeSkillDraftId
} from "./primitives.ts";
import { ok, type Result } from "./result.ts";
import {
  decodeArtifactRecord,
  decodeDestinationSeed,
  decodeDestinationSeedArray,
  decodeHubPackageLock,
  decodeHunsuOrigin,
  decodeHunsuRecord,
  decodeLineRecord,
  decodeMoveRecord,
  decodeNonEmptyText,
  decodeOptionalAt,
  decodeOptionalMoveId,
  decodeOptionalNonEmptyText,
  decodeRecord,
  decodeRequestRecord,
  decodeSkillBinding,
  decodeSkillDraftRecord,
  decodeNodeRecord,
  type HarnessDecoder
} from "./decoder-helpers.ts";

export function decodeDomainEvent(value: unknown, decodeHarness: HarnessDecoder): Result<DomainEvent, DomainWorkflowError> {
  const event = decodeRecord(value, "DomainEvent");
  if (!event.ok) {
    return event;
  }
  switch (event.value.type) {
    case "HunsuOriginRegistered": {
      const origin = decodeHunsuOrigin(event.value.origin, "event.origin");
      if (!origin.ok) return origin;
      const at = decodeOptionalAt(event.value.at, "event.at");
      if (!at.ok) return at;
      return ok({ type: "HunsuOriginRegistered", origin: origin.value, at: at.value });
    }
    case "InitialTeamCreated": {
      const request = decodeRequestRecord(event.value.request, "event.request");
      if (!request.ok) return request;
      const line = decodeLineRecord(event.value.line, "event.line");
      if (!line.ok) return line;
      const destinations = decodeDestinationSeedArray(event.value.destinations, "event.destinations");
      if (!destinations.ok) return destinations;
      const harness = event.value.harness === undefined ? ok(undefined) : decodeHarness(event.value.harness);
      if (!harness.ok) return harness;
      const harnessLock = decodeHubPackageLock(event.value.harnessLock, "event.harnessLock", ["team"]);
      if (!harnessLock.ok) return harnessLock;
      const at = decodeOptionalAt(event.value.at, "event.at");
      if (!at.ok) return at;
      return ok({
        type: "InitialTeamCreated",
        request: request.value,
        line: line.value,
        destinations: destinations.value,
        harness: harness.value,
        harnessLock: harnessLock.value,
        at: at.value
      });
    }
    case "RequestCreated": {
      const request = decodeRequestRecord(event.value.request, "event.request");
      return request.ok ? ok({ type: "RequestCreated", request: request.value }) : request;
    }
    case "DestinationDeclared": {
      const requestId = primitive(makeRequestId(event.value.requestId));
      if (!requestId.ok) return requestId;
      const destination = decodeDestinationSeed(event.value.destination, "event.destination");
      if (!destination.ok) return destination;
      const at = decodeOptionalAt(event.value.at, "event.at");
      if (!at.ok) return at;
      return ok({ type: "DestinationDeclared", requestId: requestId.value, destination: destination.value, at: at.value });
    }
    case "HarnessSeeded": {
      const requestId = primitive(makeRequestId(event.value.requestId));
      if (!requestId.ok) return requestId;
      const harness = decodeHarness(event.value.harness);
      if (!harness.ok) return harness;
      const at = decodeOptionalAt(event.value.at, "event.at");
      if (!at.ok) return at;
      return ok({ type: "HarnessSeeded", requestId: requestId.value, harness: harness.value, at: at.value });
    }
    case "LineStarted": {
      const line = decodeLineRecord(event.value.line, "event.line");
      return line.ok ? ok({ type: "LineStarted", line: line.value }) : line;
    }
    case "SkillDraftCreated": {
      const draft = decodeSkillDraftRecord(event.value.draft, "event.draft");
      return draft.ok ? ok({ type: "SkillDraftCreated", draft: draft.value }) : draft;
    }
    case "SkillDraftAccepted": {
      const draftId = primitive(makeSkillDraftId(event.value.draftId));
      if (!draftId.ok) return draftId;
      const skill = decodeSkillBinding(event.value.skill, "event.skill");
      if (!skill.ok) return skill;
      const at = decodeOptionalAt(event.value.at, "event.at");
      if (!at.ok) return at;
      return ok({ type: "SkillDraftAccepted", draftId: draftId.value, skill: skill.value, at: at.value });
    }
    case "SkillDraftDiscarded": {
      const draftId = primitive(makeSkillDraftId(event.value.draftId));
      if (!draftId.ok) return draftId;
      const at = decodeOptionalAt(event.value.at, "event.at");
      if (!at.ok) return at;
      return ok({ type: "SkillDraftDiscarded", draftId: draftId.value, at: at.value });
    }
    case "NodeCreated": {
      const node = decodeNodeRecord(event.value.node, "event.node", decodeHarness);
      return node.ok ? ok({ type: "NodeCreated", node: node.value }) : node;
    }
    case "LinePaused":
    case "LineResumed": {
      const lineId = primitive(makeLineId(event.value.lineId));
      if (!lineId.ok) return lineId;
      const at = decodeOptionalAt(event.value.at, "event.at");
      if (!at.ok) return at;
      return ok({ type: event.value.type, lineId: lineId.value, at: at.value });
    }
    case "LineAccepted":
    case "LineRejected": {
      const lineId = primitive(makeLineId(event.value.lineId));
      if (!lineId.ok) return lineId;
      const reason = decodeOptionalNonEmptyText(event.value.reason, "event.reason");
      if (!reason.ok) return reason;
      const at = decodeOptionalAt(event.value.at, "event.at");
      if (!at.ok) return at;
      return ok({ type: event.value.type, lineId: lineId.value, reason: reason.value, at: at.value });
    }
    case "DestinationClaimed":
    case "DestinationWorkStarted": {
      const destinationId = primitive(makeDestinationId(event.value.destinationId));
      if (!destinationId.ok) return destinationId;
      const actor = decodeNonEmptyText(event.value.actor, "event.actor");
      if (!actor.ok) return actor;
      const at = decodeOptionalAt(event.value.at, "event.at");
      if (!at.ok) return at;
      return ok({ type: event.value.type, destinationId: destinationId.value, actor: actor.value, at: at.value });
    }
    case "DestinationBlocked": {
      const destinationId = primitive(makeDestinationId(event.value.destinationId));
      if (!destinationId.ok) return destinationId;
      const reason = primitive(makeFailureReason(event.value.reason, "event.reason"));
      if (!reason.ok) return reason;
      const actor = decodeNonEmptyText(event.value.actor, "event.actor");
      if (!actor.ok) return actor;
      const at = decodeOptionalAt(event.value.at, "event.at");
      if (!at.ok) return at;
      return ok({ type: "DestinationBlocked", destinationId: destinationId.value, reason: reason.value, actor: actor.value, at: at.value });
    }
    case "MoveRecorded": {
      const move = decodeMoveRecord(event.value.move, "event.move", decodeHarness);
      return move.ok ? ok({ type: "MoveRecorded", move: move.value }) : move;
    }
    case "DestinationReached": {
      const destinationId = primitive(makeDestinationId(event.value.destinationId));
      if (!destinationId.ok) return destinationId;
      const moveId = primitive(makeMoveId(event.value.moveId));
      if (!moveId.ok) return moveId;
      const at = decodeOptionalAt(event.value.at, "event.at");
      if (!at.ok) return at;
      return ok({ type: "DestinationReached", destinationId: destinationId.value, moveId: moveId.value, at: at.value });
    }
    case "HunsuRecorded": {
      const hunsu = decodeHunsuRecord(event.value.hunsu, "event.hunsu", decodeHarness);
      return hunsu.ok ? ok({ type: "HunsuRecorded", hunsu: hunsu.value }) : hunsu;
    }
    case "LineForkedByHunsu": {
      const hunsuId = primitive(makeHunsuId(event.value.hunsuId));
      if (!hunsuId.ok) return hunsuId;
      const fromLineId = primitive(makeLineId(event.value.fromLineId));
      if (!fromLineId.ok) return fromLineId;
      const newLineId = primitive(makeLineId(event.value.newLineId));
      if (!newLineId.ok) return newLineId;
      const rawNewTeamName = event.value.newTeamName ?? event.value.newTeamName;
      const newTeamName = rawNewTeamName === undefined
        ? ok(undefined)
        : primitive(makeTeamName(rawNewTeamName, rawNewTeamName === event.value.newTeamName ? "event.newTeamName" : "event.newTeamName"));
      if (!newTeamName.ok) return newTeamName;
      const fromMoveId = decodeOptionalMoveId(event.value.fromMoveId);
      if (!fromMoveId.ok) return fromMoveId;
      const requestId = primitive(makeRequestId(event.value.requestId));
      if (!requestId.ok) return requestId;
      const at = decodeOptionalAt(event.value.at, "event.at");
      if (!at.ok) return at;
      return ok({
        type: "LineForkedByHunsu",
        hunsuId: hunsuId.value,
        fromLineId: fromLineId.value,
        newLineId: newLineId.value,
        newTeamName: newTeamName.value,
        fromMoveId: fromMoveId.value,
        requestId: requestId.value,
        at: at.value
      });
    }
    case "ArtifactRecorded": {
      const artifact = decodeArtifactRecord(event.value.artifact, "event.artifact");
      if (!artifact.ok) return artifact;
      const at = decodeOptionalAt(event.value.at, "event.at");
      if (!at.ok) return at;
      return ok({ type: "ArtifactRecorded", artifact: artifact.value, at: at.value });
    }
    default:
      return workflowError(`Unsupported Hunsu domain event type: ${String(event.value.type)}`);
  }
}

function primitive<T>(result: Result<T, { message: string }>): Result<T, DomainWorkflowError> {
  return result.ok ? ok(result.value) : workflowError(result.error.message);
}
