import {
  ARTIFACT_ACTION_KINDS,
  ARTIFACT_ACTION_SOURCE_SCOPES,
  ARTIFACT_KINDS,
  DESTINATION_SOURCES,
  DESTINATION_STATUSES,
  DOMAIN_ROLES,
  HUNSU_DRAFT_STATUSES,
  LINE_STATUSES,
  MOVE_OUTCOMES,
  REASONING_EFFORTS,
  SERVICE_TIERS,
  SKILL_DRAFT_STATUSES
} from "./constants.ts";
import {
  workflowError,
  type DomainWorkflowError
} from "./errors.ts";
import type {
  AgentConversationRef,
  ArtifactActionDefinition,
  ArtifactActionEnvValue,
  ArtifactActionPatch,
  ArtifactRecord,
  BoardEdge,
  Destination,
  DestinationBase,
  DestinationPatch,
  DestinationSeed,
  DestinationSource,
  HubPackageKind,
  HubPackageLock,
  DomainRole,
  Harness,
  HarnessSnapshot,
  TeamSnapshot,
  HunsuOrigin,
  HunsuDraftRecord,
  HunsuRecord,
  HunsuTarget,
  LineRecord,
  ForkedLineRecordBase,
  RootLineRecordBase,
  MoveRecord,
  NodeRecord,
  ExecutorPackageBinding,
  MemberPluginBinding,
  RequestRecord,
  SkillBinding,
  ResourcePackageBinding,
  SkillSnapshotFile,
  SkillDraftRecord,
  WorktreeRef
} from "./model.ts";
import {
  makeAgentConversationHash,
  makeArtifactActionId,
  makeArtifactId,
  makeDestinationAcceptanceCriterion,
  makeDestinationConstraint,
  makeDestinationId,
  makeDestinationNotes,
  makeDestinationTitle,
  makeExecuteId,
  makeTeamName,
  makeEvidenceText,
  makeFailureReason,
  makeHunsuDraftId,
  makeHunsuId,
  makeLineId,
  makeMoveCommit,
  makeMoveId,
  makeNodeId,
  makeNonEmptyArray,
  makeNonEmptyText,
  makePositiveInteger,
  makeRequestGoal,
  makeRequestId,
  makeRequestTitle,
  makeRiskText,
  makeSingleItemArray,
  makeSkillDraftId,
  makeSummary,
  makeWorktreeHash,
  type NonEmptyText,
  type RiskText
} from "./primitives.ts";
import { decodePromptTemplate } from "./prompt-template.ts";
import {
  harnessEntityFromSnapshot,
  validateHarnessEntity
} from "./protocol-validation.ts";
import { ok, type Result } from "./result.ts";

export type HarnessDecoder = (value: unknown) => Result<HarnessSnapshot, DomainWorkflowError>;

export function decodeRecord(value: unknown, path: string): Result<Record<string, unknown>, DomainWorkflowError> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? ok(value as Record<string, unknown>)
    : workflowError(`${path} must be an object`);
}

export function decodeArray(value: unknown, path: string): Result<unknown[], DomainWorkflowError> {
  return Array.isArray(value) ? ok(value) : workflowError(`${path} must be an array`);
}

export function decodeAllowed<const T extends string>(path: string, value: unknown, allowed: readonly T[]): Result<T, DomainWorkflowError> {
  return typeof value === "string" && allowed.includes(value as T)
    ? ok(value as T)
    : workflowError(`${path} must be one of: ${allowed.join(", ")}`);
}

function decodeDomainRole(value: unknown, path: string): Result<DomainRole, DomainWorkflowError> {
  return decodeAllowed(path, value, DOMAIN_ROLES);
}

function decodeDestinationSource(value: unknown, path: string): Result<DestinationSource, DomainWorkflowError> {
  return decodeAllowed(path, value, DESTINATION_SOURCES);
}

export function decodeNumber(value: unknown, path: string): Result<number, DomainWorkflowError> {
  return typeof value === "number" && Number.isFinite(value)
    ? ok(value)
    : workflowError(`${path} must be a finite number`);
}

export function decodeOptionalBoolean(value: unknown, path: string): Result<boolean | undefined, DomainWorkflowError> {
  if (value === undefined) {
    return ok(undefined);
  }
  return typeof value === "boolean" ? ok(value) : workflowError(`${path} must be a boolean`);
}

export function decodeNonNegativeInteger(value: unknown, path: string): Result<number, DomainWorkflowError> {
  return Number.isInteger(value) && Number(value) >= 0
    ? ok(Number(value))
    : workflowError(`${path} must be a non-negative integer`);
}

export function decodeOptionalString(value: unknown, path: string): Result<string | undefined, DomainWorkflowError> {
  if (value === undefined) {
    return ok(undefined);
  }
  return typeof value === "string" ? ok(value) : workflowError(`${path} must be a string`);
}

export function decodeString(value: unknown, path: string): Result<string, DomainWorkflowError> {
  return typeof value === "string" ? ok(value) : workflowError(`${path} must be a string`);
}

export function decodeOptionalNonEmptyText(value: unknown, path: string): Result<NonEmptyText | undefined, DomainWorkflowError> {
  if (value === undefined) {
    return ok(undefined);
  }
  const text = makeNonEmptyText(value, path);
  return text.ok ? ok(text.value) : workflowError(text.error.message);
}

export function decodeNonEmptyText(value: unknown, path: string): Result<NonEmptyText, DomainWorkflowError> {
  const text = makeNonEmptyText(value, path);
  return text.ok ? ok(text.value) : workflowError(text.error.message);
}

export function decodeOptionalAt(value: unknown, path = "at"): Result<string | undefined, DomainWorkflowError> {
  return decodeOptionalString(value, path);
}

export function decodeStringArray(value: unknown, path: string): Result<string[], DomainWorkflowError> {
  const array = decodeArray(value, path);
  if (!array.ok) {
    return array;
  }
  const items: string[] = [];
  for (let index = 0; index < array.value.length; index += 1) {
    const item = array.value[index];
    if (typeof item !== "string") {
      return workflowError(`${path}[${index}] must be a string`);
    }
    items.push(item);
  }
  return ok(items);
}

export function decodeOptionalStringArray(value: unknown, path: string): Result<string[] | undefined, DomainWorkflowError> {
  return value === undefined ? ok(undefined) : decodeStringArray(value, path);
}

function decodeOptionalNonEmptyTextArray(value: unknown, path: string): Result<NonEmptyText[] | undefined, DomainWorkflowError> {
  if (value === undefined) {
    return ok(undefined);
  }
  const array = decodeArray(value, path);
  if (!array.ok) {
    return array;
  }
  const items: NonEmptyText[] = [];
  for (let index = 0; index < array.value.length; index += 1) {
    const item = primitive(makeNonEmptyText(array.value[index], `${path}[${index}]`));
    if (!item.ok) {
      return item;
    }
    items.push(item.value);
  }
  return ok(items);
}

export function decodeOptionalNumber(value: unknown, path: string): Result<number | undefined, DomainWorkflowError> {
  return value === undefined ? ok(undefined) : decodeNumber(value, path);
}

export function decodeRequestRecord(value: unknown, path: string): Result<RequestRecord, DomainWorkflowError> {
  const record = decodeRecord(value, path);
  if (!record.ok) {
    return record;
  }
  const id = primitive(makeRequestId(record.value.id));
  if (!id.ok) return id;
  const title = primitive(makeRequestTitle(record.value.title));
  if (!title.ok) return title;
  const goal = primitive(makeRequestGoal(record.value.goal));
  if (!goal.ok) return goal;
  const createdBy = decodeDomainRole(record.value.createdBy, `${path}.createdBy`);
  if (!createdBy.ok) return createdBy;
  const createdAt = decodeOptionalString(record.value.createdAt, `${path}.createdAt`);
  if (!createdAt.ok) return createdAt;
  return ok({ id: id.value, title: title.value, goal: goal.value, createdBy: createdBy.value, createdAt: createdAt.value });
}

export function decodeDestinationSeed(value: unknown, path: string): Result<DestinationSeed, DomainWorkflowError> {
  const record = decodeRecord(value, path);
  if (!record.ok) {
    return record;
  }
  const id = primitive(makeDestinationId(record.value.id));
  if (!id.ok) return id;
  const title = primitive(makeDestinationTitle(record.value.title, `${path}.title`));
  if (!title.ok) return title;
  const acceptanceCriteria = decodeOptionalDestinationAcceptanceCriteria(record.value.acceptanceCriteria, `${path}.acceptanceCriteria`);
  if (!acceptanceCriteria.ok) return acceptanceCriteria;
  const constraints = decodeOptionalDestinationConstraints(record.value.constraints, `${path}.constraints`);
  if (!constraints.ok) return constraints;
  const priority = decodeOptionalNumber(record.value.priority, `${path}.priority`);
  if (!priority.ok) return priority;
  const notes = record.value.notes === undefined ? ok(undefined) : primitive(makeDestinationNotes(record.value.notes, `${path}.notes`));
  if (!notes.ok) return notes;
  return ok({
    id: id.value,
    title: title.value,
    acceptanceCriteria: acceptanceCriteria.value,
    constraints: constraints.value,
    priority: priority.value,
    notes: notes.value
  });
}

export function decodeDestinationSeedArray(value: unknown, path: string, requireNonEmpty = true): Result<DestinationSeed[], DomainWorkflowError> {
  const array = decodeArray(value, path);
  if (!array.ok) {
    return array;
  }
  if (requireNonEmpty) {
    const nonEmpty = primitive(makeNonEmptyArray(array.value, path));
    if (!nonEmpty.ok) {
      return nonEmpty;
    }
  }
  const destinations: DestinationSeed[] = [];
  for (let index = 0; index < array.value.length; index += 1) {
    const destination = decodeDestinationSeed(array.value[index], `${path}[${index}]`);
    if (!destination.ok) {
      return destination;
    }
    destinations.push(destination.value);
  }
  const uniqueIds = rejectDuplicateIds(destinations.map(destination => destination.id), path, "DestinationId");
  if (!uniqueIds.ok) {
    return uniqueIds;
  }
  return ok(destinations);
}

