import type {
  AlternativeDecision,
  CompletedRun,
  DomainActor,
  DomainEvent,
  EvidenceRef,
  GoalValue,
  Node,
  Project,
  ProjectState,
  Run,
  RunnerValue
} from "@hunsu/protocol";
import type {
  ActiveRunSummaryProjection,
  DecisionSummaryProjection,
  DomainEventListItemProjection,
  EvidenceSummaryProjection,
  GraphEdgeProjection,
  GraphNodeStatusProjection,
  GraphNodeSummaryProjection,
  NodeDetailProjection,
  ProjectGraphProjection,
  ProjectIntegrityProjection,
  ProjectListItemProjection,
  ProjectSummaryProjection,
  ProjectionContext,
  RunDetailProjection,
  SequencedDomainEvent
} from "./types.ts";

export type ProjectionError = {
  readonly code: "project_not_found" | "node_not_found" | "run_not_found" | "event_not_found" | "integrity_error";
  readonly message: string;
};

export type ProjectionResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ProjectionError };

export function projectListProjection(
  entries: readonly { state: ProjectState; context: ProjectionContext }[]
): ProjectListItemProjection[] {
  return entries.flatMap(({ state, context }) => state.projects.map(project => {
    const integrity = graphIntegrity(state, project);
    return {
      ...projectSummary(project, context),
      nodeCount: projectNodes(state, project.id).length,
      activeRunCount: projectRuns(state, project.id).filter(run => run.status === "running").length,
      unresolvedDivergenceCount: unresolvedDivergenceCount(state, project.id),
      integrity,
      synchronizedAt: context.synchronizedAt
    };
  }));
}

export function projectGraphProjection(
  state: ProjectState,
  projectId: string,
  context: ProjectionContext,
  options: { readonly limit: number; readonly cursor: string | null }
): ProjectionResult<ProjectGraphProjection> {
  const project = state.projects.find(candidate => candidate.id === projectId);
  if (!project) return failure("project_not_found", `Project ${projectId} was not found.`);
  const integrity = graphIntegrity(state, project);
  const ordered = integrity.status === "valid"
    ? graphOrder(state, project)
    : projectNodes(state, project.id).sort((left, right) => left.registeredAt.localeCompare(right.registeredAt) || left.commitSha.localeCompare(right.commitSha));
  const offset = decodeCursor(options.cursor, ordered.length);
  if (!offset.ok) return offset;
  const limit = Math.max(1, Math.min(300, Math.trunc(options.limit)));
  const windowNodes = ordered.slice(offset.value, offset.value + limit);
  const visible = new Set(windowNodes.map(node => String(node.commitSha)));
  const allEdges = graphEdges(state, project.id);
  const hasMore = offset.value + windowNodes.length < ordered.length;
  return ok({
    project: projectSummary(project, context),
    stateHeadSha: context.stateHeadSha,
    integrity,
    nodes: windowNodes.map(node => graphNode(state, node, context)),
    edges: allEdges.filter(edge => visible.has(edge.sourceSha) && visible.has(edge.targetSha)),
    activeRuns: activeRuns(state, project.id),
    window: {
      limit,
      hasMore,
      continuationCursor: hasMore ? String(offset.value + windowNodes.length) : null
    }
  });
}

