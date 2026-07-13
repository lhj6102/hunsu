export type JsonSchema = Readonly<Record<string, unknown>>;

export type HunsuToolDefinition = {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  readOnly: boolean;
  requiresUserConfirmation: boolean;
};

const string = { type: "string", minLength: 1 } as const;
const id = { type: "string", pattern: "^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$" } as const;
const repositoryOwner = { type: "string", pattern: "^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$" } as const;
const repositoryName = { type: "string", pattern: "^(?!\\.{1,2}$)[A-Za-z0-9._-]{1,100}$" } as const;
const sha = { type: "string", pattern: "^[0-9a-f]{40}$" } as const;
const stateSha = { ...sha, description: "Previously observed hunsu/state head SHA." } as const;
const idempotencyKey = { type: "string", minLength: 1, maxLength: 256 } as const;
const stringArray = { type: "array", items: string } as const;
const repository = object({
  installationId: { type: "integer", minimum: 1 },
  repositoryId: { type: "integer", minimum: 1 },
  owner: repositoryOwner,
  name: repositoryName,
  defaultBranch: string
}, ["owner", "name"]);
const evidence = object({
  kind: { enum: ["check", "commit", "artifact", "observation"] },
  summary: string,
  url: { type: "string", format: "uri" },
  sha,
  criterion: string
}, ["kind", "summary"]);
const completionEvidence = object({
  kind: { enum: ["check", "commit", "artifact", "observation"] },
  summary: string,
  url: { type: "string", format: "uri" },
  sha,
  criterion: string
}, ["kind", "summary", "criterion"]);
const resourceBinding = object({
  kind: { enum: ["skill", "plugin"] },
  name: string,
  reference: string
}, ["kind", "name", "reference"]);
const teamPlayer = object({
  playerId: id,
  role: string,
  order: { type: "integer", minimum: 1 }
}, ["playerId", "role", "order"]);

