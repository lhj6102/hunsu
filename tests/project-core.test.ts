import test from "node:test";
import assert from "node:assert/strict";
import {
  applyDomainEvent,
  applyProjectCommand,
  emptyProjectState,
  replayDomainEvents,
  validateRunnerGraph
} from "../packages/core/src/index.ts";
import {
  decodeProjectState,
  encodeProjectState,
  makeAcceptanceCriterion,
  makeCoachId,
  makeCoachProposalId,
  makeCoachReviewId,
  makeCommandFingerprint,
  makeComparisonId,
  makeDecisionId,
  makeDesiredOutcome,
  makeDivergenceId,
  makeEvidenceId,
  makeEvidenceSummary,
  makeEventId,
  makeGitCommitSha,
  makeGitRef,
  makeGoalId,
  makeGoalTitle,
  makeIdempotencyKey,
  makeIsoTimestamp,
  makeNonEmptyText,
  makeNonNegativeInteger,
  makePositiveInteger,
  makeProjectId,
  makeProjectObjective,
  makeProjectTitle,
  makePromptTemplate,
  makeReason,
  makeRepositoryName,
  makeRepositoryOwner,
  makeRunId,
  makeRunnerId,
  makeWorkspaceId,
  runBranchName,
  type ActiveGoal,
  type Coach,
  type DomainActor,
  type DomainEvent,
  type GitCommitSha,
  type Player,
  type Project,
  type ProjectCommand,
  type ProjectState,
  type Result,
  type Team
} from "../packages/protocol/src/index.ts";