function decodeOptionalDestinationAcceptanceCriteria(
  value: unknown,
  path: string
): Result<ReturnType<typeof makeDestinationAcceptanceCriterion> extends Result<infer T, unknown> ? T[] | undefined : never, DomainWorkflowError> {
  if (value === undefined) {
    return ok(undefined);
  }
  const array = decodeArray(value, path);
  if (!array.ok) {
    return array;
  }
  const items: Array<ReturnType<typeof makeDestinationAcceptanceCriterion> extends Result<infer T, unknown> ? T : never> = [];
  for (let index = 0; index < array.value.length; index += 1) {
    const item = primitive(makeDestinationAcceptanceCriterion(array.value[index], `${path}[${index}]`));
    if (!item.ok) {
      return item;
    }
    items.push(item.value);
  }
  return ok(items as ReturnType<typeof makeDestinationAcceptanceCriterion> extends Result<infer T, unknown> ? T[] : never);
}

function decodeOptionalDestinationConstraints(
  value: unknown,
  path: string
): Result<ReturnType<typeof makeDestinationConstraint> extends Result<infer T, unknown> ? T[] | undefined : never, DomainWorkflowError> {
  if (value === undefined) {
    return ok(undefined);
  }
  const array = decodeArray(value, path);
  if (!array.ok) {
    return array;
  }
  const items: Array<ReturnType<typeof makeDestinationConstraint> extends Result<infer T, unknown> ? T : never> = [];
  for (let index = 0; index < array.value.length; index += 1) {
    const item = primitive(makeDestinationConstraint(array.value[index], `${path}[${index}]`));
    if (!item.ok) {
      return item;
    }
    items.push(item.value);
  }
  return ok(items as ReturnType<typeof makeDestinationConstraint> extends Result<infer T, unknown> ? T[] : never);
}

export function decodeDestinationPatch(value: unknown, path: string): Result<DestinationPatch, DomainWorkflowError> {
  const record = decodeRecord(value, path);
  if (!record.ok) {
    return record;
  }
  const title = record.value.title === undefined ? ok(undefined) : primitive(makeDestinationTitle(record.value.title, `${path}.title`));
  if (!title.ok) return title;
  const acceptanceCriteria = decodeOptionalDestinationAcceptanceCriteria(record.value.acceptanceCriteria, `${path}.acceptanceCriteria`);
  if (!acceptanceCriteria.ok) return acceptanceCriteria;
  const constraints = decodeOptionalDestinationConstraints(record.value.constraints, `${path}.constraints`);
  if (!constraints.ok) return constraints;
  const priority = decodeOptionalNumber(record.value.priority, `${path}.priority`);
  if (!priority.ok) return priority;
  const notes = record.value.notes === undefined ? ok(undefined) : primitive(makeDestinationNotes(record.value.notes, `${path}.notes`));
  if (!notes.ok) return notes;
  return ok({
    title: title.value,
    acceptanceCriteria: acceptanceCriteria.value,
    constraints: constraints.value,
    priority: priority.value,
    notes: notes.value
  });
}

export function decodeDestinationRecord(value: unknown, path: string): Result<Destination, DomainWorkflowError> {
  const record = decodeRecord(value, path);
  if (!record.ok) {
    return record;
  }
  const seed = decodeDestinationSeed(record.value, path);
  if (!seed.ok) return seed;
  const requestId = primitive(makeRequestId(record.value.requestId));
  if (!requestId.ok) return requestId;
  const source = decodeDestinationSource(record.value.source, `${path}.source`);
  if (!source.ok) return source;
  const createdBy = decodeDomainRole(record.value.createdBy, `${path}.createdBy`);
  if (!createdBy.ok) return createdBy;
  const updatedBy = decodeDomainRole(record.value.updatedBy, `${path}.updatedBy`);
  if (!updatedBy.ok) return updatedBy;
  const status = decodeAllowed(`${path}.status`, record.value.status, DESTINATION_STATUSES);
  if (!status.ok) return status;
  const createdAt = decodeOptionalString(record.value.createdAt, `${path}.createdAt`);
  if (!createdAt.ok) return createdAt;
  const updatedAt = decodeOptionalString(record.value.updatedAt, `${path}.updatedAt`);
  if (!updatedAt.ok) return updatedAt;
  const base: DestinationBase = {
    ...seed.value,
    requestId: requestId.value,
    source: source.value,
    createdBy: createdBy.value,
    updatedBy: updatedBy.value,
    createdAt: createdAt.value,
    updatedAt: updatedAt.value
  };
  switch (status.value) {
    case "pending":
      return rejectDestinationLifecycleFields(record.value, path, ["claimedBy", "reachedByMoveId", "blockedReason", "canceledReason", "supersededByDestinationId"], base);
    case "claimed":
    case "in_progress": {
      const claimedBy = primitive(makeNonEmptyText(record.value.claimedBy, `${path}.claimedBy`));
      if (!claimedBy.ok) return claimedBy;
      const invalid = rejectPresent(record.value, path, ["reachedByMoveId", "blockedReason", "canceledReason", "supersededByDestinationId"]);
      if (!invalid.ok) return invalid;
      return ok({ ...base, status: status.value, claimedBy: claimedBy.value });
    }
    case "reached": {
      const reachedByMoveId = primitive(makeMoveId(record.value.reachedByMoveId));
      if (!reachedByMoveId.ok) return reachedByMoveId;
      const claimedBy = decodeOptionalNonEmptyText(record.value.claimedBy, `${path}.claimedBy`);
      if (!claimedBy.ok) return claimedBy;
      const invalid = rejectPresent(record.value, path, ["blockedReason", "canceledReason", "supersededByDestinationId"]);
      if (!invalid.ok) return invalid;
      return ok({ ...base, status: "reached", reachedByMoveId: reachedByMoveId.value, claimedBy: claimedBy.value });
    }
    case "blocked": {
      const blockedReason = primitive(makeFailureReason(record.value.blockedReason, `${path}.blockedReason`));
      if (!blockedReason.ok) return blockedReason;
      const claimedBy = decodeOptionalNonEmptyText(record.value.claimedBy, `${path}.claimedBy`);
      if (!claimedBy.ok) return claimedBy;
      const invalid = rejectPresent(record.value, path, ["reachedByMoveId", "canceledReason", "supersededByDestinationId"]);
      if (!invalid.ok) return invalid;
      return ok({ ...base, status: "blocked", blockedReason: blockedReason.value, claimedBy: claimedBy.value });
    }
    case "superseded": {
      const supersededByDestinationId = primitive(makeDestinationId(record.value.supersededByDestinationId));
      if (!supersededByDestinationId.ok) return supersededByDestinationId;
      const claimedBy = decodeOptionalNonEmptyText(record.value.claimedBy, `${path}.claimedBy`);
      if (!claimedBy.ok) return claimedBy;
      const invalid = rejectPresent(record.value, path, ["reachedByMoveId", "blockedReason", "canceledReason"]);
      if (!invalid.ok) return invalid;
      return ok({ ...base, status: "superseded", supersededByDestinationId: supersededByDestinationId.value, claimedBy: claimedBy.value });
    }
    case "canceled": {
      const canceledReason = primitive(makeFailureReason(record.value.canceledReason, `${path}.canceledReason`));
      if (!canceledReason.ok) return canceledReason;
      const claimedBy = decodeOptionalNonEmptyText(record.value.claimedBy, `${path}.claimedBy`);
      if (!claimedBy.ok) return claimedBy;
      const invalid = rejectPresent(record.value, path, ["reachedByMoveId", "blockedReason", "supersededByDestinationId"]);
      if (!invalid.ok) return invalid;
      return ok({ ...base, status: "canceled", canceledReason: canceledReason.value, claimedBy: claimedBy.value });
    }
  }
}

export function decodeDestinationRecordArray(value: unknown, path: string): Result<Destination[], DomainWorkflowError> {
  const array = decodeArray(value, path);
  if (!array.ok) {
    return array;
  }
  const destinations: Destination[] = [];
  for (let index = 0; index < array.value.length; index += 1) {
    const destination = decodeDestinationRecord(array.value[index], `${path}[${index}]`);
    if (!destination.ok) {
      return destination;
    }
    destinations.push(destination.value);
  }
  return ok(destinations);
}

export function decodeDestinationIdArray(value: unknown, path: string, requireNonEmpty: boolean): Result<ReturnType<typeof makeDestinationId> extends Result<infer T, unknown> ? T[] : never, DomainWorkflowError> {
  const array = decodeArray(value, path);
  if (!array.ok) {
    return array;
  }
  if (requireNonEmpty) {
    const nonEmpty = primitive(makeNonEmptyArray(array.value, path));
    if (!nonEmpty.ok) return nonEmpty;
  }
  const ids: Array<ReturnType<typeof makeDestinationId> extends Result<infer T, unknown> ? T : never> = [];
  for (let index = 0; index < array.value.length; index += 1) {
    const id = primitive(makeDestinationId(array.value[index]));
    if (!id.ok) return id;
    ids.push(id.value);
  }
  const uniqueIds = rejectDuplicateIds(ids, path, "DestinationId");
  if (!uniqueIds.ok) {
    return uniqueIds;
  }
  return ok(ids as ReturnType<typeof makeDestinationId> extends Result<infer T, unknown> ? T[] : never);
}

export function decodeMoveIdArray(value: unknown, path: string, requireNonEmpty: boolean): Result<ReturnType<typeof makeMoveId> extends Result<infer T, unknown> ? T[] : never, DomainWorkflowError> {
  const array = decodeArray(value, path);
  if (!array.ok) {
    return array;
  }
  if (requireNonEmpty) {
    const nonEmpty = primitive(makeNonEmptyArray(array.value, path));
    if (!nonEmpty.ok) return nonEmpty;
  }
  const ids: Array<ReturnType<typeof makeMoveId> extends Result<infer T, unknown> ? T : never> = [];
  for (let index = 0; index < array.value.length; index += 1) {
    const id = primitive(makeMoveId(array.value[index]));
    if (!id.ok) return id;
    ids.push(id.value);
  }
  const uniqueIds = rejectDuplicateIds(ids, path, "MoveId");
  if (!uniqueIds.ok) {
    return uniqueIds;
  }
  return ok(ids as ReturnType<typeof makeMoveId> extends Result<infer T, unknown> ? T[] : never);
}

