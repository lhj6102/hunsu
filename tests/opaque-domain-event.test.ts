import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeOpaqueDomainEvent,
  encodeOpaqueDomainEvent
} from "../apps/api/src/opaque-domain-event.ts";
import {
  bundledRunnerTypes,
  projectStateCodec
} from "../apps/api/src/project-codec.ts";
import {
  SHARDED_READ_MODEL_PATHS,
  decodeActivityManifest,
  decodeEventManifest,
  decodeEventShard,
  decodeGraphManifest,
  decodeGraphPage,
  decodeShardedProjectCatalog
} from "../apps/api/src/sharded-read-models.ts";
import {
  GitHubProjectStore,
  HUNSU_STATE_BRANCH,
  MemoryGitHubTransport,
  encodeNodeEnvelope,
  type RepositoryGrant
} from "../packages/github-store/src/index.ts";
import {
  NODE_PAYLOAD_SCHEMA,
  RUNNER_VALUE_SCHEMA,
  computeGoalDigest,
  computeNodePayloadDigest,
  computeNodePlanDigest,
  computeRunnerDigest,
  err,
  ok,
  managedNodeRef,
  runBranchName,
  type AcceptanceCriterion,
  type CanonicalJsonValue,
  type CommandFingerprint,
  type DesiredOutcome,
  type DomainEvent,
  type EventId,
  type GitCommitSha,
  type GoalKey,
  type GoalTitle,
  type GoalValue,
  type IdempotencyKey,
  type IsoTimestamp,
  type NonEmptyText,
  type NonNegativeInteger,
  type ProjectId,
  type Project,
  type RootNode,
  type RunId,
  type RunnerSchemaVersion,
  type RunnerTypeIntegrity,
  type RunnerTypeKey,
  type RunnerTypeLock,
  type RunnerTypeOrigin,
  type RunnerValue,
  type RunnerValueTypeRegistry
} from "../packages/protocol/src/index.ts";

const runnerType: RunnerTypeLock = {
  origin: "qa.example" as RunnerTypeOrigin,
  key: "custom/opaque-test" as RunnerTypeKey,
  schemaVersion: "1.0.0" as RunnerSchemaVersion,
  integrity: `hunsu-runner-type-v1:sha256:${"a".repeat(64)}` as RunnerTypeIntegrity
};

const runnerTypes: RunnerValueTypeRegistry = [{
  type: runnerType,
  decode(value, path) {
    if (isRecord(value) && Object.keys(value).length === 1 && typeof value.prompt === "string") {
      return ok(value);
    }
    return err({ type: "RunnerValueDecodeError", path, message: "payload must contain exactly prompt" });
  }
}];

const projectId = "project-opaque" as ProjectId;
const runId = "run-opaque" as RunId;
const sourceNodeSha = "a".repeat(40) as GitCommitSha;
const startedAt = "2026-07-15T00:00:00.000Z" as IsoTimestamp;
const goal: GoalValue = {
  key: "opaque-goal" as GoalKey,
  title: "SENSITIVE GOAL TITLE" as GoalTitle,
  desiredOutcome: "The opaque event round-trips." as DesiredOutcome,
  acceptanceCriteria: ["The event bytes remain hidden." as AcceptanceCriterion],
  constraints: [],
  priority: 1 as NonNegativeInteger
};
const runner: RunnerValue = {
  schema: RUNNER_VALUE_SCHEMA,
  type: runnerType,
  name: "SENSITIVE RUNNER NAME" as NonEmptyText,
  value: { prompt: "SENSITIVE RUNNER PROMPT" }
};
const event: DomainEvent = {
  type: "RunStarted",
  meta: {
    eventId: "event-opaque" as EventId,
    idempotencyKey: "b".repeat(64) as IdempotencyKey,
    fingerprint: "c".repeat(64) as CommandFingerprint,
    actor: { type: "plugin", id: "opaque-test" as NonEmptyText },
    recordedAt: startedAt
  },
  run: {
    id: runId,
    projectId,
    sourceNodeSha,
    goal,
    goalDigest: computeGoalDigest(goal),
    runner,
    runnerDigest: computeRunnerDigest(runner),
    branch: runBranchName(projectId, sourceNodeSha, runId),
    checkpoints: [],
    evidenceIds: [],
    startedAt,
    status: "running"
  }
};

