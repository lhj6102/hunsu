import {
  err,
  ok,
  runBranchName,
  type ActiveGoal,
  type AcceptedCoachProposalDecision,
  type AlternativeComparison,
  type AtLeastTwo,
  type Coach,
  type CoachProposal,
  type CoachReview,
  type CommandMetadata,
  type CompletedRun,
  type DomainActor,
  type DomainEvent,
  type EventMetadata,
  type EvidenceRef,
  type Goal,
  type GoalBase,
  type GoalPatch,
  type GoalSnapshot,
  type HunsuDivergence,
  type PausedGoal,
  type Player,
  type PlayerSnapshot,
  type ProcessedCommand,
  type Project,
  type ProjectCommand,
  type ProjectPatch,
  type ProjectState,
  type RejectionDecision,
  type RejectedCoachProposalDecision,
  type Result,
  type Run,
  type RunCheckpoint,
  type Runner,
  type RunnerSnapshot,
  type RunningRun,
  type SelectionDecision,
  type Team,
  type TeamPlayerSnapshot,
  type TeamSnapshot,
  type TerminalRun,
  type VerifiedRunResult
} from "@hunsu/protocol";

export type ProjectDomainErrorCode =
  | "IDEMPOTENCY_CONFLICT"
  | "DUPLICATE_ID"
  | "NOT_FOUND"
  | "INVALID_TRANSITION"
  | "INVARIANT_VIOLATION"
  | "USER_CONFIRMATION_REQUIRED"
  | "INVALID_EVENT";

export type ProjectDomainError = {
  readonly type: "ProjectDomainError";
  readonly code: ProjectDomainErrorCode;
  readonly message: string;
};

export type CommandDecision =
  | { readonly type: "accepted"; readonly event: DomainEvent }
  | { readonly type: "reused"; readonly eventId: ProjectCommand["meta"]["eventId"] };

export type CommandApplication = {
  readonly state: ProjectState;
  readonly emittedEvents: readonly DomainEvent[];
  readonly reusedEventIds: readonly ProjectCommand["meta"]["eventId"][];
};

export function emptyProjectState(): ProjectState {
  return {
    projects: [],
    goals: [],
    runners: [],
    coaches: [],
    runs: [],
    evidence: [],
    coachReviews: [],
    coachProposals: [],
    coachProposalDecisions: [],
    divergences: [],
    comparisons: [],
    decisions: [],
    processedCommands: []
  };
}

export function decideProjectCommand(
  state: ProjectState,
  command: ProjectCommand
): Result<CommandDecision, ProjectDomainError> {
  const retry = decideRetry(state, command.meta);
  if (!retry.ok) return retry;
  if (retry.value) return ok(retry.value);
  const meta = eventMetadata(command.meta);

  switch (command.type) {
    case "CreateProject": {
      const valid = validateNewProject(state, command.project, command.coach);
      return valid.ok
        ? accepted({ type: "ProjectCreated", meta, project: command.project, coach: command.coach })
        : valid;
    }
    case "UpdateProject": {
      const project = findProject(state, command.projectId);
      if (!project.ok) return project;
      if (!hasKeys(command.patch)) return failure("INVARIANT_VIOLATION", "Project update must change at least one field");
      return accepted({ type: "ProjectUpdated", meta, projectId: command.projectId, patch: command.patch });
    }
    case "CreateGoal": {
      const valid = validateNewGoal(state, command.goal);
      return valid.ok ? accepted({ type: "GoalCreated", meta, goal: command.goal }) : valid;
    }
    case "UpdateGoal": {
      const goal = findGoal(state, command.goalId);
      if (!goal.ok) return goal;
      if (goal.value.status === "completed") return invalidTransition("Goal", command.goalId, goal.value.status);
      if (!hasKeys(command.patch)) return failure("INVARIANT_VIOLATION", "Goal update must change at least one field");
      const changed = applyGoalPatch(goal.value, command.patch, command.meta.requestedAt);
      const relation = validateGoalRelation(state, changed);
      if (!relation.ok) return relation;
      const assignment = validateGoalAssignment(state, changed);
      return assignment.ok ? accepted({ type: "GoalUpdated", meta, goalId: command.goalId, patch: command.patch }) : assignment;
    }
    case "PauseGoal": {
      const goal = findGoal(state, command.goalId);
      if (!goal.ok) return goal;
      return goal.value.status === "active"
        ? accepted({ type: "GoalPaused", meta, goalId: command.goalId, reason: command.reason })
        : invalidTransition("Goal", command.goalId, goal.value.status);
    }
    case "ResumeGoal": {
      const goal = findGoal(state, command.goalId);
      if (!goal.ok) return goal;
      return goal.value.status === "paused"
        ? accepted({ type: "GoalResumed", meta, goalId: command.goalId })
        : invalidTransition("Goal", command.goalId, goal.value.status);
    }
    case "CompleteGoal": {
      const valid = validateGoalCompletion(state, command.goalId, command.selectedRunId);
      return valid.ok
        ? accepted({ type: "GoalCompleted", meta, goalId: command.goalId, selectedRunId: command.selectedRunId })
        : valid;
    }
    case "CreatePlayer": {
      const valid = validateNewPlayer(state, command.player);
      return valid.ok ? accepted({ type: "PlayerCreated", meta, player: command.player }) : valid;
    }
    case "UpdatePlayer": {
      const valid = validatePlayerUpdate(state, command.player);
      return valid.ok ? accepted({ type: "PlayerUpdated", meta, player: command.player }) : valid;
    }
    case "CreateTeam": {
      const valid = validateNewTeam(state, command.team);
      return valid.ok ? accepted({ type: "TeamCreated", meta, team: command.team }) : valid;
    }
    case "UpdateTeam": {
      const valid = validateTeamUpdate(state, command.team);
      return valid.ok ? accepted({ type: "TeamUpdated", meta, team: command.team }) : valid;
    }
    case "UpdateCoach": {
      const valid = validateCoachUpdate(state, command.coach);
      return valid.ok ? accepted({ type: "CoachUpdated", meta, coach: command.coach }) : valid;
    }
    case "StartRun": {
      const run = buildRunningRun(state, command);
      return run.ok ? accepted({ type: "RunStarted", meta, run: run.value }) : run;
    }
    case "CheckpointRun": {
      const valid = validateCheckpoint(state, command.checkpoint);
      return valid.ok ? accepted({ type: "RunCheckpointed", meta, checkpoint: command.checkpoint }) : valid;
    }
    case "AttachRunEvidence": {
      const valid = validateEvidence(state, command.evidence);
      return valid.ok ? accepted({ type: "RunEvidenceAttached", meta, evidence: command.evidence }) : valid;
    }
    case "CompleteRun": {
      const valid = validateRunResult(state, command.result);
      return valid.ok ? accepted({ type: "RunCompleted", meta, result: command.result }) : valid;
    }
    case "FailRun": {
      const run = findRunningRun(state, command.runId);
      return run.ok ? accepted({ type: "RunFailed", meta, runId: command.runId, reason: command.reason }) : run;
    }
    case "CancelRun": {
      const run = findRunningRun(state, command.runId);
      return run.ok ? accepted({ type: "RunCanceled", meta, runId: command.runId, reason: command.reason }) : run;
    }
    case "RecordCoachReview": {
      const valid = validateCoachReview(state, command.review, command.meta.actor);
      return valid.ok ? accepted({ type: "CoachReviewRecorded", meta, review: command.review }) : valid;
    }
    case "RecordCoachProposal": {
      const valid = validateCoachProposal(state, command.proposal, command.meta.actor);
      return valid.ok ? accepted({ type: "CoachProposalRecorded", meta, proposal: command.proposal }) : valid;
    }
    case "AcceptCoachProposal": {
      const decision = buildCoachProposalAcceptance(state, command);
      return decision.ok ? accepted({ type: "CoachProposalAccepted", meta, decision: decision.value }) : decision;
    }
    case "RejectCoachProposal": {
      const decision = buildCoachProposalRejection(state, command);
      return decision.ok ? accepted({ type: "CoachProposalRejected", meta, decision: decision.value }) : decision;
    }
    case "ConfirmHunsu": {
      const divergence = buildDivergence(state, command);
      return divergence.ok ? accepted({ type: "HunsuConfirmed", meta, divergence: divergence.value }) : divergence;
    }
    case "CompareAlternatives": {
      const comparison = buildComparison(state, command);
      return comparison.ok ? accepted({ type: "AlternativesCompared", meta, comparison: comparison.value }) : comparison;
    }
    case "SelectAlternative": {
      const decision = buildSelection(state, command);
      return decision.ok ? accepted({ type: "AlternativeSelected", meta, decision: decision.value }) : decision;
    }
    case "RejectAlternatives": {
      const decision = buildRejection(state, command);
      return decision.ok ? accepted({ type: "AlternativesRejected", meta, decision: decision.value }) : decision;
    }
  }
}