const definitions: HunsuToolDefinition[] = [
  readTool("hunsu.projects.list", "List GitHub-derived Hunsu Projects available to the current installation.", {
    installationId: { type: "integer", minimum: 1 },
    repository: { type: "string", description: "Optional owner/name filter." }
  }, []),
  readTool("hunsu.projects.get", "Load one Project and its current GitHub state-head health.", {
    repository,
    projectId: id
  }, ["repository", "projectId"]),
  writeTool("hunsu.projects.create", "Create a Project on the repository's hunsu/state branch.", {
    repository,
    projectId: id,
    title: string,
    objective: string,
    baseRef: string,
    coachId: id,
    idempotencyKey,
    expectedStateSha: stateSha
  }, ["repository", "projectId", "title", "objective", "baseRef", "coachId", "idempotencyKey"]),
  writeTool("hunsu.projects.update", "Update Project title, objective, or selected base ref through the shared command boundary.", {
    repository,
    projectId: id,
    title: string,
    objective: string,
    baseRef: string,
    idempotencyKey,
    expectedStateSha: stateSha
  }, ["repository", "projectId", "idempotencyKey", "expectedStateSha"]),
  writeTool("hunsu.projects.rebuild", "Reconstruct disposable Project projections entirely from GitHub events.", {
    repository,
    projectId: id
  }, ["repository"]),

  readTool("hunsu.goals.list", "List Goals for a Project.", { repository, projectId: id }, ["repository", "projectId"]),
  readTool("hunsu.goals.get", "Load one Goal with Run, evidence, and alternative summaries.", { repository, projectId: id, goalId: id }, ["repository", "projectId", "goalId"]),
  writeTool("hunsu.goals.create", "Create an outcome-oriented Goal with acceptance criteria and constraints.", {
    repository,
    projectId: id,
    goalId: id,
    title: string,
    desiredOutcome: string,
    acceptanceCriteria: stringArray,
    constraints: stringArray,
    priority: { type: "integer", minimum: 0 },
    runnerId: id,
    idempotencyKey,
    expectedStateSha: stateSha
  }, ["repository", "projectId", "goalId", "title", "desiredOutcome", "acceptanceCriteria", "constraints", "idempotencyKey", "expectedStateSha"]),
  writeTool("hunsu.goals.update", "Refine a Goal or its assigned Runner.", {
    repository,
    projectId: id,
    goalId: id,
    title: string,
    desiredOutcome: string,
    acceptanceCriteria: stringArray,
    constraints: stringArray,
    priority: { type: "integer", minimum: 0 },
    runnerId: id,
    idempotencyKey,
    expectedStateSha: stateSha
  }, ["repository", "projectId", "goalId", "idempotencyKey", "expectedStateSha"]),
  writeTool("hunsu.goals.pause", "Pause a Goal without discarding its Runs or evidence.", {
    ...mutationIdentity("goalId"),
    reason: string
  }, [...mutationRequired("goalId"), "reason"]),
  writeTool("hunsu.goals.complete", "Complete a Goal after its criteria are supported by evidence.", {
    ...mutationIdentity("goalId"),
    selectedRunId: id,
    evidenceSummary: string
  }, [...mutationRequired("goalId"), "selectedRunId", "evidenceSummary"]),

  readTool("hunsu.runners.list", "List Team and Player Runners in a Project.", { repository, projectId: id }, ["repository", "projectId"]),
  readTool("hunsu.runners.get", "Load one Team or Player Runner definition and recent use.", { repository, projectId: id, runnerId: id }, ["repository", "projectId", "runnerId"]),
  writeTool("hunsu.runners.create_player", "Create an atomic Player Runner.", {
    repository,
    projectId: id,
    runnerId: id,
    promptTemplate: string,
    resources: { type: "array", items: resourceBinding },
    runtimePolicy: runtimePolicySchema(),
    idempotencyKey,
    expectedStateSha: stateSha
  }, ["repository", "projectId", "runnerId", "promptTemplate", "resources", "runtimePolicy", "idempotencyKey", "expectedStateSha"]),
  writeTool("hunsu.runners.create_team", "Create a Team Runner that coordinates known Players.", {
    repository,
    projectId: id,
    runnerId: id,
    strategy: object({
      mode: { enum: ["sequence", "parallel", "coordinated"] },
      promptTemplate: string,
      maxRounds: { type: "integer", minimum: 1 }
    }, ["mode", "promptTemplate", "maxRounds"]),
    players: {
      type: "array",
      minItems: 1,
      items: teamPlayer
    },
    idempotencyKey,
    expectedStateSha: stateSha
  }, ["repository", "projectId", "runnerId", "strategy", "players", "idempotencyKey", "expectedStateSha"]),
  writeTool("hunsu.runners.update", "Update a Team or Player Runner while preserving existing Run snapshots.", {
    repository,
    projectId: id,
    runnerId: id,
    definition: runnerUpdateSchema(),
    idempotencyKey,
    expectedStateSha: stateSha
  }, ["repository", "projectId", "runnerId", "definition", "idempotencyKey", "expectedStateSha"]),

  writeTool("hunsu.runs.start", "Create a Run branch and return an immutable execution contract.", {
    repository,
    projectId: id,
    goalId: id,
    runnerId: id,
    runId: id,
    baseSha: sha,
    alternativeOfRunId: id,
    coachProposalId: { ...id, description: "Exact open Coach Hunsu proposal to accept atomically when no divergence exists." },
    confirmedByUser: { const: true, description: "Required only with coachProposalId after showing the proposed difference to the user." },
    idempotencyKey,
    expectedStateSha: stateSha
  }, ["repository", "projectId", "goalId", "runnerId", "runId", "baseSha", "idempotencyKey", "expectedStateSha"]),
  writeTool("hunsu.runs.checkpoint", "Record a recoverable Run checkpoint.", {
    ...mutationIdentity("runId"),
    summary: string,
    commitSha: sha
  }, [...mutationRequired("runId"), "summary"]),
  writeTool("hunsu.runs.attach_evidence", "Attach immutable criterion-linked evidence to a Run.", {
    ...mutationIdentity("runId"),
    evidence
  }, [...mutationRequired("runId"), "evidence"]),
  writeTool("hunsu.runs.complete", "Report a pushed result SHA for GitHub reachability verification.", {
    ...mutationIdentity("runId"),
    resultSha: sha,
    evidence: { type: "array", minItems: 1, items: completionEvidence }
  }, [...mutationRequired("runId"), "resultSha", "evidence"]),
  writeTool("hunsu.runs.fail", "Record a terminal Run failure with evidence.", {
    ...mutationIdentity("runId"),
    reason: string,
    evidence: { type: "array", minItems: 1, items: evidence }
  }, [...mutationRequired("runId"), "reason", "evidence"]),
  writeTool("hunsu.runs.cancel", "Cancel an active Run intentionally.", {
    ...mutationIdentity("runId"),
    reason: string
  }, [...mutationRequired("runId"), "reason"]),

  writeTool("hunsu.coach.review", "Record an evidence-grounded Coach review.", {
    repository,
    projectId: id,
    goalId: id,
    runId: id,
    assessment: string,
    findings: stringArray,
    recommendation: string,
    idempotencyKey,
    expectedStateSha: stateSha
  }, ["repository", "projectId", "assessment", "findings", "recommendation", "idempotencyKey", "expectedStateSha"]),
  writeTool("hunsu.coach.propose_change", "Propose a Goal or Runner change without applying it.", {
    repository,
    projectId: id,
    proposalId: id,
    target: { enum: ["goal", "runner"] },
    goalId: id,
    goalPatch: object({
      title: string,
      desiredOutcome: string,
      acceptanceCriteria: stringArray,
      constraints: stringArray,
      priority: { type: "integer", minimum: 0 }
    }, []),
    runnerId: id,
    summary: string,
    rationale: string,
    idempotencyKey,
    expectedStateSha: stateSha
  }, ["repository", "projectId", "proposalId", "target", "goalId", "summary", "rationale", "idempotencyKey", "expectedStateSha"]),
  writeTool("hunsu.coach.propose_hunsu", "Propose a same-base alternative without confirming it.", {
    repository,
    projectId: id,
    proposalId: id,
    sourceRunId: id,
    goalId: id,
    changedGoalPatch: object({
      title: string,
      desiredOutcome: string,
      acceptanceCriteria: stringArray,
      constraints: stringArray,
      priority: { type: "integer", minimum: 0 }
    }, []),
    changedRunnerId: id,
    rationale: string,
    idempotencyKey,
    expectedStateSha: stateSha
  }, ["repository", "projectId", "proposalId", "sourceRunId", "goalId", "rationale", "idempotencyKey", "expectedStateSha"]),

  writeTool("hunsu.alternatives.compare", "Record an evidence-based comparison of sibling Runs from one base SHA.", {
    repository,
    projectId: id,
    comparisonId: id,
    divergenceId: id,
    goalId: id,
    runIds: { type: "array", minItems: 2, uniqueItems: true, items: id },
    findings: {
      type: "array",
      items: object({
        criterion: string,
        summaries: {
          type: "array",
          minItems: 1,
          items: object({ runId: id, summary: string }, ["runId", "summary"])
        }
      }, ["criterion", "summaries"])
    },
    summary: string,
    idempotencyKey,
    expectedStateSha: stateSha
  }, ["repository", "projectId", "comparisonId", "divergenceId", "goalId", "runIds", "findings", "summary", "idempotencyKey", "expectedStateSha"]),
  confirmedTool("hunsu.alternatives.select", "Select the future that should continue after explicit user confirmation.", {
    ...mutationIdentity("runId"),
    comparisonId: id,
    rationale: string,
    confirmedByUser: { const: true }
  }, [...mutationRequired("runId"), "comparisonId", "rationale", "confirmedByUser"]),
  confirmedTool("hunsu.alternatives.reject", "Reject one alternative after explicit user confirmation.", {
    ...mutationIdentity("runId"),
    comparisonId: id,
    rationale: string,
    confirmedByUser: { const: true }
  }, [...mutationRequired("runId"), "comparisonId", "rationale", "confirmedByUser"])
];