test("commands capture immutable snapshots, support safe retries, and replay deterministically", () => {
  const fixture = makeFixture();
  let state = emptyProjectState();
  const events: DomainEvent[] = [];

  const createProject: ProjectCommand = {
    type: "CreateProject",
    meta: metadata(1),
    project: fixture.project,
    coach: fixture.coach
  };
  state = accept(state, createProject, events);

  const retried = applyProjectCommand(state, createProject);
  assert.equal(retried.ok, true);
  if (retried.ok) {
    assert.deepEqual(retried.value.emittedEvents, []);
    assert.deepEqual(retried.value.reusedEventIds, [createProject.meta.eventId]);
  }

  const conflicting = applyProjectCommand(state, {
    type: "UpdateProject",
    meta: { ...createProject.meta, fingerprint: fingerprint(999) },
    projectId: fixture.project.id,
    patch: { title: take(makeProjectTitle("Conflicting retry")) }
  });
  assert.equal(conflicting.ok, false);
  if (!conflicting.ok) assert.equal(conflicting.error.code, "IDEMPOTENCY_CONFLICT");

  state = accept(state, { type: "CreatePlayer", meta: metadata(2), player: fixture.player }, events);
  state = accept(state, { type: "CreateGoal", meta: metadata(3), goal: fixture.goal }, events);

  const sourceRunId = take(makeRunId("run_source"));
  state = accept(state, {
    type: "StartRun",
    meta: metadata(4, pluginActor()),
    runId: sourceRunId,
    projectId: fixture.project.id,
    goalId: fixture.goal.id,
    runnerId: fixture.player.id,
    baseSha: fixture.baseSha,
    branch: runBranchName(fixture.project.id, fixture.goal.id, sourceRunId),
    origin: { type: "primary" }
  }, events);

  const capturedPrompt = state.runs[0].runnerSnapshot.kind === "player"
    ? state.runs[0].runnerSnapshot.promptTemplate
    : undefined;
  const changedPlayer: Player = {
    ...fixture.player,
    promptTemplate: take(makePromptTemplate("Changed after the Run started.")),
    updatedAt: time(5)
  };
  state = accept(state, { type: "UpdatePlayer", meta: metadata(5), player: changedPlayer }, events);
  assert.equal(state.runners[0].kind === "player" ? state.runners[0].promptTemplate : undefined, changedPlayer.promptTemplate);
  assert.equal(state.runs[0].runnerSnapshot.kind === "player" ? state.runs[0].runnerSnapshot.promptTemplate : undefined, capturedPrompt);

  const uncoveredCompletion = applyProjectCommand(state, {
    type: "CompleteRun",
    meta: metadata(6, pluginActor()),
    result: {
      runId: sourceRunId,
      branch: runBranchName(fixture.project.id, fixture.goal.id, sourceRunId),
      resultSha: take(makeGitCommitSha("b".repeat(40))),
      verifiedAt: time(6)
    }
  });
  assert.equal(uncoveredCompletion.ok, false);
  if (!uncoveredCompletion.ok) assert.match(uncoveredCompletion.error.message, /cover every Goal acceptance criterion/u);

  const invalidCriterion = applyProjectCommand(state, {
    type: "AttachRunEvidence",
    meta: metadata(48, pluginActor()),
    evidence: {
      id: take(makeEvidenceId("evidence_invalid_criterion")),
      projectId: fixture.project.id,
      runId: sourceRunId,
      criterion: take(makeAcceptanceCriterion("A criterion not present in the Run snapshot")),
      kind: "check",
      summary: take(makeEvidenceSummary("This must be rejected.")),
      location: { type: "text", text: take(makeNonEmptyText("Invalid criterion.")) },
      recordedAt: time(48)
    }
  });
  assert.equal(invalidCriterion.ok, false);
  if (!invalidCriterion.ok) assert.match(invalidCriterion.error.message, /Run Goal snapshot/u);

  state = accept(state, {
    type: "AttachRunEvidence",
    meta: metadata(49, pluginActor()),
    evidence: {
      id: take(makeEvidenceId("evidence_source_criterion")),
      projectId: fixture.project.id,
      runId: sourceRunId,
      criterion: fixture.goal.acceptanceCriteria[0],
      kind: "check",
      summary: take(makeEvidenceSummary("The source result satisfies the criterion.")),
      location: { type: "git", commitSha: take(makeGitCommitSha("b".repeat(40))), path: take(makeNonEmptyText(".")) },
      recordedAt: time(49)
    }
  }, events);
  state = accept(state, {
    type: "CompleteRun",
    meta: metadata(6, pluginActor()),
    result: {
      runId: sourceRunId,
      branch: runBranchName(fixture.project.id, fixture.goal.id, sourceRunId),
      resultSha: take(makeGitCommitSha("b".repeat(40))),
      verifiedAt: time(6)
    }
  }, events);

  const restoredRunner = applyProjectCommand(state, {
    type: "UpdatePlayer",
    meta: metadata(20),
    player: { ...fixture.player, updatedAt: time(20) }
  });
  if (!restoredRunner.ok) assert.fail(restoredRunner.error.message);
  const unchangedDivergenceId = take(makeDivergenceId("divergence_without_a_change"));
  const unchangedConfirmation = applyProjectCommand(restoredRunner.value.state, {
    type: "ConfirmHunsu",
    meta: metadata(58),
    divergenceId: unchangedDivergenceId,
    projectId: fixture.project.id,
    goalId: fixture.goal.id,
    sourceRunId,
    basis: { type: "user", reason: take(makeReason("Try another future deliberately.")) }
  });
  if (!unchangedConfirmation.ok) assert.fail(unchangedConfirmation.error.message);
  const unchangedAlternativeRunId = take(makeRunId("run_unchanged_alternative"));
  const unchangedAlternative = applyProjectCommand(unchangedConfirmation.value.state, {
    type: "StartRun",
    meta: metadata(59, pluginActor()),
    runId: unchangedAlternativeRunId,
    projectId: fixture.project.id,
    goalId: fixture.goal.id,
    runnerId: fixture.player.id,
    baseSha: fixture.baseSha,
    branch: runBranchName(fixture.project.id, fixture.goal.id, unchangedAlternativeRunId),
    origin: { type: "hunsu_alternative", divergenceId: unchangedDivergenceId, sourceRunId }
  });
  assert.equal(unchangedAlternative.ok, false);
  if (!unchangedAlternative.ok) assert.match(unchangedAlternative.error.message, /change the Goal or Runner/u);

  const reviewId = take(makeCoachReviewId("review_source"));
  state = accept(state, {
    type: "RecordCoachReview",
    meta: metadata(7, { type: "coach", coachId: fixture.coach.id }),
    review: {
      id: reviewId,
      projectId: fixture.project.id,
      coachId: fixture.coach.id,
      target: { type: "run", runId: sourceRunId },
      assessment: take(makeNonEmptyText("The result is useful but an alternative should be tested.")),
      recommendations: [take(makeNonEmptyText("Try a smaller change."))],
      recordedAt: time(7)
    }
  }, events);

  const proposalId = take(makeCoachProposalId("proposal_hunsu"));
  const alternativeCriterion = take(makeAcceptanceCriterion("The smaller alternative stays deliberately focused"));
  state = accept(state, {
    type: "RecordCoachProposal",
    meta: metadata(8, { type: "coach", coachId: fixture.coach.id }),
    proposal: {
      type: "hunsu",
      id: proposalId,
      projectId: fixture.project.id,
      coachId: fixture.coach.id,
      goalId: fixture.goal.id,
      sourceRunId,
      alternative: {
        type: "goal_change",
        change: {
          title: take(makeGoalTitle("Ship a deliberately smaller alternative")),
          acceptanceCriteria: [alternativeCriterion]
        }
      },
      reason: take(makeReason("Compare a deliberately smaller alternative.")),
      proposedAt: time(8)
    }
  }, events);

  const divergenceId = take(makeDivergenceId("divergence_alpha"));
  const unconfirmed = applyProjectCommand(state, {
    type: "AcceptCoachProposal",
    meta: metadata(9, pluginActor()),
    proposalId,
    reason: take(makeReason("Accept the proposed experiment.")),
    application: { type: "hunsu", divergenceId }
  });
  assert.equal(unconfirmed.ok, false);
  if (!unconfirmed.ok) assert.equal(unconfirmed.error.code, "USER_CONFIRMATION_REQUIRED");

  state = accept(state, {
    type: "AcceptCoachProposal",
    meta: metadata(10),
    proposalId,
    reason: take(makeReason("Accept the proposed experiment.")),
    application: { type: "hunsu", divergenceId }
  }, events);
  assert.equal(state.coachProposalDecisions[0]?.status, "accepted");
  assert.equal(state.divergences[0]?.id, divergenceId);
  assert.equal(state.goals[0]?.title, "Ship a deliberately smaller alternative");
  assert.equal(state.runs[0]?.goalSnapshot.title, fixture.goal.title, "the source Run keeps its immutable Goal snapshot");

  const repeatDisposition = applyProjectCommand(state, {
    type: "RejectCoachProposal",
    meta: metadata(18),
    proposalId,
    reason: take(makeReason("Changed my mind."))
  });
  assert.equal(repeatDisposition.ok, false);
  if (!repeatDisposition.ok) assert.equal(repeatDisposition.error.code, "INVALID_TRANSITION");

  const alternativeRunId = take(makeRunId("run_alternative"));
  const wrongBase = applyProjectCommand(state, {
    type: "StartRun",
    meta: metadata(11, pluginActor()),
    runId: alternativeRunId,
    projectId: fixture.project.id,
    goalId: fixture.goal.id,
    runnerId: fixture.player.id,
    baseSha: take(makeGitCommitSha("c".repeat(40))),
    branch: runBranchName(fixture.project.id, fixture.goal.id, alternativeRunId),
    origin: { type: "hunsu_alternative", divergenceId, sourceRunId }
  });
  assert.equal(wrongBase.ok, false);
  if (!wrongBase.ok) assert.match(wrongBase.error.message, /same base SHA/u);

  state = accept(state, {
    type: "StartRun",
    meta: metadata(12, pluginActor()),
    runId: alternativeRunId,
    projectId: fixture.project.id,
    goalId: fixture.goal.id,
    runnerId: fixture.player.id,
    baseSha: fixture.baseSha,
    branch: runBranchName(fixture.project.id, fixture.goal.id, alternativeRunId),
    origin: { type: "hunsu_alternative", divergenceId, sourceRunId }
  }, events);
  assert.equal(state.runs.at(-1)?.goalSnapshot.title, "Ship a deliberately smaller alternative");
  state = accept(state, {
    type: "AttachRunEvidence",
    meta: metadata(50, pluginActor()),
    evidence: {
      id: take(makeEvidenceId("evidence_alternative_criterion")),
      projectId: fixture.project.id,
      runId: alternativeRunId,
      criterion: alternativeCriterion,
      kind: "check",
      summary: take(makeEvidenceSummary("The alternative result satisfies the criterion.")),
      location: { type: "git", commitSha: take(makeGitCommitSha("d".repeat(40))), path: take(makeNonEmptyText(".")) },
      recordedAt: time(50)
    }
  }, events);
  state = accept(state, {
    type: "CompleteRun",
    meta: metadata(13, pluginActor()),
    result: {
      runId: alternativeRunId,
      branch: runBranchName(fixture.project.id, fixture.goal.id, alternativeRunId),
      resultSha: take(makeGitCommitSha("d".repeat(40))),
      verifiedAt: time(13)
    }
  }, events);

  const unrelatedRunId = take(makeRunId("run_same_base_but_not_a_divergence_sibling"));
  state = accept(state, {
    type: "StartRun",
    meta: metadata(54, pluginActor()),
    runId: unrelatedRunId,
    projectId: fixture.project.id,
    goalId: fixture.goal.id,
    runnerId: fixture.player.id,
    baseSha: fixture.baseSha,
    branch: runBranchName(fixture.project.id, fixture.goal.id, unrelatedRunId),
    origin: { type: "primary" }
  }, events);
  state = accept(state, {
    type: "AttachRunEvidence",
    meta: metadata(55, pluginActor()),
    evidence: {
      id: take(makeEvidenceId("evidence_unrelated_run_criterion")),
      projectId: fixture.project.id,
      runId: unrelatedRunId,
      criterion: alternativeCriterion,
      kind: "check",
      summary: take(makeEvidenceSummary("The unrelated Run also satisfies the original criterion.")),
      location: { type: "git", commitSha: take(makeGitCommitSha("e".repeat(40))), path: take(makeNonEmptyText(".")) },
      recordedAt: time(55)
    }
  }, events);
  state = accept(state, {
    type: "CompleteRun",
    meta: metadata(56, pluginActor()),
    result: {
      runId: unrelatedRunId,
      branch: runBranchName(fixture.project.id, fixture.goal.id, unrelatedRunId),
      resultSha: take(makeGitCommitSha("e".repeat(40))),
      verifiedAt: time(56)
    }
  }, events);

  const comparisonId = take(makeComparisonId("comparison_alpha"));
  const unrelatedRunComparison = applyProjectCommand(state, {
    type: "CompareAlternatives",
    meta: metadata(57),
    comparisonId: take(makeComparisonId("comparison_unrelated_run")),
    divergenceId,
    runIds: [sourceRunId, alternativeRunId, unrelatedRunId],
    findings: [{
      criterion: fixture.goal.acceptanceCriteria[0],
      summaries: [
        { runId: sourceRunId, summary: take(makeEvidenceSummary("Source criterion.")) },
        { runId: alternativeRunId, summary: take(makeEvidenceSummary("Alternative result.")) },
        { runId: unrelatedRunId, summary: take(makeEvidenceSummary("Unrelated result.")) }
      ]
    }, {
      criterion: alternativeCriterion,
      summaries: [
        { runId: sourceRunId, summary: take(makeEvidenceSummary("Not applicable.")) },
        { runId: alternativeRunId, summary: take(makeEvidenceSummary("Alternative criterion.")) },
        { runId: unrelatedRunId, summary: take(makeEvidenceSummary("Not applicable.")) }
      ]
    }],
    summary: take(makeEvidenceSummary("Includes a same-base Run outside the divergence."))
  });
  assert.equal(unrelatedRunComparison.ok, false);
  if (!unrelatedRunComparison.ok) assert.match(unrelatedRunComparison.error.message, /selected Hunsu divergence/u);

  const incompleteComparison = applyProjectCommand(state, {
    type: "CompareAlternatives",
    meta: metadata(51),
    comparisonId: take(makeComparisonId("comparison_missing_criterion")),
    divergenceId,
    runIds: [sourceRunId, alternativeRunId],
    findings: [],
    summary: take(makeEvidenceSummary("Missing criterion findings."))
  });
  assert.equal(incompleteComparison.ok, false);
  if (!incompleteComparison.ok) assert.match(incompleteComparison.error.message, /every acceptance criterion/u);

  const incompleteRunSummaries = applyProjectCommand(state, {
    type: "CompareAlternatives",
    meta: metadata(52),
    comparisonId: take(makeComparisonId("comparison_missing_run")),
    divergenceId,
    runIds: [sourceRunId, alternativeRunId],
    findings: [{
      criterion: fixture.goal.acceptanceCriteria[0],
      summaries: [{ runId: sourceRunId, summary: take(makeEvidenceSummary("Only one Run.")) }]
    }, {
      criterion: alternativeCriterion,
      summaries: [
        { runId: sourceRunId, summary: take(makeEvidenceSummary("Not applicable.")) },
        { runId: alternativeRunId, summary: take(makeEvidenceSummary("Alternative criterion covered.")) }
      ]
    }],
    summary: take(makeEvidenceSummary("Missing one Run summary."))
  });
  assert.equal(incompleteRunSummaries.ok, false);
  if (!incompleteRunSummaries.ok) assert.match(incompleteRunSummaries.error.message, /each compared Run/u);

  const unknownCriterionComparison = applyProjectCommand(state, {
    type: "CompareAlternatives",
    meta: metadata(53),
    comparisonId: take(makeComparisonId("comparison_unknown_criterion")),
    divergenceId,
    runIds: [sourceRunId, alternativeRunId],
    findings: [{
      criterion: fixture.goal.acceptanceCriteria[0],
      summaries: [
        { runId: sourceRunId, summary: take(makeEvidenceSummary("Source criterion.")) },
        { runId: alternativeRunId, summary: take(makeEvidenceSummary("Not applicable.")) }
      ]
    }, {
      criterion: take(makeAcceptanceCriterion("Unknown comparison criterion")),
      summaries: [
        { runId: sourceRunId, summary: take(makeEvidenceSummary("Not applicable.")) },
        { runId: alternativeRunId, summary: take(makeEvidenceSummary("Unknown criterion.")) }
      ]
    }],
    summary: take(makeEvidenceSummary("Includes an unknown criterion."))
  });
  assert.equal(unknownCriterionComparison.ok, false);
  if (!unknownCriterionComparison.ok) assert.match(unknownCriterionComparison.error.message, /compared Run Goal snapshot/u);

  state = accept(state, {
    type: "CompareAlternatives",
    meta: metadata(14),
    comparisonId,
    divergenceId,
    runIds: [sourceRunId, alternativeRunId],
    findings: [{
      criterion: fixture.goal.acceptanceCriteria[0],
      summaries: [
        { runId: sourceRunId, summary: take(makeEvidenceSummary("Broad result.")) },
        { runId: alternativeRunId, summary: take(makeEvidenceSummary("Focused result.")) }
      ]
    }, {
      criterion: alternativeCriterion,
      summaries: [
        { runId: sourceRunId, summary: take(makeEvidenceSummary("Not applicable to the source Goal snapshot.")) },
        { runId: alternativeRunId, summary: take(makeEvidenceSummary("The alternative remains focused.")) }
      ]
    }],
    summary: take(makeEvidenceSummary("The focused alternative is stronger."))
  }, events);

  const decisionId = take(makeDecisionId("decision_alpha"));
  const automaticSelection = applyProjectCommand(state, {
    type: "SelectAlternative",
    meta: metadata(15, pluginActor()),
    decisionId,
    comparisonId,
    selectedRunId: alternativeRunId,
    rationale: take(makeReason("Prefer the focused result."))
  });
  assert.equal(automaticSelection.ok, false);
  if (!automaticSelection.ok) assert.equal(automaticSelection.error.code, "USER_CONFIRMATION_REQUIRED");

  state = accept(state, {
    type: "SelectAlternative",
    meta: metadata(16),
    decisionId,
    comparisonId,
    selectedRunId: alternativeRunId,
    rationale: take(makeReason("Prefer the focused result."))
  }, events);
  state = accept(state, {
    type: "CompleteGoal",
    meta: metadata(17),
    goalId: fixture.goal.id,
    selectedRunId: alternativeRunId
  }, events);

  assert.equal(state.goals[0].status, "completed");
  assert.deepEqual(state.divergences[0].alternativeRunIds, [alternativeRunId]);

  const replayed = replayDomainEvents(events);
  assert.equal(replayed.ok, true);
  if (replayed.ok) {
    const encoded = encodeProjectState(replayed.value);
    assert.equal(encoded, encodeProjectState(state));
    const decoded = decodeProjectState(encoded);
    assert.equal(decoded.ok, true);
    if (decoded.ok) {
      assert.deepEqual(decoded.value.evidence.map(item => item.criterion), [fixture.goal.acceptanceCriteria[0], alternativeCriterion, alternativeCriterion]);
    }
  }

  const duplicateEvent = applyDomainEvent(state, events[0]);
  assert.equal(duplicateEvent.ok, false);
  if (!duplicateEvent.ok) assert.equal(duplicateEvent.error.code, "INVALID_EVENT");
});