export function applyProjectCommand(
  state: ProjectState,
  command: ProjectCommand
): Result<CommandApplication, ProjectDomainError> {
  const decision = decideProjectCommand(state, command);
  if (!decision.ok) return decision;
  if (decision.value.type === "reused") {
    return ok({ state, emittedEvents: [], reusedEventIds: [decision.value.eventId] });
  }
  const applied = applyDomainEvent(state, decision.value.event);
  return applied.ok
    ? ok({ state: applied.value, emittedEvents: [decision.value.event], reusedEventIds: [] })
    : applied;
}

export function applyDomainEvent(
  state: ProjectState,
  event: DomainEvent
): Result<ProjectState, ProjectDomainError> {
  const command = commandFromEvent(event);
  const decision = decideProjectCommand(state, command);
  if (!decision.ok) return decision;
  if (decision.value.type !== "accepted") {
    return failure("INVALID_EVENT", "Event reuses an idempotency record already present in the stream");
  }
  if (canonicalJson(decision.value.event) !== canonicalJson(event)) {
    return failure("INVALID_EVENT", "Event payload does not match the domain decision for its command metadata");
  }
  return ok(recordProcessed(projectAcceptedEvent(state, event), event.meta));
}

export function replayDomainEvents(events: readonly DomainEvent[]): Result<ProjectState, ProjectDomainError> {
  let state = emptyProjectState();
  for (let index = 0; index < events.length; index += 1) {
    const applied = applyDomainEvent(state, events[index]);
    if (!applied.ok) {
      return failure(applied.error.code, "Event " + index + ": " + applied.error.message);
    }
    state = applied.value;
  }
  return ok(state);
}

export function validateRunnerGraph(
  state: ProjectState,
  team: Team
): Result<Team, ProjectDomainError> {
  const project = findProject(state, team.projectId);
  if (!project.ok) return project;
  if (team.players.length === 0) return failure("INVARIANT_VIOLATION", "Team must contain at least one Player");
  const ids = new Set<string>();
  const orders = new Set<number>();
  for (const slot of team.players) {
    if (ids.has(slot.playerId)) return failure("INVARIANT_VIOLATION", "Team contains duplicate Player " + slot.playerId);
    if (orders.has(slot.order)) return failure("INVARIANT_VIOLATION", "Team contains duplicate Player order " + slot.order);
    ids.add(slot.playerId);
    orders.add(slot.order);
    const runner = state.runners.find(candidate => candidate.id === slot.playerId);
    if (!runner) return failure("NOT_FOUND", "Team references unknown Player " + slot.playerId);
    if (runner.kind !== "player") return failure("INVARIANT_VIOLATION", "Team slots may reference only Players");
    if (runner.projectId !== team.projectId) return failure("INVARIANT_VIOLATION", "Team and Player must belong to the same Project");
  }
  return ok(team);
}

function decideRetry(
  state: ProjectState,
  meta: CommandMetadata
): Result<CommandDecision | undefined, ProjectDomainError> {
  const prior = state.processedCommands.find(record => record.idempotencyKey === meta.idempotencyKey);
  if (prior) {
    return prior.fingerprint === meta.fingerprint && prior.eventId === meta.eventId
      ? ok({ type: "reused", eventId: prior.eventId })
      : failure("IDEMPOTENCY_CONFLICT", "Idempotency key was already used with a different command fingerprint or event ID");
  }
  if (state.processedCommands.some(record => record.eventId === meta.eventId)) {
    return failure("DUPLICATE_ID", "Event ID already exists: " + meta.eventId);
  }
  return ok(undefined);
}

function validateNewProject(state: ProjectState, project: Project, coach: Coach): Result<void, ProjectDomainError> {
  if (state.projects.some(candidate => candidate.id === project.id)) return duplicate("Project", project.id);
  if (state.coaches.some(candidate => candidate.id === coach.id)) return duplicate("Coach", coach.id);
  if (project.coachId !== coach.id || coach.projectId !== project.id) {
    return failure("INVARIANT_VIOLATION", "Project and Coach identities do not match");
  }
  if (project.goalIds.length > 0 || project.runnerIds.length > 0) {
    return failure("INVARIANT_VIOLATION", "A new Project must start without Goal or Runner references");
  }
  return ok(undefined);
}

function validateNewGoal(state: ProjectState, goal: ActiveGoal): Result<void, ProjectDomainError> {
  const project = findProject(state, goal.projectId);
  if (!project.ok) return project;
  if (state.goals.some(candidate => candidate.id === goal.id)) return duplicate("Goal", goal.id);
  const relation = validateGoalRelation(state, goal);
  return relation.ok ? validateGoalAssignment(state, goal) : relation;
}

function validateGoalAssignment(state: ProjectState, goal: Goal): Result<void, ProjectDomainError> {
  if (goal.assignment.type === "unassigned") return ok(undefined);
  const runner = findRunner(state, goal.assignment.runnerId);
  if (!runner.ok) return runner;
  return runner.value.projectId === goal.projectId
    ? ok(undefined)
    : failure("INVARIANT_VIOLATION", "Assigned Runner must belong to the Goal Project");
}

function validateGoalRelation(state: ProjectState, goal: Goal): Result<void, ProjectDomainError> {
  if (goal.relation.type === "root") return ok(undefined);
  const ids = goal.relation.type === "child" ? [goal.relation.parentGoalId] : [...goal.relation.goalIds];
  if (new Set(ids).size !== ids.length) return failure("INVARIANT_VIOLATION", "Goal relation contains duplicate Goal IDs");
  for (const id of ids) {
    if (id === goal.id) return failure("INVARIANT_VIOLATION", "Goal cannot relate to itself");
    const related = findGoal(state, id);
    if (!related.ok) return related;
    if (related.value.projectId !== goal.projectId) return failure("INVARIANT_VIOLATION", "Related Goals must belong to the same Project");
  }
  return ok(undefined);
}

