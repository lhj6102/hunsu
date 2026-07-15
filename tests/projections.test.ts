import assert from "node:assert/strict";
import test from "node:test";
import {
  eventListProjection,
  nodeDetailProjection,
  projectGraphProjection,
  projectListProjection,
  runDetailProjection,
  type ProjectionContext,
  type ProjectionResult
} from "../packages/projections/src/index.ts";
import {
  NODE_PLAN_SCHEMA,
  NODE_PAYLOAD_SCHEMA,
  RUNNER_VALUE_SCHEMA,
  computeGoalDigest,
  computeNodePayloadDigest,
  computeNodePlanDigest,
  computeRunnerDigest,
  makeAcceptanceCriterion,
  makeCoachingProposalId,
  makeCommandFingerprint,
  makeComparisonId,
  makeDecisionId,
  makeDesiredOutcome,
  makeEventId,
  makeEvidenceId,
  makeEvidenceSummary,
  makeGitCommitSha,
  makeGitRef,
  makeGitTreeSha,
  makeGoalConstraint,
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
  makeRunId,
  makeRunnerSchemaVersion,
  makeRunnerTypeIntegrity,
  makeRunnerTypeKey,
  makeRunnerTypeOrigin,
  makeWorkspaceId,
  managedNodeRef,
  runBranchName,
  type AlternativeComparison,
  type CoachingChildNode,
  type CoachingProposal,
  type CompletedRun,
  type ConfirmedCoachingProposalDecision,
  type DomainActor,
  type DomainEvent,
  type EventMetadata,
  type EvidenceRef,
  type GoalValue,
  type NodePlan,
  type Project,
  type ProjectState,
  type RejectionDecision,
  type Result,
  type RootNode,
  type RunChildNode,
  type RunnerValue,
  type RunningRun,
  type SelectionDecision
} from "../packages/protocol/src/index.ts";

const fixture = buildFixture();

test("Graph projects one root, rightward Run edges, downward Coaching edges, and no active-Run edge", () => {
  const graph = projectionValue(projectGraphProjection(
    fixture.state,
    fixture.project.id,
    fixture.context,
    { limit: 300, cursor: null }
  ));

  assert.equal(graph.project.rootNodeSha, fixture.root.commitSha);
  assert.deepEqual(
    fixture.state.nodes.filter(node => node.type === "root").map(node => node.commitSha),
    [fixture.root.commitSha]
  );
  assert.equal(graph.integrity.status, "valid");
  assert.equal(graph.nodes.length, 4);

  const runEdges = graph.edges.filter(edge => edge.kind === "run");
  assert.deepEqual(runEdges.map(edge => [edge.sourceSha, edge.targetSha]), [
    [fixture.root.commitSha, fixture.runChildA.commitSha],
    [fixture.root.commitSha, fixture.runChildB.commitSha]
  ]);
  assert.ok(runEdges.every(edge => edge.goal.digest === computeGoalDigest(fixture.goalA)));

  const coachingEdge = graph.edges.find(edge => edge.kind === "coaching");
  assert.deepEqual(coachingEdge && {
    sourceSha: coachingEdge.sourceSha,
    targetSha: coachingEdge.targetSha,
    proposalId: coachingEdge.proposalId
  }, {
    sourceSha: fixture.root.commitSha,
    targetSha: fixture.coachingChild.commitSha,
    proposalId: fixture.proposal.id
  });

  assert.deepEqual(graph.activeRuns.map(run => run.id), [fixture.activeRun.id]);
  assert.equal(graph.edges.some(edge => edge.id.includes(String(fixture.activeRun.id))), false);
});