export function decodeNodeIdArray(value: unknown, path: string, requireNonEmpty: true): Result<ReturnType<typeof makeNodeId> extends Result<infer T, unknown> ? [T, ...T[]] : never, DomainWorkflowError>;
export function decodeNodeIdArray(value: unknown, path: string, requireNonEmpty: false): Result<ReturnType<typeof makeNodeId> extends Result<infer T, unknown> ? T[] : never, DomainWorkflowError>;
export function decodeNodeIdArray(value: unknown, path: string, requireNonEmpty: boolean): Result<unknown, DomainWorkflowError> {
  const array = decodeArray(value, path);
  if (!array.ok) {
    return array;
  }
  if (requireNonEmpty) {
    const nonEmpty = primitive(makeNonEmptyArray(array.value, path));
    if (!nonEmpty.ok) return nonEmpty;
  }
  const ids: Array<ReturnType<typeof makeNodeId> extends Result<infer T, unknown> ? T : never> = [];
  for (let index = 0; index < array.value.length; index += 1) {
    const id = primitive(makeNodeId(array.value[index]));
    if (!id.ok) return id;
    ids.push(id.value);
  }
  const uniqueIds = rejectDuplicateIds(ids, path, "NodeId");
  if (!uniqueIds.ok) {
    return uniqueIds;
  }
  return requireNonEmpty ? primitive(makeNonEmptyArray(ids, path)) : ok(ids);
}

export function decodeEvidenceArray(value: unknown, path: string, requireNonEmpty: boolean): Result<ReturnType<typeof makeEvidenceText> extends Result<infer T, unknown> ? T[] : never, DomainWorkflowError> {
  const array = decodeArray(value, path);
  if (!array.ok) {
    return array;
  }
  if (requireNonEmpty) {
    const nonEmpty = primitive(makeNonEmptyArray(array.value, path));
    if (!nonEmpty.ok) return nonEmpty;
  }
  const evidence: Array<ReturnType<typeof makeEvidenceText> extends Result<infer T, unknown> ? T : never> = [];
  for (let index = 0; index < array.value.length; index += 1) {
    const item = primitive(makeEvidenceText(array.value[index], `${path}[${index}]`));
    if (!item.ok) return item;
    evidence.push(item.value);
  }
  return ok(evidence as ReturnType<typeof makeEvidenceText> extends Result<infer T, unknown> ? T[] : never);
}

export function decodeRiskArray(value: unknown, path: string): Result<RiskText[], DomainWorkflowError> {
  const array = decodeArray(value, path);
  if (!array.ok) {
    return array;
  }
  const risks: RiskText[] = [];
  for (let index = 0; index < array.value.length; index += 1) {
    const item = primitive(makeRiskText(array.value[index], `${path}[${index}]`));
    if (!item.ok) {
      return item;
    }
    risks.push(item.value);
  }
  return ok(risks);
}

export function decodeOptionalRiskArray(value: unknown, path: string): Result<RiskText[] | undefined, DomainWorkflowError> {
  return value === undefined ? ok(undefined) : decodeRiskArray(value, path);
}

export function decodeHunsuTarget(value: unknown, path: string): Result<HunsuTarget, DomainWorkflowError> {
  const record = decodeRecord(value, path);
  if (!record.ok) {
    return record;
  }
  switch (record.value.type) {
    case "destination": {
      const id = primitive(makeDestinationId(record.value.id));
      return id.ok ? ok({ type: "destination", id: id.value }) : id;
    }
    case "move": {
      const id = primitive(makeMoveId(record.value.id));
      return id.ok ? ok({ type: "move", id: id.value }) : id;
    }
    case "line": {
      const id = primitive(makeLineId(record.value.id));
      return id.ok ? ok({ type: "line", id: id.value }) : id;
    }
    case "node": {
      const id = primitive(makeNodeId(record.value.id));
      return id.ok ? ok({ type: "node", id: id.value }) : id;
    }
    default:
      return workflowError(`${path}.type must be destination, move, line, or node`);
  }
}

export function decodeAgentConversationRef(value: unknown, path: string): Result<AgentConversationRef | undefined, DomainWorkflowError> {
  if (value === undefined) {
    return ok(undefined);
  }
  const record = decodeRecord(value, path);
  if (!record.ok) return record;
  const provider = decodeAllowed(`${path}.provider`, record.value.provider, ["codex", "local"] as const);
  if (!provider.ok) return provider;
  const conversationHash = primitive(makeAgentConversationHash(record.value.conversationHash));
  if (!conversationHash.ok) return conversationHash;
  const threadId = decodeOptionalNonEmptyText(record.value.threadId, `${path}.threadId`);
  if (!threadId.ok) return threadId;
  const contextHash = primitive(makeNonEmptyText(record.value.contextHash, `${path}.contextHash`));
  if (!contextHash.ok) return contextHash;
  const worktreeHash = record.value.worktreeHash === undefined ? ok(undefined) : primitive(makeWorktreeHash(record.value.worktreeHash));
  if (!worktreeHash.ok) return worktreeHash;
  const startedAt = primitive(makeNonEmptyText(record.value.startedAt, `${path}.startedAt`));
  if (!startedAt.ok) return startedAt;
  const endedAt = decodeOptionalNonEmptyText(record.value.endedAt, `${path}.endedAt`);
  if (!endedAt.ok) return endedAt;

  const base = {
    conversationHash: conversationHash.value,
    contextHash: contextHash.value,
    worktreeHash: worktreeHash.value,
    startedAt: startedAt.value
  };
  if (provider.value === "local") {
    if (threadId.value !== undefined) {
      return workflowError(`${path}.threadId is only valid for codex conversations`);
    }
    return endedAt.value === undefined
      ? ok({ provider: "local", ...base })
      : ok({ provider: "local", ...base, endedAt: endedAt.value });
  }
  return endedAt.value === undefined
    ? ok({ provider: "codex", ...base, threadId: threadId.value })
    : ok({ provider: "codex", ...base, threadId: threadId.value, endedAt: endedAt.value });
}

export function decodeWorktreeRef(value: unknown, path: string): Result<WorktreeRef | undefined, DomainWorkflowError> {
  if (value === undefined) {
    return ok(undefined);
  }
  const record = decodeRecord(value, path);
  if (!record.ok) return record;
  const worktreeHash = primitive(makeWorktreeHash(record.value.worktreeHash));
  if (!worktreeHash.ok) return worktreeHash;
  const pathValue = primitive(makeNonEmptyText(record.value.path, `${path}.path`));
  if (!pathValue.ok) return pathValue;
  const branch = primitive(makeNonEmptyText(record.value.branch, `${path}.branch`));
  if (!branch.ok) return branch;
  const baseRef = primitive(makeNonEmptyText(record.value.baseRef, `${path}.baseRef`));
  if (!baseRef.ok) return baseRef;
  const createdAt = primitive(makeNonEmptyText(record.value.createdAt, `${path}.createdAt`));
  if (!createdAt.ok) return createdAt;
  const removedAt = decodeOptionalNonEmptyText(record.value.removedAt, `${path}.removedAt`);
  if (!removedAt.ok) return removedAt;
  const base = {
    worktreeHash: worktreeHash.value,
    path: pathValue.value,
    branch: branch.value,
    baseRef: baseRef.value,
    createdAt: createdAt.value
  };
  return removedAt.value === undefined ? ok(base) : ok({ ...base, removedAt: removedAt.value });
}

export function decodeSkillBinding(value: unknown, path: string): Result<SkillBinding, DomainWorkflowError> {
  const record = decodeRecord(value, path);
  if (!record.ok) return record;
  const kind = decodeAllowed(`${path}.kind`, record.value.kind, ["local-snapshot", "local-root-installed", "registry-package", "skillMeta"] as const);
  if (!kind.ok) return kind;
  const name = primitive(makeNonEmptyText(record.value.name, `${path}.name`));
  if (!name.ok) return name;
  if (kind.value === "skillMeta") {
    const source = primitive(makeNonEmptyText(record.value.source, `${path}.source`));
    if (!source.ok) return source;
    const agent = decodeAllowed(`${path}.agent`, record.value.agent, ["codex"] as const);
    if (!agent.ok) return agent;
    return ok({
      kind: "skillMeta",
      name: name.value,
      source: source.value,
      agent: agent.value
    });
  }
  if (kind.value === "local-root-installed") {
    const sourcePath = decodeOptionalNonEmptyText(record.value.sourcePath, `${path}.sourcePath`);
    if (!sourcePath.ok) return sourcePath;
    return ok({
      kind: "local-root-installed",
      name: name.value,
      sourcePath: sourcePath.value
    });
  }
  if (kind.value === "local-snapshot") {
    const sourcePath = primitive(makeNonEmptyText(record.value.sourcePath, `${path}.sourcePath`));
    if (!sourcePath.ok) return sourcePath;
    const contentHash = primitive(makeNonEmptyText(record.value.contentHash, `${path}.contentHash`));
    if (!contentHash.ok) return contentHash;
    const snapshotRef = primitive(makeNonEmptyText(record.value.snapshotRef, `${path}.snapshotRef`));
    if (!snapshotRef.ok) return snapshotRef;
    const snapshotFiles = record.value.snapshotFiles === undefined ? ok(undefined) : decodeSnapshotFiles(record.value.snapshotFiles, `${path}.snapshotFiles`);
    if (!snapshotFiles.ok) return snapshotFiles;
    return ok({
      kind: "local-snapshot",
      name: name.value,
      sourcePath: sourcePath.value,
      contentHash: contentHash.value,
      snapshotRef: snapshotRef.value,
      snapshotFiles: snapshotFiles.value
    });
  }
  const registryKind = decodeAllowed(`${path}.registryKind`, record.value.registryKind, ["apm"] as const);
  if (!registryKind.ok) return registryKind;
  const registry = primitive(makeNonEmptyText(record.value.registry, `${path}.registry`));
  if (!registry.ok) return registry;
  const packageName = primitive(makeNonEmptyText(record.value.package, `${path}.package`));
  if (!packageName.ok) return packageName;
  const version = primitive(makeNonEmptyText(record.value.version, `${path}.version`));
  if (!version.ok) return version;
  if (!isExactSemver(String(version.value))) {
    return workflowError(`${path}.version must be an exact semver version`);
  }
  const integrity = primitive(makeNonEmptyText(record.value.integrity, `${path}.integrity`));
  if (!integrity.ok) return integrity;
  const contentHash = primitive(makeNonEmptyText(record.value.contentHash, `${path}.contentHash`));
  if (!contentHash.ok) return contentHash;
  if (record.value.snapshotFiles !== undefined) {
    return workflowError(`${path}.snapshotFiles is not supported for registry-package skills`);
  }
  return ok({
    kind: "registry-package",
    registryKind: registryKind.value,
    name: name.value,
    registry: registry.value,
    package: packageName.value,
    version: version.value,
    integrity: integrity.value,
    contentHash: contentHash.value
  });
}