export const HUNSU_MCP_TOOLS = Object.freeze(definitions.map(definition => Object.freeze(definition)));

export function findHunsuTool(name: string): HunsuToolDefinition | undefined {
  return HUNSU_MCP_TOOLS.find(tool => tool.name === name);
}

function mutationIdentity(resourceName: "goalId" | "runId"): Record<string, JsonSchema> {
  return {
    repository,
    projectId: id,
    [resourceName]: id,
    idempotencyKey,
    expectedStateSha: stateSha
  };
}

function mutationRequired(resourceName: "goalId" | "runId"): string[] {
  return ["repository", "projectId", resourceName, "idempotencyKey", "expectedStateSha"];
}

function runtimePolicySchema(): JsonSchema {
  return object({
    filesystem: { enum: ["read_only", "worktree_write"] },
    network: { enum: ["disabled", "enabled"] },
    approvals: { enum: ["never", "on_request"] }
  }, ["filesystem", "network", "approvals"]);
}

function runnerUpdateSchema(): JsonSchema {
  const player = {
    ...object({
    kind: { const: "player" },
    promptTemplate: string,
    resources: { type: "array", items: resourceBinding },
    runtimePolicy: runtimePolicySchema()
    }, ["kind"]),
    anyOf: [
      { required: ["promptTemplate"] },
      { required: ["resources"] },
      { required: ["runtimePolicy"] }
    ]
  };
  const strategy = {
    ...object({
      mode: { enum: ["sequence", "parallel", "coordinated"] },
      promptTemplate: string,
      maxRounds: { type: "integer", minimum: 1 }
    }, []),
    minProperties: 1
  };
  const team = {
    ...object({
    kind: { const: "team" },
    strategy,
    players: { type: "array", minItems: 1, items: teamPlayer }
    }, ["kind"]),
    anyOf: [
      { required: ["strategy"] },
      { required: ["players"] }
    ]
  };
  return {
    type: "object",
    properties: {
      kind: { enum: ["player", "team"] },
      promptTemplate: string,
      resources: { type: "array", items: resourceBinding },
      runtimePolicy: runtimePolicySchema(),
      strategy,
      players: { type: "array", minItems: 1, items: teamPlayer }
    },
    required: ["kind"],
    additionalProperties: false,
    oneOf: [player, team]
  };
}

function readTool(name: string, description: string, properties: Record<string, JsonSchema>, required: string[]): HunsuToolDefinition {
  return tool(name, description, properties, required, true, false);
}

function writeTool(name: string, description: string, properties: Record<string, JsonSchema>, required: string[]): HunsuToolDefinition {
  return tool(name, description, properties, required, false, false);
}

function confirmedTool(name: string, description: string, properties: Record<string, JsonSchema>, required: string[]): HunsuToolDefinition {
  return tool(name, description, properties, required, false, true);
}

function tool(
  name: string,
  description: string,
  properties: Record<string, JsonSchema>,
  required: string[],
  readOnly: boolean,
  requiresUserConfirmation: boolean
): HunsuToolDefinition {
  return { name, description, inputSchema: object(properties, required), readOnly, requiresUserConfirmation };
}

function object(properties: Record<string, JsonSchema>, required: string[]): JsonSchema {
  return { type: "object", properties, required, additionalProperties: false };
}
