import {
  DOMAIN_EVENT_TYPES,
  type ActiveRunSummary,
  type ComparisonSummary,
  type DecisionSummary,
  type DomainEventListItem,
  type DomainEventType,
  type EventDetailResponse,
  type EventReference,
  type EventsResponse,
  type EvidenceSummary,
  type GitHubRepositoryRef,
  type GoalValue,
  type GraphEdge,
  type GraphNodeStatus,
  type GraphNodeSummary,
  type NodeDetail,
  type NodeDetailResponse,
  type NodeLineage,
  type ProjectGraphResponse,
  type ProjectGraphSummary,
  type ProjectIntegrity,
  type ProjectListItem,
  type ProjectListResponse,
  type RunnerSummary,
  type RunnerValueSummary,
  type StartRunResponse
} from "./types.ts";

export type PresentationDecodeError = {
  code: "invalid_presentation_dto";
  path: string;
  message: string;
};

export type DecodeResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: PresentationDecodeError };

class DecodeFailure extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(message);
    this.path = path;
  }
}

export function decodeProjectList(value: unknown): DecodeResult<ProjectListResponse> {
  return decodeBoundary(() => {
    const dto = exactObject(value, "$", ["schema", "projects"]);
    return {
      schema: exactLiteral(dto.schema, "$.schema", "hunsu.web.project-list.v2"),
      projects: arrayOf(dto.projects, "$.projects", decodeProjectListItem)
    };
  });
}

export function decodeProjectGraph(value: unknown): DecodeResult<ProjectGraphResponse> {
  return decodeBoundary(() => {
    const dto = exactObject(value, "$", ["schema", "project", "stateHeadSha", "integrity", "nodes", "edges", "activeRuns", "window"]);
    const window = exactObject(dto.window, "$.window", ["limit", "hasMore", "continuationCursor"]);
    const limit = boundedPositiveInteger(window.limit, "$.window.limit", 300);
    const hasMore = booleanValue(window.hasMore, "$.window.hasMore");
    const continuationCursor = nullableText(window.continuationCursor, "$.window.continuationCursor");
    const nodes = arrayOf(dto.nodes, "$.nodes", decodeGraphNode);
    if (nodes.length > limit) fail("$.nodes", `Graph window contains ${nodes.length} Nodes but declares a limit of ${limit}.`);
    let decodedWindow: ProjectGraphResponse["window"];
    if (hasMore) {
      if (continuationCursor === null) fail("$.window.continuationCursor", "A truncated graph window requires a continuation cursor.");
      decodedWindow = { limit, hasMore: true, continuationCursor };
    } else {
      if (continuationCursor !== null) fail("$.window.continuationCursor", "A complete graph window cannot have a continuation cursor.");
      decodedWindow = { limit, hasMore: false, continuationCursor: null };
    }
    return {
      schema: exactLiteral(dto.schema, "$.schema", "hunsu.web.project-graph.v2"),
      project: decodeProjectSummary(dto.project, "$.project"),
      stateHeadSha: fullSha(dto.stateHeadSha, "$.stateHeadSha"),
      integrity: decodeIntegrity(dto.integrity, "$.integrity"),
      nodes,
      edges: arrayOf(dto.edges, "$.edges", decodeGraphEdge),
      activeRuns: arrayOf(dto.activeRuns, "$.activeRuns", decodeActiveRun),
      window: decodedWindow
    };
  });
}

export function decodeNodeDetail(value: unknown): DecodeResult<NodeDetailResponse> {
  return decodeBoundary(() => {
    const dto = exactObject(value, "$", ["schema", "stateHeadSha", "node"]);
    return {
      schema: exactLiteral(dto.schema, "$.schema", "hunsu.web.node-detail.v2"),
      stateHeadSha: fullSha(dto.stateHeadSha, "$.stateHeadSha"),
      node: decodeNode(dto.node, "$.node")
    };
  });
}

