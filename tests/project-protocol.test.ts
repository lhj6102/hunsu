import test from "node:test";
import assert from "node:assert/strict";
import {
  PROJECT_EVENT_SCHEMA,
  PROJECT_STATE_SCHEMA,
  RUNNER_VALUE_SCHEMA,
  computeGoalDigest,
  computeNodePayloadDigest,
  computeNodePlanDigest,
  computeRunnerDigest,
  decodeCanonicalJsonValue,
  decodeDomainEvent,
  decodeNodePayloadEnvelope,
  decodeNodePlan,
  decodeProjectState,
  decodeRunnerValue,
  encodeDomainEvent,
  encodeProjectState,
  err,
  makeAcceptanceCriterion,
  makeCommandFingerprint,
  makeCoachingProposalId,
  makeDesiredOutcome,
  makeEventId,
  makeEvidenceId,
  makeEvidenceSummary,
  makeGitCommitSha,
  makeGitRef,
  makeGitTreePath,
  makeGitTreeSha,
  makeGoalKey,
  makeGoalTitle,
  makeIdempotencyKey,
  makeIsoTimestamp,
  makeNonEmptyText,
  makeNonNegativeInteger,
  makeProjectId,
  makeProjectTitle,
  makeReason,
  makeRepositoryName,
  makeRepositoryOwner,
  makeRunnerSchemaVersion,
  makeRunnerTypeIntegrity,
  makeRunnerTypeKey,
  makeRunnerTypeOrigin,
  makeRunId,
  makeWorkspaceId,
  managedNodeRef,
  ok,
  type DomainEvent,
  type CanonicalJsonValue,
  type GoalValue,
  type ProjectState,
  type Result,
  type RunnerTypeLock,
  type RunnerValue,
  type RunnerValueTypeRegistry
} from "../packages/protocol/src/index.ts";

const runnerType: RunnerTypeLock = {
  origin: take(makeRunnerTypeOrigin("hunsu")),
  key: take(makeRunnerTypeKey("custom/qa-swarm")),
  schemaVersion: take(makeRunnerSchemaVersion("1.0.0")),
  integrity: take(makeRunnerTypeIntegrity(`hunsu-runner-type-v1:sha256:${"a".repeat(64)}`))
};

const runnerTypes: RunnerValueTypeRegistry = [{
  type: runnerType,
  decode(value, path) {
    if (!isCanonicalRecord(value)) {
      return err({ type: "RunnerValueDecodeError", path, message: "payload must be an object" });
    }
    const keys = Object.keys(value);
    return keys.length === 1 && keys[0] === "prompt" && typeof value.prompt === "string"
      ? ok(value)
      : err({ type: "RunnerValueDecodeError", path, message: "payload must contain exactly prompt" });
  }
}];

const runner: RunnerValue = {
  schema: RUNNER_VALUE_SCHEMA,
  type: runnerType,
  name: take(makeNonEmptyText("QA swarm")),
  value: { prompt: "Verify production." }
};

const goal: GoalValue = {
  key: take(makeGoalKey("goal_alpha")),
  title: take(makeGoalTitle("Verify production")),
  desiredOutcome: take(makeDesiredOutcome("Production evidence is complete.")),
  acceptanceCriteria: [take(makeAcceptanceCriterion("The result SHA is verified."))],
  constraints: [],
  priority: take(makeNonNegativeInteger(1))
};

const plan = { schema: "hunsu.node-plan.v1" as const, nextGoals: [goal], how: runner };