export function nodeDetailProjection(
  state: ProjectState,
  projectId: string,
  nodeSha: string,
  context: ProjectionContext
): ProjectionResult<NodeDetailProjection> {
  const project = state.projects.find(candidate => candidate.id === projectId);
  if (!project) return failure("project_not_found", `Project ${projectId} was not found.`);
  const integrity = graphIntegrity(state, project);
  const node = state.nodes.find(candidate => candidate.projectId === project.id && candidate.commitSha === nodeSha);
  if (!node) return failure("node_not_found", `Node ${nodeSha} was not found.`);
  const edges = graphEdges(state, project.id);
  const nodeRuns = state.runs.filter(run => run.projectId === project.id && run.sourceNodeSha === node.commitSha);
  const relevantRunIds = new Set(nodeRuns.map(run => String(run.id)));
  const evidence = state.evidence
    .filter(item => item.projectId === project.id && relevantRunIds.has(String(item.runId)))
    .map(item => evidenceProjection(state, item));
  const comparisons = state.comparisons
    .filter(item => item.projectId === project.id && (item.parentNodeSha === node.commitSha || item.nodeShas.includes(node.commitSha)))
    .map(item => ({
      id: String(item.id),
      summary: String(item.summary),
      siblingNodeShas: item.nodeShas.map(String),
      recordedAt: String(item.recordedAt)
    }));
  return ok({
    sha: String(node.commitSha),
    title: String(node.commitTitle),
    commitUrl: `https://github.com/${project.repository.owner}/${project.repository.name}/commit/${node.commitSha}`,
    treeSha: String(node.treeSha),
    managedRef: String(node.managedRef),
    integrity,
    status: nodeStatus(state, node),
    lineage: node.type === "root"
      ? { kind: "root" }
      : node.type === "run_child"
        ? { kind: "run_child", parentSha: String(node.parentSha), runId: String(node.runId), goalDigest: String(node.consumedGoalDigest) }
        : { kind: "coaching_child", parentSha: String(node.parentSha), proposalId: String(node.proposalId) },
    plan: {
      schema: "hunsu.node-plan.v1",
      nextGoals: node.plan.nextGoals.map(goal => goalProjection(goal, context)),
      how: runnerProjection(node.plan.how, context)
    },
    outgoingEdges: edges.filter(edge => edge.sourceSha === nodeSha),
    activeRuns: activeRuns(state, project.id).filter(run => run.sourceNodeSha === nodeSha),
    evidence,
    comparisons,
    decisions: decisionsForNode(state, node.projectId, node.commitSha)
  });
}

export function runDetailProjection(state: ProjectState, projectId: string, runId: string): ProjectionResult<RunDetailProjection> {
  if (!state.projects.some(project => project.id === projectId)) {
    return failure("project_not_found", `Project ${projectId} was not found.`);
  }
  const run = state.runs.find(candidate => candidate.projectId === projectId && candidate.id === runId);
  if (!run) return failure("run_not_found", `Run ${runId} was not found.`);
  const source = state.nodes.find(node => node.projectId === projectId && node.commitSha === run.sourceNodeSha);
  if (!source) return failure("integrity_error", `Run ${runId} references a missing source Node.`);
  return ok({
    run,
    evidence: state.evidence.filter(item => item.runId === run.id),
    sourceNodeTitle: String(source.commitTitle)
  });
}

export function eventListProjection(
  state: ProjectState,
  events: readonly SequencedDomainEvent[]
): readonly DomainEventListItemProjection[] {
  return events.map(entry => ({
    sequence: entry.sequence,
    id: String(entry.event.meta.eventId),
    type: entry.event.type,
    summary: eventSummary(entry.event),
    actor: actorProjection(entry.actor),
    occurredAt: String(entry.event.meta.recordedAt),
    reference: eventReference(state, entry.event)
  }));
}

function projectSummary(project: Project, context: ProjectionContext): ProjectSummaryProjection {
  return {
    id: String(project.id),
    title: String(project.title),
    repository: {
      owner: String(project.repository.owner),
      name: String(project.repository.name),
      url: `https://github.com/${project.repository.owner}/${project.repository.name}`,
      defaultBranch: context.defaultBranch
    },
    rootNodeSha: String(project.rootNodeSha)
  };
}

function graphNode(state: ProjectState, node: Node, context: ProjectionContext): GraphNodeSummaryProjection {
  return {
    sha: String(node.commitSha),
    title: String(node.commitTitle),
    status: nodeStatus(state, node),
    runner: runnerSummary(node.plan.how, context),
    nextGoalCount: node.plan.nextGoals.length,
    integrity: "valid"
  };
}

function runnerSummary(runner: RunnerValue, context: ProjectionContext) {
  return {
    name: String(runner.name),
    typeKey: String(runner.type.key),
    schemaVersion: String(runner.type.schemaVersion),
    digest: context.digestRunner(runner)
  };
}