test("Graph pagination returns deterministic, non-overlapping Node windows", () => {
  const first = projectionValue(projectGraphProjection(
    fixture.state,
    fixture.project.id,
    fixture.context,
    { limit: 2, cursor: null }
  ));
  assert.equal(first.window.limit, 2);
  assert.equal(first.window.hasMore, true);
  assert.equal(first.window.continuationCursor, "2");

  const second = projectionValue(projectGraphProjection(
    fixture.state,
    fixture.project.id,
    fixture.context,
    { limit: 2, cursor: first.window.continuationCursor }
  ));
  assert.equal(second.window.hasMore, false);
  assert.equal(second.window.continuationCursor, null);

  const allShas = [...first.nodes, ...second.nodes].map(node => node.sha);
  assert.equal(new Set(allShas).size, 4);
  assert.deepEqual(allShas, [
    fixture.root.commitSha,
    fixture.runChildA.commitSha,
    fixture.runChildB.commitSha,
    fixture.coachingChild.commitSha
  ]);
});

test("Node detail exposes the actual immutable Runner Value and Node-scoped activity", () => {
  const detail = projectionValue(nodeDetailProjection(
    fixture.state,
    fixture.project.id,
    fixture.coachingChild.commitSha,
    fixture.context
  ));

  assert.equal(detail.lineage.kind, "coaching_child");
  assert.equal(detail.payloadDigest, fixture.coachingChild.payloadDigest);
  assert.equal(detail.planDigest, fixture.coachingChild.planDigest);
  assert.equal(detail.plan.how.name, "Custom Matrix Runner");
  assert.equal(detail.plan.how.typeKey, "matrix/orchestrator");
  assert.equal(detail.plan.how.schemaVersion, "2.3.0");
  assert.equal(detail.plan.how.digest, computeRunnerDigest(fixture.customRunner));
  assert.deepEqual(detail.plan.how.value, {
    concurrency: 3,
    strategy: "evidence-first"
  });
  assert.deepEqual(detail.plan.nextGoals.map(goal => goal.title), [fixture.goalC.title]);
  assert.deepEqual(detail.activeRuns.map(run => run.id), [fixture.activeRun.id]);
  assert.equal(detail.outgoingEdges.length, 0, "an active Run is inspector state, not a dangling edge");
});

test("Run child Node detail includes evidence from the incoming completed Run", () => {
  const detail = projectionValue(nodeDetailProjection(
    fixture.state,
    fixture.project.id,
    fixture.runChildA.commitSha,
    fixture.context
  ));

  assert.equal(detail.payloadDigest, fixture.runChildA.payloadDigest);
  assert.deepEqual(detail.evidence.map(item => item.id), [fixture.evidence.id]);
});

test("A target SHA represented with two structural parents is surfaced as an integrity error", () => {
  const duplicateTargetWithAnotherParent: RunChildNode = {
    ...fixture.runChildA,
    parentSha: fixture.coachingChild.commitSha
  };
  const invalidState: ProjectState = {
    ...fixture.state,
    nodes: [...fixture.state.nodes, duplicateTargetWithAnotherParent]
  };
  assert.equal(invalidState.nodes.length, 5);
  assert.equal(invalidState.nodes[1]?.commitSha, invalidState.nodes[4]?.commitSha);
  assert.equal(
    invalidState.nodes.filter(node => node.projectId === fixture.project.id).length,
    5
  );
  const item = projectListProjection([{ state: invalidState, context: fixture.context }])[0];
  assert.equal(item?.integrity.status, "invalid");
  if (item?.integrity.status === "invalid") assert.equal(item.integrity.code, "duplicate_node");

  const graph = projectionValue(projectGraphProjection(
    invalidState,
    fixture.project.id,
    fixture.context,
    { limit: 300, cursor: null }
  ));
  assert.equal(graph.integrity.status, "invalid");
  if (graph.integrity.status === "invalid") {
    assert.equal(graph.integrity.code, "duplicate_node");
    assert.match(graph.integrity.message, /registered more than once/u);
  }

});

