import type {
  AlternativeComparison,
  AlternativeDecision,
  CoachProposal,
  EvidenceRef,
  Goal,
  GoalPatch,
  Project,
  ProjectState,
  ResourceBinding,
  Run,
  Runner,
  RunnerSnapshot
} from "@hunsu/protocol";
import type {
  AlternativeComparisonProjection,
  AssignedRunnerProjection,
  CoachComparisonRecommendationProjection,
  CoachProposalProjection,
  CoachProjection,
  CoachSelectionRecommendationProjection,
  DecisionProjection,
  EvidenceProjection,
  GoalAssignmentProjection,
  GoalAlternativeProjection,
  GoalDetailProjection,
  GoalPatchProjection,
  GoalSummaryProjection,
  ProjectionContext,
  ProjectListItemProjection,
  ProjectOverviewProjection,
  RepositoryProjection,
  RunDetailProjection,
  RunnerProjection,
  RunnerAssignmentChangeProjection,
  RunnerReferenceProjection,
  RunSummaryProjection
} from "./types.ts";

export type ProjectionError = {
  code: "project_not_found" | "goal_not_found" | "run_not_found" | "coach_not_found" | "comparison_not_found";
  message: string;
};

export type ProjectionResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ProjectionError };

export function projectListProjection(entries: readonly { state: ProjectState; context: ProjectionContext }[]): ProjectListItemProjection[] {
  return entries.flatMap(({ state, context }) => state.projects.map(project => projectListItem(state, project, context)));
}

export function projectOverviewProjection(state: ProjectState, projectId: string, context: ProjectionContext): ProjectionResult<ProjectOverviewProjection> {
  const project = state.projects.find(candidate => candidate.id === projectId);
  if (!project) return failure("project_not_found", `Project ${projectId} was not found.`);
  const goals = goalsFor(state, project);
  const runs = runsFor(state, project);
  const evidence = evidenceForProject(state, project);
  const projectComparisonIds = new Set(state.comparisons.filter(comparison => comparison.projectId === project.id).map(comparison => comparison.id));
  const decisions = state.decisions.filter(decision => projectComparisonIds.has(decision.comparisonId)).flatMap(decision => decisionProjection(state, decision));
  return ok({
    id: project.id,
    title: project.title,
    objective: project.objective,
    baseRef: project.baseRef,
    repository: repositoryProjection(project),
    goals: goals.map(goal => goalSummary(state, goal)),
    runs: runs.map(run => runSummary(state, project, run)),
    recentEvidence: evidence.map(item => evidenceProjection(project, item)).sort(newestFirst).slice(0, 12),
    alternatives: state.divergences
      .filter(divergence => divergence.projectId === project.id)
      .map(divergence => ({
        id: divergence.id,
        goalId: divergence.goalId,
        goalTitle: state.goals.find(goal => goal.id === divergence.goalId)?.title ?? divergence.goalId,
        baseSha: divergence.baseSha,
        runIds: [divergence.sourceRunId, ...divergence.alternativeRunIds],
        status: divergenceDecisionStatus(state, divergence.id)
      })),
    decisions,
    health: context.health,
    createdAt: project.createdAt,
    updatedAt: latestTimestamp([project.updatedAt, ...goals.map(goal => goal.updatedAt), ...runs.map(runUpdatedAt)])
  });
}

