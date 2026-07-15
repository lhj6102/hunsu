import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalPathForRoute,
  parseAppRoute,
  projectEventPath,
  projectEventsPath,
  projectGraphPath,
  projectNodePath
} from "../apps/web/src/app/routes.ts";
import { validateGraphTopology } from "../apps/web/src/features/node-graph/graphModel.ts";
import { fallbackGraphLayout } from "../apps/web/src/features/node-graph/fallbackGraphLayout.ts";
import { GRAPH_COACHING_GAP, GRAPH_RUN_GAP } from "../apps/web/src/features/node-graph/layoutMetrics.ts";
import { createLogicalSubmissionKey } from "../apps/web/src/shared/api/logicalSubmissionKey.ts";
import { eventDateBound } from "../apps/web/src/features/events/eventFilters.ts";
import type { GraphEdge, GraphNodeSummary } from "../apps/web/src/shared/api/types.ts";
import { safeHttpHref } from "../apps/web/src/shared/format.ts";

const ROOT_SHA = "1".repeat(40);
const RUN_SHA = "2".repeat(40);
const COACH_SHA = "3".repeat(40);
const SECOND_PARENT_SHA = "4".repeat(40);
const GOAL_DIGEST = `hunsu-goal-v1:sha256:${"a".repeat(64)}`;
const RUNNER_DIGEST = `hunsu-runner-v1:sha256:${"b".repeat(64)}`;

test("Web navigation exposes only Project list, Node graph, Node, Events, and Event routes", () => {
  assert.deepEqual(parseAppRoute({ pathname: "/projects" }), { kind: "projects" });
  assert.deepEqual(parseAppRoute({ pathname: "/projects/project-a" }), {
    kind: "graph",
    projectId: "project-a",
    nodeSha: null
  });
  assert.deepEqual(parseAppRoute({ pathname: "/projects/project-a/graph" }), {
    kind: "graph",
    projectId: "project-a",
    nodeSha: null
  });
  assert.deepEqual(parseAppRoute({ pathname: `/projects/project-a/graph/nodes/${RUN_SHA}` }), {
    kind: "graph",
    projectId: "project-a",
    nodeSha: RUN_SHA
  });
  assert.deepEqual(parseAppRoute({ pathname: "/projects/project-a/events" }), {
    kind: "events",
    projectId: "project-a",
    eventId: null
  });
  assert.deepEqual(parseAppRoute({ pathname: "/projects/project-a/events/event-c" }), {
    kind: "events",
    projectId: "project-a",
    eventId: "event-c"
  });
});

test("the Project root has one explicit canonical redirect to Node graph", () => {
  const route = parseAppRoute({ pathname: "/projects/project-a" });
  assert.equal(canonicalPathForRoute(route), "/projects/project-a/graph");
  assert.equal(canonicalPathForRoute(parseAppRoute({ pathname: "/projects/project-a/events" })), null);
});

test("legacy and unknown Project routes are not aliases", () => {
  for (const pathname of [
    "/",
    "/projects/project-a/goals/goal-b",
    "/projects/project-a/runners",
    "/projects/project-a/coach",
    "/projects/project-a/runs/run-c",
    "/projects/project-a/unknown",
    "/projects/%ZZ/graph"
  ]) {
    assert.deepEqual(parseAppRoute({ pathname }), { kind: "not_found" }, pathname);
  }
});

test("v2 route builders encode every identifier", () => {
  assert.equal(projectGraphPath("project/a"), "/projects/project%2Fa/graph");
  assert.equal(projectNodePath("project/a", "node sha"), "/projects/project%2Fa/graph/nodes/node%20sha");
  assert.equal(projectEventsPath("project/a"), "/projects/project%2Fa/events");
  assert.equal(projectEventPath("project/a", "event c"), "/projects/project%2Fa/events/event%20c");
});

test("the Web graph enforces one structural parent per non-root Node", () => {
  const nodes = [node(ROOT_SHA), node(RUN_SHA), node(COACH_SHA), node(SECOND_PARENT_SHA)];
  const validEdges: GraphEdge[] = [
    runEdge("run-edge", ROOT_SHA, RUN_SHA),
    coachingEdge("coach-edge", ROOT_SHA, COACH_SHA),
    runEdge("run-edge-2", RUN_SHA, SECOND_PARENT_SHA)
  ];
  assert.deepEqual(validateGraphTopology(nodes, validEdges, ROOT_SHA), { ok: true });

  const twoTails = [...validEdges, coachingEdge("second-tail", COACH_SHA, SECOND_PARENT_SHA)];
  const result = validateGraphTopology(nodes, twoTails, ROOT_SHA);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "multiple_parents");
});