test("Runner graph accepts Players and rejects duplicate or Team slot targets", () => {
  const fixture = makeFixture();
  const events: DomainEvent[] = [];
  let state = accept(emptyProjectState(), {
    type: "CreateProject",
    meta: metadata(30),
    project: fixture.project,
    coach: fixture.coach
  }, events);
  state = accept(state, { type: "CreatePlayer", meta: metadata(31), player: fixture.player }, events);

  const team: Team = {
    kind: "team",
    id: take(makeRunnerId("team_alpha")),
    projectId: fixture.project.id,
    strategy: {
      mode: "coordinated",
      promptTemplate: take(makePromptTemplate("Coordinate the Players.")),
      maxRounds: take(makePositiveInteger(3))
    },
    players: [{
      playerId: fixture.player.id,
      role: take(makeNonEmptyText("builder")),
      order: take(makePositiveInteger(1))
    }],
    createdAt: time(31),
    updatedAt: time(31)
  };
  assert.equal(validateRunnerGraph(state, team).ok, true);
  state = accept(state, { type: "CreateTeam", meta: metadata(32), team }, events);

  const teamTarget: Team = {
    ...team,
    id: take(makeRunnerId("team_invalid_target")),
    players: [{ ...team.players[0], playerId: team.id }]
  };
  assert.equal(validateRunnerGraph(state, teamTarget).ok, false);

  const duplicateSlots: Team = {
    ...team,
    id: take(makeRunnerId("team_duplicate")),
    players: [team.players[0], { ...team.players[0], order: take(makePositiveInteger(2)) }]
  };
  assert.equal(validateRunnerGraph(state, duplicateSlots).ok, false);
});