function runnerProjection(runner: RunnerValue, context: ProjectionContext) {
  return {
    schema: "hunsu.runner-value.v1" as const,
    ...runnerSummary(runner, context),
    type: {
      origin: String(runner.type.origin),
      key: String(runner.type.key),
      schemaVersion: String(runner.type.schemaVersion),
      integrity: String(runner.type.integrity)
    },
    value: runner.value
  };
}

function goalProjection(goal: GoalValue, context: ProjectionContext) {
  return {
    digest: context.digestGoal(goal),
    key: String(goal.key),
    title: String(goal.title),
    desiredOutcome: String(goal.desiredOutcome),
    acceptanceCriteria: goal.acceptanceCriteria.map(String),
    constraints: goal.constraints.map(String),
    priority: Number(goal.priority)
  };
}

function graphEdges(state: ProjectState, projectId: string): GraphEdgeProjection[] {
  const edges: GraphEdgeProjection[] = [];
  for (const node of projectNodes(state, projectId)) {
    if (node.type === "root") continue;
    if (node.type === "run_child") {
      const run = state.runs.find(candidate => candidate.id === node.runId && candidate.status === "completed");
      if (!run || run.status !== "completed") continue;
      edges.push({
        kind: "run",
        id: `run:${run.id}`,
        sourceSha: String(node.parentSha),
        targetSha: String(node.commitSha),
        runId: String(run.id),
        goal: { digest: String(run.goalDigest), title: String(run.goal.title) },
        completedAt: String(run.completedAt)
      });
      continue;
    }
    const proposal = state.coachingProposals.find(candidate => candidate.id === node.proposalId);
    const decision = state.coachingProposalDecisions.find(candidate => candidate.proposalId === node.proposalId && candidate.status === "confirmed");
    if (!proposal || !decision || decision.status !== "confirmed") continue;
    edges.push({
      kind: "coaching",
      id: `coaching:${node.proposalId}`,
      sourceSha: String(node.parentSha),
      targetSha: String(node.commitSha),
      proposalId: String(node.proposalId),
      summary: String(proposal.reason),
      confirmedAt: String(decision.decidedAt)
    });
  }
  return edges;
}

function activeRuns(state: ProjectState, projectId: string): ActiveRunSummaryProjection[] {
  return state.runs.flatMap(run => run.projectId === projectId && run.status === "running" ? [{
    id: String(run.id),
    sourceNodeSha: String(run.sourceNodeSha),
    goalDigest: String(run.goalDigest),
    goalTitle: String(run.goal.title),
    runnerName: String(run.runner.name),
    startedAt: String(run.startedAt)
  }] : []);
}

function graphIntegrity(state: ProjectState, project: Project): ProjectIntegrityProjection {
  const nodes = projectNodes(state, project.id);
  const roots = nodes.filter(node => node.type === "root");
  if (roots.length !== 1 || roots[0]?.commitSha !== project.rootNodeSha) {
    return invalidIntegrity("root_count", "The Project must contain exactly one registered root Node matching rootNodeSha.");
  }
  const shas = new Set<string>();
  for (const node of nodes) {
    const sha = String(node.commitSha);
    if (shas.has(sha)) return invalidIntegrity("duplicate_node", `Node ${sha} is registered more than once.`);
    shas.add(sha);
  }
  for (const node of nodes) {
    if (node.type === "root") continue;
    if (node.parentSha === node.commitSha) return invalidIntegrity("self_edge", `Node ${node.commitSha} points to itself.`);
    if (!shas.has(String(node.parentSha))) return invalidIntegrity("missing_parent", `Node ${node.commitSha} has a missing structural parent.`);
    const seen = new Set<string>([String(node.commitSha)]);
    let cursor: Node | undefined = node;
    while (cursor && cursor.type !== "root") {
      const parentSha = String(cursor.parentSha);
      if (seen.has(parentSha)) return invalidIntegrity("cycle", `Node ${node.commitSha} participates in a structural cycle.`);
      seen.add(parentSha);
      const parent: Node["commitSha"] = cursor.parentSha;
      cursor = nodes.find(candidate => candidate.commitSha === parent);
    }
  }
  for (const run of state.runs.filter((candidate): candidate is CompletedRun => candidate.projectId === project.id && candidate.status === "completed")) {
    const result = nodes.find(node => node.commitSha === run.resultNodeSha);
    if (!result || result.type !== "run_child" || result.runId !== run.id || result.parentSha !== run.sourceNodeSha) {
      return invalidIntegrity("run_edge", `Completed Run ${run.id} does not have one matching Run child Node.`);
    }
  }
  return { status: "valid" };
}