export function goalDetailProjection(state: ProjectState, projectId: string, goalId: string): ProjectionResult<GoalDetailProjection> {
  const project = state.projects.find(candidate => candidate.id === projectId);
  if (!project) return failure("project_not_found", `Project ${projectId} was not found.`);
  const goal = state.goals.find(candidate => candidate.projectId === project.id && candidate.id === goalId);
  if (!goal) return failure("goal_not_found", `Goal ${goalId} was not found.`);
  const runs = state.runs.filter(run => run.goalId === goal.id);
  const evidence = state.evidence.filter(item => runs.some(run => run.id === item.runId));
  const latestReview = [...state.coachReviews]
    .filter(review => {
      const target = review.target;
      return review.projectId === project.id && (
        (target.type === "goal" && target.goalId === goal.id)
        || (target.type === "run" && runs.some(run => run.id === target.runId))
      );
    })
    .sort((left, right) => right.recordedAt.localeCompare(left.recordedAt))[0];
  const decision = goalDecision(state, goal);
  const alternatives = goalAlternatives(state, project, goal, runs);
  const comparisons = state.comparisons
    .filter(comparison => comparison.projectId === project.id && comparison.goalId === goal.id)
    .map(comparison => comparisonProjection(state, project, comparison));
  return ok({
    id: goal.id,
    projectId: project.id,
    title: goal.title,
    desiredOutcome: goal.desiredOutcome,
    acceptanceCriteria: [...goal.acceptanceCriteria],
    constraints: [...goal.constraints],
    status: goal.status,
    priority: priorityLabel(Number(goal.priority)),
    ...(goal.relation.type === "child" ? { parentGoalId: goal.relation.parentGoalId } : {}),
    relatedGoalIds: goal.relation.type === "related" ? [...goal.relation.goalIds] : [],
    ...(runnerReferenceById(state, assignedRunnerId(goal)) ? { runner: runnerReferenceById(state, assignedRunnerId(goal)) } : {}),
    runs: runs.map(run => runSummary(state, project, run)),
    evidence: evidence.map(item => evidenceProjection(project, item)),
    alternatives,
    comparisons,
    ...(latestReview ? {
      coachReview: {
        id: latestReview.id,
        status: latestReview.recommendations.length > 0 ? "changes_recommended" : "ready",
        summary: latestReview.assessment,
        strengths: latestReview.recommendations.length === 0 ? ["No corrective change was recommended."] : [],
        concerns: [...latestReview.recommendations],
        recommendation: latestReview.recommendations[0],
        createdAt: latestReview.recordedAt
      }
    } : {}),
    ...(decision ? { decision } : {}),
    createdAt: goal.createdAt,
    updatedAt: goal.updatedAt
  });
}

export function runnerDirectoryProjection(state: ProjectState, projectId: string): ProjectionResult<RunnerProjection[]> {
  if (!state.projects.some(project => project.id === projectId)) return failure("project_not_found", `Project ${projectId} was not found.`);
  return ok(state.runners.filter(runner => runner.projectId === projectId).map(runner => runnerProjection(state, runner)));
}

export function runDetailProjection(state: ProjectState, projectId: string, runId: string): ProjectionResult<RunDetailProjection> {
  const project = state.projects.find(candidate => candidate.id === projectId);
  if (!project) return failure("project_not_found", `Project ${projectId} was not found.`);
  const run = state.runs.find(candidate => candidate.projectId === project.id && candidate.id === runId);
  if (!run) return failure("run_not_found", `Run ${runId} was not found.`);
  const summary = runSummary(state, project, run);
  const runEvidence = state.evidence.filter(item => item.runId === run.id).map(item => evidenceProjection(project, item));
  return ok({
    ...summary,
    projectId: project.id,
    goalSnapshot: {
      title: run.goalSnapshot.title,
      desiredOutcome: run.goalSnapshot.desiredOutcome,
      acceptanceCriteria: [...run.goalSnapshot.acceptanceCriteria],
      constraints: [...run.goalSnapshot.constraints]
    },
    runnerSnapshot: runnerSnapshotProjection(state, run.runnerSnapshot),
    instructions: runnerInstructions(run.runnerSnapshot),
    checkpoints: run.checkpoints.map(checkpoint => ({
      id: checkpoint.id,
      summary: checkpoint.summary,
      ...(checkpoint.commitSha ? { commitSha: checkpoint.commitSha } : {}),
      createdAt: checkpoint.recordedAt
    })),
    evidence: runEvidence,
    ...(run.status === "failed" ? { failure: { code: "run_failed", message: run.failureReason, retryable: false } } : {})
  });
}

export function coachViewProjection(state: ProjectState, projectId: string): ProjectionResult<CoachProjection> {
  const project = state.projects.find(candidate => candidate.id === projectId);
  if (!project) return failure("project_not_found", `Project ${projectId} was not found.`);
  const coach = state.coaches.find(candidate => candidate.id === project.coachId);
  if (!coach) return failure("coach_not_found", `Coach ${project.coachId} was not found.`);
  const reviews = state.coachReviews.filter(review => review.projectId === project.id).sort((left, right) => right.recordedAt.localeCompare(left.recordedAt));
  const latest = reviews[0];
  const weakGoals = goalsFor(state, project).filter(goal => goal.status === "paused" || !state.runs.some(run => run.goalId === goal.id));
  const stalledRuns = runsFor(state, project).filter(run => run.status === "running" && run.checkpoints.length === 0);
  const comparisonRecommendations = state.divergences
    .filter(divergence => divergence.projectId === project.id)
    .map(divergence => comparisonRecommendation(state, divergence));
  const selectionRecommendations = state.comparisons
    .filter(comparison => comparison.projectId === project.id)
    .map(comparison => selectionRecommendation(state, comparison));
  return ok({
    id: coach.id,
    name: "Project Coach",
    promptTemplate: coach.promptTemplate,
    resources: coach.resources.map(resourceProjection),
    assessment: {
      summary: latest?.assessment ?? "No Coach review has been recorded.",
      updatedAt: latest?.recordedAt ?? project.updatedAt
    },
    weakGoals: weakGoals.map(goal => goalSummary(state, goal)),
    stalledRuns: stalledRuns.map(run => runSummary(state, project, run)),
    proposals: state.coachProposals.filter(proposal => proposal.projectId === project.id).map(proposal => proposalProjection(state, proposal)),
    comparisonRecommendations,
    selectionRecommendations
  });
}