test("Hunsu proposals and confirmations reject non-completed source Runs", () => {
  const fixture = makeFixture();
  const events: DomainEvent[] = [];
  let state = accept(emptyProjectState(), {
    type: "CreateProject",
    meta: metadata(1),
    project: fixture.project,
    coach: fixture.coach
  }, events);
  state = accept(state, { type: "CreatePlayer", meta: metadata(2), player: fixture.player }, events);
  state = accept(state, { type: "CreateGoal", meta: metadata(3), goal: fixture.goal }, events);
  const failedRunId = take(makeRunId("run_failed_source"));
  state = accept(state, {
    type: "StartRun",
    meta: metadata(4, pluginActor()),
    runId: failedRunId,
    projectId: fixture.project.id,
    goalId: fixture.goal.id,
    runnerId: fixture.player.id,
    baseSha: fixture.baseSha,
    branch: runBranchName(fixture.project.id, fixture.goal.id, failedRunId),
    origin: { type: "primary" }
  }, events);
  state = accept(state, {
    type: "FailRun",
    meta: metadata(5, pluginActor()),
    runId: failedRunId,
    reason: take(makeReason("The attempted future did not satisfy the Goal."))
  }, events);

  const proposalId = take(makeCoachProposalId("proposal_failed_source"));
  const proposal = applyProjectCommand(state, {
    type: "RecordCoachProposal",
    meta: metadata(6, { type: "coach", coachId: fixture.coach.id }),
    proposal: {
      type: "hunsu",
      id: proposalId,
      projectId: fixture.project.id,
      coachId: fixture.coach.id,
      goalId: fixture.goal.id,
      sourceRunId: failedRunId,
      alternative: { type: "goal_change", change: { title: take(makeGoalTitle("Impossible sibling")) } },
      reason: take(makeReason("This proposal must be rejected.")),
      proposedAt: time(6)
    }
  });
  assert.equal(proposal.ok, false);
  if (!proposal.ok) assert.match(proposal.error.message, /completed source Run/u);

  const confirmation = applyProjectCommand(state, {
    type: "ConfirmHunsu",
    meta: metadata(7),
    divergenceId: take(makeDivergenceId("divergence_failed_source")),
    projectId: fixture.project.id,
    goalId: fixture.goal.id,
    sourceRunId: failedRunId,
    basis: { type: "user", reason: take(makeReason("This confirmation must also be rejected.")) }
  });
  assert.equal(confirmation.ok, false);
  if (!confirmation.ok) assert.match(confirmation.error.message, /completed source Run/u);
});