export function decodeStartRun(value: unknown): DecodeResult<StartRunResponse> {
  return decodeBoundary(() => {
    const dto = exactObject(value, "$", ["schema", "runId", "stateHeadSha", "synchronizedAt"]);
    return {
      schema: exactLiteral(dto.schema, "$.schema", "hunsu.web.run-started.v2"),
      runId: textValue(dto.runId, "$.runId"),
      stateHeadSha: fullSha(dto.stateHeadSha, "$.stateHeadSha"),
      synchronizedAt: timestamp(dto.synchronizedAt, "$.synchronizedAt")
    };
  });
}

export function decodeEvents(value: unknown): DecodeResult<EventsResponse> {
  return decodeBoundary(() => {
    const dto = exactObject(value, "$", ["schema", "project", "stateHeadSha", "events", "nextCursor"]);
    return {
      schema: exactLiteral(dto.schema, "$.schema", "hunsu.web.events.v2"),
      project: decodeProjectSummary(dto.project, "$.project"),
      stateHeadSha: fullSha(dto.stateHeadSha, "$.stateHeadSha"),
      events: arrayOf(dto.events, "$.events", decodeEvent),
      nextCursor: nullableText(dto.nextCursor, "$.nextCursor")
    };
  });
}

export function decodeEventDetail(value: unknown): DecodeResult<EventDetailResponse> {
  return decodeBoundary(() => {
    const dto = exactObject(value, "$", ["schema", "project", "stateHeadSha", "event"]);
    return {
      schema: exactLiteral(dto.schema, "$.schema", "hunsu.web.event-detail.v2"),
      project: decodeProjectSummary(dto.project, "$.project"),
      stateHeadSha: fullSha(dto.stateHeadSha, "$.stateHeadSha"),
      event: decodeEvent(dto.event, "$.event")
    };
  });
}

export function unwrapPresentation<T>(result: DecodeResult<T>): T {
  if (result.ok) return result.value;
  throw new Error(`${result.error.message} (${result.error.path})`);
}

function decodeProjectListItem(value: unknown, path: string): ProjectListItem {
  const dto = exactObject(value, path, ["id", "title", "repository", "rootNodeSha", "nodeCount", "activeRunCount", "unresolvedDivergenceCount", "integrity", "synchronizedAt"]);
  return {
    id: textValue(dto.id, `${path}.id`),
    title: textValue(dto.title, `${path}.title`),
    repository: decodeRepository(dto.repository, `${path}.repository`),
    rootNodeSha: fullSha(dto.rootNodeSha, `${path}.rootNodeSha`),
    nodeCount: nonNegativeInteger(dto.nodeCount, `${path}.nodeCount`),
    activeRunCount: nonNegativeInteger(dto.activeRunCount, `${path}.activeRunCount`),
    unresolvedDivergenceCount: nonNegativeInteger(dto.unresolvedDivergenceCount, `${path}.unresolvedDivergenceCount`),
    integrity: decodeIntegrity(dto.integrity, `${path}.integrity`),
    synchronizedAt: timestamp(dto.synchronizedAt, `${path}.synchronizedAt`)
  };
}

function decodeProjectSummary(value: unknown, path: string): ProjectGraphSummary {
  const dto = exactObject(value, path, ["id", "title", "repository", "rootNodeSha"]);
  return {
    id: textValue(dto.id, `${path}.id`),
    title: textValue(dto.title, `${path}.title`),
    repository: decodeRepository(dto.repository, `${path}.repository`),
    rootNodeSha: fullSha(dto.rootNodeSha, `${path}.rootNodeSha`)
  };
}

function decodeRepository(value: unknown, path: string): GitHubRepositoryRef {
  const dto = exactObject(value, path, ["owner", "name", "url", "defaultBranch"]);
  return {
    owner: textValue(dto.owner, `${path}.owner`),
    name: textValue(dto.name, `${path}.name`),
    url: httpUrl(dto.url, `${path}.url`),
    defaultBranch: textValue(dto.defaultBranch, `${path}.defaultBranch`)
  };
}

