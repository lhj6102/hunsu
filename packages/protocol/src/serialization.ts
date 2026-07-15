import { err, ok, type Result } from "./result.ts";
import {
  MAX_NODE_PAYLOAD_DECODED_BYTES,
  MAX_NODE_PAYLOAD_ENCODED_BYTES,
  NODE_PAYLOAD_CODEC,
  NODE_PAYLOAD_ENVELOPE_SCHEMA,
  NODE_PAYLOAD_SCHEMA,
  NODE_PLAN_SCHEMA,
  RUNNER_VALUE_SCHEMA,
  type AlternativeComparison,
  type AlternativeDecision,
  type CanonicalJsonValue,
  type CoachReview,
  type CoachingProposal,
  type CoachingProposalDecision,
  type ComparisonFinding,
  type DomainActor,
  type DomainEvent,
  type EventMetadata,
  type EvidenceRef,
  type GoalValue,
  type Node,
  type NodePayload,
  type NodePayloadEnvelope,
  type NodePlan,
  type ProcessedCommand,
  type Project,
  type ProjectState,
  type Run,
  type RunCheckpoint,
  type RunnerTypeLock,
  type RunnerValue,
  type RunnerValueTypeRegistry,
  type SelectionDecision,
  type RejectionDecision,
  type VerifiedRunResult
} from "./model.ts";
import {
  makeAcceptanceCriterion,
  makeAtLeastTwo,
  makeBase64Payload,
  makeCheckpointId,
  makeCoachReviewId,
  makeCoachingProposalId,
  makeCommandFingerprint,
  makeComparisonId,
  makeDecisionId,
  makeDesiredOutcome,
  makeEventId,
  makeEvidenceId,
  makeEvidenceSummary,
  makeGitBranchName,
  makeGitCommitSha,
  makeGitRef,
  makeGitTreePath,
  makeGitTreeSha,
  makeGoalConstraint,
  makeGoalDigest,
  makeGoalKey,
  makeGoalTitle,
  makeIdempotencyKey,
  makeIsoTimestamp,
  makeNodePayloadDigest,
  makeNodePlanDigest,
  makeNonEmptyArray,
  makeNonEmptyText,
  makeNonNegativeInteger,
  makeProjectId,
  makeProjectTitle,
  makeReason,
  makeRepositoryName,
  makeRepositoryOwner,
  makeRunId,
  makeRunnerDigest,
  makeRunnerSchemaVersion,
  makeRunnerTypeIntegrity,
  makeRunnerTypeKey,
  makeRunnerTypeOrigin,
  makeWorkspaceId,
  type GoalDigest,
  type NodePayloadDigest,
  type NodePlanDigest,
  type RunnerDigest
} from "./primitives.ts";

export const PROJECT_EVENT_SCHEMA = "hunsu.project-event.v3" as const;
export const HISTORICAL_PROJECT_EVENT_SCHEMA = "hunsu.project-event.v2" as const;
export const PROJECT_STATE_SCHEMA = "hunsu.project-state.v2" as const;

export type ProtocolCodecError = {
  readonly type: "ProtocolCodecError";
  readonly path: string;
  readonly message: string;
};

export function encodeDomainEvent(event: DomainEvent): string {
  return stringifyCanonical({ schema: PROJECT_EVENT_SCHEMA, event }) + "\n";
}

export function decodeDomainEvent(
  text: string,
  runnerTypes: RunnerValueTypeRegistry
): Result<DomainEvent, ProtocolCodecError> {
  const parsed = parseJson(text);
  if (!parsed.ok) return parsed;
  const root = exactRecord(parsed.value, "$", ["schema", "event"]);
  if (!root.ok) return root;
  if (root.value.schema === PROJECT_EVENT_SCHEMA) {
    return decodeEvent(root.value.event, "$.event", runnerTypes);
  }
  if (root.value.schema === HISTORICAL_PROJECT_EVENT_SCHEMA) {
    return decodeHistoricalV2Event(root.value.event, "$.event", runnerTypes);
  }
  return invalid(
    "$.schema",
    `schema must be ${PROJECT_EVENT_SCHEMA} or ${HISTORICAL_PROJECT_EVENT_SCHEMA}`
  );
}

export function encodeProjectState(state: ProjectState): string {
  return stringifyCanonical({ schema: PROJECT_STATE_SCHEMA, state }) + "\n";
}

export function decodeProjectState(
  text: string,
  runnerTypes: RunnerValueTypeRegistry
): Result<ProjectState, ProtocolCodecError> {
  const parsed = parseJson(text);
  if (!parsed.ok) return parsed;
  const root = exactRecord(parsed.value, "$", ["schema", "state"]);
  if (!root.ok) return root;
  if (root.value.schema !== PROJECT_STATE_SCHEMA) {
    return invalid("$.schema", `schema must be ${PROJECT_STATE_SCHEMA}`);
  }
  return decodeState(root.value.state, "$.state", runnerTypes);
}

export function canonicalJson(value: CanonicalJsonValue): string {
  return stringifyCanonical(value);
}

export function decodeCanonicalJsonValue(
  value: unknown,
  path = "$"
): Result<CanonicalJsonValue, ProtocolCodecError> {
  if (value === null || typeof value === "boolean" || typeof value === "string") return ok(value);
  if (typeof value === "number") {
    return Number.isFinite(value) && !Object.is(value, -0)
      ? ok(value)
      : invalid(path, "canonical JSON numbers must be finite and cannot be negative zero");
  }
  if (Array.isArray(value)) {
    const decoded: CanonicalJsonValue[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const item = decodeCanonicalJsonValue(value[index], `${path}[${index}]`);
      if (!item.ok) return item;
      decoded.push(item.value);
    }
    return ok(decoded);
  }
  if (!isRecord(value)) return invalid(path, "value must contain only canonical JSON data");
  const decoded: Record<string, CanonicalJsonValue> = {};
  for (const key of Object.keys(value)) {
    const item = decodeCanonicalJsonValue(value[key], `${path}.${key}`);
    if (!item.ok) return item;
    Object.defineProperty(decoded, key, {
      value: item.value,
      enumerable: true,
      configurable: true,
      writable: true
    });
  }
  return ok(decoded);
}

export function decodeGoalValue(value: unknown, path = "$"): Result<GoalValue, ProtocolCodecError> {
  const record = exactRecord(value, path, [
    "key", "title", "desiredOutcome", "acceptanceCriteria", "constraints", "priority"
  ]);
  if (!record.ok) return record;
  const key = primitive(makeGoalKey(record.value.key), `${path}.key`);
  if (!key.ok) return key;
  const title = primitive(makeGoalTitle(record.value.title), `${path}.title`);
  if (!title.ok) return title;
  const desiredOutcome = primitive(makeDesiredOutcome(record.value.desiredOutcome), `${path}.desiredOutcome`);
  if (!desiredOutcome.ok) return desiredOutcome;
  const criteria = decodeArray(record.value.acceptanceCriteria, `${path}.acceptanceCriteria`, (item, itemPath) =>
    primitive(makeAcceptanceCriterion(item, itemPath), itemPath));
  if (!criteria.ok) return criteria;
  const nonEmptyCriteria = primitive(makeNonEmptyArray(criteria.value, `${path}.acceptanceCriteria`), `${path}.acceptanceCriteria`);
  if (!nonEmptyCriteria.ok) return nonEmptyCriteria;
  if (new Set(nonEmptyCriteria.value).size !== nonEmptyCriteria.value.length) {
    return invalid(`${path}.acceptanceCriteria`, "acceptance criteria must be unique");
  }
  const constraints = decodeArray(record.value.constraints, `${path}.constraints`, (item, itemPath) =>
    primitive(makeGoalConstraint(item, itemPath), itemPath));
  if (!constraints.ok) return constraints;
  if (new Set(constraints.value).size !== constraints.value.length) {
    return invalid(`${path}.constraints`, "constraints must be unique");
  }
  const priority = primitive(makeNonNegativeInteger(record.value.priority, `${path}.priority`), `${path}.priority`);
  if (!priority.ok) return priority;
  return ok({
    key: key.value,
    title: title.value,
    desiredOutcome: desiredOutcome.value,
    acceptanceCriteria: nonEmptyCriteria.value,
    constraints: constraints.value,
    priority: priority.value
  });
}

export function decodeRunnerTypeLock(value: unknown, path = "$"): Result<RunnerTypeLock, ProtocolCodecError> {
  const record = exactRecord(value, path, ["origin", "key", "schemaVersion", "integrity"]);
  if (!record.ok) return record;
  const origin = primitive(makeRunnerTypeOrigin(record.value.origin, `${path}.origin`), `${path}.origin`);
  if (!origin.ok) return origin;
  const key = primitive(makeRunnerTypeKey(record.value.key, `${path}.key`), `${path}.key`);
  if (!key.ok) return key;
  const schemaVersion = primitive(makeRunnerSchemaVersion(record.value.schemaVersion, `${path}.schemaVersion`), `${path}.schemaVersion`);
  if (!schemaVersion.ok) return schemaVersion;
  const integrity = primitive(makeRunnerTypeIntegrity(record.value.integrity, `${path}.integrity`), `${path}.integrity`);
  if (!integrity.ok) return integrity;
  return ok({ origin: origin.value, key: key.value, schemaVersion: schemaVersion.value, integrity: integrity.value });
}