function validateGoalCompletion(state: ProjectState, goalId: Goal["id"], runId: Run["id"]): Result<void, ProjectDomainError> {
  const goal = findGoal(state, goalId);
  if (!goal.ok) return goal;
  if (goal.value.status === "completed") return invalidTransition("Goal", goalId, goal.value.status);
  const run = findRun(state, runId);
  if (!run.ok) return run;
  if (run.value.status !== "completed") return failure("INVALID_TRANSITION", "Goal can be completed only with a completed Run");
  if (run.value.goalId !== goalId || run.value.projectId !== goal.value.projectId) {
    return failure("INVARIANT_VIOLATION", "Selected Run does not belong to the Goal");
  }
  const openDivergences = state.divergences.filter(item => item.goalId === goalId && item.alternativeRunIds.length > 0);
  for (const divergence of openDivergences) {
    const comparisonIds = state.comparisons.filter(item => item.divergenceId === divergence.id).map(item => item.id);
    const selected = state.decisions.find((item): item is SelectionDecision => item.type === "selection" && comparisonIds.includes(item.comparisonId));
    if (!selected || selected.selectedRunId !== runId) {
      return failure("USER_CONFIRMATION_REQUIRED", "Goal alternatives require a user-confirmed selection before completion");
    }
  }
  return ok(undefined);
}

function validateNewPlayer(state: ProjectState, player: Player): Result<void, ProjectDomainError> {
  const project = findProject(state, player.projectId);
  if (!project.ok) return project;
  return state.runners.some(candidate => candidate.id === player.id) ? duplicate("Runner", player.id) : ok(undefined);
}

function validatePlayerUpdate(state: ProjectState, player: Player): Result<void, ProjectDomainError> {
  const current = findRunner(state, player.id);
  if (!current.ok) return current;
  if (current.value.kind !== "player") return failure("INVARIANT_VIOLATION", "Runner kind cannot change during update");
  return current.value.projectId === player.projectId
    ? ok(undefined)
    : failure("INVARIANT_VIOLATION", "Runner cannot move between Projects");
}

function validateNewTeam(state: ProjectState, team: Team): Result<void, ProjectDomainError> {
  if (state.runners.some(candidate => candidate.id === team.id)) return duplicate("Runner", team.id);
  return mapVoid(validateRunnerGraph(state, team));
}

function validateTeamUpdate(state: ProjectState, team: Team): Result<void, ProjectDomainError> {
  const current = findRunner(state, team.id);
  if (!current.ok) return current;
  if (current.value.kind !== "team") return failure("INVARIANT_VIOLATION", "Runner kind cannot change during update");
  if (current.value.projectId !== team.projectId) return failure("INVARIANT_VIOLATION", "Runner cannot move between Projects");
  return mapVoid(validateRunnerGraph(state, team));
}

function validateCoachUpdate(state: ProjectState, coach: Coach): Result<void, ProjectDomainError> {
  const current = state.coaches.find(candidate => candidate.id === coach.id);
  if (!current) return notFound("Coach", coach.id);
  if (current.projectId !== coach.projectId) return failure("INVARIANT_VIOLATION", "Coach cannot move between Projects");
  const project = findProject(state, coach.projectId);
  return project.ok && project.value.coachId === coach.id
    ? ok(undefined)
    : failure("INVARIANT_VIOLATION", "Coach is not selected by the Project");
}

function buildRunningRun(
  state: ProjectState,
  command: Extract<ProjectCommand, { type: "StartRun" }>
): Result<RunningRun, ProjectDomainError> {
  if (state.runs.some(run => run.id === command.runId)) return duplicate("Run", command.runId);
  const project = findProject(state, command.projectId);
  if (!project.ok) return project;
  const goal = findGoal(state, command.goalId);
  if (!goal.ok) return goal;
  if (goal.value.projectId !== command.projectId) return failure("INVARIANT_VIOLATION", "Goal does not belong to the Project");
  if (goal.value.status !== "active") return invalidTransition("Goal", goal.value.id, goal.value.status);
  const runner = findRunner(state, command.runnerId);
  if (!runner.ok) return runner;
  if (runner.value.projectId !== command.projectId) return failure("INVARIANT_VIOLATION", "Runner does not belong to the Project");
  if (goal.value.assignment.type === "assigned" && goal.value.assignment.runnerId !== command.runnerId) {
    return failure("INVARIANT_VIOLATION", "Run must use the Runner assigned to the Goal");
  }
  if (command.branch !== runBranchName(command.projectId, command.goalId, command.runId)) {
    return failure("INVARIANT_VIOLATION", "Run branch does not match the required Hunsu namespace");
  }
  let sourceRun: Run | undefined;
  if (command.origin.type === "hunsu_alternative") {
    const origin = command.origin;
    const divergence = state.divergences.find(item => item.id === origin.divergenceId);
    if (!divergence) return notFound("Hunsu divergence", origin.divergenceId);
    if (divergence.sourceRunId !== origin.sourceRunId || divergence.projectId !== command.projectId || divergence.goalId !== command.goalId) {
      return failure("INVARIANT_VIOLATION", "Alternative Run does not match its Hunsu divergence");
    }
    if (divergence.baseSha !== command.baseSha) return failure("INVARIANT_VIOLATION", "Sibling alternatives must share the same base SHA");
    sourceRun = state.runs.find(item => item.id === origin.sourceRunId);
    if (!sourceRun) return notFound("Run", origin.sourceRunId);
  }
  const runnerSnapshot = captureRunnerSnapshot(state, runner.value, command.meta.requestedAt);
  if (!runnerSnapshot.ok) return runnerSnapshot;
  const goalSnapshot = captureGoalSnapshot(goal.value, command.meta.requestedAt);
  if (sourceRun && sameGoalDefinition(goalSnapshot, sourceRun.goalSnapshot) && sameRunnerDefinition(runnerSnapshot.value, sourceRun.runnerSnapshot)) {
    return failure("INVARIANT_VIOLATION", "A Hunsu alternative must change the Goal or Runner from its source Run");
  }
  return ok({
    id: command.runId,
    projectId: command.projectId,
    goalId: command.goalId,
    runnerId: command.runnerId,
    baseSha: command.baseSha,
    branch: command.branch,
    origin: command.origin,
    goalSnapshot,
    runnerSnapshot: runnerSnapshot.value,
    checkpoints: [],
    evidenceIds: [],
    startedAt: command.meta.requestedAt,
    status: "running"
  });
}

function validateCheckpoint(state: ProjectState, checkpoint: RunCheckpoint): Result<void, ProjectDomainError> {
  const run = findRunningRun(state, checkpoint.runId);
  if (!run.ok) return run;
  return state.runs.some(item => item.checkpoints.some(existing => existing.id === checkpoint.id))
    ? duplicate("Checkpoint", checkpoint.id)
    : ok(undefined);
}

function validateEvidence(state: ProjectState, evidence: EvidenceRef): Result<void, ProjectDomainError> {
  if (state.evidence.some(item => item.id === evidence.id)) return duplicate("Evidence", evidence.id);
  const run = findRunningRun(state, evidence.runId);
  if (!run.ok) return run;
  if (run.value.projectId !== evidence.projectId) {
    return failure("INVARIANT_VIOLATION", "Evidence and Run must belong to the same Project");
  }
  if (evidence.criterion !== undefined && !run.value.goalSnapshot.acceptanceCriteria.includes(evidence.criterion)) {
    return failure("INVARIANT_VIOLATION", "Evidence criterion must belong to the Run Goal snapshot");
  }
  return ok(undefined);
}