function decodeIntegrity(value: unknown, path: string): ProjectIntegrity {
  const discriminant = taggedObject(value, path, "status");
  if (discriminant.status === "valid") {
    exactKeys(discriminant, path, ["status"]);
    return { status: "valid" };
  }
  if (discriminant.status === "invalid") {
    exactKeys(discriminant, path, ["status", "code", "message"]);
    return {
      status: "invalid",
      code: textValue(discriminant.code, `${path}.code`),
      message: textValue(discriminant.message, `${path}.message`)
    };
  }
  fail(`${path}.status`, "Expected valid or invalid integrity status.");
}

function decodeRunnerSummary(value: unknown, path: string): RunnerSummary {
  const dto = exactObject(value, path, ["name", "typeKey", "schemaVersion", "digest"]);
  return {
    name: textValue(dto.name, `${path}.name`),
    typeKey: textValue(dto.typeKey, `${path}.typeKey`),
    schemaVersion: semanticVersion(dto.schemaVersion, `${path}.schemaVersion`),
    digest: runnerDigest(dto.digest, `${path}.digest`)
  };
}

function decodeGraphNode(value: unknown, path: string): GraphNodeSummary {
  const dto = exactObject(value, path, ["sha", "title", "status", "runner", "nextGoalCount", "integrity"]);
  return {
    sha: fullSha(dto.sha, `${path}.sha`),
    title: textValue(dto.title, `${path}.title`),
    status: graphNodeStatus(dto.status, `${path}.status`),
    runner: decodeRunnerSummary(dto.runner, `${path}.runner`),
    nextGoalCount: nonNegativeInteger(dto.nextGoalCount, `${path}.nextGoalCount`),
    integrity: exactLiteral(dto.integrity, `${path}.integrity`, "valid")
  };
}

function decodeGraphEdge(value: unknown, path: string): GraphEdge {
  const dto = taggedObject(value, path, "kind");
  if (dto.kind === "run") {
    exactKeys(dto, path, ["kind", "id", "sourceSha", "targetSha", "runId", "goal", "completedAt"]);
    const goal = exactObject(dto.goal, `${path}.goal`, ["digest", "title"]);
    return {
      kind: "run",
      id: textValue(dto.id, `${path}.id`),
      sourceSha: fullSha(dto.sourceSha, `${path}.sourceSha`),
      targetSha: fullSha(dto.targetSha, `${path}.targetSha`),
      runId: textValue(dto.runId, `${path}.runId`),
      goal: {
        digest: goalDigest(goal.digest, `${path}.goal.digest`),
        title: textValue(goal.title, `${path}.goal.title`)
      },
      completedAt: timestamp(dto.completedAt, `${path}.completedAt`)
    };
  }
  if (dto.kind === "coaching") {
    exactKeys(dto, path, ["kind", "id", "sourceSha", "targetSha", "proposalId", "summary", "confirmedAt"]);
    return {
      kind: "coaching",
      id: textValue(dto.id, `${path}.id`),
      sourceSha: fullSha(dto.sourceSha, `${path}.sourceSha`),
      targetSha: fullSha(dto.targetSha, `${path}.targetSha`),
      proposalId: textValue(dto.proposalId, `${path}.proposalId`),
      summary: textValue(dto.summary, `${path}.summary`),
      confirmedAt: timestamp(dto.confirmedAt, `${path}.confirmedAt`)
    };
  }
  fail(`${path}.kind`, "Expected a run or coaching edge.");
}

function decodeActiveRun(value: unknown, path: string): ActiveRunSummary {
  const dto = exactObject(value, path, ["id", "sourceNodeSha", "goalDigest", "goalTitle", "runnerName", "startedAt"]);
  return {
    id: textValue(dto.id, `${path}.id`),
    sourceNodeSha: fullSha(dto.sourceNodeSha, `${path}.sourceNodeSha`),
    goalDigest: goalDigest(dto.goalDigest, `${path}.goalDigest`),
    goalTitle: textValue(dto.goalTitle, `${path}.goalTitle`),
    runnerName: textValue(dto.runnerName, `${path}.runnerName`),
    startedAt: timestamp(dto.startedAt, `${path}.startedAt`)
  };
}

