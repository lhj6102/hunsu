import assert from "node:assert/strict";
import test from "node:test";
import { decodeEvents, decodeNodeDetail, decodeProjectGraph } from "../apps/web/src/shared/api/v2Decoders.ts";

const SHA = "1".repeat(40);
const STATE_SHA = "2".repeat(40);
const RUNNER_DIGEST = `hunsu-runner-v1:sha256:${"a".repeat(64)}`;
const RUNNER_INTEGRITY = `hunsu-runner-type-v1:sha256:${"b".repeat(64)}`;
const NODE_PAYLOAD_DIGEST = `hunsu-node-payload-v1:sha256:${"c".repeat(64)}`;
const NODE_PLAN_DIGEST = `hunsu-node-plan-v1:sha256:${"d".repeat(64)}`;
const GOAL_DIGEST = `hunsu-goal-v1:sha256:${"e".repeat(64)}`;

test("v2 Graph presentation DTO decoding is exact", () => {
  const valid = projectGraphDto();
  assert.equal(decodeProjectGraph(valid).ok, true);

  const extraField = { ...valid, legacyGoals: [] };
  const result = decodeProjectGraph(extraField);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "invalid_presentation_dto");
    assert.equal(result.error.path, "$.legacyGoals");
  }

  const legacyObjective = projectGraphDto();
  Object.assign(legacyObjective.project, { objective: "Legacy Project-owned intent" });
  const objectiveResult = decodeProjectGraph(legacyObjective);
  assert.equal(objectiveResult.ok, false);
  if (!objectiveResult.ok) assert.equal(objectiveResult.error.path, "$.project.objective");
});

test("Graph presentation windows are bounded to 300 summary Nodes", () => {
  const oversizedLimit = projectGraphDto();
  oversizedLimit.window.limit = 301;
  const limitResult = decodeProjectGraph(oversizedLimit);
  assert.equal(limitResult.ok, false);
  if (!limitResult.ok) assert.equal(limitResult.error.path, "$.window.limit");

  const overfilledWindow = projectGraphDto();
  overfilledWindow.window.limit = 1;
  overfilledWindow.nodes.push({ ...overfilledWindow.nodes[0]!, sha: "4".repeat(40) });
  const nodesResult = decodeProjectGraph(overfilledWindow);
  assert.equal(nodesResult.ok, false);
  if (!nodesResult.ok) assert.equal(nodesResult.error.path, "$.nodes");
});

test("Graph decoding accepts only completed Run and confirmed Coaching structural edges", () => {
  const activeRun = projectGraphDto();
  activeRun.edges.push({
    kind: "run",
    id: "run-active",
    sourceSha: SHA,
    targetSha: "4".repeat(40),
    runId: "run-active",
    goal: { digest: `hunsu-goal-v1:sha256:${"c".repeat(64)}`, title: "Still running" },
    startedAt: "2026-07-14T07:00:00.000Z"
  });
  const activeResult = decodeProjectGraph(activeRun);
  assert.equal(activeResult.ok, false);
  if (!activeResult.ok) assert.equal(activeResult.error.path, "$.edges[0].startedAt");

  const proposal = projectGraphDto();
  proposal.edges.push({
    kind: "coaching",
    id: "proposal-open",
    sourceSha: SHA,
    targetSha: "4".repeat(40),
    proposalId: "proposal-open",
    summary: "Not confirmed",
    proposedAt: "2026-07-14T07:00:00.000Z"
  });
  const proposalResult = decodeProjectGraph(proposal);
  assert.equal(proposalResult.ok, false);
  if (!proposalResult.ok) assert.equal(proposalResult.error.path, "$.edges[0].proposedAt");
});

test("Runner Value decoding accepts arbitrary canonical JSON and rejects an unprefixed digest", () => {
  const valid = nodeDetailDto();
  const decoded = decodeNodeDetail(valid);
  assert.equal(decoded.ok, true);
  if (decoded.ok) assert.deepEqual(decoded.value.node.plan.how.value, ["custom", 1, true, null]);

  const invalid = nodeDetailDto();
  invalid.node.plan.how.digest = "a".repeat(64);
  const result = decodeNodeDetail(invalid);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.path, "$.node.plan.how.digest");

  const mismatchedTypeKey = nodeDetailDto();
  mismatchedTypeKey.node.plan.how.typeKey = "qa/other";
  const typeKeyResult = decodeNodeDetail(mismatchedTypeKey);
  assert.equal(typeKeyResult.ok, false);
  if (!typeKeyResult.ok) assert.equal(typeKeyResult.error.path, "$.node.plan.how.typeKey");

  const mismatchedSchemaVersion = nodeDetailDto();
  mismatchedSchemaVersion.node.plan.how.schemaVersion = "2.0.0";
  const schemaVersionResult = decodeNodeDetail(mismatchedSchemaVersion);
  assert.equal(schemaVersionResult.ok, false);
  if (!schemaVersionResult.ok) assert.equal(schemaVersionResult.error.path, "$.node.plan.how.schemaVersion");
});