export function decodeRunnerValue(
  value: unknown,
  runnerTypes: RunnerValueTypeRegistry,
  path = "$"
): Result<RunnerValue, ProtocolCodecError> {
  const record = exactRecord(value, path, ["schema", "type", "name", "value"]);
  if (!record.ok) return record;
  if (record.value.schema !== RUNNER_VALUE_SCHEMA) {
    return invalid(`${path}.schema`, `schema must be ${RUNNER_VALUE_SCHEMA}`);
  }
  const type = decodeRunnerTypeLock(record.value.type, `${path}.type`);
  if (!type.ok) return type;
  const name = primitive(makeNonEmptyText(record.value.name, `${path}.name`), `${path}.name`);
  if (!name.ok) return name;
  const payload = decodeCanonicalJsonValue(record.value.value, `${path}.value`);
  if (!payload.ok) return payload;
  const decoder = runnerTypes.find(candidate => sameRunnerType(candidate.type, type.value));
  if (!decoder) {
    return invalid(`${path}.type`, "Runner type lock is not registered exactly");
  }
  const decodedPayload = decoder.decode(payload.value, `${path}.value`);
  if (!decodedPayload.ok) {
    return invalid(decodedPayload.error.path, decodedPayload.error.message);
  }
  if (stringifyCanonical(decodedPayload.value) !== stringifyCanonical(payload.value)) {
    return invalid(`${path}.value`, "Runner type decoder must validate without normalizing the payload");
  }
  return ok({ schema: RUNNER_VALUE_SCHEMA, type: type.value, name: name.value, value: payload.value });
}

export function decodeNodePlan(
  value: unknown,
  runnerTypes: RunnerValueTypeRegistry,
  path = "$"
): Result<NodePlan, ProtocolCodecError> {
  const record = exactRecord(value, path, ["schema", "nextGoals", "how"]);
  if (!record.ok) return record;
  if (record.value.schema !== NODE_PLAN_SCHEMA) {
    return invalid(`${path}.schema`, `schema must be ${NODE_PLAN_SCHEMA}`);
  }
  const nextGoals = decodeArray(record.value.nextGoals, `${path}.nextGoals`, decodeGoalValue);
  if (!nextGoals.ok) return nextGoals;
  const goalKeys = nextGoals.value.map(goal => goal.key);
  if (new Set(goalKeys).size !== goalKeys.length) {
    return invalid(`${path}.nextGoals`, "Goal keys must be unique within a Node");
  }
  const goalDigests = nextGoals.value.map(computeGoalDigest);
  if (new Set(goalDigests).size !== goalDigests.length) {
    return invalid(`${path}.nextGoals`, "Goal values must have unique canonical digests within a Node");
  }
  const how = decodeRunnerValue(record.value.how, runnerTypes, `${path}.how`);
  if (!how.ok) return how;
  return ok({ schema: NODE_PLAN_SCHEMA, nextGoals: nextGoals.value, how: how.value });
}

export function decodeNodePayload(
  value: unknown,
  runnerTypes: RunnerValueTypeRegistry,
  path = "$"
): Result<NodePayload, ProtocolCodecError> {
  const record = exactRecord(value, path, ["schema", "projectId", "commitSha", "treeSha", "plan"]);
  if (!record.ok) return record;
  if (record.value.schema !== NODE_PAYLOAD_SCHEMA) {
    return invalid(`${path}.schema`, `schema must be ${NODE_PAYLOAD_SCHEMA}`);
  }
  const projectId = primitive(makeProjectId(record.value.projectId), `${path}.projectId`);
  if (!projectId.ok) return projectId;
  const commitSha = primitive(makeGitCommitSha(record.value.commitSha, `${path}.commitSha`), `${path}.commitSha`);
  if (!commitSha.ok) return commitSha;
  const treeSha = primitive(makeGitTreeSha(record.value.treeSha, `${path}.treeSha`), `${path}.treeSha`);
  if (!treeSha.ok) return treeSha;
  const plan = decodeNodePlan(record.value.plan, runnerTypes, `${path}.plan`);
  if (!plan.ok) return plan;
  return ok({ schema: NODE_PAYLOAD_SCHEMA, projectId: projectId.value, commitSha: commitSha.value, treeSha: treeSha.value, plan: plan.value });
}

export function decodeNodePayloadEnvelope(value: unknown, path = "$"): Result<NodePayloadEnvelope, ProtocolCodecError> {
  const record = exactRecord(value, path, ["schema", "codec", "decodedSize", "encodedSize", "digest", "data"]);
  if (!record.ok) return record;
  if (record.value.schema !== NODE_PAYLOAD_ENVELOPE_SCHEMA) {
    return invalid(`${path}.schema`, `schema must be ${NODE_PAYLOAD_ENVELOPE_SCHEMA}`);
  }
  if (record.value.codec !== NODE_PAYLOAD_CODEC) {
    return invalid(`${path}.codec`, `codec must be ${NODE_PAYLOAD_CODEC}`);
  }
  const decodedSize = primitive(makeNonNegativeInteger(record.value.decodedSize, `${path}.decodedSize`), `${path}.decodedSize`);
  if (!decodedSize.ok) return decodedSize;
  if (decodedSize.value > MAX_NODE_PAYLOAD_DECODED_BYTES) {
    return invalid(`${path}.decodedSize`, `decoded payload exceeds ${MAX_NODE_PAYLOAD_DECODED_BYTES} bytes`);
  }
  const encodedSize = primitive(makeNonNegativeInteger(record.value.encodedSize, `${path}.encodedSize`), `${path}.encodedSize`);
  if (!encodedSize.ok) return encodedSize;
  if (encodedSize.value > MAX_NODE_PAYLOAD_ENCODED_BYTES) {
    return invalid(`${path}.encodedSize`, `encoded payload exceeds ${MAX_NODE_PAYLOAD_ENCODED_BYTES} bytes`);
  }
  const digest = primitive(makeNodePayloadDigest(record.value.digest), `${path}.digest`);
  if (!digest.ok) return digest;
  const data = primitive(makeBase64Payload(record.value.data, `${path}.data`), `${path}.data`);
  if (!data.ok) return data;
  if (encodedSize.value !== data.value.length) {
    return invalid(`${path}.encodedSize`, "encodedSize must equal the base64 payload byte length");
  }
  return ok({
    schema: NODE_PAYLOAD_ENVELOPE_SCHEMA,
    codec: NODE_PAYLOAD_CODEC,
    decodedSize: decodedSize.value,
    encodedSize: encodedSize.value,
    digest: digest.value,
    data: data.value
  });
}

export function computeGoalDigest(goal: GoalValue): GoalDigest {
  return (`hunsu-goal-v1:sha256:${sha256Hex(stringifyCanonical(goal))}`) as GoalDigest;
}

export function computeRunnerDigest(runner: RunnerValue): RunnerDigest {
  return (`hunsu-runner-v1:sha256:${sha256Hex(stringifyCanonical(runner))}`) as RunnerDigest;
}

export function computeNodePlanDigest(plan: NodePlan): NodePlanDigest {
  return (`hunsu-node-plan-v1:sha256:${sha256Hex(stringifyCanonical(plan))}`) as NodePlanDigest;
}

export function computeNodePayloadDigest(payload: NodePayload): NodePayloadDigest {
  return (`hunsu-node-payload-v1:sha256:${sha256Hex(stringifyCanonical(payload))}`) as NodePayloadDigest;
}

export function nodePayloadFor(node: Node): NodePayload {
  return {
    schema: NODE_PAYLOAD_SCHEMA,
    projectId: node.projectId,
    commitSha: node.commitSha,
    treeSha: node.treeSha,
    plan: node.plan
  };
}

export function canonicalUtf8ByteLength(value: unknown): number {
  let length = 0;
  for (const symbol of stringifyCanonical(value)) {
    const codePoint = symbol.codePointAt(0)!;
    length += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
  }
  return length;
}