function comparisonRecommendation(
  state: ProjectState,
  divergence: ProjectState["divergences"][number]
): CoachComparisonRecommendationProjection {
  const runIds = [divergence.sourceRunId, ...divergence.alternativeRunIds];
  const completedRunCount = runIds.filter(runId => state.runs.some(run => run.id === runId && run.status === "completed")).length;
  const comparison = state.comparisons
    .filter(candidate => candidate.divergenceId === divergence.id)
    .sort((left, right) => right.recordedAt.localeCompare(left.recordedAt))[0];
  const goalTitle = state.goals.find(goal => goal.id === divergence.goalId)?.title ?? divergence.goalId;
  if (comparison) {
    return {
      id: `comparison-recommendation:${divergence.id}`,
      divergenceId: divergence.id,
      goalId: divergence.goalId,
      goalTitle,
      baseSha: divergence.baseSha,
      runIds,
      completedRunCount,
      status: "comparison_recorded",
      recommendation: `Review the recorded criterion-by-criterion comparison before deciding: ${comparison.summary}`,
      comparisonId: comparison.id
    };
  }
  const ready = completedRunCount >= 2;
  return {
    id: `comparison-recommendation:${divergence.id}`,
    divergenceId: divergence.id,
    goalId: divergence.goalId,
    goalTitle,
    baseSha: divergence.baseSha,
    runIds,
    completedRunCount,
    status: ready ? "ready_to_compare" : "gather_evidence",
    recommendation: ready
      ? "Record a criterion-by-criterion comparison of the completed same-base Runs before selecting or rejecting an alternative."
      : "Complete at least two same-base sibling Runs and attach acceptance-criterion evidence before comparing alternatives."
  };
}

function selectionRecommendation(
  state: ProjectState,
  comparison: AlternativeComparison
): CoachSelectionRecommendationProjection {
  const goalTitle = state.goals.find(goal => goal.id === comparison.goalId)?.title ?? comparison.goalId;
  const decisions = state.decisions.filter(decision => decision.comparisonId === comparison.id);
  const selection = [...decisions].reverse().find(decision => decision.type === "selection");
  if (selection?.type === "selection") {
    return {
      id: `selection-recommendation:${comparison.id}`,
      comparisonId: comparison.id,
      goalId: comparison.goalId,
      goalTitle,
      runIds: [...comparison.runIds],
      status: "decision_recorded",
      action: "select",
      recommendation: `The user confirmed this selection: ${selection.rationale}`,
      basis: "recorded_decision",
      recommendedRunId: selection.selectedRunId,
      requiresUserConfirmation: true
    };
  }

  const rejectedRunIds = new Set(decisions.flatMap(decision => decision.type === "rejection" ? decision.rejectedRunIds : []));
  const remainingRunIds = comparison.runIds.filter(runId => !rejectedRunIds.has(runId));
  const review = [...state.coachReviews]
    .filter(candidate => candidate.projectId === comparison.projectId
      && candidate.target.type === "comparison"
      && candidate.target.comparisonId === comparison.id)
    .sort((left, right) => right.recordedAt.localeCompare(left.recordedAt))[0];
  const reviewedRecommendation = review?.recommendations.join(" ");

  if (remainingRunIds.length === 1) {
    return {
      id: `selection-recommendation:${comparison.id}`,
      comparisonId: comparison.id,
      goalId: comparison.goalId,
      goalTitle,
      runIds: [...comparison.runIds],
      status: "awaiting_user",
      action: "select",
      recommendation: reviewedRecommendation ?? "Only one compared Run remains unrejected. Review its evidence before explicitly confirming selection.",
      basis: review ? "coach_review" : "comparison_evidence",
      recommendedRunId: remainingRunIds[0],
      requiresUserConfirmation: true
    };
  }

  if (remainingRunIds.length === 0) {
    return {
      id: `selection-recommendation:${comparison.id}`,
      comparisonId: comparison.id,
      goalId: comparison.goalId,
      goalTitle,
      runIds: [...comparison.runIds],
      status: "awaiting_user",
      action: "another_experiment",
      recommendation: reviewedRecommendation ?? "Every compared Run was rejected. Propose another same-base experiment instead of silently reviving an alternative.",
      basis: review ? "coach_review" : "comparison_evidence",
      requiresUserConfirmation: true
    };
  }

  return {
    id: `selection-recommendation:${comparison.id}`,
    comparisonId: comparison.id,
    goalId: comparison.goalId,
    goalTitle,
    runIds: [...comparison.runIds],
    status: "awaiting_user",
    action: "review_selection",
    recommendation: reviewedRecommendation ?? `Review the comparison evidence before selecting, rejecting, or requesting another experiment: ${comparison.summary}`,
    basis: review ? "coach_review" : "comparison_evidence",
    requiresUserConfirmation: true
  };
}