function validateRunResult(state: ProjectState, result: VerifiedRunResult): Result<void, ProjectDomainError> {
  const run = findRunningRun(state, result.runId);
  if (!run.ok) return run;
  if (run.value.branch !== result.branch) {
    return failure("INVARIANT_VIOLATION", "Verified result branch does not match the Run branch");
  }
  const coveredCriteria = new Set(
    state.evidence
      .filter(evidence => evidence.runId === run.value.id && run.value.evidenceIds.includes(evidence.id))
      .flatMap(evidence => evidence.criterion === undefined ? [] : [evidence.criterion])
  );
  const missingCriteria = run.value.goalSnapshot.acceptanceCriteria.filter(criterion => !coveredCriteria.has(criterion));
  return missingCriteria.length === 0
    ? ok(undefined)
    : failure(
        "INVARIANT_VIOLATION",
        `Completed Run evidence must cover every Goal acceptance criterion; missing: ${missingCriteria.join("; ")}`
      );
}

function validateCoachReview(state: ProjectState, review: CoachReview, actor: DomainActor): Result<void, ProjectDomainError> {
  if (state.coachReviews.some(item => item.id === review.id)) return duplicate("Coach review", review.id);
  const coach = validateCoachActor(state, review.projectId, review.coachId, actor);
  if (!coach.ok) return coach;
  return validateReviewTarget(state, review);
}

function validateReviewTarget(state: ProjectState, review: CoachReview): Result<void, ProjectDomainError> {
  switch (review.target.type) {
    case "project":
      return review.target.projectId === review.projectId ? mapVoid(findProject(state, review.target.projectId)) : failure("INVARIANT_VIOLATION", "Review target belongs to another Project");
    case "goal": {
      const goal = findGoal(state, review.target.goalId);
      return goal.ok && goal.value.projectId === review.projectId ? ok(undefined) : goal.ok ? failure("INVARIANT_VIOLATION", "Review target belongs to another Project") : goal;
    }
    case "run": {
      const run = findRun(state, review.target.runId);
      return run.ok && run.value.projectId === review.projectId ? ok(undefined) : run.ok ? failure("INVARIANT_VIOLATION", "Review target belongs to another Project") : run;
    }
    case "comparison": {
      const comparisonId = review.target.comparisonId;
      const comparison = state.comparisons.find(item => item.id === comparisonId);
      if (!comparison) return notFound("Comparison", comparisonId);
      return comparison.projectId === review.projectId ? ok(undefined) : failure("INVARIANT_VIOLATION", "Review target belongs to another Project");
    }
  }
}

function validateCoachProposal(state: ProjectState, proposal: CoachProposal, actor: DomainActor): Result<void, ProjectDomainError> {
  if (state.coachProposals.some(item => item.id === proposal.id)) return duplicate("Coach proposal", proposal.id);
  const coach = validateCoachActor(state, proposal.projectId, proposal.coachId, actor);
  if (!coach.ok) return coach;
  const goal = findGoal(state, proposal.goalId);
  if (!goal.ok) return goal;
  if (goal.value.projectId !== proposal.projectId) return failure("INVARIANT_VIOLATION", "Proposal Goal belongs to another Project");
  if (proposal.type === "goal_change") {
    if (!hasKeys(proposal.change)) return failure("INVARIANT_VIOLATION", "Goal change proposal must change at least one field");
    return validateGoalRelation(state, applyGoalPatch(goal.value, proposal.change, proposal.proposedAt));
  }
  if (proposal.type === "runner_change") {
    const runner = findRunner(state, proposal.runnerId);
    return runner.ok && runner.value.projectId === proposal.projectId ? ok(undefined) : runner.ok ? failure("INVARIANT_VIOLATION", "Proposed Runner belongs to another Project") : runner;
  }
  const run = findRun(state, proposal.sourceRunId);
  if (!run.ok) return run;
  if (run.value.projectId !== proposal.projectId || run.value.goalId !== proposal.goalId) {
    return failure("INVARIANT_VIOLATION", "Proposed source Run does not match the Goal");
  }
  if (run.value.status !== "completed") {
    return failure("INVALID_TRANSITION", "A Hunsu proposal requires a completed source Run");
  }
  if (goal.value.status === "completed") return invalidTransition("Goal", goal.value.id, goal.value.status);
  if (proposal.alternative.type === "goal_change") {
    if (!hasKeys(proposal.alternative.change)) return failure("INVARIANT_VIOLATION", "Hunsu Goal change must change at least one field");
    const changed = applyGoalPatch(goal.value, proposal.alternative.change, proposal.proposedAt);
    const relation = validateGoalRelation(state, changed);
    return relation.ok ? validateGoalAssignment(state, changed) : relation;
  }
  const runner = findRunner(state, proposal.alternative.runnerId);
  return runner.ok && runner.value.projectId === proposal.projectId
    ? ok(undefined)
    : runner.ok ? failure("INVARIANT_VIOLATION", "Alternative Runner belongs to another Project") : runner;
}

function buildCoachProposalAcceptance(
  state: ProjectState,
  command: Extract<ProjectCommand, { type: "AcceptCoachProposal" }>
): Result<AcceptedCoachProposalDecision, ProjectDomainError> {
  const proposal = findOpenCoachProposal(state, command.proposalId, command.meta.actor);
  if (!proposal.ok) return proposal;

  if (proposal.value.type === "hunsu") {
    if (command.application.type !== "hunsu") {
      return failure("INVARIANT_VIOLATION", "A Hunsu proposal requires a Hunsu acceptance application");
    }
    const divergence = buildDivergence(state, {
      type: "ConfirmHunsu",
      meta: command.meta,
      divergenceId: command.application.divergenceId,
      projectId: proposal.value.projectId,
      goalId: proposal.value.goalId,
      sourceRunId: proposal.value.sourceRunId,
      basis: { type: "coach_proposal", proposalId: proposal.value.id }
    });
    if (!divergence.ok) return divergence;
    const current = findGoal(state, proposal.value.goalId);
    if (!current.ok) return current;
    if (current.value.status === "completed") return invalidTransition("Goal", current.value.id, current.value.status);
    const goal = proposal.value.alternative.type === "goal_change"
      ? applyGoalPatch(current.value, proposal.value.alternative.change, command.meta.requestedAt)
      : applyGoalPatch(
          current.value,
          { assignment: { type: "assigned", runnerId: proposal.value.alternative.runnerId } },
          command.meta.requestedAt
        );
    const relation = validateGoalRelation(state, goal);
    if (!relation.ok) return relation;
    const assignment = validateGoalAssignment(state, goal);
    return assignment.ok
      ? ok({
          status: "accepted",
          id: command.meta.eventId,
          proposalId: proposal.value.id,
          reason: command.reason,
          decidedAt: command.meta.requestedAt,
          application: { type: "hunsu", divergence: divergence.value, goal }
        })
      : assignment;
  }

  if (command.application.type !== "apply_change") {
    return failure("INVARIANT_VIOLATION", "Only a Hunsu proposal can create a divergence");
  }
  const current = findGoal(state, proposal.value.goalId);
  if (!current.ok) return current;
  if (current.value.status === "completed") return invalidTransition("Goal", current.value.id, current.value.status);

  if (proposal.value.type === "goal_change") {
    const goal = applyGoalPatch(current.value, proposal.value.change, command.meta.requestedAt);
    const relation = validateGoalRelation(state, goal);
    if (!relation.ok) return relation;
    const assignment = validateGoalAssignment(state, goal);
    return assignment.ok
      ? ok({
          status: "accepted",
          id: command.meta.eventId,
          proposalId: proposal.value.id,
          reason: command.reason,
          decidedAt: command.meta.requestedAt,
          application: { type: "goal_change", goal }
        })
      : assignment;
  }

  const goal = applyGoalPatch(
    current.value,
    { assignment: { type: "assigned", runnerId: proposal.value.runnerId } },
    command.meta.requestedAt
  );
  const assignment = validateGoalAssignment(state, goal);
  return assignment.ok
    ? ok({
        status: "accepted",
        id: command.meta.eventId,
        proposalId: proposal.value.id,
        reason: command.reason,
        decidedAt: command.meta.requestedAt,
        application: { type: "runner_change", goal }
      })
    : assignment;
}