function decodeEvent(
  value: unknown,
  path: string,
  runnerTypes: RunnerValueTypeRegistry
): Result<DomainEvent, ProtocolCodecError> {
  if (!isRecord(value) || typeof value.type !== "string") return invalid(path, "event must be a typed object");
  const meta = decodeEventMetadata(value.meta, `${path}.meta`);
  if (!meta.ok) return meta;
  switch (value.type) {
    case "ProjectCreated": {
      const record = exactRecord(value, path, ["type", "meta", "project"]);
      if (!record.ok) return record;
      const project = decodeProject(record.value.project, `${path}.project`);
      return project.ok ? ok({ type: "ProjectCreated", meta: meta.value, project: project.value }) : project;
    }
    case "ProjectMaterializationsRebuilt": {
      const record = exactRecord(value, path, ["type", "meta", "projectId"]);
      if (!record.ok) return record;
      const projectId = primitive(makeProjectId(record.value.projectId), `${path}.projectId`);
      return projectId.ok
        ? ok({ type: "ProjectMaterializationsRebuilt", meta: meta.value, projectId: projectId.value })
        : projectId;
    }
    case "RootNodeRegistered":
      return decodeNodeRegistrationEvent(value, path, meta.value, "RootNodeRegistered", "root", runnerTypes);
    case "RunStarted": {
      const record = exactRecord(value, path, ["type", "meta", "run"]);
      if (!record.ok) return record;
      const run = decodeRun(record.value.run, `${path}.run`, runnerTypes);
      return run.ok && run.value.status === "running"
        ? ok({ type: "RunStarted", meta: meta.value, run: run.value })
        : run.ok ? invalid(`${path}.run.status`, "RunStarted requires a running Run") : run;
    }
    case "RunCheckpointed": {
      const record = exactRecord(value, path, ["type", "meta", "checkpoint"]);
      if (!record.ok) return record;
      const checkpoint = decodeCheckpoint(record.value.checkpoint, `${path}.checkpoint`);
      return checkpoint.ok ? ok({ type: "RunCheckpointed", meta: meta.value, checkpoint: checkpoint.value }) : checkpoint;
    }
    case "RunEvidenceAttached": {
      const record = exactRecord(value, path, ["type", "meta", "evidence"]);
      if (!record.ok) return record;
      const evidence = decodeEvidence(record.value.evidence, `${path}.evidence`);
      return evidence.ok ? ok({ type: "RunEvidenceAttached", meta: meta.value, evidence: evidence.value }) : evidence;
    }
    case "RunCompleted": {
      const record = exactRecord(value, path, ["type", "meta", "result"]);
      if (!record.ok) return record;
      const result = decodeVerifiedResult(record.value.result, `${path}.result`);
      return result.ok ? ok({ type: "RunCompleted", meta: meta.value, result: result.value }) : result;
    }
    case "RunChildNodeRegistered":
      return decodeNodeRegistrationEvent(value, path, meta.value, "RunChildNodeRegistered", "run_child", runnerTypes);
    case "RunFailed":
    case "RunCanceled": {
      const record = exactRecord(value, path, ["type", "meta", "runId", "reason"]);
      if (!record.ok) return record;
      const runId = primitive(makeRunId(record.value.runId), `${path}.runId`);
      if (!runId.ok) return runId;
      const reason = primitive(makeReason(record.value.reason, `${path}.reason`), `${path}.reason`);
      if (!reason.ok) return reason;
      return value.type === "RunFailed"
        ? ok({ type: "RunFailed", meta: meta.value, runId: runId.value, reason: reason.value })
        : ok({ type: "RunCanceled", meta: meta.value, runId: runId.value, reason: reason.value });
    }
    case "CoachReviewRecorded": {
      const record = exactRecord(value, path, ["type", "meta", "review"]);
      if (!record.ok) return record;
      const review = decodeCoachReview(record.value.review, `${path}.review`);
      return review.ok ? ok({ type: "CoachReviewRecorded", meta: meta.value, review: review.value }) : review;
    }
    case "CoachingProposalRecorded": {
      const record = exactRecord(value, path, ["type", "meta", "proposal"]);
      if (!record.ok) return record;
      const proposal = decodeCoachingProposal(record.value.proposal, `${path}.proposal`, runnerTypes);
      return proposal.ok ? ok({ type: "CoachingProposalRecorded", meta: meta.value, proposal: proposal.value }) : proposal;
    }
    case "CoachingProposalConfirmed":
    case "CoachingProposalRejected": {
      const record = exactRecord(value, path, ["type", "meta", "decision"]);
      if (!record.ok) return record;
      const decision = decodeCoachingDecision(record.value.decision, `${path}.decision`);
      if (!decision.ok) return decision;
      if (value.type === "CoachingProposalConfirmed" && decision.value.status === "confirmed") {
        return ok({ type: "CoachingProposalConfirmed", meta: meta.value, decision: decision.value });
      }
      if (value.type === "CoachingProposalRejected" && decision.value.status === "rejected") {
        return ok({ type: "CoachingProposalRejected", meta: meta.value, decision: decision.value });
      }
      return invalid(`${path}.decision.status`, "event type and Coaching decision status must agree");
    }
    case "CoachingChildNodeRegistered":
      return decodeNodeRegistrationEvent(value, path, meta.value, "CoachingChildNodeRegistered", "coaching_child", runnerTypes);
    case "AlternativesCompared": {
      const record = exactRecord(value, path, ["type", "meta", "comparison"]);
      if (!record.ok) return record;
      const comparison = decodeComparison(record.value.comparison, `${path}.comparison`);
      return comparison.ok ? ok({ type: "AlternativesCompared", meta: meta.value, comparison: comparison.value }) : comparison;
    }
    case "AlternativeSelected":
    case "AlternativesRejected": {
      const record = exactRecord(value, path, ["type", "meta", "decision"]);
      if (!record.ok) return record;
      const decision = decodeAlternativeDecision(record.value.decision, `${path}.decision`);
      if (!decision.ok) return decision;
      if (value.type === "AlternativeSelected" && decision.value.type === "selection") {
        return ok({ type: "AlternativeSelected", meta: meta.value, decision: decision.value });
      }
      if (value.type === "AlternativesRejected" && decision.value.type === "rejection") {
        return ok({ type: "AlternativesRejected", meta: meta.value, decision: decision.value });
      }
      return invalid(`${path}.decision.type`, "event type and alternative decision type must agree");
    }
    default:
      return invalid(`${path}.type`, "unsupported v3 event type");
  }
}

/**
 * Freeze the exact event variants emitted by the original v2 runtime. Only the
 * two shapes that changed in v3 are normalized; every other variant continues
 * through the same exact-field decoder because its v2 and v3 representation is
 * byte-for-byte identical.
 */
function decodeHistoricalV2Event(
  value: unknown,
  path: string,
  runnerTypes: RunnerValueTypeRegistry
): Result<DomainEvent, ProtocolCodecError> {
  if (!isRecord(value) || typeof value.type !== "string") return invalid(path, "event must be a typed object");
  const meta = decodeEventMetadata(value.meta, `${path}.meta`);
  if (!meta.ok) return meta;
  switch (value.type) {
    case "CoachingProposalRecorded": {
      const record = exactRecord(value, path, ["type", "meta", "proposal"]);
      if (!record.ok) return record;
      const proposal = decodeHistoricalV2CoachingProposal(record.value.proposal, `${path}.proposal`, runnerTypes);
      return proposal.ok ? ok({ type: "CoachingProposalRecorded", meta: meta.value, proposal: proposal.value }) : proposal;
    }
    case "AlternativesCompared": {
      const record = exactRecord(value, path, ["type", "meta", "comparison"]);
      if (!record.ok) return record;
      const comparison = decodeHistoricalV2Comparison(record.value.comparison, `${path}.comparison`);
      return comparison.ok ? ok({ type: "AlternativesCompared", meta: meta.value, comparison: comparison.value }) : comparison;
    }
    case "ProjectCreated":
    case "ProjectMaterializationsRebuilt":
    case "RootNodeRegistered":
    case "RunStarted":
    case "RunCheckpointed":
    case "RunEvidenceAttached":
    case "RunCompleted":
    case "RunChildNodeRegistered":
    case "RunFailed":
    case "RunCanceled":
    case "CoachReviewRecorded":
    case "CoachingProposalConfirmed":
    case "CoachingProposalRejected":
    case "CoachingChildNodeRegistered":
    case "AlternativeSelected":
    case "AlternativesRejected":
      return decodeEvent(value, path, runnerTypes);
    default:
      return invalid(`${path}.type`, "unsupported historical v2 event type");
  }
}

function decodeNodeRegistrationEvent<Type extends "RootNodeRegistered" | "RunChildNodeRegistered" | "CoachingChildNodeRegistered", Kind extends Node["type"]>(
  value: Record<string, unknown>,
  path: string,
  meta: EventMetadata,
  eventType: Type,
  nodeType: Kind,
  runnerTypes: RunnerValueTypeRegistry
): Result<Extract<DomainEvent, { type: Type }>, ProtocolCodecError> {
  const record = exactRecord(value, path, ["type", "meta", "node", "payload"]);
  if (!record.ok) return record;
  const node = decodeNode(record.value.node, `${path}.node`, runnerTypes);
  if (!node.ok) return node;
  if (node.value.type !== nodeType) return invalid(`${path}.node.type`, `node type must be ${nodeType}`);
  const payload = decodeNodePayloadEnvelope(record.value.payload, `${path}.payload`);
  if (!payload.ok) return payload;
  return ok({ type: eventType, meta, node: node.value, payload: payload.value } as Extract<DomainEvent, { type: Type }>);
}

function decodeState(value: unknown, path: string, runnerTypes: RunnerValueTypeRegistry): Result<ProjectState, ProtocolCodecError> {
  const record = exactRecord(value, path, [
    "projects", "nodes", "runs", "evidence", "coachReviews", "coachingProposals",
    "coachingProposalDecisions", "comparisons", "decisions", "processedCommands"
  ]);
  if (!record.ok) return record;
  const projects = decodeArray(record.value.projects, `${path}.projects`, decodeProject);
  if (!projects.ok) return projects;
  const nodes = decodeArray(record.value.nodes, `${path}.nodes`, (item, itemPath) => decodeNode(item, itemPath, runnerTypes));
  if (!nodes.ok) return nodes;
  const runs = decodeArray(record.value.runs, `${path}.runs`, (item, itemPath) => decodeRun(item, itemPath, runnerTypes));
  if (!runs.ok) return runs;
  const evidence = decodeArray(record.value.evidence, `${path}.evidence`, decodeEvidence);
  if (!evidence.ok) return evidence;
  const coachReviews = decodeArray(record.value.coachReviews, `${path}.coachReviews`, decodeCoachReview);
  if (!coachReviews.ok) return coachReviews;
  const coachingProposals = decodeArray(record.value.coachingProposals, `${path}.coachingProposals`, (item, itemPath) =>
    decodeCoachingProposal(item, itemPath, runnerTypes));
  if (!coachingProposals.ok) return coachingProposals;
  const coachingProposalDecisions = decodeArray(record.value.coachingProposalDecisions, `${path}.coachingProposalDecisions`, decodeCoachingDecision);
  if (!coachingProposalDecisions.ok) return coachingProposalDecisions;
  const comparisons = decodeArray(record.value.comparisons, `${path}.comparisons`, decodeComparison);
  if (!comparisons.ok) return comparisons;
  const decisions = decodeArray(record.value.decisions, `${path}.decisions`, decodeAlternativeDecision);
  if (!decisions.ok) return decisions;
  const processedCommands = decodeArray(record.value.processedCommands, `${path}.processedCommands`, decodeProcessedCommand);
  if (!processedCommands.ok) return processedCommands;
  return ok({
    projects: projects.value,
    nodes: nodes.value,
    runs: runs.value,
    evidence: evidence.value,
    coachReviews: coachReviews.value,
    coachingProposals: coachingProposals.value,
    coachingProposalDecisions: coachingProposalDecisions.value,
    comparisons: comparisons.value,
    decisions: decisions.value,
    processedCommands: processedCommands.value
  });
}