test("user Coach proposal decisions apply changes or preserve state on rejection", () => {
  const fixture = makeFixture();
  const events: DomainEvent[] = [];
  let state = accept(emptyProjectState(), {
    type: "CreateProject",
    meta: metadata(40),
    project: fixture.project,
    coach: fixture.coach
  }, events);
  state = accept(state, { type: "CreatePlayer", meta: metadata(41), player: fixture.player }, events);
  state = accept(state, { type: "CreateGoal", meta: metadata(42), goal: fixture.goal }, events);

  const changeProposalId = take(makeCoachProposalId("proposal_goal_change"));
  state = accept(state, {
    type: "RecordCoachProposal",
    meta: metadata(43, { type: "coach", coachId: fixture.coach.id }),
    proposal: {
      type: "goal_change",
      id: changeProposalId,
      projectId: fixture.project.id,
      coachId: fixture.coach.id,
      goalId: fixture.goal.id,
      change: { title: take(makeGoalTitle("Complete the verified vertical slice")) },
      reason: take(makeReason("Make verification explicit.")),
      proposedAt: time(43)
    }
  }, events);
  state = accept(state, {
    type: "AcceptCoachProposal",
    meta: metadata(44),
    proposalId: changeProposalId,
    reason: take(makeReason("The clarification is useful.")),
    application: { type: "apply_change" }
  }, events);
  assert.equal(state.goals[0]?.title, "Complete the verified vertical slice");
  assert.equal(state.coachProposalDecisions[0]?.status, "accepted");

  const alternatePlayer: Player = {
    ...fixture.player,
    id: take(makeRunnerId("player_beta")),
    promptTemplate: take(makePromptTemplate("Build a broader alternative.")),
    createdAt: time(45),
    updatedAt: time(45)
  };
  state = accept(state, { type: "CreatePlayer", meta: metadata(45), player: alternatePlayer }, events);
  const runnerProposalId = take(makeCoachProposalId("proposal_runner_change"));
  state = accept(state, {
    type: "RecordCoachProposal",
    meta: metadata(46, { type: "coach", coachId: fixture.coach.id }),
    proposal: {
      type: "runner_change",
      id: runnerProposalId,
      projectId: fixture.project.id,
      coachId: fixture.coach.id,
      goalId: fixture.goal.id,
      runnerId: alternatePlayer.id,
      reason: take(makeReason("Try the broader Player.")),
      proposedAt: time(46)
    }
  }, events);
  state = accept(state, {
    type: "RejectCoachProposal",
    meta: metadata(47),
    proposalId: runnerProposalId,
    reason: take(makeReason("Keep the focused Player."))
  }, events);
  assert.deepEqual(state.goals[0]?.assignment, { type: "assigned", runnerId: fixture.player.id });
  assert.equal(state.coachProposalDecisions[1]?.status, "rejected");

  const replayed = replayDomainEvents(events);
  assert.equal(replayed.ok, true);
  if (replayed.ok) assert.equal(encodeProjectState(replayed.value), encodeProjectState(state));
});