test("Sibling Run Nodes count as unresolved divergence until decisions decorate them", () => {
  const undecidedState: ProjectState = { ...fixture.state, decisions: [] };
  const undecided = projectListProjection([{ state: undecidedState, context: fixture.context }])[0];
  assert.equal(undecided?.unresolvedDivergenceCount, 1);

  const selectedWithoutRejections: ProjectState = { ...fixture.state, decisions: [fixture.selection] };
  const partiallyDecided = projectListProjection([{ state: selectedWithoutRejections, context: fixture.context }])[0];
  assert.equal(
    partiallyDecided?.unresolvedDivergenceCount,
    1,
    "selection alone does not dispose the remaining sibling alternatives"
  );

  const resolved = projectListProjection([{ state: fixture.state, context: fixture.context }])[0];
  assert.equal(resolved?.unresolvedDivergenceCount, 0);

  const graph = projectionValue(projectGraphProjection(
    fixture.state,
    fixture.project.id,
    fixture.context,
    { limit: 300, cursor: null }
  ));
  assert.equal(graph.nodes.find(node => node.sha === fixture.runChildA.commitSha)?.status, "rejected");
  assert.equal(graph.nodes.find(node => node.sha === fixture.runChildB.commitSha)?.status, "selected");

  const rejected = projectionValue(nodeDetailProjection(
    fixture.state,
    fixture.project.id,
    fixture.runChildA.commitSha,
    fixture.context
  ));
  assert.deepEqual(rejected.decisions.map(decision => decision.kind), ["rejected"]);

  const selected = projectionValue(nodeDetailProjection(
    fixture.state,
    fixture.project.id,
    fixture.runChildB.commitSha,
    fixture.context
  ));
  assert.deepEqual(selected.decisions.map(decision => decision.kind), ["selected"]);
  assert.deepEqual(selected.comparisons.map(comparison => comparison.id), [fixture.comparison.id]);
  assert.deepEqual(selected.comparisons[0]?.nodeShas, [fixture.runChildA.commitSha, fixture.runChildB.commitSha]);
  assert.equal(selected.comparisons[0]?.disposition.type, "decisions_recorded");

  const root = projectionValue(nodeDetailProjection(
    fixture.state,
    fixture.project.id,
    fixture.root.commitSha,
    fixture.context
  ));
  assert.deepEqual(root.coachingProposals.map(proposal => ({
    id: proposal.id,
    sourcePayloadDigest: proposal.sourcePayloadDigest,
    sourcePlanDigest: proposal.sourcePlanDigest,
    proposedPlanDigest: proposal.proposedPlanDigest,
    summary: proposal.summary,
    rationale: proposal.rationale,
    disposition: proposal.disposition.type
  })), [{
    id: fixture.proposal.id,
    sourcePayloadDigest: fixture.root.payloadDigest,
    sourcePlanDigest: fixture.root.planDigest,
    proposedPlanDigest: fixture.proposal.proposedPlanDigest,
    summary: fixture.proposal.summary,
    rationale: fixture.proposal.rationale,
    disposition: "confirmed"
  }]);
});

test("decisions are scoped by Project when repositories share the same commit SHAs", () => {
  const projectId = must(makeProjectId("production-trial-copy"));
  const project: Project = {
    ...fixture.project,
    id: projectId,
    title: must(makeProjectTitle("Production Trial Copy"))
  };
  const nodes = fixture.state.nodes.map(node => ({
    ...node,
    projectId,
    managedRef: managedNodeRef(projectId, node.commitSha),
    payloadDigest: computeNodePayloadDigest({
      schema: NODE_PAYLOAD_SCHEMA,
      projectId,
      commitSha: node.commitSha,
      treeSha: node.treeSha,
      plan: node.plan
    })
  }));
  const state: ProjectState = {
    ...fixture.state,
    projects: [fixture.project, project],
    nodes: [...fixture.state.nodes, ...nodes]
  };

  const graph = projectionValue(projectGraphProjection(
    state,
    projectId,
    fixture.context,
    { limit: 300, cursor: null }
  ));
  assert.equal(graph.nodes.find(node => node.sha === fixture.runChildA.commitSha)?.status, "available");
  assert.equal(graph.nodes.find(node => node.sha === fixture.runChildB.commitSha)?.status, "available");

  const item = projectListProjection([{ state, context: fixture.context }])
    .find(candidate => candidate.id === projectId);
  assert.equal(item?.unresolvedDivergenceCount, 1);

  const detail = projectionValue(nodeDetailProjection(
    state,
    projectId,
    fixture.runChildA.commitSha,
    fixture.context
  ));
  assert.deepEqual(detail.decisions, []);
});