function decodeNode(value: unknown, path: string): NodeDetail {
  const dto = exactObject(value, path, ["sha", "title", "commitUrl", "treeSha", "managedRef", "integrity", "status", "lineage", "plan", "outgoingEdges", "activeRuns", "evidence", "comparisons", "decisions"]);
  const plan = exactObject(dto.plan, `${path}.plan`, ["schema", "nextGoals", "how"]);
  return {
    sha: fullSha(dto.sha, `${path}.sha`),
    title: textValue(dto.title, `${path}.title`),
    commitUrl: httpUrl(dto.commitUrl, `${path}.commitUrl`),
    treeSha: fullSha(dto.treeSha, `${path}.treeSha`),
    managedRef: textValue(dto.managedRef, `${path}.managedRef`),
    integrity: decodeIntegrity(dto.integrity, `${path}.integrity`),
    status: graphNodeStatus(dto.status, `${path}.status`),
    lineage: decodeLineage(dto.lineage, `${path}.lineage`),
    plan: {
      schema: exactLiteral(plan.schema, `${path}.plan.schema`, "hunsu.node-plan.v1"),
      nextGoals: arrayOf(plan.nextGoals, `${path}.plan.nextGoals`, decodeGoal),
      how: decodeRunnerValue(plan.how, `${path}.plan.how`)
    },
    outgoingEdges: arrayOf(dto.outgoingEdges, `${path}.outgoingEdges`, decodeGraphEdge),
    activeRuns: arrayOf(dto.activeRuns, `${path}.activeRuns`, decodeActiveRun),
    evidence: arrayOf(dto.evidence, `${path}.evidence`, decodeEvidence),
    comparisons: arrayOf(dto.comparisons, `${path}.comparisons`, decodeComparison),
    decisions: arrayOf(dto.decisions, `${path}.decisions`, decodeDecision)
  };
}

function decodeLineage(value: unknown, path: string): NodeLineage {
  const dto = taggedObject(value, path, "kind");
  if (dto.kind === "root") {
    exactKeys(dto, path, ["kind"]);
    return { kind: "root" };
  }
  if (dto.kind === "run_child") {
    exactKeys(dto, path, ["kind", "parentSha", "runId", "goalDigest"]);
    return {
      kind: "run_child",
      parentSha: fullSha(dto.parentSha, `${path}.parentSha`),
      runId: textValue(dto.runId, `${path}.runId`),
      goalDigest: goalDigest(dto.goalDigest, `${path}.goalDigest`)
    };
  }
  if (dto.kind === "coaching_child") {
    exactKeys(dto, path, ["kind", "parentSha", "proposalId"]);
    return {
      kind: "coaching_child",
      parentSha: fullSha(dto.parentSha, `${path}.parentSha`),
      proposalId: textValue(dto.proposalId, `${path}.proposalId`)
    };
  }
  fail(`${path}.kind`, "Expected root, run_child, or coaching_child lineage.");
}

function decodeGoal(value: unknown, path: string): GoalValue {
  const dto = exactObject(value, path, ["digest", "key", "title", "desiredOutcome", "acceptanceCriteria", "constraints", "priority"]);
  return {
    digest: goalDigest(dto.digest, `${path}.digest`),
    key: textValue(dto.key, `${path}.key`),
    title: textValue(dto.title, `${path}.title`),
    desiredOutcome: textValue(dto.desiredOutcome, `${path}.desiredOutcome`),
    acceptanceCriteria: nonEmptyTextArray(dto.acceptanceCriteria, `${path}.acceptanceCriteria`),
    constraints: arrayOf(dto.constraints, `${path}.constraints`, textValue),
    priority: nonNegativeInteger(dto.priority, `${path}.priority`)
  };
}