export function decodeMemberPluginBinding(value: unknown, path: string): Result<MemberPluginBinding, DomainWorkflowError> {
  const record = decodeRecord(value, path);
  if (!record.ok) return record;
  const kind = decodeAllowed(`${path}.kind`, record.value.kind, ["local-root-installed"] as const);
  if (!kind.ok) return kind;
  const id = primitive(makeNonEmptyText(record.value.id, `${path}.id`));
  if (!id.ok) return id;
  return ok({
    kind: kind.value,
    id: id.value
  });
}

export function decodeHubPackageLock(value: unknown, path: string, allowedKinds?: HubPackageKind[]): Result<HubPackageLock | undefined, DomainWorkflowError> {
  if (value === undefined) {
    return ok(undefined);
  }
  const record = decodeRecord(value, path);
  if (!record.ok) return record;
  const origin = primitive(makeNonEmptyText(record.value.origin, `${path}.origin`));
  if (!origin.ok) return origin;
  const kind = decodeAllowed(`${path}.kind`, record.value.kind, ["team", "member", "manager", "skill"] as const);
  if (!kind.ok) return kind;
  if (allowedKinds && !allowedKinds.includes(kind.value)) {
    return workflowError(`${path}.kind must be ${allowedKinds.join(" or ")}`);
  }
  const key = primitive(makeNonEmptyText(record.value.key, `${path}.key`));
  if (!key.ok) return key;
  const version = primitive(makeNonEmptyText(record.value.version, `${path}.version`));
  if (!version.ok) return version;
  const integrity = primitive(makeNonEmptyText(record.value.integrity, `${path}.integrity`));
  if (!integrity.ok) return integrity;
  return ok({
    origin: origin.value,
    kind: kind.value,
    key: key.value,
    version: version.value,
    integrity: integrity.value
  });
}

export function decodeExecutorPackageBindings(value: unknown, path: string): Result<ExecutorPackageBinding[], DomainWorkflowError> {
  if (value === undefined) return ok([]);
  const array = decodeArray(value, path);
  if (!array.ok) return array;
  const bindings: ExecutorPackageBinding[] = [];
  for (let index = 0; index < array.value.length; index += 1) {
    const record = decodeRecord(array.value[index], `${path}[${index}]`);
    if (!record.ok) return record;
    const executorId = primitive(makeNonEmptyText(record.value.executorId, `${path}[${index}].executorId`));
    if (!executorId.ok) return executorId;
    const lock = decodeHubPackageLock(record.value.lock, `${path}[${index}].lock`, ["member"]);
    if (!lock.ok) return lock;
    if (!lock.value) return workflowError(`${path}[${index}].lock is required`);
    bindings.push({ executorId: executorId.value, lock: lock.value });
  }
  return ok(bindings);
}

export function decodeResourcePackageBindings(value: unknown, path: string): Result<ResourcePackageBinding[], DomainWorkflowError> {
  if (value === undefined) return ok([]);
  const array = decodeArray(value, path);
  if (!array.ok) return array;
  const bindings: ResourcePackageBinding[] = [];
  for (let index = 0; index < array.value.length; index += 1) {
    const record = decodeRecord(array.value[index], `${path}[${index}]`);
    if (!record.ok) return record;
    const name = primitive(makeNonEmptyText(record.value.name, `${path}[${index}].name`));
    if (!name.ok) return name;
    const lock = decodeHubPackageLock(record.value.lock, `${path}[${index}].lock`, ["skill"]);
    if (!lock.ok) return lock;
    if (!lock.value) return workflowError(`${path}[${index}].lock is required`);
    bindings.push({ name: name.value, lock: lock.value });
  }
  return ok(bindings);
}

export function decodeHunsuOrigin(value: unknown, path: string): Result<HunsuOrigin, DomainWorkflowError> {
  const record = decodeRecord(value, path);
  if (!record.ok) return record;
  const name = primitive(makeNonEmptyText(record.value.name, `${path}.name`));
  if (!name.ok) return name;
  const url = primitive(makeNonEmptyText(record.value.url, `${path}.url`));
  if (!url.ok) return url;
  const transport = decodeAllowed(`${path}.transport`, record.value.transport, ["http", "ssh"] as const);
  if (!transport.ok) return transport;
  const identity = decodeOptionalNonEmptyText(record.value.identity, `${path}.identity`);
  if (!identity.ok) return identity;
  return ok({
    name: name.value,
    url: url.value,
    transport: transport.value,
    identity: identity.value
  });
}

export function decodeArtifactRecord(value: unknown, path: string): Result<ArtifactRecord, DomainWorkflowError> {
  const record = decodeRecord(value, path);
  if (!record.ok) return record;
  const id = primitive(makeArtifactId(record.value.id));
  if (!id.ok) return id;
  const owner = decodeArtifactOwner(record.value.owner, `${path}.owner`);
  if (!owner.ok) return owner;
  const kind = decodeAllowed(`${path}.kind`, record.value.kind, ARTIFACT_KINDS);
  if (!kind.ok) return kind;
  const artifactPath = decodeOptionalNonEmptyText(record.value.path, `${path}.path`);
  if (!artifactPath.ok) return artifactPath;
  const text = decodeOptionalNonEmptyText(record.value.text, `${path}.text`);
  if (!text.ok) return text;
  if (artifactPath.value === undefined && text.value === undefined) {
    return workflowError(`${path} must include path, text, or both`);
  }
  if (artifactPath.value !== undefined && text.value !== undefined) {
    return ok({ id: id.value, owner: owner.value, kind: kind.value, path: artifactPath.value, text: text.value });
  }
  return artifactPath.value !== undefined
    ? ok({ id: id.value, owner: owner.value, kind: kind.value, path: artifactPath.value })
    : ok({ id: id.value, owner: owner.value, kind: kind.value, text: text.value! });
}

export function decodeArtifactActionDefinition(value: unknown, path: string): Result<ArtifactActionDefinition, DomainWorkflowError> {
  const record = decodeRecord(value, path);
  if (!record.ok) return record;
  const id = primitive(makeArtifactActionId(record.value.id));
  if (!id.ok) return id;
  const title = primitive(makeNonEmptyText(record.value.title, `${path}.title`));
  if (!title.ok) return title;
  const kind = decodeAllowed(`${path}.kind`, record.value.kind, ARTIFACT_ACTION_KINDS);
  if (!kind.ok) return kind;
  const sourceScope = decodeAllowed(`${path}.sourceScope`, record.value.sourceScope, ARTIFACT_ACTION_SOURCE_SCOPES);
  if (!sourceScope.ok) return sourceScope;
  const env = decodeArtifactActionEnv(record.value.env, `${path}.env`);
  if (!env.ok) return env;
  const runner = decodeArtifactActionRunner(record.value.runner, `${path}.runner`);
  if (!runner.ok) return runner;
  const aliases = decodeArtifactActionAliases(record.value.aliases, `${path}.aliases`);
  if (!aliases.ok) return aliases;
  const envAliases = validateArtifactActionEnvAliases(env.value, aliases.value, `${path}.env`);
  if (!envAliases.ok) return envAliases;
  const evidence = decodeArtifactActionEvidence(record.value.evidence, `${path}.evidence`);
  if (!evidence.ok) return evidence;
  const displayOrder = decodeNonNegativeInteger(record.value.displayOrder, `${path}.displayOrder`);
  if (!displayOrder.ok) return displayOrder;
  if (kind.value === "check" && runner.value.type !== "command") {
    return workflowError(`${path}.runner.type must be command for check actions`);
  }
  return ok({
    id: id.value,
    title: title.value,
    kind: kind.value,
    sourceScope: sourceScope.value,
    env: env.value,
    runner: runner.value,
    aliases: aliases.value,
    evidence: evidence.value,
    displayOrder: displayOrder.value
  });
}

