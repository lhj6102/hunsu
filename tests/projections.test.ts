import test from "node:test";
import assert from "node:assert/strict";
import {
  applyProjectCommand,
  emptyProjectState
} from "../packages/core/src/index.ts";
import {
  alternativeComparisonProjection,
  coachViewProjection,
  goalDetailProjection,
  projectListProjection,
  projectOverviewProjection,
  runDetailProjection,
  runnerDirectoryProjection,
  type ProjectionContext,
  type ProjectionResult
} from "../packages/projections/src/index.ts";
import {
  makeAcceptanceCriterion,
  makeCheckpointId,
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
  makeGoalConstraint,
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
  makeResourceName,
  makeRunId,
  makeRunnerId,
  makeWorkspaceId,
  runBranchName,
  type ActiveGoal,
  type Coach,
  type DomainActor,
  type Player,
  type Project,
  type ProjectCommand,
  type ProjectState,
  type Result,
  type Team
} from "../packages/protocol/src/index.ts";

const fixture = buildFixture();

test("Project list and overview isolate repository-backed Project data", () => {
  const items = projectListProjection([{ state: fixture.state, context: fixture.context }]);
  assert.equal(items.length, 2);

  const item = items.find(candidate => candidate.id === fixture.project.id);
  assert.ok(item);
  assert.equal(item.repository.url, "https://github.com/openai/hunsu");
  assert.equal(item.repository.defaultBranch, "main");
  assert.equal(item.activeGoalCount, 0);
  assert.equal(item.activeRunCount, 0);
  assert.equal(item.latestResult?.runId, fixture.alternativeRunId);
  assert.equal(item.latestResult?.status, "completed");
  assert.equal(item.coachReviewStatus, "changes_recommended");
  assert.equal(item.unresolvedAlternativeCount, 0);
  assert.equal(item.synchronizedAt, fixture.context.health.synchronizedAt);

  const overview = projectionValue(projectOverviewProjection(
    fixture.state,
    fixture.project.id,
    fixture.context
  ));
  assert.equal(overview.id, fixture.project.id);
  assert.equal(overview.goals.length, 1);
  assert.equal(overview.runs.length, 2);
  assert.equal(overview.recentEvidence.length, 2);
  assert.equal(overview.recentEvidence[0]?.id, fixture.alternativeEvidenceId);
  assert.equal(overview.alternatives[0]?.status, "selected");
  assert.deepEqual(overview.alternatives[0]?.runIds, [
    fixture.sourceRunId,
    fixture.alternativeRunId
  ]);

  assert.deepEqual(overview.decisions.map(decision => decision.id), [
    fixture.rejectionDecisionId,
    fixture.selectionDecisionId
  ]);
  assert.equal(
    overview.decisions.some(decision => decision.id === fixture.foreignSelectionDecisionId),
    false,
    "another Project's alternative decision must not leak into this overview"
  );
});

test("Goal and Run projections expose immutable snapshots, checkpoints, and evidence", () => {
  const goal = projectionValue(goalDetailProjection(
    fixture.state,
    fixture.project.id,
    fixture.goal.id
  ));
  assert.equal(goal.title, fixture.updatedGoalTitle);
  assert.equal(goal.status, "completed");
  assert.equal(goal.priority, "high");
  assert.equal(goal.runner?.id, fixture.player.id);
  assert.equal(goal.runs.length, 2);
  assert.equal(goal.evidence.length, 2);
  assert.equal(goal.coachReview?.status, "changes_recommended");
  assert.equal(goal.decision?.recommendedRunId, fixture.alternativeRunId);

  const run = projectionValue(runDetailProjection(
    fixture.state,
    fixture.project.id,
    fixture.sourceRunId
  ));
  assert.equal(run.status, "completed");
  assert.equal(run.resultSha, fixture.sourceResultSha);
  assert.equal(run.goalSnapshot.title, fixture.originalGoalTitle);
  assert.notEqual(run.goalSnapshot.title, goal.title);
  assert.deepEqual(run.goalSnapshot.acceptanceCriteria, [fixture.criterion]);
  assert.deepEqual(run.goalSnapshot.constraints, [fixture.constraint]);
  assert.equal(run.runnerSnapshot.kind, "player");
  if (run.runnerSnapshot.kind === "player") {
    assert.deepEqual(run.runnerSnapshot.runtimePolicy, {
      filesystem: "worktree_write",
      network: "disabled",
      approvals: "on_request"
    });
    assert.deepEqual(run.runnerSnapshot.resources, [{
      id: "skill:typescript",
      kind: "skill",
      name: "typescript",
      reference: "skill://typescript"
    }, {
      id: "plugin:eslint",
      kind: "plugin",
      name: "eslint",
      reference: "1.2.3"
    }]);
  }
  assert.equal(run.instructions, fixture.player.promptTemplate);
  assert.equal(run.checkpoints.length, 1);
  assert.equal(run.checkpoints[0]?.commitSha, fixture.sourceResultSha);
  assert.equal(run.evidenceCount, 1);
  assert.equal(run.evidence[0]?.id, fixture.sourceEvidenceId);
  assert.equal(run.evidence[0]?.kind, "check");
  assert.equal(run.evidence[0]?.criterion, fixture.criterion);
  assert.equal(
    run.evidence[0]?.url,
    `https://github.com/openai/hunsu/blob/${fixture.sourceResultSha}/reports/acceptance.json`
  );

  assert.equal(
    goal.evidence.find(item => item.id === fixture.sourceEvidenceId)?.criterion,
    fixture.criterion
  );
});