function decodeProject(value: unknown, path: string): Result<Project, ProtocolCodecError> {
  const record = exactRecord(value, path, ["id", "workspaceId", "repository", "baseRef", "title", "rootNodeSha", "createdAt"]);
  if (!record.ok) return record;
  const id = primitive(makeProjectId(record.value.id), `${path}.id`);
  if (!id.ok) return id;
  const workspaceId = primitive(makeWorkspaceId(record.value.workspaceId), `${path}.workspaceId`);
  if (!workspaceId.ok) return workspaceId;
  const repository = exactRecord(record.value.repository, `${path}.repository`, ["owner", "name"]);
  if (!repository.ok) return repository;
  const owner = primitive(makeRepositoryOwner(repository.value.owner), `${path}.repository.owner`);
  if (!owner.ok) return owner;
  const name = primitive(makeRepositoryName(repository.value.name), `${path}.repository.name`);
  if (!name.ok) return name;
  const baseRef = primitive(makeGitRef(record.value.baseRef, `${path}.baseRef`), `${path}.baseRef`);
  if (!baseRef.ok) return baseRef;
  const title = primitive(makeProjectTitle(record.value.title), `${path}.title`);
  if (!title.ok) return title;
  const rootNodeSha = primitive(makeGitCommitSha(record.value.rootNodeSha, `${path}.rootNodeSha`), `${path}.rootNodeSha`);
  if (!rootNodeSha.ok) return rootNodeSha;
  const createdAt = primitive(makeIsoTimestamp(record.value.createdAt, `${path}.createdAt`), `${path}.createdAt`);
  if (!createdAt.ok) return createdAt;
  return ok({
    id: id.value,
    workspaceId: workspaceId.value,
    repository: { owner: owner.value, name: name.value },
    baseRef: baseRef.value,
    title: title.value,
    rootNodeSha: rootNodeSha.value,
    createdAt: createdAt.value
  });
}

function decodeNode(value: unknown, path: string, runnerTypes: RunnerValueTypeRegistry): Result<Node, ProtocolCodecError> {
  if (!isRecord(value) || typeof value.type !== "string") return invalid(path, "Node must be a typed object");
  const childKeys = value.type === "run_child"
    ? ["parentSha", "runId", "consumedGoalDigest"]
    : value.type === "coaching_child" ? ["parentSha", "proposalId"] : [];
  if (value.type !== "root" && value.type !== "run_child" && value.type !== "coaching_child") {
    return invalid(`${path}.type`, "unsupported Node type");
  }
  const record = exactRecord(value, path, [
    "type", "projectId", "commitSha", "treeSha", "managedRef", "commitTitle", "plan",
    "planDigest", "payloadDigest", "registeredAt", ...childKeys
  ]);
  if (!record.ok) return record;
  const projectId = primitive(makeProjectId(record.value.projectId), `${path}.projectId`);
  if (!projectId.ok) return projectId;
  const commitSha = primitive(makeGitCommitSha(record.value.commitSha, `${path}.commitSha`), `${path}.commitSha`);
  if (!commitSha.ok) return commitSha;
  const treeSha = primitive(makeGitTreeSha(record.value.treeSha, `${path}.treeSha`), `${path}.treeSha`);
  if (!treeSha.ok) return treeSha;
  const managedRef = primitive(makeGitRef(record.value.managedRef, `${path}.managedRef`), `${path}.managedRef`);
  if (!managedRef.ok) return managedRef;
  const commitTitle = primitive(makeNonEmptyText(record.value.commitTitle, `${path}.commitTitle`), `${path}.commitTitle`);
  if (!commitTitle.ok) return commitTitle;
  const plan = decodeNodePlan(record.value.plan, runnerTypes, `${path}.plan`);
  if (!plan.ok) return plan;
  const planDigest = primitive(makeNodePlanDigest(record.value.planDigest), `${path}.planDigest`);
  if (!planDigest.ok) return planDigest;
  const payloadDigest = primitive(makeNodePayloadDigest(record.value.payloadDigest), `${path}.payloadDigest`);
  if (!payloadDigest.ok) return payloadDigest;
  const registeredAt = primitive(makeIsoTimestamp(record.value.registeredAt, `${path}.registeredAt`), `${path}.registeredAt`);
  if (!registeredAt.ok) return registeredAt;
  const base = {
    projectId: projectId.value,
    commitSha: commitSha.value,
    treeSha: treeSha.value,
    managedRef: managedRef.value,
    commitTitle: commitTitle.value,
    plan: plan.value,
    planDigest: planDigest.value,
    payloadDigest: payloadDigest.value,
    registeredAt: registeredAt.value
  };
  if (value.type === "root") return ok({ type: "root", ...base });
  const parentSha = primitive(makeGitCommitSha(record.value.parentSha, `${path}.parentSha`), `${path}.parentSha`);
  if (!parentSha.ok) return parentSha;
  if (value.type === "run_child") {
    const runId = primitive(makeRunId(record.value.runId), `${path}.runId`);
    if (!runId.ok) return runId;
    const consumedGoalDigest = primitive(makeGoalDigest(record.value.consumedGoalDigest), `${path}.consumedGoalDigest`);
    if (!consumedGoalDigest.ok) return consumedGoalDigest;
    return ok({ type: "run_child", ...base, parentSha: parentSha.value, runId: runId.value, consumedGoalDigest: consumedGoalDigest.value });
  }
  const proposalId = primitive(makeCoachingProposalId(record.value.proposalId), `${path}.proposalId`);
  if (!proposalId.ok) return proposalId;
  return ok({ type: "coaching_child", ...base, parentSha: parentSha.value, proposalId: proposalId.value });
}

function decodeRun(value: unknown, path: string, runnerTypes: RunnerValueTypeRegistry): Result<Run, ProtocolCodecError> {
  if (!isRecord(value) || typeof value.status !== "string") return invalid(path, "Run must be a status variant");
  const terminalKeys = value.status === "completed"
    ? ["resultNodeSha", "verifiedAt", "completedAt"]
    : value.status === "failed" ? ["failedAt", "failureReason"]
      : value.status === "canceled" ? ["canceledAt", "cancellationReason"] : [];
  if (value.status !== "running" && value.status !== "completed" && value.status !== "failed" && value.status !== "canceled") {
    return invalid(`${path}.status`, "unsupported Run status");
  }
  const record = exactRecord(value, path, [
    "id", "projectId", "sourceNodeSha", "goal", "goalDigest", "runner", "runnerDigest",
    "branch", "checkpoints", "evidenceIds", "startedAt", "status", ...terminalKeys
  ]);
  if (!record.ok) return record;
  const id = primitive(makeRunId(record.value.id), `${path}.id`);
  if (!id.ok) return id;
  const projectId = primitive(makeProjectId(record.value.projectId), `${path}.projectId`);
  if (!projectId.ok) return projectId;
  const sourceNodeSha = primitive(makeGitCommitSha(record.value.sourceNodeSha, `${path}.sourceNodeSha`), `${path}.sourceNodeSha`);
  if (!sourceNodeSha.ok) return sourceNodeSha;
  const goal = decodeGoalValue(record.value.goal, `${path}.goal`);
  if (!goal.ok) return goal;
  const goalDigest = primitive(makeGoalDigest(record.value.goalDigest), `${path}.goalDigest`);
  if (!goalDigest.ok) return goalDigest;
  const runner = decodeRunnerValue(record.value.runner, runnerTypes, `${path}.runner`);
  if (!runner.ok) return runner;
  const runnerDigest = primitive(makeRunnerDigest(record.value.runnerDigest), `${path}.runnerDigest`);
  if (!runnerDigest.ok) return runnerDigest;
  const branch = primitive(makeGitBranchName(record.value.branch, `${path}.branch`), `${path}.branch`);
  if (!branch.ok) return branch;
  const checkpoints = decodeArray(record.value.checkpoints, `${path}.checkpoints`, decodeCheckpoint);
  if (!checkpoints.ok) return checkpoints;
  const evidenceIds = decodeArray(record.value.evidenceIds, `${path}.evidenceIds`, (item, itemPath) => primitive(makeEvidenceId(item), itemPath));
  if (!evidenceIds.ok) return evidenceIds;
  const startedAt = primitive(makeIsoTimestamp(record.value.startedAt, `${path}.startedAt`), `${path}.startedAt`);
  if (!startedAt.ok) return startedAt;
  const base = {
    id: id.value,
    projectId: projectId.value,
    sourceNodeSha: sourceNodeSha.value,
    goal: goal.value,
    goalDigest: goalDigest.value,
    runner: runner.value,
    runnerDigest: runnerDigest.value,
    branch: branch.value,
    checkpoints: checkpoints.value,
    evidenceIds: evidenceIds.value,
    startedAt: startedAt.value
  };
  if (value.status === "running") return ok({ ...base, status: "running" });
  if (value.status === "completed") {
    const resultNodeSha = primitive(makeGitCommitSha(record.value.resultNodeSha, `${path}.resultNodeSha`), `${path}.resultNodeSha`);
    if (!resultNodeSha.ok) return resultNodeSha;
    const verifiedAt = primitive(makeIsoTimestamp(record.value.verifiedAt, `${path}.verifiedAt`), `${path}.verifiedAt`);
    if (!verifiedAt.ok) return verifiedAt;
    const completedAt = primitive(makeIsoTimestamp(record.value.completedAt, `${path}.completedAt`), `${path}.completedAt`);
    if (!completedAt.ok) return completedAt;
    return ok({ ...base, status: "completed", resultNodeSha: resultNodeSha.value, verifiedAt: verifiedAt.value, completedAt: completedAt.value });
  }
  if (value.status === "failed") {
    const failedAt = primitive(makeIsoTimestamp(record.value.failedAt, `${path}.failedAt`), `${path}.failedAt`);
    if (!failedAt.ok) return failedAt;
    const failureReason = primitive(makeReason(record.value.failureReason, `${path}.failureReason`), `${path}.failureReason`);
    if (!failureReason.ok) return failureReason;
    return ok({ ...base, status: "failed", failedAt: failedAt.value, failureReason: failureReason.value });
  }
  const canceledAt = primitive(makeIsoTimestamp(record.value.canceledAt, `${path}.canceledAt`), `${path}.canceledAt`);
  if (!canceledAt.ok) return canceledAt;
  const cancellationReason = primitive(makeReason(record.value.cancellationReason, `${path}.cancellationReason`), `${path}.cancellationReason`);
  if (!cancellationReason.ok) return cancellationReason;
  return ok({ ...base, status: "canceled", canceledAt: canceledAt.value, cancellationReason: cancellationReason.value });
}