function decodeRunnerValue(value: unknown, path: string): RunnerValueSummary {
  const dto = exactObject(value, path, ["schema", "name", "typeKey", "schemaVersion", "digest", "type", "value"]);
  const type = exactObject(dto.type, `${path}.type`, ["origin", "key", "schemaVersion", "integrity"]);
  const runnerValue = canonicalJson(dto.value, `${path}.value`);
  return {
    schema: exactLiteral(dto.schema, `${path}.schema`, "hunsu.runner-value.v1"),
    name: textValue(dto.name, `${path}.name`),
    typeKey: textValue(dto.typeKey, `${path}.typeKey`),
    schemaVersion: semanticVersion(dto.schemaVersion, `${path}.schemaVersion`),
    digest: runnerDigest(dto.digest, `${path}.digest`),
    type: {
      origin: textValue(type.origin, `${path}.type.origin`),
      key: textValue(type.key, `${path}.type.key`),
      schemaVersion: semanticVersion(type.schemaVersion, `${path}.type.schemaVersion`),
      integrity: runnerTypeIntegrity(type.integrity, `${path}.type.integrity`)
    },
    value: runnerValue
  };
}

function decodeEvidence(value: unknown, path: string): EvidenceSummary {
  const dto = exactObject(value, path, ["id", "kind", "title", "summary", "criterion", "location", "createdAt"]);
  const criterion = taggedObject(dto.criterion, `${path}.criterion`, "kind");
  const location = taggedObject(dto.location, `${path}.location`, "kind");
  let decodedCriterion: EvidenceSummary["criterion"];
  if (criterion.kind === "unlinked") {
    exactKeys(criterion, `${path}.criterion`, ["kind"]);
    decodedCriterion = { kind: "unlinked" };
  } else if (criterion.kind === "linked") {
    exactKeys(criterion, `${path}.criterion`, ["kind", "goalDigest", "criterion"]);
    decodedCriterion = {
      kind: "linked",
      goalDigest: goalDigest(criterion.goalDigest, `${path}.criterion.goalDigest`),
      criterion: textValue(criterion.criterion, `${path}.criterion.criterion`)
    };
  } else {
    fail(`${path}.criterion.kind`, "Expected linked or unlinked criterion.");
  }
  let decodedLocation: EvidenceSummary["location"];
  if (location.kind === "none") {
    exactKeys(location, `${path}.location`, ["kind"]);
    decodedLocation = { kind: "none" };
  } else if (location.kind === "url") {
    exactKeys(location, `${path}.location`, ["kind", "url"]);
    decodedLocation = { kind: "url", url: httpUrl(location.url, `${path}.location.url`) };
  } else {
    fail(`${path}.location.kind`, "Expected none or url evidence location.");
  }
  return {
    id: textValue(dto.id, `${path}.id`),
    kind: oneOf(dto.kind, `${path}.kind`, ["commit", "check", "report", "artifact", "link"] as const),
    title: textValue(dto.title, `${path}.title`),
    summary: textValue(dto.summary, `${path}.summary`),
    criterion: decodedCriterion,
    location: decodedLocation,
    createdAt: timestamp(dto.createdAt, `${path}.createdAt`)
  };
}

function decodeComparison(value: unknown, path: string): ComparisonSummary {
  const dto = exactObject(value, path, ["id", "summary", "siblingNodeShas", "recordedAt"]);
  return {
    id: textValue(dto.id, `${path}.id`),
    summary: textValue(dto.summary, `${path}.summary`),
    siblingNodeShas: nonEmptyArray(dto.siblingNodeShas, `${path}.siblingNodeShas`, fullSha),
    recordedAt: timestamp(dto.recordedAt, `${path}.recordedAt`)
  };
}

function decodeDecision(value: unknown, path: string): DecisionSummary {
  const dto = taggedObject(value, path, "kind");
  if (dto.kind !== "selected" && dto.kind !== "rejected") {
    fail(`${path}.kind`, "Expected selected or rejected decision.");
  }
  exactKeys(dto, path, ["kind", "id", "nodeSha", "reason", "recordedAt"]);
  return {
    kind: dto.kind,
    id: textValue(dto.id, `${path}.id`),
    nodeSha: fullSha(dto.nodeSha, `${path}.nodeSha`),
    reason: textValue(dto.reason, `${path}.reason`),
    recordedAt: timestamp(dto.recordedAt, `${path}.recordedAt`)
  };
}