test("opaque Domain events are deterministic and contain no plaintext Goal or Runner values", () => {
  const first = encodeOpaqueDomainEvent(event);
  const second = encodeOpaqueDomainEvent(event);
  if (!first.ok) assert.fail(first.error.message);
  assert.deepEqual(second, first);

  const raw = JSON.stringify(first.value);
  assert.equal(raw.includes(String(goal.title)), false);
  assert.equal(raw.includes(String(runner.name)), false);
  assert.equal(raw.includes(String((runner.value as { prompt: string }).prompt)), false);
  assert.deepEqual(decodeOpaqueDomainEvent(first.value, runnerTypes), ok(event));
});

test("opaque Domain event decoding rejects metadata, digest, and shape tampering", () => {
  const encoded = encodeOpaqueDomainEvent(event);
  if (!encoded.ok) assert.fail(encoded.error.message);
  assert.equal(decodeOpaqueDomainEvent({ ...encoded.value, digest: `hunsu-domain-event-v2:sha256:${"0".repeat(64)}` }, runnerTypes).ok, false);
  assert.equal(decodeOpaqueDomainEvent({ ...encoded.value, decodedSize: encoded.value.decodedSize + 1 }, runnerTypes).ok, false);
  assert.equal(decodeOpaqueDomainEvent({ ...encoded.value, legacy: true }, runnerTypes).ok, false);
  assert.equal(decodeOpaqueDomainEvent({ ...encoded.value, data: "not base64" }, runnerTypes).ok, false);
});