test("Runner and Coach projections preserve closed Runner variants and proposal dispositions", () => {
  const runners = projectionValue(runnerDirectoryProjection(fixture.state, fixture.project.id));
  assert.equal(runners.length, 3);

  const player = runners.find(candidate => candidate.id === fixture.player.id);
  assert.ok(player);
  assert.equal(player.kind, "player");
  if (player.kind === "player") {
    assert.equal(player.runtimePolicy.filesystem, "worktree_write");
    assert.equal(player.runtimePolicy.network, "disabled");
    assert.equal(player.runtimePolicy.approvals, "on_request");
    assert.deepEqual(player.resources, [{
      id: "skill:typescript",
      kind: "skill",
      name: "typescript",
      reference: "skill://typescript"
    }, {
      id: "plugin:eslint",
      kind: "plugin",
      name: "eslint",
      reference: "1.2.3"
    }]);
    assert.equal(player.goalCount, 1);
    assert.equal(player.recentResults.length, 2);
  }

  const team = runners.find(candidate => candidate.id === fixture.team.id);
  assert.ok(team);
  assert.equal(team.kind, "team");
  if (team.kind === "team") {
    assert.deepEqual(team.strategy, {
      mode: "sequence",
      promptTemplate: "Run the Player in order.",
      maxRounds: 1
    });
    assert.deepEqual(team.players, [{
      playerId: fixture.player.id,
      playerName: fixture.player.id,
      role: "builder",
      order: 1
    }]);
    assert.equal(team.goalCount, 0);
  }

  const coach = projectionValue(coachViewProjection(fixture.state, fixture.project.id));
  assert.equal(coach.assessment.summary, "The verified result should be compared with a focused alternative.");
  assert.equal(coach.weakGoals.length, 0);
  assert.equal(coach.stalledRuns.length, 0);
  assert.equal(coach.proposals.length, 3);
  assert.equal(coach.comparisonRecommendations.length, 1);
  assert.deepEqual(coach.comparisonRecommendations[0], {
    id: `comparison-recommendation:${fixture.divergenceId}`,
    divergenceId: fixture.divergenceId,
    goalId: fixture.goal.id,
    goalTitle: fixture.updatedGoalTitle,
    baseSha: fixture.baseSha,
    runIds: [fixture.sourceRunId, fixture.alternativeRunId],
    completedRunCount: 2,
    status: "comparison_recorded",
    recommendation: "Review the recorded criterion-by-criterion comparison before deciding: The focused alternative is preferred.",
    comparisonId: fixture.comparisonId
  });
  assert.equal(coach.selectionRecommendations.length, 1);
  assert.deepEqual(coach.selectionRecommendations[0], {
    id: `selection-recommendation:${fixture.comparisonId}`,
    comparisonId: fixture.comparisonId,
    goalId: fixture.goal.id,
    goalTitle: fixture.updatedGoalTitle,
    runIds: [fixture.sourceRunId, fixture.alternativeRunId],
    status: "decision_recorded",
    action: "select",
    recommendation: "The user confirmed this selection: Prefer the focused verified result.",
    basis: "recorded_decision",
    recommendedRunId: fixture.alternativeRunId,
    requiresUserConfirmation: true
  });
  const pendingCoach = projectionValue(coachViewProjection({
    ...fixture.state,
    decisions: fixture.state.decisions.filter(decision => decision.comparisonId !== fixture.comparisonId)
  }, fixture.project.id));
  assert.equal(pendingCoach.selectionRecommendations[0]?.status, "awaiting_user");
  assert.equal(pendingCoach.selectionRecommendations[0]?.action, "review_selection");
  assert.equal(pendingCoach.selectionRecommendations[0]?.requiresUserConfirmation, true);
  assert.equal(
    coach.proposals.find(proposal => proposal.id === fixture.acceptedProposalId)?.status,
    "confirmed"
  );
  assert.equal(
    coach.proposals.find(proposal => proposal.id === fixture.rejectedProposalId)?.status,
    "rejected"
  );
  const goalProposal = coach.proposals.find(proposal => proposal.id === fixture.acceptedProposalId);
  assert.equal(goalProposal?.kind, "goal_change");
  if (goalProposal?.kind === "goal_change") assert.equal(goalProposal.change.title, fixture.updatedGoalTitle);
  const runnerProposal = coach.proposals.find(proposal => proposal.id === fixture.rejectedProposalId);
  assert.equal(runnerProposal?.kind, "runner_change");
  if (runnerProposal?.kind === "runner_change") {
    assert.equal(runnerProposal.change.from.type, "assigned");
    assert.equal(runnerProposal.change.from.type === "assigned" ? runnerProposal.change.from.runnerId : undefined, fixture.player.id);
    assert.equal(runnerProposal.change.to.runnerId, fixture.alternatePlayerId);
  }
  const hunsuProposal = coach.proposals.find(proposal => proposal.id === fixture.hunsuProposalId);
  assert.equal(hunsuProposal?.kind, "hunsu");
  if (hunsuProposal?.kind === "hunsu") {
    assert.equal(hunsuProposal.sourceRun.id, fixture.sourceRunId);
    assert.equal(hunsuProposal.sourceRun.status, "completed");
    assert.equal(hunsuProposal.sourceRun.resultSha, fixture.sourceResultSha);
    assert.equal(hunsuProposal.alternative.type, "goal_change");
    if (hunsuProposal.alternative.type === "goal_change") {
      assert.deepEqual(hunsuProposal.alternative.change, {
        desiredOutcome: "Compare the implementation and review outcomes.",
        acceptanceCriteria: [fixture.criterion],
        constraints: [fixture.constraint],
        priority: 80,
        assignment: {
          type: "assigned",
          runnerId: fixture.team.id,
          runner: { id: fixture.team.id, kind: "team", name: fixture.team.id }
        }
      });
    }
  }
});

