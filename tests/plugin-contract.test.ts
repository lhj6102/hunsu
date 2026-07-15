import assert from "node:assert/strict";
import test from "node:test";
import {
  handleMcpRequest,
  HUNSU_MCP_TOOLS,
  type McpToolDispatcher,
  type RunContract,
  type RunnerValue,
  type ToolResponse
} from "../packages/plugin-contract/src/index.ts";

const expectedTools = [
  "hunsu.projects.list", "hunsu.projects.get", "hunsu.projects.create", "hunsu.projects.rebuild",
  "hunsu.runner_capabilities.list", "hunsu.runner_capabilities.get",
  "hunsu.nodes.graph", "hunsu.nodes.get",
  "hunsu.events.list", "hunsu.events.get",
  "hunsu.runs.get",
  "hunsu.coach.reviews.list", "hunsu.coach.reviews.get", "hunsu.coach.proposals.list", "hunsu.coach.proposals.get",
  "hunsu.runs.start", "hunsu.runs.checkpoint", "hunsu.runs.attach_evidence", "hunsu.runs.complete", "hunsu.runs.fail", "hunsu.runs.cancel",
  "hunsu.coach.review", "hunsu.coach.propose_transition", "hunsu.coach.confirm_transition", "hunsu.coach.reject_transition",
  "hunsu.alternatives.list", "hunsu.alternatives.get", "hunsu.alternatives.compare", "hunsu.alternatives.select", "hunsu.alternatives.reject"
];

test("plugin contract exposes only the v2 Commit Node tool surface", () => {
  assert.deepEqual(HUNSU_MCP_TOOLS.map(tool => tool.name), expectedTools);
  assert.equal(new Set(expectedTools).size, expectedTools.length);
  assert.equal(HUNSU_MCP_TOOLS.some(tool => tool.name.startsWith("hunsu.goals.")), false);
  assert.equal(HUNSU_MCP_TOOLS.some(tool => tool.name.startsWith("hunsu.runners.")), false);
  for (const tool of HUNSU_MCP_TOOLS) {
    if (Array.isArray(tool.inputSchema.oneOf)) {
      assert.ok(tool.inputSchema.oneOf.length >= 2);
      for (const variant of tool.inputSchema.oneOf as Array<Record<string, unknown>>) {
        assert.equal(variant.type, "object");
        assert.equal(variant.additionalProperties, false);
      }
    } else {
      assert.equal(tool.inputSchema.type, "object");
      assert.equal(tool.inputSchema.additionalProperties, false);
    }
  }
  assert.equal(tool("hunsu.nodes.graph").readOnly, true);
  assert.equal(tool("hunsu.runner_capabilities.list").readOnly, true);
  assert.equal(tool("hunsu.runner_capabilities.get").readOnly, true);
  assert.equal(tool("hunsu.events.list").readOnly, true);
  assert.equal(tool("hunsu.coach.reviews.list").readOnly, true);
  assert.equal(tool("hunsu.coach.proposals.get").readOnly, true);
  assert.equal(tool("hunsu.alternatives.get").readOnly, true);
  assert.equal(tool("hunsu.projects.rebuild").readOnly, false);
  assert.deepEqual(tool("hunsu.projects.rebuild").inputSchema.required, [
    "repository", "projectId", "idempotencyKey", "expectedStateSha", "confirmedByUser"
  ]);
  assert.equal(tool("hunsu.alternatives.compare").readOnly, false);
  assert.deepEqual(tool("hunsu.coach.proposals.get").inputSchema.required, [
    "repository", "projectId", "sourceNodeSha", "proposalId"
  ]);
  assert.deepEqual(tool("hunsu.runner_capabilities.list").inputSchema.required, ["repository"]);
  assert.equal(
    ((tool("hunsu.runner_capabilities.list").inputSchema.properties as Record<string, Record<string, unknown>>).limit?.maximum),
    50
  );
  assert.deepEqual(tool("hunsu.runner_capabilities.get").inputSchema.required, ["repository", "type"]);
  const capabilityType = (tool("hunsu.runner_capabilities.get").inputSchema.properties as Record<string, Record<string, unknown>>).type!;
  assert.deepEqual(capabilityType.required, ["origin", "key", "schemaVersion", "integrity"]);
  assert.equal(capabilityType.additionalProperties, false);
});