test("v2 primitives reject unsafe names and Runner type locks are extensible", () => {
  assert.equal(makeProjectId("project-safe").ok, true);
  assert.equal(makeProjectId("project/unsafe").ok, false);
  assert.equal(makeGitRef("refs/tags/hunsu/node/project-safe/" + "a".repeat(40)).ok, true);
  assert.equal(makeGitRef("refs/heads/bad.lock").ok, false);
  assert.equal(makeGitTreePath("evidence/production/report.json").ok, true);
  for (const path of ["/tmp/report.json", "../report.json", "evidence/../report.json", "evidence\\report.json", "evidence//report.json"]) {
    assert.equal(makeGitTreePath(path).ok, false, path);
  }
  assert.equal(makeRunnerSchemaVersion("1.0.0").ok, true);
  assert.equal(makeRunnerSchemaVersion("latest").ok, false);
  assert.equal(makeRunnerTypeKey("custom/my-runner").ok, true);
});

test("canonical v2 digests are stable and domain-separated", () => {
  const reorderedGoal: GoalValue = {
    priority: goal.priority,
    constraints: goal.constraints,
    acceptanceCriteria: goal.acceptanceCriteria,
    desiredOutcome: goal.desiredOutcome,
    title: goal.title,
    key: goal.key
  };
  assert.equal(computeGoalDigest(goal), computeGoalDigest(reorderedGoal));
  assert.equal(computeGoalDigest(goal), "hunsu-goal-v1:sha256:bdf813c6970095559dbd03e804f6f2aa6b9bcb5864dcaa0a577dc1de98578098");
  assert.match(computeGoalDigest(goal), /^hunsu-goal-v1:sha256:[0-9a-f]{64}$/u);
  assert.match(computeRunnerDigest(runner), /^hunsu-runner-v1:sha256:[0-9a-f]{64}$/u);
  assert.match(computeNodePlanDigest(plan), /^hunsu-node-plan-v1:sha256:[0-9a-f]{64}$/u);
  const payload = {
    schema: "hunsu.node-payload.v1" as const,
    projectId: take(makeProjectId("project_alpha")),
    commitSha: take(makeGitCommitSha("a".repeat(40))),
    treeSha: take(makeGitTreeSha("b".repeat(40))),
    plan
  };
  assert.match(computeNodePayloadDigest(payload), /^hunsu-node-payload-v1:sha256:[0-9a-f]{64}$/u);
});

test("Runner and Node plan codecs require an exact registered type decoder", () => {
  assert.deepEqual(decodeRunnerValue(runner, runnerTypes), ok(runner));
  assert.equal(decodeRunnerValue({ ...runner, value: { prompt: "ok", extra: true } }, runnerTypes).ok, false);
  assert.equal(decodeRunnerValue({ ...runner, type: { ...runner.type, key: "custom/unknown" } }, runnerTypes).ok, false);
  assert.deepEqual(decodeNodePlan(plan, runnerTypes), ok(plan));
  assert.equal(decodeNodePlan({ ...plan, nextGoals: [goal, goal] }, runnerTypes).ok, false);
  assert.equal(decodeNodePlan({ ...plan, legacyRunnerId: "runner_alpha" }, runnerTypes).ok, false);
});

test("canonical JSON decoding preserves __proto__ as data without mutating the object prototype", () => {
  const input = JSON.parse('{"__proto__":{"polluted":true},"safe":1}') as unknown;
  const decoded = decodeCanonicalJsonValue(input);
  assert.equal(decoded.ok, true);
  if (!decoded.ok || typeof decoded.value !== "object" || decoded.value === null || Array.isArray(decoded.value)) {
    assert.fail("expected a decoded canonical JSON object");
  }
  assert.deepEqual(Object.keys(decoded.value), ["__proto__", "safe"]);
  assert.equal(Object.hasOwn(decoded.value, "__proto__"), true);
  assert.equal((decoded.value as Record<string, unknown>).polluted, undefined);
  assert.deepEqual((decoded.value as Record<string, unknown>).__proto__, { polluted: true });
});