export function decodeArtifactActionPatch(value: unknown, path: string): Result<ArtifactActionPatch, DomainWorkflowError> {
  const record = decodeRecord(value, path);
  if (!record.ok) return record;
  const patch: ArtifactActionPatch = {};
  if ("title" in record.value) {
    const title = primitive(makeNonEmptyText(record.value.title, `${path}.title`));
    if (!title.ok) return title;
    patch.title = title.value;
  }
  if ("kind" in record.value) {
    const kind = decodeAllowed(`${path}.kind`, record.value.kind, ARTIFACT_ACTION_KINDS);
    if (!kind.ok) return kind;
    patch.kind = kind.value;
  }
  if ("sourceScope" in record.value) {
    const sourceScope = decodeAllowed(`${path}.sourceScope`, record.value.sourceScope, ARTIFACT_ACTION_SOURCE_SCOPES);
    if (!sourceScope.ok) return sourceScope;
    patch.sourceScope = sourceScope.value;
  }
  if ("env" in record.value) {
    const env = decodeArtifactActionEnv(record.value.env, `${path}.env`);
    if (!env.ok) return env;
    patch.env = env.value;
  }
  if ("runner" in record.value) {
    const runner = decodeArtifactActionRunner(record.value.runner, `${path}.runner`);
    if (!runner.ok) return runner;
    patch.runner = runner.value;
  }
  if ("aliases" in record.value) {
    const aliases = decodeArtifactActionAliases(record.value.aliases, `${path}.aliases`);
    if (!aliases.ok) return aliases;
    patch.aliases = aliases.value;
  }
  if ("evidence" in record.value) {
    const evidence = decodeArtifactActionEvidence(record.value.evidence, `${path}.evidence`);
    if (!evidence.ok) return evidence;
    patch.evidence = evidence.value;
  }
  if ("displayOrder" in record.value) {
    const displayOrder = decodeNonNegativeInteger(record.value.displayOrder, `${path}.displayOrder`);
    if (!displayOrder.ok) return displayOrder;
    patch.displayOrder = displayOrder.value;
  }
  if (patch.kind === "check" && patch.runner && patch.runner.type !== "command") {
    return workflowError(`${path}.runner.type must be command for check actions`);
  }
  return ok(patch);
}

function validateArtifactActionEnvAliases(
  env: Record<string, ArtifactActionEnvValue> | undefined,
  aliases: ArtifactActionDefinition["aliases"],
  path: string
): Result<void, DomainWorkflowError> {
  const aliasNames = new Set(Object.keys(aliases ?? {}));
  for (const [name, spec] of Object.entries(env ?? {})) {
    if ("alias" in spec && !aliasNames.has(String(spec.alias))) {
      return workflowError(`${path}.${name}.alias references unknown alias: ${spec.alias}`);
    }
    if ("fromAliasUrl" in spec && !aliasNames.has(String(spec.fromAliasUrl))) {
      return workflowError(`${path}.${name}.fromAliasUrl references unknown alias: ${spec.fromAliasUrl}`);
    }
  }
  return ok(undefined);
}

export function decodeLineRecord(value: unknown, path: string): Result<LineRecord, DomainWorkflowError> {
  const record = decodeRecord(value, path);
  if (!record.ok) return record;
  const id = primitive(makeLineId(record.value.id));
  if (!id.ok) return id;
  const requestId = primitive(makeRequestId(record.value.requestId));
  if (!requestId.ok) return requestId;
  const teamName = record.value.teamName === undefined
    ? ok(undefined)
    : primitive(makeTeamName(record.value.teamName, `${path}.teamName`));
  if (!teamName.ok) return teamName;
  const status = decodeAllowed(`${path}.status`, record.value.status, LINE_STATUSES);
  if (!status.ok) return status;
  const moveIds = decodeMoveIdArray(record.value.moveIds, `${path}.moveIds`, false);
  if (!moveIds.ok) return moveIds;
  const rootNodeId = primitive(makeNodeId(record.value.rootNodeId));
  if (!rootNodeId.ok) return rootNodeId;
  const currentNodeId = primitive(makeNodeId(record.value.currentNodeId));
  if (!currentNodeId.ok) return currentNodeId;
  const nodeIds = decodeNodeIdArray(record.value.nodeIds, `${path}.nodeIds`, true);
  if (!nodeIds.ok) return nodeIds;
  const parentLineId = decodeOptionalLineId(record.value.parentLineId);
  if (!parentLineId.ok) return parentLineId;
  const forkedFromMoveId = decodeOptionalMoveId(record.value.forkedFromMoveId);
  if (!forkedFromMoveId.ok) return forkedFromMoveId;
  if (forkedFromMoveId.value !== undefined && parentLineId.value === undefined) {
    return workflowError(`${path}.parentLineId is required when forkedFromMoveId is present`);
  }
  const route = {
    id: id.value,
    requestId: requestId.value,
    teamName: teamName.value,
    moveIds: moveIds.value,
    rootNodeId: rootNodeId.value,
    currentNodeId: currentNodeId.value,
    nodeIds: nodeIds.value
  };
  if (parentLineId.value !== undefined) {
    const forkedBase: ForkedLineRecordBase = { ...route, parentLineId: parentLineId.value, forkedFromMoveId: forkedFromMoveId.value };
    return lineWithStatus(forkedBase, status.value);
  }
  const rootBase: RootLineRecordBase = route;
  return lineWithStatus(rootBase, status.value);
}

export function decodeSkillDraftRecord(value: unknown, path: string): Result<SkillDraftRecord, DomainWorkflowError> {
  const record = decodeRecord(value, path);
  if (!record.ok) return record;
  const id = primitive(makeSkillDraftId(record.value.id));
  if (!id.ok) return id;
  const name = primitive(makeNonEmptyText(record.value.name, `${path}.name`));
  if (!name.ok) return name;
  const sourcePath = decodeOptionalNonEmptyText(record.value.sourcePath, `${path}.sourcePath`);
  if (!sourcePath.ok) return sourcePath;
  const draftPath = primitive(makeNonEmptyText(record.value.draftPath, `${path}.draftPath`));
  if (!draftPath.ok) return draftPath;
  const createdFromNodeId = decodeOptionalNodeId(record.value.createdFromNodeId);
  if (!createdFromNodeId.ok) return createdFromNodeId;
  const createdAt = decodeOptionalString(record.value.createdAt, `${path}.createdAt`);
  if (!createdAt.ok) return createdAt;
  const status = decodeAllowed(`${path}.status`, record.value.status, SKILL_DRAFT_STATUSES);
  if (!status.ok) return status;
  const base = {
    id: id.value,
    name: name.value,
    sourcePath: sourcePath.value,
    draftPath: draftPath.value,
    createdFromNodeId: createdFromNodeId.value,
    createdAt: createdAt.value
  };
  switch (status.value) {
    case "accepted": {
      const acceptedSnapshot = decodeSkillBinding(record.value.acceptedSnapshot, `${path}.acceptedSnapshot`);
      return acceptedSnapshot.ok ? ok({ ...base, status: "accepted", acceptedSnapshot: acceptedSnapshot.value }) : acceptedSnapshot;
    }
    case "draft":
      if (record.value.acceptedSnapshot !== undefined) {
        return workflowError(`${path}.acceptedSnapshot is only valid for accepted Skill Drafts`);
      }
      return ok({ ...base, status: "draft" });
    case "discarded":
      if (record.value.acceptedSnapshot !== undefined) {
        return workflowError(`${path}.acceptedSnapshot is only valid for accepted Skill Drafts`);
      }
      return ok({ ...base, status: "discarded" });
  }
}

export function decodeHunsuDraftRecord(value: unknown, path: string, decodeHarness: HarnessDecoder): Result<HunsuDraftRecord, DomainWorkflowError> {
  const record = decodeRecord(value, path);
  if (!record.ok) return record;
  const id = primitive(makeHunsuDraftId(record.value.id));
  if (!id.ok) return id;
  const sourceLineId = primitive(makeLineId(record.value.sourceLineId));
  if (!sourceLineId.ok) return sourceLineId;
  const sourceNodeId = primitive(makeNodeId(record.value.sourceNodeId));
  if (!sourceNodeId.ok) return sourceNodeId;
  const sourceMoveId = decodeOptionalMoveId(record.value.sourceMoveId);
  if (!sourceMoveId.ok) return sourceMoveId;
  const target = decodeHunsuTarget(record.value.target, `${path}.target`);
  if (!target.ok) return target;
  const newTeamName = primitive(makeTeamName(record.value.newTeamName, `${path}.newTeamName`));
  if (!newTeamName.ok) return newTeamName;
  const summary = primitive(makeSummary(record.value.summary, `${path}.summary`));
  if (!summary.ok) return summary;
  const teamSnapshot = decodeTeamSnapshot(record.value.teamSnapshot, `${path}.teamSnapshot`, decodeHarness);
  if (!teamSnapshot.ok) return teamSnapshot;
  const changedFiles = decodeHunsuChangedFileArray(record.value.changedFiles, `${path}.changedFiles`);
  if (!changedFiles.ok) return changedFiles;
  const createdAt = decodeOptionalString(record.value.createdAt, `${path}.createdAt`);
  if (!createdAt.ok) return createdAt;
  const updatedAt = decodeOptionalString(record.value.updatedAt, `${path}.updatedAt`);
  if (!updatedAt.ok) return updatedAt;
  const status = decodeAllowed(`${path}.status`, record.value.status, HUNSU_DRAFT_STATUSES);
  if (!status.ok) return status;
  const base = {
    id: id.value,
    sourceLineId: sourceLineId.value,
    sourceNodeId: sourceNodeId.value,
    sourceMoveId: sourceMoveId.value,
    target: target.value,
    newTeamName: newTeamName.value,
    summary: summary.value,
    teamSnapshot: teamSnapshot.value,
    changedFiles: changedFiles.value,
    createdAt: createdAt.value,
    updatedAt: updatedAt.value
  };
  switch (status.value) {
    case "ready": {
      const hunsuId = primitive(makeHunsuId(record.value.hunsuId));
      if (!hunsuId.ok) return hunsuId;
      const newLineId = primitive(makeLineId(record.value.newLineId));
      if (!newLineId.ok) return newLineId;
      if (record.value.conversationRef === undefined) {
        return workflowError(`${path}.conversationRef is required for ready HUNSU Drafts`);
      }
      const conversationRef = decodeAgentConversationRef(record.value.conversationRef, `${path}.conversationRef`);
      if (!conversationRef.ok) return conversationRef;
      if (!conversationRef.value) {
        return workflowError(`${path}.conversationRef is required for ready HUNSU Drafts`);
      }
      return ok({ ...base, status: "ready", hunsuId: hunsuId.value, newLineId: newLineId.value, conversationRef: conversationRef.value });
    }
    case "confirmed": {
      const hunsuId = primitive(makeHunsuId(record.value.hunsuId));
      if (!hunsuId.ok) return hunsuId;
      const newLineId = primitive(makeLineId(record.value.newLineId));
      if (!newLineId.ok) return newLineId;
      if (record.value.conversationRef === undefined) {
        return workflowError(`${path}.conversationRef is required for confirmed HUNSU Drafts`);
      }
      const conversationRef = decodeAgentConversationRef(record.value.conversationRef, `${path}.conversationRef`);
      if (!conversationRef.ok) return conversationRef;
      if (!conversationRef.value) {
        return workflowError(`${path}.conversationRef is required for confirmed HUNSU Drafts`);
      }
      return ok({ ...base, status: "confirmed", hunsuId: hunsuId.value, newLineId: newLineId.value, conversationRef: conversationRef.value });
    }
    case "draft":
      if (record.value.hunsuId !== undefined || record.value.newLineId !== undefined || record.value.conversationRef !== undefined) {
        return workflowError(`${path} draft status cannot carry hunsuId, newLineId, or conversationRef`);
      }
      return ok({ ...base, status: "draft" });
    case "discarded":
      if (record.value.hunsuId !== undefined || record.value.newLineId !== undefined) {
        return workflowError(`${path} discarded status cannot carry hunsuId or newLineId`);
      }
      if (record.value.conversationRef === undefined) {
        return ok({ ...base, status: "discarded" });
      }
      const conversationRef = decodeAgentConversationRef(record.value.conversationRef, `${path}.conversationRef`);
      return conversationRef.ok ? ok({ ...base, status: "discarded", conversationRef: conversationRef.value }) : conversationRef;
  }
}

