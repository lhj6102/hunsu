import assert from "node:assert/strict";
import test from "node:test";
import {
  GitHubProjectStore,
  HUNSU_STATE_BRANCH,
  MemoryGitHubTransport,
  normalizeGitHubWebhook,
  type ProjectStateCodec,
  type RepositoryGrant,
  type GitHubTransport,
  type StoreResult
} from "../packages/github-store/src/index.ts";

type Event =
  | { type: "ProjectCreated"; projectId: string; title: string }
  | { type: "ProjectRenamed"; projectId: string; title: string };

type State = {
  projectId: string;
  title: string;
};

type TestEventEnvelope = Record<string, unknown> & {
  eventId: string;
  sequence: number;
  idempotencyKeyHash: string;
  actor: unknown;
};

const repository: RepositoryGrant = {
  installationId: 17,
  repositoryId: 42,
  owner: "hunsu",
  name: "sample",
  defaultBranch: "main",
  private: true,
  permissions: { contents: "write" }
};
const baseSha = "a".repeat(40);

const codec: ProjectStateCodec<Event, State> = {
  projectId: state => state.projectId,
  decodeEvent(input): StoreResult<Event> {
    if (isRecord(input)
      && (input.type === "ProjectCreated" || input.type === "ProjectRenamed")
      && typeof input.projectId === "string"
      && typeof input.title === "string"
    ) {
      return { ok: true, value: input as Event };
    }
    return { ok: false, error: { code: "invalid_event", message: "invalid test event" } };
  },
  replay(events): StoreResult<State> {
    let state: State | undefined;
    for (const event of events) {
      if (event.type === "ProjectCreated") state = { projectId: event.projectId, title: event.title };
      else if (state?.projectId === event.projectId) state = { ...state, title: event.title };
      else return { ok: false, error: { code: "invalid_event", message: "rename before create" } };
    }
    return state
      ? { ok: true, value: state }
      : { ok: false, error: { code: "invalid_event", message: "empty stream" } };
  },
  materialize: state => ({
    "project.json": { schema: "hunsu.project.v1", ...state },
    "snapshots/latest.json": state
  })
};

