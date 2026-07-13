import test from "node:test";
import assert from "node:assert/strict";
import {
  decodeDomainEvent,
  encodeDomainEvent,
  makeCoachId,
  makeCommandFingerprint,
  makeEventId,
  makeGitBranchName,
  makeGitRef,
  makeIdempotencyKey,
  makeIsoTimestamp,
  makeNonEmptyText,
  makeProjectId,
  makeProjectObjective,
  makeProjectTitle,
  makePromptTemplate,
  makeRepositoryName,
  makeRepositoryOwner,
  makeWorkspaceId,
  type DomainEvent,
  type Result
} from "../packages/protocol/src/index.ts";

test("domain IDs and Git names reject unsafe ref fragments", () => {
  assert.equal(makeProjectId("project-safe").ok, true);
  assert.equal(makeProjectId("project/unsafe").ok, false);
  assert.equal(makeProjectId("project..unsafe").ok, false);
  assert.equal(makeGitBranchName("hunsu/run/project/goal/run").ok, true);
  assert.equal(makeGitBranchName("bad..branch").ok, false);
  assert.equal(makeGitBranchName("bad branch").ok, false);
  assert.equal(makeGitRef("refs/heads/hunsu/state").ok, true);
  assert.equal(makeGitRef("refs/heads/bad.lock").ok, false);
});

test("persisted idempotency values must be SHA-256 digests", () => {
  assert.equal(makeIdempotencyKey("plain-client-key").ok, false);
  assert.equal(makeIdempotencyKey("a".repeat(64)).ok, true);
  assert.equal(makeCommandFingerprint("sha256:" + "b".repeat(64)).ok, true);
});

test("domain event codec is canonical, versioned, and validates branded fields", () => {
  const at = take(makeIsoTimestamp("2026-07-13T00:00:00.000Z"));
  const projectId = take(makeProjectId("project_alpha"));
  const coachId = take(makeCoachId("coach_alpha"));
  const event: DomainEvent = {
    type: "ProjectCreated",
    meta: {
      eventId: take(makeEventId("event_alpha")),
      idempotencyKey: take(makeIdempotencyKey("1".repeat(64))),
      fingerprint: take(makeCommandFingerprint("2".repeat(64))),
      actor: { type: "user", id: take(makeNonEmptyText("user-alpha")) },
      recordedAt: at
    },
    project: {
      id: projectId,
      workspaceId: take(makeWorkspaceId("workspace_alpha")),
      repository: {
        owner: take(makeRepositoryOwner("openai")),
        name: take(makeRepositoryName("hunsu"))
      },
      baseRef: take(makeGitRef("refs/heads/main")),
      title: take(makeProjectTitle("Hunsu")),
      objective: take(makeProjectObjective("Prove the Git-backed project flow")),
      coachId,
      goalIds: [],
      runnerIds: [],
      createdAt: at,
      updatedAt: at
    },
    coach: {
      id: coachId,
      projectId,
      promptTemplate: take(makePromptTemplate("Review evidence and propose changes.")),
      resources: [],
      policy: {
        goalChanges: "propose_only",
        runnerChanges: "propose_only",
        hunsu: "propose_only",
        selection: "user_only"
      },
      createdAt: at,
      updatedAt: at
    }
  };

  const encoded = encodeDomainEvent(event);
  assert.match(encoded, /^\{"event":/u);
  assert.match(encoded, /"schema":"hunsu\.project-event\.v1"/u);
  assert.equal(encoded.endsWith("\n"), true);

  const decoded = decodeDomainEvent(encoded);
  assert.equal(decoded.ok, true);
  if (decoded.ok) assert.deepEqual(decoded.value, event);

  const unsafe = encoded.replace("refs/heads/main", "refs/heads/bad..ref");
  assert.equal(decodeDomainEvent(unsafe).ok, false);

  const withUnknownField = JSON.parse(encoded) as {
    event: { project: Record<string, unknown> };
  };
  withUnknownField.event.project.unrecognized = true;
  assert.equal(decodeDomainEvent(JSON.stringify(withUnknownField)).ok, false);
});

function take<T, E>(result: Result<T, E>): T {
  if (!result.ok) throw new Error("Fixture construction failed");
  return result.value;
}