function graphOrder(state: ProjectState, project: Project): Node[] {
  const nodes = projectNodes(state, project.id);
  const children = new Map<string, Node[]>();
  for (const node of nodes) {
    if (node.type === "root") continue;
    const siblings = children.get(String(node.parentSha)) ?? [];
    siblings.push(node);
    children.set(String(node.parentSha), siblings);
  }
  for (const siblings of children.values()) {
    siblings.sort((left, right) => left.registeredAt.localeCompare(right.registeredAt) || left.commitSha.localeCompare(right.commitSha));
  }
  const root = nodes.find(node => node.type === "root" && node.commitSha === project.rootNodeSha);
  if (!root) return [];
  const ordered: Node[] = [];
  const pending: Node[] = [root];
  while (pending.length > 0) {
    const node = pending.shift();
    if (!node) continue;
    ordered.push(node);
    pending.push(...(children.get(String(node.commitSha)) ?? []));
  }
  return ordered;
}

function nodeStatus(state: ProjectState, node: Node): GraphNodeStatusProjection {
  if (isRejectedNode(state, node.projectId, node.commitSha)) return "rejected";
  if (projectDecisions(state, node.projectId).some(decision => decision.type === "selection" && decision.selectedNodeSha === node.commitSha)) return "selected";
  if (node.type === "root" && projectNodes(state, node.projectId).length === 1) return "current";
  return "available";
}

function isRejectedNode(state: ProjectState, projectId: Project["id"] | string, sha: Node["commitSha"]): boolean {
  return projectDecisions(state, projectId).some(decision => decision.type === "rejection" && decision.rejectedNodeShas.includes(sha));
}

function unresolvedDivergenceCount(state: ProjectState, projectId: string): number {
  const byParent = new Map<string, string[]>();
  for (const node of projectNodes(state, projectId)) {
    if (node.type !== "run_child") continue;
    const siblings = byParent.get(String(node.parentSha)) ?? [];
    siblings.push(String(node.commitSha));
    byParent.set(String(node.parentSha), siblings);
  }
  let count = 0;
  const decisions = projectDecisions(state, projectId);
  const selected = new Set(decisions.flatMap(decision => decision.type === "selection" ? [String(decision.selectedNodeSha)] : []));
  const rejected = new Set(decisions.flatMap(decision => decision.type === "rejection" ? decision.rejectedNodeShas.map(String) : []));
  for (const shas of byParent.values()) {
    if (shas.length < 2) continue;
    const selectedSiblings = shas.filter(sha => selected.has(sha) && !rejected.has(sha));
    const allRejected = shas.every(sha => rejected.has(sha));
    const oneSelected = selectedSiblings.length === 1
      && shas.every(sha => sha === selectedSiblings[0] || rejected.has(sha));
    if (!allRejected && !oneSelected) count += 1;
  }
  return count;
}

function decisionsForNode(
  state: ProjectState,
  projectId: Project["id"],
  nodeSha: Node["commitSha"]
): DecisionSummaryProjection[] {
  const projected: DecisionSummaryProjection[] = [];
  for (const decision of projectDecisions(state, projectId)) {
    if (decision.type === "selection") {
      if (decision.selectedNodeSha === nodeSha) projected.push({
        kind: "selected",
        id: String(decision.id),
        nodeSha: String(nodeSha),
        reason: String(decision.rationale),
        recordedAt: String(decision.decidedAt)
      });
      continue;
    }
    if (decision.rejectedNodeShas.includes(nodeSha)) projected.push({
      kind: "rejected",
      id: String(decision.id),
      nodeSha: String(nodeSha),
      reason: String(decision.rationale),
      recordedAt: String(decision.decidedAt)
    });
  }
  return projected;
}