function decodeCheckpoint(value: unknown, path: string): Result<RunCheckpoint, ProtocolCodecError> {
  const record = exactRecord(value, path, ["id", "runId", "summary", "location", "recordedAt"]);
  if (!record.ok) return record;
  const id = primitive(makeCheckpointId(record.value.id), `${path}.id`);
  if (!id.ok) return id;
  const runId = primitive(makeRunId(record.value.runId), `${path}.runId`);
  if (!runId.ok) return runId;
  const summary = primitive(makeEvidenceSummary(record.value.summary, `${path}.summary`), `${path}.summary`);
  if (!summary.ok) return summary;
  const locationRecord = isRecord(record.value.location) && record.value.location.type === "observation"
    ? exactRecord(record.value.location, `${path}.location`, ["type"])
    : exactRecord(record.value.location, `${path}.location`, ["type", "commitSha"]);
  if (!locationRecord.ok) return locationRecord;
  let location: RunCheckpoint["location"];
  if (locationRecord.value.type === "observation") location = { type: "observation" };
  else if (locationRecord.value.type === "commit") {
    const sha = primitive(makeGitCommitSha(locationRecord.value.commitSha, `${path}.location.commitSha`), `${path}.location.commitSha`);
    if (!sha.ok) return sha;
    location = { type: "commit", commitSha: sha.value };
  } else return invalid(`${path}.location.type`, "unsupported checkpoint location");
  const recordedAt = primitive(makeIsoTimestamp(record.value.recordedAt, `${path}.recordedAt`), `${path}.recordedAt`);
  if (!recordedAt.ok) return recordedAt;
  return ok({ id: id.value, runId: runId.value, summary: summary.value, location, recordedAt: recordedAt.value });
}

function decodeEvidence(value: unknown, path: string): Result<EvidenceRef, ProtocolCodecError> {
  const record = exactRecord(value, path, ["id", "projectId", "runId", "target", "kind", "summary", "location", "recordedAt"]);
  if (!record.ok) return record;
  const id = primitive(makeEvidenceId(record.value.id), `${path}.id`);
  if (!id.ok) return id;
  const projectId = primitive(makeProjectId(record.value.projectId), `${path}.projectId`);
  if (!projectId.ok) return projectId;
  const runId = primitive(makeRunId(record.value.runId), `${path}.runId`);
  if (!runId.ok) return runId;
  if (!isRecord(record.value.target)) return invalid(`${path}.target`, "evidence target must be an object");
  let target: EvidenceRef["target"];
  if (record.value.target.type === "run") {
    const targetRecord = exactRecord(record.value.target, `${path}.target`, ["type"]);
    if (!targetRecord.ok) return targetRecord;
    target = { type: "run" };
  } else if (record.value.target.type === "criterion") {
    const targetRecord = exactRecord(record.value.target, `${path}.target`, ["type", "criterion"]);
    if (!targetRecord.ok) return targetRecord;
    const criterion = primitive(makeAcceptanceCriterion(targetRecord.value.criterion, `${path}.target.criterion`), `${path}.target.criterion`);
    if (!criterion.ok) return criterion;
    target = { type: "criterion", criterion: criterion.value };
  } else return invalid(`${path}.target.type`, "unsupported evidence target");
  const kind = oneOf(record.value.kind, ["diff", "check", "screenshot", "report", "note"] as const, `${path}.kind`);
  if (!kind.ok) return kind;
  const summary = primitive(makeEvidenceSummary(record.value.summary, `${path}.summary`), `${path}.summary`);
  if (!summary.ok) return summary;
  const location = decodeEvidenceLocation(record.value.location, `${path}.location`);
  if (!location.ok) return location;
  const recordedAt = primitive(makeIsoTimestamp(record.value.recordedAt, `${path}.recordedAt`), `${path}.recordedAt`);
  if (!recordedAt.ok) return recordedAt;
  return ok({ id: id.value, projectId: projectId.value, runId: runId.value, target, kind: kind.value, summary: summary.value, location: location.value, recordedAt: recordedAt.value });
}

function decodeEvidenceLocation(value: unknown, path: string): Result<EvidenceRef["location"], ProtocolCodecError> {
  if (!isRecord(value) || typeof value.type !== "string") return invalid(path, "evidence location must be a typed object");
  if (value.type === "git") {
    const record = exactRecord(value, path, ["type", "commitSha", "path"]);
    if (!record.ok) return record;
    const sha = primitive(makeGitCommitSha(record.value.commitSha, `${path}.commitSha`), `${path}.commitSha`);
    if (!sha.ok) return sha;
    const evidencePath = primitive(makeGitTreePath(record.value.path, `${path}.path`), `${path}.path`);
    return evidencePath.ok ? ok({ type: "git", commitSha: sha.value, path: evidencePath.value }) : evidencePath;
  }
  if (value.type === "url") {
    const record = exactRecord(value, path, ["type", "url"]);
    if (!record.ok) return record;
    const url = primitive(makeNonEmptyText(record.value.url, `${path}.url`), `${path}.url`);
    return url.ok ? ok({ type: "url", url: url.value }) : url;
  }
  if (value.type === "text") {
    const record = exactRecord(value, path, ["type", "text"]);
    if (!record.ok) return record;
    const text = primitive(makeNonEmptyText(record.value.text, `${path}.text`), `${path}.text`);
    return text.ok ? ok({ type: "text", text: text.value }) : text;
  }
  return invalid(`${path}.type`, "unsupported evidence location");
}

function decodeVerifiedResult(value: unknown, path: string): Result<VerifiedRunResult, ProtocolCodecError> {
  const record = exactRecord(value, path, ["runId", "branch", "resultSha", "verifiedAt"]);
  if (!record.ok) return record;
  const runId = primitive(makeRunId(record.value.runId), `${path}.runId`);
  if (!runId.ok) return runId;
  const branch = primitive(makeGitBranchName(record.value.branch, `${path}.branch`), `${path}.branch`);
  if (!branch.ok) return branch;
  const resultSha = primitive(makeGitCommitSha(record.value.resultSha, `${path}.resultSha`), `${path}.resultSha`);
  if (!resultSha.ok) return resultSha;
  const verifiedAt = primitive(makeIsoTimestamp(record.value.verifiedAt, `${path}.verifiedAt`), `${path}.verifiedAt`);
  return verifiedAt.ok ? ok({ runId: runId.value, branch: branch.value, resultSha: resultSha.value, verifiedAt: verifiedAt.value }) : verifiedAt;
}

function decodeCoachReview(value: unknown, path: string): Result<CoachReview, ProtocolCodecError> {
  const record = exactRecord(value, path, ["id", "projectId", "target", "assessment", "recommendations", "recordedAt"]);
  if (!record.ok) return record;
  const id = primitive(makeCoachReviewId(record.value.id), `${path}.id`);
  if (!id.ok) return id;
  const projectId = primitive(makeProjectId(record.value.projectId), `${path}.projectId`);
  if (!projectId.ok) return projectId;
  if (!isRecord(record.value.target)) return invalid(`${path}.target`, "review target must be a typed object");
  let target: CoachReview["target"];
  if (record.value.target.type === "node") {
    const targetRecord = exactRecord(record.value.target, `${path}.target`, ["type", "nodeSha"]);
    if (!targetRecord.ok) return targetRecord;
    const nodeSha = primitive(makeGitCommitSha(targetRecord.value.nodeSha, `${path}.target.nodeSha`), `${path}.target.nodeSha`);
    if (!nodeSha.ok) return nodeSha;
    target = { type: "node", nodeSha: nodeSha.value };
  } else if (record.value.target.type === "run") {
    const targetRecord = exactRecord(record.value.target, `${path}.target`, ["type", "runId"]);
    if (!targetRecord.ok) return targetRecord;
    const runId = primitive(makeRunId(targetRecord.value.runId), `${path}.target.runId`);
    if (!runId.ok) return runId;
    target = { type: "run", runId: runId.value };
  } else if (record.value.target.type === "comparison") {
    const targetRecord = exactRecord(record.value.target, `${path}.target`, ["type", "comparisonId"]);
    if (!targetRecord.ok) return targetRecord;
    const comparisonId = primitive(makeComparisonId(targetRecord.value.comparisonId), `${path}.target.comparisonId`);
    if (!comparisonId.ok) return comparisonId;
    target = { type: "comparison", comparisonId: comparisonId.value };
  } else return invalid(`${path}.target.type`, "unsupported review target");
  const assessment = primitive(makeNonEmptyText(record.value.assessment, `${path}.assessment`), `${path}.assessment`);
  if (!assessment.ok) return assessment;
  const recommendations = decodeArray(record.value.recommendations, `${path}.recommendations`, (item, itemPath) => primitive(makeNonEmptyText(item, itemPath), itemPath));
  if (!recommendations.ok) return recommendations;
  const recordedAt = primitive(makeIsoTimestamp(record.value.recordedAt, `${path}.recordedAt`), `${path}.recordedAt`);
  return recordedAt.ok ? ok({ id: id.value, projectId: projectId.value, target, assessment: assessment.value, recommendations: recommendations.value, recordedAt: recordedAt.value }) : recordedAt;
}