export function alternativeComparisonProjection(state: ProjectState, projectId: string, comparisonId: string): ProjectionResult<AlternativeComparisonProjection> {
  const project = state.projects.find(candidate => candidate.id === projectId);
  if (!project) return failure("project_not_found", `Project ${projectId} was not found.`);
  const comparison = state.comparisons.find(candidate => candidate.projectId === project.id && candidate.id === comparisonId);
  if (!comparison) return failure("comparison_not_found", `Comparison ${comparisonId} was not found.`);
  const goal = state.goals.find(candidate => candidate.projectId === project.id && candidate.id === comparison.goalId);
  if (!goal) return failure("goal_not_found", `Goal ${comparison.goalId} was not found.`);
  const runs = comparison.runIds.flatMap(runId => state.runs.filter(run => run.projectId === project.id && run.id === runId));
  return ok(comparisonProjection(state, project, comparison, runs));
}

function projectListItem(state: ProjectState, project: Project, context: ProjectionContext): ProjectListItemProjection {
  const goals = goalsFor(state, project);
  const runs = runsFor(state, project);
  const latest = [...runs].sort((left, right) => runUpdatedAt(right).localeCompare(runUpdatedAt(left)))[0];
  const review = [...state.coachReviews].filter(item => item.projectId === project.id).sort((left, right) => right.recordedAt.localeCompare(left.recordedAt))[0];
  return {
    id: project.id,
    title: project.title,
    objective: project.objective,
    repository: repositoryProjection(project),
    activeGoalCount: goals.filter(goal => goal.status !== "completed").length,
    activeRunCount: runs.filter(run => run.status === "running").length,
    ...(latest ? {
      latestResult: {
        runId: latest.id,
        goalTitle: state.goals.find(goal => goal.id === latest.goalId)?.title ?? latest.goalId,
        status: latest.status,
        ...(latest.status === "completed" ? { resultSha: latest.resultSha } : {}),
        updatedAt: runUpdatedAt(latest)
      }
    } : {}),
    coachReviewStatus: !review ? "not_requested" : review.recommendations.length > 0 ? "changes_recommended" : "ready",
    unresolvedAlternativeCount: state.divergences.filter(divergence => divergence.projectId === project.id && !divergenceHasDecision(state, divergence.id)).length,
    synchronizedAt: context.health.synchronizedAt
  };
}

function goalSummary(state: ProjectState, goal: Goal): GoalSummaryProjection {
  const runs = state.runs.filter(run => run.goalId === goal.id);
  return {
    id: goal.id,
    title: goal.title,
    desiredOutcome: goal.desiredOutcome,
    status: goal.status,
    priority: priorityLabel(Number(goal.priority)),
    ...(runnerReferenceById(state, assignedRunnerId(goal)) ? { runner: runnerReferenceById(state, assignedRunnerId(goal)) } : {}),
    runCount: runs.length,
    activeRunCount: runs.filter(run => run.status === "running").length,
    alternativeCount: state.divergences.filter(divergence => divergence.goalId === goal.id).reduce((count, divergence) => count + divergence.alternativeRunIds.length, 0),
    updatedAt: goal.updatedAt
  };
}

