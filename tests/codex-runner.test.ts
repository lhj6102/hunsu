import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import {
  buildTeamPlanningPrompt,
  buildHunsuDraftPrompt,
  buildMoveFinalizerPrompt,
  buildMemberPathPrompt,
  CodexAppServerClient,
  CodexAppServerRunner,
  createDefaultCodexRunner,
  DEFAULT_TEAM_INSTRUCTION,
  TEAM_EXECUTION_PLAN_SCHEMA
} from "../packages/codex-runner/src/index.ts";
import type { CodexAppServerTransport } from "../packages/codex-runner/src/index.ts";
import type { MoveFinalizerInput, MemberPathRunInput, RunnerEvent, StartRunInput } from "../packages/codex-runner/src/index.ts";
import {
  createDefaultHarness,
  createDefaultManagerConfig,
  createDefaultMemberConfig,
  makeDestinationId,
  makeDestinationTitle,
  makeHunsuId,
  makeLineId,
  makeNodeId,
  makeNonEmptyText,
  makePositiveInteger,
  makeRequestGoal,
  makeRequestId,
  makeRequestTitle,
  promptTemplateFromText
} from "../packages/protocol/src/index.ts";
import type { BoardProjection, HarnessSnapshot, NonEmptyText } from "../packages/protocol/src/index.ts";

function requireDomainValue<T>(result: { ok: true; value: T } | { ok: false; error: { message: string } }): T {
  if (result.ok) {
    return result.value;
  }
  throw new Error(result.error.message);
}

function nt(value: string): NonEmptyText {
  return value as NonEmptyText;
}

function assertStrictObjectSchemas(schema: unknown, path = "schema"): void {
  if (!schema || typeof schema !== "object") return;
  const node = schema as Record<string, unknown>;
  const types = Array.isArray(node.type) ? node.type : [node.type];
  if (types.includes("object")) {
    assert.equal(node.additionalProperties, false, `${path} must set additionalProperties: false`);
  }
  const properties = node.properties;
  if (properties && typeof properties === "object") {
    const propertyKeys = Object.keys(properties);
    assert.deepEqual(node.required, propertyKeys, `${path} must require every property for strict structured output`);
    for (const [key, value] of Object.entries(properties as Record<string, unknown>)) {
      assertStrictObjectSchemas(value, `${path}.properties.${key}`);
    }
  }
  if (node.items) {
    assertStrictObjectSchemas(node.items, `${path}.items`);
  }
}

function requestId(value: string) {
  return requireDomainValue(makeRequestId(value));
}

function destinationId(value: string) {
  return requireDomainValue(makeDestinationId(value));
}

function destinationTitle(value: string) {
  return requireDomainValue(makeDestinationTitle(value));
}

function lineId(value: string) {
  return requireDomainValue(makeLineId(value));
}

function nodeId(value: string) {
  return requireDomainValue(makeNodeId(value));
}

function hunsuId(value: string) {
  return requireDomainValue(makeHunsuId(value));
}

function requestTitle(value: string) {
  return requireDomainValue(makeRequestTitle(value));
}

function requestGoal(value: string) {
  return requireDomainValue(makeRequestGoal(value));
}

test("Codex runner TEAM prompt stays focused on objective and hides Hunsu domain mechanics", () => {
  const prompt = buildTeamPlanningPrompt({
    runId: "run/req_001",
    repositoryPath: "/repo",
    requestGoal: "Build Studio",
    harness: createDefaultHarness("Keep changes small."),
    selectedDestinationIds: ["destination_001"],
    activeDestinations: [
      {
        id: destinationId("destination_001"),
        requestId: requestId("req_001"),
        title: destinationTitle("Wire Bridge server commands"),
        status: "pending",
        source: "initial-execute-team",
        createdBy: "SYSTEM",
        updatedBy: "SYSTEM"
      }
    ],
    previousMemberOutputs: ["Add coverage for the server command path."],
    board: createBoard()
  });

  assert.match(prompt, /^<role>[\s\S]*<\/role>\n\n<goal>[\s\S]*<\/goal>\n\n<member_profiles>[\s\S]*<\/member_profiles>\n\n<rules>[\s\S]*<\/rules>$/);
  assert.match(prompt, /<purpose>[\s\S]*Plan a closure-free executable ExecutionPlan/);
  assert.match(prompt, /<instructions>[\s\S]*Keep changes small/);
  assert.match(prompt, /Wire Bridge server commands/);
  assert.match(prompt, /Keep the GUI local-first/);
  assert.match(prompt, /<member id="azir">[\s\S]*Plan briefly, then implement/);
  assert.match(prompt, /<member id="galio">[\s\S]*Verify the completed work/);
  assert.match(prompt, /root kind queue/);
  assert.match(prompt, /queue items array as kind goal with stage needs_evaluation/);
  assert.match(prompt, /Set remainingAttempts to 5/);
  assert.match(prompt, /Set requires to PrevMove/);
  assert.doesNotMatch(prompt, /You are the Team|Hunsu Execute|Resolved Harness|Prompt Template|Output schema|MemberPath|\.hunsu|MOVE|Roadmap/);
  assert.doesNotMatch(prompt, /Add coverage for the server command path|ARRIVED|ACCIDENT|Final response schema|CLI contract/);
});

test("Codex runner Team structured output schema describes ExecutionPlan without composition keywords", () => {
  assert.doesNotMatch(JSON.stringify(TEAM_EXECUTION_PLAN_SCHEMA), /oneOf|anyOf|allOf/);
  assertStrictObjectSchemas(TEAM_EXECUTION_PLAN_SCHEMA);
  assert.equal(TEAM_EXECUTION_PLAN_SCHEMA.type, "object");
  assert.deepEqual(TEAM_EXECUTION_PLAN_SCHEMA.required, ["kind", "id", "items"]);
  assert.deepEqual(TEAM_EXECUTION_PLAN_SCHEMA.properties.kind.enum, ["queue"]);
  assert.equal(TEAM_EXECUTION_PLAN_SCHEMA.properties.items.items.additionalProperties, false);
  assert.deepEqual(TEAM_EXECUTION_PLAN_SCHEMA.properties.items.items.properties.kind.enum, ["goal"]);
  assert.deepEqual(TEAM_EXECUTION_PLAN_SCHEMA.properties.items.items.properties.stage.enum, ["needs_evaluation"]);
  assert.deepEqual(TEAM_EXECUTION_PLAN_SCHEMA.properties.items.items.properties.requires.type, ["string", "array"]);
  assert.deepEqual(TEAM_EXECUTION_PLAN_SCHEMA.properties.items.items.properties.assignee.properties.executorId, {
    type: "string"
  });
});