export function decodeMoveRecord(value: unknown, path: string, decodeHarness: HarnessDecoder): Result<MoveRecord, DomainWorkflowError> {
  const record = decodeRecord(value, path);
  if (!record.ok) return record;
  const id = primitive(makeMoveId(record.value.id));
  if (!id.ok) return id;
  const lineId = primitive(makeLineId(record.value.lineId));
  if (!lineId.ok) return lineId;
  const fromNodeId = primitive(makeNodeId(record.value.fromNodeId));
  if (!fromNodeId.ok) return fromNodeId;
  const toNodeId = primitive(makeNodeId(record.value.toNodeId));
  if (!toNodeId.ok) return toNodeId;
  const teamName = record.value.teamName === undefined
    ? ok(undefined)
    : primitive(makeTeamName(record.value.teamName, `${path}.teamName`));
  if (!teamName.ok) return teamName;
  const ordinal = record.value.ordinal === undefined ? ok(undefined) : decodeNonNegativeInteger(record.value.ordinal, `${path}.ordinal`);
  if (!ordinal.ok) return ordinal;
  const snapshot = record.value.snapshot === undefined ? ok(undefined) : decodeTeamSnapshot(record.value.snapshot, `${path}.snapshot`, decodeHarness);
  if (!snapshot.ok) return snapshot;
  const sourceHunsuId = decodeOptionalHunsuId(record.value.sourceHunsuId);
  if (!sourceHunsuId.ok) return sourceHunsuId;
  const executeId = decodeOptionalExecuteId(record.value.executeId);
  if (!executeId.ok) return executeId;
  const conversationRef = decodeAgentConversationRef(record.value.conversationRef, `${path}.conversationRef`);
  if (!conversationRef.ok) return conversationRef;
  const worktree = decodeWorktreeRef(record.value.worktree, `${path}.worktree`);
  if (!worktree.ok) return worktree;
  const summary = primitive(makeSummary(record.value.summary, `${path}.summary`));
  if (!summary.ok) return summary;
  const commit = primitive(makeMoveCommit(record.value.commit, `${path}.commit`));
  if (!commit.ok) return commit;
  const evidence = decodeEvidenceArray(record.value.evidence, `${path}.evidence`, true);
  if (!evidence.ok) return evidence;
  const risks = decodeOptionalRiskArray(record.value.risks, `${path}.risks`);
  if (!risks.ok) return risks;
  const recordedBy = decodeAllowed(`${path}.recordedBy`, record.value.recordedBy, ["SYSTEM"] as const);
  if (!recordedBy.ok) return recordedBy;
  const recordedAt = decodeOptionalString(record.value.recordedAt, `${path}.recordedAt`);
  if (!recordedAt.ok) return recordedAt;
  const outcome = decodeAllowed(`${path}.outcome`, record.value.outcome, MOVE_OUTCOMES);
  if (!outcome.ok) return outcome;
  const base = {
    id: id.value,
    lineId: lineId.value,
    fromNodeId: fromNodeId.value,
    toNodeId: toNodeId.value,
    teamName: teamName.value,
    ordinal: ordinal.value,
    snapshot: snapshot.value,
    sourceHunsuId: sourceHunsuId.value,
    executeId: executeId.value,
    conversationRef: conversationRef.value,
    worktree: worktree.value,
    summary: summary.value,
    commit: commit.value,
    evidence: evidence.value,
    risks: risks.value,
    recordedBy: recordedBy.value,
    recordedAt: recordedAt.value
  };
  if (outcome.value === "arrived") {
    const reachedDestinationIds = decodeDestinationIdArray(record.value.reachedDestinationIds, `${path}.reachedDestinationIds`, true);
    if (!reachedDestinationIds.ok) return reachedDestinationIds;
    const single = primitive(makeSingleItemArray(reachedDestinationIds.value, `${path}.reachedDestinationIds`));
    if (!single.ok) return single;
    if (record.value.failureReason !== undefined) {
      return workflowError(`${path}.failureReason is only valid for accident MOVEs`);
    }
    return ok({ ...base, outcome: "arrived", reachedDestinationIds: single.value });
  }
  const reachedDestinationIds = decodeDestinationIdArray(record.value.reachedDestinationIds, `${path}.reachedDestinationIds`, false);
  if (!reachedDestinationIds.ok) return reachedDestinationIds;
  if (reachedDestinationIds.value.length !== 0) {
    return workflowError(`${path}.reachedDestinationIds must be empty for accident MOVEs`);
  }
  const failureReason = primitive(makeFailureReason(record.value.failureReason, `${path}.failureReason`));
  return failureReason.ok ? ok({ ...base, outcome: "accident", reachedDestinationIds: [], failureReason: failureReason.value }) : failureReason;
}

export function decodeHunsuRecord(value: unknown, path: string, decodeHarness: HarnessDecoder): Result<HunsuRecord, DomainWorkflowError> {
  const record = decodeRecord(value, path);
  if (!record.ok) return record;
  const id = primitive(makeHunsuId(record.value.id));
  if (!id.ok) return id;
  const hunsuDraftId = decodeOptionalHunsuDraftId(record.value.hunsuDraftId);
  if (!hunsuDraftId.ok) return hunsuDraftId;
  const conversationRef = decodeAgentConversationRef(record.value.conversationRef, `${path}.conversationRef`);
  if (!conversationRef.ok) return conversationRef;
  const lineId = primitive(makeLineId(record.value.lineId));
  if (!lineId.ok) return lineId;
  const fromNodeId = primitive(makeNodeId(record.value.fromNodeId));
  if (!fromNodeId.ok) return fromNodeId;
  const toNodeId = primitive(makeNodeId(record.value.toNodeId));
  if (!toNodeId.ok) return toNodeId;
  const target = decodeHunsuTarget(record.value.target, `${path}.target`);
  if (!target.ok) return target;
  const summary = primitive(makeSummary(record.value.summary, `${path}.summary`));
  if (!summary.ok) return summary;
  const newLineId = record.value.newLineId === undefined
    ? ok(undefined)
    : primitive(makeLineId(record.value.newLineId));
  if (!newLineId.ok) return newLineId;
  const sourceMoveId = decodeOptionalMoveId(record.value.sourceMoveId);
  if (!sourceMoveId.ok) return sourceMoveId;
  const newTeamName = record.value.newTeamName === undefined
    ? ok(undefined)
    : primitive(makeTeamName(record.value.newTeamName, `${path}.newTeamName`));
  if (!newTeamName.ok) return newTeamName;
  const teamSnapshot = decodeTeamSnapshot(record.value.teamSnapshot, `${path}.teamSnapshot`, decodeHarness);
  if (!teamSnapshot.ok) return teamSnapshot;
  const changedFiles = decodeHunsuChangedFileArray(record.value.changedFiles, `${path}.changedFiles`);
  if (!changedFiles.ok) return changedFiles;
  const recordedBy = decodeAllowed(`${path}.recordedBy`, record.value.recordedBy, ["DIRECTOR"] as const);
  if (!recordedBy.ok) return recordedBy;
  const recordedAt = decodeOptionalString(record.value.recordedAt, `${path}.recordedAt`);
  if (!recordedAt.ok) return recordedAt;
  return ok({
    id: id.value,
    hunsuDraftId: hunsuDraftId.value,
    conversationRef: conversationRef.value,
    lineId: lineId.value,
    fromNodeId: fromNodeId.value,
    toNodeId: toNodeId.value,
    target: target.value,
    summary: summary.value,
    newLineId: newLineId.value,
    sourceMoveId: sourceMoveId.value,
    newTeamName: newTeamName.value,
    teamSnapshot: teamSnapshot.value,
    changedFiles: changedFiles.value,
    recordedBy: recordedBy.value,
    recordedAt: recordedAt.value
  });
}

function decodeHunsuChangedFileArray(value: unknown, path: string): Result<HunsuRecord["changedFiles"], DomainWorkflowError> {
  const array = decodeArray(value, path);
  if (!array.ok) return array;
  if (array.value.length === 0) {
    return workflowError(`${path} must contain at least one changed file`);
  }
  const files: HunsuRecord["changedFiles"] = [];
  for (let index = 0; index < array.value.length; index += 1) {
    const file = decodeHunsuChangedFile(array.value[index], `${path}[${index}]`);
    if (!file.ok) return file;
    files.push(file.value);
  }
  return ok(files);
}