function runSummary(state: ProjectState, project: Project, run: Run): RunSummaryProjection {
  const goalTitle = state.goals.find(goal => goal.id === run.goalId)?.title ?? run.goalSnapshot.title;
  const runner = runnerReferenceById(state, run.runnerId) ?? { id: run.runnerId, kind: run.runnerSnapshot.kind, name: run.runnerId };
  return {
    id: run.id,
    goalId: run.goalId,
    goalTitle,
    runner,
    baseSha: run.baseSha,
    branch: run.branch,
    status: run.status,
    ...(run.status === "completed" ? {
      resultSha: run.resultSha,
      resultUrl: `${repositoryProjection(project).url}/commit/${run.resultSha}`,
      completedAt: run.completedAt
    } : {}),
    evidenceCount: run.evidenceIds.length,
    startedAt: run.startedAt,
    updatedAt: runUpdatedAt(run)
  };
}

function evidenceProjection(project: Project, evidence: EvidenceRef): EvidenceProjection {
  const criterion = evidenceCriterion(evidence);
  if (evidence.location.type === "git") {
    return {
      id: evidence.id,
      kind: evidence.kind === "check" ? "check" : evidence.kind === "report" ? "report" : "commit",
      title: evidence.summary,
      ...(criterion ? { criterion } : {}),
      commitSha: evidence.location.commitSha,
      url: `${repositoryProjection(project).url}/blob/${evidence.location.commitSha}/${evidence.location.path}`,
      createdAt: evidence.recordedAt
    };
  }
  if (evidence.location.type === "url") {
    return { id: evidence.id, kind: "link", title: evidence.summary, ...(criterion ? { criterion } : {}), url: evidence.location.url, createdAt: evidence.recordedAt };
  }
  return { id: evidence.id, kind: evidence.kind === "report" ? "report" : "artifact", title: evidence.summary, ...(criterion ? { criterion } : {}), summary: evidence.location.text, createdAt: evidence.recordedAt };
}

function runnerProjection(state: ProjectState, runner: Runner): RunnerProjection {
  const recent = state.runs.filter(run => run.runnerId === runner.id).sort((left, right) => runUpdatedAt(right).localeCompare(runUpdatedAt(left))).slice(0, 5);
  const project = state.projects.find(candidate => candidate.id === runner.projectId);
  const summaries = project ? recent.map(run => runSummary(state, project, run)) : [];
  const goalCount = new Set(state.runs.filter(run => run.runnerId === runner.id).map(run => run.goalId)).size;
  if (runner.kind === "player") {
    return {
      kind: "player",
      id: runner.id,
      name: runner.id,
      promptTemplate: runner.promptTemplate,
      resources: runner.resources.map(resourceProjection),
      runtimePolicy: {
        network: runner.runtimePolicy.network === "allowed" ? "enabled" : "disabled",
        approvals: runner.runtimePolicy.approval === "user" ? "on_request" : "never"
      },
      goalCount,
      recentResults: summaries
    };
  }
  return {
    kind: "team",
    id: runner.id,
    name: runner.id,
    strategy: {
      mode: runner.strategy.mode,
      promptTemplate: runner.strategy.promptTemplate,
      maxRounds: Number(runner.strategy.maxRounds)
    },
    players: runner.players.map(slot => ({
      playerId: slot.playerId,
      playerName: slot.playerId,
      role: slot.role,
      order: Number(slot.order)
    })),
    goalCount,
    recentResults: summaries
  };
}

function runnerSnapshotProjection(state: ProjectState, snapshot: RunnerSnapshot): RunnerProjection {
  if (snapshot.kind === "player") {
    return {
      kind: "player",
      id: snapshot.id,
      name: snapshot.id,
      promptTemplate: snapshot.promptTemplate,
      resources: snapshot.resources.map(resourceProjection),
      runtimePolicy: {
        network: snapshot.runtimePolicy.network === "allowed" ? "enabled" : "disabled",
        approvals: snapshot.runtimePolicy.approval === "user" ? "on_request" : "never"
      },
      goalCount: 0,
      recentResults: []
    };
  }
  return {
    kind: "team",
    id: snapshot.id,
    name: snapshot.id,
    strategy: {
      mode: snapshot.strategy.mode,
      promptTemplate: snapshot.strategy.promptTemplate,
      maxRounds: Number(snapshot.strategy.maxRounds)
    },
    players: snapshot.players.map(({ slot, player }) => ({
      playerId: player.id,
      playerName: player.id,
      role: slot.role,
      order: Number(slot.order)
    })),
    goalCount: 0,
    recentResults: []
  };
}