test("Codex runner HUNSU Draft prompt uses file-backed request editing", () => {
  const draftInput = createHunsuDraftInput();
  const draftPrompt = buildHunsuDraftPrompt(draftInput);

  assert.match(draftPrompt, /Hunsu Draft agent/);
  assert.match(draftPrompt, /<manager>[\s\S]*manager\.hunsu\.default/);
  assert.match(draftPrompt, /Discuss HUNSU changes conversationally/);
  assert.match(draftPrompt, /Faker M000/);
  assert.match(draftPrompt, /\.hunsu-request\/destinations\.json/);
  assert.match(draftPrompt, /\.hunsu-request\/harness\.json/);
  assert.match(draftPrompt, /\.hunsu-request\/executors\.json/);
  assert.match(draftPrompt, /\.hunsu-request\/resources\.json/);
  assert.match(draftPrompt, /\.hunsu-request\/artifact-actions\.json/);
  assert.match(draftPrompt, /Do not edit \.hunsu\/ encoded runtime files, \.hunsu-prev\/, product files/);
  assert.match(draftPrompt, /<draft_check_command>/);
  assert.match(draftPrompt, /\/diff-artifacts/);
  assert.match(draftPrompt, /::hunsu-diff/);
  assert.match(draftPrompt, /diffArtifactId/);
  assert.match(draftPrompt, /simple TODO\/Destination addition, edit only \.hunsu-request\/destinations\.json/);
  assert.match(draftPrompt, /Edit only the files required by the user's explicit request/);
  assert.match(draftPrompt, /Do not edit \.hunsu-request\/harness\.json unless the user explicitly asks to change root Team or Harness policy/);
  assert.match(draftPrompt, /Do not edit \.hunsu-request\/executors\.json unless the user explicitly asks to change Member definitions or Member config/);
  assert.match(draftPrompt, /Do not edit \.hunsu-request\/resources\.json unless the user explicitly asks to change Resource bindings or requirements/);
  assert.match(draftPrompt, /Do not create, copy, or update Resource bindings or assignment entries for newly added Destinations/);
  assert.doesNotMatch(draftPrompt, /runtime binding changes/);
  assert.doesNotMatch(draftPrompt, /Artifact Action changes only/);
  assert.doesNotMatch(draftPrompt, /Draft check must pass before approval/);
});

test("Codex runner planning prompt lists available Members", () => {
  const protocol: HarnessSnapshot = {
    kind: "role_squad",
    maxRoundCount: requireDomainValue(makePositiveInteger(3, "maxRoundCount")),
    team: { promptTemplate: promptTemplateFromText("Plan for {{ currentDestination.title }} first.") },
    members: [
      createDefaultMemberConfig("planner", "Plan first."),
      createDefaultMemberConfig("implementer", "Implement."),
      createDefaultMemberConfig("reviewer", "Review."),
      createDefaultMemberConfig("integrator", "Integrate.")
    ]
  };

  const prompt = buildTeamPlanningPrompt({
    ...createRunInput(),
    harness: protocol
  });
  assert.match(prompt, /<instructions>[\s\S]*Plan for Wire Bridge server commands first/);
  assert.match(prompt, /<member id="planner">[\s\S]*<profile>[\s\S]*Plan first/);
  assert.match(prompt, /<member id="integrator">[\s\S]*<profile>[\s\S]*Integrate/);
});

test("Codex runner planning prompt falls back to the default Team instruction", () => {
  const protocol: HarnessSnapshot = {
    kind: "team_execution_plan",
    maxAttemptCount: requireDomainValue(makePositiveInteger(3, "maxAttemptCount")),
    team: { promptTemplate: promptTemplateFromText("   ") },
    members: [createDefaultMemberConfig("azir", "Implement."), createDefaultMemberConfig("galio", "Verify.")]
  };

  const prompt = buildTeamPlanningPrompt({
    ...createRunInput(),
    harness: protocol
  });
  assert.match(prompt, new RegExp(`<instructions>[\\s\\S]*${DEFAULT_TEAM_INSTRUCTION}`));
});

test("Codex runner Member prompt nudges execution without inline skills or Hunsu path metadata", () => {
  const prompt = buildMemberPathPrompt({
    ...createMemberPathInput(),
    harness: createDefaultHarness("Use member-bound skills.", [{
      kind: "local-snapshot",
      name: nt("ui-inspector"),
      sourcePath: nt("origin:test/ui-inspector"),
      contentHash: nt("hash-ui-inspector"),
      snapshotRef: nt("codex-skill:hash-ui-inspector"),
      snapshotFiles: [
        { path: nt("SKILL.md"), text: "# UI Inspector\n\nUse the browser snapshot before changing layout.\n" },
        { path: nt("references/checks.md"), text: "Confirm the selected MOVE remains playable.\n" }
      ]
    }])
  });

  assert.match(prompt, /^<member>[\s\S]*<\/member>\n\n<goal>[\s\S]*<\/goal>\n\n<constraints>[\s\S]*<\/constraints>$/);
  assert.match(prompt, /Do not read \.hunsu files\./);
  assert.match(prompt, /Do not create commits\./);
  assert.match(prompt, /Use bounded commands for verification/);
  assert.match(prompt, /If you start a preview server, dev server, watcher, or any other long-running command, stop it before your final response\./);
  assert.match(prompt, /Do not leave running command sessions, local listeners, or background processes open at the end of the turn\./);
  assert.match(prompt, /Implement the selected Destination/);
  assert.doesNotMatch(prompt, /Member Path|executorId|requires|ui-inspector|SKILL\.md|browser snapshot|Worktree status|Dependency outputs|Attempt transcript/);
});

test("Codex runner Member prompt stays focused on natural-language execution work", () => {
  const prompt = buildMemberPathPrompt({
    ...createMemberPathInput({
      memberPath: {
        ...memberPath("verify", "galio", "Verify the endpoint and report what you observed.", ["implement"])
      },
      dependencyOutputs: ["Implemented the endpoint."],
      attemptTranscript: "attempt 1: checked endpoint"
    }),
    attemptOrdinal: 2,
    maxAttemptCount: 5,
    worktreeStatus: "clean: false",
    worktreeDiff: "diff --git a/server.ts b/server.ts"
  });

  assert.match(prompt, /<member>[\s\S]*Verify the completed work against the focused goal/);
  assert.match(prompt, /<goal>[\s\S]*Verify the endpoint and report what you observed/);
  assert.match(prompt, /Do not read \.hunsu files\./);
  assert.match(prompt, /long-running command, stop it before your final response/);
  assert.doesNotMatch(prompt, /PASS|RETRY|galio|diff --git|attempt 1|Implemented the endpoint|executorId|requires|Worktree status|Attempt transcript|structured output/);
});

test("Codex runner MOVE finalizer prompt asks only for the final commit message", () => {
  const prompt = buildMoveFinalizerPrompt(createMoveFinalizerInput());

  assert.match(prompt, /MOVE finalizer/);
  assert.match(prompt, /Source MOVE commit: commit_prev/);
  assert.match(prompt, /Terminal Path commit: commit_verify/);
  assert.match(prompt, /implement \(azir\)/);
  assert.match(prompt, /Verify the implementation/);
  assert.match(prompt, /auto.txt/);
  assert.match(prompt, /Return only the commit message content/);
  assert.match(prompt, /Studio appends system trailers/);
  assert.match(prompt, /Do not create Git commits/);
  assert.doesNotMatch(prompt, /Terminal verdict|reachedDestinationIds|PASS|RETRY/);
});

test("CodexAppServerRunner starts a Team turn and maps app-server events", async () => {
  const transport = new MockAppServerTransport();
  const runner = createMockAppServerRunner(transport);
  const collected = collectRunnerEvents(runner.events("run/req_001"));
  const runPromise = runner.runTeamPlanning(createRunInput());

  respondTo(await transport.waitForRequest("initialize"), transport, {
    userAgent: "codex-app-server/0.0.0",
    codexHome: "/tmp/codex",
    platformFamily: "unix",
    platformOs: "linux"
  });
  await waitFor(() => transport.sent.some(message => message.method === "initialized"));

  const threadStart = await transport.waitForRequest("thread/start");
  assert.equal(threadStart.params?.cwd, "/repo");
  assert.equal(threadStart.params?.approvalPolicy, "never");
  assert.equal(threadStart.params?.approvalsReviewer, "user");
  assert.equal(threadStart.params?.sandbox, "read-only");
  respondTo(threadStart, transport, { thread: { id: "thread_app_team" } });

  await respondToProviderGoalClear(transport, "thread_app_team");
  const turnStart = await transport.waitForRequest("turn/start");
  assertNoProviderGoalSet(transport);
  assert.equal(turnStart.params?.threadId, "thread_app_team");
  assert.equal(turnStart.params?.sandboxPolicy?.type, "readOnly");
  assert.equal(turnStart.params?.sandboxPolicy?.networkAccess, false);
  assert.deepEqual(turnStart.params?.outputSchema, TEAM_EXECUTION_PLAN_SCHEMA);
  assert.match(turnStart.params?.input?.[0]?.text ?? "", /Wire Bridge server commands/);
  respondTo(turnStart, transport, { turn: { id: "turn_team_001", status: "inProgress", items: [] } });

  transport.emit({
    method: "turn/started",
    params: { threadId: "thread_app_team", turn: { id: "turn_team_001", status: "inProgress", items: [] } }
  });
  transport.emit({
    method: "item/started",
    params: {
      threadId: "thread_app_team",
      turnId: "turn_team_001",
      item: {
        type: "userMessage",
        id: "user_001",
        content: [{ type: "text", text: "Inspect the repository and report the preview command." }]
      }
    }
  });
  transport.emit({
    method: "item/started",
    params: {
      threadId: "thread_app_team",
      turnId: "turn_team_001",
      startedAtMs: 1,
      item: { type: "commandExecution", id: "cmd_001", command: "pnpm test", cwd: "/repo", status: "inProgress" }
    }
  });
  transport.emit({
    method: "item/commandExecution/outputDelta",
    params: {
      threadId: "thread_app_team",
      turnId: "turn_team_001",
      itemId: "cmd_001",
      delta: "running tests\n"
    }
  });
  transport.emit({
    method: "item/completed",
    params: {
      threadId: "thread_app_team",
      turnId: "turn_team_001",
      completedAtMs: 2,
      item: { type: "commandExecution", id: "cmd_001", command: "pnpm test", cwd: "/repo", status: "completed", aggregatedOutput: "ok", exitCode: 0 }
    }
  });
  transport.emit({
    method: "thread/tokenUsage/updated",
    params: {
      threadId: "thread_app_team",
      turnId: "turn_team_001",
      tokenUsage: {
        last: { inputTokens: 11, cachedInputTokens: 2, outputTokens: 5, reasoningOutputTokens: 1, totalTokens: 16 },
        total: { inputTokens: 11, cachedInputTokens: 2, outputTokens: 5, reasoningOutputTokens: 1, totalTokens: 16 },
        modelContextWindow: 1000
      }
    }
  });
  transport.emit({
    method: "item/started",
    params: {
      threadId: "thread_app_team",
      turnId: "turn_team_001",
      startedAtMs: 3,
      item: { type: "fileChange", id: "file_001", changes: [{ path: "src/app.ts", kind: "update" }], status: "inProgress" }
    }
  });
  transport.emit({
    method: "item/completed",
    params: {
      threadId: "thread_app_team",
      turnId: "turn_team_001",
      completedAtMs: 4,
      item: { type: "fileChange", id: "file_001", changes: [{ path: "src/app.ts", kind: "update" }], status: "completed" }
    }
  });
  for (const [method, delta, encoding] of [
    ["item/agentMessage/delta", "H", "plain"],
    ["item/agentMessage/textDelta", "e", "base64"],
    ["item/agentMessage/outputDelta", "l", "plain"],
    ["item/assistantMessage/textDelta", "l", "plain"],
    ["item/assistantMessage/outputDelta", "o", "plain"]
  ] as const) {
    transport.emit({
      method,
      params: {
        threadId: "thread_app_team",
        turnId: "turn_team_001",
        itemId: "msg_001",
        ...(encoding === "base64" ? { deltaBase64: Buffer.from(delta, "utf8").toString("base64") } : { delta })
      }
    });
  }
  transport.emit({
    method: "item/completed",
    params: {
      threadId: "thread_app_team",
      turnId: "turn_team_001",
      completedAtMs: 5,
      item: { type: "agentMessage", id: "msg_001", text: "Hello", phase: null, memoryCitation: null }
    }
  });
  transport.emit({
    method: "turn/completed",
    params: {
      threadId: "thread_app_team",
      turn: {
        id: "turn_team_001",
        status: "completed",
        items: [{ type: "agentMessage", id: "msg_001", text: "Hello" }],
        itemsView: { type: "complete" },
        error: null
      }
    }
  });

  const result = await runPromise;
  const events = await collected;

  assert.equal(result.providerThreadId, "thread_app_team");
  assert.equal(result.providerTurnId, "turn_team_001");
  assert.equal(result.finalResponse, "Hello");
  assert.equal(events.some(event => event.type === "runner.appServer.message" && event.method === "turn/started"), true);
  assert.equal(events.some(event => event.type === "runner.turn.started" && event.providerTurnId === "turn_team_001"), true);
  assert.equal(events.some(event => event.type === "runner.item.started" && event.item.type === "userMessage" && event.item.text === "Inspect the repository and report the preview command."), true);
  assert.equal(events.some(event => event.type === "runner.item.started" && event.item.type === "commandExecution" && event.itemId === "cmd_001"), true);
  assert.equal(events.some(event => event.type === "runner.item.delta" && event.itemId === "cmd_001" && event.deltaKind === "commandOutput" && event.delta === "running tests\n"), true);
  assert.equal(events.some(event => event.type === "runner.item.completed" && event.item.type === "fileChange" && event.itemId === "file_001"), true);
  assert.deepEqual(events.filter(isAgentMessageDelta).map(event => event.delta), ["H", "e", "l", "l", "o"]);
  assert.equal(events.some(event => event.type === "runner.item.completed" && event.item.type === "agentMessage" && event.item.text === "Hello"), true);
  assert.equal(events.find(isFinalEvent)?.finalResponse, "Hello");
  assert.match(JSON.stringify(result.rawResult), /input_tokens/);
});

test("CodexAppServerRunner cleans background terminals when a final response arrives with an active command", async () => {
  const transport = new MockAppServerTransport();
  const runner = createMockAppServerRunner(transport);
  const runPromise = runner.runMemberPath(createMemberPathInput({
    memberPath: memberPath("verify", "galio", "Verify the implementation and report what you observed.", ["implement"])
  }));

  respondTo(await transport.waitForRequest("initialize"), transport, {});
  respondTo(await transport.waitForRequest("thread/start"), transport, { thread: { id: "thread_cleanup" } });
  await respondToTeamGoal(transport, "thread_cleanup", /Verify the implementation and report what you observed/, false);
  const turnStart = await transport.waitForRequest("turn/start");
  respondTo(turnStart, transport, { turn: { id: "turn_cleanup", status: "inProgress", items: [] } });
  transport.emit({
    method: "turn/started",
    params: { threadId: "thread_cleanup", turn: { id: "turn_cleanup", status: "inProgress", items: [] } }
  });
  transport.emit({
    method: "item/started",
    params: {
      threadId: "thread_cleanup",
      turnId: "turn_cleanup",
      item: {
        type: "commandExecution",
        id: "cmd_preview",
        command: "pnpm run preview",
        cwd: "/repo",
        processId: "process_preview",
        status: "inProgress"
      }
    }
  });
  transport.emit({
    method: "item/completed",
    params: {
      threadId: "thread_cleanup",
      turnId: "turn_cleanup",
      item: { type: "agentMessage", id: "msg_cleanup", text: "Verified the preview and stopped the server." }
    }
  });
  const cleanup = await transport.waitForRequest("thread/backgroundTerminals/clean");
  assert.deepEqual(cleanup.params, { threadId: "thread_cleanup" });
  respondTo(cleanup, transport, {});
  transport.emit({
    method: "turn/completed",
    params: {
      threadId: "thread_cleanup",
      turn: {
        id: "turn_cleanup",
        status: "completed",
        items: [{ type: "agentMessage", id: "msg_cleanup", text: "Verified the preview and stopped the server." }],
        error: null
      }
    }
  });

  const result = await runPromise;
  assert.equal(result.finalResponse, "Verified the preview and stopped the server.");
});

test("CodexAppServerRunner does not revive closed event subscribers between turns", async () => {
  const transport = new MockAppServerTransport();
  const runner = createMockAppServerRunner(transport);
  const staleIterator = runner.events("run/req_001")[Symbol.asyncIterator]();
  const firstStaleEvent = staleIterator.next();

  const firstRun = runner.runTeamPlanning(createRunInput());
  respondTo(await transport.waitForRequest("initialize"), transport, {});
  await completeTeamTurn(transport, {
    threadId: "thread_first",
    turnId: "turn_first",
    itemId: "msg_first",
    delta: "first",
    since: 0
  });
  await firstRun;
  const firstStaleResult = await firstStaleEvent;
  assert.equal(firstStaleResult.done, false);

  const secondStart = transport.sent.length;
  const secondRun = runner.runTeamPlanning(createRunInput());
  await completeTeamTurn(transport, {
    threadId: "thread_second",
    turnId: "turn_second",
    itemId: "msg_second",
    delta: "second",
    since: secondStart
  });
  await secondRun;

  const staleEvents = await drainRunnerEvents(staleIterator);
  const staleDeltas = [firstStaleResult.value, ...staleEvents]
    .filter(isAgentMessageDelta)
    .map(event => event.delta);
  assert.deepEqual(staleDeltas, ["first"]);
});

test("CodexAppServerRunner runs verifying Member Path read-only without structured output schema", async () => {
  const transport = new MockAppServerTransport();
  const runner = createMockAppServerRunner(transport);
  const runPromise = runner.runMemberPath(createMemberPathInput({
    memberPath: {
      ...memberPath("verify", "galio", "Verify the implementation and report what you observed.", ["implement"])
    }
  }));

  respondTo(await transport.waitForRequest("initialize"), transport, {});
  respondTo(await transport.waitForRequest("thread/start"), transport, { thread: { id: "thread_app_member" } });
  await respondToTeamGoal(transport, "thread_app_member", /Verify the implementation and report what you observed/, false);
  const turnStart = await transport.waitForRequest("turn/start");
  assert.equal(turnStart.params?.sandboxPolicy?.type, "readOnly");
  assert.equal(turnStart.params?.sandboxPolicy?.networkAccess, false);
  assert.equal(turnStart.params?.approvalPolicy, "never");
  assert.equal(turnStart.params?.approvalsReviewer, "user");
  assert.equal(turnStart.params?.outputSchema, null);
  respondTo(turnStart, transport, {
    turn: {
      id: "turn_member_001",
      status: "completed",
      items: [{
        type: "agentMessage",
        id: "msg_member",
        text: "Verified the implementation and the endpoint responded as expected."
      }],
      error: null
    }
  });

  const result = await runPromise;
  assert.equal(result.providerThreadId, "thread_app_member");
  assert.equal(result.providerTurnId, "turn_member_001");
  assert.match(result.finalResponse ?? "", /endpoint responded as expected/);
});

test("CodexAppServerRunner maps worktree-write Member auto-review approval to app-server options", async () => {
  const transport = new MockAppServerTransport();
  const runner = createMockAppServerRunner(transport);
  const protocol = createDefaultHarness("Plan the implementation.");
  if (protocol.kind === "team_execution_plan") {
    protocol.members = [
      createDefaultMemberConfig("ryze", "Build the focused goal.", [], { kind: "worktree_write", network: "disabled" }, { policy: "on_request", reviewer: "auto_review" })
    ];
  }
  const runPromise = runner.runMemberPath(createMemberPathInput({
    harness: protocol,
    memberPath: memberPath("build", "ryze", "Build and verify the focused goal.", "PrevMove"),
    outputSchema: { type: "object" }
  }));

  respondTo(await transport.waitForRequest("initialize"), transport, {});
  respondTo(await transport.waitForRequest("thread/start"), transport, { thread: { id: "thread_app_ryze" } });
  await respondToProviderGoalClear(transport, "thread_app_ryze");
  const turnStart = await transport.waitForRequest("turn/start");
  assertNoProviderGoalSet(transport);
  assert.equal(turnStart.params?.sandboxPolicy?.type, "workspaceWrite");
  assert.deepEqual(turnStart.params?.sandboxPolicy?.writableRoots, ["/repo"]);
  assert.equal(turnStart.params?.sandboxPolicy?.networkAccess, false);
  assert.equal(turnStart.params?.approvalPolicy, "on-request");
  assert.equal(turnStart.params?.approvalsReviewer, "auto_review");
  respondTo(turnStart, transport, {
    turn: {
      id: "turn_ryze_001",
      status: "completed",
      items: [{ type: "agentMessage", id: "msg_ryze", text: "Changed the worktree." }],
      error: null
    }
  });

  const result = await runPromise;
  assert.equal(result.providerThreadId, "thread_app_ryze");
  assert.equal(result.providerTurnId, "turn_ryze_001");
});

test("CodexAppServerRunner applies resolved model selection over Member defaults", async () => {
  const transport = new MockAppServerTransport();
  const runner = createMockAppServerRunner(transport);
  const runPromise = runner.runTeamPlanning(createRunInput({
    resolvedModelSelection: {
      providerId: "codex",
      model: "gpt-5.5-thinking",
      reasoningEffort: "xhigh",
      serviceTier: "fast"
    }
  }));

  respondTo(await transport.waitForRequest("initialize"), transport, {});
  const threadStart = await transport.waitForRequest("thread/start");
  assert.equal(threadStart.params?.model, "gpt-5.5-thinking");
  assert.equal(threadStart.params?.serviceTier, "fast");
  respondTo(threadStart, transport, { thread: { id: "thread_model_alias" } });
  await respondToProviderGoalClear(transport, "thread_model_alias");
  const turnStart = await transport.waitForRequest("turn/start");
  assert.equal(turnStart.params?.model, "gpt-5.5-thinking");
  assert.equal(turnStart.params?.effort, "xhigh");
  assert.equal(turnStart.params?.serviceTier, "fast");
  respondTo(turnStart, transport, {
    turn: {
      id: "turn_model_alias",
      status: "completed",
      items: [{ type: "agentMessage", id: "msg_model_alias", text: "{\"kind\":\"queue\",\"id\":\"plan\",\"items\":[]}" }],
      error: null
    }
  });

  const result = await runPromise;
  assert.equal(result.providerThreadId, "thread_model_alias");
  assert.equal(result.providerTurnId, "turn_model_alias");
});

test("CodexAppServerRunner maps direct Member modelSelection to app-server options", async () => {
  const transport = new MockAppServerTransport();
  const runner = createMockAppServerRunner(transport);
  const protocol = createDefaultHarness("Run the selected member.");
  if (protocol.kind === "team_execution_plan") {
    const member = createDefaultMemberConfig("azir", "Implement the selected goal.");
    member.modelSelection = {
      kind: "direct",
      provider: {
        providerId: "codex",
        model: "gpt-5.5",
        reasoningEffort: "medium",
        serviceTier: "fast"
      }
    };
    member.model = "codex-default" as typeof member.model;
    member.reasoningEffort = "default";
    member.serviceTier = "default";
    protocol.members = [member];
  }
  const runPromise = runner.runMemberPath(createMemberPathInput({
    harness: protocol,
    memberPath: memberPath("build", "azir", "Build and verify the focused goal.", "PrevMove"),
    outputSchema: { type: "object" }
  }));

  respondTo(await transport.waitForRequest("initialize"), transport, {});
  const threadStart = await transport.waitForRequest("thread/start");
  assert.equal(threadStart.params?.model, "gpt-5.5");
  assert.equal(threadStart.params?.serviceTier, "fast");
  respondTo(threadStart, transport, { thread: { id: "thread_member_selection" } });
  await respondToProviderGoalClear(transport, "thread_member_selection");
  const turnStart = await transport.waitForRequest("turn/start");
  assert.equal(turnStart.params?.model, "gpt-5.5");
  assert.equal(turnStart.params?.effort, "medium");
  assert.equal(turnStart.params?.serviceTier, "fast");
  respondTo(turnStart, transport, {
    turn: {
      id: "turn_member_selection",
      status: "completed",
      items: [{ type: "agentMessage", id: "msg_member_selection", text: "Changed the worktree." }],
      error: null
    }
  });

  const result = await runPromise;
  assert.equal(result.providerThreadId, "thread_member_selection");
  assert.equal(result.providerTurnId, "turn_member_selection");
});

test("CodexAppServerRunner maps direct Hunsu Draft Manager modelSelection to app-server options", async () => {
  const transport = new MockAppServerTransport();
  const runner = createMockAppServerRunner(transport);
  const manager = {
    ...createDefaultManagerConfig(),
    modelSelection: {
      kind: "direct" as const,
      provider: {
        providerId: "codex" as const,
        model: "gpt-5.5" as const,
        reasoningEffort: "low" as const,
        serviceTier: "fast" as const
      }
    }
  };
  const runPromise = runner.prepareHunsuDraftSession!({
    ...createHunsuDraftInput(),
    manager
  });

  respondTo(await transport.waitForRequest("initialize"), transport, {});
  const threadStart = await transport.waitForRequest("thread/start");
  assert.equal(threadStart.params?.model, "gpt-5.5");
  assert.equal(threadStart.params?.serviceTier, "fast");
  respondTo(threadStart, transport, { thread: { id: "thread_manager_selection" } });
  await respondToTeamGoal(transport, "thread_manager_selection", /Discuss HUNSU changes conversationally/, false);

  const result = await runPromise;
  assert.equal(result.providerThreadId, "thread_manager_selection");
});

test("CodexAppServerRunner maps user-reviewed Member approval to app-server options", async () => {
  const transport = new MockAppServerTransport();
  const runner = createMockAppServerRunner(transport);
  const protocol = createDefaultHarness("Plan the implementation.");
  if (protocol.kind === "team_execution_plan") {
    protocol.members = [
      createDefaultMemberConfig("leona", "Build the focused goal.", [], { kind: "worktree_write", network: "disabled" }, { policy: "on_request", reviewer: "user" })
    ];
  }
  const runPromise = runner.runMemberPath(createMemberPathInput({
    harness: protocol,
    memberPath: memberPath("build", "leona", "Build and verify the focused goal.", "PrevMove"),
    outputSchema: { type: "object" }
  }));

  respondTo(await transport.waitForRequest("initialize"), transport, {});
  respondTo(await transport.waitForRequest("thread/start"), transport, { thread: { id: "thread_app_leona" } });
  await respondToProviderGoalClear(transport, "thread_app_leona");
  const turnStart = await transport.waitForRequest("turn/start");
  assertNoProviderGoalSet(transport);
  assert.equal(turnStart.params?.sandboxPolicy?.type, "workspaceWrite");
  assert.equal(turnStart.params?.approvalPolicy, "on-request");
  assert.equal(turnStart.params?.approvalsReviewer, "user");
  respondTo(turnStart, transport, {
    turn: {
      id: "turn_leona_001",
      status: "completed",
      items: [{ type: "agentMessage", id: "msg_leona", text: "Changed the worktree." }],
      error: null
    }
  });

  const result = await runPromise;
  assert.equal(result.providerThreadId, "thread_app_leona");
  assert.equal(result.providerTurnId, "turn_leona_001");
});

test("CodexAppServerRunner maps unrestricted Member execution to dangerFullAccess sandbox", async () => {
  const transport = new MockAppServerTransport();
  const runner = createMockAppServerRunner(transport);
  const protocol = createDefaultHarness("Plan the implementation.");
  if (protocol.kind === "team_execution_plan") {
    protocol.members = [
      createDefaultMemberConfig("ezreal", "Use full access for the focused goal.", [], { kind: "unrestricted", network: "enabled" }, { policy: "never" })
    ];
  }
  const runPromise = runner.runMemberPath(createMemberPathInput({
    harness: protocol,
    memberPath: memberPath("full-access", "ezreal", "Use full access for the focused goal.", "PrevMove"),
    outputSchema: { type: "object" }
  }));

  respondTo(await transport.waitForRequest("initialize"), transport, {});
  respondTo(await transport.waitForRequest("thread/start"), transport, { thread: { id: "thread_app_ezreal" } });
  await respondToProviderGoalClear(transport, "thread_app_ezreal");
  const turnStart = await transport.waitForRequest("turn/start");
  assertNoProviderGoalSet(transport);
  assert.equal(turnStart.params?.sandboxPolicy?.type, "dangerFullAccess");
  assert.equal(turnStart.params?.sandboxPolicy?.networkAccess, true);
  assert.equal(turnStart.params?.approvalPolicy, "never");
  assert.equal(turnStart.params?.approvalsReviewer, "user");
  respondTo(turnStart, transport, {
    turn: {
      id: "turn_ezreal_001",
      status: "completed",
      items: [{ type: "agentMessage", id: "msg_ezreal", text: "Used full access." }],
      error: null
    }
  });

  const result = await runPromise;
  assert.equal(result.providerThreadId, "thread_app_ezreal");
  assert.equal(result.providerTurnId, "turn_ezreal_001");
});

test("CodexAppServerRunner runs MOVE finalizer read-only without structured schema", async () => {
  const transport = new MockAppServerTransport();
  const runner = createMockAppServerRunner(transport);
  const runPromise = runner.runMoveFinalizer(createMoveFinalizerInput());

  respondTo(await transport.waitForRequest("initialize"), transport, {});
  respondTo(await transport.waitForRequest("thread/start"), transport, { thread: { id: "thread_app_finalizer" } });
  await respondToTeamGoal(transport, "thread_app_finalizer", /final MOVE commit message/);
  const turnStart = await transport.waitForRequest("turn/start");
  assert.equal(turnStart.params?.sandboxPolicy?.type, "readOnly");
  assert.equal(turnStart.params?.approvalPolicy, "never");
  assert.equal(turnStart.params?.approvalsReviewer, "user");
  assert.equal(turnStart.params?.outputSchema, null);
  assert.match(turnStart.params?.input?.[0]?.text ?? "", /Terminal Path commit: commit_verify/);
  respondTo(turnStart, transport, {
    turn: {
      id: "turn_finalizer_001",
      status: "completed",
      items: [{
        type: "agentMessage",
        id: "msg_finalizer",
        text: "Complete batch Destination\n\nSummary: auto.txt now contains the completed result."
      }],
      error: null
    }
  });

  const result = await runPromise;
  assert.equal(result.providerThreadId, "thread_app_finalizer");
  assert.equal(result.providerTurnId, "turn_finalizer_001");
  assert.equal(result.finalResponse, "Complete batch Destination\n\nSummary: auto.txt now contains the completed result.");
});

test("CodexAppServerRunner enables app-server network access only when explicit", async () => {
  const transport = new MockAppServerTransport();
  const runner = createMockAppServerRunner(transport);
  const runPromise = runner.runTeamPlanning({
    ...createRunInput(),
    codexThreadOptions: {
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
      networkAccessEnabled: true
    }
  });

  respondTo(await transport.waitForRequest("initialize"), transport, {});
  respondTo(await transport.waitForRequest("thread/start"), transport, { thread: { id: "thread_network" } });
  await respondToProviderGoalClear(transport, "thread_network");
  const turnStart = await transport.waitForRequest("turn/start");
  assertNoProviderGoalSet(transport);
  assert.equal(turnStart.params?.sandboxPolicy?.type, "readOnly");
  assert.equal(turnStart.params?.sandboxPolicy?.networkAccess, true);
  respondTo(turnStart, transport, {
    turn: {
      id: "turn_network",
      status: "completed",
      items: [{ type: "agentMessage", id: "msg_network", text: "Network-enabled run finished." }],
      error: null
    }
  });

  await runPromise;
});

test("CodexAppServerRunner resumes an existing Team thread", async () => {
  const transport = new MockAppServerTransport();
  const runner = createMockAppServerRunner(transport);
  const runPromise = runner.resumeRun({ ...createRunInput(), providerThreadId: "thread_existing" });

  respondTo(await transport.waitForRequest("initialize"), transport, {});
  const resume = await transport.waitForRequest("thread/resume");
  assert.equal(resume.params?.threadId, "thread_existing");
  respondTo(resume, transport, { thread: { id: "thread_existing" } });
  await respondToProviderGoalClear(transport, "thread_existing");
  const turnStart = await transport.waitForRequest("turn/start");
  assertNoProviderGoalSet(transport);
  respondTo(turnStart, transport, {
    turn: {
      id: "turn_resume_001",
      status: "completed",
      items: [{ type: "agentMessage", id: "msg_resume", text: "Resumed." }],
      error: null
    }
  });

  const result = await runPromise;
  assert.equal(result.providerThreadId, "thread_existing");
  assert.equal(result.providerTurnId, "turn_resume_001");
  assert.equal(result.finalResponse, "Resumed.");
});

test("CodexAppServerRunner starts a prewarmed HUNSU Draft turn without resuming or resetting goal", async () => {
  const transport = new MockAppServerTransport();
  const runner = createMockAppServerRunner(transport);
  const runPromise = runner.runHunsuDraftTurn({ ...createHunsuDraftInput(), providerThreadId: "thread_hunsu_draft_prepared" });

  respondTo(await transport.waitForRequest("initialize"), transport, {});
  const turnStart = await transport.waitForRequest("turn/start");
  assert.equal(turnStart.params?.threadId, "thread_hunsu_draft_prepared");
  assert.equal(transport.sent.some(message => message.method === "thread/resume"), false);
  assert.equal(transport.sent.some(message => message.method === "thread/goal/set"), false);
  respondTo(turnStart, transport, {
    turn: {
      id: "turn_hunsu_draft_001",
      status: "completed",
      items: [{ type: "agentMessage", id: "msg_hunsu_draft", text: "준비됐습니다." }],
      error: null
    }
  });

  const result = await runPromise;
  assert.equal(result.providerThreadId, "thread_hunsu_draft_prepared");
  assert.equal(result.providerTurnId, "turn_hunsu_draft_001");
  assert.equal(result.finalResponse, "준비됐습니다.");
  assert.equal(transport.sent.some(message => message.method === "thread/resume"), false);
  assert.equal(transport.sent.some(message => message.method === "thread/goal/set"), false);
});

test("CodexAppServerRunner falls back to resume when a prewarmed HUNSU Draft thread is unavailable", async () => {
  const transport = new MockAppServerTransport();
  const runner = createMockAppServerRunner(transport);
  const runPromise = runner.runHunsuDraftTurn({ ...createHunsuDraftInput(), providerThreadId: "thread_hunsu_draft_stale" });

  respondTo(await transport.waitForRequest("initialize"), transport, {});
  const firstTurnStart = await transport.waitForRequest("turn/start");
  assert.equal(firstTurnStart.params?.threadId, "thread_hunsu_draft_stale");
  errorTo(firstTurnStart, transport, "unknown thread");

  const resume = await transport.waitForRequest("thread/resume");
  assert.equal(resume.params?.threadId, "thread_hunsu_draft_stale");
  respondTo(resume, transport, { thread: { id: "thread_hunsu_draft_stale" } });
  const goalSet = await transport.waitForRequest("thread/goal/set");
  assert.equal(goalSet.params?.threadId, "thread_hunsu_draft_stale");
  respondTo(goalSet, transport, { goal: { objective: goalSet.params?.objective } });
  const secondTurnStart = await waitForRequestAfter(transport, "turn/start", transport.sent.indexOf(goalSet));
  assert.equal(secondTurnStart.params?.threadId, "thread_hunsu_draft_stale");
  respondTo(secondTurnStart, transport, {
    turn: {
      id: "turn_hunsu_draft_resumed",
      status: "completed",
      items: [{ type: "agentMessage", id: "msg_hunsu_draft_resumed", text: "재개됐습니다." }],
      error: null
    }
  });

  const result = await runPromise;
  assert.equal(result.providerThreadId, "thread_hunsu_draft_stale");
  assert.equal(result.providerTurnId, "turn_hunsu_draft_resumed");
  assert.equal(result.finalResponse, "재개됐습니다.");
});

test("CodexAppServerRunner stopRun interrupts the active turn", async () => {
  const transport = new MockAppServerTransport();
  const runner = createMockAppServerRunner(transport);
  const runPromise = runner.runTeamPlanning(createRunInput());

  respondTo(await transport.waitForRequest("initialize"), transport, {});
  respondTo(await transport.waitForRequest("thread/start"), transport, { thread: { id: "thread_interrupt" } });
  await respondToProviderGoalClear(transport, "thread_interrupt");
  const turnStart = await transport.waitForRequest("turn/start");
  assertNoProviderGoalSet(transport);
  respondTo(turnStart, transport, { turn: { id: "turn_interrupt", status: "inProgress", items: [] } });
  transport.emit({
    method: "turn/started",
    params: { threadId: "thread_interrupt", turn: { id: "turn_interrupt", status: "inProgress", items: [] } }
  });

  const stopPromise = runner.stopRun("run/req_001");
  const interrupt = await transport.waitForRequest("turn/interrupt");
  assert.deepEqual(interrupt.params, { threadId: "thread_interrupt", turnId: "turn_interrupt" });
  respondTo(interrupt, transport, {});

  await stopPromise;
  await assert.rejects(runPromise, /interrupted by Studio/);
});

test("CodexAppServerRunner stopRun does not hang before app-server returns a turn id", async () => {
  const transport = new MockAppServerTransport();
  const runner = createMockAppServerRunner(transport);
  const runPromise = runner.runTeamPlanning(createRunInput());

  respondTo(await transport.waitForRequest("initialize"), transport, {});
  respondTo(await transport.waitForRequest("thread/start"), transport, { thread: { id: "thread_no_turn_id" } });
  await respondToProviderGoalClear(transport, "thread_no_turn_id");
  await transport.waitForRequest("turn/start");
  assertNoProviderGoalSet(transport);

  await runner.stopRun("run/req_001");

  assert.equal(transport.sent.some(message => message.method === "turn/interrupt"), false);
  await assert.rejects(runPromise, /before app-server returned a turn id/);
});

test("CodexAppServerRunner safely declines app-server approval requests", async () => {
  const transport = new MockAppServerTransport();
  const runner = createMockAppServerRunner(transport);
  const collected = collectRunnerEvents(runner.events("run/req_001"));
  const runPromise = runner.runTeamPlanning(createRunInput());

  respondTo(await transport.waitForRequest("initialize"), transport, {});
  respondTo(await transport.waitForRequest("thread/start"), transport, { thread: { id: "thread_approval" } });
  await respondToProviderGoalClear(transport, "thread_approval");
  const turnStart = await transport.waitForRequest("turn/start");
  assertNoProviderGoalSet(transport);
  respondTo(turnStart, transport, { turn: { id: "turn_approval", status: "inProgress", items: [] } });
  transport.emit({
    method: "turn/started",
    params: { threadId: "thread_approval", turn: { id: "turn_approval", status: "inProgress", items: [] } }
  });

  transport.emit({
    id: "server-approval-001",
    method: "item/commandExecution/requestApproval",
    params: {
      threadId: "thread_approval",
      turnId: "turn_approval",
      itemId: "cmd_approval",
      command: "git push",
      startedAtMs: 1
    }
  });
  await waitFor(() => transport.sent.some(message => message.id === "server-approval-001"));
  assert.deepEqual(transport.sent.find(message => message.id === "server-approval-001")?.result, { decision: "decline" });

  transport.emit({
    method: "turn/completed",
    params: {
      threadId: "thread_approval",
      turn: {
        id: "turn_approval",
        status: "completed",
        items: [{ type: "agentMessage", id: "msg_approval", text: "Done after decline." }],
        error: null
      }
    }
  });

  await runPromise;
  const events = await collected;
  assert.match(events.map(event => "detail" in event ? event.detail : "message" in event ? event.message : "").join("\n"), /requested command approval; Hunsu declined/);
});

test("CodexAppServerRunner declines file and permission approvals without hanging", async () => {
  const fileTransport = new MockAppServerTransport();
  const fileRunner = createMockAppServerRunner(fileTransport);
  const fileRunPromise = fileRunner.runTeamPlanning(createRunInput());

  respondTo(await fileTransport.waitForRequest("initialize"), fileTransport, {});
  respondTo(await fileTransport.waitForRequest("thread/start"), fileTransport, { thread: { id: "thread_file_approval" } });
  await respondToProviderGoalClear(fileTransport, "thread_file_approval");
  const fileTurnStart = await fileTransport.waitForRequest("turn/start");
  assertNoProviderGoalSet(fileTransport);
  respondTo(fileTurnStart, fileTransport, { turn: { id: "turn_file_approval", status: "inProgress", items: [] } });
  fileTransport.emit({
    method: "turn/started",
    params: { threadId: "thread_file_approval", turn: { id: "turn_file_approval", status: "inProgress", items: [] } }
  });
  fileTransport.emit({
    id: "server-file-approval-001",
    method: "item/fileChange/requestApproval",
    params: {
      threadId: "thread_file_approval",
      turnId: "turn_file_approval",
      itemId: "file_approval",
      grantRoot: "/outside",
      startedAtMs: 1
    }
  });
  await waitFor(() => fileTransport.sent.some(message => message.id === "server-file-approval-001"));
  assert.deepEqual(fileTransport.sent.find(message => message.id === "server-file-approval-001")?.result, { decision: "decline" });
  fileTransport.emit({
    method: "turn/completed",
    params: {
      threadId: "thread_file_approval",
      turn: {
        id: "turn_file_approval",
        status: "completed",
        items: [{ type: "agentMessage", id: "msg_file_approval", text: "Continued safely." }],
        error: null
      }
    }
  });
  await fileRunPromise;

  const permissionTransport = new MockAppServerTransport();
  const permissionRunner = createMockAppServerRunner(permissionTransport);
  const permissionRunPromise = permissionRunner.runTeamPlanning(createRunInput());
  const permissionRejected = assert.rejects(permissionRunPromise, /requested additional permissions/);

  respondTo(await permissionTransport.waitForRequest("initialize"), permissionTransport, {});
  respondTo(await permissionTransport.waitForRequest("thread/start"), permissionTransport, { thread: { id: "thread_permission_approval" } });
  await respondToProviderGoalClear(permissionTransport, "thread_permission_approval");
  const permissionTurnStart = await permissionTransport.waitForRequest("turn/start");
  assertNoProviderGoalSet(permissionTransport);
  respondTo(permissionTurnStart, permissionTransport, { turn: { id: "turn_permission_approval", status: "inProgress", items: [] } });
  permissionTransport.emit({
    method: "turn/started",
    params: { threadId: "thread_permission_approval", turn: { id: "turn_permission_approval", status: "inProgress", items: [] } }
  });
  permissionTransport.emit({
    id: "server-permission-approval-001",
    method: "item/permissions/requestApproval",
    params: {
      threadId: "thread_permission_approval",
      turnId: "turn_permission_approval",
      itemId: "permission_approval",
      cwd: "/repo",
      reason: "Need broader access",
      permissions: { network: { enabled: true }, fileSystem: null },
      startedAtMs: 1
    }
  });
  await waitFor(() => permissionTransport.sent.some(message => message.id === "server-permission-approval-001"));
  assert.deepEqual(permissionTransport.sent.find(message => message.id === "server-permission-approval-001")?.result, { permissions: {}, scope: "turn", strictAutoReview: true });
  const interrupt = await permissionTransport.waitForRequest("turn/interrupt");
  assert.deepEqual(interrupt.params, { threadId: "thread_permission_approval", turnId: "turn_permission_approval" });
  respondTo(interrupt, permissionTransport, {});
  await permissionRejected;
});

test("CodexAppServerRunner answers unsupported server requests with JSON-RPC errors", async () => {
  const transport = new MockAppServerTransport();
  const runner = createMockAppServerRunner(transport);
  const runPromise = runner.runTeamPlanning(createRunInput());

  respondTo(await transport.waitForRequest("initialize"), transport, {});
  respondTo(await transport.waitForRequest("thread/start"), transport, { thread: { id: "thread_unsupported_request" } });
  await respondToProviderGoalClear(transport, "thread_unsupported_request");
  const turnStart = await transport.waitForRequest("turn/start");
  assertNoProviderGoalSet(transport);
  respondTo(turnStart, transport, { turn: { id: "turn_unsupported_request", status: "inProgress", items: [] } });
  transport.emit({
    method: "turn/started",
    params: { threadId: "thread_unsupported_request", turn: { id: "turn_unsupported_request", status: "inProgress", items: [] } }
  });

  transport.emit({
    id: "server-unsupported-001",
    method: "item/tool/requestUserInput",
    params: {
      threadId: "thread_unsupported_request",
      turnId: "turn_unsupported_request",
      itemId: "input_001",
      questions: []
    }
  });
  await waitFor(() => transport.sent.some(message => message.id === "server-unsupported-001"));
  const response = transport.sent.find(message => message.id === "server-unsupported-001");
  assert.equal(response?.error?.code, -32601);
  assert.match(response?.error?.message ?? "", /Unsupported Codex app-server request/);

  transport.emit({
    method: "turn/completed",
    params: {
      threadId: "thread_unsupported_request",
      turn: {
        id: "turn_unsupported_request",
        status: "completed",
        items: [{ type: "agentMessage", id: "msg_unsupported", text: "Finished after unsupported request error." }],
        error: null
      }
    }
  });
  await runPromise;
});

test("CodexAppServerRunner reads app-server account and rate-limit status", async () => {
  const transport = new MockAppServerTransport();
  const runner = createMockAppServerRunner(transport);
  const statusPromise = runner.providerStatus();

  respondTo(await transport.waitForRequest("initialize"), transport, { userAgent: "codex-app-server/0.0.0" });
  const accountRead = await transport.waitForRequest("account/read");
  assert.deepEqual(accountRead.params, { refreshToken: false });
  respondTo(accountRead, transport, { account: { type: "apiKey" }, requiresOpenaiAuth: false });
  const rateLimitsRead = await transport.waitForRequest("account/rateLimits/read");
  respondTo(rateLimitsRead, transport, { rateLimits: { limitId: "codex", primary: null, secondary: null, credits: null, planType: null, rateLimitReachedType: null }, rateLimitsByLimitId: null });

  const status = await statusPromise;
  assert.equal(status.backend, "app-server");
  assert.equal(status.available, true);
  assert.deepEqual(status.account, { account: { type: "apiKey" }, requiresOpenaiAuth: false });
});

test("CodexAppServerRunner preserves partial provider status errors", async () => {
  const transport = new MockAppServerTransport();
  const runner = createMockAppServerRunner(transport);
  const statusPromise = runner.providerStatus();

  respondTo(await transport.waitForRequest("initialize"), transport, { userAgent: "codex-app-server/0.0.0" });
  respondTo(await transport.waitForRequest("account/read"), transport, { account: null, requiresOpenaiAuth: true });
  errorTo(await transport.waitForRequest("account/rateLimits/read"), transport, "codex account authentication required to read rate limits");

  const status = await statusPromise;
  assert.equal(status.available, true);
  assert.deepEqual(status.account, { account: null, requiresOpenaiAuth: true });
  assert.match(status.rateLimitsError ?? "", /authentication required/);
  assert.match(status.error ?? "", /authentication required/);
});

test("CodexAppServerClient cleans up timed-out transports and restarts on the next request", async () => {
  const first = new MockAppServerTransport();
  const second = new MockAppServerTransport();
  const transports = [first, second];
  let index = 0;
  const client = new CodexAppServerClient({
    transportFactory: () => transports[index++],
    requestTimeoutMs: 5,
    environment: {}
  });
  const runner = new CodexAppServerRunner({ client, environment: {} });

  const timedOut = await runner.providerStatus();
  assert.equal(timedOut.available, false);
  assert.match(timedOut.error ?? "", /timed out: initialize/);
  assert.equal(first.closed, true);

  const statusPromise = runner.providerStatus();
  respondTo(await second.waitForRequest("initialize"), second, {});
  respondTo(await second.waitForRequest("account/read"), second, { account: { type: "apiKey" }, requiresOpenaiAuth: false });
  respondTo(await second.waitForRequest("account/rateLimits/read"), second, { rateLimits: { limitId: "codex" }, rateLimitsByLimitId: null });

  const status = await statusPromise;
  assert.equal(status.available, true);
  assert.equal(index, 2);
});

test("Codex runner factory is app-server only", () => {
  assert.ok(createDefaultCodexRunner({}).constructor.name.includes("CodexAppServerRunner"));
});

function createRunInput(overrides: Partial<StartRunInput> = {}): StartRunInput {
  return {
    runId: "run/req_001",
    repositoryPath: "/repo",
    requestGoal: "Build Studio",
    harness: createDefaultHarness("Keep changes small."),
    selectedDestinationIds: ["destination_001"],
    activeDestinations: [
      {
        id: destinationId("destination_001"),
        requestId: requestId("req_001"),
        title: destinationTitle("Wire Bridge server commands"),
        status: "pending",
        source: "initial-execute-team",
        createdBy: "SYSTEM",
        updatedBy: "SYSTEM"
      }
    ],
    board: createBoard(),
    ...overrides
  };
}

function createHunsuDraftInput() {
  return {
    ...createRunInput({
      runId: "hunsu-draft:hd001",
      teamName: "Faker",
      sourceMoveId: "M0000",
      targetMoveOrdinal: 0
    }),
    draftSessionId: "hd001",
    manager: createDefaultManagerConfig(),
    sourceArtifactId: "hda_source00000001",
    baseArtifactId: "hda_source00000001",
    draftCheckCommand: "node --input-type=module -e 'await fetch(\"http://127.0.0.1:19687/api/roadmaps/test/hunsu/drafts/hd001/diff-artifacts\", { method: \"POST\" })'",
    baseArtifact: {
      kind: "source-protocol",
      team: { teamName: "Faker" },
      destinations: [{ id: "destination_001", title: "Wire Bridge server commands" }]
    },
    sourceSnapshot: {
      sourceLineId: "run/req_001",
      sourceNodeId: "req_001:root",
      sourceMoveId: "M0000",
      moveOrdinal: 0,
      teamName: "Faker",
      summary: "Faker M000",
      destinationSummaries: [{
        id: "destination_001",
        title: "Wire Bridge server commands",
        status: "pending"
      }]
    },
    messages: [{
      role: "user" as const,
      text: "현재 Faker M000을 복제하는 Hunsu를 만들어 새 Team route를 생성해달라",
      createdAt: "2026-01-01T00:00:00.000Z"
    }],
    userMessage: "현재 Faker M000을 복제하는 Hunsu를 만들어 새 Team route를 생성해달라"
  };
}

function createMemberPathInput(overrides: Partial<MemberPathRunInput> = {}): MemberPathRunInput {
  return {
    ...createRunInput(),
    memberPath: memberPath("implement", "azir", "Implement the selected Destination.", "PrevMove"),
    ...overrides
  };
}

function createMoveFinalizerInput(overrides: Partial<MoveFinalizerInput> = {}): MoveFinalizerInput {
  return {
    ...createRunInput(),
    moveId: "M0001",
    sourceMoveCommit: "commit_prev",
    terminalPathCommit: "commit_verify",
    terminalMemberPathId: "verify",
    pathCommits: {
      PrevMove: "commit_prev",
      implement: "commit_implement",
      verify: "commit_verify"
    },
    pathOutputs: [
      {
        pathId: "implement",
        executorId: "azir",
        goal: "Implement the selected Destination.",
        commit: "commit_implement",
        finalResponse: "Changed auto.txt."
      },
      {
        pathId: "verify",
        executorId: "galio",
        goal: "Verify the implementation and report what you observed.",
        commit: "commit_verify",
        finalResponse: "Verified the implementation and the endpoint responded as expected."
      }
    ],
    completionSummary: "Completed batch Destination",
    diffStat: " auto.txt | 1 +",
    diffNameStatus: "A\tauto.txt",
    diffPatch: "diff --git a/auto.txt b/auto.txt\n+done",
    ...overrides
  };
}

function memberPath(id: string, executorId: string, goal: string, requires: string[] | "PrevMove") {
  return {
    id: requireDomainValue(makeNonEmptyText(id, "pathId")),
    executorId: requireDomainValue(makeNonEmptyText(executorId, "executorId")),
    goal,
    requires: requires === "PrevMove" ? requires : requires.map(value => requireDomainValue(makeNonEmptyText(value, "pathId")))
  };
}

function createBoard(): BoardProjection {
  return {
    origins: [],
    requests: [{
      id: requestId("req_001"),
      title: requestTitle("Studio MVP"),
      goal: requestGoal("Build Studio"),
      createdBy: "SYSTEM"
    }],
    destinations: [],
    nodes: [],
    edges: [],
    lines: [{
      id: lineId("run/req_001"),
      requestId: requestId("req_001"),
      status: "active",
      moveIds: [],
      rootNodeId: nodeId("req_001:root"),
      currentNodeId: nodeId("req_001:root"),
      nodeIds: [nodeId("req_001:root")]
    }],
    moves: [],
    hunsus: [],
    skillDrafts: [],
    artifacts: [],
    artifactActions: [],
    futureConstraints: [{ hunsuId: hunsuId("h001"), lineId: lineId("run/req_001"), constraint: nt("Keep the GUI local-first.") }]
  };
}

async function collectRunnerEvents(events: AsyncIterable<RunnerEvent>): Promise<RunnerEvent[]> {
  const collected: RunnerEvent[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
}

async function drainRunnerEvents(iterator: AsyncIterator<RunnerEvent>): Promise<RunnerEvent[]> {
  const collected: RunnerEvent[] = [];
  while (true) {
    const result = await iterator.next();
    if (result.done) {
      return collected;
    }
    collected.push(result.value);
  }
}

function isFinalEvent(event: RunnerEvent): event is Extract<RunnerEvent, { type: "runner.final" }> {
  return event.type === "runner.final";
}

function isAgentMessageDelta(event: RunnerEvent): event is Extract<RunnerEvent, { type: "runner.item.delta" }> & { deltaKind: "agentMessage" } {
  return event.type === "runner.item.delta" && event.deltaKind === "agentMessage";
}

function createMockAppServerRunner(transport: MockAppServerTransport): CodexAppServerRunner {
  const client = new CodexAppServerClient({
    transportFactory: () => transport,
    requestTimeoutMs: 1_000,
    environment: {}
  });
  return new CodexAppServerRunner({ client, environment: {} });
}

type MockJsonRpcMessage = {
  id?: string | number;
  method?: string;
  params?: any;
  result?: any;
  error?: { code: number; message: string; data?: unknown };
};

class MockAppServerTransport implements CodexAppServerTransport {
  sent: MockJsonRpcMessage[] = [];
  closed = false;
  private readonly messageHandlers = new Set<(message: MockJsonRpcMessage) => void>();
  private readonly errorHandlers = new Set<(error: Error) => void>();
  private readonly closeHandlers = new Set<() => void>();

  send(message: MockJsonRpcMessage): void {
    this.sent.push(message);
  }

  close(): void {
    this.closed = true;
    for (const handler of this.closeHandlers) {
      handler();
    }
  }

  onMessage(handler: (message: MockJsonRpcMessage) => void): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  onError(handler: (error: Error) => void): () => void {
    this.errorHandlers.add(handler);
    return () => this.errorHandlers.delete(handler);
  }

  onClose(handler: () => void): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  emit(message: MockJsonRpcMessage): void {
    for (const handler of this.messageHandlers) {
      handler(message);
    }
  }

  emitError(error: Error): void {
    for (const handler of this.errorHandlers) {
      handler(error);
    }
  }

  async waitForRequest(method: string): Promise<MockJsonRpcMessage> {
    await waitFor(() => this.sent.some(message => message.method === method && message.id !== undefined));
    const found = this.sent.find(message => message.method === method && message.id !== undefined);
    assert.ok(found);
    return found;
  }
}

function respondTo(request: MockJsonRpcMessage, transport: MockAppServerTransport, result: unknown): void {
  assert.notEqual(request.id, undefined);
  transport.emit({ id: request.id, result });
}

async function waitForRequestAfter(transport: MockAppServerTransport, method: string, startIndex: number): Promise<MockJsonRpcMessage> {
  await waitFor(() => transport.sent.some((message, index) => index >= startIndex && message.method === method && message.id !== undefined));
  const found = transport.sent.find((message, index) => index >= startIndex && message.method === method && message.id !== undefined);
  assert.ok(found);
  return found;
}

async function completeTeamTurn(
  transport: MockAppServerTransport,
  input: { threadId: string; turnId: string; itemId: string; delta: string; since: number }
): Promise<void> {
  respondTo(await waitForRequestAfter(transport, "thread/start", input.since), transport, { thread: { id: input.threadId } });
  const goalClear = await waitForRequestAfter(transport, "thread/goal/clear", input.since);
  assert.deepEqual(goalClear.params, { threadId: input.threadId });
  respondTo(goalClear, transport, {});
  respondTo(await waitForRequestAfter(transport, "turn/start", input.since), transport, {
    turn: { id: input.turnId, status: "inProgress", items: [] }
  });
  transport.emit({
    method: "item/agentMessage/delta",
    params: {
      threadId: input.threadId,
      turnId: input.turnId,
      itemId: input.itemId,
      delta: input.delta
    }
  });
  transport.emit({
    method: "turn/completed",
    params: {
      threadId: input.threadId,
      turn: {
        id: input.turnId,
        status: "completed",
        items: [{ type: "agentMessage", id: input.itemId, text: input.delta }],
        error: null
      }
    }
  });
}

async function respondToTeamGoal(transport: MockAppServerTransport, threadId: string, expectedPrompt: RegExp = /Keep changes small/, expectRequestContext = true): Promise<void> {
  const goalSet = await transport.waitForRequest("thread/goal/set");
  assert.equal(goalSet.params?.threadId, threadId);
  if (expectRequestContext) {
    assert.match(goalSet.params?.objective ?? "", /Wire Bridge server commands/);
    assert.doesNotMatch(goalSet.params?.objective ?? "", /Current TODO|Resolved Prompt Template/);
  }
  assert.match(goalSet.params?.objective ?? "", expectedPrompt);
  respondTo(goalSet, transport, { goal: { objective: goalSet.params?.objective } });
}

async function respondToProviderGoalClear(transport: MockAppServerTransport, threadId: string): Promise<void> {
  const goalClear = await transport.waitForRequest("thread/goal/clear");
  assert.deepEqual(goalClear.params, { threadId });
  respondTo(goalClear, transport, {});
}

function assertNoProviderGoalSet(transport: MockAppServerTransport): void {
  assert.equal(transport.sent.some(message => message.method === "thread/goal/set"), false);
}

function errorTo(request: MockJsonRpcMessage, transport: MockAppServerTransport, message: string): void {
  assert.notEqual(request.id, undefined);
  transport.emit({ id: request.id, error: { code: -32000, message } });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  assert.equal(predicate(), true);
}