function buildCoachProposalRejection(
  state: ProjectState,
  command: Extract<ProjectCommand, { type: "RejectCoachProposal" }>
): Result<RejectedCoachProposalDecision, ProjectDomainError> {
  const proposal = findOpenCoachProposal(state, command.proposalId, command.meta.actor);
  return proposal.ok
    ? ok({
        status: "rejected",
        id: command.meta.eventId,
        proposalId: proposal.value.id,
        reason: command.reason,
        decidedAt: command.meta.requestedAt
      })
    : proposal;
}

function findOpenCoachProposal(
  state: ProjectState,
  proposalId: CoachProposal["id"],
  actor: DomainActor
): Result<CoachProposal, ProjectDomainError> {
  if (actor.type !== "user") {
    return failure("USER_CONFIRMATION_REQUIRED", "Coach proposal decisions require explicit user confirmation");
  }
  const proposal = state.coachProposals.find(item => item.id === proposalId);
  if (!proposal) return notFound("Coach proposal", proposalId);
  if (state.coachProposalDecisions.some(item => item.proposalId === proposalId)
    || state.divergences.some(item => item.basis.type === "coach_proposal" && item.basis.proposalId === proposalId)) {
    return failure("INVALID_TRANSITION", "Coach proposal already has a recorded disposition");
  }
  return ok(proposal);
}

function buildDivergence(
  state: ProjectState,
  command: Extract<ProjectCommand, { type: "ConfirmHunsu" }>
): Result<HunsuDivergence, ProjectDomainError> {
  if (command.meta.actor.type !== "user") return failure("USER_CONFIRMATION_REQUIRED", "Hunsu requires explicit user confirmation");
  if (state.divergences.some(item => item.id === command.divergenceId)) return duplicate("Hunsu divergence", command.divergenceId);
  const run = findRun(state, command.sourceRunId);
  if (!run.ok) return run;
  if (run.value.status !== "completed") return failure("INVALID_TRANSITION", "Hunsu requires a completed source Run");
  if (run.value.projectId !== command.projectId || run.value.goalId !== command.goalId) {
    return failure("INVARIANT_VIOLATION", "Hunsu source Run does not match the Project and Goal");
  }
  if (command.basis.type === "coach_proposal") {
    const proposalId = command.basis.proposalId;
    const proposal = state.coachProposals.find(item => item.id === proposalId);
    if (!proposal) return notFound("Coach proposal", proposalId);
    if (proposal.type !== "hunsu" || proposal.projectId !== command.projectId || proposal.goalId !== command.goalId || proposal.sourceRunId !== command.sourceRunId) {
      return failure("INVARIANT_VIOLATION", "Coach proposal does not match the confirmed Hunsu");
    }
  }
  return ok({
    id: command.divergenceId,
    projectId: command.projectId,
    goalId: command.goalId,
    sourceRunId: command.sourceRunId,
    baseSha: run.value.baseSha,
    basis: command.basis,
    alternativeRunIds: [],
    confirmedAt: command.meta.requestedAt
  });
}

function buildComparison(
  state: ProjectState,
  command: Extract<ProjectCommand, { type: "CompareAlternatives" }>
): Result<AlternativeComparison, ProjectDomainError> {
  if (state.comparisons.some(item => item.id === command.comparisonId)) return duplicate("Comparison", command.comparisonId);
  const divergence = state.divergences.find(item => item.id === command.divergenceId);
  if (!divergence) return notFound("Hunsu divergence", command.divergenceId);
  if (command.runIds.length < 2 || new Set(command.runIds).size !== command.runIds.length) {
    return failure("INVARIANT_VIOLATION", "Comparison requires at least two unique Runs");
  }
  if (!command.runIds.includes(divergence.sourceRunId) || !command.runIds.some(id => divergence.alternativeRunIds.includes(id))) {
    return failure("INVARIANT_VIOLATION", "Comparison must include the source Run and at least one sibling alternative");
  }
  const siblingRunIds = new Set([divergence.sourceRunId, ...divergence.alternativeRunIds]);
  if (command.runIds.some(id => !siblingRunIds.has(id))) {
    return failure("INVARIANT_VIOLATION", "Comparison Runs must all belong to the selected Hunsu divergence");
  }
  const comparedRuns: CompletedRun[] = [];
  for (const id of command.runIds) {
    const run = findRun(state, id);
    if (!run.ok) return run;
    if (run.value.status !== "completed") return failure("INVALID_TRANSITION", "Only completed Runs can be compared");
    if (run.value.projectId !== divergence.projectId || run.value.goalId !== divergence.goalId || run.value.baseSha !== divergence.baseSha) {
      return failure("INVARIANT_VIOLATION", "Compared Runs must be same-base siblings for one Goal");
    }
    comparedRuns.push(run.value);
  }
  const requiredCriteria = [...new Set(comparedRuns.flatMap(run => run.goalSnapshot.acceptanceCriteria))];
  const findingCriteria = command.findings.map(finding => finding.criterion);
  if (findingCriteria.length !== requiredCriteria.length || new Set(findingCriteria).size !== findingCriteria.length) {
    return failure("INVARIANT_VIOLATION", "Comparison must contain exactly one finding for every acceptance criterion in the compared Run snapshots");
  }
  if (findingCriteria.some(criterion => !requiredCriteria.includes(criterion))) {
    return failure("INVARIANT_VIOLATION", "Comparison finding criterion must belong to a compared Run Goal snapshot");
  }
  for (const finding of command.findings) {
    const summarizedRunIds = finding.summaries.map(item => item.runId);
    if (finding.summaries.length !== command.runIds.length || new Set(summarizedRunIds).size !== summarizedRunIds.length) {
      return failure("INVARIANT_VIOLATION", "Every comparison finding must contain exactly one summary for each compared Run");
    }
    if (command.runIds.some(runId => !summarizedRunIds.includes(runId))) {
      return failure("INVARIANT_VIOLATION", "Every comparison finding must summarize every compared Run");
    }
  }
  return ok({
    id: command.comparisonId,
    projectId: divergence.projectId,
    goalId: divergence.goalId,
    divergenceId: divergence.id,
    baseSha: divergence.baseSha,
    runIds: command.runIds,
    findings: command.findings,
    summary: command.summary,
    recordedAt: command.meta.requestedAt
  });
}