test("Run detail binds the one Goal snapshot, source Node, and immutable evidence", () => {
  const detail = projectionValue(runDetailProjection(
    fixture.state,
    fixture.project.id,
    fixture.completedRunA.id
  ));

  assert.equal(detail.run.status, "completed");
  assert.equal(detail.sourceNodeTitle, fixture.root.commitTitle);
  assert.equal(detail.run.goalDigest, computeGoalDigest(fixture.goalA));
  assert.equal(detail.run.runnerDigest, computeRunnerDigest(fixture.defaultRunner));
  assert.deepEqual(detail.evidence.map(evidence => evidence.id), [fixture.evidence.id]);
  assert.equal(detail.evidence[0]?.target.type, "criterion");
});

test("Event projection preserves sequence, typed summaries, actors, and Graph deep-link targets", () => {
  const user: DomainActor = { type: "user", id: text("qa-user") };
  const plugin: DomainActor = { type: "plugin", id: text("hunsu-plugin") };
  const events: readonly { sequence: number; event: DomainEvent; actor: DomainActor }[] = [
    {
      sequence: 41,
      actor: plugin,
      event: {
        type: "RunStarted",
        meta: eventMeta("event-run-started", "c", fixture.activeRun.startedAt, plugin),
        run: fixture.activeRun
      }
    },
    {
      sequence: 42,
      actor: plugin,
      event: {
        type: "RunCompleted",
        meta: eventMeta("event-run-completed", "d", fixture.completedRunA.completedAt, plugin),
        result: {
          runId: fixture.completedRunA.id,
          branch: fixture.completedRunA.branch,
          resultSha: fixture.completedRunA.resultNodeSha,
          verifiedAt: fixture.completedRunA.verifiedAt
        }
      }
    },
    {
      sequence: 43,
      actor: user,
      event: {
        type: "AlternativeSelected",
        meta: eventMeta("event-alternative-selected", "e", fixture.selection.decidedAt, user),
        decision: fixture.selection
      }
    }
  ];

  const projected = eventListProjection(fixture.state, events);
  assert.deepEqual(projected.map(event => event.sequence), [41, 42, 43]);
  assert.deepEqual(projected.map(event => event.type), [
    "RunStarted",
    "RunCompleted",
    "AlternativeSelected"
  ]);
  assert.deepEqual(projected.map(event => event.actor.label), ["Plugin", "Plugin", "User"]);
  assert.deepEqual(projected[0]?.reference, {
    kind: "run",
    runId: fixture.activeRun.id,
    sourceNodeSha: fixture.coachingChild.commitSha,
    target: { kind: "pending" }
  });
  assert.deepEqual(projected[1]?.reference, {
    kind: "run",
    runId: fixture.completedRunA.id,
    sourceNodeSha: fixture.root.commitSha,
    target: { kind: "registered", nodeSha: fixture.runChildA.commitSha }
  });
  assert.deepEqual(projected[2]?.reference, {
    kind: "node",
    nodeSha: fixture.runChildB.commitSha
  });
  assert.match(projected[2]?.summary ?? "", /^Selected Node /u);
});