test("GitHub state writes are append-only, idempotent, and reconstruct from events", async () => {
  const transport = new MemoryGitHubTransport([{ repository, initialSha: baseSha }]);
  const store = new GitHubProjectStore(transport, codec);
  const created = await store.append({
    repository,
    projectId: "project-alpha",
    baseSha,
    idempotencyKey: "create-project-alpha",
    occurredAt: "2026-07-13T00:00:00.000Z",
    actor: { kind: "user", id: "user-1" },
    command: { type: "CreateProject", title: "Alpha" },
    decide: () => ({ ok: true, value: [{ type: "ProjectCreated", projectId: "project-alpha", title: "Alpha" }] })
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;

  const branch = await transport.readBranch(repository, HUNSU_STATE_BRANCH);
  assert.equal(branch.ok, true);
  if (!branch.ok || !branch.value) return;
  const eventPaths = Object.keys(branch.value.files).filter(path => path.includes("/events/"));
  assert.equal(eventPaths.length, 1);
  assert.equal(branch.value.files[eventPaths[0]].includes("create-project-alpha"), false);

  const replayed = await store.append({
    repository,
    projectId: "project-alpha",
    baseSha,
    expectedHeadSha: baseSha,
    idempotencyKey: "create-project-alpha",
    occurredAt: "2026-07-13T00:00:00.000Z",
    actor: { kind: "user", id: "user-1" },
    command: { type: "CreateProject", title: "Alpha" },
    decide: () => assert.fail("idempotent replay must not decide again")
  });
  assert.equal(replayed.ok && replayed.value.idempotentReplay, true);

  const reused = await store.append({
    repository,
    projectId: "project-alpha",
    baseSha,
    idempotencyKey: "create-project-alpha",
    occurredAt: "2026-07-13T00:01:00.000Z",
    actor: { kind: "user", id: "user-1" },
    command: { type: "CreateProject", title: "Different" },
    decide: () => ({ ok: true, value: [] })
  });
  assert.equal(reused.ok, false);
  if (!reused.ok) assert.equal(reused.error.code, "idempotency_conflict");

  const damagedSnapshot = await transport.commitFiles({
    repository,
    branch: HUNSU_STATE_BRANCH,
    expectedHeadSha: created.value.stateHeadSha,
    message: "damage disposable snapshot",
    updates: [{ path: ".hunsu/projects/project-alpha/snapshots/latest.json", content: "not-json" }]
  });
  assert.equal(damagedSnapshot.ok, true);
  const reconstructed = await store.readProject(repository, "project-alpha");
  assert.equal(reconstructed.ok, true);
  if (reconstructed.ok) assert.deepEqual(reconstructed.value.state, { projectId: "project-alpha", title: "Alpha" });
});

test("repository reconstruction distinguishes a missing state branch from an exact empty snapshot", async () => {
  const memory = new MemoryGitHubTransport([{ repository, initialSha: baseSha }]);
  const store = new GitHubProjectStore(memory, codec);

  const missing = await store.reconstructRepository(repository);
  assert.deepEqual(missing, { ok: true, value: { kind: "state_branch_missing", projects: [] } });

  const created = await memory.createBranch(repository, HUNSU_STATE_BRANCH, baseSha);
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const empty = await store.reconstructRepository(repository);
  assert.deepEqual(empty, {
    ok: true,
    value: { kind: "state_branch", stateHeadSha: created.value.headSha, projects: [] }
  });
});

test("Project discovery and append work when state reads contain only event files", async () => {
  const memory = new MemoryGitHubTransport([{ repository, initialSha: baseSha }]);
  const seedStore = new GitHubProjectStore(memory, codec);
  const alpha = await seedStore.append({
    repository,
    projectId: "project-alpha",
    baseSha,
    idempotencyKey: "create-project-alpha-for-filtered-read",
    occurredAt: "2026-07-13T00:00:00.000Z",
    actor: { kind: "user", id: "user-1" },
    command: { type: "CreateProject", title: "Alpha" },
    decide: () => ({ ok: true, value: [{ type: "ProjectCreated", projectId: "project-alpha", title: "Alpha" }] })
  });
  assert.equal(alpha.ok, true);
  if (!alpha.ok) return;
  const beta = await seedStore.append({
    repository,
    projectId: "project-beta",
    baseSha,
    expectedHeadSha: alpha.value.stateHeadSha,
    idempotencyKey: "create-project-beta-for-filtered-read",
    occurredAt: "2026-07-13T00:01:00.000Z",
    actor: { kind: "user", id: "user-1" },
    command: { type: "CreateProject", title: "Beta" },
    decide: () => ({ ok: true, value: [{ type: "ProjectCreated", projectId: "project-beta", title: "Beta" }] })
  });
  assert.equal(beta.ok, true);
  if (!beta.ok) return;

  const eventOnlyTransport: GitHubTransport = {
    listInstallationRepositories: installationId => memory.listInstallationRepositories(installationId),
    readBranchHead: (target, branch) => memory.readBranchHead(target, branch),
    readBranch: async (target, branch) => {
      const result = await memory.readBranch(target, branch);
      if (!result.ok || !result.value || branch !== HUNSU_STATE_BRANCH) return result;
      return {
        ok: true,
        value: {
          headSha: result.value.headSha,
          files: Object.fromEntries(Object.entries(result.value.files).filter(([path]) => path.includes("/events/")))
        }
      };
    },
    createBranch: (target, branch, fromSha) => memory.createBranch(target, branch, fromSha),
    commitFiles: input => memory.commitFiles(input),
    compareCommits: (target, base, head) => memory.compareCommits(target, base, head),
    commitExists: (target, sha) => memory.commitExists(target, sha)
  };
  const store = new GitHubProjectStore(eventOnlyTransport, codec);
  const discovered = await store.reconstructRepository(repository);
  assert.equal(discovered.ok, true);
  if (!discovered.ok) return;
  assert.equal(discovered.value.kind, "state_branch");
  assert.deepEqual(discovered.value.projects.map(project => project.state), [
    { projectId: "project-alpha", title: "Alpha" },
    { projectId: "project-beta", title: "Beta" }
  ]);

  const renamed = await store.append({
    repository,
    projectId: "project-alpha",
    baseSha,
    expectedHeadSha: beta.value.stateHeadSha,
    idempotencyKey: "rename-project-alpha-from-filtered-read",
    occurredAt: "2026-07-13T00:02:00.000Z",
    actor: { kind: "user", id: "user-1" },
    command: { type: "RenameProject", title: "Alpha renamed" },
    decide: state => state?.title === "Alpha"
      ? { ok: true, value: [{ type: "ProjectRenamed", projectId: "project-alpha", title: "Alpha renamed" }] }
      : { ok: false, error: { code: "invalid_event", message: "filtered read did not reconstruct Alpha" } }
  });
  assert.equal(renamed.ok, true);
  if (!renamed.ok) return;

  const branch = await memory.readBranch(repository, HUNSU_STATE_BRANCH);
  assert.equal(branch.ok, true);
  if (!branch.ok || !branch.value) return;
  const workspace: unknown = JSON.parse(branch.value.files[".hunsu/workspace.json"]);
  assert.ok(isRecord(workspace));
  assert.deepEqual(workspace.projectIds, ["project-alpha", "project-beta"]);
  assert.deepEqual(JSON.parse(branch.value.files[".hunsu/projects/project-alpha/project.json"]), {
    schema: "hunsu.project.v1",
    projectId: "project-alpha",
    title: "Alpha renamed"
  });
});

test("fresh state initialization uses the authoritative created snapshot without a ref reread", async () => {
  const inheritedState = await storedProjectFiles();
  const memory = new MemoryGitHubTransport([{
    repository,
    initialSha: baseSha,
    initialFiles: inheritedState
  }]);
  let stateReads = 0;
  const transport: GitHubTransport = {
    listInstallationRepositories: installationId => memory.listInstallationRepositories(installationId),
    readBranchHead: (target, branch) => memory.readBranchHead(target, branch),
    readBranch: async (target, branch) => {
      if (branch === HUNSU_STATE_BRANCH) {
        stateReads += 1;
        if (stateReads <= 2) return { ok: true, value: undefined };
      }
      return memory.readBranch(target, branch);
    },
    createBranch: (target, branch, fromSha) => memory.createBranch(target, branch, fromSha),
    commitFiles: input => memory.commitFiles(input),
    compareCommits: (target, base, head) => memory.compareCommits(target, base, head),
    commitExists: (target, sha) => memory.commitExists(target, sha)
  };
  const store = new GitHubProjectStore(transport, codec);

  const result = await store.append({
    repository,
    projectId: "project-alpha",
    baseSha,
    idempotencyKey: "created-snapshot",
    occurredAt: "2026-07-13T00:00:00.000Z",
    actor: { kind: "user", id: "user-1" },
    command: { type: "RenameProject", title: "Created snapshot" },
    decide: state => state?.title === "Alpha"
      ? {
          ok: true,
          value: [{ type: "ProjectRenamed", projectId: "project-alpha", title: "Created snapshot" }]
        }
      : { ok: false, error: { code: "invalid_event", message: "Created snapshot did not preserve inherited state." } }
  });

  assert.equal(result.ok, true);
  assert.equal(result.ok && result.value.state.title, "Created snapshot");
  assert.equal(stateReads, 1);
});

test("an invisible concurrent state initialization fails retryably without deciding or committing", async () => {
  const memory = new MemoryGitHubTransport([{ repository, initialSha: baseSha }]);
  let decisions = 0;
  let commits = 0;
  const delays: number[] = [];
  const transport: GitHubTransport = {
    listInstallationRepositories: installationId => memory.listInstallationRepositories(installationId),
    readBranchHead: async () => ({ ok: true, value: undefined }),
    readBranch: async () => ({ ok: true, value: undefined }),
    createBranch: async () => ({
      ok: false,
      error: { code: "conflict", message: "The state branch was created concurrently." }
    }),
    commitFiles: async () => {
      commits += 1;
      return { ok: false, error: { code: "conflict", message: "Unexpected commit." } };
    },
    compareCommits: (target, base, head) => memory.compareCommits(target, base, head),
    commitExists: (target, sha) => memory.commitExists(target, sha)
  };
  const store = new GitHubProjectStore(transport, codec, {
    wait: async delayMs => { delays.push(delayMs); }
  });

  const result = await store.append({
    repository,
    projectId: "project-concurrent-init",
    baseSha,
    idempotencyKey: "concurrent-init",
    occurredAt: "2026-07-13T00:00:00.000Z",
    actor: { kind: "user", id: "user-1" },
    command: { type: "CreateProject", title: "Concurrent" },
    decide: () => {
      decisions += 1;
      return {
        ok: true,
        value: [{ type: "ProjectCreated", projectId: "project-concurrent-init", title: "Concurrent" }]
      };
    }
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "transport");
    assert.equal(result.error.cause?.code, "not_found");
  }
  assert.equal(decisions, 0);
  assert.equal(commits, 0);
  assert.deepEqual(delays, [50, 150]);
});

test("a concurrent state creator is observed through bounded retries before the CAS write", async () => {
  const inheritedState = await storedProjectFiles();
  const winnerHeadSha = "b".repeat(40);
  const memory = new MemoryGitHubTransport([{
    repository,
    initialSha: winnerHeadSha,
    initialFiles: inheritedState,
    branches: {
      [repository.defaultBranch]: baseSha,
      [HUNSU_STATE_BRANCH]: winnerHeadSha
    }
  }]);
  let stateReads = 0;
  const delays: number[] = [];
  const transport: GitHubTransport = {
    listInstallationRepositories: installationId => memory.listInstallationRepositories(installationId),
    readBranchHead: (target, branch) => memory.readBranchHead(target, branch),
    readBranch: async (target, branch) => {
      if (branch === HUNSU_STATE_BRANCH) {
        stateReads += 1;
        if (stateReads <= 2) return { ok: true, value: undefined };
      }
      return memory.readBranch(target, branch);
    },
    createBranch: async () => ({
      ok: false,
      error: { code: "conflict", message: "The state branch was created concurrently." }
    }),
    commitFiles: input => memory.commitFiles(input),
    compareCommits: (target, base, head) => memory.compareCommits(target, base, head),
    commitExists: (target, sha) => memory.commitExists(target, sha)
  };
  const store = new GitHubProjectStore(transport, codec, {
    wait: async delayMs => { delays.push(delayMs); }
  });

  const result = await store.append({
    repository,
    projectId: "project-alpha",
    baseSha,
    idempotencyKey: "concurrent-winner",
    occurredAt: "2026-07-13T00:00:00.000Z",
    actor: { kind: "user", id: "user-1" },
    command: { type: "RenameProject", title: "Concurrent winner" },
    decide: state => state?.title === "Alpha"
      ? {
          ok: true,
          value: [{ type: "ProjectRenamed", projectId: "project-alpha", title: "Concurrent winner" }]
        }
      : { ok: false, error: { code: "invalid_event", message: "Concurrent winner state was not preserved." } }
  });

  assert.equal(result.ok, true);
  assert.equal(result.ok && result.value.state.title, "Concurrent winner");
  assert.equal(stateReads, 3);
  assert.deepEqual(delays, [50]);
});

test("GitHub state reconstructs a valid multi-event command batch", async () => {
  const files = await storedProjectFiles([
    { type: "ProjectCreated", projectId: "project-alpha", title: "Alpha" },
    { type: "ProjectRenamed", projectId: "project-alpha", title: "Beta" }
  ]);
  const store = storeWithState(files);
  const reconstructed = await store.readProject({ ...repository, owner: "HunSu", name: "Sample" }, "project-alpha");
  assert.equal(reconstructed.ok, true, "GitHub repository owner and name casing is not identity-significant");
  if (reconstructed.ok) {
    assert.equal(reconstructed.value.eventCount, 2);
    assert.deepEqual(reconstructed.value.state, { projectId: "project-alpha", title: "Beta" });
  }
});

test("GitHub state rejects an event copied from another repository", async () => {
  const files = await storedProjectFiles();
  const mismatchedRepositories: RepositoryGrant[] = [
    { ...repository, installationId: 18 },
    { ...repository, repositoryId: 43 },
    { ...repository, owner: "example" },
    { ...repository, name: "target" }
  ];
  for (const targetRepository of mismatchedRepositories) {
    const reconstructed = await storeWithState(files, targetRepository).readProject(targetRepository, "project-alpha");
    assert.equal(reconstructed.ok, false);
    if (!reconstructed.ok) {
      assert.equal(reconstructed.error.code, "invalid_event");
      assert.match(reconstructed.error.message, /different GitHub repository/u);
    }
  }
});

test("GitHub state rejects an event whose file path does not match its envelope", async () => {
  const files = await storedProjectFiles();
  const [path, content] = onlyEventFile(files);
  const tampered = { ...files };
  delete tampered[path];
  tampered[path.replace("/2026/07/", "/2026/08/")] = content;

  const reconstructed = await storeWithState(tampered).readProject(repository, "project-alpha");
  assert.equal(reconstructed.ok, false);
  if (!reconstructed.ok) {
    assert.equal(reconstructed.error.code, "invalid_event");
    assert.match(reconstructed.error.message, /does not match its envelope path/u);
  }
});

test("GitHub state rejects a path-consistent but non-deterministic event id", async () => {
  const files = await storedProjectFiles();
  const [path, content] = onlyEventFile(files);
  const envelope = parseEventEnvelope(content);
  const originalEventId = envelope.eventId;
  const tamperedEventId = originalEventId === "f".repeat(32) ? "e".repeat(32) : "f".repeat(32);
  envelope.eventId = tamperedEventId;
  const tampered = { ...files };
  delete tampered[path];
  tampered[path.replace(`${originalEventId}.json`, `${tamperedEventId}.json`)] = `${JSON.stringify(envelope)}\n`;

  const reconstructed = await storeWithState(tampered).readProject(repository, "project-alpha");
  assert.equal(reconstructed.ok, false);
  if (!reconstructed.ok) {
    assert.equal(reconstructed.error.code, "invalid_event");
    assert.match(reconstructed.error.message, /non-deterministic event id/u);
  }
});

test("GitHub state rejects an idempotency hash reused by a different command", async () => {
  const transport = new MemoryGitHubTransport([{ repository, initialSha: baseSha }]);
  const store = new GitHubProjectStore(transport, codec);
  const created = await store.append({
    repository,
    projectId: "project-alpha",
    baseSha,
    idempotencyKey: "create-project-alpha",
    occurredAt: "2026-07-13T00:00:00.000Z",
    actor: { kind: "user", id: "user-1" },
    command: { type: "CreateProject", title: "Alpha" },
    decide: () => ({ ok: true, value: [{ type: "ProjectCreated", projectId: "project-alpha", title: "Alpha" }] })
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const renamed = await store.append({
    repository,
    projectId: "project-alpha",
    baseSha,
    expectedHeadSha: created.value.stateHeadSha,
    idempotencyKey: "rename-project-alpha",
    occurredAt: "2026-07-13T00:01:00.000Z",
    actor: { kind: "user", id: "user-1" },
    command: { type: "RenameProject", title: "Beta" },
    decide: () => ({ ok: true, value: [{ type: "ProjectRenamed", projectId: "project-alpha", title: "Beta" }] })
  });
  assert.equal(renamed.ok, true);
  if (!renamed.ok) return;
  const branch = await transport.readBranch(repository, HUNSU_STATE_BRANCH);
  assert.equal(branch.ok, true);
  if (!branch.ok || !branch.value) return;

  const eventEntries = Object.entries(branch.value.files)
    .filter(([path]) => path.includes("/events/"))
    .map(([path, content]) => ({ path, envelope: parseEventEnvelope(content) }))
    .sort((left, right) => left.envelope.sequence - right.envelope.sequence);
  assert.equal(eventEntries.length, 2);
  eventEntries[1].envelope.idempotencyKeyHash = eventEntries[0].envelope.idempotencyKeyHash;
  const tampered = {
    ...branch.value.files,
    [eventEntries[1].path]: `${JSON.stringify(eventEntries[1].envelope)}\n`
  };
  const reconstructed = await storeWithState(tampered).readProject(repository, "project-alpha");
  assert.equal(reconstructed.ok, false);
  if (!reconstructed.ok) assert.equal(reconstructed.error.code, "idempotency_conflict");
});

test("GitHub state rejects inconsistent metadata inside a multi-event command batch", async () => {
  const files = await storedProjectFiles([
    { type: "ProjectCreated", projectId: "project-alpha", title: "Alpha" },
    { type: "ProjectRenamed", projectId: "project-alpha", title: "Beta" }
  ]);
  const entries = Object.entries(files)
    .filter(([path]) => path.includes("/events/"))
    .map(([path, content]) => ({ path, envelope: parseEventEnvelope(content) }))
    .sort((left, right) => left.envelope.sequence - right.envelope.sequence);
  assert.equal(entries.length, 2);
  entries[1].envelope.actor = { kind: "user", id: "different-user" };
  const tampered = { ...files, [entries[1].path]: `${JSON.stringify(entries[1].envelope)}\n` };

  const reconstructed = await storeWithState(tampered).readProject(repository, "project-alpha");
  assert.equal(reconstructed.ok, false);
  if (!reconstructed.ok) {
    assert.equal(reconstructed.error.code, "invalid_event");
    assert.match(reconstructed.error.message, /inconsistent command event batch metadata/u);
  }
});

test("GitHub state rejects a command batch split by another command", async () => {
  const transport = new MemoryGitHubTransport([{ repository, initialSha: baseSha }]);
  const store = new GitHubProjectStore(transport, codec);
  const created = await store.append({
    repository,
    projectId: "project-alpha",
    baseSha,
    idempotencyKey: "create-and-rename-project-alpha",
    occurredAt: "2026-07-13T00:00:00.000Z",
    actor: { kind: "user", id: "user-1" },
    command: { type: "CreateAndRenameProject", title: "Beta" },
    decide: () => ({ ok: true, value: [
      { type: "ProjectCreated", projectId: "project-alpha", title: "Alpha" },
      { type: "ProjectRenamed", projectId: "project-alpha", title: "Beta" }
    ] })
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const renamed = await store.append({
    repository,
    projectId: "project-alpha",
    baseSha,
    expectedHeadSha: created.value.stateHeadSha,
    idempotencyKey: "rename-project-alpha-again",
    occurredAt: "2026-07-13T00:01:00.000Z",
    actor: { kind: "user", id: "user-1" },
    command: { type: "RenameProject", title: "Gamma" },
    decide: () => ({ ok: true, value: [{ type: "ProjectRenamed", projectId: "project-alpha", title: "Gamma" }] })
  });
  assert.equal(renamed.ok, true);
  if (!renamed.ok) return;
  const branch = await transport.readBranch(repository, HUNSU_STATE_BRANCH);
  assert.equal(branch.ok, true);
  if (!branch.ok || !branch.value) return;

  const entries = Object.entries(branch.value.files)
    .filter(([path]) => path.includes("/events/"))
    .map(([path, content]) => ({ path, envelope: parseEventEnvelope(content) }))
    .sort((left, right) => left.envelope.sequence - right.envelope.sequence);
  assert.equal(entries.length, 3);
  entries[1].envelope.sequence = 3;
  entries[2].envelope.sequence = 2;
  const tampered = {
    ...branch.value.files,
    [entries[1].path]: `${JSON.stringify(entries[1].envelope)}\n`,
    [entries[2].path]: `${JSON.stringify(entries[2].envelope)}\n`
  };
  const reconstructed = await storeWithState(tampered).readProject(repository, "project-alpha");
  assert.equal(reconstructed.ok, false);
  if (!reconstructed.ok) {
    assert.equal(reconstructed.error.code, "invalid_event");
    assert.match(reconstructed.error.message, /non-contiguous command event batch/u);
  }
});

test("GitHub state rejects stale writes and credential-shaped state", async () => {
  const transport = new MemoryGitHubTransport([{ repository, initialSha: baseSha }]);
  const store = new GitHubProjectStore(transport, codec);
  const unsafe = await store.append({
    repository,
    projectId: "project-alpha",
    baseSha,
    idempotencyKey: "unsafe",
    occurredAt: "2026-07-13T00:00:00.000Z",
    actor: { kind: "user", id: "user-1" },
    command: { type: "CreateProject", accessToken: "ghp_example" },
    decide: () => ({ ok: true, value: [{ type: "ProjectCreated", projectId: "project-alpha", title: "Alpha" }] })
  });
  assert.equal(unsafe.ok, false);
  if (!unsafe.ok) assert.equal(unsafe.error.code, "unsafe_state");

  const created = await store.append({
    repository,
    projectId: "project-alpha",
    baseSha,
    idempotencyKey: "safe",
    occurredAt: "2026-07-13T00:00:00.000Z",
    actor: { kind: "user", id: "user-1" },
    command: { type: "CreateProject", title: "Alpha" },
    decide: () => ({ ok: true, value: [{ type: "ProjectCreated", projectId: "project-alpha", title: "Alpha" }] })
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const advanced = await transport.commitFiles({
    repository,
    branch: HUNSU_STATE_BRANCH,
    expectedHeadSha: created.value.stateHeadSha,
    message: "concurrent projection refresh",
    updates: [{ path: ".hunsu/workspace.json", content: "{}" }]
  });
  assert.equal(advanced.ok, true);
  const stale = await store.append({
    repository,
    projectId: "project-alpha",
    baseSha,
    expectedHeadSha: created.value.stateHeadSha,
    idempotencyKey: "rename",
    occurredAt: "2026-07-13T00:02:00.000Z",
    actor: { kind: "user", id: "user-1" },
    command: { type: "RenameProject", title: "Beta" },
    decide: () => ({ ok: true, value: [{ type: "ProjectRenamed", projectId: "project-alpha", title: "Beta" }] })
  });
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.equal(stale.error.code, "stale_state");
});

test("Run completion verifies base ancestry and expected branch reachability", async () => {
  const transport = new MemoryGitHubTransport([{ repository, initialSha: baseSha }]);
  const store = new GitHubProjectStore(transport, codec);
  const branch = await store.createRunBranch({
    repository,
    projectId: "project-alpha",
    goalId: "goal-auth",
    runId: "run-one",
    baseSha
  });
  assert.deepEqual(branch, { ok: true, value: "hunsu/run/project-alpha/goal-auth/run-one" });
  if (!branch.ok) return;
  const result = transport.addCommit({ repository, branch: branch.value, parentSha: baseSha, files: { "result.txt": "done" } });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const retriedBranch = await store.createRunBranch({
    repository,
    projectId: "project-alpha",
    goalId: "goal-auth",
    runId: "run-one",
    baseSha
  });
  assert.deepEqual(retriedBranch, branch, "a lost start response remains retryable after the Run branch advances");
  const verified = await store.verifyRunResult({ repository, branch: branch.value, baseSha, resultSha: result.value });
  assert.equal(verified.ok, true);

  const unrelated = "b".repeat(40);
  const rejected = await store.verifyRunResult({ repository, branch: branch.value, baseSha, resultSha: unrelated });
  assert.equal(rejected.ok, false);
});

test("GitHub webhooks normalize only installation-scoped state signals", () => {
  const statePush = normalizeGitHubWebhook("push", {
    ref: "refs/heads/hunsu/state",
    before: "1".repeat(40),
    after: "2".repeat(40),
    installation: { id: repository.installationId },
    repository: {
      id: repository.repositoryId,
      name: repository.name,
      default_branch: repository.defaultBranch,
      owner: { login: repository.owner }
    }
  });
  assert.equal(statePush.ok, true);
  if (statePush.ok) {
    assert.equal(statePush.value.kind, "state_ref_changed");
    if (statePush.value.kind === "state_ref_changed") assert.deepEqual(statePush.value.repository, repositoryWithoutGrant());
  }

  assert.deepEqual(normalizeGitHubWebhook("push", { ref: "refs/heads/main" }), {
    ok: true,
    value: { kind: "ignored", eventName: "push" }
  });
  assert.equal(normalizeGitHubWebhook("push", {
    ref: "refs/heads/hunsu/state",
    before: "not-a-sha",
    after: "2".repeat(40)
  }).ok, false);
});

function repositoryWithoutGrant() {
  return {
    installationId: repository.installationId,
    repositoryId: repository.repositoryId,
    owner: repository.owner,
    name: repository.name,
    defaultBranch: repository.defaultBranch
  };
}

async function storedProjectFiles(events: readonly Event[] = [
  { type: "ProjectCreated", projectId: "project-alpha", title: "Alpha" }
]): Promise<Record<string, string>> {
  const transport = new MemoryGitHubTransport([{ repository, initialSha: baseSha }]);
  const store = new GitHubProjectStore(transport, codec);
  const appended = await store.append({
    repository,
    projectId: "project-alpha",
    baseSha,
    idempotencyKey: "stored-project-fixture",
    occurredAt: "2026-07-13T00:00:00.000Z",
    actor: { kind: "user", id: "user-1" },
    command: { type: "FixtureMutation", eventCount: events.length },
    decide: () => ({ ok: true, value: events })
  });
  assert.equal(appended.ok, true);
  const branch = await transport.readBranch(repository, HUNSU_STATE_BRANCH);
  assert.equal(branch.ok, true);
  assert.ok(branch.value);
  return { ...branch.value.files };
}

function storeWithState(files: Record<string, string>, targetRepository: RepositoryGrant = repository): GitHubProjectStore<Event, State> {
  const stateHeadSha = "d".repeat(40);
  const transport = new MemoryGitHubTransport([{
    repository: targetRepository,
    initialSha: stateHeadSha,
    initialFiles: files,
    branches: {
      [targetRepository.defaultBranch]: stateHeadSha,
      [HUNSU_STATE_BRANCH]: stateHeadSha
    }
  }]);
  return new GitHubProjectStore(transport, codec);
}

function onlyEventFile(files: Record<string, string>): [string, string] {
  const entries = Object.entries(files).filter(([path]) => path.includes("/events/"));
  assert.equal(entries.length, 1);
  return entries[0];
}

function parseEventEnvelope(content: string): TestEventEnvelope {
  const parsed: unknown = JSON.parse(content);
  if (!isRecord(parsed)
    || typeof parsed.eventId !== "string"
    || typeof parsed.sequence !== "number"
    || !Number.isSafeInteger(parsed.sequence)
    || typeof parsed.idempotencyKeyHash !== "string"
  ) {
    assert.fail("test fixture must contain a stored event envelope");
  }
  return {
    ...parsed,
    eventId: parsed.eventId,
    sequence: parsed.sequence,
    idempotencyKeyHash: parsed.idempotencyKeyHash,
    actor: parsed.actor
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