function decodeEvent(value: unknown, path: string): DomainEventListItem {
  const dto = exactObject(value, path, ["sequence", "id", "type", "summary", "actor", "occurredAt", "reference"]);
  const actor = exactObject(dto.actor, `${path}.actor`, ["id", "label"]);
  return {
    sequence: positiveInteger(dto.sequence, `${path}.sequence`),
    id: textValue(dto.id, `${path}.id`),
    type: eventType(dto.type, `${path}.type`),
    summary: textValue(dto.summary, `${path}.summary`),
    actor: {
      id: textValue(actor.id, `${path}.actor.id`),
      label: textValue(actor.label, `${path}.actor.label`)
    },
    occurredAt: timestamp(dto.occurredAt, `${path}.occurredAt`),
    reference: decodeEventReference(dto.reference, `${path}.reference`)
  };
}

function decodeEventReference(value: unknown, path: string): EventReference {
  const dto = taggedObject(value, path, "kind");
  if (dto.kind === "project") {
    exactKeys(dto, path, ["kind"]);
    return { kind: "project" };
  }
  if (dto.kind === "node") {
    exactKeys(dto, path, ["kind", "nodeSha"]);
    return { kind: "node", nodeSha: fullSha(dto.nodeSha, `${path}.nodeSha`) };
  }
  if (dto.kind === "run") {
    exactKeys(dto, path, ["kind", "runId", "sourceNodeSha", "target"]);
    const target = taggedObject(dto.target, `${path}.target`, "kind");
    if (target.kind === "pending") {
      exactKeys(target, `${path}.target`, ["kind"]);
      return {
        kind: "run",
        runId: textValue(dto.runId, `${path}.runId`),
        sourceNodeSha: fullSha(dto.sourceNodeSha, `${path}.sourceNodeSha`),
        target: { kind: "pending" }
      };
    }
    if (target.kind === "registered") {
      exactKeys(target, `${path}.target`, ["kind", "nodeSha"]);
      return {
        kind: "run",
        runId: textValue(dto.runId, `${path}.runId`),
        sourceNodeSha: fullSha(dto.sourceNodeSha, `${path}.sourceNodeSha`),
        target: { kind: "registered", nodeSha: fullSha(target.nodeSha, `${path}.target.nodeSha`) }
      };
    }
    fail(`${path}.target.kind`, "Expected pending or registered Run target.");
  }
  fail(`${path}.kind`, "Expected project, node, or run event reference.");
}

function decodeBoundary<T>(decode: () => T): DecodeResult<T> {
  try {
    return { ok: true, value: decode() };
  } catch (error) {
    if (error instanceof DecodeFailure) {
      return {
        ok: false,
        error: {
          code: "invalid_presentation_dto",
          path: error.path,
          message: error.message
        }
      };
    }
    throw error;
  }
}

function exactObject(value: unknown, path: string, keys: readonly string[]): Record<string, unknown> {
  if (!isRecord(value)) fail(path, "Expected an object.");
  exactKeys(value, path, keys);
  return value;
}

function taggedObject(value: unknown, path: string, tag: string): Record<string, unknown> & { [key: string]: unknown } {
  if (!isRecord(value)) fail(path, "Expected an object.");
  if (typeof value[tag] !== "string") fail(`${path}.${tag}`, "Expected a string discriminant.");
  return value;
}

