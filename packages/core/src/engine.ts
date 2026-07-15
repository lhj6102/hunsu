import {
  MAX_NODE_PAYLOAD_DECODED_BYTES,
  MAX_NODE_PAYLOAD_ENCODED_BYTES,
  NODE_PLAN_SCHEMA,
  canonicalUtf8ByteLength,
  computeGoalDigest,
  computeNodePayloadDigest,
  computeNodePlanDigest,
  computeRunnerDigest,
  err,
  managedNodeRef,
  nodePayloadFor,
  ok,
  runBranchName,
  type AlternativeComparison,
  type CoachingChildNode,
  type CoachingProposal,
  type CoachingProposalDecision,
  type CompareAlternativesCommand,
  type CommandMetadata,
  type CompletedRun,
  type DomainActor,
  type DomainEvent,
  type EventId,
  type EventMetadata,
  type EvidenceRef,
  type GitCommitSha,
  type GoalDigest,
  type Node,
  type NodePayload,
  type NodePayloadEnvelope,
  type NodePlan,
  type NonEmptyArray,
  type ProcessedCommand,
  type Project,
  type ProjectCommand,
  type ProjectState,
  type RejectionDecision,
  type Result,
  type RootNode,
  type Run,
  type RunCheckpoint,
  type RunChildNode,
  type RunningRun,
  type SelectionDecision,
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

export type NodePayloadVerificationError = {
  readonly message: string;
};

export type ProjectIntegrityBoundary = {
  readonly verifyNodePayload: (
    expected: NodePayload,
    envelope: NodePayloadEnvelope
  ) => Result<true, NodePayloadVerificationError>;
};

export type CommandDecision =
  | { readonly type: "accepted"; readonly events: NonEmptyArray<DomainEvent> }
  | { readonly type: "reused"; readonly eventIds: NonEmptyArray<EventId> };

export type CommandApplication = {
  readonly state: ProjectState;
  readonly emittedEvents: readonly DomainEvent[];
  readonly reusedEventIds: readonly EventId[];
};

export function emptyProjectState(): ProjectState {
  return {
    projects: [],
    nodes: [],
    runs: [],
    evidence: [],
    coachReviews: [],
    coachingProposals: [],
    coachingProposalDecisions: [],
    comparisons: [],
    decisions: [],
    processedCommands: []
  };
}

export function decideProjectCommand(
  state: ProjectState,
  command: ProjectCommand,
  integrity: ProjectIntegrityBoundary
): Result<CommandDecision, ProjectDomainError> {
  const retry = decideRetry(state, command.meta);
  if (!retry.ok) return retry;
  if (retry.value !== undefined) return ok(retry.value);
  const meta = eventMetadata(command.meta);

  switch (command.type) {
    case "CreateProject": {
      const valid = validateProjectCreation(state, command.project, command.rootNode, command.payload, command.meta.actor, integrity);
      if (!valid.ok) return valid;
      const additional = validateAdditionalEventId(state, command.meta.eventId, command.rootNodeEventId);
      if (!additional.ok) return additional;
      return accepted(
        { type: "ProjectCreated", meta, project: command.project },
        {
          type: "RootNodeRegistered",
          meta: eventMetadata(command.meta, command.rootNodeEventId),
          node: command.rootNode,
          payload: command.payload
        }
      );
    }
    case "RebuildProjectMaterializations": {
      const valid = validateProjectRebuild(state, command.projectId, command.meta.actor);
      return valid.ok
        ? accepted({ type: "ProjectMaterializationsRebuilt", meta, projectId: command.projectId })
        : valid;
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
      const valid = validateRunCompletion(state, command.result, command.node, command.payload, command.meta.requestedAt, integrity);
      if (!valid.ok) return valid;
      const additional = validateAdditionalEventId(state, command.meta.eventId, command.nodeEventId);
      if (!additional.ok) return additional;
      return accepted(
        { type: "RunCompleted", meta, result: command.result },
        {
          type: "RunChildNodeRegistered",
          meta: eventMetadata(command.meta, command.nodeEventId),
          node: command.node,
          payload: command.payload
        }
      );
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
    case "RecordCoachingProposal": {
      const valid = validateCoachingProposalCommand(state, command.proposal, command.meta);
      return valid.ok ? accepted({ type: "CoachingProposalRecorded", meta, proposal: command.proposal }) : valid;
    }
    case "ConfirmCoachingProposal": {
      const built = buildCoachingConfirmation(state, command, integrity);
      if (!built.ok) return built;
      const additional = validateAdditionalEventId(state, command.meta.eventId, command.nodeEventId);
      if (!additional.ok) return additional;
      return accepted(
        { type: "CoachingProposalConfirmed", meta, decision: built.value },
        {
          type: "CoachingChildNodeRegistered",
          meta: eventMetadata(command.meta, command.nodeEventId),
          node: command.node,
          payload: command.payload
        }
      );
    }
    case "RejectCoachingProposal": {
      const decision = buildCoachingRejection(state, command);
      return decision.ok ? accepted({ type: "CoachingProposalRejected", meta, decision: decision.value }) : decision;
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
  command: ProjectCommand,
  integrity: ProjectIntegrityBoundary
): Result<CommandApplication, ProjectDomainError> {
  const decision = decideProjectCommand(state, command, integrity);
  if (!decision.ok) return decision;
  if (decision.value.type === "reused") {
    return ok({ state, emittedEvents: [], reusedEventIds: decision.value.eventIds });
  }
  let next = state;
  for (const event of decision.value.events) {
    const applied = applyDomainEvent(next, event, integrity);
    if (!applied.ok) return applied;
    next = applied.value;
  }
  return ok({ state: next, emittedEvents: decision.value.events, reusedEventIds: [] });
}

export function applyDomainEvent(
  state: ProjectState,
  event: DomainEvent,
  integrity: ProjectIntegrityBoundary
): Result<ProjectState, ProjectDomainError> {
  const eventIdentity = validateEventIdentity(state, event.meta);
  if (!eventIdentity.ok) return eventIdentity;
  switch (event.type) {
    case "ProjectCreated": {
      const valid = validateProjectEvent(state, event.project, event.meta.actor);
      return valid.ok ? ok(finish({ ...state, projects: [...state.projects, event.project] }, event.meta)) : asInvalidEvent(valid);
    }
    case "ProjectMaterializationsRebuilt": {
      const valid = validateProjectRebuild(state, event.projectId, event.meta.actor);
      return valid.ok ? ok(finish(state, event.meta)) : asInvalidEvent(valid);
    }
    case "RootNodeRegistered": {
      if (event.meta.actor.type !== "user") return invalidEvent("Root Node registration requires explicit user confirmation");
      const project = findProject(state, event.node.projectId);
      if (!project.ok) return project;
      if (project.value.rootNodeSha !== event.node.commitSha) {
        return invalidEvent("Root Node does not match the Project root SHA");
      }
      const valid = validateNewNode(state, event.node, event.payload, event.meta.recordedAt, integrity);
      return valid.ok ? ok(finish({ ...state, nodes: [...state.nodes, event.node] }, event.meta)) : asInvalidEvent(valid);
    }
    case "RunStarted": {
      const valid = validateRunningRunEvent(state, event.run);
      return valid.ok ? ok(finish({ ...state, runs: [...state.runs, event.run] }, event.meta)) : asInvalidEvent(valid);
    }
    case "RunCheckpointed": {
      const valid = validateCheckpoint(state, event.checkpoint);
      if (!valid.ok) return asInvalidEvent(valid);
      return ok(finish({ ...state, runs: replaceRun(state.runs, event.checkpoint.runId, run => ({
        ...run,
        checkpoints: [...run.checkpoints, event.checkpoint]
      })) }, event.meta));
    }
    case "RunEvidenceAttached": {
      const valid = validateEvidence(state, event.evidence);
      if (!valid.ok) return asInvalidEvent(valid);
      return ok(finish({
        ...state,
        evidence: [...state.evidence, event.evidence],
        runs: replaceRun(state.runs, event.evidence.runId, run => ({ ...run, evidenceIds: [...run.evidenceIds, event.evidence.id] }))
      }, event.meta));
    }
    case "RunCompleted": {
      const valid = validateVerifiedRunResult(state, event.result);
      if (!valid.ok) return asInvalidEvent(valid);
      return ok(finish({ ...state, runs: replaceRun(state.runs, event.result.runId, run => ({
        ...run,
        status: "completed",
        resultNodeSha: event.result.resultSha,
        verifiedAt: event.result.verifiedAt,
        completedAt: event.meta.recordedAt
      })) }, event.meta));
    }
    case "RunChildNodeRegistered": {
      const run = findCompletedRun(state, event.node.runId);
      if (!run.ok) return asInvalidEvent(run);
      const valid = validateRunChildNode(state, run.value, event.node, event.payload, event.meta.recordedAt, integrity);
      return valid.ok ? ok(finish({ ...state, nodes: [...state.nodes, event.node] }, event.meta)) : asInvalidEvent(valid);
    }
    case "RunFailed": {
      const run = findRunningRun(state, event.runId);
      if (!run.ok) return asInvalidEvent(run);
      return ok(finish({ ...state, runs: replaceRun(state.runs, event.runId, item => ({
        ...item,
        status: "failed",
        failedAt: event.meta.recordedAt,
        failureReason: event.reason
      })) }, event.meta));
    }
    case "RunCanceled": {
      const run = findRunningRun(state, event.runId);
      if (!run.ok) return asInvalidEvent(run);
      return ok(finish({ ...state, runs: replaceRun(state.runs, event.runId, item => ({
        ...item,
        status: "canceled",
        canceledAt: event.meta.recordedAt,
        cancellationReason: event.reason
      })) }, event.meta));
    }
    case "CoachReviewRecorded": {
      const valid = validateCoachReview(state, event.review, event.meta.actor);
      return valid.ok
        ? ok(finish({ ...state, coachReviews: [...state.coachReviews, event.review] }, event.meta))
        : asInvalidEvent(valid);
    }
    case "CoachingProposalRecorded": {
      const valid = validateCoachingProposal(state, event.proposal, event.meta.actor);
      return valid.ok
        ? ok(finish({ ...state, coachingProposals: [...state.coachingProposals, event.proposal] }, event.meta))
        : asInvalidEvent(valid);
    }
    case "CoachingProposalConfirmed": {
      const proposal = findConfirmableCoachingProposal(state, event.decision.proposalId, event.meta.actor);
      if (!proposal.ok) return asInvalidEvent(proposal);
      const decisionId = validateDecisionId(state, event.decision.id);
      if (!decisionId.ok) return asInvalidEvent(decisionId);
      return ok(finish({
        ...state,
        coachingProposalDecisions: [...state.coachingProposalDecisions, event.decision]
      }, event.meta));
    }
    case "CoachingChildNodeRegistered": {
      const valid = validateCoachingChildEvent(state, event.node, event.payload, event.meta.recordedAt, integrity);
      return valid.ok ? ok(finish({ ...state, nodes: [...state.nodes, event.node] }, event.meta)) : asInvalidEvent(valid);
    }
    case "CoachingProposalRejected": {
      const proposal = findOpenCoachingProposal(state, event.decision.proposalId, event.meta.actor);
      if (!proposal.ok) return asInvalidEvent(proposal);
      const decisionId = validateDecisionId(state, event.decision.id);
      if (!decisionId.ok) return asInvalidEvent(decisionId);
      return ok(finish({
        ...state,
        coachingProposalDecisions: [...state.coachingProposalDecisions, event.decision]
      }, event.meta));
    }
    case "AlternativesCompared": {
      const valid = validateComparison(state, event.comparison);
      return valid.ok
        ? ok(finish({ ...state, comparisons: [...state.comparisons, event.comparison] }, event.meta))
        : asInvalidEvent(valid);
    }
    case "AlternativeSelected": {
      const valid = validateSelectionDecision(state, event.decision, event.meta.actor);
      return valid.ok ? ok(finish({ ...state, decisions: [...state.decisions, event.decision] }, event.meta)) : asInvalidEvent(valid);
    }
    case "AlternativesRejected": {
      const valid = validateRejectionDecision(state, event.decision, event.meta.actor);
      return valid.ok ? ok(finish({ ...state, decisions: [...state.decisions, event.decision] }, event.meta)) : asInvalidEvent(valid);
    }
  }
}

export function replayDomainEvents(
  events: readonly DomainEvent[],
  integrity: ProjectIntegrityBoundary
): Result<ProjectState, ProjectDomainError> {
  const batches = validateDomainEventBatches(events);
  if (!batches.ok) return batches;
  let state = emptyProjectState();
  for (const event of events) {
    const applied = applyDomainEvent(state, event, integrity);
    if (!applied.ok) return applied;
    state = applied.value;
  }
  return ok(state);
}

function validateDomainEventBatches(events: readonly DomainEvent[]): Result<void, ProjectDomainError> {
  const closed = new Set<string>();
  const eventIds = new Set<EventId>();
  let current: DomainEvent[] = [];

  const closeCurrent = (): Result<void, ProjectDomainError> => {
    if (current.length === 0) return ok(undefined);
    const types = current.map(event => event.type);
    const validPair = (types[0] === "ProjectCreated" && types[1] === "RootNodeRegistered")
      || (types[0] === "RunCompleted" && types[1] === "RunChildNodeRegistered")
      || (types[0] === "CoachingProposalConfirmed" && types[1] === "CoachingChildNodeRegistered");
    const requiresPair = types.some(type => type === "ProjectCreated"
      || type === "RootNodeRegistered"
      || type === "RunCompleted"
      || type === "RunChildNodeRegistered"
      || type === "CoachingProposalConfirmed"
      || type === "CoachingChildNodeRegistered");
    if ((current.length === 2 && !validPair) || current.length > 2 || (current.length === 1 && requiresPair)) {
      return invalidEvent(`Command event batch is incomplete or invalid: ${types.join(", ")}`);
    }
    closed.add(current[0]!.meta.idempotencyKey);
    return ok(undefined);
  };

  for (const event of events) {
    if (eventIds.has(event.meta.eventId)) return invalidEvent(`Event ${event.meta.eventId} appears more than once`);
    eventIds.add(event.meta.eventId);
    const first = current[0];
    if (first && event.meta.idempotencyKey !== first.meta.idempotencyKey) {
      const closedBatch = closeCurrent();
      if (!closedBatch.ok) return closedBatch;
      current = [];
    }
    if (closed.has(event.meta.idempotencyKey)) return invalidEvent("A command event batch cannot be split by another command");
    const batchFirst = current[0];
    if (batchFirst && (event.meta.fingerprint !== batchFirst.meta.fingerprint
      || event.meta.recordedAt !== batchFirst.meta.recordedAt
      || !sameDomainActor(event.meta.actor, batchFirst.meta.actor)
    )) {
      return invalidEvent("Events in one command batch must share fingerprint, actor, and timestamp");
    }
    current.push(event);
  }
  return closeCurrent();
}

function sameDomainActor(left: DomainActor, right: DomainActor): boolean {
  if (left.type !== right.type) return false;
  if (left.type === "system" && right.type === "system") return true;
  return left.type !== "system" && right.type !== "system" && left.id === right.id;
}

export function inheritRunChildPlan(
  source: Node,
  consumedGoalDigest: GoalDigest
): Result<NodePlan, ProjectDomainError> {
  const matches = source.plan.nextGoals.filter(goal => computeGoalDigest(goal) === consumedGoalDigest);
  if (matches.length !== 1) {
    return failure("INVARIANT_VIOLATION", "A Run must digest exactly one Goal from its source Node");
  }
  return ok({
    schema: NODE_PLAN_SCHEMA,
    nextGoals: source.plan.nextGoals.filter(goal => computeGoalDigest(goal) !== consumedGoalDigest),
    how: source.plan.how
  });
}

export function validateNodeGraph(state: ProjectState): Result<true, ProjectDomainError> {
  for (const project of state.projects) {
    const nodes = state.nodes.filter(node => node.projectId === project.id);
    const shas = nodes.map(node => node.commitSha);
    if (new Set(shas).size !== shas.length) {
      return failure("INVARIANT_VIOLATION", `Project ${project.id} contains duplicate Node SHAs`);
    }
    const roots = nodes.filter((node): node is RootNode => node.type === "root");
    if (roots.length !== 1 || roots[0]!.commitSha !== project.rootNodeSha) {
      return failure("INVARIANT_VIOLATION", `Project ${project.id} must contain exactly its declared root Node`);
    }
    for (const node of nodes) {
      if (node.type === "root") continue;
      if (node.parentSha === node.commitSha) return failure("INVARIANT_VIOLATION", "Node cannot be its own parent");
      const parent = nodes.find(candidate => candidate.commitSha === node.parentSha);
      if (!parent) return failure("INVARIANT_VIOLATION", `Node ${node.commitSha} has no parent in its Project`);
      const visited = new Set<GitCommitSha>([node.commitSha]);
      let cursor: Node = parent;
      while (cursor.type !== "root") {
        if (visited.has(cursor.commitSha)) return failure("INVARIANT_VIOLATION", "Node Graph contains a cycle");
        visited.add(cursor.commitSha);
        const parentSha = cursor.parentSha;
        const next = nodes.find(candidate => candidate.commitSha === parentSha);
        if (!next) return failure("INVARIANT_VIOLATION", `Node ${cursor.commitSha} has no parent in its Project`);
        cursor = next;
      }
    }
  }
  return ok(true);
}

export function unresolvedDivergenceCount(state: ProjectState, projectId: Project["id"]): number {
  const children = state.nodes.filter((node): node is RunChildNode => node.projectId === projectId && node.type === "run_child");
  const parents = new Set(children.map(node => node.parentSha));
  const selected = new Set(state.decisions.flatMap(decision => decision.type === "selection" && decision.projectId === projectId ? [decision.selectedNodeSha] : []));
  const rejected = new Set(state.decisions.flatMap(decision => decision.type === "rejection" && decision.projectId === projectId ? decision.rejectedNodeShas : []));
  let unresolved = 0;
  for (const parentSha of parents) {
    const siblings = children.filter(node => node.parentSha === parentSha);
    if (siblings.length < 2) continue;
    if (!isCandidateCohortResolved(siblings.map(node => node.commitSha), selected, rejected)) unresolved += 1;
  }

  const coachedCohorts = new Map<string, Set<GitCommitSha>>();
  for (const comparison of state.comparisons) {
    if (comparison.projectId !== projectId || comparison.type !== "coached_how_experiment") continue;
    const key = comparisonCohortKey(comparison);
    const nodeShas = coachedCohorts.get(key) ?? new Set<GitCommitSha>();
    for (const nodeSha of comparison.nodeShas) nodeShas.add(nodeSha);
    coachedCohorts.set(key, nodeShas);
  }
  for (const nodeShas of coachedCohorts.values()) {
    if (nodeShas.size >= 2 && !isCandidateCohortResolved([...nodeShas], selected, rejected)) unresolved += 1;
  }
  return unresolved;
}

function isCandidateCohortResolved(
  nodeShas: readonly GitCommitSha[],
  selected: ReadonlySet<GitCommitSha>,
  rejected: ReadonlySet<GitCommitSha>
): boolean {
  const selectedCandidates = nodeShas.filter(nodeSha => selected.has(nodeSha) && !rejected.has(nodeSha));
  const allRejected = nodeShas.every(nodeSha => rejected.has(nodeSha));
  const oneSelected = selectedCandidates.length === 1
    && nodeShas.every(nodeSha => nodeSha === selectedCandidates[0] || rejected.has(nodeSha));
  return allRejected || oneSelected;
}

function validateProjectCreation(
  state: ProjectState,
  project: Project,
  rootNode: RootNode,
  payload: NodePayloadEnvelope,
  actor: DomainActor,
  integrity: ProjectIntegrityBoundary
): Result<void, ProjectDomainError> {
  const projectValid = validateProjectEvent(state, project, actor);
  if (!projectValid.ok) return projectValid;
  if (rootNode.projectId !== project.id || rootNode.commitSha !== project.rootNodeSha) {
    return failure("INVARIANT_VIOLATION", "Root Node must match the new Project and its declared root SHA");
  }
  if (rootNode.type !== "root") return failure("INVARIANT_VIOLATION", "Project initialization requires a root Node");
  return validateNodeContent(rootNode, payload, rootNode.registeredAt, integrity);
}

function validateProjectEvent(state: ProjectState, project: Project, actor: DomainActor): Result<void, ProjectDomainError> {
  if (actor.type !== "user") return failure("USER_CONFIRMATION_REQUIRED", "Project initialization requires explicit user confirmation");
  return state.projects.some(candidate => candidate.id === project.id)
    ? duplicate("Project", project.id)
    : ok(undefined);
}

function validateProjectRebuild(
  state: ProjectState,
  projectId: Project["id"],
  actor: DomainActor
): Result<void, ProjectDomainError> {
  if (actor.type !== "user") {
    return failure("USER_CONFIRMATION_REQUIRED", "Project materialization rebuild requires explicit user confirmation");
  }
  return mapVoid(findProject(state, projectId));
}

function buildRunningRun(
  state: ProjectState,
  command: Extract<ProjectCommand, { type: "StartRun" }>
): Result<RunningRun, ProjectDomainError> {
  if (state.runs.some(run => run.id === command.runId)) return duplicate("Run", command.runId);
  const project = findProject(state, command.projectId);
  if (!project.ok) return project;
  const source = findNode(state, command.projectId, command.sourceNodeSha);
  if (!source.ok) return source;
  if (isRejectedNode(state, command.projectId, source.value.commitSha)) {
    return failure("INVALID_TRANSITION", "Rejected Nodes cannot start new Runs");
  }
  const goal = source.value.plan.nextGoals.filter(item => computeGoalDigest(item) === command.goalDigest);
  if (goal.length !== 1) return failure("INVARIANT_VIOLATION", "A Run must select exactly one Goal digest from its source Node");
  if (command.branch !== runBranchName(command.projectId, command.sourceNodeSha, command.runId)) {
    return failure("INVARIANT_VIOLATION", "Run branch does not match the required Node-scoped Hunsu namespace");
  }
  return ok({
    id: command.runId,
    projectId: command.projectId,
    sourceNodeSha: command.sourceNodeSha,
    goal: goal[0]!,
    goalDigest: command.goalDigest,
    runner: source.value.plan.how,
    runnerDigest: computeRunnerDigest(source.value.plan.how),
    branch: command.branch,
    checkpoints: [],
    evidenceIds: [],
    startedAt: command.meta.requestedAt,
    status: "running"
  });
}

function validateRunningRunEvent(state: ProjectState, run: RunningRun): Result<void, ProjectDomainError> {
  if (state.runs.some(candidate => candidate.id === run.id)) return duplicate("Run", run.id);
  const source = findNode(state, run.projectId, run.sourceNodeSha);
  if (!source.ok) return source;
  if (isRejectedNode(state, run.projectId, source.value.commitSha)) return failure("INVALID_TRANSITION", "Rejected Nodes cannot start new Runs");
  const goals = source.value.plan.nextGoals.filter(goal => computeGoalDigest(goal) === run.goalDigest);
  if (goals.length !== 1 || computeGoalDigest(run.goal) !== run.goalDigest) {
    return failure("INVARIANT_VIOLATION", "Run must contain exactly one Goal from its source Node");
  }
  if (computeRunnerDigest(run.runner) !== run.runnerDigest || run.runnerDigest !== computeRunnerDigest(source.value.plan.how)) {
    return failure("INVARIANT_VIOLATION", "Run must snapshot the source Node Runner Value exactly");
  }
  if (run.branch !== runBranchName(run.projectId, run.sourceNodeSha, run.id)) {
    return failure("INVARIANT_VIOLATION", "Run branch does not match the required Node-scoped Hunsu namespace");
  }
  return run.checkpoints.length === 0 && run.evidenceIds.length === 0
    ? ok(undefined)
    : failure("INVARIANT_VIOLATION", "A newly started Run cannot contain checkpoints or evidence");
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
  if (run.value.projectId !== evidence.projectId) return failure("INVARIANT_VIOLATION", "Evidence and Run must belong to the same Project");
  if (evidence.target.type === "criterion" && !run.value.goal.acceptanceCriteria.includes(evidence.target.criterion)) {
    return failure("INVARIANT_VIOLATION", "Evidence criterion must belong to the Run's single Goal snapshot");
  }
  return ok(undefined);
}

function validateVerifiedRunResult(state: ProjectState, result: VerifiedRunResult): Result<RunningRun, ProjectDomainError> {
  const run = findRunningRun(state, result.runId);
  if (!run.ok) return run;
  if (run.value.branch !== result.branch) return failure("INVARIANT_VIOLATION", "Verified result branch does not match the Run branch");
  if (run.value.sourceNodeSha === result.resultSha) return failure("INVARIANT_VIOLATION", "Run result SHA must differ from its source Node SHA");
  const covered = new Set(state.evidence
    .filter(item => item.runId === run.value.id && run.value.evidenceIds.includes(item.id) && item.target.type === "criterion")
    .map(item => item.target.type === "criterion" ? item.target.criterion : undefined));
  const missing = run.value.goal.acceptanceCriteria.filter(criterion => !covered.has(criterion));
  return missing.length === 0
    ? run
    : failure("INVARIANT_VIOLATION", `Completed Run evidence must cover every acceptance criterion; missing: ${missing.join("; ")}`);
}

function validateRunCompletion(
  state: ProjectState,
  result: VerifiedRunResult,
  node: RunChildNode,
  payload: NodePayloadEnvelope,
  recordedAt: RunningRun["startedAt"],
  integrity: ProjectIntegrityBoundary
): Result<void, ProjectDomainError> {
  const run = validateVerifiedRunResult(state, result);
  if (!run.ok) return run;
  if (node.commitSha !== result.resultSha) return failure("INVARIANT_VIOLATION", "Run child Node SHA must equal the verified result SHA");
  return validateRunChildNode(state, run.value, node, payload, recordedAt, integrity);
}

function validateRunChildNode(
  state: ProjectState,
  run: RunningRun | CompletedRun,
  node: RunChildNode,
  payload: NodePayloadEnvelope,
  recordedAt: RunningRun["startedAt"],
  integrity: ProjectIntegrityBoundary
): Result<void, ProjectDomainError> {
  if (run.status === "completed" && run.resultNodeSha !== node.commitSha) {
    return failure("INVARIANT_VIOLATION", "Registered Run child does not match its completed Run result");
  }
  if (node.projectId !== run.projectId || node.parentSha !== run.sourceNodeSha || node.runId !== run.id || node.consumedGoalDigest !== run.goalDigest) {
    return failure("INVARIANT_VIOLATION", "Run child Node must bind to its Run, source Node, and one consumed Goal");
  }
  const source = findNode(state, run.projectId, run.sourceNodeSha);
  if (!source.ok) return source;
  const inherited = inheritRunChildPlan(source.value, run.goalDigest);
  if (!inherited.ok) return inherited;
  if (computeNodePlanDigest(node.plan) !== computeNodePlanDigest(inherited.value)) {
    return failure("INVARIANT_VIOLATION", "Run child plan must inherit the Runner and remove only the consumed Goal");
  }
  return validateNewNode(state, node, payload, recordedAt, integrity);
}

function validateCoachReview(state: ProjectState, review: ProjectState["coachReviews"][number], actor: DomainActor): Result<void, ProjectDomainError> {
  if (actor.type !== "coach") return failure("INVARIANT_VIOLATION", "Coach reviews must be authored by a Coach actor");
  if (state.coachReviews.some(item => item.id === review.id)) return duplicate("Coach review", review.id);
  const project = findProject(state, review.projectId);
  if (!project.ok) return project;
  if (review.target.type === "node") return mapVoid(findNode(state, review.projectId, review.target.nodeSha));
  if (review.target.type === "run") {
    const run = findRun(state, review.target.runId);
    return run.ok && run.value.projectId === review.projectId ? ok(undefined) : run.ok ? failure("INVARIANT_VIOLATION", "Review target belongs to another Project") : run;
  }
  const comparisonId = review.target.comparisonId;
  const comparison = state.comparisons.find(item => item.id === comparisonId);
  if (!comparison) return notFound("Comparison", comparisonId);
  return comparison.projectId === review.projectId ? ok(undefined) : failure("INVARIANT_VIOLATION", "Review target belongs to another Project");
}

function validateCoachingProposal(state: ProjectState, proposal: CoachingProposal, actor: DomainActor): Result<void, ProjectDomainError> {
  if (actor.type !== "coach") return failure("INVARIANT_VIOLATION", "Coaching proposals must be authored by a Coach actor");
  if (state.coachingProposals.some(item => item.id === proposal.id)) return duplicate("Coaching proposal", proposal.id);
  const source = findNode(state, proposal.projectId, proposal.sourceNodeSha);
  if (!source.ok) return source;
  if (isRejectedNode(state, proposal.projectId, source.value.commitSha)) return failure("INVALID_TRANSITION", "Rejected Nodes cannot be coached");
  if (source.value.payloadDigest !== proposal.sourcePayloadDigest
    || computeNodePayloadDigest(nodePayloadFor(source.value)) !== proposal.sourcePayloadDigest
  ) {
    return failure("INVARIANT_VIOLATION", "Coaching proposal source payload digest does not match the source Node");
  }
  if (source.value.planDigest !== proposal.sourcePlanDigest || computeNodePlanDigest(source.value.plan) !== proposal.sourcePlanDigest) {
    return failure("INVARIANT_VIOLATION", "Coaching proposal source digest does not match the source Node plan");
  }
  const proposed = validatePlan(proposal.proposedPlan);
  if (!proposed.ok) return proposed;
  if (computeNodePlanDigest(proposal.proposedPlan) !== proposal.proposedPlanDigest) {
    return failure("INVARIANT_VIOLATION", "Coaching proposal digest does not match its proposed plan");
  }
  return proposal.proposedPlanDigest === proposal.sourcePlanDigest
    ? failure("INVARIANT_VIOLATION", "Coaching proposal must change the Node plan")
    : ok(undefined);
}

function validateCoachingProposalCommand(
  state: ProjectState,
  proposal: CoachingProposal,
  meta: CommandMetadata
): Result<void, ProjectDomainError> {
  if (proposal.expectedStateSha !== meta.expectedStateSha) {
    return failure("INVARIANT_VIOLATION", "Coaching proposal expected state SHA must match its command CAS boundary");
  }
  return validateCoachingProposal(state, proposal, meta.actor);
}

function buildCoachingConfirmation(
  state: ProjectState,
  command: Extract<ProjectCommand, { type: "ConfirmCoachingProposal" }>,
  integrity: ProjectIntegrityBoundary
): Result<Extract<CoachingProposalDecision, { status: "confirmed" }>, ProjectDomainError> {
  const proposal = findConfirmableCoachingProposal(state, command.proposalId, command.meta.actor);
  if (!proposal.ok) return proposal;
  const decision = validateDecisionId(state, command.decisionId);
  if (!decision.ok) return decision;
  const node = validateCoachingChild(state, proposal.value, command.node, command.payload, command.meta.requestedAt, integrity);
  if (!node.ok) return node;
  return ok({
    status: "confirmed",
    id: command.decisionId,
    proposalId: command.proposalId,
    childNodeSha: command.node.commitSha,
    reason: command.reason,
    decidedAt: command.meta.requestedAt
  });
}

function buildCoachingRejection(
  state: ProjectState,
  command: Extract<ProjectCommand, { type: "RejectCoachingProposal" }>
): Result<Extract<CoachingProposalDecision, { status: "rejected" }>, ProjectDomainError> {
  const proposal = findOpenCoachingProposal(state, command.proposalId, command.meta.actor);
  if (!proposal.ok) return proposal;
  const decision = validateDecisionId(state, command.decisionId);
  if (!decision.ok) return decision;
  return ok({
    status: "rejected",
    id: command.decisionId,
    proposalId: command.proposalId,
    reason: command.reason,
    decidedAt: command.meta.requestedAt
  });
}

function validateCoachingChildEvent(
  state: ProjectState,
  node: CoachingChildNode,
  payload: NodePayloadEnvelope,
  recordedAt: EventMetadata["recordedAt"],
  integrity: ProjectIntegrityBoundary
): Result<void, ProjectDomainError> {
  const proposal = state.coachingProposals.find(item => item.id === node.proposalId);
  if (!proposal) return notFound("Coaching proposal", node.proposalId);
  const decision = state.coachingProposalDecisions.find(item => item.proposalId === node.proposalId);
  if (!decision || decision.status !== "confirmed" || decision.childNodeSha !== node.commitSha) {
    return failure("INVALID_TRANSITION", "Coaching child registration requires its confirmed proposal decision");
  }
  return validateCoachingChild(state, proposal, node, payload, recordedAt, integrity);
}

function validateCoachingChild(
  state: ProjectState,
  proposal: CoachingProposal,
  node: CoachingChildNode,
  payload: NodePayloadEnvelope,
  recordedAt: EventMetadata["recordedAt"],
  integrity: ProjectIntegrityBoundary
): Result<void, ProjectDomainError> {
  const source = findNode(state, proposal.projectId, proposal.sourceNodeSha);
  if (!source.ok) return source;
  if (node.projectId !== proposal.projectId || node.parentSha !== proposal.sourceNodeSha || node.proposalId !== proposal.id) {
    return failure("INVARIANT_VIOLATION", "Coaching child Node must bind to the confirmed proposal and source Node");
  }
  if (node.treeSha !== source.value.treeSha) {
    return failure("INVARIANT_VIOLATION", "Coaching child commit must preserve the source tree SHA");
  }
  if (computeNodePlanDigest(node.plan) !== proposal.proposedPlanDigest) {
    return failure("INVARIANT_VIOLATION", "Coaching child plan must exactly match the confirmed proposal");
  }
  return validateNewNode(state, node, payload, recordedAt, integrity);
}

function findOpenCoachingProposal(state: ProjectState, proposalId: CoachingProposal["id"], actor: DomainActor): Result<CoachingProposal, ProjectDomainError> {
  if (actor.type !== "user") return failure("USER_CONFIRMATION_REQUIRED", "Coaching proposal disposition requires explicit user confirmation");
  const proposal = state.coachingProposals.find(item => item.id === proposalId);
  if (!proposal) return notFound("Coaching proposal", proposalId);
  return state.coachingProposalDecisions.some(item => item.proposalId === proposalId)
    ? failure("INVALID_TRANSITION", "Coaching proposal already has a disposition")
    : ok(proposal);
}

function findConfirmableCoachingProposal(
  state: ProjectState,
  proposalId: CoachingProposal["id"],
  actor: DomainActor
): Result<CoachingProposal, ProjectDomainError> {
  const proposal = findOpenCoachingProposal(state, proposalId, actor);
  if (!proposal.ok) return proposal;
  return isRejectedNode(state, proposal.value.projectId, proposal.value.sourceNodeSha)
    ? failure("INVALID_TRANSITION", "Rejected Nodes cannot be coached")
    : proposal;
}

function buildComparison(state: ProjectState, command: CompareAlternativesCommand): Result<AlternativeComparison, ProjectDomainError> {
  if (state.comparisons.some(item => item.id === command.comparisonId)) return duplicate("Comparison", command.comparisonId);
  const candidates = resolveCompletedRunCandidates(state, command.projectId, command.nodeShas);
  if (!candidates.ok) return candidates;
  const findings = validateComparisonFindings(command.nodeShas, command.findings);
  if (!findings.ok) return findings;
  switch (command.comparisonType) {
    case "sibling_runs": {
      const parentNodeSha = candidates.value[0]!.node.parentSha;
      if (!candidates.value.every(candidate => candidate.node.parentSha === parentNodeSha)) {
        return failure("INVARIANT_VIOLATION", "Compared sibling Run alternatives must have one shared parent");
      }
      const comparison: AlternativeComparison = {
        type: "sibling_runs",
        id: command.comparisonId,
        projectId: command.projectId,
        parentNodeSha,
        nodeShas: command.nodeShas,
        findings: command.findings,
        summary: command.summary,
        recordedAt: command.meta.requestedAt
      };
      const overlap = validateComparisonCohortOverlap(state, comparison);
      return overlap.ok ? ok(comparison) : overlap;
    }
    case "coached_how_experiment": {
      const goalDigest = validateCoachedHowExperimentCandidates(state, command.projectId, command.anchorNodeSha, candidates.value);
      if (!goalDigest.ok) return goalDigest;
      const comparison: AlternativeComparison = {
        type: "coached_how_experiment",
        id: command.comparisonId,
        projectId: command.projectId,
        anchorNodeSha: command.anchorNodeSha,
        goalDigest: goalDigest.value,
        nodeShas: command.nodeShas,
        findings: command.findings,
        summary: command.summary,
        recordedAt: command.meta.requestedAt
      };
      const overlap = validateComparisonCohortOverlap(state, comparison);
      return overlap.ok ? ok(comparison) : overlap;
    }
    default: {
      const exhaustive: never = command;
      return exhaustive;
    }
  }
}

function validateComparison(state: ProjectState, comparison: AlternativeComparison): Result<void, ProjectDomainError> {
  if (state.comparisons.some(item => item.id === comparison.id)) return duplicate("Comparison", comparison.id);
  const candidates = resolveCompletedRunCandidates(state, comparison.projectId, comparison.nodeShas);
  if (!candidates.ok) return candidates;
  const findings = validateComparisonFindings(comparison.nodeShas, comparison.findings);
  if (!findings.ok) return findings;
  switch (comparison.type) {
    case "sibling_runs":
      if (!candidates.value.every(candidate => candidate.node.parentSha === comparison.parentNodeSha)) {
        return failure("INVARIANT_VIOLATION", "Sibling Run comparison must contain completed result Nodes under its declared parent");
      }
      return validateComparisonCohortOverlap(state, comparison);
    case "coached_how_experiment": {
      const goalDigest = validateCoachedHowExperimentCandidates(state, comparison.projectId, comparison.anchorNodeSha, candidates.value);
      if (!goalDigest.ok) return goalDigest;
      if (goalDigest.value !== comparison.goalDigest) {
        return failure("INVARIANT_VIOLATION", "Coached How experiment Goal digest does not match its completed Runs");
      }
      return validateComparisonCohortOverlap(state, comparison);
    }
    default: {
      const exhaustive: never = comparison;
      return exhaustive;
    }
  }
}

type CompletedRunComparisonCandidate = {
  readonly node: RunChildNode;
  readonly run: CompletedRun;
  readonly source: Node;
};

function resolveCompletedRunCandidates(
  state: ProjectState,
  projectId: Project["id"],
  nodeShas: readonly GitCommitSha[]
): Result<readonly CompletedRunComparisonCandidate[], ProjectDomainError> {
  if (nodeShas.length < 2) return failure("INVARIANT_VIOLATION", "An alternative comparison requires at least two result Nodes");
  if (new Set(nodeShas).size !== nodeShas.length) return failure("INVARIANT_VIOLATION", "Comparison Node SHAs must be unique");
  const candidates: CompletedRunComparisonCandidate[] = [];
  for (const nodeSha of nodeShas) {
    const node = findNode(state, projectId, nodeSha);
    if (!node.ok) return node;
    if (node.value.type !== "run_child") {
      return failure("INVARIANT_VIOLATION", "Only completed Run result Nodes can be compared as alternatives");
    }
    const run = findCompletedRun(state, node.value.runId);
    if (!run.ok) return run;
    if (run.value.projectId !== projectId
      || run.value.sourceNodeSha !== node.value.parentSha
      || run.value.resultNodeSha !== node.value.commitSha
      || run.value.goalDigest !== node.value.consumedGoalDigest
    ) {
      return failure("INVARIANT_VIOLATION", "Comparison candidate must bind an actual completed Run to its source and result Node");
    }
    const source = findNode(state, projectId, run.value.sourceNodeSha);
    if (!source.ok) return source;
    const matchingGoals = source.value.plan.nextGoals.filter(goal => computeGoalDigest(goal) === run.value.goalDigest);
    if (matchingGoals.length !== 1 || computeGoalDigest(run.value.goal) !== run.value.goalDigest) {
      return failure("INVARIANT_VIOLATION", "Comparison candidate Run must bind one canonical Goal from its source Node");
    }
    if (run.value.runnerDigest !== computeRunnerDigest(run.value.runner)
      || run.value.runnerDigest !== computeRunnerDigest(source.value.plan.how)
    ) {
      return failure("INVARIANT_VIOLATION", "Comparison candidate Run must bind the exact How from its source Node");
    }
    candidates.push({ node: node.value, run: run.value, source: source.value });
  }
  return ok(candidates);
}

function validateCoachedHowExperimentCandidates(
  state: ProjectState,
  projectId: Project["id"],
  anchorNodeSha: GitCommitSha,
  candidates: readonly CompletedRunComparisonCandidate[]
): Result<GoalDigest, ProjectDomainError> {
  const anchor = findNode(state, projectId, anchorNodeSha);
  if (!anchor.ok) return anchor;
  const sourceShas = candidates.map(candidate => candidate.source.commitSha);
  if (new Set(sourceShas).size !== sourceShas.length) {
    return failure("INVARIANT_VIOLATION", "A Coached How experiment requires one completed Run result per distinct source Node");
  }
  const goalDigest = candidates[0]!.run.goalDigest;
  if (!candidates.every(candidate => candidate.run.goalDigest === goalDigest)) {
    return failure("INVARIANT_VIOLATION", "Coached How experiment Runs must digest the same canonical Goal");
  }
  const anchorPlanDigest = computeNodePlanDigest(anchor.value.plan);
  if (anchor.value.planDigest !== anchorPlanDigest) {
    return failure("INVARIANT_VIOLATION", "Coached How experiment anchor must have a valid canonical Node Plan digest");
  }
  for (const candidate of candidates) {
    const source = candidate.source;
    const sourcePlanDigest = computeNodePlanDigest(source.plan);
    if (source.planDigest !== sourcePlanDigest) {
      return failure("INVARIANT_VIOLATION", "Coached How experiment source must have a valid canonical Node Plan digest");
    }
    if (source.commitSha !== anchor.value.commitSha) {
      if (source.type !== "coaching_child" || source.parentSha !== anchor.value.commitSha) {
        return failure("INVARIANT_VIOLATION", "Coached How experiment sources must be the anchor or its direct Coaching children");
      }
      if (source.treeSha !== anchor.value.treeSha) {
        return failure("INVARIANT_VIOLATION", "Coached How experiment source must preserve the anchor tree SHA");
      }
      const proposal = state.coachingProposals.find(item => item.projectId === projectId && item.id === source.proposalId);
      const decision = state.coachingProposalDecisions.find(item => item.status === "confirmed"
        && item.proposalId === source.proposalId
        && item.childNodeSha === source.commitSha);
      if (!proposal || !decision
        || proposal.sourceNodeSha !== anchor.value.commitSha
        || proposal.proposedPlanDigest !== sourcePlanDigest
        || computeNodePlanDigest(proposal.proposedPlan) !== proposal.proposedPlanDigest
      ) {
        return failure("INVARIANT_VIOLATION", "Coached How experiment source must come from a directly confirmed Coaching proposal");
      }
    }
    const planWithAnchorHow: NodePlan = {
      schema: source.plan.schema,
      nextGoals: source.plan.nextGoals,
      how: anchor.value.plan.how
    };
    if (computeNodePlanDigest(planWithAnchorHow) !== anchorPlanDigest) {
      return failure("INVARIANT_VIOLATION", "Coached How experiment source plans must be byte-identical except for How");
    }
  }
  return ok(goalDigest);
}

function validateComparisonFindings(
  nodeShas: readonly GitCommitSha[],
  findings: AlternativeComparison["findings"]
): Result<void, ProjectDomainError> {
  for (const finding of findings) {
    const summaryShas = finding.summaries.map(item => item.nodeSha);
    if (summaryShas.length !== nodeShas.length
      || new Set(summaryShas).size !== summaryShas.length
      || nodeShas.some(sha => !summaryShas.includes(sha))
    ) {
      return failure("INVARIANT_VIOLATION", "Every comparison finding must summarize every included result Node exactly once");
    }
  }
  return ok(undefined);
}

function validateComparisonCohortOverlap(
  state: ProjectState,
  comparison: AlternativeComparison
): Result<void, ProjectDomainError> {
  const cohortKey = comparisonCohortKey(comparison);
  for (const existing of state.comparisons) {
    if (existing.projectId !== comparison.projectId) continue;
    const overlaps = existing.nodeShas.some(nodeSha => comparison.nodeShas.includes(nodeSha));
    if (overlaps && comparisonCohortKey(existing) !== cohortKey) {
      return failure("INVARIANT_VIOLATION", "Overlapping alternative comparisons must use the same explicit cohort key");
    }
  }
  return ok(undefined);
}

function comparisonCohortKey(comparison: AlternativeComparison): string {
  switch (comparison.type) {
    case "sibling_runs":
      return `${comparison.type}:${comparison.projectId}:${comparison.parentNodeSha}`;
    case "coached_how_experiment":
      return `${comparison.type}:${comparison.projectId}:${comparison.anchorNodeSha}:${comparison.goalDigest}`;
    default: {
      const exhaustive: never = comparison;
      return exhaustive;
    }
  }
}

function buildSelection(state: ProjectState, command: Extract<ProjectCommand, { type: "SelectAlternative" }>): Result<SelectionDecision, ProjectDomainError> {
  const decision: SelectionDecision = {
    type: "selection",
    id: command.decisionId,
    projectId: command.projectId,
    comparisonId: command.comparisonId,
    selectedNodeSha: command.selectedNodeSha,
    rationale: command.rationale,
    decidedAt: command.meta.requestedAt
  };
  const valid = validateSelectionDecision(state, decision, command.meta.actor);
  return valid.ok ? ok(decision) : valid;
}

function validateSelectionDecision(state: ProjectState, decision: SelectionDecision, actor: DomainActor): Result<void, ProjectDomainError> {
  if (actor.type !== "user") return failure("USER_CONFIRMATION_REQUIRED", "Alternative selection requires explicit user confirmation");
  const id = validateDecisionId(state, decision.id);
  if (!id.ok) return id;
  const comparison = state.comparisons.find(item => item.projectId === decision.projectId && item.id === decision.comparisonId);
  if (!comparison) return notFound("Comparison", decision.comparisonId);
  if (!comparison.nodeShas.includes(decision.selectedNodeSha)) return failure("INVARIANT_VIOLATION", "Selected Node was not part of the comparison");
  if (isRejectedNode(state, decision.projectId, decision.selectedNodeSha)) return failure("INVALID_TRANSITION", "Rejected Node cannot be selected");
  const cohortKey = comparisonCohortKey(comparison);
  const cohortSelections = state.decisions.filter((item): item is SelectionDecision => item.type === "selection" && item.projectId === decision.projectId).filter(item => {
    const prior = state.comparisons.find(comparisonItem => comparisonItem.projectId === decision.projectId && comparisonItem.id === item.comparisonId);
    return prior !== undefined && comparisonCohortKey(prior) === cohortKey;
  });
  return cohortSelections.length === 0
    ? ok(undefined)
    : failure("INVALID_TRANSITION", "Alternative cohort already has a selected future");
}

function buildRejection(state: ProjectState, command: Extract<ProjectCommand, { type: "RejectAlternatives" }>): Result<RejectionDecision, ProjectDomainError> {
  const decision: RejectionDecision = {
    type: "rejection",
    id: command.decisionId,
    projectId: command.projectId,
    comparisonId: command.comparisonId,
    rejectedNodeShas: command.rejectedNodeShas,
    rationale: command.rationale,
    decidedAt: command.meta.requestedAt
  };
  const valid = validateRejectionDecision(state, decision, command.meta.actor);
  return valid.ok ? ok(decision) : valid;
}

function validateRejectionDecision(state: ProjectState, decision: RejectionDecision, actor: DomainActor): Result<void, ProjectDomainError> {
  if (actor.type !== "user") return failure("USER_CONFIRMATION_REQUIRED", "Alternative rejection requires explicit user confirmation");
  const id = validateDecisionId(state, decision.id);
  if (!id.ok) return id;
  const comparison = state.comparisons.find(item => item.projectId === decision.projectId && item.id === decision.comparisonId);
  if (!comparison) return notFound("Comparison", decision.comparisonId);
  if (new Set(decision.rejectedNodeShas).size !== decision.rejectedNodeShas.length) return failure("INVARIANT_VIOLATION", "Rejected Node SHAs must be unique");
  if (decision.rejectedNodeShas.some(sha => !comparison.nodeShas.includes(sha))) return failure("INVARIANT_VIOLATION", "Rejected Node was not part of the comparison");
  const selected = new Set(state.decisions.flatMap(item => item.type === "selection" && item.projectId === decision.projectId ? [item.selectedNodeSha] : []));
  if (decision.rejectedNodeShas.some(sha => selected.has(sha))) return failure("INVALID_TRANSITION", "Selected Node cannot be rejected");
  if (decision.rejectedNodeShas.some(sha => isRejectedNode(state, decision.projectId, sha))) return failure("INVALID_TRANSITION", "Node is already rejected");
  return ok(undefined);
}

function validateNewNode(
  state: ProjectState,
  node: Node,
  payload: NodePayloadEnvelope,
  recordedAt: EventMetadata["recordedAt"],
  integrity: ProjectIntegrityBoundary
): Result<void, ProjectDomainError> {
  const project = findProject(state, node.projectId);
  if (!project.ok) return project;
  if (state.nodes.some(candidate => candidate.projectId === node.projectId && candidate.commitSha === node.commitSha)) return duplicate("Node", node.commitSha);
  if (node.type === "root") {
    if (state.nodes.some(candidate => candidate.projectId === node.projectId && candidate.type === "root")) return failure("INVARIANT_VIOLATION", "Project already has a root Node");
    if (node.commitSha !== project.value.rootNodeSha) return failure("INVARIANT_VIOLATION", "Root Node must match the Project root SHA");
  } else {
    if (node.parentSha === node.commitSha) return failure("INVARIANT_VIOLATION", "Node cannot be its own parent");
    const parent = findNode(state, node.projectId, node.parentSha);
    if (!parent.ok) return parent;
  }
  return validateNodeContent(node, payload, recordedAt, integrity);
}

function validateNodeContent(
  node: Node,
  payload: NodePayloadEnvelope,
  recordedAt: EventMetadata["recordedAt"],
  integrity: ProjectIntegrityBoundary
): Result<void, ProjectDomainError> {
  const plan = validatePlan(node.plan);
  if (!plan.ok) return plan;
  if (node.planDigest !== computeNodePlanDigest(node.plan)) return failure("INVARIANT_VIOLATION", "Node plan digest does not match its canonical plan");
  if (node.managedRef !== managedNodeRef(node.projectId, node.commitSha)) return failure("INVARIANT_VIOLATION", "Node managed ref does not match its Project and commit SHA");
  if (node.registeredAt !== recordedAt) return failure("INVARIANT_VIOLATION", "Node registration timestamp must match its registration event");
  const decoded = nodePayloadFor(node);
  const digest = computeNodePayloadDigest(decoded);
  if (node.payloadDigest !== digest || payload.digest !== digest) return failure("INVARIANT_VIOLATION", "Node payload digest does not match its canonical decoded payload");
  const decodedSize = canonicalUtf8ByteLength(decoded);
  if (payload.decodedSize !== decodedSize || decodedSize > MAX_NODE_PAYLOAD_DECODED_BYTES) return failure("INVARIANT_VIOLATION", "Node payload decoded size is invalid");
  if (payload.encodedSize !== payload.data.length || payload.encodedSize > MAX_NODE_PAYLOAD_ENCODED_BYTES) return failure("INVARIANT_VIOLATION", "Node payload encoded size is invalid");
  const verified = integrity.verifyNodePayload(decoded, payload);
  if (!verified.ok) return failure("INVARIANT_VIOLATION", `Node payload envelope verification failed: ${verified.error.message}`);
  return ok(undefined);
}

function validatePlan(plan: NodePlan): Result<void, ProjectDomainError> {
  if (plan.schema !== NODE_PLAN_SCHEMA) return failure("INVARIANT_VIOLATION", "Node plan schema must be hunsu.node-plan.v1");
  const keys = plan.nextGoals.map(goal => goal.key);
  if (new Set(keys).size !== keys.length) return failure("INVARIANT_VIOLATION", "Node Goal keys must be unique");
  const digests = plan.nextGoals.map(computeGoalDigest);
  if (new Set(digests).size !== digests.length) return failure("INVARIANT_VIOLATION", "Node Goal digests must be unique");
  for (const goal of plan.nextGoals) {
    if (goal.acceptanceCriteria.length === 0 || new Set(goal.acceptanceCriteria).size !== goal.acceptanceCriteria.length) {
      return failure("INVARIANT_VIOLATION", "Every Goal must contain unique non-empty acceptance criteria");
    }
  }
  return ok(undefined);
}

function validateDecisionId(state: ProjectState, id: CoachingProposalDecision["id"] | ProjectState["decisions"][number]["id"]): Result<void, ProjectDomainError> {
  return state.coachingProposalDecisions.some(item => item.id === id) || state.decisions.some(item => item.id === id)
    ? duplicate("Decision", id)
    : ok(undefined);
}

function validateAdditionalEventId(state: ProjectState, primary: EventId, additional: EventId): Result<void, ProjectDomainError> {
  if (primary === additional || state.processedCommands.some(item => item.eventIds.includes(additional))) return duplicate("Event", additional);
  return ok(undefined);
}

function validateEventIdentity(state: ProjectState, meta: EventMetadata): Result<void, ProjectDomainError> {
  if (state.processedCommands.some(item => item.eventIds.includes(meta.eventId))) return invalidEvent(`Event ${meta.eventId} was already applied`);
  const processed = state.processedCommands.find(item => item.idempotencyKey === meta.idempotencyKey);
  return processed && processed.fingerprint !== meta.fingerprint
    ? invalidEvent("Events sharing an idempotency key must share the same fingerprint")
    : ok(undefined);
}

function decideRetry(state: ProjectState, meta: CommandMetadata): Result<CommandDecision | undefined, ProjectDomainError> {
  const processed = state.processedCommands.find(item => item.idempotencyKey === meta.idempotencyKey);
  if (!processed) return ok(undefined);
  return processed.fingerprint === meta.fingerprint
    ? ok({ type: "reused", eventIds: processed.eventIds })
    : failure("IDEMPOTENCY_CONFLICT", "Idempotency key was already used with another command fingerprint");
}

function finish(state: ProjectState, meta: EventMetadata): ProjectState {
  const existing = state.processedCommands.find(item => item.idempotencyKey === meta.idempotencyKey);
  if (!existing) {
    const processed: ProcessedCommand = { idempotencyKey: meta.idempotencyKey, fingerprint: meta.fingerprint, eventIds: [meta.eventId] };
    return { ...state, processedCommands: [...state.processedCommands, processed] };
  }
  return {
    ...state,
    processedCommands: state.processedCommands.map(item => item.idempotencyKey === meta.idempotencyKey
      ? { ...item, eventIds: [...item.eventIds, meta.eventId] as NonEmptyArray<EventId> }
      : item)
  };
}

function eventMetadata(meta: CommandMetadata, eventId = meta.eventId): EventMetadata {
  return {
    eventId,
    idempotencyKey: meta.idempotencyKey,
    fingerprint: meta.fingerprint,
    actor: meta.actor,
    recordedAt: meta.requestedAt
  };
}

function accepted(first: DomainEvent, ...rest: DomainEvent[]): Result<CommandDecision, never> {
  return ok({ type: "accepted", events: [first, ...rest] });
}

function findProject(state: ProjectState, id: Project["id"]): Result<Project, ProjectDomainError> {
  const project = state.projects.find(item => item.id === id);
  return project ? ok(project) : notFound("Project", id);
}

function findNode(state: ProjectState, projectId: Project["id"], sha: GitCommitSha): Result<Node, ProjectDomainError> {
  const node = state.nodes.find(item => item.projectId === projectId && item.commitSha === sha);
  return node ? ok(node) : notFound("Node", `${projectId}/${sha}`);
}

function findRun(state: ProjectState, id: Run["id"]): Result<Run, ProjectDomainError> {
  const run = state.runs.find(item => item.id === id);
  return run ? ok(run) : notFound("Run", id);
}

function findRunningRun(state: ProjectState, id: Run["id"]): Result<RunningRun, ProjectDomainError> {
  const run = findRun(state, id);
  if (!run.ok) return run;
  return run.value.status === "running"
    ? ok(run.value)
    : failure("INVALID_TRANSITION", `Run ${id} is ${run.value.status}`);
}

function findCompletedRun(state: ProjectState, id: Run["id"]): Result<CompletedRun, ProjectDomainError> {
  const run = findRun(state, id);
  if (!run.ok) return run;
  return run.value.status === "completed"
    ? ok(run.value)
    : failure("INVALID_TRANSITION", `Run ${id} is ${run.value.status}`);
}

function replaceRun(runs: readonly Run[], id: Run["id"], replace: (run: RunningRun) => Run): readonly Run[] {
  return runs.map(run => run.id === id && run.status === "running" ? replace(run) : run);
}

function isRejectedNode(state: ProjectState, projectId: Project["id"], sha: GitCommitSha): boolean {
  return state.decisions.some(decision => decision.type === "rejection"
    && decision.projectId === projectId
    && decision.rejectedNodeShas.includes(sha));
}

function mapVoid<T>(result: Result<T, ProjectDomainError>): Result<void, ProjectDomainError> {
  return result.ok ? ok(undefined) : result;
}

function asInvalidEvent<T>(result: Result<T, ProjectDomainError>): Result<never, ProjectDomainError> {
  return result.ok ? invalidEvent("Unexpected valid event result") : invalidEvent(result.error.message);
}

function duplicate(kind: string, id: string): Result<never, ProjectDomainError> {
  return failure("DUPLICATE_ID", `${kind} ${id} already exists`);
}

function notFound(kind: string, id: string): Result<never, ProjectDomainError> {
  return failure("NOT_FOUND", `${kind} ${id} was not found`);
}

function invalidEvent(message: string): Result<never, ProjectDomainError> {
  return failure("INVALID_EVENT", message);
}

function failure(code: ProjectDomainErrorCode, message: string): Result<never, ProjectDomainError> {
  return err({ type: "ProjectDomainError", code, message });
}