test("same-base alternative projections show comparison evidence and explicit selection", () => {
  const comparison = projectionValue(alternativeComparisonProjection(
    fixture.state,
    fixture.project.id,
    fixture.comparisonId
  ));
  assert.equal(comparison.baseSha, fixture.baseSha);
  assert.equal(comparison.id, fixture.comparisonId);
  assert.equal(comparison.divergenceId, fixture.divergenceId);
  assert.equal(comparison.summary, "The focused alternative is preferred.");
  assert.deepEqual(comparison.runIds, [fixture.sourceRunId, fixture.alternativeRunId]);
  assert.deepEqual(comparison.findings, [{
    criterion: fixture.criterion,
    summaries: [
      { runId: fixture.sourceRunId, summary: "The broad Run passes with extra surface area." },
      { runId: fixture.alternativeRunId, summary: "The focused Run passes with a smaller change." }
    ]
  }]);
  assert.equal(comparison.alternatives.length, 2);
  assert.ok(comparison.alternatives.every(alternative => alternative.run.baseSha === fixture.baseSha));

  const source = comparison.alternatives.find(alternative => alternative.run.id === fixture.sourceRunId);
  const alternative = comparison.alternatives.find(candidate => candidate.run.id === fixture.alternativeRunId);
  assert.ok(source);
  assert.ok(alternative);
  assert.equal(source.selected, false);
  assert.equal(source.rejected, true);
  assert.equal(source.summary, "The broad Run passes with extra surface area.");
  assert.equal(source.evidence[0]?.id, fixture.sourceEvidenceId);
  assert.equal(alternative.selected, true);
  assert.equal(alternative.rejected, false);
  assert.equal(alternative.summary, "The focused Run passes with a smaller change.");
  assert.equal(alternative.evidence[0]?.id, fixture.alternativeEvidenceId);
  assert.deepEqual(alternative.strengths, [fixture.criterion]);

  const goal = projectionValue(goalDetailProjection(fixture.state, fixture.project.id, fixture.goal.id));
  assert.equal(goal.comparisons.length, 1);
  assert.equal(goal.comparisons[0]?.id, fixture.comparisonId);
  assert.deepEqual(goal.comparisons[0]?.findings, comparison.findings);
  const selected = goal.alternatives.find(candidate => candidate.run.id === fixture.alternativeRunId);
  const rejected = goal.alternatives.find(candidate => candidate.run.id === fixture.sourceRunId);
  assert.equal(selected?.selected, true);
  assert.equal(rejected?.rejected, true);
});