function decodeHunsuChangedFile(value: unknown, path: string): Result<HunsuRecord["changedFiles"][number], DomainWorkflowError> {
  const record = decodeRecord(value, path);
  if (!record.ok) return record;
  const filePath = primitive(makeNonEmptyText(record.value.path, `${path}.path`));
  if (!filePath.ok) return filePath;
  const kind = decodeAllowed(`${path}.kind`, record.value.kind, ["added", "updated", "removed"] as const);
  if (!kind.ok) return kind;
  const summary = primitive(makeSummary(record.value.summary, `${path}.summary`));
  return summary.ok ? ok({ path: filePath.value, kind: kind.value, summary: summary.value }) : summary;
}

export function decodeNodeRecord(value: unknown, path: string, decodeHarness: HarnessDecoder): Result<NodeRecord, DomainWorkflowError> {
  const record = decodeRecord(value, path);
  if (!record.ok) return record;
  const id = primitive(makeNodeId(record.value.id));
  if (!id.ok) return id;
  const requestId = primitive(makeRequestId(record.value.requestId));
  if (!requestId.ok) return requestId;
  const lineId = decodeOptionalLineId(record.value.lineId);
  if (!lineId.ok) return lineId;
  const teamName = record.value.teamName === undefined
    ? ok(undefined)
    : primitive(makeTeamName(record.value.teamName, `${path}.teamName`));
  if (!teamName.ok) return teamName;
  const ordinal = decodeNonNegativeInteger(record.value.ordinal, `${path}.ordinal`);
  if (!ordinal.ok) return ordinal;
  const destinations = decodeDestinationRecordArray(record.value.destinations, `${path}.destinations`);
  if (!destinations.ok) return destinations;
  const harness = decodeHarness(record.value.harness);
  if (!harness.ok) return harness;
  const harnessGraph = decodeHarnessGraph(record.value.harnessGraph, harness.value, `${path}.harnessGraph`);
  if (!harnessGraph.ok) return harnessGraph;
  const harnessLock = decodeHubPackageLock(record.value.harnessLock, `${path}.harnessLock`, ["team"]);
  if (!harnessLock.ok) return harnessLock;
  const executorPackageBindings = decodeExecutorPackageBindings(record.value.executorPackageBindings, `${path}.executorPackageBindings`);
  if (!executorPackageBindings.ok) return executorPackageBindings;
  const resourcePackageBindings = decodeResourcePackageBindings(record.value.resourcePackageBindings, `${path}.resourcePackageBindings`);
  if (!resourcePackageBindings.ok) return resourcePackageBindings;
  const artifactActions = decodeArtifactActionDefinitionArray(record.value.artifactActions ?? [], `${path}.artifactActions`);
  if (!artifactActions.ok) return artifactActions;
  const source = decodeNodeSource(record.value.source, `${path}.source`);
  if (!source.ok) return source;
  const createdAt = decodeOptionalString(record.value.createdAt, `${path}.createdAt`);
  if (!createdAt.ok) return createdAt;
  return ok({
    id: id.value,
    requestId: requestId.value,
    lineId: lineId.value,
    teamName: teamName.value,
    ordinal: ordinal.value,
    destinations: destinations.value,
    harness: harness.value,
    harnessGraph: harnessGraph.value,
    harnessLock: harnessLock.value,
    executorPackageBindings: executorPackageBindings.value,
    resourcePackageBindings: resourcePackageBindings.value,
    artifactActions: artifactActions.value,
    source: source.value,
    createdAt: createdAt.value
  });
}

export function decodeOptionalHunsuDraftId(value: unknown): Result<ReturnType<typeof makeHunsuDraftId> extends Result<infer T, unknown> ? T | undefined : never, DomainWorkflowError> {
  return value === undefined ? ok(undefined as ReturnType<typeof makeHunsuDraftId> extends Result<infer T, unknown> ? T | undefined : never) : primitive(makeHunsuDraftId(value));
}

export function decodeOptionalHunsuId(value: unknown): Result<ReturnType<typeof makeHunsuId> extends Result<infer T, unknown> ? T | undefined : never, DomainWorkflowError> {
  return value === undefined ? ok(undefined as ReturnType<typeof makeHunsuId> extends Result<infer T, unknown> ? T | undefined : never) : primitive(makeHunsuId(value));
}

export function decodeOptionalMoveId(value: unknown): Result<ReturnType<typeof makeMoveId> extends Result<infer T, unknown> ? T | undefined : never, DomainWorkflowError> {
  return value === undefined ? ok(undefined as ReturnType<typeof makeMoveId> extends Result<infer T, unknown> ? T | undefined : never) : primitive(makeMoveId(value));
}

export function decodeArtifactActionIdArray(value: unknown, path: string): Result<Array<ReturnType<typeof makeArtifactActionId> extends Result<infer T, unknown> ? T : never>, DomainWorkflowError> {
  const array = decodeArray(value, path);
  if (!array.ok) return array as Result<never, DomainWorkflowError>;
  const ids: Array<ReturnType<typeof makeArtifactActionId> extends Result<infer T, unknown> ? T : never> = [];
  for (let index = 0; index < array.value.length; index += 1) {
    const id = primitive(makeArtifactActionId(array.value[index]));
    if (!id.ok) return id as Result<never, DomainWorkflowError>;
    ids.push(id.value as ReturnType<typeof makeArtifactActionId> extends Result<infer T, unknown> ? T : never);
  }
  return ok(ids);
}

export function decodeOptionalLineId(value: unknown): Result<ReturnType<typeof makeLineId> extends Result<infer T, unknown> ? T | undefined : never, DomainWorkflowError> {
  return value === undefined ? ok(undefined as ReturnType<typeof makeLineId> extends Result<infer T, unknown> ? T | undefined : never) : primitive(makeLineId(value));
}

export function decodeOptionalNodeId(value: unknown): Result<ReturnType<typeof makeNodeId> extends Result<infer T, unknown> ? T | undefined : never, DomainWorkflowError> {
  return value === undefined ? ok(undefined as ReturnType<typeof makeNodeId> extends Result<infer T, unknown> ? T | undefined : never) : primitive(makeNodeId(value));
}

export function decodeOptionalExecuteId(value: unknown): Result<ReturnType<typeof makeExecuteId> extends Result<infer T, unknown> ? T | undefined : never, DomainWorkflowError> {
  return value === undefined ? ok(undefined as ReturnType<typeof makeExecuteId> extends Result<infer T, unknown> ? T | undefined : never) : primitive(makeExecuteId(value));
}

function decodeTeamSnapshot(value: unknown, path: string, decodeHarness: HarnessDecoder): Result<TeamSnapshot, DomainWorkflowError> {
  const record = decodeRecord(value, path);
  if (!record.ok) return record;
  const teamName = primitive(makeTeamName(record.value.teamName, `${path}.teamName`));
  if (!teamName.ok) return teamName;
  const moveOrdinal = decodeNonNegativeInteger(record.value.moveOrdinal, `${path}.moveOrdinal`);
  if (!moveOrdinal.ok) return moveOrdinal;
  const destinations = decodeDestinationRecordArray(record.value.destinations, `${path}.destinations`);
  if (!destinations.ok) return destinations;
  const harness = decodeHarness(record.value.harness);
  if (!harness.ok) return harness;
  const harnessGraph = decodeHarnessGraph(record.value.harnessGraph, harness.value, `${path}.harnessGraph`);
  if (!harnessGraph.ok) return harnessGraph;
  const harnessLock = decodeHubPackageLock(record.value.harnessLock, `${path}.harnessLock`, ["team"]);
  if (!harnessLock.ok) return harnessLock;
  const executorPackageBindings = decodeExecutorPackageBindings(record.value.executorPackageBindings, `${path}.executorPackageBindings`);
  if (!executorPackageBindings.ok) return executorPackageBindings;
  const resourcePackageBindings = decodeResourcePackageBindings(record.value.resourcePackageBindings, `${path}.resourcePackageBindings`);
  if (!resourcePackageBindings.ok) return resourcePackageBindings;
  const artifactActions = decodeArtifactActionDefinitionArray(record.value.artifactActions ?? [], `${path}.artifactActions`);
  if (!artifactActions.ok) return artifactActions;
  return ok({
    teamName: teamName.value,
    moveOrdinal: moveOrdinal.value,
    destinations: destinations.value,
    harness: harness.value,
    harnessGraph: harnessGraph.value,
    harnessLock: harnessLock.value,
    executorPackageBindings: executorPackageBindings.value,
    resourcePackageBindings: resourcePackageBindings.value,
    artifactActions: artifactActions.value
  });
}

function decodeHarnessGraph(value: unknown, fallbackHarness: HarnessSnapshot, path: string): Result<Harness, DomainWorkflowError> {
  if (value === undefined) {
    return ok(harnessEntityFromSnapshot(fallbackHarness));
  }
  return validateHarnessEntity(value, path);
}

export function decodeArtifactActionDefinitionArray(value: unknown, path: string): Result<ArtifactActionDefinition[], DomainWorkflowError> {
  const array = decodeArray(value, path);
  if (!array.ok) return array;
  const actions: ArtifactActionDefinition[] = [];
  for (let index = 0; index < array.value.length; index += 1) {
    const action = decodeArtifactActionDefinition(array.value[index], `${path}[${index}]`);
    if (!action.ok) return action;
    if (actions.some(existing => existing.id === action.value.id)) {
      return workflowError(`${path} contains duplicate ArtifactActionId: ${action.value.id}`);
    }
    actions.push(action.value);
  }
  return ok(actions);
}

function decodeSnapshotFiles(value: unknown, path: string): Result<SkillSnapshotFile[], DomainWorkflowError> {
  const array = decodeArray(value, path);
  if (!array.ok) return array;
  const files: SkillSnapshotFile[] = [];
  for (let index = 0; index < array.value.length; index += 1) {
    const record = decodeRecord(array.value[index], `${path}[${index}]`);
    if (!record.ok) return record;
    const filePath = primitive(makeNonEmptyText(record.value.path, `${path}[${index}].path`));
    if (!filePath.ok) return filePath;
    const text = record.value.text;
    if (typeof text !== "string") {
      return workflowError(`${path}[${index}].text must be a string`);
    }
    files.push({ path: filePath.value, text });
  }
  return ok(files);
}

