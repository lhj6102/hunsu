import assert from "node:assert/strict";
import test from "node:test";
import { gzipSync as gzipBomb } from "node:zlib";
import type { NodePayload } from "../packages/protocol/src/index.ts";
import {
  GitHubProjectStore,
  HUNSU_STATE_BRANCH,
  MemoryGitHubTransport,
  decodeNodeEnvelope,
  encodeNodeEnvelope,
  normalizeGitHubWebhook,
  type ProjectStateCodec,
  type BranchSnapshot,
  type NodeStateAnchor,
  type RepositoryGrant,
  type RepositoryLocator,
  type GitHubTransport,
  type StateActor,
  type StoreResult,
  type TransportResult
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
  nodeAnchors: () => [],
  encodeEvent: event => ({ ok: true, value: event }),
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
  materialize: state => ({ ok: true, value: {
    "project.json": { schema: "hunsu.project.v2", ...state },
    "snapshots/latest.json": state
  } })
};

test("GitHub state writes are append-only, idempotent, and reconstruct from events", async () => {
  const transport = new MemoryGitHubTransport([{ repository, initialSha: baseSha }]);
  const store = new GitHubProjectStore(transport, codec);
  const created = await store.append({
    repository,
    projectId: "project-alpha",
    baseSha,
    expectedHeadSha: baseSha,
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
    expectedHeadSha: baseSha,
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
    updates: [{ path: ".hunsu/v2/projects/project-alpha/snapshots/latest.json", content: "not-json" }]
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

test("every append requires an explicit full expected state head", async () => {
  const memory = new MemoryGitHubTransport([{ repository, initialSha: baseSha }]);
  const store = new GitHubProjectStore(memory, codec);
  let decisions = 0;
  const result = await store.append({
    repository,
    projectId: "project-alpha",
    baseSha,
    idempotencyKey: "missing-cas",
    occurredAt: "2026-07-13T00:00:00.000Z",
    actor: { kind: "user", id: "user-1" },
    command: { type: "CreateProject" },
    decide: () => {
      decisions += 1;
      return { ok: true, value: [{ type: "ProjectCreated", projectId: "project-alpha", title: "Alpha" }] };
    }
  } as unknown as Parameters<typeof store.append>[0]);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "invalid_event");
    assert.match(result.error.message, /Expected state SHA/u);
  }
  assert.equal(decisions, 0);
  assert.deepEqual(await memory.readBranch(repository, HUNSU_STATE_BRANCH), { ok: true, value: undefined });
});

test("stale bootstrap CAS does not create the Hunsu state branch", async () => {
  class TrackingMemoryTransport extends MemoryGitHubTransport {
    createBranchCalls = 0;
    commitFilesCalls = 0;

    override async createBranch(...args: Parameters<MemoryGitHubTransport["createBranch"]>) {
      this.createBranchCalls += 1;
      return super.createBranch(...args);
    }

    override async commitFiles(...args: Parameters<MemoryGitHubTransport["commitFiles"]>) {
      this.commitFilesCalls += 1;
      return super.commitFiles(...args);
    }
  }
  const memory = new TrackingMemoryTransport([{ repository, initialSha: baseSha }]);
  const store = new GitHubProjectStore(memory, codec);
  const staleExpected = "b".repeat(40);
  let decisions = 0;

  const result = await store.append({
    repository,
    projectId: "project-alpha",
    baseSha,
    expectedHeadSha: staleExpected,
    idempotencyKey: "stale-bootstrap",
    occurredAt: "2026-07-13T00:00:00.000Z",
    actor: { kind: "user", id: "user-1" },
    command: { type: "CreateProject", title: "Alpha" },
    decide: () => {
      decisions += 1;
      return { ok: true, value: [{ type: "ProjectCreated", projectId: "project-alpha", title: "Alpha" }] };
    }
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "stale_state");
    assert.equal(result.error.expectedHeadSha, staleExpected);
    assert.equal(result.error.actualHeadSha, baseSha);
  }
  assert.equal(memory.createBranchCalls, 0);
  assert.equal(memory.commitFilesCalls, 0);
  assert.equal(decisions, 0);
  assert.deepEqual(await memory.readBranch(repository, HUNSU_STATE_BRANCH), { ok: true, value: undefined });
});

test("Project discovery and append work when state reads contain only event files", async () => {
  const memory = new MemoryGitHubTransport([{ repository, initialSha: baseSha }]);
  const seedStore = new GitHubProjectStore(memory, codec);
  const alpha = await seedStore.append({
    repository,
    projectId: "project-alpha",
    baseSha,
    expectedHeadSha: baseSha,
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
    readStateFilesAtHead: (target, head, selections) => memory.readStateFilesAtHead(target, head, selections),
    createBranch: (target, branch, fromSha) => memory.createBranch(target, branch, fromSha),
    listManagedNodeAnchors: (target, projectId) => memory.listManagedNodeAnchors(target, projectId),
    readManagedNodeAnchors: (target, projectId, nodeShas) => memory.readManagedNodeAnchors(target, projectId, nodeShas),
    commitFiles: input => memory.commitFiles(input),
    compareCommits: (target, base, head) => memory.compareCommits(target, base, head),
    commitExists: (target, sha) => memory.commitExists(target, sha),
    readRef: (target, ref) => memory.readRef(target, ref),
    createRef: (target, ref, sha) => memory.createRef(target, ref, sha),
    readCommit: (target, sha) => memory.readCommit(target, sha),
    createCommit: input => memory.createCommit(input)
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
  const workspace: unknown = JSON.parse(branch.value.files[".hunsu/v2/workspace.json"]);
  assert.ok(isRecord(workspace));
  assert.deepEqual(workspace.projectIds, ["project-alpha", "project-beta"]);
  assert.deepEqual(JSON.parse(branch.value.files[".hunsu/v2/projects/project-alpha/project.json"]), {
    schema: "hunsu.project.v2",
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
    readStateFilesAtHead: (target, head, selections) => memory.readStateFilesAtHead(target, head, selections),
    createBranch: (target, branch, fromSha) => memory.createBranch(target, branch, fromSha),
    listManagedNodeAnchors: (target, projectId) => memory.listManagedNodeAnchors(target, projectId),
    readManagedNodeAnchors: (target, projectId, nodeShas) => memory.readManagedNodeAnchors(target, projectId, nodeShas),
    commitFiles: input => memory.commitFiles(input),
    compareCommits: (target, base, head) => memory.compareCommits(target, base, head),
    commitExists: (target, sha) => memory.commitExists(target, sha),
    readRef: (target, ref) => memory.readRef(target, ref),
    createRef: (target, ref, sha) => memory.createRef(target, ref, sha),
    readCommit: (target, sha) => memory.readCommit(target, sha),
    createCommit: input => memory.createCommit(input)
  };
  const store = new GitHubProjectStore(transport, codec);

  const result = await store.append({
    repository,
    projectId: "project-alpha",
    baseSha,
    expectedHeadSha: baseSha,
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
    readStateFilesAtHead: (target, head, selections) => memory.readStateFilesAtHead(target, head, selections),
    createBranch: async () => ({
      ok: false,
      error: { code: "conflict", message: "The state branch was created concurrently." }
    }),
    listManagedNodeAnchors: (target, projectId) => memory.listManagedNodeAnchors(target, projectId),
    readManagedNodeAnchors: (target, projectId, nodeShas) => memory.readManagedNodeAnchors(target, projectId, nodeShas),
    commitFiles: async () => {
      commits += 1;
      return { ok: false, error: { code: "conflict", message: "Unexpected commit." } };
    },
    compareCommits: (target, base, head) => memory.compareCommits(target, base, head),
    commitExists: (target, sha) => memory.commitExists(target, sha),
    readRef: (target, ref) => memory.readRef(target, ref),
    createRef: (target, ref, sha) => memory.createRef(target, ref, sha),
    readCommit: (target, sha) => memory.readCommit(target, sha),
    createCommit: input => memory.createCommit(input)
  };
  const store = new GitHubProjectStore(transport, codec, {
    wait: async delayMs => { delays.push(delayMs); }
  });

  const result = await store.append({
    repository,
    projectId: "project-concurrent-init",
    baseSha,
    expectedHeadSha: baseSha,
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

test("a concurrent state creator is observed and rejected against the caller's exact state head", async () => {
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
  let decisions = 0;
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
    readStateFilesAtHead: (target, head, selections) => memory.readStateFilesAtHead(target, head, selections),
    createBranch: async () => ({
      ok: false,
      error: { code: "conflict", message: "The state branch was created concurrently." }
    }),
    listManagedNodeAnchors: (target, projectId) => memory.listManagedNodeAnchors(target, projectId),
    readManagedNodeAnchors: (target, projectId, nodeShas) => memory.readManagedNodeAnchors(target, projectId, nodeShas),
    commitFiles: input => memory.commitFiles(input),
    compareCommits: (target, base, head) => memory.compareCommits(target, base, head),
    commitExists: (target, sha) => memory.commitExists(target, sha),
    readRef: (target, ref) => memory.readRef(target, ref),
    createRef: (target, ref, sha) => memory.createRef(target, ref, sha),
    readCommit: (target, sha) => memory.readCommit(target, sha),
    createCommit: input => memory.createCommit(input)
  };
  const store = new GitHubProjectStore(transport, codec, {
    wait: async delayMs => { delays.push(delayMs); }
  });

  const result = await store.append({
    repository,
    projectId: "project-alpha",
    baseSha,
    expectedHeadSha: baseSha,
    idempotencyKey: "concurrent-winner",
    occurredAt: "2026-07-13T00:00:00.000Z",
    actor: { kind: "user", id: "user-1" },
    command: { type: "RenameProject", title: "Concurrent winner" },
    decide: state => {
      decisions += 1;
      return state?.title === "Alpha" ? {
          ok: true,
          value: [{ type: "ProjectRenamed", projectId: "project-alpha", title: "Concurrent winner" }]
        }
        : { ok: false, error: { code: "invalid_event", message: "Concurrent winner state was not preserved." } };
    }
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "stale_state");
    assert.equal(result.error.expectedHeadSha, baseSha);
    assert.equal(result.error.actualHeadSha, winnerHeadSha);
  }
  assert.equal(decisions, 0);
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

test("reconstruction verifies registered Node tags and commits in one batched boundary", async () => {
  const files = await storedProjectFiles();
  const nodeSha = "d".repeat(40);

  async function fixture() {
    const memory = new MemoryGitHubTransport([{
      repository,
      initialSha: nodeSha,
      initialFiles: files,
      initialMessage: "Root node\n\nInitial Hunsu Node.",
      branches: { [repository.defaultBranch]: nodeSha, [HUNSU_STATE_BRANCH]: nodeSha }
    }]);
    const commit = await memory.readCommit(repository, nodeSha);
    assert.equal(commit.ok && commit.value !== undefined, true);
    if (!commit.ok || !commit.value) throw new Error("Node commit fixture is missing");
    const anchor: NodeStateAnchor = {
      projectId: "project-alpha",
      nodeSha,
      treeSha: commit.value.treeSha,
      managedRef: `refs/tags/hunsu/node/project-alpha/${nodeSha}`,
      commitTitle: "Root node"
    };
    return { memory, anchor };
  }

  const valid = await fixture();
  assert.equal((await valid.memory.createRef(repository, valid.anchor.managedRef, nodeSha)).ok, true);
  const orphan = valid.memory.addCommit({ repository, branch: "orphan", parentSha: nodeSha, message: "Orphan Node" });
  assert.equal(orphan.ok, true);
  if (!orphan.ok) return;
  assert.equal((await valid.memory.createRef(
    repository,
    `refs/tags/hunsu/node/project-alpha/${orphan.value}`,
    orphan.value
  )).ok, true);
  let batchedReads = 0;
  let perNodeReads = 0;
  const counted = new Proxy(valid.memory, {
    get(target, property) {
      if (property === "listManagedNodeAnchors") return async (...args: Parameters<GitHubTransport["listManagedNodeAnchors"]>) => {
        batchedReads += 1;
        return await target.listManagedNodeAnchors(...args);
      };
      if (property === "readRef" || property === "readCommit") return async () => {
        perNodeReads += 1;
        throw new Error("reconstruction must not perform per-Node GitHub reads");
      };
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    }
  }) as GitHubTransport;
  const validStore = new GitHubProjectStore(counted, { ...codec, nodeAnchors: () => [valid.anchor] });
  assert.equal((await validStore.readProject(repository, "project-alpha")).ok, true, "an orphan tag remains invisible until its CAS retry");
  assert.equal(batchedReads, 1);
  assert.equal(perNodeReads, 0);

  const missing = await fixture();
  const missingResult = await new GitHubProjectStore(missing.memory, { ...codec, nodeAnchors: () => [missing.anchor] })
    .readProject(repository, "project-alpha");
  assert.equal(missingResult.ok, false);
  if (!missingResult.ok) assert.match(missingResult.error.message, /missing or points to another commit/u);

  const moved = await fixture();
  const other = moved.memory.addCommit({ repository, branch: "other", parentSha: nodeSha, message: "Other commit" });
  assert.equal(other.ok, true);
  if (!other.ok) return;
  assert.equal((await moved.memory.createRef(repository, moved.anchor.managedRef, other.value)).ok, true);
  const movedResult = await new GitHubProjectStore(moved.memory, { ...codec, nodeAnchors: () => [moved.anchor] })
    .readProject(repository, "project-alpha");
  assert.equal(movedResult.ok, false);
  if (!movedResult.ok) assert.match(movedResult.error.message, /missing or points to another commit/u);

  const wrongTree = await fixture();
  assert.equal((await wrongTree.memory.createRef(repository, wrongTree.anchor.managedRef, nodeSha)).ok, true);
  const treeResult = await new GitHubProjectStore(wrongTree.memory, {
    ...codec,
    nodeAnchors: () => [{ ...wrongTree.anchor, treeSha: "e".repeat(40) }]
  }).readProject(repository, "project-alpha");
  assert.equal(treeResult.ok, false);
  if (!treeResult.ok) assert.match(treeResult.error.message, /unexpected tree SHA/u);
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

test("GitHub state rejects unknown keys in stored event, repository, and actor envelopes", async () => {
  const topLevel = await storedProjectFiles();
  await assertEnvelopeTamperRejected(topLevel, envelope => {
    envelope.legacyRevision = 1;
  });

  const repositoryEnvelope = await storedProjectFiles();
  await assertEnvelopeTamperRejected(repositoryEnvelope, envelope => {
    assert.ok(isRecord(envelope.repository));
    envelope.repository.defaultBranch = "main";
  });

  const actorCases: readonly { actor: StateActor; legacyKey: string; legacyValue: string }[] = [
    { actor: { kind: "user", id: "user-1" }, legacyKey: "clientId", legacyValue: "legacy-client" },
    {
      actor: { kind: "plugin", userId: "user-1", clientId: "codex" },
      legacyKey: "id",
      legacyValue: "legacy-plugin"
    },
    { actor: { kind: "system", operation: "rebuild" }, legacyKey: "userId", legacyValue: "legacy-system" }
  ];
  for (const { actor, legacyKey, legacyValue } of actorCases) {
    const files = await storedProjectFiles(undefined, actor);
    const valid = await storeWithState(files).readProject(repository, "project-alpha");
    assert.equal(valid.ok, true, `${actor.kind} actor fixture must be accepted before tampering`);
    await assertEnvelopeTamperRejected(files, envelope => {
      assert.ok(isRecord(envelope.actor));
      envelope.actor[legacyKey] = legacyValue;
    });
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
    expectedHeadSha: baseSha,
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

test("GitHub state rejects an incomplete declared multi-event command batch", async () => {
  const files = await storedProjectFiles([
    { type: "ProjectCreated", projectId: "project-alpha", title: "Alpha" },
    { type: "ProjectRenamed", projectId: "project-alpha", title: "Beta" }
  ]);
  const entries = Object.entries(files).filter(([path]) => path.includes("/events/"));
  assert.equal(entries.length, 2);
  const second = entries.find(([, content]) => parseEventEnvelope(content).sequence === 2);
  assert.ok(second);
  delete files[second[0]];
  const reconstructed = await storeWithState(files).readProject(repository, "project-alpha");
  assert.equal(reconstructed.ok, false);
  if (!reconstructed.ok) {
    assert.equal(reconstructed.error.code, "invalid_event");
    assert.match(reconstructed.error.message, /incomplete command event batch/u);
  }
});

test("GitHub state rejects a command batch split by another command", async () => {
  const transport = new MemoryGitHubTransport([{ repository, initialSha: baseSha }]);
  const store = new GitHubProjectStore(transport, codec);
  const created = await store.append({
    repository,
    projectId: "project-alpha",
    baseSha,
    expectedHeadSha: baseSha,
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
    expectedHeadSha: baseSha,
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
    expectedHeadSha: baseSha,
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
    updates: [{ path: ".hunsu/v2/workspace.json", content: "{}" }]
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
    runId: "run-one",
    sourceNodeSha: baseSha
  });
  assert.deepEqual(branch, { ok: true, value: `hunsu/run/project-alpha/${baseSha}/run-one` });
  if (!branch.ok) return;
  const result = transport.addCommit({ repository, branch: branch.value, parentSha: baseSha, files: { "result.txt": "done" } });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const retriedBranch = await store.createRunBranch({
    repository,
    projectId: "project-alpha",
    runId: "run-one",
    sourceNodeSha: baseSha
  });
  assert.deepEqual(retriedBranch, branch, "a lost start response remains retryable after the Run branch advances");
  const verified = await store.verifyRunResult({ repository, branch: branch.value, baseSha, resultSha: result.value });
  assert.equal(verified.ok, true);

  const unrelated = "b".repeat(40);
  const rejected = await store.verifyRunResult({ repository, branch: branch.value, baseSha, resultSha: unrelated });
  assert.equal(rejected.ok, false);

  const unchanged = await store.verifyRunResult({ repository, branch: branch.value, baseSha, resultSha: baseSha });
  assert.equal(unchanged.ok, false);
  if (!unchanged.ok) assert.match(unchanged.error.message, /distinct from its source Node/u);

  const wrongBaseBranch = await store.verifyRunResult({
    repository,
    branch: `hunsu/run/project-alpha/${"b".repeat(40)}/run-one`,
    baseSha,
    resultSha: result.value
  });
  assert.equal(wrongBaseBranch.ok, false);
  if (!wrongBaseBranch.ok) assert.match(wrongBaseBranch.error.message, /expected branch/u);

  const loosePrefix = await store.verifyRunResult({
    repository,
    branch: "hunsu/run/not-a-node-scoped-branch",
    baseSha,
    resultSha: result.value
  });
  assert.equal(loosePrefix.ok, false);
});

test("Run branch creation recovers an identical create-ref race", async () => {
  class RacingMemoryTransport extends MemoryGitHubTransport {
    #race = true;

    override async createBranch(
      target: RepositoryLocator,
      branch: string,
      fromSha: string
    ): Promise<TransportResult<BranchSnapshot>> {
      const created = await super.createBranch(target, branch, fromSha);
      if (this.#race && created.ok) {
        this.#race = false;
        return { ok: false, error: { code: "conflict", message: "ref raced", status: 422 } };
      }
      return created;
    }
  }

  const transport = new RacingMemoryTransport([{ repository, initialSha: baseSha }]);
  const store = new GitHubProjectStore(transport, codec);
  const created = await store.createRunBranch({
    repository,
    projectId: "project-alpha",
    runId: "run-raced",
    sourceNodeSha: baseSha
  });
  assert.deepEqual(created, { ok: true, value: `hunsu/run/project-alpha/${baseSha}/run-raced` });
});

test("Node payload envelopes are deterministic, bounded, and exact", () => {
  const payload = {
    schema: "hunsu.node-payload.v1",
    projectId: "project-alpha",
    commitSha: baseSha,
    treeSha: "c".repeat(40),
    plan: {
      schema: "hunsu.node-plan.v1",
      nextGoals: [{
        key: "goal-one",
        title: "One",
        desiredOutcome: "One is complete",
        acceptanceCriteria: ["One works"],
        constraints: [],
        priority: 0
      }],
      how: {
        schema: "hunsu.runner-value.v1",
        type: {
          origin: "bundled",
          key: "player",
          schemaVersion: "1.0.0",
          integrity: `hunsu-runner-type-v1:sha256:${"d".repeat(64)}`
        },
        name: "Player",
        value: { mode: "careful" }
      }
    }
  } as unknown as NodePayload;
  const first = encodeNodeEnvelope(payload);
  const second = encodeNodeEnvelope({
    treeSha: payload.treeSha,
    plan: payload.plan,
    schema: payload.schema,
    commitSha: payload.commitSha,
    projectId: payload.projectId
  });
  assert.equal(first.ok, true);
  assert.deepEqual(second, first, "canonical JSON and deterministic gzip must produce the same envelope");
  if (!first.ok) return;

  const decoded = decodeNodeEnvelope(first.value);
  assert.equal(decoded.ok, true);
  if (decoded.ok) assert.deepEqual(decoded.value.value, payload);

  const extraField = decodeNodeEnvelope({ ...first.value, executable: "forbidden" });
  assert.equal(extraField.ok, false);
  const wrongDigest = decodeNodeEnvelope({ ...first.value, digest: `hunsu-node-payload-v1:sha256:${"0".repeat(64)}` });
  assert.equal(wrongDigest.ok, false);
  const nonCanonicalBase64 = decodeNodeEnvelope({
    ...first.value,
    data: `${first.value.data}\n`,
    encodedSize: first.value.encodedSize + 1
  });
  assert.equal(nonCanonicalBase64.ok, false);

  const oversizedDecodedData = gzipBomb("x".repeat(2_000_000), { level: 9 }).toString("base64");
  const forgedDecodedSize = decodeNodeEnvelope({
    ...first.value,
    data: oversizedDecodedData,
    encodedSize: Buffer.byteLength(oversizedDecodedData, "utf8")
  });
  assert.equal(forgedDecodedSize.ok, false, "gzip expansion must be rejected from its footer before decompression");

  const oversized = encodeNodeEnvelope({
    ...payload,
    plan: { ...payload.plan, how: { ...payload.plan.how, value: { content: "x".repeat(1_048_577) } } }
  });
  assert.equal(oversized.ok, false);
});

test("managed Node tags and Coaching commits are immutable and retryable", async () => {
  const transport = new MemoryGitHubTransport([{ repository, initialSha: baseSha }]);
  const store = new GitHubProjectStore(transport, codec);
  const root = await store.anchorNode({ repository, projectId: "project-alpha", nodeSha: baseSha });
  assert.deepEqual(root, {
    ok: true,
    value: `refs/tags/hunsu/node/project-alpha/${baseSha}`
  });
  assert.deepEqual(await store.anchorNode({ repository, projectId: "project-alpha", nodeSha: baseSha }), root);

  const coached = await store.createCoachingNode({
    repository,
    projectId: "project-alpha",
    sourceSha: baseSha,
    proposalId: "proposal-one",
    planDigest: `hunsu-node-plan-v1:sha256:${"b".repeat(64)}`,
    proposedAt: "2026-07-14T01:02:03.000Z"
  });
  assert.equal(coached.ok, true);
  if (!coached.ok) return;
  assert.notEqual(coached.value.nodeSha, baseSha);
  const source = await transport.readCommit(repository, baseSha);
  const child = await transport.readCommit(repository, coached.value.nodeSha);
  assert.equal(source.ok && child.ok, true);
  if (!source.ok || !source.value || !child.ok || !child.value) return;
  assert.equal(child.value.treeSha, source.value.treeSha);
  assert.deepEqual(child.value.parentShas, [baseSha]);

  const retry = await store.createCoachingNode({
    repository,
    projectId: "project-alpha",
    sourceSha: baseSha,
    proposalId: "proposal-one",
    planDigest: `hunsu-node-plan-v1:sha256:${"b".repeat(64)}`,
    proposedAt: "2026-07-14T01:02:03.000Z"
  });
  assert.deepEqual(retry, coached, "a lost response must reproduce the same commit and managed tag");

  const alternative = transport.addCommit({
    repository,
    branch: "hunsu/run/project-alpha/goal-one/run-two",
    parentSha: baseSha,
    files: { "result.txt": "alternative" }
  });
  assert.equal(alternative.ok, true);
  if (!alternative.ok) return;
  const conflictingRef = `refs/tags/hunsu/node/project-beta/${baseSha}`;
  assert.equal((await transport.createRef(repository, conflictingRef, alternative.value)).ok, true);
  const mismatch = await store.anchorNode({ repository, projectId: "project-beta", nodeSha: baseSha });
  assert.equal(mismatch.ok, false);
  if (!mismatch.ok) assert.equal(mismatch.error.code, "integrity");
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
], actor: StateActor = { kind: "user", id: "user-1" }): Promise<Record<string, string>> {
  const transport = new MemoryGitHubTransport([{ repository, initialSha: baseSha }]);
  const store = new GitHubProjectStore(transport, codec);
  const appended = await store.append({
    repository,
    projectId: "project-alpha",
    baseSha,
    expectedHeadSha: baseSha,
    idempotencyKey: "stored-project-fixture",
    occurredAt: "2026-07-13T00:00:00.000Z",
    actor,
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

async function assertEnvelopeTamperRejected(
  files: Record<string, string>,
  mutate: (envelope: TestEventEnvelope) => void
): Promise<void> {
  const [path, content] = onlyEventFile(files);
  const envelope = parseEventEnvelope(content);
  mutate(envelope);
  const result = await storeWithState({ ...files, [path]: `${JSON.stringify(envelope)}\n` })
    .readProject(repository, "project-alpha");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "invalid_event");
    assert.match(result.error.message, /invalid event envelope/u);
  }
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