function buildFixture() {
  const projectId = must(makeProjectId("production-trial"));
  const workspaceId = must(makeWorkspaceId("workspace-qa"));
  const rootSha = sha("1");
  const runChildASha = sha("2");
  const runChildBSha = sha("3");
  const coachingChildSha = sha("4");
  const rootTreeSha = tree("a");
  const runChildATreeSha = tree("b");
  const runChildBTreeSha = tree("c");
  const t0 = timestamp("2026-07-15T00:00:00Z");
  const t1 = timestamp("2026-07-15T00:01:00Z");
  const t2 = timestamp("2026-07-15T00:02:00Z");
  const t3 = timestamp("2026-07-15T00:03:00Z");
  const t4 = timestamp("2026-07-15T00:04:00Z");
  const t5 = timestamp("2026-07-15T00:05:00Z");
  const t6 = timestamp("2026-07-15T00:06:00Z");

  const goalA = goal("validate-production", "Validate production evidence", 100);
  const goalB = goal("improve-retry", "Improve retry resilience", 80);
  const goalC = goal("verify-coaching", "Verify coached strategy", 90);
  const defaultRunner = runner(
    "Default QA Runner",
    "bundled",
    "team/sequence",
    "1.0.0",
    "a",
    { mode: "sequence", maxRounds: 2 }
  );
  const customRunner = runner(
    "Custom Matrix Runner",
    "acme.qa",
    "matrix/orchestrator",
    "2.3.0",
    "b",
    { concurrency: 3, strategy: "evidence-first" }
  );
  const rootPlan: NodePlan = {
    schema: NODE_PLAN_SCHEMA,
    nextGoals: [goalA, goalB],
    how: defaultRunner
  };
  const runChildPlan: NodePlan = {
    schema: NODE_PLAN_SCHEMA,
    nextGoals: [goalB],
    how: defaultRunner
  };
  const coachingPlan: NodePlan = {
    schema: NODE_PLAN_SCHEMA,
    nextGoals: [goalC],
    how: customRunner
  };

  const project: Project = {
    id: projectId,
    workspaceId,
    repository: {
      owner: must(makeRepositoryOwner("lhj6102")),
      name: must(makeRepositoryName("hunsu-production-trial"))
    },
    baseRef: must(makeGitRef("refs/heads/main")),
    title: must(makeProjectTitle("Production Trial")),
    rootNodeSha: rootSha,
    createdAt: t0
  };
  const root: RootNode = {
    type: "root",
    projectId,
    commitSha: rootSha,
    treeSha: rootTreeSha,
    managedRef: managedNodeRef(projectId, rootSha),
    commitTitle: text("Base node"),
    plan: rootPlan,
    planDigest: computeNodePlanDigest(rootPlan),
    payloadDigest: computeNodePayloadDigest({
      schema: NODE_PAYLOAD_SCHEMA,
      projectId,
      commitSha: rootSha,
      treeSha: rootTreeSha,
      plan: rootPlan
    }),
    registeredAt: t0
  };

  const completedRunAId = must(makeRunId("run-a"));
  const completedRunBId = must(makeRunId("run-b"));
  const evidenceId = must(makeEvidenceId("evidence-a"));
  const completedRunA: CompletedRun = {
    id: completedRunAId,
    projectId,
    sourceNodeSha: rootSha,
    goal: goalA,
    goalDigest: computeGoalDigest(goalA),
    runner: defaultRunner,
    runnerDigest: computeRunnerDigest(defaultRunner),
    branch: runBranchName(projectId, rootSha, completedRunAId),
    checkpoints: [],
    evidenceIds: [evidenceId],
    startedAt: t1,
    status: "completed",
    resultNodeSha: runChildASha,
    verifiedAt: t2,
    completedAt: t2
  };
  const completedRunB: CompletedRun = {
    id: completedRunBId,
    projectId,
    sourceNodeSha: rootSha,
    goal: goalA,
    goalDigest: computeGoalDigest(goalA),
    runner: defaultRunner,
    runnerDigest: computeRunnerDigest(defaultRunner),
    branch: runBranchName(projectId, rootSha, completedRunBId),
    checkpoints: [],
    evidenceIds: [],
    startedAt: t1,
    status: "completed",
    resultNodeSha: runChildBSha,
    verifiedAt: t3,
    completedAt: t3
  };
  const runChildA = runChild(
    projectId,
    runChildASha,
    runChildATreeSha,
    rootSha,
    completedRunAId,
    goalA,
    runChildPlan,
    "Verified result A",
    t1
  );
  const runChildB = runChild(
    projectId,
    runChildBSha,
    runChildBTreeSha,
    rootSha,
    completedRunBId,
    goalA,
    runChildPlan,
    "Verified result B",
    t2
  );

  const proposalId = must(makeCoachingProposalId("coach-transition"));
  const proposal: CoachingProposal = {
    id: proposalId,
    projectId,
    sourceNodeSha: rootSha,
    sourcePayloadDigest: root.payloadDigest,
    sourcePlanDigest: root.planDigest,
    proposedPlan: coachingPlan,
    proposedPlanDigest: computeNodePlanDigest(coachingPlan),
    expectedStateSha: sha("f"),
    summary: must(makeEvidenceSummary("Use a custom evidence-first matrix Runner.")),
    rationale: must(makeReason("The custom matrix makes the evidence strategy explicit.")),
    proposedAt: t2
  };
  const coachingChild: CoachingChildNode = {
    type: "coaching_child",
    projectId,
    commitSha: coachingChildSha,
    treeSha: rootTreeSha,
    managedRef: managedNodeRef(projectId, coachingChildSha),
    commitTitle: text("Coach QA strategy"),
    plan: coachingPlan,
    planDigest: computeNodePlanDigest(coachingPlan),
    payloadDigest: computeNodePayloadDigest({
      schema: NODE_PAYLOAD_SCHEMA,
      projectId,
      commitSha: coachingChildSha,
      treeSha: rootTreeSha,
      plan: coachingPlan
    }),
    registeredAt: t3,
    parentSha: rootSha,
    proposalId
  };
  const coachingDecision: ConfirmedCoachingProposalDecision = {
    status: "confirmed",
    id: must(makeDecisionId("confirm-coaching")),
    proposalId,
    childNodeSha: coachingChildSha,
    reason: must(makeReason("Confirmed after reviewing the complete plan.")),
    decidedAt: t3
  };

  const activeRunId = must(makeRunId("run-active"));
  const activeRun: RunningRun = {
    id: activeRunId,
    projectId,
    sourceNodeSha: coachingChildSha,
    goal: goalC,
    goalDigest: computeGoalDigest(goalC),
    runner: customRunner,
    runnerDigest: computeRunnerDigest(customRunner),
    branch: runBranchName(projectId, coachingChildSha, activeRunId),
    checkpoints: [],
    evidenceIds: [],
    startedAt: t4,
    status: "running"
  };

  const evidence: EvidenceRef = {
    id: evidenceId,
    projectId,
    runId: completedRunAId,
    target: { type: "criterion", criterion: goalA.acceptanceCriteria[0] },
    kind: "check",
    summary: must(makeEvidenceSummary("Production acceptance check passed.")),
    location: { type: "url", url: text("https://example.test/evidence/acceptance") },
    recordedAt: t2
  };
  const comparison: AlternativeComparison = {
    type: "sibling_runs",
    id: must(makeComparisonId("comparison-ab")),
    projectId,
    parentNodeSha: rootSha,
    nodeShas: [runChildASha, runChildBSha],
    findings: [{
      subject: text("Acceptance evidence"),
      summaries: [
        { nodeSha: runChildASha, summary: must(makeEvidenceSummary("Complete but broad.")) },
        { nodeSha: runChildBSha, summary: must(makeEvidenceSummary("Complete and focused.")) }
      ]
    }],
    summary: must(makeEvidenceSummary("Result B is the focused alternative.")),
    recordedAt: t5
  };
  const rejection: RejectionDecision = {
    type: "rejection",
    id: must(makeDecisionId("reject-result-a")),
    projectId,
    comparisonId: comparison.id,
    rejectedNodeShas: [runChildASha],
    rationale: must(makeReason("Result A changes unnecessary files.")),
    decidedAt: t6
  };
  const selection: SelectionDecision = {
    type: "selection",
    id: must(makeDecisionId("select-result-b")),
    projectId,
    comparisonId: comparison.id,
    selectedNodeSha: runChildBSha,
    rationale: must(makeReason("Result B has the smallest verified surface.")),
    decidedAt: t6
  };

  const state: ProjectState = {
    projects: [project],
    nodes: [root, runChildA, runChildB, coachingChild],
    runs: [completedRunA, completedRunB, activeRun],
    evidence: [evidence],
    coachReviews: [],
    coachingProposals: [proposal],
    coachingProposalDecisions: [coachingDecision],
    comparisons: [comparison],
    decisions: [rejection, selection],
    processedCommands: []
  };
  const context: ProjectionContext = {
    defaultBranch: "main",
    stateHeadSha: "f".repeat(40),
    synchronizedAt: "2026-07-15T00:07:00Z",
    digestGoal: goalValue => String(computeGoalDigest(goalValue)),
    digestRunner: runnerValue => String(computeRunnerDigest(runnerValue))
  };

  return {
    state,
    context,
    project,
    root,
    runChildA,
    runChildB,
    coachingChild,
    completedRunA,
    activeRun,
    evidence,
    proposal,
    comparison,
    selection,
    goalA,
    goalC,
    defaultRunner,
    customRunner
  };
}

