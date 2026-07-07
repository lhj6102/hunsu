import test from "node:test";
import assert from "node:assert/strict";
import { makePositiveInteger } from "../packages/protocol/src/index.ts";
import type { BoardProjection, Destination, LineRecord, NodeRecord } from "../packages/protocol/src/index.ts";
import type { ExecuteStepResult } from "../apps/bridge/src/execute/execute-model.ts";
import { parseGoalEvaluation, parseExecutionPlan } from "../apps/bridge/src/execute/execution-plan.ts";
import {
  ensureTerminalOutput,
  planExecuteStart,
  planMaxAttemptsExceeded
} from "../apps/bridge/src/execute/execute-workflow.ts";

test("Execute orchestration parses closure-free ExecutionPlan format", () => {
  const execution = unwrap(parseExecutionPlan(JSON.stringify({
    kind: "queue",
    id: "builder-verifier",
    items: [{
      kind: "goal",
      stage: "needs_evaluation",
      id: "selected-destination",
      assignee: { executorId: "azir", goal: "Implement the work" },
      evaluator: { executorId: "galio", prompt: "Verify the work" },
      remainingAttempts: 2,
      requires: "PrevMove"
    }]
  })));

  assert.equal(execution.kind, "queue");
  assert.equal(execution.items[0]?.kind, "goal");
});

test("Execute orchestration returns typed errors for invalid ExecutionPlan", () => {
  expectError(parseExecutionPlan(JSON.stringify({
    kind: "goal",
    id: "missing-assignee-executor",
    stage: "needs_evaluation",
    assignee: { goal: "Implement" },
    remainingAttempts: 1,
    requires: "PrevMove"
  })), "execution_plan_invalid");

  expectError(parseExecutionPlan(JSON.stringify({
    kind: "goal",
    id: "bad-budget",
    stage: "needs_evaluation",
    assignee: { executorId: "azir", goal: "Implement" },
    evaluator: { executorId: "galio", prompt: "Verify" },
    remainingAttempts: -1,
    requires: "PrevMove"
  })), "execution_plan_invalid");

  expectError(parseExecutionPlan(JSON.stringify({
    kind: "goal",
    id: "blank-requires",
    stage: "needs_evaluation",
    assignee: { executorId: "azir", goal: "Implement" },
    evaluator: { executorId: "galio", prompt: "Verify" },
    remainingAttempts: 1,
    requires: [""]
  })), "execution_plan_invalid");

  expectError(parseExecutionPlan(JSON.stringify({
    kind: "goal",
    id: "legacy-unstaged",
    assignee: { executorId: "azir", goal: "Implement" },
    evaluator: { executorId: "galio", prompt: "Verify" },
    remainingAttempts: 1
  })), "execution_plan_invalid");

  expectError(parseExecutionPlan(JSON.stringify({
    kind: "goal",
    stage: "needs_execution",
    id: "missing-evaluation",
    assignee: { executorId: "azir", goal: "Implement" },
    evaluator: { executorId: "galio", prompt: "Verify" },
    remainingAttempts: 1,
    evaluationPathId: "selected-destination.evaluate.1",
    requires: ["selected-destination.evaluate.1"]
  })), "execution_plan_invalid");

  expectError(parseExecutionPlan(JSON.stringify({
    kind: "goal",
    stage: "needs_execution",
    id: "mismatched-requires",
    assignee: { executorId: "azir", goal: "Implement" },
    evaluator: { executorId: "galio", prompt: "Verify" },
    remainingAttempts: 1,
    evaluationPathId: "selected-destination.evaluate.1",
    evaluation: {
      type: "fail",
      reason: "Missing file",
      feedback: "Create auto.txt"
    },
    requires: ["selected-destination.evaluate.other"]
  })), "execution_plan_invalid");
});