function decodeCoachingProposal(value: unknown, path: string, runnerTypes: RunnerValueTypeRegistry): Result<CoachingProposal, ProtocolCodecError> {
  const record = exactRecord(value, path, [
    "id", "projectId", "sourceNodeSha", "sourcePayloadDigest", "sourcePlanDigest",
    "proposedPlan", "proposedPlanDigest", "expectedStateSha", "summary", "rationale", "proposedAt"
  ]);
  if (!record.ok) return record;
  const id = primitive(makeCoachingProposalId(record.value.id), `${path}.id`);
  if (!id.ok) return id;
  const projectId = primitive(makeProjectId(record.value.projectId), `${path}.projectId`);
  if (!projectId.ok) return projectId;
  const sourceNodeSha = primitive(makeGitCommitSha(record.value.sourceNodeSha, `${path}.sourceNodeSha`), `${path}.sourceNodeSha`);
  if (!sourceNodeSha.ok) return sourceNodeSha;
  const sourcePayloadDigest = primitive(makeNodePayloadDigest(record.value.sourcePayloadDigest), `${path}.sourcePayloadDigest`);
  if (!sourcePayloadDigest.ok) return sourcePayloadDigest;
  const sourcePlanDigest = primitive(makeNodePlanDigest(record.value.sourcePlanDigest), `${path}.sourcePlanDigest`);
  if (!sourcePlanDigest.ok) return sourcePlanDigest;
  const proposedPlan = decodeNodePlan(record.value.proposedPlan, runnerTypes, `${path}.proposedPlan`);
  if (!proposedPlan.ok) return proposedPlan;
  const proposedPlanDigest = primitive(makeNodePlanDigest(record.value.proposedPlanDigest), `${path}.proposedPlanDigest`);
  if (!proposedPlanDigest.ok) return proposedPlanDigest;
  const expectedStateSha = primitive(makeGitCommitSha(record.value.expectedStateSha, `${path}.expectedStateSha`), `${path}.expectedStateSha`);
  if (!expectedStateSha.ok) return expectedStateSha;
  const summary = primitive(makeEvidenceSummary(record.value.summary, `${path}.summary`), `${path}.summary`);
  if (!summary.ok) return summary;
  const rationale = primitive(makeReason(record.value.rationale, `${path}.rationale`), `${path}.rationale`);
  if (!rationale.ok) return rationale;
  const proposedAt = primitive(makeIsoTimestamp(record.value.proposedAt, `${path}.proposedAt`), `${path}.proposedAt`);
  return proposedAt.ok ? ok({
    id: id.value,
    projectId: projectId.value,
    sourceNodeSha: sourceNodeSha.value,
    sourcePayloadDigest: sourcePayloadDigest.value,
    sourcePlanDigest: sourcePlanDigest.value,
    proposedPlan: proposedPlan.value,
    proposedPlanDigest: proposedPlanDigest.value,
    expectedStateSha: expectedStateSha.value,
    summary: summary.value,
    rationale: rationale.value,
    proposedAt: proposedAt.value
  }) : proposedAt;
}

function decodeHistoricalV2CoachingProposal(
  value: unknown,
  path: string,
  runnerTypes: RunnerValueTypeRegistry
): Result<CoachingProposal, ProtocolCodecError> {
  const record = exactRecord(value, path, [
    "id", "projectId", "sourceNodeSha", "sourcePayloadDigest", "sourcePlanDigest",
    "proposedPlan", "proposedPlanDigest", "expectedStateSha", "reason", "proposedAt"
  ]);
  if (!record.ok) return record;
  const id = primitive(makeCoachingProposalId(record.value.id), `${path}.id`);
  if (!id.ok) return id;
  const projectId = primitive(makeProjectId(record.value.projectId), `${path}.projectId`);
  if (!projectId.ok) return projectId;
  const sourceNodeSha = primitive(makeGitCommitSha(record.value.sourceNodeSha, `${path}.sourceNodeSha`), `${path}.sourceNodeSha`);
  if (!sourceNodeSha.ok) return sourceNodeSha;
  const sourcePayloadDigest = primitive(makeNodePayloadDigest(record.value.sourcePayloadDigest), `${path}.sourcePayloadDigest`);
  if (!sourcePayloadDigest.ok) return sourcePayloadDigest;
  const sourcePlanDigest = primitive(makeNodePlanDigest(record.value.sourcePlanDigest), `${path}.sourcePlanDigest`);
  if (!sourcePlanDigest.ok) return sourcePlanDigest;
  const proposedPlan = decodeNodePlan(record.value.proposedPlan, runnerTypes, `${path}.proposedPlan`);
  if (!proposedPlan.ok) return proposedPlan;
  const proposedPlanDigest = primitive(makeNodePlanDigest(record.value.proposedPlanDigest), `${path}.proposedPlanDigest`);
  if (!proposedPlanDigest.ok) return proposedPlanDigest;
  const expectedStateSha = primitive(makeGitCommitSha(record.value.expectedStateSha, `${path}.expectedStateSha`), `${path}.expectedStateSha`);
  if (!expectedStateSha.ok) return expectedStateSha;
  const summary = primitive(makeEvidenceSummary(record.value.reason, `${path}.reason`), `${path}.reason`);
  if (!summary.ok) return summary;
  const rationale = primitive(makeReason(record.value.reason, `${path}.reason`), `${path}.reason`);
  if (!rationale.ok) return rationale;
  const proposedAt = primitive(makeIsoTimestamp(record.value.proposedAt, `${path}.proposedAt`), `${path}.proposedAt`);
  return proposedAt.ok ? ok({
    id: id.value,
    projectId: projectId.value,
    sourceNodeSha: sourceNodeSha.value,
    sourcePayloadDigest: sourcePayloadDigest.value,
    sourcePlanDigest: sourcePlanDigest.value,
    proposedPlan: proposedPlan.value,
    proposedPlanDigest: proposedPlanDigest.value,
    expectedStateSha: expectedStateSha.value,
    summary: summary.value,
    rationale: rationale.value,
    proposedAt: proposedAt.value
  }) : proposedAt;
}

function decodeCoachingDecision(value: unknown, path: string): Result<CoachingProposalDecision, ProtocolCodecError> {
  if (!isRecord(value) || (value.status !== "confirmed" && value.status !== "rejected")) return invalid(path, "unsupported Coaching decision status");
  const keys = value.status === "confirmed"
    ? ["status", "id", "proposalId", "childNodeSha", "reason", "decidedAt"]
    : ["status", "id", "proposalId", "reason", "decidedAt"];
  const record = exactRecord(value, path, keys);
  if (!record.ok) return record;
  const id = primitive(makeDecisionId(record.value.id), `${path}.id`);
  if (!id.ok) return id;
  const proposalId = primitive(makeCoachingProposalId(record.value.proposalId), `${path}.proposalId`);
  if (!proposalId.ok) return proposalId;
  const reason = primitive(makeReason(record.value.reason, `${path}.reason`), `${path}.reason`);
  if (!reason.ok) return reason;
  const decidedAt = primitive(makeIsoTimestamp(record.value.decidedAt, `${path}.decidedAt`), `${path}.decidedAt`);
  if (!decidedAt.ok) return decidedAt;
  if (value.status === "rejected") return ok({ status: "rejected", id: id.value, proposalId: proposalId.value, reason: reason.value, decidedAt: decidedAt.value });
  const childNodeSha = primitive(makeGitCommitSha(record.value.childNodeSha, `${path}.childNodeSha`), `${path}.childNodeSha`);
  return childNodeSha.ok ? ok({ status: "confirmed", id: id.value, proposalId: proposalId.value, childNodeSha: childNodeSha.value, reason: reason.value, decidedAt: decidedAt.value }) : childNodeSha;
}