test("GitHub state event files contain no plaintext Goal title, Runner name, or prompt", async () => {
  const repository: RepositoryGrant = {
    installationId: 41,
    repositoryId: 42,
    owner: "qa-owner",
    name: "qa-repository",
    defaultBranch: "main",
    private: true,
    permissions: { contents: "write" }
  };
  const baseSha = "d".repeat(40);
  const transport = new MemoryGitHubTransport([{
    repository,
    initialSha: baseSha,
    initialMessage: "Opaque root"
  }]);
  const store = new GitHubProjectStore(transport, projectStateCodec);
  const baseCommit = await transport.readCommit(repository, baseSha);
  if (!baseCommit.ok || !baseCommit.value) assert.fail("base commit is missing");
  const treeSha = baseCommit.value.treeSha as import("../packages/protocol/src/index.ts").GitTreeSha;
  const bundledType = bundledRunnerTypes.find(candidate => candidate.type.key === "runner.player")?.type;
  if (!bundledType) assert.fail("bundled Player Runner type is missing");
  const opaqueRunner: RunnerValue = {
    schema: RUNNER_VALUE_SCHEMA,
    type: bundledType,
    name: "RAW STATE MUST HIDE THIS RUNNER" as NonEmptyText,
    value: {
      promptTemplate: "RAW STATE MUST HIDE THIS PROMPT",
      resources: [],
      runtimePolicy: {
        filesystem: "worktree_write",
        network: "enabled",
        approvals: "on_request"
      }
    }
  };
  const opaqueGoal: GoalValue = {
    ...goal,
    title: "RAW STATE MUST HIDE THIS GOAL" as GoalTitle
  };
  const plan = {
    schema: "hunsu.node-plan.v1" as const,
    nextGoals: [opaqueGoal],
    how: opaqueRunner
  };
  const rootSha = baseSha as GitCommitSha;
  const nodePayload = {
    schema: NODE_PAYLOAD_SCHEMA,
    projectId,
    commitSha: rootSha,
    treeSha,
    plan
  };
  const payload = encodeNodeEnvelope(nodePayload);
  if (!payload.ok) assert.fail(payload.error.message);
  const root: RootNode = {
    type: "root",
    projectId,
    commitSha: rootSha,
    treeSha,
    managedRef: managedNodeRef(projectId, rootSha),
    commitTitle: "Opaque root" as NonEmptyText,
    plan,
    planDigest: computeNodePlanDigest(plan),
    payloadDigest: computeNodePayloadDigest(nodePayload),
    registeredAt: startedAt
  };
  const project: Project = {
    id: projectId,
    workspaceId: "workspace-opaque" as import("../packages/protocol/src/index.ts").WorkspaceId,
    repository: {
      owner: repository.owner as import("../packages/protocol/src/index.ts").RepositoryOwner,
      name: repository.name as import("../packages/protocol/src/index.ts").RepositoryName
    },
    baseRef: "refs/heads/main" as import("../packages/protocol/src/index.ts").GitRef,
    title: "Opaque project" as import("../packages/protocol/src/index.ts").ProjectTitle,
    rootNodeSha: rootSha,
    createdAt: startedAt
  };
  const commonMeta = {
    idempotencyKey: "f".repeat(64) as IdempotencyKey,
    fingerprint: "1".repeat(64) as CommandFingerprint,
    actor: { type: "user" as const, id: "qa-user" as NonEmptyText },
    recordedAt: startedAt
  };
  const events: readonly DomainEvent[] = [
    {
      type: "ProjectCreated",
      meta: { ...commonMeta, eventId: "event-project-created" as EventId },
      project
    },
    {
      type: "RootNodeRegistered",
      meta: { ...commonMeta, eventId: "event-root-registered" as EventId },
      node: root,
      payload: payload.value
    }
  ];
  const anchored = await store.anchorNode({ repository, projectId, nodeSha: baseSha });
  if (!anchored.ok) assert.fail(anchored.error.message);
  const appended = await store.append({
    repository,
    projectId,
    baseSha,
    expectedHeadSha: baseSha,
    idempotencyKey: "opaque-project-create",
    occurredAt: startedAt,
    actor: { kind: "user", id: "qa-user" },
    command: { type: "CreateOpaqueProject", projectId },
    decide: () => ({ ok: true, value: events })
  });
  if (!appended.ok) assert.fail(appended.error.message);

  const branch = await transport.readBranch(repository, HUNSU_STATE_BRANCH);
  if (!branch.ok || !branch.value) assert.fail("Hunsu state branch was not written");
  const eventFiles = Object.entries(branch.value.files)
    .filter(([path]) => new RegExp(`^\\.hunsu/v2/projects/${projectId}/events/\\d{4}/\\d{2}/[0-9a-f]{32}\\.json$`, "u").test(path));
  assert.equal(eventFiles.length, 2);
  const raw = eventFiles.map(([, content]) => content).join("\n");
  assert.equal(raw.includes(String(opaqueGoal.title)), false);
  assert.equal(raw.includes(String(opaqueRunner.name)), false);
  assert.equal(raw.includes("RAW STATE MUST HIDE THIS PROMPT"), false);
  for (const [, content] of eventFiles) {
    const stored = JSON.parse(content) as { event?: { schema?: unknown } };
    assert.equal(stored.event?.schema, "hunsu.opaque-domain-event.v1");
  }

  const projectRoot = `.hunsu/v2/projects/${projectId}`;
  const catalog = decodeShardedProjectCatalog(JSON.parse(branch.value.files[`${projectRoot}/${SHARDED_READ_MODEL_PATHS.project}`]!));
  const graph = decodeGraphManifest(JSON.parse(branch.value.files[`${projectRoot}/${SHARDED_READ_MODEL_PATHS.graphManifest}`]!));
  const graphPage = decodeGraphPage(JSON.parse(branch.value.files[`${projectRoot}/graph/pages/0000000.json`]!));
  const activity = decodeActivityManifest(JSON.parse(branch.value.files[`${projectRoot}/${SHARDED_READ_MODEL_PATHS.activityManifest}`]!));
  const eventIndex = decodeEventManifest(JSON.parse(branch.value.files[`${projectRoot}/${SHARDED_READ_MODEL_PATHS.eventManifest}`]!));
  const eventShard = decodeEventShard(JSON.parse(branch.value.files[`${projectRoot}/indexes/events/shards/0000000.json`]!));
  if (!catalog.ok || !graph.ok || !graphPage.ok || !activity.ok || !eventIndex.ok || !eventShard.ok) assert.fail("sharded read model materializations must decode");
  assert.equal(catalog.value.counts.events, 2);
  assert.equal(graph.value.nodeCount, 1);
  assert.equal(graphPage.value.nodes.length, 1);
  assert.equal(activity.value.projectId, projectId);
  assert.deepEqual(eventShard.value.entries.map(entry => entry.sequence), [1, 2]);
  const catalogEnvelope = JSON.parse(branch.value.files[`${projectRoot}/${SHARDED_READ_MODEL_PATHS.project}`]!) as Record<string, unknown>;
  assert.equal(decodeShardedProjectCatalog({ ...catalogEnvelope, unsupported: true }).ok, false);
  assert.equal(decodeShardedProjectCatalog({ ...catalogEnvelope, digest: `hunsu-catalog-read-model-v2:sha256:${"0".repeat(64)}` }).ok, false);
  assert.equal(decodeShardedProjectCatalog({
    ...catalogEnvelope,
    checkpoint: { ...(catalogEnvelope.checkpoint as Record<string, unknown>), eventCount: 999 }
  }).ok, false);

  const materializedRaw = [
    branch.value.files[`${projectRoot}/${SHARDED_READ_MODEL_PATHS.project}`],
    branch.value.files[`${projectRoot}/${SHARDED_READ_MODEL_PATHS.graphManifest}`],
    branch.value.files[`${projectRoot}/${SHARDED_READ_MODEL_PATHS.activityManifest}`],
    branch.value.files[`${projectRoot}/${SHARDED_READ_MODEL_PATHS.eventManifest}`]
  ].join("\n");
  assert.equal(materializedRaw.includes(String(opaqueGoal.desiredOutcome)), false);
  assert.equal(materializedRaw.includes(String(opaqueGoal.acceptanceCriteria[0])), false);
  assert.equal(materializedRaw.includes("RAW STATE MUST HIDE THIS PROMPT"), false);

  const graphOnly = await transport.readStateFilesAtHead(repository, appended.value.stateHeadSha, [{
    kind: "project_read_model",
    projectId,
    model: "graph"
  }]);
  if (!graphOnly.ok) assert.fail(graphOnly.error.message);
  assert.deepEqual(Object.keys(graphOnly.value.files), [`${projectRoot}/${SHARDED_READ_MODEL_PATHS.graphManifest}`]);

  const reconstructed = await store.readProject(repository, projectId);
  if (!reconstructed.ok) assert.fail(reconstructed.error.message);

  const secondAppend = await store.append({
    repository,
    projectId,
    baseSha,
    expectedHeadSha: appended.value.stateHeadSha,
    idempotencyKey: "opaque-run-start",
    occurredAt: "2026-07-15T00:01:00.000Z",
    actor: { kind: "plugin", userId: "qa-user", clientId: "qa-client" },
    command: { type: "StartOpaqueRun", projectId, runId },
    decide: () => ({ ok: true, value: [{
      type: "RunStarted",
      meta: {
        eventId: "event-run-started" as EventId,
        idempotencyKey: "2".repeat(64) as IdempotencyKey,
        fingerprint: "3".repeat(64) as CommandFingerprint,
        actor: { type: "plugin", id: "qa-client" as NonEmptyText },
        recordedAt: "2026-07-15T00:01:00.000Z" as IsoTimestamp
      },
      run: {
        id: runId,
        projectId,
        sourceNodeSha: rootSha,
        goal: opaqueGoal,
        goalDigest: computeGoalDigest(opaqueGoal),
        runner: opaqueRunner,
        runnerDigest: computeRunnerDigest(opaqueRunner),
        branch: runBranchName(projectId, rootSha, runId),
        checkpoints: [], evidenceIds: [],
        startedAt: "2026-07-15T00:01:00.000Z" as IsoTimestamp,
        status: "running"
      }
    }] })
  });
  if (!secondAppend.ok) assert.fail(secondAppend.error.message);
  const reconstructedAgain = await store.readProject(repository, projectId);
  if (!reconstructedAgain.ok) assert.fail(reconstructedAgain.error.message);
  assert.equal(reconstructedAgain.value.eventCount, 3);
});

function isRecord(value: CanonicalJsonValue): value is { readonly [key: string]: CanonicalJsonValue } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