function exactKeys(value: Record<string, unknown>, path: string, keys: readonly string[]): void {
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${path}.${key}`, "Unexpected field.");
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) fail(`${path}.${key}`, "Missing required field.");
  }
}

function arrayOf<T>(value: unknown, path: string, decode: (item: unknown, itemPath: string) => T): readonly T[] {
  if (!Array.isArray(value)) fail(path, "Expected an array.");
  return value.map((item, index) => decode(item, `${path}[${index}]`));
}

function nonEmptyArray<T>(value: unknown, path: string, decode: (item: unknown, itemPath: string) => T): readonly T[] {
  const result = arrayOf(value, path, decode);
  if (result.length === 0) fail(path, "Expected at least one item.");
  return result;
}

function nonEmptyTextArray(value: unknown, path: string): readonly string[] {
  return nonEmptyArray(value, path, textValue);
}

function textValue(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) fail(path, "Expected non-empty text.");
  return value;
}

function nullableText(value: unknown, path: string): string | null {
  return value === null ? null : textValue(value, path);
}

function fullSha(value: unknown, path: string): string {
  const result = textValue(value, path);
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(result)) fail(path, "Expected a lowercase full Git object SHA.");
  return result;
}

function prefixedDigest(value: unknown, path: string, prefix: string): string {
  const result = textValue(value, path);
  if (!result.startsWith(prefix) || !/^[0-9a-f]{64}$/u.test(result.slice(prefix.length))) fail(path, `Expected ${prefix} followed by a lowercase SHA-256 digest.`);
  return result;
}

function goalDigest(value: unknown, path: string): string {
  return prefixedDigest(value, path, "hunsu-goal-v1:sha256:");
}

function runnerDigest(value: unknown, path: string): string {
  return prefixedDigest(value, path, "hunsu-runner-v1:sha256:");
}

function runnerTypeIntegrity(value: unknown, path: string): string {
  return prefixedDigest(value, path, "hunsu-runner-type-v1:sha256:");
}

function timestamp(value: unknown, path: string): string {
  const result = textValue(value, path);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u.test(result) || !Number.isFinite(Date.parse(result))) fail(path, "Expected a valid RFC 3339 timestamp.");
  return result;
}

function semanticVersion(value: unknown, path: string): string {
  const result = textValue(value, path);
  if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(result)) fail(path, "Expected an exact semantic version.");
  return result;
}

function httpUrl(value: unknown, path: string): string {
  const result = textValue(value, path);
  let parsed: URL;
  try {
    parsed = new URL(result);
  } catch {
    fail(path, "Expected an absolute HTTP URL.");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") fail(path, "Expected an HTTP URL.");
  if (parsed.username || parsed.password) fail(path, "URL credentials are forbidden.");
  return result;
}

function nonNegativeInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail(path, "Expected a non-negative integer.");
  return value as number;
}

function positiveInteger(value: unknown, path: string): number {
  const result = nonNegativeInteger(value, path);
  if (result === 0) fail(path, "Expected a positive integer.");
  return result;
}

function boundedPositiveInteger(value: unknown, path: string, maximum: number): number {
  const result = positiveInteger(value, path);
  if (result > maximum) fail(path, `Expected an integer no greater than ${maximum}.`);
  return result;
}

function booleanValue(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") fail(path, "Expected a boolean.");
  return value;
}

function exactLiteral<T extends string>(value: unknown, path: string, literal: T): T {
  if (value !== literal) fail(path, `Expected ${literal}.`);
  return literal;
}

function oneOf<const T extends readonly string[]>(value: unknown, path: string, allowed: T): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) fail(path, `Expected one of: ${allowed.join(", ")}.`);
  return value as T[number];
}

function graphNodeStatus(value: unknown, path: string): GraphNodeStatus {
  return oneOf(value, path, ["available", "current", "selected", "rejected"] as const);
}

function eventType(value: unknown, path: string): DomainEventType {
  return oneOf(value, path, DOMAIN_EVENT_TYPES);
}

type CanonicalJson = null | boolean | number | string | readonly CanonicalJson[] | { readonly [key: string]: CanonicalJson };

function canonicalJson(value: unknown, path: string): CanonicalJson {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail(path, "Expected a finite JSON number.");
    return value;
  }
  if (Array.isArray(value)) return value.map((item, index) => canonicalJson(item, `${path}[${index}]`));
  if (isRecord(value)) {
    const result: Record<string, CanonicalJson> = {};
    for (const [key, item] of Object.entries(value)) {
      Object.defineProperty(result, key, {
        value: canonicalJson(item, `${path}.${key}`),
        enumerable: true,
        configurable: true,
        writable: true
      });
    }
    return result;
  }
  fail(path, "Expected canonical JSON.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(path: string, message: string): never {
  throw new DecodeFailure(path, message);
}