test("Execute orchestration parses Goal evaluator pass/fail responses", () => {
  assert.deepEqual(unwrap(parseGoalEvaluation(JSON.stringify({
    type: "pass",
    summary: "Verified the work",
    evidence: ["auto.txt exists"]
  }))), {
    type: "pass",
    summary: "Verified the work",
    evidence: ["auto.txt exists"]
  });

  assert.equal(unwrap(parseGoalEvaluation(JSON.stringify({
    type: "fail",
    reason: "Missing file",
    feedback: "Create auto.txt",
    nextGoal: "Create auto.txt"
  }))).type, "fail");
});

test("Execute orchestration plans Execute start state without side effects", () => {
  const plan = unwrap(planExecuteStart({
    board: boardFixture(),
    line: lineFixture(),
    lineNode: nodeFixture(),
    existingRuns: [],
    activeDestinations: [
      destinationFixture("destination_low", 10),
      destinationFixture("destination_high", 100)
    ]
  }));

  assert.equal(plan.lineNode.id, "node_001");
  assert.equal(plan.targetMoveOrdinal, 2);
  assert.deepEqual(plan.selectedDestinationIds, ["destination_high"]);
});

test("Execute orchestration rejects explicit multi-Destination Execute starts", () => {
  expectError(planExecuteStart({
    board: boardFixture(),
    line: lineFixture(),
    lineNode: nodeFixture(),
    existingRuns: [],
    selectedDestinationIds: ["destination_001", "destination_002"],
    activeDestinations: [
      destinationFixture("destination_001", 100),
      destinationFixture("destination_002", 90)
    ]
  }), "invalid_start_state");
});

test("Execute orchestration rejects non-head Destination Execute starts", () => {
  expectError(planExecuteStart({
    board: boardFixture(),
    line: lineFixture(),
    lineNode: nodeFixture(),
    existingRuns: [],
    selectedDestinationIds: ["destination_low"],
    activeDestinations: [
      destinationFixture("destination_low", 10),
      destinationFixture("destination_high", 100)
    ]
  }), "invalid_start_state");
});

test("Execute orchestration rejects duplicate active Execute starts", () => {
  expectError(planExecuteStart({
    board: boardFixture(),
    line: lineFixture(),
    lineNode: nodeFixture(),
    existingRuns: [{ sourceNodeId: "node_001", status: "paused" }],
    activeDestinations: [destinationFixture("destination_001", 100)]
  }), "active_execute_exists");
});

test("Execute orchestration requires terminal Path output before MOVE completion", () => {
  assert.equal(unwrap(ensureTerminalOutput("Verified the work.")), "Verified the work.");
  expectError(ensureTerminalOutput(undefined), "terminal_output_missing");
});

test("Execute orchestration plans max-attempt Accident recording", () => {
  const decision = planMaxAttemptsExceeded({
    maxAttemptCount: requireDomainValue(makePositiveInteger(2, "maxAttemptCount"))
  });

  assert.equal(decision.type, "record_accident");
  assert.equal(decision.reason.code, "max_attempts_exhausted");
  assert.match(decision.reason.message, /without recording an Arrived MOVE/);
});

function unwrap<T>(result: ExecuteStepResult<T>): T {
  if (!result.ok) {
    assert.fail(`${result.error.code}: ${result.error.message}`);
  }
  return result.value;
}

function expectError<T>(result: ExecuteStepResult<T>, code: string): void {
  if (result.ok) {
    assert.fail(`Expected ${code}, received ok`);
  }
  assert.equal(result.error.code, code);
}

function requireDomainValue<T>(result: { ok: true; value: T } | { ok: false; error: { message: string } }): T {
  if (result.ok) {
    return result.value;
  }
  throw new Error(result.error.message);
}

function boardFixture(edges: unknown[] = []): BoardProjection {
  return { edges } as BoardProjection;
}

function lineFixture(): LineRecord {
  return { id: "run/req", status: "active" } as LineRecord;
}

function nodeFixture(): NodeRecord {
  return { id: "node_001", ordinal: 1, teamName: "Azir" } as NodeRecord;
}

function destinationFixture(id: string, priority: number): Destination {
  return { id, priority } as Destination;
}