function buildSelection(
  state: ProjectState,
  command: Extract<ProjectCommand, { type: "SelectAlternative" }>
): Result<SelectionDecision, ProjectDomainError> {
  if (command.meta.actor.type !== "user") return failure("USER_CONFIRMATION_REQUIRED", "Alternative selection requires explicit user confirmation");
  if (state.decisions.some(item => item.id === command.decisionId)) return duplicate("Decision", command.decisionId);
  const comparison = state.comparisons.find(item => item.id === command.comparisonId);
  if (!comparison) return notFound("Comparison", command.comparisonId);
  if (!comparison.runIds.includes(command.selectedRunId)) return failure("INVARIANT_VIOLATION", "Selected Run is not part of the comparison");
  if (state.decisions.some(item => item.type === "selection" && item.comparisonId === command.comparisonId)) {
    return failure("INVALID_TRANSITION", "Comparison already has a selected alternative");
  }
  if (rejectedRunIds(state, command.comparisonId).has(command.selectedRunId)) {
    return failure("INVALID_TRANSITION", "A rejected Run cannot be selected");
  }
  return ok({
    type: "selection",
    id: command.decisionId,
    comparisonId: command.comparisonId,
    selectedRunId: command.selectedRunId,
    rejectedRunIds: comparison.runIds.filter(id => id !== command.selectedRunId),
    rationale: command.rationale,
    decidedAt: command.meta.requestedAt
  });
}

function buildRejection(
  state: ProjectState,
  command: Extract<ProjectCommand, { type: "RejectAlternatives" }>
): Result<RejectionDecision, ProjectDomainError> {
  if (command.meta.actor.type !== "user") return failure("USER_CONFIRMATION_REQUIRED", "Alternative rejection requires explicit user confirmation");
  if (state.decisions.some(item => item.id === command.decisionId)) return duplicate("Decision", command.decisionId);
  const comparison = state.comparisons.find(item => item.id === command.comparisonId);
  if (!comparison) return notFound("Comparison", command.comparisonId);
  if (state.decisions.some(item => item.type === "selection" && item.comparisonId === command.comparisonId)) {
    return failure("INVALID_TRANSITION", "Selected comparison alternatives cannot be rejected later");
  }
  if (new Set(command.rejectedRunIds).size !== command.rejectedRunIds.length || command.rejectedRunIds.some(id => !comparison.runIds.includes(id))) {
    return failure("INVARIANT_VIOLATION", "Rejected Runs must be unique entries in the comparison");
  }
  const prior = rejectedRunIds(state, command.comparisonId);
  if (command.rejectedRunIds.some(id => prior.has(id))) return failure("INVALID_TRANSITION", "Run was already rejected");
  return ok({
    type: "rejection",
    id: command.decisionId,
    comparisonId: command.comparisonId,
    rejectedRunIds: command.rejectedRunIds,
    rationale: command.rationale,
    decidedAt: command.meta.requestedAt
  });
}

function validateCoachActor(
  state: ProjectState,
  projectId: Project["id"],
  coachId: Coach["id"],
  actor: DomainActor
): Result<void, ProjectDomainError> {
  const project = findProject(state, projectId);
  if (!project.ok) return project;
  if (project.value.coachId !== coachId || !state.coaches.some(coach => coach.id === coachId && coach.projectId === projectId)) {
    return failure("INVARIANT_VIOLATION", "Coach is not selected by the Project");
  }
  return actor.type === "coach" && actor.coachId === coachId
    ? ok(undefined)
    : failure("INVARIANT_VIOLATION", "Coach record must be authored by its Coach");
}

function captureGoalSnapshot(goal: Goal, capturedAt: GoalSnapshot["capturedAt"]): GoalSnapshot {
  return {
    id: goal.id,
    projectId: goal.projectId,
    title: goal.title,
    desiredOutcome: goal.desiredOutcome,
    acceptanceCriteria: [...goal.acceptanceCriteria] as GoalSnapshot["acceptanceCriteria"],
    constraints: [...goal.constraints],
    priority: goal.priority,
    assignment: cloneGoalAssignment(goal.assignment),
    relation: cloneGoalRelation(goal.relation),
    capturedAt
  };
}

function captureRunnerSnapshot(
  state: ProjectState,
  runner: Runner,
  capturedAt: PlayerSnapshot["capturedAt"]
): Result<RunnerSnapshot, ProjectDomainError> {
  if (runner.kind === "player") return ok(capturePlayerSnapshot(runner, capturedAt));
  const valid = validateRunnerGraph(state, runner);
  if (!valid.ok) return valid;
  const players: TeamPlayerSnapshot[] = runner.players.map(slot => {
    const player = state.runners.find(candidate => candidate.id === slot.playerId && candidate.kind === "player") as Player;
    return { slot: { ...slot }, player: capturePlayerSnapshot(player, capturedAt) };
  });
  return ok({
    kind: "team",
    id: runner.id,
    projectId: runner.projectId,
    strategy: { ...runner.strategy },
    players: players as unknown as TeamSnapshot["players"],
    capturedAt
  });
}

function capturePlayerSnapshot(player: Player, capturedAt: PlayerSnapshot["capturedAt"]): PlayerSnapshot {
  return {
    kind: "player",
    id: player.id,
    projectId: player.projectId,
    promptTemplate: player.promptTemplate,
    resources: player.resources.map(resource => ({ ...resource })),
    runtimePolicy: { ...player.runtimePolicy },
    capturedAt
  };
}

function sameGoalDefinition(left: GoalSnapshot, right: GoalSnapshot): boolean {
  return JSON.stringify({
    id: left.id,
    projectId: left.projectId,
    title: left.title,
    desiredOutcome: left.desiredOutcome,
    acceptanceCriteria: left.acceptanceCriteria,
    constraints: left.constraints,
    priority: left.priority,
    assignment: left.assignment,
    relation: left.relation
  }) === JSON.stringify({
    id: right.id,
    projectId: right.projectId,
    title: right.title,
    desiredOutcome: right.desiredOutcome,
    acceptanceCriteria: right.acceptanceCriteria,
    constraints: right.constraints,
    priority: right.priority,
    assignment: right.assignment,
    relation: right.relation
  });
}

function sameRunnerDefinition(left: RunnerSnapshot, right: RunnerSnapshot): boolean {
  return JSON.stringify(runnerDefinition(left)) === JSON.stringify(runnerDefinition(right));
}

function runnerDefinition(snapshot: RunnerSnapshot): unknown {
  if (snapshot.kind === "player") {
    return {
      kind: snapshot.kind,
      id: snapshot.id,
      projectId: snapshot.projectId,
      promptTemplate: snapshot.promptTemplate,
      resources: snapshot.resources,
      runtimePolicy: snapshot.runtimePolicy
    };
  }
  return {
    kind: snapshot.kind,
    id: snapshot.id,
    projectId: snapshot.projectId,
    strategy: snapshot.strategy,
    players: snapshot.players.map(item => ({
      slot: item.slot,
      player: runnerDefinition(item.player)
    }))
  };
}

function eventMetadata(meta: CommandMetadata): EventMetadata {
  return {
    eventId: meta.eventId,
    idempotencyKey: meta.idempotencyKey,
    fingerprint: meta.fingerprint,
    actor: meta.actor,
    recordedAt: meta.requestedAt
  };
}

function commandMetadata(meta: EventMetadata): CommandMetadata {
  return {
    eventId: meta.eventId,
    idempotencyKey: meta.idempotencyKey,
    fingerprint: meta.fingerprint,
    actor: meta.actor,
    requestedAt: meta.recordedAt
  };
}