function runChild(
  projectId: Project["id"],
  commitSha: RootNode["commitSha"],
  treeSha: RootNode["treeSha"],
  parentSha: RootNode["commitSha"],
  runId: CompletedRun["id"],
  consumedGoal: GoalValue,
  plan: NodePlan,
  commitTitle: string,
  registeredAt: RootNode["registeredAt"]
): RunChildNode {
  return {
    type: "run_child",
    projectId,
    commitSha,
    treeSha,
    managedRef: managedNodeRef(projectId, commitSha),
    commitTitle: text(commitTitle),
    plan,
    planDigest: computeNodePlanDigest(plan),
    payloadDigest: computeNodePayloadDigest({
      schema: NODE_PAYLOAD_SCHEMA,
      projectId,
      commitSha,
      treeSha,
      plan
    }),
    registeredAt,
    parentSha,
    runId,
    consumedGoalDigest: computeGoalDigest(consumedGoal)
  };
}

function goal(key: string, title: string, priority: number): GoalValue {
  return {
    key: must(makeGoalKey(key)),
    title: must(makeGoalTitle(title)),
    desiredOutcome: must(makeDesiredOutcome(`${title} is demonstrably complete.`)),
    acceptanceCriteria: [must(makeAcceptanceCriterion(`${title} passes its acceptance check.`))],
    constraints: [must(makeGoalConstraint("Do not change main."))],
    priority: must(makeNonNegativeInteger(priority))
  };
}