function goalAlternatives(state: ProjectState, project: Project, goal: Goal, runs: Run[]): GoalAlternativeProjection[] {
  const comparisons = state.comparisons.filter(comparison => comparison.projectId === project.id && comparison.goalId === goal.id);
  const compared = new Set(comparisons.flatMap(comparison => [...comparison.runIds]));
  const siblingIds = new Set(state.divergences.filter(divergence => divergence.projectId === project.id && divergence.goalId === goal.id).flatMap(divergence => [divergence.sourceRunId, ...divergence.alternativeRunIds]));
  return runs.filter(run => siblingIds.has(run.id)).map((run, index) => {
    const comparisonIds = new Set(comparisons.filter(comparison => comparison.runIds.includes(run.id)).map(comparison => comparison.id));
    const decisions = state.decisions.filter(candidate => comparisonIds.has(candidate.comparisonId));
    const runEvidence = state.evidence.filter(item => item.runId === run.id).map(item => evidenceProjection(project, item));
    return {
      run: runSummary(state, project, run),
      label: `Alternative ${index + 1}`,
      summary: compared.has(run.id) ? "Included in recorded comparison." : "Awaiting comparison.",
      strengths: run.status === "completed" ? [`Completed with ${run.evidenceIds.length} evidence item(s).`] : [],
      tradeoffs: run.status === "failed" ? [run.failureReason] : [],
      evidence: runEvidence,
      selected: decisions.some(decision => decision.type === "selection" && decision.selectedRunId === run.id),
      rejected: decisions.some(decision => decisionRejected(decision, run.id))
    };
  });
}

function comparisonAlternatives(state: ProjectState, project: Project, comparison: AlternativeComparison, runs: Run[]): GoalAlternativeProjection[] {
  const decisions = state.decisions.filter(candidate => candidate.comparisonId === comparison.id);
  return runs.map((run, index) => ({
    run: runSummary(state, project, run),
    label: `Alternative ${index + 1}`,
    summary: comparison.findings.flatMap(finding => finding.summaries.filter(item => item.runId === run.id).map(item => item.summary)).join(" ") || comparison.summary,
    strengths: comparison.findings.filter(finding => finding.summaries.some(item => item.runId === run.id)).map(finding => finding.criterion),
    tradeoffs: run.status === "failed" ? [run.failureReason] : [],
    evidence: state.evidence.filter(item => item.runId === run.id).map(item => evidenceProjection(project, item)),
    selected: decisions.some(decision => decision.type === "selection" && decision.selectedRunId === run.id),
    rejected: decisions.some(decision => decisionRejected(decision, run.id))
  }));
}

function comparisonProjection(
  state: ProjectState,
  project: Project,
  comparison: AlternativeComparison,
  runs: Run[] = comparison.runIds.flatMap(runId => state.runs.filter(run => run.projectId === project.id && run.id === runId))
): AlternativeComparisonProjection {
  return {
    id: comparison.id,
    projectId: project.id,
    goalId: comparison.goalId,
    divergenceId: comparison.divergenceId,
    baseSha: comparison.baseSha,
    runIds: [...comparison.runIds],
    summary: comparison.summary,
    findings: comparison.findings.map(finding => ({
      criterion: finding.criterion,
      summaries: finding.summaries.map(summary => ({
        runId: summary.runId,
        summary: summary.summary
      }))
    })),
    alternatives: comparisonAlternatives(state, project, comparison, runs),
    recordedAt: comparison.recordedAt
  };
}