test("Goal decision prefers a later valid selection over a prior partial rejection", () => {
  const projected = projectionValue(goalDetailProjection(fixture.state, fixture.project.id, fixture.goal.id));
  assert.equal(projected.decision?.id, fixture.selectionDecisionId);
  assert.equal(projected.decision?.status, "confirmed");
  assert.equal(projected.decision?.recommendedRunId, fixture.alternativeRunId);
});

function buildFixture() {
  let state = emptyProjectState();
  let commandIndex = 1;
  const execute = (command: ProjectCommand): void => {
    state = accept(state, command);
  };
  const nextMetadata = (actor: DomainActor = userActor()): ProjectCommand["meta"] => metadata(commandIndex++, actor);

  const projectId = take(makeProjectId("project_alpha"));
  const coachId = take(makeCoachId("coach_alpha"));
  const playerId = take(makeRunnerId("player_alpha"));
  const alternatePlayerId = take(makeRunnerId("player_beta"));
  const teamId = take(makeRunnerId("team_alpha"));
  const createdAt = time(0);
  const project: Project = {
    id: projectId,
    workspaceId: take(makeWorkspaceId("workspace_alpha")),
    repository: {
      owner: take(makeRepositoryOwner("openai")),
      name: take(makeRepositoryName("hunsu"))
    },
    baseRef: take(makeGitRef("refs/heads/main")),
    title: take(makeProjectTitle("Hunsu")),
    objective: take(makeProjectObjective("Prove a GitHub-backed product flow.")),
    coachId,
    goalIds: [],
    runnerIds: [],
    createdAt,
    updatedAt: createdAt
  };
  const coach: Coach = {
    id: coachId,
    projectId,
    promptTemplate: take(makePromptTemplate("Review evidence and propose deliberate changes.")),
    resources: [],
    policy: {
      goalChanges: "propose_only",
      runnerChanges: "propose_only",
      hunsu: "propose_only",
      selection: "user_only"
    },
    createdAt,
    updatedAt: createdAt
  };
  execute({ type: "CreateProject", meta: nextMetadata(), project, coach });

  const player: Player = {
    kind: "player",
    id: playerId,
    projectId,
    promptTemplate: take(makePromptTemplate("Implement the smallest verified change.")),
    resources: [{
      type: "skill",
      name: take(makeResourceName("typescript")),
      source: take(makeNonEmptyText("skill://typescript"))
    }, {
      type: "plugin",
      name: take(makeResourceName("eslint")),
      version: take(makeNonEmptyText("1.2.3"))
    }],
    runtimePolicy: { fileAccess: "project_write", network: "denied", approval: "user" },
    createdAt,
    updatedAt: createdAt
  };
  const alternatePlayer: Player = {
    ...player,
    id: alternatePlayerId,
    promptTemplate: take(makePromptTemplate("Implement a broader alternative."))
  };
  execute({ type: "CreatePlayer", meta: nextMetadata(), player });
  execute({ type: "CreatePlayer", meta: nextMetadata(), player: alternatePlayer });

  const team: Team = {
    kind: "team",
    id: teamId,
    projectId,
    strategy: {
      mode: "sequence",
      promptTemplate: take(makePromptTemplate("Run the Player in order.")),
      maxRounds: take(makePositiveInteger(1))
    },
    players: [{
      playerId,
      role: take(makeNonEmptyText("builder")),
      order: take(makePositiveInteger(1))
    }],
    createdAt,
    updatedAt: createdAt
  };
  execute({ type: "CreateTeam", meta: nextMetadata(), team });

  const originalGoalTitle = take(makeGoalTitle("Deliver the verified Project slice"));
  const updatedGoalTitle = take(makeGoalTitle("Deliver the verified Project slice with comparison"));
  const criterion = take(makeAcceptanceCriterion("The result is verified against the Run branch."));
  const constraint = take(makeGoalConstraint("Keep repository state free of credentials."));
  const goal: ActiveGoal = {
    id: take(makeGoalId("goal_alpha")),
    projectId,
    title: originalGoalTitle,
    desiredOutcome: take(makeDesiredOutcome("A verified Run appears in the Project.")),
    acceptanceCriteria: [criterion],
    constraints: [constraint],
    priority: take(makeNonNegativeInteger(70)),
    assignment: { type: "assigned", runnerId: playerId },
    relation: { type: "root" },
    status: "active",
    createdAt,
    updatedAt: createdAt
  };
  execute({ type: "CreateGoal", meta: nextMetadata(), goal });

  const baseSha = take(makeGitCommitSha("a".repeat(40)));
  const sourceResultSha = take(makeGitCommitSha("b".repeat(40)));
  const alternativeResultSha = take(makeGitCommitSha("c".repeat(40)));
  const sourceRunId = take(makeRunId("run_source"));
  const alternativeRunId = take(makeRunId("run_alternative"));
  execute({
    type: "StartRun",
    meta: nextMetadata(pluginActor()),
    runId: sourceRunId,
    projectId,
    goalId: goal.id,
    runnerId: playerId,
    baseSha,
    branch: runBranchName(projectId, goal.id, sourceRunId),
    origin: { type: "primary" }
  });
  execute({
    type: "CheckpointRun",
    meta: nextMetadata(pluginActor()),
    checkpoint: {
      id: take(makeCheckpointId("checkpoint_source")),
      runId: sourceRunId,
      summary: take(makeEvidenceSummary("Acceptance check committed.")),
      commitSha: sourceResultSha,
      recordedAt: time(commandIndex)
    }
  });

  const sourceEvidenceId = take(makeEvidenceId("evidence_source"));
  execute({
    type: "AttachRunEvidence",
    meta: nextMetadata(pluginActor()),
    evidence: {
      id: sourceEvidenceId,
      projectId,
      runId: sourceRunId,
      criterion,
      kind: "check",
      summary: take(makeEvidenceSummary("Acceptance check passed.")),
      location: {
        type: "git",
        commitSha: sourceResultSha,
        path: take(makeNonEmptyText("reports/acceptance.json"))
      },
      recordedAt: time(commandIndex)
    }
  });
  execute({
    type: "CompleteRun",
    meta: nextMetadata(pluginActor()),
    result: {
      runId: sourceRunId,
      branch: runBranchName(projectId, goal.id, sourceRunId),
      resultSha: sourceResultSha,
      verifiedAt: time(commandIndex)
    }
  });

  execute({
    type: "RecordCoachReview",
    meta: nextMetadata(coachActor(coachId)),
    review: {
      id: take(makeCoachReviewId("review_alpha")),
      projectId,
      coachId,
      target: { type: "run", runId: sourceRunId },
      assessment: take(makeNonEmptyText("The verified result should be compared with a focused alternative.")),
      recommendations: [take(makeNonEmptyText("Compare a smaller implementation."))],
      recordedAt: time(commandIndex)
    }
  });

  const acceptedProposalId = take(makeCoachProposalId("proposal_goal_change"));
  execute({
    type: "RecordCoachProposal",
    meta: nextMetadata(coachActor(coachId)),
    proposal: {
      type: "goal_change",
      id: acceptedProposalId,
      projectId,
      coachId,
      goalId: goal.id,
      change: { title: updatedGoalTitle },
      reason: take(makeReason("Make the comparison requirement explicit.")),
      proposedAt: time(commandIndex)
    }
  });
  execute({
    type: "AcceptCoachProposal",
    meta: nextMetadata(),
    proposalId: acceptedProposalId,
    reason: take(makeReason("The clarification is useful.")),
    application: { type: "apply_change" }
  });

  const rejectedProposalId = take(makeCoachProposalId("proposal_runner_change"));
  execute({
    type: "RecordCoachProposal",
    meta: nextMetadata(coachActor(coachId)),
    proposal: {
      type: "runner_change",
      id: rejectedProposalId,
      projectId,
      coachId,
      goalId: goal.id,
      runnerId: alternatePlayerId,
      reason: take(makeReason("Use the broader Player.")),
      proposedAt: time(commandIndex)
    }
  });
  execute({
    type: "RejectCoachProposal",
    meta: nextMetadata(),
    proposalId: rejectedProposalId,
    reason: take(makeReason("Keep the focused Player."))
  });

  const hunsuProposalId = take(makeCoachProposalId("proposal_hunsu_goal_change"));
  execute({
    type: "RecordCoachProposal",
    meta: nextMetadata(coachActor(coachId)),
    proposal: {
      type: "hunsu",
      id: hunsuProposalId,
      projectId,
      coachId,
      goalId: goal.id,
      sourceRunId,
      alternative: {
        type: "goal_change",
        change: {
          desiredOutcome: take(makeDesiredOutcome("Compare the implementation and review outcomes.")),
          acceptanceCriteria: [criterion],
          constraints: [constraint],
          priority: take(makeNonNegativeInteger(80)),
          assignment: { type: "assigned", runnerId: teamId }
        }
      },
      reason: take(makeReason("Compare an explicitly coordinated Goal alternative.")),
      proposedAt: time(commandIndex)
    }
  });
  execute({
    type: "RejectCoachProposal",
    meta: nextMetadata(),
    proposalId: hunsuProposalId,
    reason: take(makeReason("Keep the user-created divergence for this fixture."))
  });

  const divergenceId = take(makeDivergenceId("divergence_alpha"));
  execute({
    type: "ConfirmHunsu",
    meta: nextMetadata(),
    divergenceId,
    projectId,
    goalId: goal.id,
    sourceRunId,
    basis: { type: "user", reason: take(makeReason("Compare a focused sibling.")) }
  });
  execute({
    type: "StartRun",
    meta: nextMetadata(pluginActor()),
    runId: alternativeRunId,
    projectId,
    goalId: goal.id,
    runnerId: playerId,
    baseSha,
    branch: runBranchName(projectId, goal.id, alternativeRunId),
    origin: { type: "hunsu_alternative", divergenceId, sourceRunId }
  });

  const alternativeEvidenceId = take(makeEvidenceId("evidence_alternative"));
  execute({
    type: "AttachRunEvidence",
    meta: nextMetadata(pluginActor()),
    evidence: {
      id: alternativeEvidenceId,
      projectId,
      runId: alternativeRunId,
      criterion,
      kind: "report",
      summary: take(makeEvidenceSummary("Focused implementation report.")),
      location: {
        type: "url",
        url: take(makeNonEmptyText("https://example.test/reports/focused"))
      },
      recordedAt: time(commandIndex)
    }
  });
  execute({
    type: "CompleteRun",
    meta: nextMetadata(pluginActor()),
    result: {
      runId: alternativeRunId,
      branch: runBranchName(projectId, goal.id, alternativeRunId),
      resultSha: alternativeResultSha,
      verifiedAt: time(commandIndex)
    }
  });

  const comparisonId = take(makeComparisonId("comparison_alpha"));
  execute({
    type: "CompareAlternatives",
    meta: nextMetadata(),
    comparisonId,
    divergenceId,
    runIds: [sourceRunId, alternativeRunId],
    findings: [{
      criterion,
      summaries: [
        { runId: sourceRunId, summary: take(makeEvidenceSummary("The broad Run passes with extra surface area.")) },
        { runId: alternativeRunId, summary: take(makeEvidenceSummary("The focused Run passes with a smaller change.")) }
      ]
    }],
    summary: take(makeEvidenceSummary("The focused alternative is preferred."))
  });
  const rejectionDecisionId = take(makeDecisionId("decision_reject_source"));
  execute({
    type: "RejectAlternatives",
    meta: nextMetadata(),
    decisionId: rejectionDecisionId,
    comparisonId,
    rejectedRunIds: [sourceRunId],
    rationale: take(makeReason("The source Run carries unnecessary surface area."))
  });
  const selectionDecisionId = take(makeDecisionId("decision_alpha"));
  execute({
    type: "SelectAlternative",
    meta: nextMetadata(),
    decisionId: selectionDecisionId,
    comparisonId,
    selectedRunId: alternativeRunId,
    rationale: take(makeReason("Prefer the focused verified result."))
  });
  execute({
    type: "CompleteGoal",
    meta: nextMetadata(),
    goalId: goal.id,
    selectedRunId: alternativeRunId
  });

  const foreign = addForeignProject(state, commandIndex);
  state = foreign.state;

  const context: ProjectionContext = {
    health: {
      repositoryAccess: "healthy",
      stateRef: "healthy",
      stateRefName: "hunsu/state",
      stateHeadSha: "f".repeat(40),
      projection: "current",
      synchronizedAt: "2026-07-13T01:00:00.000Z"
    }
  };

  return {
    state,
    context,
    project,
    coach,
    player,
    alternatePlayerId,
    team,
    goal,
    originalGoalTitle,
    updatedGoalTitle,
    criterion,
    constraint,
    baseSha,
    sourceResultSha,
    sourceRunId,
    alternativeRunId,
    sourceEvidenceId,
    alternativeEvidenceId,
    acceptedProposalId,
    rejectedProposalId,
    hunsuProposalId,
    divergenceId,
    comparisonId,
    rejectionDecisionId,
    selectionDecisionId,
    foreignSelectionDecisionId: foreign.selectionDecisionId
  };
}