function commandFromEvent(event: DomainEvent): ProjectCommand {
  const meta = commandMetadata(event.meta);
  switch (event.type) {
    case "ProjectCreated": return { type: "CreateProject", meta, project: event.project, coach: event.coach };
    case "ProjectUpdated": return { type: "UpdateProject", meta, projectId: event.projectId, patch: event.patch };
    case "GoalCreated": return { type: "CreateGoal", meta, goal: event.goal };
    case "GoalUpdated": return { type: "UpdateGoal", meta, goalId: event.goalId, patch: event.patch };
    case "GoalPaused": return { type: "PauseGoal", meta, goalId: event.goalId, reason: event.reason };
    case "GoalResumed": return { type: "ResumeGoal", meta, goalId: event.goalId };
    case "GoalCompleted": return { type: "CompleteGoal", meta, goalId: event.goalId, selectedRunId: event.selectedRunId };
    case "PlayerCreated": return { type: "CreatePlayer", meta, player: event.player };
    case "PlayerUpdated": return { type: "UpdatePlayer", meta, player: event.player };
    case "TeamCreated": return { type: "CreateTeam", meta, team: event.team };
    case "TeamUpdated": return { type: "UpdateTeam", meta, team: event.team };
    case "CoachUpdated": return { type: "UpdateCoach", meta, coach: event.coach };
    case "RunStarted": return {
      type: "StartRun", meta, runId: event.run.id, projectId: event.run.projectId, goalId: event.run.goalId,
      runnerId: event.run.runnerId, baseSha: event.run.baseSha, branch: event.run.branch, origin: event.run.origin
    };
    case "RunCheckpointed": return { type: "CheckpointRun", meta, checkpoint: event.checkpoint };
    case "RunEvidenceAttached": return { type: "AttachRunEvidence", meta, evidence: event.evidence };
    case "RunCompleted": return { type: "CompleteRun", meta, result: event.result };
    case "RunFailed": return { type: "FailRun", meta, runId: event.runId, reason: event.reason };
    case "RunCanceled": return { type: "CancelRun", meta, runId: event.runId, reason: event.reason };
    case "CoachReviewRecorded": return { type: "RecordCoachReview", meta, review: event.review };
    case "CoachProposalRecorded": return { type: "RecordCoachProposal", meta, proposal: event.proposal };
    case "CoachProposalAccepted": return {
      type: "AcceptCoachProposal",
      meta,
      proposalId: event.decision.proposalId,
      reason: event.decision.reason,
      application: event.decision.application.type === "hunsu"
        ? { type: "hunsu", divergenceId: event.decision.application.divergence.id }
        : { type: "apply_change" }
    };
    case "CoachProposalRejected": return {
      type: "RejectCoachProposal",
      meta,
      proposalId: event.decision.proposalId,
      reason: event.decision.reason
    };
    case "HunsuConfirmed": return {
      type: "ConfirmHunsu", meta, divergenceId: event.divergence.id, projectId: event.divergence.projectId,
      goalId: event.divergence.goalId, sourceRunId: event.divergence.sourceRunId, basis: event.divergence.basis
    };
    case "AlternativesCompared": return {
      type: "CompareAlternatives", meta, comparisonId: event.comparison.id, divergenceId: event.comparison.divergenceId,
      runIds: event.comparison.runIds, findings: event.comparison.findings, summary: event.comparison.summary
    };
    case "AlternativeSelected": return {
      type: "SelectAlternative", meta, decisionId: event.decision.id, comparisonId: event.decision.comparisonId,
      selectedRunId: event.decision.selectedRunId, rationale: event.decision.rationale
    };
    case "AlternativesRejected": return {
      type: "RejectAlternatives", meta, decisionId: event.decision.id, comparisonId: event.decision.comparisonId,
      rejectedRunIds: event.decision.rejectedRunIds, rationale: event.decision.rationale
    };
  }
}

function projectAcceptedEvent(state: ProjectState, event: DomainEvent): ProjectState {
  switch (event.type) {
    case "ProjectCreated":
      return { ...state, projects: [...state.projects, event.project], coaches: [...state.coaches, event.coach] };
    case "ProjectUpdated":
      return { ...state, projects: state.projects.map(project => project.id === event.projectId ? { ...project, ...event.patch, updatedAt: event.meta.recordedAt } : project) };
    case "GoalCreated":
      return {
        ...state,
        goals: [...state.goals, event.goal],
        projects: state.projects.map(project => project.id === event.goal.projectId ? { ...project, goalIds: [...project.goalIds, event.goal.id], updatedAt: event.meta.recordedAt } : project)
      };
    case "GoalUpdated":
      return { ...state, goals: state.goals.map(goal => goal.id === event.goalId ? applyGoalPatch(goal, event.patch, event.meta.recordedAt) : goal) };
    case "GoalPaused":
      return { ...state, goals: state.goals.map(goal => goal.id === event.goalId ? { ...goalBase(goal), status: "paused", pausedAt: event.meta.recordedAt, pauseReason: event.reason } : goal) };
    case "GoalResumed":
      return { ...state, goals: state.goals.map(goal => goal.id === event.goalId ? { ...goalBase(goal), status: "active", updatedAt: event.meta.recordedAt } : goal) };
    case "GoalCompleted":
      return { ...state, goals: state.goals.map(goal => goal.id === event.goalId ? { ...goalBase(goal), status: "completed", completedAt: event.meta.recordedAt, selectedRunId: event.selectedRunId, updatedAt: event.meta.recordedAt } : goal) };
    case "PlayerCreated":
      return addRunner(state, event.player, event.meta.recordedAt);
    case "TeamCreated":
      return addRunner(state, event.team, event.meta.recordedAt);
    case "PlayerUpdated":
      return { ...state, runners: state.runners.map(runner => runner.id === event.player.id ? event.player : runner) };
    case "TeamUpdated":
      return { ...state, runners: state.runners.map(runner => runner.id === event.team.id ? event.team : runner) };
    case "CoachUpdated":
      return { ...state, coaches: state.coaches.map(coach => coach.id === event.coach.id ? event.coach : coach) };
    case "RunStarted": {
      const next = { ...state, runs: [...state.runs, event.run] };
      if (event.run.origin.type !== "hunsu_alternative") return next;
      const divergenceId = event.run.origin.divergenceId;
      return {
        ...next,
        divergences: next.divergences.map(item => item.id === divergenceId
          ? { ...item, alternativeRunIds: [...item.alternativeRunIds, event.run.id] }
          : item)
      };
    }
    case "RunCheckpointed":
      return { ...state, runs: state.runs.map(run => run.id === event.checkpoint.runId ? { ...run, checkpoints: [...run.checkpoints, event.checkpoint] } : run) };
    case "RunEvidenceAttached":
      return {
        ...state,
        evidence: [...state.evidence, event.evidence],
        runs: state.runs.map(run => run.id === event.evidence.runId ? { ...run, evidenceIds: [...run.evidenceIds, event.evidence.id] } : run)
      };
    case "RunCompleted":
      return { ...state, runs: state.runs.map(run => run.id === event.result.runId ? completedRun(run, event.result, event.meta.recordedAt) : run) };
    case "RunFailed":
      return { ...state, runs: state.runs.map(run => run.id === event.runId ? { ...runBase(run), status: "failed", failedAt: event.meta.recordedAt, failureReason: event.reason } : run) };
    case "RunCanceled":
      return { ...state, runs: state.runs.map(run => run.id === event.runId ? { ...runBase(run), status: "canceled", canceledAt: event.meta.recordedAt, cancellationReason: event.reason } : run) };
    case "CoachReviewRecorded":
      return { ...state, coachReviews: [...state.coachReviews, event.review] };
    case "CoachProposalRecorded":
      return { ...state, coachProposals: [...state.coachProposals, event.proposal] };
    case "CoachProposalAccepted": {
      const next = {
        ...state,
        coachProposalDecisions: [...state.coachProposalDecisions, event.decision]
      };
      if (event.decision.application.type === "hunsu") {
        const application = event.decision.application;
        return {
          ...next,
          divergences: [...next.divergences, application.divergence],
          goals: next.goals.map(candidate => candidate.id === application.goal.id ? application.goal : candidate)
        };
      }
      const goal = event.decision.application.goal;
      return { ...next, goals: next.goals.map(candidate => candidate.id === goal.id ? goal : candidate) };
    }
    case "CoachProposalRejected":
      return { ...state, coachProposalDecisions: [...state.coachProposalDecisions, event.decision] };
    case "HunsuConfirmed":
      return { ...state, divergences: [...state.divergences, event.divergence] };
    case "AlternativesCompared":
      return { ...state, comparisons: [...state.comparisons, event.comparison] };
    case "AlternativeSelected":
      return { ...state, decisions: [...state.decisions, event.decision] };
    case "AlternativesRejected":
      return { ...state, decisions: [...state.decisions, event.decision] };
  }
}