function decodeComparison(value: unknown, path: string): Result<AlternativeComparison, ProtocolCodecError> {
  if (!isRecord(value) || (value.type !== "sibling_runs" && value.type !== "coached_how_experiment")) {
    return invalid(`${path}.type`, "unsupported alternative comparison type");
  }
  const record = exactRecord(value, path, value.type === "sibling_runs"
    ? ["type", "id", "projectId", "parentNodeSha", "nodeShas", "findings", "summary", "recordedAt"]
    : ["type", "id", "projectId", "anchorNodeSha", "goalDigest", "nodeShas", "findings", "summary", "recordedAt"]);
  if (!record.ok) return record;
  const id = primitive(makeComparisonId(record.value.id), `${path}.id`);
  if (!id.ok) return id;
  const projectId = primitive(makeProjectId(record.value.projectId), `${path}.projectId`);
  if (!projectId.ok) return projectId;
  const nodeShas = decodeArray(record.value.nodeShas, `${path}.nodeShas`, (item, itemPath) => primitive(makeGitCommitSha(item, itemPath), itemPath));
  if (!nodeShas.ok) return nodeShas;
  const atLeastTwo = primitive(makeAtLeastTwo(nodeShas.value, `${path}.nodeShas`), `${path}.nodeShas`);
  if (!atLeastTwo.ok) return atLeastTwo;
  if (new Set(atLeastTwo.value).size !== atLeastTwo.value.length) return invalid(`${path}.nodeShas`, "comparison Node SHAs must be unique");
  const findings = decodeArray(record.value.findings, `${path}.findings`, decodeComparisonFinding);
  if (!findings.ok) return findings;
  for (const [findingIndex, finding] of findings.value.entries()) {
    const summaryShas = finding.summaries.map(item => item.nodeSha);
    if (summaryShas.length !== atLeastTwo.value.length
      || new Set(summaryShas).size !== summaryShas.length
      || atLeastTwo.value.some(nodeSha => !summaryShas.includes(nodeSha))
    ) {
      return invalid(`${path}.findings[${findingIndex}].summaries`, "must summarize every included result Node exactly once");
    }
  }
  const summary = primitive(makeEvidenceSummary(record.value.summary, `${path}.summary`), `${path}.summary`);
  if (!summary.ok) return summary;
  const recordedAt = primitive(makeIsoTimestamp(record.value.recordedAt, `${path}.recordedAt`), `${path}.recordedAt`);
  if (!recordedAt.ok) return recordedAt;
  if (value.type === "sibling_runs") {
    const parentNodeSha = primitive(makeGitCommitSha(record.value.parentNodeSha, `${path}.parentNodeSha`), `${path}.parentNodeSha`);
    return parentNodeSha.ok ? ok({
      type: "sibling_runs",
      id: id.value,
      projectId: projectId.value,
      parentNodeSha: parentNodeSha.value,
      nodeShas: atLeastTwo.value,
      findings: findings.value,
      summary: summary.value,
      recordedAt: recordedAt.value
    }) : parentNodeSha;
  }
  const anchorNodeSha = primitive(makeGitCommitSha(record.value.anchorNodeSha, `${path}.anchorNodeSha`), `${path}.anchorNodeSha`);
  if (!anchorNodeSha.ok) return anchorNodeSha;
  const goalDigest = primitive(makeGoalDigest(record.value.goalDigest), `${path}.goalDigest`);
  return goalDigest.ok ? ok({
    type: "coached_how_experiment",
    id: id.value,
    projectId: projectId.value,
    anchorNodeSha: anchorNodeSha.value,
    goalDigest: goalDigest.value,
    nodeShas: atLeastTwo.value,
    findings: findings.value,
    summary: summary.value,
    recordedAt: recordedAt.value
  }) : goalDigest;
}

function decodeHistoricalV2Comparison(
  value: unknown,
  path: string
): Result<AlternativeComparison, ProtocolCodecError> {
  const record = exactRecord(value, path, [
    "id", "projectId", "parentNodeSha", "nodeShas", "findings", "summary", "recordedAt"
  ]);
  if (!record.ok) return record;
  const id = primitive(makeComparisonId(record.value.id), `${path}.id`);
  if (!id.ok) return id;
  const projectId = primitive(makeProjectId(record.value.projectId), `${path}.projectId`);
  if (!projectId.ok) return projectId;
  const parentNodeSha = primitive(makeGitCommitSha(record.value.parentNodeSha, `${path}.parentNodeSha`), `${path}.parentNodeSha`);
  if (!parentNodeSha.ok) return parentNodeSha;
  const nodeShas = decodeArray(record.value.nodeShas, `${path}.nodeShas`, (item, itemPath) =>
    primitive(makeGitCommitSha(item, itemPath), itemPath));
  if (!nodeShas.ok) return nodeShas;
  const atLeastTwo = primitive(makeAtLeastTwo(nodeShas.value, `${path}.nodeShas`), `${path}.nodeShas`);
  if (!atLeastTwo.ok) return atLeastTwo;
  if (new Set(atLeastTwo.value).size !== atLeastTwo.value.length) {
    return invalid(`${path}.nodeShas`, "comparison Node SHAs must be unique");
  }
  const findings = decodeArray(record.value.findings, `${path}.findings`, decodeComparisonFinding);
  if (!findings.ok) return findings;
  const summary = primitive(makeEvidenceSummary(record.value.summary, `${path}.summary`), `${path}.summary`);
  if (!summary.ok) return summary;
  const normalizedFindings: ComparisonFinding[] = [];
  for (const [findingIndex, finding] of findings.value.entries()) {
    const summariesByNode = new Map(finding.summaries.map(item => [item.nodeSha, item]));
    if (summariesByNode.size !== finding.summaries.length
      || finding.summaries.some(item => !atLeastTwo.value.includes(item.nodeSha))
    ) {
      return invalid(
        `${path}.findings[${findingIndex}].summaries`,
        "historical comparison summaries must be unique and belong to an included result Node"
      );
    }
    const normalizedSummaries = primitive(makeNonEmptyArray(
      atLeastTwo.value.map(nodeSha => summariesByNode.get(nodeSha) ?? {
        nodeSha,
        summary: summary.value
      }),
      `${path}.findings[${findingIndex}].summaries`
    ), `${path}.findings[${findingIndex}].summaries`);
    if (!normalizedSummaries.ok) return normalizedSummaries;
    normalizedFindings.push({
      subject: finding.subject,
      summaries: normalizedSummaries.value
    });
  }
  const recordedAt = primitive(makeIsoTimestamp(record.value.recordedAt, `${path}.recordedAt`), `${path}.recordedAt`);
  return recordedAt.ok ? ok({
    type: "sibling_runs",
    id: id.value,
    projectId: projectId.value,
    parentNodeSha: parentNodeSha.value,
    nodeShas: atLeastTwo.value,
    findings: normalizedFindings,
    summary: summary.value,
    recordedAt: recordedAt.value
  }) : recordedAt;
}

function decodeComparisonFinding(value: unknown, path: string): Result<ComparisonFinding, ProtocolCodecError> {
  const record = exactRecord(value, path, ["subject", "summaries"]);
  if (!record.ok) return record;
  const subject = primitive(makeNonEmptyText(record.value.subject, `${path}.subject`), `${path}.subject`);
  if (!subject.ok) return subject;
  const summaries = decodeArray(record.value.summaries, `${path}.summaries`, (item, itemPath) => {
    const summaryRecord = exactRecord(item, itemPath, ["nodeSha", "summary"]);
    if (!summaryRecord.ok) return summaryRecord;
    const nodeSha = primitive(makeGitCommitSha(summaryRecord.value.nodeSha, `${itemPath}.nodeSha`), `${itemPath}.nodeSha`);
    if (!nodeSha.ok) return nodeSha;
    const summary = primitive(makeEvidenceSummary(summaryRecord.value.summary, `${itemPath}.summary`), `${itemPath}.summary`);
    return summary.ok ? ok({ nodeSha: nodeSha.value, summary: summary.value }) : summary;
  });
  if (!summaries.ok) return summaries;
  const nonEmpty = primitive(makeNonEmptyArray(summaries.value, `${path}.summaries`), `${path}.summaries`);
  return nonEmpty.ok ? ok({ subject: subject.value, summaries: nonEmpty.value }) : nonEmpty;
}

function decodeAlternativeDecision(value: unknown, path: string): Result<AlternativeDecision, ProtocolCodecError> {
  if (!isRecord(value) || (value.type !== "selection" && value.type !== "rejection")) return invalid(path, "unsupported alternative decision type");
  const keys = value.type === "selection"
    ? ["type", "id", "projectId", "comparisonId", "selectedNodeSha", "rationale", "decidedAt"]
    : ["type", "id", "projectId", "comparisonId", "rejectedNodeShas", "rationale", "decidedAt"];
  const record = exactRecord(value, path, keys);
  if (!record.ok) return record;
  const id = primitive(makeDecisionId(record.value.id), `${path}.id`);
  if (!id.ok) return id;
  const projectId = primitive(makeProjectId(record.value.projectId), `${path}.projectId`);
  if (!projectId.ok) return projectId;
  const comparisonId = primitive(makeComparisonId(record.value.comparisonId), `${path}.comparisonId`);
  if (!comparisonId.ok) return comparisonId;
  const rationale = primitive(makeReason(record.value.rationale, `${path}.rationale`), `${path}.rationale`);
  if (!rationale.ok) return rationale;
  const decidedAt = primitive(makeIsoTimestamp(record.value.decidedAt, `${path}.decidedAt`), `${path}.decidedAt`);
  if (!decidedAt.ok) return decidedAt;
  if (value.type === "selection") {
    const selectedNodeSha = primitive(makeGitCommitSha(record.value.selectedNodeSha, `${path}.selectedNodeSha`), `${path}.selectedNodeSha`);
    return selectedNodeSha.ok ? ok({ type: "selection", id: id.value, projectId: projectId.value, comparisonId: comparisonId.value, selectedNodeSha: selectedNodeSha.value, rationale: rationale.value, decidedAt: decidedAt.value } satisfies SelectionDecision) : selectedNodeSha;
  }
  const rejected = decodeArray(record.value.rejectedNodeShas, `${path}.rejectedNodeShas`, (item, itemPath) => primitive(makeGitCommitSha(item, itemPath), itemPath));
  if (!rejected.ok) return rejected;
  const nonEmpty = primitive(makeNonEmptyArray(rejected.value, `${path}.rejectedNodeShas`), `${path}.rejectedNodeShas`);
  if (!nonEmpty.ok) return nonEmpty;
  if (new Set(nonEmpty.value).size !== nonEmpty.value.length) return invalid(`${path}.rejectedNodeShas`, "rejected Node SHAs must be unique");
  return ok({ type: "rejection", id: id.value, projectId: projectId.value, comparisonId: comparisonId.value, rejectedNodeShas: nonEmpty.value, rationale: rationale.value, decidedAt: decidedAt.value } satisfies RejectionDecision);
}

