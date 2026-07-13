import assert from "node:assert/strict";
import test from "node:test";
import {
  handleMcpRequest,
  HUNSU_MCP_TOOLS,
  type McpToolDispatcher,
  type ToolResponse
} from "../packages/plugin-contract/src/index.ts";

const expectedTools = [
  "hunsu.projects.list", "hunsu.projects.get", "hunsu.projects.create", "hunsu.projects.update", "hunsu.projects.rebuild",
  "hunsu.goals.list", "hunsu.goals.get", "hunsu.goals.create", "hunsu.goals.update", "hunsu.goals.pause", "hunsu.goals.complete",
  "hunsu.runners.list", "hunsu.runners.get", "hunsu.runners.create_player", "hunsu.runners.create_team", "hunsu.runners.update",
  "hunsu.runs.start", "hunsu.runs.checkpoint", "hunsu.runs.attach_evidence", "hunsu.runs.complete", "hunsu.runs.fail", "hunsu.runs.cancel",
  "hunsu.coach.review", "hunsu.coach.propose_change", "hunsu.coach.propose_hunsu",
  "hunsu.alternatives.compare", "hunsu.alternatives.select", "hunsu.alternatives.reject"
];

test("plugin contract exposes the complete command surface", () => {
  assert.deepEqual(HUNSU_MCP_TOOLS.map(tool => tool.name), expectedTools);
  assert.equal(new Set(expectedTools).size, expectedTools.length);
  for (const tool of HUNSU_MCP_TOOLS) {
    assert.equal(tool.inputSchema.type, "object");
    assert.equal(tool.inputSchema.additionalProperties, false);
  }
  assert.equal(HUNSU_MCP_TOOLS.find(tool => tool.name === "hunsu.alternatives.compare")?.readOnly, false);
  const complete = HUNSU_MCP_TOOLS.find(tool => tool.name === "hunsu.goals.complete")?.inputSchema;
  assert.ok(Array.isArray(complete?.required) && complete.required.includes("selectedRunId"));
  const createProject = HUNSU_MCP_TOOLS.find(tool => tool.name === "hunsu.projects.create")?.inputSchema;
  const repositorySchema = (createProject?.properties as Record<string, Record<string, unknown>> | undefined)?.repository;
  assert.deepEqual(repositorySchema?.required, ["owner", "name"]);
  const completeRun = HUNSU_MCP_TOOLS.find(tool => tool.name === "hunsu.runs.complete")?.inputSchema;
  const completionEvidence = ((completeRun?.properties as Record<string, Record<string, unknown>> | undefined)?.evidence?.items) as Record<string, unknown> | undefined;
  assert.ok(Array.isArray(completionEvidence?.required) && completionEvidence.required.includes("criterion"));
  const createPlayer = HUNSU_MCP_TOOLS.find(tool => tool.name === "hunsu.runners.create_player")?.inputSchema;
  const createTeam = HUNSU_MCP_TOOLS.find(tool => tool.name === "hunsu.runners.create_team")?.inputSchema;
  assert.equal((createPlayer?.properties as Record<string, unknown> | undefined)?.name, undefined);
  assert.equal((createTeam?.properties as Record<string, unknown> | undefined)?.name, undefined);
  const updateRunner = HUNSU_MCP_TOOLS.find(tool => tool.name === "hunsu.runners.update")?.inputSchema;
  const definition = (updateRunner?.properties as Record<string, Record<string, unknown>> | undefined)?.definition;
  assert.equal(definition?.additionalProperties, false);
  assert.deepEqual(definition?.required, ["kind"]);
  assert.equal(Array.isArray(definition?.oneOf), true);
});

test("MCP does not dispatch a Coach-proposed sibling start before user confirmation", async () => {
  let calls = 0;
  const dispatcher: McpToolDispatcher<undefined> = {
    async call(): Promise<ToolResponse<unknown>> {
      calls += 1;
      return { ok: true, data: {} };
    }
  };
  const response = await handleMcpRequest({
    jsonrpc: "2.0",
    id: "unconfirmed-start",
    method: "tools/call",
    params: {
      name: "hunsu.runs.start",
      arguments: mutation({
        goalId: "goal-a",
        runnerId: "player-b",
        runId: "run-b",
        baseSha: "b".repeat(40),
        alternativeOfRunId: "run-a",
        coachProposalId: "proposal-a"
      })
    }
  }, dispatcher, undefined);
  assert.equal(calls, 0);
  assert.equal(response && "result" in response, true);
  if (response && "result" in response) {
    const result = response.result as { structuredContent: { ok: boolean; error: { code: string } } };
    assert.equal(result.structuredContent.ok, false);
    assert.equal(result.structuredContent.error.code, "confirmation_required");
  }
});

test("MCP selection requires explicit user confirmation before dispatch", async () => {
  let calls = 0;
  const dispatcher: McpToolDispatcher<undefined> = {
    async call(): Promise<ToolResponse<unknown>> {
      calls += 1;
      return { ok: true, data: {} };
    }
  };
  const response = await handleMcpRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "hunsu.alternatives.select",
      arguments: mutation({ runId: "run-a", comparisonId: "comparison-a", rationale: "Best evidence" })
    }
  }, dispatcher, undefined);
  assert.equal(calls, 0);
  assert.equal(response && "result" in response, true);
  if (response && "result" in response) {
    const result = response.result as { structuredContent: { ok: boolean; error: { code: string } } };
    assert.equal(result.structuredContent.ok, false);
    assert.equal(result.structuredContent.error.code, "confirmation_required");
  }
});

test("MCP rejects unknown fields and dispatches validated calls", async () => {
  let calledName = "";
  const dispatcher: McpToolDispatcher<{ userId: string }> = {
    async call(name): Promise<ToolResponse<unknown>> {
      calledName = name;
      return { ok: true, data: { accepted: true } };
    }
  };
  const invalid = await handleMcpRequest({
    jsonrpc: "2.0",
    id: "bad",
    method: "tools/call",
    params: { name: "hunsu.projects.list", arguments: { installationId: 1, credential: "no" } }
  }, dispatcher, { userId: "user-1" });
  assert.equal(invalid && "error" in invalid && invalid.error.code, -32602);

  const ignoredRunnerName = await handleMcpRequest({
    jsonrpc: "2.0",
    id: "named-runner",
    method: "tools/call",
    params: {
      name: "hunsu.runners.create_player",
      arguments: mutation({
        runnerId: "player-a",
        name: "Ignored display name",
        promptTemplate: "Implement the Goal.",
        resources: [],
        runtimePolicy: { filesystem: "read_only", network: "disabled", approvals: "never" }
      })
    }
  }, dispatcher, { userId: "user-1" });
  assert.equal(ignoredRunnerName && "error" in ignoredRunnerName && ignoredRunnerName.error.code, -32602);

  const valid = await handleMcpRequest({
    jsonrpc: "2.0",
    id: "good",
    method: "tools/call",
    params: { name: "hunsu.projects.list", arguments: {} }
  }, dispatcher, { userId: "user-1" });
  assert.equal(calledName, "hunsu.projects.list");
  assert.equal(valid && "result" in valid, true);
});

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