function addRunner(state: ProjectState, runner: Runner, at: Project["updatedAt"]): ProjectState {
  return {
    ...state,
    runners: [...state.runners, runner],
    projects: state.projects.map(project => project.id === runner.projectId
      ? { ...project, runnerIds: [...project.runnerIds, runner.id], updatedAt: at }
      : project)
  };
}

function completedRun(run: Run, result: VerifiedRunResult, at: CompletedRun["completedAt"]): CompletedRun {
  return {
    ...runBase(run),
    status: "completed",
    resultSha: result.resultSha,
    verifiedAt: result.verifiedAt,
    completedAt: at
  };
}

function goalBase(goal: Goal): GoalBase {
  return {
    id: goal.id,
    projectId: goal.projectId,
    title: goal.title,
    desiredOutcome: goal.desiredOutcome,
    acceptanceCriteria: goal.acceptanceCriteria,
    constraints: goal.constraints,
    priority: goal.priority,
    assignment: goal.assignment,
    relation: goal.relation,
    createdAt: goal.createdAt,
    updatedAt: goal.updatedAt
  };
}

function applyGoalPatch(goal: ActiveGoal | PausedGoal, patch: GoalPatch, at: Goal["updatedAt"]): ActiveGoal | PausedGoal;
function applyGoalPatch(goal: Goal, patch: GoalPatch, at: Goal["updatedAt"]): Goal;
function applyGoalPatch(goal: Goal, patch: GoalPatch, at: Goal["updatedAt"]): Goal {
  const base = { ...goalBase(goal), ...patch, updatedAt: at };
  if (goal.status === "active") return { ...base, status: "active" };
  if (goal.status === "paused") return { ...base, status: "paused", pausedAt: goal.pausedAt, pauseReason: goal.pauseReason };
  return { ...base, status: "completed", completedAt: goal.completedAt, selectedRunId: goal.selectedRunId };
}

function runBase(run: Run): import("@hunsu/protocol").RunBase {
  return {
    id: run.id,
    projectId: run.projectId,
    goalId: run.goalId,
    runnerId: run.runnerId,
    baseSha: run.baseSha,
    branch: run.branch,
    origin: run.origin,
    goalSnapshot: run.goalSnapshot,
    runnerSnapshot: run.runnerSnapshot,
    checkpoints: run.checkpoints,
    evidenceIds: run.evidenceIds,
    startedAt: run.startedAt
  };
}

function recordProcessed(state: ProjectState, meta: EventMetadata): ProjectState {
  const processed: ProcessedCommand = {
    idempotencyKey: meta.idempotencyKey,
    fingerprint: meta.fingerprint,
    eventId: meta.eventId
  };
  return { ...state, processedCommands: [...state.processedCommands, processed] };
}

function cloneGoalRelation(relation: GoalBase["relation"]): GoalBase["relation"] {
  if (relation.type === "root") return { type: "root" };
  if (relation.type === "child") return { type: "child", parentGoalId: relation.parentGoalId };
  return { type: "related", goalIds: [...relation.goalIds] as NonNullable<GoalBase["relation"] & { type: "related" }>["goalIds"] };
}

function cloneGoalAssignment(assignment: GoalBase["assignment"]): GoalBase["assignment"] {
  return assignment.type === "assigned"
    ? { type: "assigned", runnerId: assignment.runnerId }
    : { type: "unassigned" };
}

function rejectedRunIds(state: ProjectState, comparisonId: import("@hunsu/protocol").ComparisonId): Set<Run["id"]> {
  return new Set(state.decisions
    .filter((item): item is RejectionDecision => item.type === "rejection" && item.comparisonId === comparisonId)
    .flatMap(item => [...item.rejectedRunIds]));
}

function findProject(state: ProjectState, id: Project["id"]): Result<Project, ProjectDomainError> {
  const value = state.projects.find(item => item.id === id);
  return value ? ok(value) : notFound("Project", id);
}

function findGoal(state: ProjectState, id: Goal["id"]): Result<Goal, ProjectDomainError> {
  const value = state.goals.find(item => item.id === id);
  return value ? ok(value) : notFound("Goal", id);
}

function findRunner(state: ProjectState, id: Runner["id"]): Result<Runner, ProjectDomainError> {
  const value = state.runners.find(item => item.id === id);
  return value ? ok(value) : notFound("Runner", id);
}

function findRun(state: ProjectState, id: Run["id"]): Result<Run, ProjectDomainError> {
  const value = state.runs.find(item => item.id === id);
  return value ? ok(value) : notFound("Run", id);
}

function findRunningRun(state: ProjectState, id: Run["id"]): Result<RunningRun, ProjectDomainError> {
  const run = findRun(state, id);
  if (!run.ok) return run;
  return run.value.status === "running" ? ok(run.value) : invalidTransition("Run", id, run.value.status);
}

function accepted(event: DomainEvent): Result<CommandDecision, ProjectDomainError> {
  return ok({ type: "accepted", event });
}

function duplicate(kind: string, id: unknown): Result<never, ProjectDomainError> {
  return failure("DUPLICATE_ID", kind + " ID already exists: " + String(id));
}

function notFound(kind: string, id: unknown): Result<never, ProjectDomainError> {
  return failure("NOT_FOUND", kind + " was not found: " + String(id));
}

function invalidTransition(kind: string, id: unknown, status: string): Result<never, ProjectDomainError> {
  return failure("INVALID_TRANSITION", kind + " " + String(id) + " cannot transition from " + status);
}

function failure(code: ProjectDomainErrorCode, message: string): Result<never, ProjectDomainError> {
  return err({ type: "ProjectDomainError", code, message });
}

function mapVoid<T>(result: Result<T, ProjectDomainError>): Result<void, ProjectDomainError> {
  return result.ok ? ok(undefined) : result;
}

function hasKeys(value: object): boolean {
  return Object.keys(value).length > 0;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, item]) => [key, sortJson(item)]));
}