function projectDecisions(
  state: ProjectState,
  projectId: Project["id"] | string
): readonly AlternativeDecision[] {
  const comparisonIds = new Set(state.comparisons
    .filter(comparison => comparison.projectId === projectId)
    .map(comparison => comparison.id));
  return state.decisions.filter(decision => comparisonIds.has(decision.comparisonId));
}

function evidenceProjection(state: ProjectState, evidence: EvidenceRef): EvidenceSummaryProjection {
  const run = state.runs.find(candidate => candidate.id === evidence.runId);
  const kind = evidence.kind === "diff"
    ? "commit"
    : evidence.kind === "check"
      ? "check"
      : evidence.kind === "report"
        ? "report"
        : evidence.kind === "screenshot"
          ? "artifact"
          : "link";
  return {
    id: String(evidence.id),
    kind,
    title: String(evidence.summary),
    summary: String(evidence.summary),
    criterion: evidence.target.type === "criterion" && run
      ? { kind: "linked", goalDigest: String(run.goalDigest), criterion: String(evidence.target.criterion) }
      : { kind: "unlinked" },
    location: evidence.location.type === "url"
      ? { kind: "url", url: String(evidence.location.url) }
      : evidence.location.type === "git"
        ? { kind: "url", url: `https://github.com/${state.projects.find(project => project.id === evidence.projectId)?.repository.owner ?? ""}/${state.projects.find(project => project.id === evidence.projectId)?.repository.name ?? ""}/blob/${evidence.location.commitSha}/${evidence.location.path}` }
        : { kind: "none" },
    createdAt: String(evidence.recordedAt)
  };
}

function actorProjection(actor: DomainActor): { id: string; label: string } {
  if (actor.type === "system") return { id: "system", label: "System" };
  return { id: String(actor.id), label: actor.type === "coach" ? "Coach" : actor.type === "plugin" ? "Plugin" : "User" };
}

function eventReference(state: ProjectState, event: DomainEvent): DomainEventListItemProjection["reference"] {
  switch (event.type) {
    case "ProjectCreated": return { kind: "project" };
    case "ProjectMaterializationsRebuilt": return { kind: "project" };
    case "RootNodeRegistered":
    case "RunChildNodeRegistered":
    case "CoachingChildNodeRegistered": return { kind: "node", nodeSha: String(event.node.commitSha) };
    case "RunStarted": return runReference(event.run);
    case "RunCheckpointed": return runReferenceById(state, event.checkpoint.runId);
    case "RunEvidenceAttached": return runReferenceById(state, event.evidence.runId);
    case "RunCompleted": return runReferenceById(state, event.result.runId);
    case "RunFailed":
    case "RunCanceled": return runReferenceById(state, event.runId);
    case "CoachReviewRecorded": {
      const target = event.review.target;
      if (target.type === "node") return { kind: "node", nodeSha: String(target.nodeSha) };
      if (target.type === "run") return runReferenceById(state, target.runId);
      const comparison = state.comparisons.find(item => item.id === target.comparisonId);
      return comparison ? { kind: "node", nodeSha: String(comparison.parentNodeSha) } : { kind: "project" };
    }
    case "CoachingProposalRecorded": return { kind: "node", nodeSha: String(event.proposal.sourceNodeSha) };
    case "CoachingProposalConfirmed": return { kind: "node", nodeSha: String(event.decision.childNodeSha) };
    case "CoachingProposalRejected": {
      const proposal = state.coachingProposals.find(item => item.id === event.decision.proposalId);
      return proposal ? { kind: "node", nodeSha: String(proposal.sourceNodeSha) } : { kind: "project" };
    }
    case "AlternativesCompared": return { kind: "node", nodeSha: String(event.comparison.parentNodeSha) };
    case "AlternativeSelected": return { kind: "node", nodeSha: String(event.decision.selectedNodeSha) };
    case "AlternativesRejected": return { kind: "node", nodeSha: String(event.decision.rejectedNodeShas[0]) };
  }
}