test("the Web graph rejects dangling edges, self edges, and disconnected Nodes", () => {
  const nodes = [node(ROOT_SHA), node(RUN_SHA)];
  assert.equal(validateGraphTopology(nodes, [runEdge("dangling", ROOT_SHA, COACH_SHA)], ROOT_SHA).ok, false);
  assert.equal(validateGraphTopology(nodes, [runEdge("self", ROOT_SHA, ROOT_SHA)], ROOT_SHA).ok, false);
  const disconnected = validateGraphTopology(nodes, [], ROOT_SHA);
  assert.equal(disconnected.ok, false);
  if (!disconnected.ok) assert.equal(disconnected.code, "missing_parent");
});

test("the fallback layout preserves rightward Runs and downward Coaching", () => {
  const nodes = [node(ROOT_SHA), node(RUN_SHA), node(COACH_SHA), node(SECOND_PARENT_SHA)];
  const edges = [
    runEdge("run-edge", ROOT_SHA, RUN_SHA),
    coachingEdge("coach-edge", ROOT_SHA, COACH_SHA),
    coachingEdge("nested-coach", RUN_SHA, SECOND_PARENT_SHA)
  ];
  const positions = new Map(fallbackGraphLayout({ nodes, edges }).map(position => [position.sha, position]));
  assert.ok(positions.get(RUN_SHA)!.x > positions.get(ROOT_SHA)!.x);
  assert.ok(positions.get(COACH_SHA)!.y > positions.get(ROOT_SHA)!.y);
  assert.ok(positions.get(SECOND_PARENT_SHA)!.y > positions.get(RUN_SHA)!.y);
  assert.ok(positions.get(RUN_SHA)!.x - positions.get(ROOT_SHA)!.x >= GRAPH_RUN_GAP);
  assert.ok(positions.get(COACH_SHA)!.y - positions.get(ROOT_SHA)!.y >= GRAPH_COACHING_GAP);
});

test("Web links reject unsafe URL schemes", () => {
  assert.equal(safeHttpHref("/api/auth/github"), "/api/auth/github");
  assert.equal(safeHttpHref("https://github.com/hunsu/project"), "https://github.com/hunsu/project");
  assert.equal(safeHttpHref("https://user:secret@example.com/result"), undefined);
  assert.equal(safeHttpHref("javascript:alert(1)"), undefined);
  assert.equal(safeHttpHref("data:text/html,unsafe"), undefined);
});

test("Web date filters become inclusive UTC RFC 3339 bounds", () => {
  assert.equal(eventDateBound("2026-07-14", "from"), "2026-07-14T00:00:00.000Z");
  assert.equal(eventDateBound("2026-07-14", "to"), "2026-07-14T23:59:59.999Z");
  assert.equal(eventDateBound("2026-07-14T09:30:00+09:00", "from"), "2026-07-14T09:30:00+09:00");
});

test("Run retries retain a logical submission key until input changes or succeeds", () => {
  let created = 0;
  const submission = createLogicalSubmissionKey("node.run.start", scope => `${scope}:key-${++created}`);
  const input = { projectId: "project-a", nodeSha: ROOT_SHA, goalDigest: GOAL_DIGEST, runId: "run-a" };

  const initial = submission.keyFor(input);
  assert.equal(submission.keyFor({ runId: "run-a", goalDigest: GOAL_DIGEST, nodeSha: ROOT_SHA, projectId: "project-a" }), initial);
  assert.equal(created, 1);

  const changed = submission.keyFor({ ...input, runId: "run-b" });
  assert.notEqual(changed, initial);
  submission.succeeded();
  assert.notEqual(submission.keyFor({ ...input, runId: "run-b" }), changed);
});

function node(sha: string): GraphNodeSummary {
  return {
    sha,
    title: `Node ${sha.slice(0, 4)}`,
    status: "available",
    runner: {
      name: "QA Runner",
      typeKey: "qa.runner",
      schemaVersion: "1",
      digest: RUNNER_DIGEST
    },
    nextGoalCount: 1,
    integrity: "valid"
  };
}

function runEdge(id: string, sourceSha: string, targetSha: string): GraphEdge {
  return {
    kind: "run",
    id,
    sourceSha,
    targetSha,
    runId: `${id}-run`,
    goal: { digest: GOAL_DIGEST, title: "Validate one Goal" },
    completedAt: "2026-07-14T07:00:00.000Z"
  };
}

function coachingEdge(id: string, sourceSha: string, targetSha: string): GraphEdge {
  return {
    kind: "coaching",
    id,
    sourceSha,
    targetSha,
    proposalId: `${id}-proposal`,
    summary: "Change the Node plan",
    confirmedAt: "2026-07-14T07:00:00.000Z"
  };
}