function decodeProcessedCommand(value: unknown, path: string): Result<ProcessedCommand, ProtocolCodecError> {
  const record = exactRecord(value, path, ["idempotencyKey", "fingerprint", "eventIds"]);
  if (!record.ok) return record;
  const idempotencyKey = primitive(makeIdempotencyKey(record.value.idempotencyKey), `${path}.idempotencyKey`);
  if (!idempotencyKey.ok) return idempotencyKey;
  const fingerprint = primitive(makeCommandFingerprint(record.value.fingerprint), `${path}.fingerprint`);
  if (!fingerprint.ok) return fingerprint;
  const eventIds = decodeArray(record.value.eventIds, `${path}.eventIds`, (item, itemPath) => primitive(makeEventId(item), itemPath));
  if (!eventIds.ok) return eventIds;
  const nonEmpty = primitive(makeNonEmptyArray(eventIds.value, `${path}.eventIds`), `${path}.eventIds`);
  return nonEmpty.ok ? ok({ idempotencyKey: idempotencyKey.value, fingerprint: fingerprint.value, eventIds: nonEmpty.value }) : nonEmpty;
}

function decodeEventMetadata(value: unknown, path: string): Result<EventMetadata, ProtocolCodecError> {
  const record = exactRecord(value, path, ["eventId", "idempotencyKey", "fingerprint", "actor", "recordedAt"]);
  if (!record.ok) return record;
  const eventId = primitive(makeEventId(record.value.eventId), `${path}.eventId`);
  if (!eventId.ok) return eventId;
  const idempotencyKey = primitive(makeIdempotencyKey(record.value.idempotencyKey), `${path}.idempotencyKey`);
  if (!idempotencyKey.ok) return idempotencyKey;
  const fingerprint = primitive(makeCommandFingerprint(record.value.fingerprint), `${path}.fingerprint`);
  if (!fingerprint.ok) return fingerprint;
  const actor = decodeActor(record.value.actor, `${path}.actor`);
  if (!actor.ok) return actor;
  const recordedAt = primitive(makeIsoTimestamp(record.value.recordedAt, `${path}.recordedAt`), `${path}.recordedAt`);
  return recordedAt.ok ? ok({ eventId: eventId.value, idempotencyKey: idempotencyKey.value, fingerprint: fingerprint.value, actor: actor.value, recordedAt: recordedAt.value }) : recordedAt;
}

function decodeActor(value: unknown, path: string): Result<DomainActor, ProtocolCodecError> {
  if (!isRecord(value) || typeof value.type !== "string") return invalid(path, "actor must be a typed object");
  if (value.type === "system") {
    const record = exactRecord(value, path, ["type"]);
    return record.ok ? ok({ type: "system" }) : record;
  }
  if (value.type !== "user" && value.type !== "coach" && value.type !== "plugin") return invalid(`${path}.type`, "unsupported actor type");
  const record = exactRecord(value, path, ["type", "id"]);
  if (!record.ok) return record;
  const id = primitive(makeNonEmptyText(record.value.id, `${path}.id`), `${path}.id`);
  if (!id.ok) return id;
  if (value.type === "user") return ok({ type: "user", id: id.value });
  if (value.type === "coach") return ok({ type: "coach", id: id.value });
  return ok({ type: "plugin", id: id.value });
}

function sameRunnerType(left: RunnerTypeLock, right: RunnerTypeLock): boolean {
  return left.origin === right.origin
    && left.key === right.key
    && left.schemaVersion === right.schemaVersion
    && left.integrity === right.integrity;
}

function parseJson(text: string): Result<unknown, ProtocolCodecError> {
  try {
    return ok(JSON.parse(text) as unknown);
  } catch (error) {
    return invalid("$", "Invalid JSON: " + (error instanceof Error ? error.message : String(error)));
  }
}

function stringifyCanonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stringifyCanonical).join(",")}]`;
  if (!isRecord(value)) throw new TypeError("Cannot canonicalize non-JSON value");
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stringifyCanonical(value[key])}`).join(",")}}`;
}

function exactRecord(value: unknown, path: string, keys: readonly string[]): Result<Record<string, unknown>, ProtocolCodecError> {
  if (!isRecord(value)) return invalid(path, "value must be an object");
  const allowed = new Set(keys);
  const unknown = Object.keys(value).filter(key => !allowed.has(key)).sort();
  if (unknown.length > 0) return invalid(path, `unsupported keys: ${unknown.join(", ")}`);
  const missing = keys.filter(key => !Object.hasOwn(value, key));
  if (missing.length > 0) return invalid(path, `missing keys: ${missing.join(", ")}`);
  return ok(value);
}

function decodeArray<T>(
  value: unknown,
  path: string,
  decode: (item: unknown, path: string) => Result<T, ProtocolCodecError>
): Result<readonly T[], ProtocolCodecError> {
  if (!Array.isArray(value)) return invalid(path, "value must be an array");
  const items: T[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = decode(value[index], `${path}[${index}]`);
    if (!item.ok) return item;
    items.push(item.value);
  }
  return ok(items);
}

function oneOf<const Values extends readonly string[]>(value: unknown, values: Values, path: string): Result<Values[number], ProtocolCodecError> {
  return typeof value === "string" && values.includes(value)
    ? ok(value as Values[number])
    : invalid(path, `value must be one of ${values.join(", ")}`);
}

function primitive<T, E extends { readonly message: string }>(
  value: Result<T, E>,
  path: string
): Result<T, ProtocolCodecError> {
  return value.ok ? ok(value.value) : invalid(path, value.error.message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(path: string, message: string): Result<never, ProtocolCodecError> {
  return err({ type: "ProtocolCodecError", path, message });
}

const SHA256_INITIAL = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
] as const;

const SHA256_ROUND = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
] as const;

function sha256Hex(value: string): string {
  const bytes = utf8Bytes(value);
  const bitLength = BigInt(bytes.length) * 8n;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  for (let shift = 56n; shift >= 0n; shift -= 8n) bytes.push(Number((bitLength >> shift) & 0xffn));
  const hash: number[] = [...SHA256_INITIAL];
  const words = new Array<number>(64).fill(0);
  for (let offset = 0; offset < bytes.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      const start = offset + index * 4;
      words[index] = ((bytes[start]! << 24) | (bytes[start + 1]! << 16) | (bytes[start + 2]! << 8) | bytes[start + 3]!) >>> 0;
    }
    for (let index = 16; index < 64; index += 1) {
      const previous15 = words[index - 15]!;
      const previous2 = words[index - 2]!;
      const sigma0 = rotateRight(previous15, 7) ^ rotateRight(previous15, 18) ^ (previous15 >>> 3);
      const sigma1 = rotateRight(previous2, 17) ^ rotateRight(previous2, 19) ^ (previous2 >>> 10);
      words[index] = (words[index - 16]! + sigma0 + words[index - 7]! + sigma1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = hash as [number, number, number, number, number, number, number, number];
    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choose = (e & f) ^ (~e & g);
      const temporary1 = (h + sum1 + choose + SHA256_ROUND[index]! + words[index]!) >>> 0;
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temporary2 = (sum0 + majority) >>> 0;
      h = g; g = f; f = e; e = (d + temporary1) >>> 0; d = c; c = b; b = a; a = (temporary1 + temporary2) >>> 0;
    }
    hash[0] = (hash[0]! + a) >>> 0; hash[1] = (hash[1]! + b) >>> 0;
    hash[2] = (hash[2]! + c) >>> 0; hash[3] = (hash[3]! + d) >>> 0;
    hash[4] = (hash[4]! + e) >>> 0; hash[5] = (hash[5]! + f) >>> 0;
    hash[6] = (hash[6]! + g) >>> 0; hash[7] = (hash[7]! + h) >>> 0;
  }
  return hash.map(word => word.toString(16).padStart(8, "0")).join("");
}

function rotateRight(value: number, count: number): number {
  return (value >>> count) | (value << (32 - count));
}

function utf8Bytes(value: string): number[] {
  const bytes: number[] = [];
  for (const symbol of value) {
    const codePoint = symbol.codePointAt(0)!;
    if (codePoint <= 0x7f) bytes.push(codePoint);
    else if (codePoint <= 0x7ff) bytes.push(0xc0 | (codePoint >>> 6), 0x80 | (codePoint & 0x3f));
    else if (codePoint <= 0xffff) bytes.push(0xe0 | (codePoint >>> 12), 0x80 | ((codePoint >>> 6) & 0x3f), 0x80 | (codePoint & 0x3f));
    else bytes.push(0xf0 | (codePoint >>> 18), 0x80 | ((codePoint >>> 12) & 0x3f), 0x80 | ((codePoint >>> 6) & 0x3f), 0x80 | (codePoint & 0x3f));
  }
  return bytes;
}