test("comparison write and detail reads use exact tagged anchor variants", () => {
  for (const name of ["hunsu.alternatives.compare", "hunsu.alternatives.get"] as const) {
    const variants = tool(name).inputSchema.oneOf as Array<Record<string, any>>;
    assert.equal(variants.length, 2);
    const sibling = variants.find(variant => variant.properties.comparisonType.const === "sibling_runs")!;
    const coached = variants.find(variant => variant.properties.comparisonType.const === "coached_how_experiment")!;
    assert.ok(sibling.required.includes("sourceNodeSha"));
    assert.equal(sibling.properties.anchorNodeSha, undefined);
    assert.ok(coached.required.includes("anchorNodeSha"));
    assert.equal(coached.properties.sourceNodeSha, undefined);
  }
});

test("comparison transport rejects ambiguous or mismatched anchor variants", async () => {
  let calls = 0;
  const dispatcher: McpToolDispatcher<undefined> = {
    async call(): Promise<ToolResponse<unknown>> {
      calls += 1;
      return { ok: true, data: {} };
    }
  };
  const common = {
    repository: { owner: "hunsu", name: "sample" },
    projectId: "project-a",
    comparisonType: "sibling_runs",
    sourceNodeSha: "a".repeat(40),
    comparisonId: "comparison-a"
  };
  const ambiguous = await call("hunsu.alternatives.get", {
    ...common,
    anchorNodeSha: "b".repeat(40)
  }, dispatcher);
  assert.equal(ambiguous && "error" in ambiguous && ambiguous.error.code, -32602);

  const mismatched = await call("hunsu.alternatives.get", {
    ...common,
    comparisonType: "coached_how_experiment"
  }, dispatcher);
  assert.equal(mismatched && "error" in mismatched && mismatched.error.code, -32602);
  assert.equal(calls, 0);
});

test("Run start selects one Goal digest and cannot override the Node Runner or base", () => {
  const schema = tool("hunsu.runs.start").inputSchema;
  assert.deepEqual(schema.required, [
    "repository", "projectId", "sourceNodeSha", "goalDigest", "runId", "idempotencyKey", "expectedStateSha"
  ]);
  const properties = schema.properties as Record<string, unknown>;
  assert.equal(properties.runnerId, undefined);
  assert.equal(properties.baseSha, undefined);
  assert.equal(properties.alternativeOfRunId, undefined);
  assert.equal(properties.goalId, undefined);
});

test("Node plans carry exact Goal Values and one full extensible Runner Value", () => {
  const schema = tool("hunsu.coach.propose_transition").inputSchema;
  const proposedPlan = (schema.properties as Record<string, Record<string, unknown>>).proposedPlan!;
  assert.deepEqual(proposedPlan.required, ["schema", "nextGoals", "how"]);
  assert.equal(proposedPlan.additionalProperties, false);
  const how = (proposedPlan.properties as Record<string, Record<string, unknown>>).how!;
  assert.deepEqual(how.required, ["schema", "type", "name", "value"]);
  assert.equal(how.additionalProperties, false);
  const runnerType = (how.properties as Record<string, Record<string, unknown>>).type!;
  assert.deepEqual(runnerType.required, ["origin", "key", "schemaVersion", "integrity"]);
  assert.equal((runnerType.properties as Record<string, unknown>).kind, undefined);
});

test("Project bootstrap schema directs callers to the exact repository-context CAS base", () => {
  const create = tool("hunsu.projects.create");
  const expectedStateSha = (create.inputSchema.properties as Record<string, Record<string, unknown>>).expectedStateSha!;
  assert.match(String(expectedStateSha.description), /default-branch head/u);
  assert.match(String(expectedStateSha.description), /hunsu\/state head/u);
  assert.match(tool("hunsu.projects.list").description, /initialization status/u);
  assert.match(tool("hunsu.projects.list").description, /expectedStateSha/u);
});