function proposalProjection(state: ProjectState, proposal: CoachProposal): CoachProjection["proposals"][number] {
  const decision = state.coachProposalDecisions.find(candidate => candidate.proposalId === proposal.id);
  const status: CoachProposalProjection["status"] = decision?.status === "accepted"
    ? "confirmed"
    : decision?.status === "rejected"
      ? "rejected"
      : "proposed";
  const common = {
    id: proposal.id,
    title: proposal.type === "hunsu" ? "Create a Hunsu alternative" : proposal.type === "goal_change" ? "Change Goal" : "Change Runner",
    rationale: proposal.reason,
    summary: proposal.reason,
    consequential: true as const,
    status,
    createdAt: proposal.proposedAt
  };
  const goal = state.goals.find(candidate => candidate.projectId === proposal.projectId && candidate.id === proposal.goalId);
  if (!goal) throw new Error(`Coach proposal ${proposal.id} references missing Goal ${proposal.goalId}.`);
  if (proposal.type === "goal_change") {
    return { ...common, kind: "goal_change", goalId: proposal.goalId, change: goalPatchProjection(state, proposal.change) };
  }
  if (proposal.type === "runner_change") {
    return {
      ...common,
      kind: "runner_change",
      goalId: proposal.goalId,
      change: runnerAssignmentChange(state, goal.assignment, proposal.runnerId)
    };
  }
  const project = state.projects.find(candidate => candidate.id === proposal.projectId);
  const sourceRun = state.runs.find(candidate => candidate.projectId === proposal.projectId && candidate.id === proposal.sourceRunId);
  if (!project || !sourceRun || sourceRun.status !== "completed") {
    throw new Error(`Hunsu proposal ${proposal.id} does not reference a completed source Run.`);
  }
  const sourceRunSummary = runSummary(state, project, sourceRun);
  return {
    ...common,
    kind: "hunsu",
    goalId: proposal.goalId,
    sourceRun: {
      ...sourceRunSummary,
      status: "completed",
      resultSha: sourceRun.resultSha,
      resultUrl: `${repositoryProjection(project).url}/commit/${sourceRun.resultSha}`,
      completedAt: sourceRun.completedAt
    },
    alternative: proposal.alternative.type === "goal_change"
      ? { type: "goal_change", change: goalPatchProjection(state, proposal.alternative.change) }
      : {
          type: "runner_change",
          change: runnerAssignmentChange(
            state,
            { type: "assigned", runnerId: sourceRun.runnerId },
            proposal.alternative.runnerId
          )
        }
  };
}

function decisionProjection(state: ProjectState, decision: AlternativeDecision): DecisionProjection[] {
  const comparison = state.comparisons.find(candidate => candidate.id === decision.comparisonId);
  if (!comparison) return [];
  return [{
    id: decision.id,
    goalId: comparison.goalId,
    title: decision.type === "selection" ? "Alternative selected" : "Alternatives rejected",
    status: decision.type === "selection" ? "confirmed" : "rejected",
    ...(decision.type === "selection" ? { recommendedRunId: decision.selectedRunId } : {}),
    reason: decision.rationale,
    createdAt: decision.decidedAt
  }];
}

function goalDecision(state: ProjectState, goal: Goal): DecisionProjection | undefined {
  const comparisons = new Set(state.comparisons.filter(comparison => comparison.goalId === goal.id).map(comparison => comparison.id));
  const decision = latestDecision(state.decisions.filter(candidate => comparisons.has(candidate.comparisonId)));
  return decision ? decisionProjection(state, decision)[0] : undefined;
}

function goalPatchProjection(state: ProjectState, patch: GoalPatch): GoalPatchProjection {
  return {
    ...(patch.title === undefined ? {} : { title: patch.title }),
    ...(patch.desiredOutcome === undefined ? {} : { desiredOutcome: patch.desiredOutcome }),
    ...(patch.acceptanceCriteria === undefined ? {} : { acceptanceCriteria: [...patch.acceptanceCriteria] }),
    ...(patch.constraints === undefined ? {} : { constraints: [...patch.constraints] }),
    ...(patch.priority === undefined ? {} : { priority: Number(patch.priority) }),
    ...(patch.assignment === undefined ? {} : { assignment: assignmentProjection(state, patch.assignment) }),
    ...(patch.relation === undefined ? {} : {
      relation: patch.relation.type === "root"
        ? { type: "root" as const }
        : patch.relation.type === "child"
          ? { type: "child" as const, parentGoalId: patch.relation.parentGoalId }
          : { type: "related" as const, goalIds: [...patch.relation.goalIds] }
    })
  };
}

function runnerAssignmentChange(
  state: ProjectState,
  from: Goal["assignment"],
  proposedRunnerId: string
): RunnerAssignmentChangeProjection {
  return {
    from: assignmentProjection(state, from),
    to: assignedRunnerProjection(state, proposedRunnerId)
  };
}

function assignmentProjection(state: ProjectState, assignment: Goal["assignment"]): GoalAssignmentProjection {
  return assignment.type === "unassigned" ? { type: "unassigned" } : assignedRunnerProjection(state, assignment.runnerId);
}

