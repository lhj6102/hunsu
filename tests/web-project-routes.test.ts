import assert from "node:assert/strict";
import test from "node:test";
import {
  coachPath,
  goalPath,
  parseAppRoute,
  projectPath,
  runnersPath,
  runPath,
  shouldFetchProjectList
} from "../apps/web/src/app/routes.ts";
import { safeHttpHref } from "../apps/web/src/shared/format.ts";
import { alternativeDecisionRequest } from "../apps/web/src/shared/api/alternativeDecision.ts";
import { createLogicalSubmissionKey } from "../apps/web/src/shared/api/logicalSubmissionKey.ts";
import { canRecordAlternativeDecision } from "../apps/web/src/features/alternatives/comparisonModel.ts";
import { latestCompletedRun } from "../apps/web/src/features/goals/goalActionModel.ts";

test("Web navigation exposes the six Project surfaces", () => {
  assert.deepEqual(parseAppRoute({ pathname: "/projects" }), { kind: "projects" });
  assert.deepEqual(parseAppRoute({ pathname: "/projects/project-a" }), {
    kind: "project",
    projectId: "project-a"
  });
  assert.deepEqual(parseAppRoute({ pathname: "/projects/project-a/goals/goal-b" }), {
    kind: "goal",
    projectId: "project-a",
    goalId: "goal-b"
  });
  assert.deepEqual(parseAppRoute({ pathname: "/projects/project-a/runners" }), {
    kind: "runners",
    projectId: "project-a"
  });
  assert.deepEqual(parseAppRoute({ pathname: "/projects/project-a/coach" }), {
    kind: "coach",
    projectId: "project-a"
  });
  assert.deepEqual(parseAppRoute({ pathname: "/projects/project-a/runs/run-c" }), {
    kind: "run",
    projectId: "project-a",
    runId: "run-c"
  });
});

test("only the Project list route enables the full Project-list request", () => {
  assert.equal(shouldFetchProjectList(parseAppRoute({ pathname: "/projects" })), true);
  for (const pathname of [
    "/projects/project-a",
    "/projects/project-a/goals/goal-b",
    "/projects/project-a/runs/run-c",
    "/projects/project-a/runners",
    "/projects/project-a/coach"
  ]) {
    assert.equal(shouldFetchProjectList(parseAppRoute({ pathname })), false, pathname);
  }
});

test("Project route builders encode identifiers and keep comparison within Goal detail", () => {
  assert.equal(projectPath("project/a"), "/projects/project%2Fa");
  assert.equal(goalPath("project/a", "goal b"), "/projects/project%2Fa/goals/goal%20b");
  assert.equal(runnersPath("project/a"), "/projects/project%2Fa/runners");
  assert.equal(coachPath("project/a"), "/projects/project%2Fa/coach");
  assert.equal(runPath("project/a", "run c"), "/projects/project%2Fa/runs/run%20c");
});

test("unknown locations fall back to Project navigation", () => {
  assert.deepEqual(parseAppRoute({ pathname: "/" }), { kind: "projects" });
  assert.deepEqual(parseAppRoute({ pathname: "/projects/project-a/unknown" }), {
    kind: "project",
    projectId: "project-a"
  });
});

test("Web links reject unsafe URL schemes", () => {
  assert.equal(safeHttpHref("/api/auth/github"), "/api/auth/github");
  assert.equal(safeHttpHref("https://github.com/hunsu/project"), "https://github.com/hunsu/project");
  assert.equal(safeHttpHref("https://user:secret@example.com/result"), undefined);
  assert.equal(safeHttpHref("javascript:alert(1)"), undefined);
  assert.equal(safeHttpHref("data:text/html,unsafe"), undefined);
});

test("alternative decisions require a completed Run in a recorded comparison", () => {
  assert.equal(canRecordAlternativeDecision({ id: "run-completed", status: "completed" }, "comparison-1"), true);
  assert.equal(canRecordAlternativeDecision({ id: "run-completed", status: "completed" }, undefined), false);
  assert.equal(canRecordAlternativeDecision({ id: "run-running", status: "running" }, "comparison-1"), false);
  assert.deepEqual(
    alternativeDecisionRequest("comparison-1", "a".repeat(40), "decision:one"),
    {
      comparisonId: "comparison-1",
      expectedStateSha: "a".repeat(40),
      idempotencyKey: "decision:one"
    }
  );
});

test("Give Hunsu chooses only the latest completed source Run", () => {
  const source = latestCompletedRun([
    { id: "completed-old", status: "completed", updatedAt: "2026-07-13T01:00:00.000Z" },
    { id: "running-new", status: "running", updatedAt: "2026-07-13T04:00:00.000Z" },
    { id: "failed-newer", status: "failed", updatedAt: "2026-07-13T03:00:00.000Z" },
    { id: "pending", status: "pending", updatedAt: "2026-07-13T05:00:00.000Z" }
  ]);
  assert.equal(source?.id, "completed-old");
  assert.equal(latestCompletedRun([{ id: "running", status: "running", updatedAt: "2026-07-13T01:00:00.000Z" }]), undefined);
  assert.equal(latestCompletedRun([{ id: "failed", status: "failed", updatedAt: "2026-07-13T02:00:00.000Z" }]), undefined);
});

test("Web mutation retries retain a logical submission key until input changes or succeeds", () => {
  let created = 0;
  const submission = createLogicalSubmissionKey("goal.lifecycle", scope => `${scope}:key-${++created}`);
  const input = {
    projectId: "project-a",
    goalId: "goal-a",
    status: "paused"
  };

  const initial = submission.keyFor(input);
  const lostResponseRetry = submission.keyFor({
    status: "paused",
    goalId: "goal-a",
    projectId: "project-a"
  });
  assert.equal(lostResponseRetry, initial);
  assert.equal(created, 1);

  // Concurrency tokens are transport state, not part of the semantic command
  // passed to keyFor. Polling may refresh one after the response was lost.
  const retryAfterProjectionRefresh = {
    expectedStateSha: "b".repeat(40),
    idempotencyKey: submission.keyFor(input)
  };
  assert.equal(retryAfterProjectionRefresh.idempotencyKey, initial);

  const changedInput = submission.keyFor({ ...input, status: "active" });
  assert.notEqual(changedInput, initial);
  assert.equal(created, 2);

  submission.succeeded();
  const afterSuccess = submission.keyFor({ ...input, status: "active" });
  assert.notEqual(afterSuccess, changedInput);
  assert.equal(created, 3);
});

test("abandoning a Web mutation rotates the key for an otherwise identical resubmission", () => {
  let created = 0;
  const submission = createLogicalSubmissionKey("project.create", scope => `${scope}:key-${++created}`);
  const input = { repository: "hunsu/product", title: "Product" };
  const first = submission.keyFor(input);
  submission.abandon();
  assert.notEqual(submission.keyFor(input), first);
});