function addForeignProject(initial: ProjectState, firstCommandIndex: number) {
  let state = initial;
  let commandIndex = firstCommandIndex;
  const execute = (command: ProjectCommand): void => {
    state = accept(state, command);
  };
  const nextMetadata = (actor: DomainActor = userActor()): ProjectCommand["meta"] => metadata(commandIndex++, actor);

  const projectId = take(makeProjectId("project_foreign"));
  const coachId = take(makeCoachId("coach_foreign"));
  const playerId = take(makeRunnerId("player_foreign"));
  const at = time(commandIndex);
  const project: Project = {
    id: projectId,
    workspaceId: take(makeWorkspaceId("workspace_foreign")),
    repository: {
      owner: take(makeRepositoryOwner("openai")),
      name: take(makeRepositoryName("foreign"))
    },
    baseRef: take(makeGitRef("refs/heads/main")),
    title: take(makeProjectTitle("Foreign Project")),
    objective: take(makeProjectObjective("Prove Project decision isolation.")),
    coachId,
    goalIds: [],
    runnerIds: [],
    createdAt: at,
    updatedAt: at
  };
  const coach: Coach = {
    id: coachId,
    projectId,
    promptTemplate: take(makePromptTemplate("Review the foreign Project.")),
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
    promptTemplate: take(makePromptTemplate("Build the foreign result.")),
    resources: [],
    runtimePolicy: { fileAccess: "project_write", network: "denied", approval: "user" },
    createdAt: at,
    updatedAt: at
  };
  const goal: ActiveGoal = {
    id: take(makeGoalId("goal_foreign")),
    projectId,
    title: take(makeGoalTitle("Deliver a foreign result")),
    desiredOutcome: take(makeDesiredOutcome("A foreign decision exists.")),
    acceptanceCriteria: [take(makeAcceptanceCriterion("The foreign result is verified."))],
    constraints: [],
    priority: take(makeNonNegativeInteger(30)),
    assignment: { type: "assigned", runnerId: playerId },
    relation: { type: "root" },
    status: "active",
    createdAt: at,
    updatedAt: at
  };

  execute({ type: "CreateProject", meta: nextMetadata(), project, coach });
  execute({ type: "CreatePlayer", meta: nextMetadata(), player });
  execute({ type: "CreateGoal", meta: nextMetadata(), goal });

  const baseSha = take(makeGitCommitSha("d".repeat(40)));
  const sourceResultSha = take(makeGitCommitSha("e".repeat(40)));
  const alternativeResultSha = take(makeGitCommitSha("f".repeat(40)));
  const criterion = goal.acceptanceCriteria[0];
  const sourceRunId = take(makeRunId("run_foreign_source"));
  const alternativeRunId = take(makeRunId("run_foreign_alternative"));
  execute({
    type: "StartRun",
    meta: nextMetadata(pluginActor()),
    runId: sourceRunId,
    projectId,
    goalId: goal.id,
    runnerId: playerId,
    baseSha,
    branch: runBranchName(projectId, goal.id, sourceRunId),
    origin: { type: "primary" }
  });
  execute({
    type: "AttachRunEvidence",
    meta: nextMetadata(pluginActor()),
    evidence: {
      id: take(makeEvidenceId("evidence_foreign_source")),
      projectId,
      runId: sourceRunId,
      criterion,
      kind: "check",
      summary: take(makeEvidenceSummary("The foreign source result is verified.")),
      location: { type: "git", commitSha: sourceResultSha, path: take(makeNonEmptyText("reports/source.json")) },
      recordedAt: time(commandIndex)
    }
  });
  execute({
    type: "CompleteRun",
    meta: nextMetadata(pluginActor()),
    result: {
      runId: sourceRunId,
      branch: runBranchName(projectId, goal.id, sourceRunId),
      resultSha: sourceResultSha,
      verifiedAt: time(commandIndex)
    }
  });

  const divergenceId = take(makeDivergenceId("divergence_foreign"));
  execute({
    type: "ConfirmHunsu",
    meta: nextMetadata(),
    divergenceId,
    projectId,
    goalId: goal.id,
    sourceRunId,
    basis: { type: "user", reason: take(makeReason("Compare a foreign sibling.")) }
  });
  execute({
    type: "UpdatePlayer",
    meta: nextMetadata(),
    player: {
      ...player,
      promptTemplate: take(makePromptTemplate("Build the foreign sibling with a narrower approach.")),
      updatedAt: time(commandIndex)
    }
  });
  execute({
    type: "StartRun",
    meta: nextMetadata(pluginActor()),
    runId: alternativeRunId,
    projectId,
    goalId: goal.id,
    runnerId: playerId,
    baseSha,
    branch: runBranchName(projectId, goal.id, alternativeRunId),
    origin: { type: "hunsu_alternative", divergenceId, sourceRunId }
  });
  execute({
    type: "AttachRunEvidence",
    meta: nextMetadata(pluginActor()),
    evidence: {
      id: take(makeEvidenceId("evidence_foreign_alternative")),
      projectId,
      runId: alternativeRunId,
      criterion,
      kind: "check",
      summary: take(makeEvidenceSummary("The foreign alternative result is verified.")),
      location: { type: "git", commitSha: alternativeResultSha, path: take(makeNonEmptyText("reports/alternative.json")) },
      recordedAt: time(commandIndex)
    }
  });
  execute({
    type: "CompleteRun",
    meta: nextMetadata(pluginActor()),
    result: {
      runId: alternativeRunId,
      branch: runBranchName(projectId, goal.id, alternativeRunId),
      resultSha: alternativeResultSha,
      verifiedAt: time(commandIndex)
    }
  });

  const comparisonId = take(makeComparisonId("comparison_foreign"));
  execute({
    type: "CompareAlternatives",
    meta: nextMetadata(),
    comparisonId,
    divergenceId,
    runIds: [sourceRunId, alternativeRunId],
    findings: [{
      criterion,
      summaries: [
        { runId: sourceRunId, summary: take(makeEvidenceSummary("The foreign source satisfies the criterion.")) },
        { runId: alternativeRunId, summary: take(makeEvidenceSummary("The foreign alternative satisfies the criterion.")) }
      ]
    }],
    summary: take(makeEvidenceSummary("The foreign alternative is preferred."))
  });
  const selectionDecisionId = take(makeDecisionId("decision_foreign"));
  execute({
    type: "SelectAlternative",
    meta: nextMetadata(),
    decisionId: selectionDecisionId,
    comparisonId,
    selectedRunId: alternativeRunId,
    rationale: take(makeReason("Select the foreign alternative."))
  });

  return { state, selectionDecisionId };
}