function makeFixture(): { project: Project; coach: Coach; player: Player; goal: ActiveGoal; baseSha: GitCommitSha } {
  const projectId = take(makeProjectId("project_alpha"));
  const coachId = take(makeCoachId("coach_alpha"));
  const playerId = take(makeRunnerId("player_alpha"));
  const at = time(0);
  const project: Project = {
    id: projectId,
    workspaceId: take(makeWorkspaceId("workspace_alpha")),
    repository: {
      owner: take(makeRepositoryOwner("openai")),
      name: take(makeRepositoryName("hunsu"))
    },
    baseRef: take(makeGitRef("refs/heads/main")),
    title: take(makeProjectTitle("Hunsu")),
    objective: take(makeProjectObjective("Prove the project flow.")),
    coachId,
    goalIds: [],
    runnerIds: [],
    createdAt: at,
    updatedAt: at
  };
  const coach: Coach = {
    id: coachId,
    projectId,
    promptTemplate: take(makePromptTemplate("Review progress and propose alternatives.")),
    resources: [],
    policy: {
      goalChanges: "propose_only",
      runnerChanges: "propose_only",
      hunsu: "propose_only",
      selection: "user_only"
    },
    createdAt: at,
    updatedAt: at
  };
  const player: Player = {
    kind: "player",
    id: playerId,
    projectId,
    promptTemplate: take(makePromptTemplate("Build the focused change.")),
    resources: [],
    runtimePolicy: { fileAccess: "project_write", network: "denied", approval: "user" },
    createdAt: at,
    updatedAt: at
  };
  const goal: ActiveGoal = {
    id: take(makeGoalId("goal_alpha")),
    projectId,
    title: take(makeGoalTitle("Complete the vertical slice")),
    desiredOutcome: take(makeDesiredOutcome("A verified plugin-driven Run appears in the Project.")),
    acceptanceCriteria: [take(makeAcceptanceCriterion("The result commit is verified."))],
    constraints: [],
    priority: take(makeNonNegativeInteger(10)),
    assignment: { type: "assigned", runnerId: playerId },
    relation: { type: "root" },
    status: "active",
    createdAt: at,
    updatedAt: at
  };
  return { project, coach, player, goal, baseSha: take(makeGitCommitSha("a".repeat(40))) };
}

