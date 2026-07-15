import test from "node:test";
import assert from "node:assert/strict";
import {
  applyDomainEvent as applyDomainEventWithIntegrity,
  applyProjectCommand as applyProjectCommandWithIntegrity,
  emptyProjectState,
  inheritRunChildPlan,
  replayDomainEvents as replayDomainEventsWithIntegrity,
  unresolvedDivergenceCount,
  validateNodeGraph,
  type ProjectIntegrityBoundary
} from "../packages/core/src/index.ts";
import { decodeNodeEnvelope, encodeNodeEnvelope } from "../packages/github-store/src/index.ts";
import {
  HISTORICAL_PROJECT_EVENT_SCHEMA,
  NODE_PLAN_SCHEMA,
  RUNNER_VALUE_SCHEMA,
  computeGoalDigest,
  computeNodePayloadDigest,
  computeNodePlanDigest,
  computeRunnerDigest,
  decodeDomainEvent,
  encodeDomainEvent,
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
  makeGitTreePath,
  makeGitTreeSha,
  makeGoalDigest,
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
  nodePayloadFor,
  runBranchName,
  type CommandMetadata,
  type CompletedRun,
  type ComparisonId,
  type CoachingProposalId,
  type DomainActor,
  type DomainEvent,
  type GitCommitSha,
  type GitTreeSha,
  type GoalValue,
  type IsoTimestamp,
  type Node,
  type NodePayloadEnvelope,
  type NodePlan,
  type Project,
  type ProjectCommand,
  type ProjectState,
  type Result,
  type RootNode,
  type RunChildNode,
  type RunId,
  type RunnerValue,
  type RunnerValueTypeRegistry
} from "../packages/protocol/src/index.ts";

const integrity: ProjectIntegrityBoundary = {
  verifyNodePayload(expected, payload) {
    const decoded = decodeNodeEnvelope(payload);
    if (!decoded.ok) return { ok: false, error: { message: decoded.error.message } };
    return decoded.value.digest === computeNodePayloadDigest(expected)
      ? { ok: true, value: true }
      : { ok: false, error: { message: "decoded payload does not match the expected Node" } };
  }
};

function applyProjectCommand(state: ProjectState, command: ProjectCommand) {
  return applyProjectCommandWithIntegrity(state, command, integrity);
}

function applyDomainEvent(state: ProjectState, event: DomainEvent) {
  return applyDomainEventWithIntegrity(state, event, integrity);
}

function replayDomainEvents(events: readonly DomainEvent[]) {
  return replayDomainEventsWithIntegrity(events, integrity);
}