test("RunContract v2 contains one Goal and the full Runner Value", () => {
  const contract: RunContract = {
    schema: "hunsu.run-contract.v2",
    runId: "run-a",
    projectId: "project-a",
    sourceNodeSha: "a".repeat(40),
    goal: {
      key: "ship",
      title: "Ship",
      desiredOutcome: "Production is healthy.",
      acceptanceCriteria: ["Smoke test passes."],
      constraints: [],
      priority: 0
    },
    goalDigest: `hunsu-goal-v1:sha256:${"b".repeat(64)}`,
    runner: runnerValue(),
    runnerDigest: `hunsu-runner-v1:sha256:${"c".repeat(64)}`,
    repository: {
      installationId: 1,
      repositoryId: 2,
      owner: "hunsu",
      name: "sample",
      branch: `hunsu/run/project-a/${"a".repeat(40)}/run-a`
    },
    instructions: "Execute the selected Goal.",
    requiredEvidence: [],
    toolPolicy: { filesystem: "worktree_write", network: "enabled", approvals: "on_request" },
    lease: { expiresAt: "2026-07-14T00:00:00.000Z", checkpointAfterSeconds: 300 }
  };
  assert.equal(contract.goal.acceptanceCriteria.length, 1);
  assert.equal(contract.runner.type.key, "runner.player");
});

test("MCP requires explicit confirmation for bootstrap, Coaching, selection, and rejection", async () => {
  const namesAndArguments: readonly [string, Record<string, unknown>][] = [
    ["hunsu.projects.create", mutation({
      title: "Project A",
      rootNodeSha: "b".repeat(40),
      initialPlan: { schema: "hunsu.node-plan.v1", nextGoals: [], how: runnerValue() }
    })],
    ["hunsu.projects.rebuild", mutation({})],
    ["hunsu.coach.confirm_transition", mutation({ proposalId: "proposal-a" })],
    ["hunsu.coach.reject_transition", mutation({ proposalId: "proposal-a", reason: "Not now." })],
    ["hunsu.alternatives.select", mutation({ nodeSha: "c".repeat(40), comparisonId: "comparison-a", rationale: "Best evidence." })],
    ["hunsu.alternatives.reject", mutation({ nodeSha: "d".repeat(40), comparisonId: "comparison-a", rationale: "Failed checks." })]
  ];

  let calls = 0;
  const dispatcher: McpToolDispatcher<undefined> = {
    async call(): Promise<ToolResponse<unknown>> {
      calls += 1;
      return { ok: true, data: {} };
    }
  };
  for (const [name, argumentsValue] of namesAndArguments) {
    const response = await call(name, argumentsValue, dispatcher);
    assert.equal(structuredErrorCode(response), "confirmation_required", name);
  }
  assert.equal(calls, 0);
});

test("retired v1 Goal and Runner tools fail explicitly without dispatch aliases", async () => {
  let calls = 0;
  const dispatcher: McpToolDispatcher<undefined> = {
    async call(): Promise<ToolResponse<unknown>> {
      calls += 1;
      return { ok: true, data: {} };
    }
  };
  for (const name of ["hunsu.goals.list", "hunsu.runners.create_player", "hunsu.coach.propose_hunsu"]) {
    const response = await call(name, {}, dispatcher);
    assert.equal(structuredErrorCode(response), "unsupported_protocol_version");
  }
  assert.equal(calls, 0);
});