function isExactSemver(value: string): boolean {
  return /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value);
}

function decodeArtifactOwner(value: unknown, path: string): Result<ArtifactRecord["owner"], DomainWorkflowError> {
  const record = decodeRecord(value, path);
  if (!record.ok) return record;
  switch (record.value.type) {
    case "move": {
      const id = primitive(makeMoveId(record.value.id));
      return id.ok ? ok({ type: "move", id: id.value }) : id;
    }
    case "hunsu": {
      const id = primitive(makeHunsuId(record.value.id));
      return id.ok ? ok({ type: "hunsu", id: id.value }) : id;
    }
    case "line": {
      const id = primitive(makeLineId(record.value.id));
      return id.ok ? ok({ type: "line", id: id.value }) : id;
    }
    default:
      return workflowError(`${path}.type must be move, hunsu, or line`);
  }
}

function decodeArtifactActionEnv(value: unknown, path: string): Result<Record<string, ArtifactActionEnvValue> | undefined, DomainWorkflowError> {
  if (value === undefined) {
    return ok(undefined);
  }
  const record = decodeRecord(value, path);
  if (!record.ok) return record;
  const env: Record<string, ArtifactActionEnvValue> = {};
  for (const [name, raw] of Object.entries(record.value)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      return workflowError(`${path}.${name} must be a valid environment variable name`);
    }
    const spec = decodeRecord(raw, `${path}.${name}`);
    if (!spec.ok) return spec;
    const keys = ["default", "value", "required", "alias", "fromAliasUrl"].filter(key => key in spec.value);
    if (keys.length !== 1) {
      return workflowError(`${path}.${name} must declare exactly one of default, value, required, alias, or fromAliasUrl`);
    }
    if ("default" in spec.value) {
      const scalar = decodeScalar(spec.value.default, `${path}.${name}.default`);
      if (!scalar.ok) return scalar;
      env[name] = { default: scalar.value };
    } else if ("value" in spec.value) {
      const scalar = decodeScalar(spec.value.value, `${path}.${name}.value`);
      if (!scalar.ok) return scalar;
      env[name] = { value: scalar.value };
    } else if ("alias" in spec.value) {
      const alias = primitive(makeNonEmptyText(spec.value.alias, `${path}.${name}.alias`));
      if (!alias.ok) return alias;
      env[name] = { alias: alias.value };
    } else if ("fromAliasUrl" in spec.value) {
      const alias = primitive(makeNonEmptyText(spec.value.fromAliasUrl, `${path}.${name}.fromAliasUrl`));
      if (!alias.ok) return alias;
      env[name] = { fromAliasUrl: alias.value };
    } else {
      if (spec.value.required !== true) {
        return workflowError(`${path}.${name}.required must be true`);
      }
      const secret = decodeOptionalBoolean(spec.value.secret, `${path}.${name}.secret`);
      if (!secret.ok) return secret;
      env[name] = { required: true, secret: secret.value };
    }
  }
  return ok(env);
}

function decodeArtifactActionRunner(value: unknown, path: string): Result<ArtifactActionDefinition["runner"], DomainWorkflowError> {
  const record = decodeRecord(value, path);
  if (!record.ok) return record;
  switch (record.value.type) {
    case "docker_compose": {
      const file = primitive(makeNonEmptyText(record.value.file, `${path}.file`));
      if (!file.ok) return file;
      const projectName = decodeOptionalNonEmptyText(record.value.projectName, `${path}.projectName`);
      return projectName.ok ? ok({ type: "docker_compose", file: file.value, projectName: projectName.value }) : projectName;
    }
    case "command": {
      const command = primitive(makeNonEmptyText(record.value.command, `${path}.command`));
      if (!command.ok) return command;
      const stopCommand = decodeOptionalNonEmptyText(record.value.stopCommand, `${path}.stopCommand`);
      return stopCommand.ok ? ok({ type: "command", command: command.value, stopCommand: stopCommand.value }) : stopCommand;
    }
    default:
      return workflowError(`${path}.type must be docker_compose or command`);
  }
}

function decodeArtifactActionAliases(value: unknown, path: string): Result<ArtifactActionDefinition["aliases"], DomainWorkflowError> {
  if (value === undefined) {
    return ok(undefined);
  }
  const record = decodeRecord(value, path);
  if (!record.ok) return record;
  const aliases: NonNullable<ArtifactActionDefinition["aliases"]> = {};
  for (const [alias, raw] of Object.entries(record.value)) {
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(alias)) {
      return workflowError(`${path}.${alias} must start with a letter and contain only letters, numbers, "_" or "-"`);
    }
    const aliasRecord = decodeRecord(raw, `${path}.${alias}`);
    if (!aliasRecord.ok) return aliasRecord;
    const hasTarget = "target" in aliasRecord.value;
    const hasService = "service" in aliasRecord.value;
    const hasContainerPort = "containerPort" in aliasRecord.value;
    if (hasTarget && (hasService || hasContainerPort || "healthPath" in aliasRecord.value)) {
      return workflowError(`${path}.${alias} must not mix target with docker service fields`);
    }
    if (hasTarget) {
      const target = primitive(makeNonEmptyText(aliasRecord.value.target, `${path}.${alias}.target`));
      if (!target.ok) return target;
      aliases[alias] = { target: target.value };
      continue;
    }
    if (!hasService || !hasContainerPort) {
      return workflowError(`${path}.${alias} must declare either target or both service and containerPort`);
    }
    const service = primitive(makeNonEmptyText(aliasRecord.value.service, `${path}.${alias}.service`));
    if (!service.ok) return service;
    const containerPort = primitive(makePositiveInteger(aliasRecord.value.containerPort, `${path}.${alias}.containerPort`));
    if (!containerPort.ok) return containerPort;
    const healthPath = decodeOptionalNonEmptyText(aliasRecord.value.healthPath, `${path}.${alias}.healthPath`);
    if (!healthPath.ok) return healthPath;
    aliases[alias] = {
      service: service.value,
      containerPort: containerPort.value,
      healthPath: healthPath.value
    };
  }
  return ok(aliases);
}

function decodeArtifactActionEvidence(value: unknown, path: string): Result<ArtifactActionDefinition["evidence"], DomainWorkflowError> {
  if (value === undefined) {
    return ok(undefined);
  }
  const record = decodeRecord(value, path);
  if (!record.ok) return record;
  const paths = decodeOptionalNonEmptyTextArray(record.value.paths, `${path}.paths`);
  if (!paths.ok) return paths;
  const attach = decodeOptionalBoolean(record.value.attach, `${path}.attach`);
  if (!attach.ok) return attach;
  return ok({
    attach: attach.value,
    paths: paths.value
  });
}

function decodeScalar(value: unknown, path: string): Result<string | number | boolean, DomainWorkflowError> {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? ok(value)
    : workflowError(`${path} must be a string, number, or boolean`);
}

function rejectDuplicateIds(ids: string[], path: string, label: string): Result<void, DomainWorkflowError> {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) {
      return workflowError(`${path} contains duplicate ${label}: ${id}`);
    }
    seen.add(id);
  }
  return ok(undefined);
}

function decodeNodeSource(value: unknown, path: string): Result<NodeRecord["source"], DomainWorkflowError> {
  const record = decodeRecord(value, path);
  if (!record.ok) return record;
  switch (record.value.type) {
    case "initial-execute-team":
    case "request": {
      const requestId = primitive(makeRequestId(record.value.requestId));
      return requestId.ok ? ok({ type: record.value.type, requestId: requestId.value }) : requestId;
    }
    case "move": {
      const moveId = primitive(makeMoveId(record.value.moveId));
      if (!moveId.ok) return moveId;
      const fromNodeId = primitive(makeNodeId(record.value.fromNodeId));
      return fromNodeId.ok ? ok({ type: "move", moveId: moveId.value, fromNodeId: fromNodeId.value }) : fromNodeId;
    }
    case "hunsu": {
      const hunsuId = primitive(makeHunsuId(record.value.hunsuId));
      if (!hunsuId.ok) return hunsuId;
      const fromNodeId = primitive(makeNodeId(record.value.fromNodeId));
      return fromNodeId.ok ? ok({ type: "hunsu", hunsuId: hunsuId.value, fromNodeId: fromNodeId.value }) : fromNodeId;
    }
    default:
      return workflowError(`${path}.type must be a supported node source type`);
  }
}

function lineWithStatus(base: RootLineRecordBase | ForkedLineRecordBase, status: LineRecord["status"]): Result<LineRecord, DomainWorkflowError> {
  switch (status) {
    case "active":
      return ok({ ...base, status: "active" });
    case "paused":
      return ok({ ...base, status: "paused" });
    case "complete":
      return ok({ ...base, status: "complete" });
    case "failed":
      return ok({ ...base, status: "failed" });
    case "abandoned":
      return ok({ ...base, status: "abandoned" });
  }
}

function rejectDestinationLifecycleFields(
  record: Record<string, unknown>,
  path: string,
  fields: string[],
  base: DestinationBase
): Result<Destination, DomainWorkflowError> {
  const invalid = rejectPresent(record, path, fields);
  return invalid.ok ? ok({ ...base, status: "pending" }) : invalid;
}

function rejectPresent(record: Record<string, unknown>, path: string, fields: string[]): Result<void, DomainWorkflowError> {
  const field = fields.find(candidate => record[candidate] !== undefined);
  return field ? workflowError(`${path}.${field} is not valid for this lifecycle status`) : ok(undefined);
}

function primitive<T>(result: Result<T, { message: string }>): Result<T, DomainWorkflowError> {
  return result.ok ? ok(result.value) : workflowError(result.error.message);
}