function accept(state: ProjectState, command: ProjectCommand, events: DomainEvent[]): ProjectState {
  const applied = applyProjectCommand(state, command);
  if (!applied.ok) throw new Error(applied.error.code + ": " + applied.error.message);
  events.push(...applied.value.emittedEvents);
  return applied.value.state;
}

function metadata(index: number, actor: DomainActor = userActor()): ProjectCommand["meta"] {
  return {
    eventId: take(makeEventId("event_" + index)),
    idempotencyKey: take(makeIdempotencyKey(index.toString(16).padStart(64, "0"))),
    fingerprint: fingerprint(index),
    actor,
    requestedAt: time(index)
  };
}

function fingerprint(index: number) {
  return take(makeCommandFingerprint((index + 4096).toString(16).padStart(64, "0")));
}

function userActor(): DomainActor {
  return { type: "user", id: take(makeNonEmptyText("user-alpha")) };
}

function pluginActor(): DomainActor {
  return { type: "plugin", id: take(makeNonEmptyText("hunsu-plugin")) };
}

function time(index: number) {
  return take(makeIsoTimestamp("2026-07-13T00:" + String(index).padStart(2, "0") + ":00.000Z"));
}

function take<T, E>(result: Result<T, E>): T {
  if (!result.ok) throw new Error("Fixture construction failed");
  return result.value;
}