test("v2 event and state codecs reject v1 schemas and unknown fields", () => {
  const at = take(makeIsoTimestamp("2026-07-14T00:00:00.000Z"));
  const projectId = take(makeProjectId("project_alpha"));
  const event: DomainEvent = {
    type: "ProjectCreated",
    meta: {
      eventId: take(makeEventId("event_alpha")),
      idempotencyKey: take(makeIdempotencyKey("1".repeat(64))),
      fingerprint: take(makeCommandFingerprint("2".repeat(64))),
      actor: { type: "user", id: take(makeNonEmptyText("user-alpha")) },
      recordedAt: at
    },
    project: {
      id: projectId,
      workspaceId: take(makeWorkspaceId("workspace_alpha")),
      repository: { owner: take(makeRepositoryOwner("openai")), name: take(makeRepositoryName("hunsu")) },
      baseRef: take(makeGitRef("refs/heads/main")),
      title: take(makeProjectTitle("Hunsu")),
      rootNodeSha: take(makeGitCommitSha("a".repeat(40))),
      createdAt: at
    }
  };

  const encoded = encodeDomainEvent(event);
  assert.match(encoded, new RegExp(`"schema":"${PROJECT_EVENT_SCHEMA.replaceAll(".", "\\.")}"`, "u"));
  assert.deepEqual(decodeDomainEvent(encoded, runnerTypes), ok(event));
  assert.equal(decodeDomainEvent(encoded.replace(PROJECT_EVENT_SCHEMA, "hunsu.project-event.v1"), runnerTypes).ok, false);

  const rebuilt: DomainEvent = {
    type: "ProjectMaterializationsRebuilt",
    meta: { ...event.meta, eventId: take(makeEventId("event_rebuild")) },
    projectId
  };
  assert.deepEqual(decodeDomainEvent(encodeDomainEvent(rebuilt), runnerTypes), ok(rebuilt));
  const rebuiltWithExtra = JSON.parse(encodeDomainEvent(rebuilt)) as { event: Record<string, unknown> };
  rebuiltWithExtra.event.legacyProjection = true;
  assert.equal(decodeDomainEvent(JSON.stringify(rebuiltWithExtra), runnerTypes).ok, false);

  const unknown = JSON.parse(encoded) as { event: Record<string, unknown> };
  unknown.event.legacy = true;
  assert.equal(decodeDomainEvent(JSON.stringify(unknown), runnerTypes).ok, false);

  const projectObjective = JSON.parse(encoded) as { event: { project: Record<string, unknown> } };
  projectObjective.event.project.objective = "Legacy Project-owned intent";
  assert.equal(decodeDomainEvent(JSON.stringify(projectObjective), runnerTypes).ok, false);

  const treeSha = take(makeGitTreeSha("b".repeat(40)));
  const nodePayload = { schema: "hunsu.node-payload.v1" as const, projectId, commitSha: event.project.rootNodeSha, treeSha, plan };
  const rootNode = {
    type: "root" as const,
    projectId,
    commitSha: event.project.rootNodeSha,
    treeSha,
    managedRef: managedNodeRef(projectId, event.project.rootNodeSha),
    commitTitle: take(makeNonEmptyText("Root node")),
    plan,
    planDigest: computeNodePlanDigest(plan),
    payloadDigest: computeNodePayloadDigest(nodePayload),
    registeredAt: at
  };
  const populated: ProjectState = {
    projects: [event.project], nodes: [rootNode], runs: [], evidence: [], coachReviews: [], coachingProposals: [],
    coachingProposalDecisions: [], comparisons: [], decisions: [], processedCommands: [{
      idempotencyKey: event.meta.idempotencyKey,
      fingerprint: event.meta.fingerprint,
      eventIds: [event.meta.eventId]
    }]
  };
  const encodedState = encodeProjectState(populated);
  assert.match(encodedState, new RegExp(`"schema":"${PROJECT_STATE_SCHEMA.replaceAll(".", "\\.")}"`, "u"));
  assert.deepEqual(decodeProjectState(encodedState, runnerTypes), ok(populated));
  assert.equal(decodeProjectState(encodedState.replace(PROJECT_STATE_SCHEMA, "hunsu.project-state.v1"), runnerTypes).ok, false);

  const coachedPlan = { ...plan, nextGoals: [] };
  const proposalEvent: DomainEvent = {
    type: "CoachingProposalRecorded",
    meta: { ...event.meta, eventId: take(makeEventId("event_proposal")), actor: { type: "coach", id: take(makeNonEmptyText("coach-alpha")) } },
    proposal: {
      id: take(makeCoachingProposalId("proposal_alpha")),
      projectId,
      sourceNodeSha: rootNode.commitSha,
      sourcePayloadDigest: rootNode.payloadDigest,
      sourcePlanDigest: rootNode.planDigest,
      proposedPlan: coachedPlan,
      proposedPlanDigest: computeNodePlanDigest(coachedPlan),
      expectedStateSha: rootNode.commitSha,
      reason: take(makeReason("Consume the completed Goal.")),
      proposedAt: at
    }
  };
  const encodedProposal = encodeDomainEvent(proposalEvent);
  assert.deepEqual(decodeDomainEvent(encodedProposal, runnerTypes), ok(proposalEvent));
  const missingBinding = JSON.parse(encodedProposal) as { event: { proposal: Record<string, unknown> } };
  delete missingBinding.event.proposal.sourcePayloadDigest;
  assert.equal(decodeDomainEvent(JSON.stringify(missingBinding), runnerTypes).ok, false);
  const extraBinding = JSON.parse(encodedProposal) as { event: { proposal: Record<string, unknown> } };
  extraBinding.event.proposal.compatibleStateSha = rootNode.commitSha;
  assert.equal(decodeDomainEvent(JSON.stringify(extraBinding), runnerTypes).ok, false);

  const evidenceEvent: DomainEvent = {
    type: "RunEvidenceAttached",
    meta: { ...event.meta, eventId: take(makeEventId("event_evidence")) },
    evidence: {
      id: take(makeEvidenceId("evidence_alpha")),
      projectId,
      runId: take(makeRunId("run_alpha")),
      target: { type: "run" },
      kind: "report",
      summary: take(makeEvidenceSummary("Immutable production report.")),
      location: {
        type: "git",
        commitSha: rootNode.commitSha,
        path: take(makeGitTreePath("evidence/production/report.json"))
      },
      recordedAt: at
    }
  };
  const encodedEvidence = encodeDomainEvent(evidenceEvent);
  assert.deepEqual(decodeDomainEvent(encodedEvidence, runnerTypes), ok(evidenceEvent));
  for (const path of ["/tmp/report.json", "evidence/../report.json", "evidence\\report.json"]) {
    const invalidPath = JSON.parse(encodedEvidence) as { event: { evidence: { location: { path: string } } } };
    invalidPath.event.evidence.location.path = path;
    assert.equal(decodeDomainEvent(JSON.stringify(invalidPath), runnerTypes).ok, false, path);
  }
});

test("payload envelope decoder enforces exact codec, sizes, and canonical base64", () => {
  const envelope = {
    schema: "hunsu.node-payload-envelope.v1",
    codec: "canonical-json+deterministic-gzip+base64",
    decodedSize: 128,
    encodedSize: 4,
    digest: `hunsu-node-payload-v1:sha256:${"b".repeat(64)}`,
    data: "H4sI"
  };
  assert.equal(decodeNodePayloadEnvelope(envelope).ok, true);
  assert.equal(decodeNodePayloadEnvelope({ ...envelope, encodedSize: 3 }).ok, false);
  assert.equal(decodeNodePayloadEnvelope({ ...envelope, codec: "base64" }).ok, false);
  assert.equal(decodeNodePayloadEnvelope({ ...envelope, data: "not base64" }).ok, false);
  assert.equal(decodeNodePayloadEnvelope({ ...envelope, legacy: true }).ok, false);
});

function take<T, E>(result: Result<T, E>): T {
  if (!result.ok) throw new Error("Fixture construction failed");
  return result.value;
}

function isCanonicalRecord(value: CanonicalJsonValue): value is { readonly [key: string]: CanonicalJsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