test("Commit Node commands enforce one-Goal Runs, Coaching-only plan changes, single-tail topology, and explicit decisions", () => {
  const fixture = makeFixture();
  let state = emptyProjectState();
  const events: DomainEvent[] = [];

  const create: ProjectCommand = {
    type: "CreateProject",
    meta: metadata(1),
    rootNodeEventId: eventId(2),
    project: fixture.project,
    rootNode: fixture.root,
    payload: envelope(fixture.root)
  };
  state = accept(state, create, events);
  assert.equal(state.projects.length, 1);
  assert.equal(state.nodes.length, 1);

  const retried = applyProjectCommand(state, create);
  assert.equal(retried.ok, true);
  if (retried.ok) {
    assert.deepEqual(retried.value.emittedEvents, []);
    assert.deepEqual(retried.value.reusedEventIds, [create.meta.eventId, create.rootNodeEventId]);
  }
  const conflict = applyProjectCommand(state, { ...create, meta: { ...create.meta, fingerprint: fingerprint(999) } });
  assert.equal(conflict.ok, false);
  if (!conflict.ok) assert.equal(conflict.error.code, "IDEMPOTENCY_CONFLICT");

  const wrongGoal = applyProjectCommand(state, {
    type: "StartRun",
    meta: metadata(3, pluginActor()),
    runId: runId("run_wrong_goal"),
    projectId: fixture.project.id,
    sourceNodeSha: fixture.root.commitSha,
    goalDigest: take(makeGoalDigest(`hunsu-goal-v1:sha256:${"f".repeat(64)}`)),
    branch: runBranchName(fixture.project.id, fixture.root.commitSha, runId("run_wrong_goal"))
  });
  assert.equal(wrongGoal.ok, false);
  if (!wrongGoal.ok) assert.match(wrongGoal.error.message, /exactly one Goal/u);

  const firstRunId = runId("run_first");
  state = startRun(state, events, fixture, firstRunId, 4);
  assert.equal(state.runs[0]?.goalDigest, fixture.goalDigest);
  assert.deepEqual(state.runs[0]?.runner, fixture.runner);

  const uncovered = applyProjectCommand(state, completeCommand(state, fixture, firstRunId, sha("b"), tree("2"), 6));
  assert.equal(uncovered.ok, false);
  if (!uncovered.ok) assert.match(uncovered.error.message, /cover every acceptance criterion/u);

  state = attachCriterionEvidence(state, events, fixture, firstRunId, sha("b"), 7);
  state = accept(state, completeCommand(state, fixture, firstRunId, sha("b"), tree("2"), 8), events);
  assert.equal(state.runs.find(run => run.id === firstRunId)?.status, "completed");
  const firstChild = findNode(state, sha("b"));
  assert.equal(firstChild.type, "run_child");
  assert.equal(firstChild.plan.nextGoals.length, 0);
  assert.deepEqual(firstChild.plan.how, fixture.runner);

  const secondRunId = runId("run_second");
  state = startRun(state, events, fixture, secondRunId, 10);
  state = attachCriterionEvidence(state, events, fixture, secondRunId, sha("c"), 11);
  state = accept(state, completeCommand(state, fixture, secondRunId, sha("c"), tree("3"), 12), events);
  assert.equal(unresolvedDivergenceCount(state, fixture.project.id), 1);

  const pendingRejectedSourceProposalId = take(makeCoachingProposalId("proposal_pending_before_rejection"));
  state = accept(state, {
    type: "RecordCoachingProposal",
    meta: metadata(13, { type: "coach", id: text("coach-alpha") }),
    proposal: {
      id: pendingRejectedSourceProposalId,
      projectId: fixture.project.id,
      sourceNodeSha: firstChild.commitSha,
      sourcePayloadDigest: firstChild.payloadDigest,
      sourcePlanDigest: firstChild.planDigest,
      proposedPlan: fixture.root.plan,
      proposedPlanDigest: fixture.root.planDigest,
      expectedStateSha: sha("f"),
      summary: take(makeEvidenceSummary("Restore a Goal before the source decision.")),
      rationale: reason("Verify confirmation revalidates the source disposition."),
      proposedAt: time(13)
    }
  }, events);

  const comparisonId = take(makeComparisonId("comparison_alpha"));
  state = accept(state, {
    type: "CompareAlternatives",
    comparisonType: "sibling_runs",
    meta: metadata(14, { type: "coach", id: text("coach-alpha") }),
    comparisonId,
    projectId: fixture.project.id,
    nodeShas: [sha("b"), sha("c")],
    findings: [{
      subject: text("Production evidence"),
      summaries: [
        { nodeSha: sha("b"), summary: take(makeEvidenceSummary("The first future passes.")) },
        { nodeSha: sha("c"), summary: take(makeEvidenceSummary("The second future passes.")) }
      ]
    }],
    summary: take(makeEvidenceSummary("Both sibling futures are verifiable."))
  }, events);
  assert.equal(state.comparisons[0]?.type, "sibling_runs");

  const pluginRejection = applyProjectCommand(state, {
    type: "RejectAlternatives",
    meta: metadata(15, pluginActor()),
    decisionId: take(makeDecisionId("decision_reject_plugin")),
    projectId: fixture.project.id,
    comparisonId,
    rejectedNodeShas: [sha("b")],
    rationale: reason("Prefer the other future.")
  });
  assert.equal(pluginRejection.ok, false);
  if (!pluginRejection.ok) assert.equal(pluginRejection.error.code, "USER_CONFIRMATION_REQUIRED");

  state = accept(state, {
    type: "RejectAlternatives",
    meta: metadata(16),
    decisionId: take(makeDecisionId("decision_reject_first")),
    projectId: fixture.project.id,
    comparisonId,
    rejectedNodeShas: [sha("b")],
    rationale: reason("The second future has clearer evidence.")
  }, events);
  assert.equal(unresolvedDivergenceCount(state, fixture.project.id), 1);

  const rejectedSourceChild = coachingNode(
    fixture.project,
    firstChild,
    pendingRejectedSourceProposalId,
    fixture.root.plan,
    sha("e"),
    firstChild.treeSha,
    time(17)
  );
  const confirmAfterSourceRejection = applyProjectCommand(state, {
    type: "ConfirmCoachingProposal",
    meta: metadata(17),
    nodeEventId: eventId(117),
    decisionId: take(makeDecisionId("decision_confirm_rejected_source")),
    proposalId: pendingRejectedSourceProposalId,
    reason: reason("Attempt to continue the rejected source."),
    node: rejectedSourceChild,
    payload: envelope(rejectedSourceChild)
  });
  assert.equal(confirmAfterSourceRejection.ok, false);
  if (!confirmAfterSourceRejection.ok) assert.match(confirmAfterSourceRejection.error.message, /Rejected Nodes/u);

  const automaticSelection = applyProjectCommand(state, {
    type: "SelectAlternative",
    meta: metadata(17, pluginActor()),
    decisionId: take(makeDecisionId("decision_select_plugin")),
    projectId: fixture.project.id,
    comparisonId,
    selectedNodeSha: sha("c"),
    rationale: reason("Select automatically.")
  });
  assert.equal(automaticSelection.ok, false);
  if (!automaticSelection.ok) assert.equal(automaticSelection.error.code, "USER_CONFIRMATION_REQUIRED");

  state = accept(state, {
    type: "SelectAlternative",
    meta: metadata(18),
    decisionId: take(makeDecisionId("decision_select_second")),
    projectId: fixture.project.id,
    comparisonId,
    selectedNodeSha: sha("c"),
    rationale: reason("The user selects the stronger future.")
  }, events);
  assert.equal(unresolvedDivergenceCount(state, fixture.project.id), 0);

  const rejectedProposal = applyProjectCommand(state, {
    type: "RecordCoachingProposal",
    meta: metadata(19, { type: "coach", id: text("coach-alpha") }),
    proposal: {
      id: take(makeCoachingProposalId("proposal_rejected_node")),
      projectId: fixture.project.id,
      sourceNodeSha: sha("b"),
      sourcePayloadDigest: firstChild.payloadDigest,
      sourcePlanDigest: firstChild.planDigest,
      proposedPlan: fixture.root.plan,
      proposedPlanDigest: fixture.root.planDigest,
      expectedStateSha: sha("f"),
      summary: take(makeEvidenceSummary("Restore the original plan on the rejected result.")),
      rationale: reason("Attempt to continue a rejected future."),
      proposedAt: time(19)
    }
  });
  assert.equal(rejectedProposal.ok, false);
  if (!rejectedProposal.ok) assert.match(rejectedProposal.error.message, /Rejected Nodes/u);

  const selectedChild = findNode(state, sha("c"));
  const coachedPlan: NodePlan = { ...selectedChild.plan, nextGoals: [fixture.followupGoal] };
  const proposalId = take(makeCoachingProposalId("proposal_followup"));
  state = accept(state, {
    type: "RecordCoachingProposal",
    meta: metadata(20, { type: "coach", id: text("coach-alpha") }),
    proposal: {
      id: proposalId,
      projectId: fixture.project.id,
      sourceNodeSha: selectedChild.commitSha,
      sourcePayloadDigest: selectedChild.payloadDigest,
      sourcePlanDigest: selectedChild.planDigest,
      proposedPlan: coachedPlan,
      proposedPlanDigest: computeNodePlanDigest(coachedPlan),
      expectedStateSha: sha("f"),
      summary: take(makeEvidenceSummary("Add a follow-up resilience Goal.")),
      rationale: reason("Add the next product outcome."),
      proposedAt: time(20)
    }
  }, events);
  assert.equal(state.nodes.length, 3, "a proposal alone creates no Node");
  assert.equal(state.coachingProposals.at(-1)?.summary, "Add a follow-up resilience Goal.");
  assert.equal(state.coachingProposals.at(-1)?.rationale, "Add the next product outcome.");

  const coachingSha = sha("d");
  const wrongTreeNode = coachingNode(fixture.project, selectedChild, proposalId, coachedPlan, coachingSha, tree("9"), time(22));
  const unconfirmed = applyProjectCommand(state, {
    type: "ConfirmCoachingProposal",
    meta: metadata(22, pluginActor()),
    nodeEventId: eventId(23),
    decisionId: take(makeDecisionId("decision_coach_plugin")),
    proposalId,
    reason: reason("Apply without a user."),
    node: wrongTreeNode,
    payload: envelope(wrongTreeNode)
  });
  assert.equal(unconfirmed.ok, false);
  if (!unconfirmed.ok) assert.equal(unconfirmed.error.code, "USER_CONFIRMATION_REQUIRED");

  const correctNode = coachingNode(fixture.project, selectedChild, proposalId, coachedPlan, coachingSha, selectedChild.treeSha, time(24));
  state = accept(state, {
    type: "ConfirmCoachingProposal",
    meta: metadata(24),
    nodeEventId: eventId(25),
    decisionId: take(makeDecisionId("decision_coach_confirm")),
    proposalId,
    reason: reason("Create the coached child Node."),
    node: correctNode,
    payload: envelope(correctNode)
  }, events);
  assert.equal(state.nodes.length, 4);
  assert.equal(findNode(state, coachingSha).type, "coaching_child");
  assert.equal(findNode(state, coachingSha).treeSha, selectedChild.treeSha);

  const noOpProposal = applyProjectCommand(state, {
    type: "RecordCoachingProposal",
    meta: metadata(26, { type: "coach", id: text("coach-alpha") }),
    proposal: {
      id: take(makeCoachingProposalId("proposal_noop")),
      projectId: fixture.project.id,
      sourceNodeSha: coachingSha,
      sourcePayloadDigest: correctNode.payloadDigest,
      sourcePlanDigest: correctNode.planDigest,
      proposedPlan: correctNode.plan,
      proposedPlanDigest: correctNode.planDigest,
      expectedStateSha: sha("f"),
      summary: take(makeEvidenceSummary("Leave the Node Plan unchanged.")),
      rationale: reason("No actual plan change."),
      proposedAt: time(26)
    }
  });
  assert.equal(noOpProposal.ok, false);
  if (!noOpProposal.ok) assert.match(noOpProposal.error.message, /must change/u);

  const tailRunId = runId("run_single_tail_check");
  state = accept(state, {
    type: "StartRun",
    meta: metadata(27, pluginActor()),
    runId: tailRunId,
    projectId: fixture.project.id,
    sourceNodeSha: coachingSha,
    goalDigest: computeGoalDigest(fixture.followupGoal),
    branch: runBranchName(fixture.project.id, coachingSha, tailRunId)
  }, events);
  state = attachCriterionEvidence(state, events, fixture, tailRunId, sha("b"), 28, fixture.followupGoal.acceptanceCriteria[0]);
  const duplicateTail = applyProjectCommand(state, completeCommand(state, fixture, tailRunId, sha("b"), tree("4"), 29));
  assert.equal(duplicateTail.ok, false);
  if (!duplicateTail.ok) assert.equal(duplicateTail.error.code, "DUPLICATE_ID", "one target Node cannot receive a second parent");
  state = accept(state, {
    type: "FailRun",
    meta: metadata(30, pluginActor()),
    runId: tailRunId,
    reason: reason("The duplicate target was rejected.")
  }, events);
  assert.equal(state.nodes.length, 4, "failed Runs create no Node");

  const pluginRebuild = applyProjectCommand(state, {
    type: "RebuildProjectMaterializations",
    meta: metadata(31, pluginActor()),
    projectId: fixture.project.id
  });
  assert.equal(pluginRebuild.ok, false);
  if (!pluginRebuild.ok) assert.equal(pluginRebuild.error.code, "USER_CONFIRMATION_REQUIRED");

  const topologyBeforeRebuild = state.nodes;
  state = accept(state, {
    type: "RebuildProjectMaterializations",
    meta: metadata(32),
    projectId: fixture.project.id
  }, events);
  assert.deepEqual(state.nodes, topologyBeforeRebuild, "a materialization rebuild cannot alter Project topology");
  assert.equal(events.at(-1)?.type, "ProjectMaterializationsRebuilt");

  assert.deepEqual(validateNodeGraph(state), { ok: true, value: true });
  const replayed = replayDomainEvents(events);
  assert.equal(replayed.ok, true);
  if (replayed.ok) assert.deepEqual(replayed.value, state);

  const historicalRunnerTypes = runnerTypesFor(fixture.runner);
  let removedHistoricalSummary = false;
  const historicalEvents = events.map(event => {
    const historical = historicalV2Fixture(event, !removedHistoricalSummary);
    if (event.type === "AlternativesCompared" && event.comparison.type === "sibling_runs") {
      removedHistoricalSummary = true;
    }
    const decoded = decodeDomainEvent(historical, historicalRunnerTypes);
    if (!decoded.ok) assert.fail(`Historical v2 fixture failed at ${decoded.error.path}: ${decoded.error.message}`);
    return decoded.value;
  });
  assert.equal(removedHistoricalSummary, true, "the replay fixture must exercise an incomplete historical finding");
  const historicalReplay = replayDomainEvents(historicalEvents);
  assert.equal(historicalReplay.ok, true);
  if (historicalReplay.ok) {
    const historicalProposal = historicalReplay.value.coachingProposals[0];
    assert.ok(historicalProposal);
    assert.equal(historicalProposal.summary, historicalProposal.rationale);
    const historicalComparison = historicalReplay.value.comparisons[0];
    assert.ok(historicalComparison);
    assert.equal(historicalComparison.type, "sibling_runs");
    assert.deepEqual(
      historicalComparison.findings[0]?.summaries.map(item => item.nodeSha),
      historicalComparison.nodeShas
    );
  }

  const duplicateEvent = applyDomainEvent(state, events[0]!);
  assert.equal(duplicateEvent.ok, false);
  if (!duplicateEvent.ok) assert.equal(duplicateEvent.error.code, "INVALID_EVENT");
});

