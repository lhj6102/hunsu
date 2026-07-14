export type JsonSchema = Readonly<Record<string, unknown>>;

export type HunsuToolName =
  | "hunsu.projects.list"
  | "hunsu.projects.get"
  | "hunsu.projects.create"
  | "hunsu.projects.rebuild"
  | "hunsu.nodes.graph"
  | "hunsu.nodes.get"
  | "hunsu.events.list"
  | "hunsu.events.get"
  | "hunsu.runs.get"
  | "hunsu.runs.start"
  | "hunsu.runs.checkpoint"
  | "hunsu.runs.attach_evidence"
  | "hunsu.runs.complete"
  | "hunsu.runs.fail"
  | "hunsu.runs.cancel"
  | "hunsu.coach.review"
  | "hunsu.coach.propose_transition"
  | "hunsu.coach.confirm_transition"
  | "hunsu.coach.reject_transition"
  | "hunsu.alternatives.compare"
  | "hunsu.alternatives.select"
  | "hunsu.alternatives.reject";

export type HunsuToolDefinition = {
  readonly name: HunsuToolName;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  readonly readOnly: boolean;
  readonly requiresUserConfirmation: boolean;
  readonly confirmationMessage?: string;
  readonly confirmationRecovery?: string;
};

const text = { type: "string", minLength: 1 } as const;
const id = { type: "string", pattern: "^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$" } as const;
const repositoryOwner = { type: "string", pattern: "^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$" } as const;
const repositoryName = { type: "string", pattern: "^(?!\\.{1,2}$)[A-Za-z0-9._-]{1,100}$" } as const;
const sha = { type: "string", pattern: "^[0-9a-f]{40}$" } as const;
const goalDigest = { type: "string", pattern: "^hunsu-goal-v1:sha256:[0-9a-f]{64}$" } as const;
const nodePayloadDigest = { type: "string", pattern: "^hunsu-node-payload-v1:sha256:[0-9a-f]{64}$" } as const;
const timestamp = { type: "string", format: "date-time" } as const;
const stateSha = {
  ...sha,
  description: "Exact expectedStateSha returned by the latest Project or repository context; this is the default-branch head before v2 initialization and the hunsu/state head otherwise."
} as const;
const idempotencyKey = { type: "string", minLength: 1, maxLength: 256 } as const;
const stringArray = { type: "array", items: text } as const;
const repository = object({
  installationId: { type: "integer", minimum: 1 },
  repositoryId: { type: "integer", minimum: 1 },
  owner: repositoryOwner,
  name: repositoryName,
  defaultBranch: text
}, ["owner", "name"]);
const checkpointLocation = {
  oneOf: [
    object({ type: { const: "observation" } }, ["type"]),
    object({ type: { const: "commit" }, commitSha: sha }, ["type", "commitSha"])
  ]
} as const;
const evidenceTarget = {
  oneOf: [
    object({ type: { const: "run" } }, ["type"]),
    object({ type: { const: "criterion" }, criterion: text }, ["type", "criterion"])
  ]
} as const;
const criterionEvidenceTarget = object({
  type: { const: "criterion" },
  criterion: text
}, ["type", "criterion"]);
const evidenceLocation = {
  oneOf: [
    object({ type: { const: "git" }, commitSha: sha, path: text }, ["type", "commitSha", "path"]),
    object({ type: { const: "url" }, url: { type: "string", format: "uri" } }, ["type", "url"]),
    object({ type: { const: "text" }, text }, ["type", "text"])
  ]
} as const;
const evidence = object({
  kind: { enum: ["diff", "check", "screenshot", "report", "note"] },
  summary: text,
  target: evidenceTarget,
  location: evidenceLocation
}, ["kind", "summary", "target", "location"]);
const completionEvidence = object({
  kind: { enum: ["diff", "check", "screenshot", "report", "note"] },
  summary: text,
  target: criterionEvidenceTarget,
  location: evidenceLocation
}, ["kind", "summary", "target", "location"]);
const goalValue = object({
  key: id,
  title: text,
  desiredOutcome: text,
  acceptanceCriteria: { type: "array", minItems: 1, uniqueItems: true, items: text },
  constraints: stringArray,
  priority: { type: "integer", minimum: 0 }
}, ["key", "title", "desiredOutcome", "acceptanceCriteria", "constraints", "priority"]);
const runnerTypeLock = object({
  origin: { type: "string", pattern: "^[a-z0-9](?:[a-z0-9._-]{0,127})$" },
  key: { type: "string", pattern: "^[a-z0-9](?:[a-z0-9._/-]*[a-z0-9])?$" },
  schemaVersion: { type: "string", pattern: "^(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?$" },
  integrity: { type: "string", pattern: "^hunsu-runner-type-v1:sha256:[0-9a-f]{64}$" }
}, ["origin", "key", "schemaVersion", "integrity"]);
const runnerValue = object({
  schema: { const: "hunsu.runner-value.v1" },
  type: runnerTypeLock,
  name: text,
  value: { "x-hunsu-canonical-json": true }
}, ["schema", "type", "name", "value"]);
const nodePlan = object({
  schema: { const: "hunsu.node-plan.v1" },
  nextGoals: { type: "array", uniqueItems: true, items: goalValue },
  how: runnerValue
}, ["schema", "nextGoals", "how"]);