function runner(
  name: string,
  origin: string,
  key: string,
  schemaVersion: string,
  integritySeed: string,
  value: RunnerValue["value"]
): RunnerValue {
  return {
    schema: RUNNER_VALUE_SCHEMA,
    type: {
      origin: must(makeRunnerTypeOrigin(origin)),
      key: must(makeRunnerTypeKey(key)),
      schemaVersion: must(makeRunnerSchemaVersion(schemaVersion)),
      integrity: must(makeRunnerTypeIntegrity(
        `hunsu-runner-type-v1:sha256:${integritySeed.repeat(64)}`
      ))
    },
    name: text(name),
    value
  };
}

function eventMeta(
  id: string,
  digestSeed: string,
  recordedAt: EventMetadata["recordedAt"],
  actor: DomainActor
): EventMetadata {
  return {
    eventId: must(makeEventId(id)),
    idempotencyKey: must(makeIdempotencyKey(digestSeed.repeat(64))),
    fingerprint: must(makeCommandFingerprint(digestSeed.repeat(64))),
    actor,
    recordedAt
  };
}

function sha(seed: string) {
  return must(makeGitCommitSha(seed.repeat(40)));
}

function tree(seed: string) {
  return must(makeGitTreeSha(seed.repeat(40)));
}

function timestamp(value: string) {
  return must(makeIsoTimestamp(value));
}

function text(value: string) {
  return must(makeNonEmptyText(value));
}

function projectionValue<T>(result: ProjectionResult<T>): T {
  if (!result.ok) assert.fail(result.error.message);
  return result.value;
}

function must<T, E>(result: Result<T, E>): T {
  if (!result.ok) throw new Error(`Fixture primitive was invalid: ${JSON.stringify(result.error)}`);
  return result.value;
}