function assignedRunnerProjection(state: ProjectState, runnerId: string): AssignedRunnerProjection {
  const runner = runnerReferenceById(state, runnerId);
  if (!runner) throw new Error(`Coach proposal references missing Runner ${runnerId}.`);
  return { type: "assigned", runnerId, runner };
}

function latestDecision(decisions: readonly AlternativeDecision[]): AlternativeDecision | undefined {
  return [...decisions].sort((left, right) => right.decidedAt.localeCompare(left.decidedAt))[0];
}

function runnerReferenceById(state: ProjectState, runnerId: string | undefined): RunnerReferenceProjection | undefined {
  if (!runnerId) return undefined;
  const runner = state.runners.find(candidate => candidate.id === runnerId);
  return runner ? { id: runner.id, kind: runner.kind, name: runner.id } : undefined;
}

function assignedRunnerId(goal: Goal): string | undefined {
  return goal.assignment.type === "assigned" ? goal.assignment.runnerId : undefined;
}

function repositoryProjection(project: Project): RepositoryProjection {
  const defaultBranch = String(project.baseRef).replace(/^refs\/heads\//u, "");
  return {
    owner: project.repository.owner,
    name: project.repository.name,
    url: `https://github.com/${project.repository.owner}/${project.repository.name}`,
    defaultBranch
  };
}

function resourceProjection(resource: ResourceBinding): { id: string; kind: "skill" | "plugin"; name: string; version?: string } {
  return resource.type === "skill"
    ? { id: `skill:${resource.name}`, kind: "skill", name: resource.name }
    : { id: `plugin:${resource.name}`, kind: "plugin", name: resource.name, version: resource.version };
}

function runnerInstructions(snapshot: RunnerSnapshot): string {
  return snapshot.kind === "player" ? snapshot.promptTemplate : snapshot.strategy.promptTemplate;
}

function runUpdatedAt(run: Run): string {
  if (run.status === "completed") return run.completedAt;
  if (run.status === "failed") return run.failedAt;
  if (run.status === "canceled") return run.canceledAt;
  return run.checkpoints.at(-1)?.recordedAt ?? run.startedAt;
}

function goalsFor(state: ProjectState, project: Project): Goal[] {
  return state.goals.filter(goal => goal.projectId === project.id);
}

function runsFor(state: ProjectState, project: Project): Run[] {
  return state.runs.filter(run => run.projectId === project.id);
}

function evidenceForProject(state: ProjectState, project: Project): EvidenceRef[] {
  return state.evidence.filter(item => item.projectId === project.id);
}

function evidenceCriterion(evidence: EvidenceRef): string | undefined {
  if (!("criterion" in evidence) || typeof evidence.criterion !== "string") return undefined;
  const criterion = evidence.criterion.trim();
  return criterion.length > 0 ? criterion : undefined;
}

function divergenceHasDecision(state: ProjectState, divergenceId: string): boolean {
  const comparisonIds = new Set(state.comparisons.filter(comparison => comparison.divergenceId === divergenceId).map(comparison => comparison.id));
  return state.decisions.some(decision => comparisonIds.has(decision.comparisonId));
}

function divergenceDecisionStatus(state: ProjectState, divergenceId: string): "open" | "selected" | "rejected" {
  const comparisonIds = new Set(state.comparisons.filter(comparison => comparison.divergenceId === divergenceId).map(comparison => comparison.id));
  const decision = latestDecision(state.decisions.filter(candidate => comparisonIds.has(candidate.comparisonId)));
  return decision?.type === "selection" ? "selected" : decision?.type === "rejection" ? "rejected" : "open";
}

function decisionRejected(decision: AlternativeDecision, runId: string): boolean {
  return decision.rejectedRunIds.some(rejectedRunId => rejectedRunId === runId);
}

function priorityLabel(priority: number): "low" | "normal" | "high" | "urgent" {
  if (priority >= 90) return "urgent";
  if (priority >= 60) return "high";
  if (priority <= 20) return "low";
  return "normal";
}

function newestFirst(left: EvidenceProjection, right: EvidenceProjection): number {
  return right.createdAt.localeCompare(left.createdAt);
}

function latestTimestamp(values: readonly string[]): string {
  return [...values].sort().at(-1) ?? new Date(0).toISOString();
}

function ok<T>(value: T): ProjectionResult<T> {
  return { ok: true, value };
}

function failure(code: ProjectionError["code"], message: string): ProjectionResult<never> {
  return { ok: false, error: { code, message } };
}