const definitions: HunsuToolDefinition[] = [
  readTool("hunsu.projects.list", "List v2 Hunsu Projects and repository bootstrap contexts, including v2 initialization status and the exact expectedStateSha.", {
    installationId: { type: "integer", minimum: 1 },
    repository: { type: "string", description: "Optional owner/name filter." }
  }, []),
  readTool("hunsu.projects.get", "Load one Project, its root Node, current state-head integrity, and the exact expectedStateSha for the repository.", {
    repository,
    projectId: id
  }, ["repository", "projectId"]),
  confirmedTool(
    "hunsu.projects.create",
    "Initialize a v2 Project at an existing root commit with its first immutable Node plan.",
    {
      repository,
      projectId: id,
      title: text,
      rootNodeSha: sha,
      initialPlan: nodePlan,
      idempotencyKey,
      expectedStateSha: stateSha,
      confirmedByUser: { const: true }
    },
    ["repository", "projectId", "title", "rootNodeSha", "initialPlan", "idempotencyKey", "expectedStateSha", "confirmedByUser"],
    "Initializing this Project root requires explicit user confirmation.",
    "Show the repository, full root SHA, initial Goals, and Runner Value, then ask the user to confirm."
  ),
  confirmedTool(
    "hunsu.projects.rebuild",
    "CAS-rebuild disposable v2 Project materializations from authoritative Events.",
    {
      repository,
      projectId: id,
      idempotencyKey,
      expectedStateSha: stateSha,
      confirmedByUser: { const: true }
    },
    ["repository", "projectId", "idempotencyKey", "expectedStateSha", "confirmedByUser"],
    "Rebuilding this Project's exact-head materializations requires explicit user confirmation.",
    "Show the Project and exact expected state SHA, then ask the user to confirm the CAS rebuild."
  ),

  readTool("hunsu.nodes.graph", "Load Commit Node topology and card summaries without decoding every Node payload.", {
    repository,
    projectId: id,
    cursor: text,
    limit: { type: "integer", minimum: 1, maximum: 300 }
  }, ["repository", "projectId"]),
  readTool("hunsu.nodes.get", "Decode one Commit Node with its next Goals, Runner Value, integrity, and related activity.", {
    repository,
    projectId: id,
    nodeSha: sha
  }, ["repository", "projectId", "nodeSha"]),

  readTool("hunsu.events.list", "List append-only v2 domain Events in descending sequence order.", {
    repository,
    projectId: id,
    cursor: text,
    limit: { type: "integer", minimum: 1, maximum: 50 },
    eventType: text,
    nodeSha: sha,
    actor: text,
    occurredFrom: timestamp,
    occurredTo: timestamp
  }, ["repository", "projectId"]),
  readTool("hunsu.events.get", "Load one append-only domain Event and its related Node or Run references.", {
    repository,
    projectId: id,
    eventId: id
  }, ["repository", "projectId", "eventId"]),

  readTool("hunsu.runs.get", "Load one Run with its immutable singular Goal, full Runner Value, checkpoints, and evidence.", {
    repository,
    projectId: id,
    runId: id
  }, ["repository", "projectId", "runId"]),
  writeTool("hunsu.runs.start", "Start one Run from a source Node for exactly one next Goal and return RunContract v2.", {
    repository,
    projectId: id,
    sourceNodeSha: sha,
    goalDigest,
    runId: id,
    idempotencyKey,
    expectedStateSha: stateSha
  }, ["repository", "projectId", "sourceNodeSha", "goalDigest", "runId", "idempotencyKey", "expectedStateSha"]),
  writeTool("hunsu.runs.checkpoint", "Record a recoverable checkpoint for an active Run.", {
    ...mutationIdentity("runId"),
    summary: text,
    location: checkpointLocation
  }, [...mutationRequired("runId"), "summary", "location"]),
  writeTool("hunsu.runs.attach_evidence", "Attach immutable criterion-linked evidence to an active Run.", {
    ...mutationIdentity("runId"),
    evidence
  }, [...mutationRequired("runId"), "evidence"]),
  writeTool("hunsu.runs.complete", "Verify a pushed result SHA and atomically register its Run child Node.", {
    ...mutationIdentity("runId"),
    resultSha: sha,
    evidence: { type: "array", minItems: 1, items: completionEvidence }
  }, [...mutationRequired("runId"), "resultSha", "evidence"]),
  writeTool("hunsu.runs.fail", "Record a terminal Run failure without creating a Node or edge.", {
    ...mutationIdentity("runId"),
    reason: text
  }, [...mutationRequired("runId"), "reason"]),
  writeTool("hunsu.runs.cancel", "Cancel an active Run without creating a Node or edge.", {
    ...mutationIdentity("runId"),
    reason: text
  }, [...mutationRequired("runId"), "reason"]),

  writeTool("hunsu.coach.review", "Record an evidence-grounded review of one Commit Node and its activity.", {
    repository,
    projectId: id,
    nodeSha: sha,
    reviewId: id,
    assessment: text,
    findings: stringArray,
    recommendation: text,
    idempotencyKey,
    expectedStateSha: stateSha
  }, ["repository", "projectId", "nodeSha", "reviewId", "assessment", "findings", "recommendation", "idempotencyKey", "expectedStateSha"]),
  writeTool("hunsu.coach.propose_transition", "Propose a complete next Node plan without creating a commit, Node, or edge.", {
    repository,
    projectId: id,
    sourceNodeSha: sha,
    sourcePayloadDigest: nodePayloadDigest,
    proposalId: id,
    proposedPlan: nodePlan,
    summary: text,
    rationale: text,
    idempotencyKey,
    expectedStateSha: stateSha
  }, ["repository", "projectId", "sourceNodeSha", "sourcePayloadDigest", "proposalId", "proposedPlan", "summary", "rationale", "idempotencyKey", "expectedStateSha"]),
  confirmedTool(
    "hunsu.coach.confirm_transition",
    "Confirm a pending Coaching proposal and register its deterministic same-tree child Node.",
    {
      ...mutationIdentity("proposalId"),
      confirmedByUser: { const: true }
    },
    [...mutationRequired("proposalId"), "confirmedByUser"],
    "Applying this Coaching transition requires explicit user confirmation.",
    "Show the exact source Node and complete current-versus-proposed Node plan, then ask the user to confirm."
  ),
  confirmedTool(
    "hunsu.coach.reject_transition",
    "Reject a pending Coaching proposal without changing the Commit Node graph.",
    {
      ...mutationIdentity("proposalId"),
      reason: text,
      confirmedByUser: { const: true }
    },
    [...mutationRequired("proposalId"), "reason", "confirmedByUser"],
    "Rejecting this Coaching proposal requires explicit user confirmation.",
    "Show the exact pending proposal, then ask the user to confirm its rejection."
  ),

  writeTool("hunsu.alternatives.compare", "Record an evidence-based comparison of completed Run child Nodes with one structural parent.", {
    repository,
    projectId: id,
    sourceNodeSha: sha,
    comparisonId: id,
    nodeShas: { type: "array", minItems: 2, uniqueItems: true, items: sha },
    findings: {
      type: "array",
      items: object({
        criterion: text,
        summaries: {
          type: "array",
          minItems: 2,
          items: object({ nodeSha: sha, summary: text }, ["nodeSha", "summary"])
        }
      }, ["criterion", "summaries"])
    },
    summary: text,
    idempotencyKey,
    expectedStateSha: stateSha
  }, ["repository", "projectId", "sourceNodeSha", "comparisonId", "nodeShas", "findings", "summary", "idempotencyKey", "expectedStateSha"]),
  confirmedTool(
    "hunsu.alternatives.select",
    "Select a sibling future after comparison and explicit user confirmation.",
    {
      ...mutationIdentity("nodeSha"),
      comparisonId: id,
      rationale: text,
      confirmedByUser: { const: true }
    },
    [...mutationRequired("nodeSha"), "comparisonId", "rationale", "confirmedByUser"],
    "Selecting this Node requires explicit user confirmation.",
    "Show the sibling comparison and ask the user to confirm the selected Node."
  ),
  confirmedTool(
    "hunsu.alternatives.reject",
    "Reject one sibling future after comparison and explicit user confirmation.",
    {
      ...mutationIdentity("nodeSha"),
      comparisonId: id,
      rationale: text,
      confirmedByUser: { const: true }
    },
    [...mutationRequired("nodeSha"), "comparisonId", "rationale", "confirmedByUser"],
    "Rejecting this Node requires explicit user confirmation.",
    "Show the sibling comparison and ask the user to confirm the rejected Node."
  )
];