test("Node activity decoding preserves exact Coaching and comparison recovery summaries", () => {
  const valid = nodeDetailDto();
  valid.node.coachingProposals.push({
    id: "proposal-a",
    sourceNodeSha: SHA,
    sourcePayloadDigest: NODE_PAYLOAD_DIGEST,
    sourcePlanDigest: NODE_PLAN_DIGEST,
    proposedPlanDigest: `hunsu-node-plan-v1:sha256:${"f".repeat(64)}`,
    expectedStateSha: STATE_SHA,
    summary: "Use the verified Team How.",
    rationale: "Compare the same Goal under another How.",
    proposedAt: "2026-07-14T07:00:00.000Z",
    disposition: { type: "confirmed", decisionId: "decision-a", childNodeSha: "4".repeat(40), reason: "Approved.", decidedAt: "2026-07-14T07:01:00.000Z" }
  });
  valid.node.coachReviews.push({
    id: "review-a",
    target: { type: "node", nodeSha: SHA },
    assessment: "Evidence is complete.",
    recommendations: ["Compare both results."],
    recordedAt: "2026-07-14T07:02:00.000Z"
  });
  valid.node.comparisons.push({
    type: "coached_how_experiment",
    id: "comparison-a",
    anchorNodeSha: SHA,
    goalDigest: GOAL_DIGEST,
    nodeShas: ["5".repeat(40), "6".repeat(40)],
    summary: "Team produced stronger retry evidence.",
    disposition: {
      type: "decisions_recorded",
      decisions: [{
        id: "decision-b",
        type: "selection",
        comparisonId: "comparison-a",
        nodeShas: ["6".repeat(40)],
        rationale: "Prefer the complete evidence.",
        decidedAt: "2026-07-14T07:03:00.000Z"
      }]
    },
    recordedAt: "2026-07-14T07:02:30.000Z"
  });
  const decoded = decodeNodeDetail(valid);
  assert.equal(decoded.ok, true);
  if (decoded.ok) {
    assert.equal(decoded.value.node.coachingProposals[0]?.disposition.type, "confirmed");
    assert.equal(decoded.value.node.comparisons[0]?.type, "coached_how_experiment");
  }

  const reviewWithoutRecommendations = structuredClone(valid) as any;
  reviewWithoutRecommendations.node.coachReviews[0].recommendations = [];
  assert.equal(decodeNodeDetail(reviewWithoutRecommendations).ok, true);

  const invalid = structuredClone(valid) as any;
  invalid.node.coachingProposals[0].reason = "legacy alias";
  const invalidResult = decodeNodeDetail(invalid);
  assert.equal(invalidResult.ok, false);
  if (!invalidResult.ok) assert.equal(invalidResult.error.path, "$.node.coachingProposals[0].reason");
});

test("Events accept only protocol DomainEvent discriminants", () => {
  const valid = eventsDto();
  assert.equal(decodeEvents(valid).ok, true);

  const invalid = eventsDto();
  invalid.events[0]!.type = "NodeSelected";
  const result = decodeEvents(invalid);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.path, "$.events[0].type");
});

function projectGraphDto() {
  return {
    schema: "hunsu.web.project-graph.v2",
    project: projectSummary(),
    stateHeadSha: STATE_SHA,
    integrity: { status: "valid" },
    nodes: [{
      sha: SHA,
      title: "Root Node",
      status: "current",
      runner: {
        name: "Custom QA Runner",
        typeKey: "qa/custom",
        schemaVersion: "1.0.0",
        digest: RUNNER_DIGEST
      },
      nextGoalCount: 1,
      integrity: "valid"
    }],
    edges: [] as Record<string, unknown>[],
    activeRuns: [],
    window: { limit: 300, hasMore: false, continuationCursor: null }
  };
}

function nodeDetailDto() {
  return {
    schema: "hunsu.web.node-detail.v2",
    stateHeadSha: STATE_SHA,
    node: {
      sha: SHA,
      payloadDigest: NODE_PAYLOAD_DIGEST,
      planDigest: NODE_PLAN_DIGEST,
      title: "Root Node",
      commitUrl: `https://github.com/hunsu/product/commit/${SHA}`,
      treeSha: "3".repeat(40),
      managedRef: `refs/tags/hunsu/node/project-a/${SHA}`,
      integrity: { status: "valid" },
      status: "current",
      lineage: { kind: "root" },
      plan: {
        schema: "hunsu.node-plan.v1",
        nextGoals: [],
        how: {
          schema: "hunsu.runner-value.v1",
          name: "Custom QA Runner",
          typeKey: "qa/custom",
          schemaVersion: "1.0.0",
          digest: RUNNER_DIGEST,
          type: {
            origin: "hunsu.bundled",
            key: "qa/custom",
            schemaVersion: "1.0.0",
            integrity: RUNNER_INTEGRITY
          },
          value: ["custom", 1, true, null]
        }
      },
      outgoingEdges: [],
      activeRuns: [],
      evidence: [],
      comparisons: [] as Record<string, any>[],
      decisions: [],
      coachingProposals: [] as Record<string, any>[],
      coachReviews: [] as Record<string, any>[]
    }
  };
}

function eventsDto() {
  return {
    schema: "hunsu.web.events.v2",
    project: projectSummary(),
    stateHeadSha: STATE_SHA,
    events: [{
      sequence: 1,
      id: "event-a",
      type: "AlternativeSelected",
      summary: "The verified sibling was selected.",
      actor: { id: "user-a", label: "User A" },
      occurredAt: "2026-07-14T07:00:00.000Z",
      reference: { kind: "node", nodeSha: SHA }
    }],
    nextCursor: null
  };
}

function projectSummary() {
  return {
    id: "project-a",
    title: "Production Trial",
    repository: {
      owner: "hunsu",
      name: "product",
      url: "https://github.com/hunsu/product",
      defaultBranch: "main"
    },
    rootNodeSha: SHA
  };
}