test("MCP rejects old Run inputs, unknown fields, and non-canonical Runner values", async () => {
  let calledName = "";
  const dispatcher: McpToolDispatcher<{ userId: string }> = {
    async call(name): Promise<ToolResponse<unknown>> {
      calledName = name;
      return { ok: true, data: { accepted: true } };
    }
  };
  const oldRun = await call("hunsu.runs.start", mutation({
    sourceNodeSha: "b".repeat(40),
    goalDigest: `hunsu-goal-v1:sha256:${"c".repeat(64)}`,
    runId: "run-a",
    runnerId: "player-a"
  }), dispatcher);
  assert.equal(oldRun && "error" in oldRun && oldRun.error.code, -32602);

  const invalidRunner = await call("hunsu.coach.propose_transition", mutation({
    sourceNodeSha: "b".repeat(40),
    sourcePayloadDigest: `hunsu-node-payload-v1:sha256:${"d".repeat(64)}`,
    proposalId: "proposal-a",
    proposedPlan: {
      schema: "hunsu.node-plan.v1",
      nextGoals: [],
      how: { ...runnerValue(), value: { invalid: undefined } }
    },
    summary: "Change executor.",
    rationale: "More reliable."
  }), dispatcher);
  assert.equal(invalidRunner && "error" in invalidRunner && invalidRunner.error.code, -32602);

  const valid = await call("hunsu.projects.list", {}, dispatcher);
  assert.equal(calledName, "hunsu.projects.list");
  assert.equal(valid && "result" in valid, true);
});

test("checkpoint and evidence inputs use explicit lifecycle variants", async () => {
  let calls = 0;
  const dispatcher: McpToolDispatcher<undefined> = {
    async call(): Promise<ToolResponse<unknown>> {
      calls += 1;
      return { ok: true, data: {} };
    }
  };

  const optionalCheckpoint = await call("hunsu.runs.checkpoint", mutation({
    runId: "run-a",
    summary: "Built.",
    commitSha: "b".repeat(40)
  }), dispatcher);
  assert.equal(optionalCheckpoint && "error" in optionalCheckpoint && optionalCheckpoint.error.code, -32602);

  const mixedLocation = await call("hunsu.runs.attach_evidence", mutation({
    runId: "run-a",
    evidence: {
      kind: "check",
      summary: "Smoke passed.",
      target: { type: "criterion", criterion: "Smoke passes." },
      location: { type: "url", url: "https://example.com/check", text: "duplicate state" }
    }
  }), dispatcher);
  assert.equal(mixedLocation && "error" in mixedLocation && mixedLocation.error.code, -32602);

  const valid = await call("hunsu.runs.attach_evidence", mutation({
    runId: "run-a",
    evidence: {
      kind: "check",
      summary: "Smoke passed.",
      target: { type: "criterion", criterion: "Smoke passes." },
      location: { type: "url", url: "https://example.com/check" }
    }
  }), dispatcher);
  assert.equal(valid && "result" in valid, true);
  assert.equal(calls, 1);
});

function runnerValue(): RunnerValue {
  return {
    schema: "hunsu.runner-value.v1" as const,
    type: {
      origin: "official",
      key: "runner.player",
      schemaVersion: "1.0.0",
      integrity: `hunsu-runner-type-v1:sha256:${"1".repeat(64)}`
    },
    name: "Repository Player",
    value: { promptTemplate: "Implement one Goal." }
  };
}

function tool(name: string) {
  const definition = HUNSU_MCP_TOOLS.find(candidate => candidate.name === name);
  assert.ok(definition, `Missing tool ${name}`);
  return definition;
}

async function call(
  name: string,
  argumentsValue: Record<string, unknown>,
  dispatcher: McpToolDispatcher<any>
) {
  return await handleMcpRequest({
    jsonrpc: "2.0",
    id: name,
    method: "tools/call",
    params: { name, arguments: argumentsValue }
  }, dispatcher, undefined);
}

function structuredErrorCode(response: Awaited<ReturnType<typeof handleMcpRequest>>): string | undefined {
  if (!response || !("result" in response)) return undefined;
  const result = response.result as { structuredContent?: { ok?: boolean; error?: { code?: string } } };
  return result.structuredContent?.error?.code;
}

function mutation(extra: Record<string, unknown>): Record<string, unknown> {
  return {
    repository: {
      installationId: 1,
      repositoryId: 2,
      owner: "hunsu",
      name: "sample",
      defaultBranch: "main"
    },
    projectId: "project-a",
    idempotencyKey: "mutation-a",
    expectedStateSha: "a".repeat(40),
    ...extra
  };
}