function runReference(run: Run): DomainEventListItemProjection["reference"] {
  return {
    kind: "run",
    runId: String(run.id),
    sourceNodeSha: String(run.sourceNodeSha),
    target: run.status === "completed"
      ? { kind: "registered", nodeSha: String(run.resultNodeSha) }
      : { kind: "pending" }
  };
}

function runReferenceById(state: ProjectState, runId: Run["id"]): DomainEventListItemProjection["reference"] {
  const run = state.runs.find(candidate => candidate.id === runId);
  return run ? runReference(run) : { kind: "project" };
}

function eventSummary(event: DomainEvent): string {
  switch (event.type) {
    case "ProjectCreated": return `Created Project ${event.project.title}`;
    case "ProjectMaterializationsRebuilt": return `Rebuilt Project ${event.projectId} materializations`;
    case "RootNodeRegistered": return `Registered root Node ${shortSha(event.node.commitSha)}`;
    case "RunStarted": return `Started Run ${event.run.id} for ${event.run.goal.title}`;
    case "RunCheckpointed": return `Recorded checkpoint for Run ${event.checkpoint.runId}`;
    case "RunEvidenceAttached": return `Attached evidence to Run ${event.evidence.runId}`;
    case "RunCompleted": return `Completed Run ${event.result.runId}`;
    case "RunChildNodeRegistered": return `Registered Run child Node ${shortSha(event.node.commitSha)}`;
    case "RunFailed": return `Failed Run ${event.runId}`;
    case "RunCanceled": return `Canceled Run ${event.runId}`;
    case "CoachReviewRecorded": return `Recorded Coach review ${event.review.id}`;
    case "CoachingProposalRecorded": return `Proposed Coaching transition ${event.proposal.id}`;
    case "CoachingProposalConfirmed": return `Confirmed Coaching transition ${event.decision.proposalId}`;
    case "CoachingChildNodeRegistered": return `Registered Coaching child Node ${shortSha(event.node.commitSha)}`;
    case "CoachingProposalRejected": return `Rejected Coaching transition ${event.decision.proposalId}`;
    case "AlternativesCompared": return `Compared ${event.comparison.nodeShas.length} sibling Nodes`;
    case "AlternativeSelected": return `Selected Node ${shortSha(event.decision.selectedNodeSha)}`;
    case "AlternativesRejected": return `Rejected ${event.decision.rejectedNodeShas.length} Node alternative(s)`;
  }
}

function shortSha(value: string): string {
  return String(value).slice(0, 8);
}

function projectNodes(state: ProjectState, projectId: Project["id"] | string): Node[] {
  return state.nodes.filter(node => node.projectId === projectId);
}

function projectRuns(state: ProjectState, projectId: Project["id"] | string): Run[] {
  return state.runs.filter(run => run.projectId === projectId);
}

function decodeCursor(cursor: string | null, length: number): ProjectionResult<number> {
  if (cursor === null) return ok(0);
  if (!/^(?:0|[1-9]\d*)$/u.test(cursor)) return failure("integrity_error", "Graph continuation cursor is invalid.");
  const value = Number(cursor);
  return Number.isSafeInteger(value) && value >= 0 && value <= length
    ? ok(value)
    : failure("integrity_error", "Graph continuation cursor is outside the current projection.");
}

function invalidIntegrity(code: string, message: string): ProjectIntegrityProjection {
  return { status: "invalid", code, message };
}

function ok<T>(value: T): ProjectionResult<T> {
  return { ok: true, value };
}

function failure(code: ProjectionError["code"], message: string): ProjectionResult<never> {
  return { ok: false, error: { code, message } };
}