function accept(state: ProjectState, command: ProjectCommand): ProjectState {
  const applied = applyProjectCommand(state, command);
  if (!applied.ok) throw new Error(applied.error.code + ": " + applied.error.message);
  return applied.value.state;
}

function metadata(index: number, actor: DomainActor): ProjectCommand["meta"] {
  return {
    eventId: take(makeEventId("event_projection_" + index)),
    idempotencyKey: take(makeIdempotencyKey(index.toString(16).padStart(64, "0"))),
    fingerprint: take(makeCommandFingerprint((index + 4096).toString(16).padStart(64, "0"))),
    actor,
    requestedAt: time(index)
  };
}

function userActor(): DomainActor {
  return { type: "user", id: take(makeNonEmptyText("user-alpha")) };
}

function pluginActor(): DomainActor {
  return { type: "plugin", id: take(makeNonEmptyText("hunsu-plugin")) };
}

function coachActor(coachId: Coach["id"]): DomainActor {
  return { type: "coach", coachId };
}

function time(index: number) {
  return take(makeIsoTimestamp("2026-07-13T00:00:" + String(index).padStart(2, "0") + ".000Z"));
}

function projectionValue<T>(result: ProjectionResult<T>): T {
  if (!result.ok) throw new Error(result.error.code + ": " + result.error.message);
  return result.value;
}

function take<T, E>(result: Result<T, E>): T {
  if (!result.ok) throw new Error("Fixture construction failed");
  return result.value;
}