export const HUNSU_MCP_TOOLS = Object.freeze(definitions.map(definition => Object.freeze(definition)));

export function findHunsuTool(name: string): HunsuToolDefinition | undefined {
  return HUNSU_MCP_TOOLS.find(tool => tool.name === name);
}

const RETIRED_V1_TOOLS = new Set([
  "hunsu.projects.update",
  "hunsu.coach.get",
  "hunsu.coach.propose_change",
  "hunsu.coach.propose_hunsu"
]);

export function isRetiredHunsuV1Tool(name: string): boolean {
  return name.startsWith("hunsu.goals.") || name.startsWith("hunsu.runners.") || RETIRED_V1_TOOLS.has(name);
}

function mutationIdentity(resourceName: "runId" | "proposalId" | "nodeSha"): Record<string, JsonSchema> {
  return {
    repository,
    projectId: id,
    [resourceName]: resourceName === "nodeSha" ? sha : id,
    idempotencyKey,
    expectedStateSha: stateSha
  };
}

function mutationRequired(resourceName: "runId" | "proposalId" | "nodeSha"): string[] {
  return ["repository", "projectId", resourceName, "idempotencyKey", "expectedStateSha"];
}

function readTool(name: HunsuToolName, description: string, properties: Record<string, JsonSchema>, required: string[]): HunsuToolDefinition {
  return tool(name, description, properties, required, true, false);
}

function writeTool(name: HunsuToolName, description: string, properties: Record<string, JsonSchema>, required: string[]): HunsuToolDefinition {
  return tool(name, description, properties, required, false, false);
}

function confirmedTool(
  name: HunsuToolName,
  description: string,
  properties: Record<string, JsonSchema>,
  required: string[],
  confirmationMessage: string,
  confirmationRecovery: string
): HunsuToolDefinition {
  return tool(name, description, properties, required, false, true, confirmationMessage, confirmationRecovery);
}

function tool(
  name: HunsuToolName,
  description: string,
  properties: Record<string, JsonSchema>,
  required: string[],
  readOnly: boolean,
  requiresUserConfirmation: boolean,
  confirmationMessage?: string,
  confirmationRecovery?: string
): HunsuToolDefinition {
  return {
    name,
    description,
    inputSchema: object(properties, required),
    readOnly,
    requiresUserConfirmation,
    ...(confirmationMessage === undefined ? {} : { confirmationMessage }),
    ...(confirmationRecovery === undefined ? {} : { confirmationRecovery })
  };
}

function object(properties: Record<string, JsonSchema>, required: string[]): JsonSchema {
  return { type: "object", properties, required, additionalProperties: false };
}
