import {
  workflowError,
  type DomainWorkflowError
} from "./errors.ts";
import type { ValidatedCommand } from "./model.ts";
import {
  makeLineId,
  makeMoveCommit,
  makeMoveId,
  makeNonEmptyText,
  makeTeamName,
  makeRequestGoal,
  makeRequestId,
  makeRequestTitle,
  makeSingleItemArray,
  makeSkillDraftId,
  makeSummary,
  makeDestinationId,
  makeFailureReason
} from "./primitives.ts";
import { ok, type Result } from "./result.ts";
import {
  decodeAgentConversationRef,
  decodeArtifactRecord,
  decodeDestinationIdArray,
  decodeDestinationSeedArray,
  decodeHubPackageLock,
  decodeHunsuOrigin,
  decodeEvidenceArray,
  decodeHunsuDraftRecord,
  decodeOptionalAt,
  decodeOptionalExecuteId,
  decodeOptionalNonEmptyText,
  decodeRecord,
  decodeRiskArray,
  decodeWorktreeRef,
  type HarnessDecoder
} from "./decoder-helpers.ts";

export function decodeCommand(input: unknown, decodeHarness: HarnessDecoder): Result<ValidatedCommand, DomainWorkflowError> {
  const command = decodeRecord(input, "Command");
  if (!command.ok) {
    return command;
  }
  switch (command.value.type) {
    case "RegisterHunsuOrigin": {
      const origin = decodeHunsuOrigin(command.value.origin, "origin");
      if (!origin.ok) return origin;
      const actor = decodeOptionalNonEmptyText(command.value.actor, "actor");
      if (!actor.ok) return actor;
      const at = decodeOptionalAt(command.value.at);
      if (!at.ok) return at;
      return ok({ type: "RegisterHunsuOrigin", origin: origin.value, actor: actor.value, at: at.value });
    }
    case "CreateInitialTeam": {
      const requestId = primitive(makeRequestId(command.value.requestId));
      if (!requestId.ok) return requestId;
      const lineId = primitive(makeLineId(command.value.lineId));
      if (!lineId.ok) return lineId;
      const title = primitive(makeRequestTitle(command.value.title));
      if (!title.ok) return title;
      const goal = primitive(makeRequestGoal(command.value.goal));
      if (!goal.ok) return goal;
      const destinations = decodeDestinationSeedArray(command.value.destinations, "destinations");
      if (!destinations.ok) return destinations;
      const harness = command.value.harness === undefined ? ok(undefined) : decodeHarness(command.value.harness);
      if (!harness.ok) return harness;
      const harnessLock = decodeHubPackageLock(command.value.harnessLock, "harnessLock", ["team"]);
      if (!harnessLock.ok) return harnessLock;
      const teamName = command.value.teamName === undefined ? ok(undefined) : primitive(makeTeamName(command.value.teamName));
      if (!teamName.ok) return teamName;
      const actor = decodeOptionalNonEmptyText(command.value.actor, "actor");
      if (!actor.ok) return actor;
      const at = decodeOptionalAt(command.value.at);
      if (!at.ok) return at;
      return ok({
        type: "CreateInitialTeam",
        requestId: requestId.value,
        lineId: lineId.value,
        title: title.value,
        goal: goal.value,
        destinations: destinations.value,
        harness: harness.value,
        harnessLock: harnessLock.value,
        teamName: teamName.value,
        actor: actor.value,
        at: at.value
      });
    }
    case "StartLine": {
      const requestId = primitive(makeRequestId(command.value.requestId));
      if (!requestId.ok) return requestId;
      const lineId = primitive(makeLineId(command.value.lineId));
      if (!lineId.ok) return lineId;
      const teamName = command.value.teamName === undefined ? ok(undefined) : primitive(makeTeamName(command.value.teamName));
      if (!teamName.ok) return teamName;
      const at = decodeOptionalAt(command.value.at);
      if (!at.ok) return at;
      return ok({ type: "StartLine", lineId: lineId.value, requestId: requestId.value, teamName: teamName.value, at: at.value });
    }
    case "PauseLine":
    case "ResumeLine": {
      const lineId = primitive(makeLineId(command.value.lineId));
      if (!lineId.ok) return lineId;
      const at = decodeOptionalAt(command.value.at);
      if (!at.ok) return at;
      return ok({ type: command.value.type, lineId: lineId.value, at: at.value });
    }
    case "AcceptLine":
    case "RejectLine": {
      const lineId = primitive(makeLineId(command.value.lineId));
      if (!lineId.ok) return lineId;
      const reason = decodeOptionalNonEmptyText(command.value.reason, "reason");
      if (!reason.ok) return reason;
      const at = decodeOptionalAt(command.value.at);
      if (!at.ok) return at;
      return ok({ type: command.value.type, lineId: lineId.value, reason: reason.value, at: at.value });
    }
    case "ClaimDestination":
    case "StartDestinationWork": {
      const destinationId = primitive(makeDestinationId(command.value.destinationId));
      if (!destinationId.ok) return destinationId;
      const actor = primitive(makeNonEmptyText(command.value.actor, "actor"));
      if (!actor.ok) return actor;
      const at = decodeOptionalAt(command.value.at);
      if (!at.ok) return at;
      return ok({ type: command.value.type, destinationId: destinationId.value, actor: actor.value, at: at.value });
    }
    case "ReportDestinationBlocked": {
      const destinationId = primitive(makeDestinationId(command.value.destinationId));
      if (!destinationId.ok) return destinationId;
      const reason = primitive(makeFailureReason(command.value.reason, "reason"));
      if (!reason.ok) return reason;
      const actor = primitive(makeNonEmptyText(command.value.actor, "actor"));
      if (!actor.ok) return actor;
      const at = decodeOptionalAt(command.value.at);
      if (!at.ok) return at;
      return ok({ type: "ReportDestinationBlocked", destinationId: destinationId.value, reason: reason.value, actor: actor.value, at: at.value });
    }
    case "RecordMove": {
      const lineId = primitive(makeLineId(command.value.lineId));
      if (!lineId.ok) return lineId;
      const moveId = primitive(makeMoveId(command.value.moveId));
      if (!moveId.ok) return moveId;
      const summary = primitive(makeSummary(command.value.summary));
      if (!summary.ok) return summary;
      const commit = primitive(makeMoveCommit(command.value.commit, "commit"));
      if (!commit.ok) return commit;
      const reachedDestinationIds = decodeDestinationIdArray(command.value.reachedDestinationIds, "reachedDestinationIds", true);
      if (!reachedDestinationIds.ok) return reachedDestinationIds;
      const singleReachedDestinationIds = primitive(makeSingleItemArray(reachedDestinationIds.value, "reachedDestinationIds"));
      if (!singleReachedDestinationIds.ok) return singleReachedDestinationIds;
      const evidence = decodeEvidenceArray(command.value.evidence, "evidence", true);
      if (!evidence.ok) return evidence;
      const risks = command.value.risks === undefined ? ok(undefined) : decodeRiskArray(command.value.risks, "risks");
      if (!risks.ok) return risks;
      const executeId = decodeOptionalExecuteId(command.value.executeId);
      if (!executeId.ok) return executeId;
      const conversationRef = decodeAgentConversationRef(command.value.conversationRef, "conversationRef");
      if (!conversationRef.ok) return conversationRef;
      const worktree = decodeWorktreeRef(command.value.worktree, "worktree");
      if (!worktree.ok) return worktree;
      const actor = primitive(makeNonEmptyText(command.value.actor, "actor"));
      if (!actor.ok) return actor;
      const at = decodeOptionalAt(command.value.at);
      if (!at.ok) return at;
      return ok({
        type: "RecordMove",
        lineId: lineId.value,
        moveId: moveId.value,
        summary: summary.value,
        commit: commit.value,
        reachedDestinationIds: singleReachedDestinationIds.value,
        evidence: evidence.value,
        risks: risks.value,
        executeId: executeId.value,
        conversationRef: conversationRef.value,
        worktree: worktree.value,
        actor: actor.value,
        at: at.value
      });
    }
    case "RecordAccident": {
      const lineId = primitive(makeLineId(command.value.lineId));
      if (!lineId.ok) return lineId;
      const moveId = primitive(makeMoveId(command.value.moveId));
      if (!moveId.ok) return moveId;
      const summary = primitive(makeSummary(command.value.summary));
      if (!summary.ok) return summary;
      const commit = primitive(makeMoveCommit(command.value.commit, "commit"));
      if (!commit.ok) return commit;
      const evidence = decodeEvidenceArray(command.value.evidence, "evidence", true);
      if (!evidence.ok) return evidence;
      const failureReason = primitive(makeFailureReason(command.value.failureReason));
      if (!failureReason.ok) return failureReason;
      const risks = command.value.risks === undefined ? ok(undefined) : decodeRiskArray(command.value.risks, "risks");
      if (!risks.ok) return risks;
      const executeId = decodeOptionalExecuteId(command.value.executeId);
      if (!executeId.ok) return executeId;
      const conversationRef = decodeAgentConversationRef(command.value.conversationRef, "conversationRef");
      if (!conversationRef.ok) return conversationRef;
      const worktree = decodeWorktreeRef(command.value.worktree, "worktree");
      if (!worktree.ok) return worktree;
      const actor = primitive(makeNonEmptyText(command.value.actor, "actor"));
      if (!actor.ok) return actor;
      const at = decodeOptionalAt(command.value.at);
      if (!at.ok) return at;
      return ok({
        type: "RecordAccident",
        lineId: lineId.value,
        moveId: moveId.value,
        summary: summary.value,
        commit: commit.value,
        evidence: evidence.value,
        failureReason: failureReason.value,
        risks: risks.value,
        executeId: executeId.value,
        conversationRef: conversationRef.value,
        worktree: worktree.value,
        actor: actor.value,
        at: at.value
      });
    }
    case "AttachMoveEvidence": {
      const moveId = primitive(makeMoveId(command.value.moveId));
      if (!moveId.ok) return moveId;
      const artifact = decodeArtifactRecord(command.value.artifact, "artifact");
      if (!artifact.ok) return artifact;
      const actor = primitive(makeNonEmptyText(command.value.actor, "actor"));
      if (!actor.ok) return actor;
      const at = decodeOptionalAt(command.value.at);
      if (!at.ok) return at;
      return ok({ type: "AttachMoveEvidence", moveId: moveId.value, artifact: artifact.value, actor: actor.value, at: at.value });
    }
    case "ConfirmHunsuDraft": {
      const draft = decodeHunsuDraftRecord(command.value.draft, "draft", decodeHarness);
      if (!draft.ok) return draft;
      if (draft.value.status !== "ready") {
        return workflowError(`HUNSU Draft ${draft.value.id} cannot be confirmed from status ${draft.value.status}`);
      }
      const actor = primitive(makeNonEmptyText(command.value.actor, "actor"));
      if (!actor.ok) return actor;
      const at = decodeOptionalAt(command.value.at);
      if (!at.ok) return at;
      return ok({
        type: "ConfirmHunsuDraft",
        draft: draft.value,
        actor: actor.value,
        at: at.value
      });
    }
    case "CreateSkillDraft": {
      const draftId = primitive(makeSkillDraftId(command.value.draftId));
      if (!draftId.ok) return draftId;
      const lineId = primitive(makeLineId(command.value.lineId));
      if (!lineId.ok) return lineId;
      const name = primitive(makeNonEmptyText(command.value.name, "name"));
      if (!name.ok) return name;
      const draftPath = primitive(makeNonEmptyText(command.value.draftPath, "draftPath"));
      if (!draftPath.ok) return draftPath;
      const sourcePath = decodeOptionalNonEmptyText(command.value.sourcePath, "sourcePath");
      if (!sourcePath.ok) return sourcePath;
      const actor = primitive(makeNonEmptyText(command.value.actor, "actor"));
      if (!actor.ok) return actor;
      const at = decodeOptionalAt(command.value.at);
      if (!at.ok) return at;
      return ok({ type: "CreateSkillDraft", draftId: draftId.value, lineId: lineId.value, name: name.value, draftPath: draftPath.value, sourcePath: sourcePath.value, actor: actor.value, at: at.value });
    }
    case "DiscardSkillDraft": {
      const draftId = primitive(makeSkillDraftId(command.value.draftId));
      if (!draftId.ok) return draftId;
      const actor = primitive(makeNonEmptyText(command.value.actor, "actor"));
      if (!actor.ok) return actor;
      const at = decodeOptionalAt(command.value.at);
      if (!at.ok) return at;
      return ok({ type: "DiscardSkillDraft", draftId: draftId.value, actor: actor.value, at: at.value });
    }
    case "RecordArtifact": {
      const artifact = decodeArtifactRecord(command.value.artifact, "artifact");
      if (!artifact.ok) return artifact;
      const at = decodeOptionalAt(command.value.at);
      if (!at.ok) return at;
      return ok({ type: "RecordArtifact", artifact: artifact.value, at: at.value });
    }
    default:
      return workflowError(`Unsupported command type: ${String(command.value.type)}`);
  }
}

function primitive<T>(result: Result<T, { message: string }>): Result<T, DomainWorkflowError> {
  return result.ok ? ok(result.value) : workflowError(result.error.message);
}