test("core rejects forged Node envelope bytes even when digest and sizes are copied", () => {
  const fixture = makeFixture();
  const valid = envelope(fixture.root);
  const first = valid.data[0] === "A" ? "B" : "A";
  const forged: NodePayloadEnvelope = {
    ...valid,
    data: `${first}${valid.data.slice(1)}` as NodePayloadEnvelope["data"]
  };
  const result = applyProjectCommand(emptyProjectState(), {
    type: "CreateProject",
    meta: metadata(41),
    rootNodeEventId: eventId(42),
    project: fixture.project,
    rootNode: { ...fixture.root, registeredAt: time(41) },
    payload: forged
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error.message, /envelope verification failed/u);
});

test("Coaching proposals bind the source payload and exact command state head", () => {
  const fixture = makeFixture();
  const created = applyProjectCommand(emptyProjectState(), {
    type: "CreateProject",
    meta: metadata(43),
    rootNodeEventId: eventId(44),
    project: fixture.project,
    rootNode: { ...fixture.root, registeredAt: time(43) },
    payload: envelope({ ...fixture.root, registeredAt: time(43) })
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const changedPlan: NodePlan = { ...fixture.root.plan, nextGoals: [fixture.followupGoal] };
  const baseProposal = {
    id: take(makeCoachingProposalId("proposal_bound_source")),
    projectId: fixture.project.id,
    sourceNodeSha: fixture.root.commitSha,
    sourcePayloadDigest: fixture.root.payloadDigest,
    sourcePlanDigest: fixture.root.planDigest,
    proposedPlan: changedPlan,
    proposedPlanDigest: computeNodePlanDigest(changedPlan),
    expectedStateSha: sha("f"),
    summary: take(makeEvidenceSummary("Bind a follow-up Goal to the complete source Node.")),
    rationale: reason("Bind the complete source Node."),
    proposedAt: time(45)
  };
  const wrongPayload = applyProjectCommand(created.value.state, {
    type: "RecordCoachingProposal",
    meta: metadata(45, { type: "coach", id: text("coach-alpha") }),
    proposal: {
      ...baseProposal,
      sourcePayloadDigest: computeNodePayloadDigest({ ...nodePayloadFor(fixture.root), treeSha: tree("9") })
    }
  });
  assert.equal(wrongPayload.ok, false);
  if (!wrongPayload.ok) assert.match(wrongPayload.error.message, /source payload digest/u);

  const wrongHead = applyProjectCommand(created.value.state, {
    type: "RecordCoachingProposal",
    meta: metadata(46, { type: "coach", id: text("coach-alpha") }),
    proposal: {
      ...baseProposal,
      id: take(makeCoachingProposalId("proposal_wrong_head")),
      expectedStateSha: sha("e")
    }
  });
  assert.equal(wrongHead.ok, false);
  if (!wrongHead.ok) assert.match(wrongHead.error.message, /CAS boundary/u);
});

test("domain replay rejects incomplete and invalid multi-event command batches", () => {
  const fixture = makeFixture();
  const created = applyProjectCommand(emptyProjectState(), {
    type: "CreateProject",
    meta: metadata(47),
    rootNodeEventId: eventId(48),
    project: fixture.project,
    rootNode: { ...fixture.root, registeredAt: time(47) },
    payload: envelope({ ...fixture.root, registeredAt: time(47) })
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const incomplete = replayDomainEvents([created.value.emittedEvents[0]!]);
  assert.equal(incomplete.ok, false);
  if (!incomplete.ok) assert.match(incomplete.error.message, /incomplete or invalid/u);

  const reversed = replayDomainEvents([...created.value.emittedEvents].reverse());
  assert.equal(reversed.ok, false);
  if (!reversed.ok) assert.match(reversed.error.message, /incomplete or invalid/u);
});

test("Coached How experiments compare one completed result per confirmed How source and resolve as one explicit cohort", () => {
  const experiment = makeCoachedHowExperimentState();
  const originalTopology = experiment.state.nodes;
  assert.equal(unresolvedDivergenceCount(experiment.state, experiment.fixture.project.id), 0);

  const comparisonId = take(makeComparisonId("comparison_coached_how"));
  let state = accept(experiment.state, coachedHowComparisonCommand(experiment, comparisonId, 60), []);
  const comparison = state.comparisons[0];
  assert.equal(comparison?.type, "coached_how_experiment");
  if (comparison?.type !== "coached_how_experiment") assert.fail("expected a Coached How experiment comparison");
  assert.equal(comparison.anchorNodeSha, experiment.fixture.root.commitSha);
  assert.equal(comparison.goalDigest, experiment.fixture.goalDigest);
  assert.equal(unresolvedDivergenceCount(state, experiment.fixture.project.id), 1);
  assert.deepEqual(state.nodes, originalTopology, "comparison cannot alter structural Nodes or edges");

  const repeatedComparisonId = take(makeComparisonId("comparison_coached_how_repeat"));
  state = accept(state, coachedHowComparisonCommand(experiment, repeatedComparisonId, 61), []);
  assert.equal(unresolvedDivergenceCount(state, experiment.fixture.project.id), 1, "repeated comparisons share one explicit cohort");

  state = accept(state, {
    type: "RejectAlternatives",
    meta: metadata(62),
    decisionId: take(makeDecisionId("decision_reject_baseline_how")),
    projectId: experiment.fixture.project.id,
    comparisonId,
    rejectedNodeShas: [experiment.baselineResult.commitSha],
    rationale: reason("The coached How produced stronger evidence.")
  }, []);
  assert.equal(unresolvedDivergenceCount(state, experiment.fixture.project.id), 1);

  state = accept(state, {
    type: "SelectAlternative",
    meta: metadata(63),
    decisionId: take(makeDecisionId("decision_select_coached_how")),
    projectId: experiment.fixture.project.id,
    comparisonId,
    selectedNodeSha: experiment.coachedResult.commitSha,
    rationale: reason("Select the result from the coached How.")
  }, []);
  assert.equal(unresolvedDivergenceCount(state, experiment.fixture.project.id), 0);
  assert.deepEqual(state.nodes, originalTopology, "decisions decorate result Nodes without changing structural edges");

  const secondSelection = applyProjectCommand(state, {
    type: "SelectAlternative",
    meta: metadata(64),
    decisionId: take(makeDecisionId("decision_select_same_cohort_twice")),
    projectId: experiment.fixture.project.id,
    comparisonId: repeatedComparisonId,
    selectedNodeSha: experiment.coachedResult.commitSha,
    rationale: reason("Attempt another selection through a repeated comparison.")
  });
  assert.equal(secondSelection.ok, false);
  if (!secondSelection.ok) assert.match(secondSelection.error.message, /cohort already has a selected future/u);
});

test("Coached How experiment validation rejects forged candidates, unconfirmed sources, plan drift, and overlapping cohort identities", () => {
  const experiment = makeCoachedHowExperimentState();
  const command = coachedHowComparisonCommand(experiment, take(makeComparisonId("comparison_invalid_coached_how")), 70);

  const unconfirmed = applyProjectCommand({ ...experiment.state, coachingProposalDecisions: [] }, command);
  assert.equal(unconfirmed.ok, false);
  if (!unconfirmed.ok) assert.match(unconfirmed.error.message, /directly confirmed Coaching proposal/u);

  const forgedRun: CompletedRun = { ...experiment.coachedRun, resultNodeSha: sha("9") };
  const forged = applyProjectCommand({
    ...experiment.state,
    runs: experiment.state.runs.map(run => run.id === forgedRun.id ? forgedRun : run)
  }, command);
  assert.equal(forged.ok, false);
  if (!forged.ok) assert.match(forged.error.message, /actual completed Run/u);

  const wrongTreeSource = { ...experiment.coachedSource, treeSha: tree("9") };
  const wrongTree = applyProjectCommand({
    ...experiment.state,
    nodes: experiment.state.nodes.map(node => node.commitSha === wrongTreeSource.commitSha ? wrongTreeSource : node)
  }, command);
  assert.equal(wrongTree.ok, false);
  if (!wrongTree.ok) assert.match(wrongTree.error.message, /preserve the anchor tree SHA/u);

  const driftedPlan: NodePlan = {
    ...experiment.coachedSource.plan,
    nextGoals: [experiment.fixture.goal, experiment.fixture.followupGoal]
  };
  const driftedSource = {
    ...experiment.coachedSource,
    plan: driftedPlan,
    planDigest: computeNodePlanDigest(driftedPlan)
  };
  const planDrift = applyProjectCommand({
    ...experiment.state,
    nodes: experiment.state.nodes.map(node => node.commitSha === driftedSource.commitSha ? driftedSource : node),
    coachingProposals: experiment.state.coachingProposals.map(proposal => proposal.id === driftedSource.proposalId
      ? { ...proposal, proposedPlan: driftedPlan, proposedPlanDigest: driftedSource.planDigest }
      : proposal)
  }, command);
  assert.equal(planDrift.ok, false);
  if (!planDrift.ok) assert.match(planDrift.error.message, /byte-identical except for How/u);

  const otherGoalDigest = computeGoalDigest(experiment.fixture.followupGoal);
  const otherGoalPlan: NodePlan = { ...experiment.coachedSource.plan, nextGoals: [experiment.fixture.followupGoal] };
  const otherGoalSource = {
    ...experiment.coachedSource,
    plan: otherGoalPlan,
    planDigest: computeNodePlanDigest(otherGoalPlan)
  };
  const otherGoalResult = { ...experiment.coachedResult, consumedGoalDigest: otherGoalDigest };
  const otherGoalRun: CompletedRun = {
    ...experiment.coachedRun,
    goal: experiment.fixture.followupGoal,
    goalDigest: otherGoalDigest
  };
  const mismatchedGoal = applyProjectCommand({
    ...experiment.state,
    nodes: experiment.state.nodes.map(node => {
      if (node.commitSha === otherGoalSource.commitSha) return otherGoalSource;
      if (node.commitSha === otherGoalResult.commitSha) return otherGoalResult;
      return node;
    }),
    runs: experiment.state.runs.map(run => run.id === otherGoalRun.id ? otherGoalRun : run)
  }, command);
  assert.equal(mismatchedGoal.ok, false);
  if (!mismatchedGoal.ok) assert.match(mismatchedGoal.error.message, /same canonical Goal/u);

  const incompleteFinding = applyProjectCommand(experiment.state, {
    ...command,
    meta: metadata(71, { type: "coach", id: text("coach-alpha") }),
    comparisonId: take(makeComparisonId("comparison_incomplete_finding")),
    findings: [{
      subject: text("Acceptance criterion"),
      summaries: [{ nodeSha: experiment.baselineResult.commitSha, summary: take(makeEvidenceSummary("Only one candidate.")) }]
    }]
  });
  assert.equal(incompleteFinding.ok, false);
  if (!incompleteFinding.ok) assert.match(incompleteFinding.error.message, /every included result Node exactly once/u);

  const secondBaselineRunId = runId("run_second_baseline_how");
  const secondBaselineResult = runChildNode(
    experiment.fixture.project,
    experiment.fixture.root,
    secondBaselineRunId,
    experiment.fixture.goalDigest,
    experiment.baselineResult.plan,
    sha("e"),
    tree("4"),
    time(72)
  );
  const secondBaselineRun = completedRunFor(
    experiment.fixture,
    experiment.fixture.root,
    secondBaselineResult,
    secondBaselineRunId,
    time(72)
  );
  const stateWithSibling: ProjectState = {
    ...experiment.state,
    nodes: [...experiment.state.nodes, secondBaselineResult],
    runs: [...experiment.state.runs, secondBaselineRun]
  };
  const overlappingState = accept(stateWithSibling, {
    type: "CompareAlternatives",
    comparisonType: "sibling_runs",
    meta: metadata(72, { type: "coach", id: text("coach-alpha") }),
    comparisonId: take(makeComparisonId("comparison_overlapping_sibling")),
    projectId: experiment.fixture.project.id,
    nodeShas: [experiment.baselineResult.commitSha, secondBaselineResult.commitSha],
    findings: [],
    summary: take(makeEvidenceSummary("Compare two baseline sibling results."))
  }, []);
  const overlap = applyProjectCommand(overlappingState, {
    ...command,
    meta: metadata(73, { type: "coach", id: text("coach-alpha") }),
    comparisonId: take(makeComparisonId("comparison_overlap_coached"))
  });
  assert.equal(overlap.ok, false);
  if (!overlap.ok) assert.match(overlap.error.message, /same explicit cohort key/u);
});

test("alternative decisions cannot dispose identical commit SHAs in another Project", () => {
  const first = makeFixture();
  const secondProjectId = take(makeProjectId("project_beta"));
  const secondProject: Project = { ...first.project, id: secondProjectId, workspaceId: take(makeWorkspaceId("workspace_beta")) };
  const emptyPlan: NodePlan = { ...first.root.plan, nextGoals: [] };
  const firstChildren = [
    runChildNode(first.project, first.root, runId("run_first_a"), first.goalDigest, emptyPlan, sha("b"), tree("2"), time(51)),
    runChildNode(first.project, first.root, runId("run_first_b"), first.goalDigest, emptyPlan, sha("c"), tree("3"), time(52))
  ];
  const secondRoot = rootNode(secondProject, first.root.plan, first.root.treeSha, first.root.registeredAt);
  const state: ProjectState = {
    ...emptyProjectState(),
    projects: [first.project, secondProject],
    nodes: [first.root, ...firstChildren, secondRoot],
    decisions: [
      {
        type: "rejection",
        id: take(makeDecisionId("decision_beta_reject")),
        projectId: secondProjectId,
        comparisonId: take(makeComparisonId("comparison_beta")),
        rejectedNodeShas: [sha("b")],
        rationale: reason("Reject only the beta Project future."),
        decidedAt: time(53)
      },
      {
        type: "selection",
        id: take(makeDecisionId("decision_beta_select")),
        projectId: secondProjectId,
        comparisonId: take(makeComparisonId("comparison_beta")),
        selectedNodeSha: sha("c"),
        rationale: reason("Select only the beta Project future."),
        decidedAt: time(54)
      }
    ]
  };
  assert.equal(unresolvedDivergenceCount(state, first.project.id), 1);
});

function makeCoachedHowExperimentState() {
  const fixture = makeFixture();
  const coachedRunner: RunnerValue = {
    ...fixture.runner,
    name: text("Coached QA verification swarm"),
    value: { prompt: "Verify production with the coached strategy." }
  };
  const coachedPlan: NodePlan = { ...fixture.root.plan, how: coachedRunner };
  const proposalId = take(makeCoachingProposalId("proposal_coached_how_experiment"));
  const coachedSource = coachingNode(
    fixture.project,
    fixture.root,
    proposalId,
    coachedPlan,
    sha("b"),
    fixture.root.treeSha,
    time(50)
  );
  const baselineRunId = runId("run_baseline_how");
  const coachedRunId = runId("run_coached_how");
  const baselineResultPlan: NodePlan = { ...fixture.root.plan, nextGoals: [] };
  const coachedResultPlan: NodePlan = { ...coachedSource.plan, nextGoals: [] };
  const baselineResult = runChildNode(
    fixture.project,
    fixture.root,
    baselineRunId,
    fixture.goalDigest,
    baselineResultPlan,
    sha("c"),
    tree("2"),
    time(51)
  );
  const coachedResult = runChildNode(
    fixture.project,
    coachedSource,
    coachedRunId,
    fixture.goalDigest,
    coachedResultPlan,
    sha("d"),
    tree("3"),
    time(52)
  );
  const baselineRun = completedRunFor(fixture, fixture.root, baselineResult, baselineRunId, time(51));
  const coachedRun = completedRunFor(fixture, coachedSource, coachedResult, coachedRunId, time(52));
  const state: ProjectState = {
    ...emptyProjectState(),
    projects: [fixture.project],
    nodes: [fixture.root, coachedSource, baselineResult, coachedResult],
    runs: [baselineRun, coachedRun],
    coachingProposals: [{
      id: proposalId,
      projectId: fixture.project.id,
      sourceNodeSha: fixture.root.commitSha,
      sourcePayloadDigest: fixture.root.payloadDigest,
      sourcePlanDigest: fixture.root.planDigest,
      proposedPlan: coachedPlan,
      proposedPlanDigest: computeNodePlanDigest(coachedPlan),
      expectedStateSha: sha("f"),
      summary: take(makeEvidenceSummary("Use a coached How against the same Goal and source tree.")),
      rationale: reason("Compare the baseline and coached execution strategies."),
      proposedAt: time(49)
    }],
    coachingProposalDecisions: [{
      status: "confirmed",
      id: take(makeDecisionId("decision_confirm_coached_how")),
      proposalId,
      childNodeSha: coachedSource.commitSha,
      reason: reason("Confirm the coached How experiment source."),
      decidedAt: time(50)
    }]
  };
  return { fixture, state, coachedSource, baselineResult, coachedResult, baselineRun, coachedRun };
}

function completedRunFor(
  fixture: ReturnType<typeof makeFixture>,
  source: Node,
  result: RunChildNode,
  id: RunId,
  completedAt: IsoTimestamp
): CompletedRun {
  return {
    status: "completed",
    id,
    projectId: fixture.project.id,
    sourceNodeSha: source.commitSha,
    goal: fixture.goal,
    goalDigest: fixture.goalDigest,
    runner: source.plan.how,
    runnerDigest: computeRunnerDigest(source.plan.how),
    branch: runBranchName(fixture.project.id, source.commitSha, id),
    checkpoints: [],
    evidenceIds: [],
    startedAt: time(48),
    resultNodeSha: result.commitSha,
    verifiedAt: completedAt,
    completedAt
  };
}

function coachedHowComparisonCommand(
  experiment: ReturnType<typeof makeCoachedHowExperimentState>,
  comparisonId: ComparisonId,
  sequence: number
): Extract<ProjectCommand, { type: "CompareAlternatives"; comparisonType: "coached_how_experiment" }> {
  return {
    type: "CompareAlternatives",
    comparisonType: "coached_how_experiment",
    meta: metadata(sequence, { type: "coach", id: text("coach-alpha") }),
    comparisonId,
    projectId: experiment.fixture.project.id,
    anchorNodeSha: experiment.fixture.root.commitSha,
    nodeShas: [experiment.baselineResult.commitSha, experiment.coachedResult.commitSha],
    findings: [{
      subject: text("Acceptance criterion"),
      summaries: [
        { nodeSha: experiment.baselineResult.commitSha, summary: take(makeEvidenceSummary("Baseline evidence satisfies the criterion.")) },
        { nodeSha: experiment.coachedResult.commitSha, summary: take(makeEvidenceSummary("Coached evidence satisfies the criterion.")) }
      ]
    }],
    summary: take(makeEvidenceSummary("Compare the same Goal through baseline and coached How values."))
  };
}

function makeFixture(): {
  project: Project;
  root: RootNode;
  runner: RunnerValue;
  goal: GoalValue;
  followupGoal: GoalValue;
  goalDigest: ReturnType<typeof computeGoalDigest>;
} {
  const at = time(1);
  const projectId = take(makeProjectId("project_alpha"));
  const runner: RunnerValue = {
    schema: RUNNER_VALUE_SCHEMA,
    type: {
      origin: take(makeRunnerTypeOrigin("hunsu")),
      key: take(makeRunnerTypeKey("custom/qa-swarm")),
      schemaVersion: take(makeRunnerSchemaVersion("1.0.0")),
      integrity: take(makeRunnerTypeIntegrity(`hunsu-runner-type-v1:sha256:${"a".repeat(64)}`))
    },
    name: text("QA verification swarm"),
    value: { prompt: "Verify production evidence." }
  };
  const goal: GoalValue = {
    key: take(makeGoalKey("goal_production")),
    title: take(makeGoalTitle("Validate production")),
    desiredOutcome: take(makeDesiredOutcome("Production behavior is verified.")),
    acceptanceCriteria: [take(makeAcceptanceCriterion("The result commit is verified."))],
    constraints: [],
    priority: take(makeNonNegativeInteger(1))
  };
  const followupGoal: GoalValue = {
    key: take(makeGoalKey("goal_followup")),
    title: take(makeGoalTitle("Improve resilience")),
    desiredOutcome: take(makeDesiredOutcome("Retries remain idempotent.")),
    acceptanceCriteria: [take(makeAcceptanceCriterion("A retry creates no duplicate state."))],
    constraints: [],
    priority: take(makeNonNegativeInteger(2))
  };
  const plan: NodePlan = { schema: NODE_PLAN_SCHEMA, nextGoals: [goal], how: runner };
  const project: Project = {
    id: projectId,
    workspaceId: take(makeWorkspaceId("workspace_alpha")),
    repository: { owner: take(makeRepositoryOwner("openai")), name: take(makeRepositoryName("hunsu")) },
    baseRef: take(makeGitRef("refs/heads/main")),
    title: take(makeProjectTitle("Production Trial")),
    rootNodeSha: sha("a"),
    createdAt: at
  };
  const root = rootNode(project, plan, tree("1"), at);
  return { project, root, runner, goal, followupGoal, goalDigest: computeGoalDigest(goal) };
}

function rootNode(project: Project, plan: NodePlan, treeSha: GitTreeSha, registeredAt: IsoTimestamp): RootNode {
  const common = nodeCommon(project, project.rootNodeSha, treeSha, plan, registeredAt, "Root node");
  return { type: "root", ...common };
}

function runChildNode(
  project: Project,
  parent: Node,
  runIdValue: RunId,
  goalDigest: ReturnType<typeof computeGoalDigest>,
  plan: NodePlan,
  commitSha: GitCommitSha,
  treeSha: GitTreeSha,
  registeredAt: IsoTimestamp
): RunChildNode {
  return {
    type: "run_child",
    ...nodeCommon(project, commitSha, treeSha, plan, registeredAt, "Run result"),
    parentSha: parent.commitSha,
    runId: runIdValue,
    consumedGoalDigest: goalDigest
  };
}

function coachingNode(
  project: Project,
  parent: Node,
  proposalId: CoachingProposalId,
  plan: NodePlan,
  commitSha: GitCommitSha,
  treeSha: GitTreeSha,
  registeredAt: IsoTimestamp
) {
  return {
    type: "coaching_child" as const,
    ...nodeCommon(project, commitSha, treeSha, plan, registeredAt, "Coached plan"),
    parentSha: parent.commitSha,
    proposalId
  };
}

function nodeCommon(project: Project, commitSha: GitCommitSha, treeSha: GitTreeSha, plan: NodePlan, registeredAt: IsoTimestamp, title: string) {
  const payload = { schema: "hunsu.node-payload.v1" as const, projectId: project.id, commitSha, treeSha, plan };
  return {
    projectId: project.id,
    commitSha,
    treeSha,
    managedRef: managedNodeRef(project.id, commitSha),
    commitTitle: text(title),
    plan,
    planDigest: computeNodePlanDigest(plan),
    payloadDigest: computeNodePayloadDigest(payload),
    registeredAt
  };
}

function envelope(node: Node): NodePayloadEnvelope {
  return take(encodeNodeEnvelope(nodePayloadFor(node)));
}

function startRun(state: ProjectState, events: DomainEvent[], fixture: ReturnType<typeof makeFixture>, id: RunId, sequence: number): ProjectState {
  return accept(state, {
    type: "StartRun",
    meta: metadata(sequence, pluginActor()),
    runId: id,
    projectId: fixture.project.id,
    sourceNodeSha: fixture.root.commitSha,
    goalDigest: fixture.goalDigest,
    branch: runBranchName(fixture.project.id, fixture.root.commitSha, id)
  }, events);
}

function attachCriterionEvidence(
  state: ProjectState,
  events: DomainEvent[],
  fixture: ReturnType<typeof makeFixture>,
  id: RunId,
  resultSha: GitCommitSha,
  sequence: number,
  criterion = fixture.goal.acceptanceCriteria[0]
): ProjectState {
  return accept(state, {
    type: "AttachRunEvidence",
    meta: metadata(sequence, pluginActor()),
    evidence: {
      id: take(makeEvidenceId(`evidence_${sequence}`)),
      projectId: fixture.project.id,
      runId: id,
      target: { type: "criterion", criterion },
      kind: "check",
      summary: take(makeEvidenceSummary("The acceptance criterion is verified.")),
      location: { type: "git", commitSha: resultSha, path: take(makeGitTreePath("evidence/check.txt")) },
      recordedAt: time(sequence)
    }
  }, events);
}

function completeCommand(
  state: ProjectState,
  fixture: ReturnType<typeof makeFixture>,
  id: RunId,
  resultSha: GitCommitSha,
  resultTree: GitTreeSha,
  sequence: number
): Extract<ProjectCommand, { type: "CompleteRun" }> {
  const run = state.runs.find(item => item.id === id);
  if (!run || run.status !== "running") throw new Error("Run fixture must be running");
  const source = findNode(state, run.sourceNodeSha);
  const inherited = take(inheritRunChildPlan(source, run.goalDigest));
  const node = runChildNode(fixture.project, source, id, run.goalDigest, inherited, resultSha, resultTree, time(sequence));
  return {
    type: "CompleteRun",
    meta: metadata(sequence, pluginActor()),
    nodeEventId: eventId(sequence + 100),
    result: { runId: id, branch: run.branch, resultSha, verifiedAt: time(sequence) },
    node,
    payload: envelope(node)
  };
}

function accept(state: ProjectState, command: ProjectCommand, events: DomainEvent[]): ProjectState {
  const result = applyProjectCommand(state, command);
  if (!result.ok) assert.fail(result.error.message);
  events.push(...result.value.emittedEvents);
  return result.value.state;
}

function findNode(state: ProjectState, commitSha: GitCommitSha): Node {
  const node = state.nodes.find(item => item.commitSha === commitSha);
  if (!node) throw new Error("Node fixture was not found");
  return node;
}

function metadata(sequence: number, actor: DomainActor = { type: "user", id: text("user-alpha") }): CommandMetadata {
  return {
    eventId: eventId(sequence),
    idempotencyKey: take(makeIdempotencyKey(sequence.toString(16).padStart(64, "0"))),
    fingerprint: fingerprint(sequence),
    expectedStateSha: sha("f"),
    actor,
    requestedAt: time(sequence)
  };
}

function pluginActor(): DomainActor {
  return { type: "plugin", id: text("hunsu-plugin") };
}

function eventId(sequence: number) {
  return take(makeEventId(`event_${sequence}`));
}

function fingerprint(sequence: number) {
  return take(makeCommandFingerprint((sequence + 4096).toString(16).padStart(64, "0")));
}

function runId(value: string) {
  return take(makeRunId(value));
}

function sha(character: string): GitCommitSha {
  return take(makeGitCommitSha(character.repeat(40)));
}

function tree(character: string): GitTreeSha {
  return take(makeGitTreeSha(character.repeat(40)));
}

function time(sequence: number): IsoTimestamp {
  return take(makeIsoTimestamp(`2026-07-14T00:00:${String(sequence % 60).padStart(2, "0")}.000Z`));
}

function text(value: string) {
  return take(makeNonEmptyText(value));
}

function reason(value: string) {
  return take(makeReason(value));
}

function runnerTypesFor(runner: RunnerValue): RunnerValueTypeRegistry {
  return [{
    type: runner.type,
    decode(value, path) {
      if (typeof value === "object"
        && value !== null
        && !Array.isArray(value)
        && Object.keys(value).length === 1
        && typeof (value as { prompt?: unknown }).prompt === "string"
      ) {
        return { ok: true, value: { prompt: (value as { prompt: string }).prompt } };
      }
      return {
        ok: false,
        error: { type: "RunnerValueDecodeError", path, message: "payload must contain exactly prompt" }
      };
    }
  }];
}

/** Exact origin/main v2 shapes: one proposal reason and no comparison discriminant. */
function historicalV2Fixture(event: DomainEvent, removeOneComparisonSummary: boolean): string {
  const envelope = JSON.parse(encodeDomainEvent(event)) as {
    schema: string;
    event: Record<string, unknown>;
  };
  if (event.type === "CoachingProposalRecorded") {
    const proposal = envelope.event.proposal as Record<string, unknown>;
    delete proposal.summary;
    delete proposal.rationale;
    proposal.reason = event.proposal.rationale;
    envelope.schema = HISTORICAL_PROJECT_EVENT_SCHEMA;
  } else if (event.type === "AlternativesCompared" && event.comparison.type === "sibling_runs") {
    const comparison = envelope.event.comparison as Record<string, unknown>;
    delete comparison.type;
    if (removeOneComparisonSummary) {
      const findings = comparison.findings as Array<{ summaries: unknown[] }>;
      findings[0]?.summaries.pop();
    }
    envelope.schema = HISTORICAL_PROJECT_EVENT_SCHEMA;
  }
  return JSON.stringify(envelope);
}

function take<T, E>(result: Result<T, E>): T {
  if (!result.ok) throw new Error("Fixture construction failed");
  return result.value;
}
