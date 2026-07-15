import assert from "node:assert/strict";
import test from "node:test";
import {
  HunsuApplicationService,
  bundledRunnerRuntime,
  createBundledRunnerExecutorAdapters,
  createTrustedRunnerRuntime,
  runnerAdapterOk,
  type AuthContext,
  type TrustedRunnerExecutorAdapter
} from "../apps/api/src/index.ts";
import {
  MemoryGitHubTransport,
  type RepositoryGrant
} from "../packages/github-store/src/index.ts";
import {
  computeGoalDigest,
  decodeNodePlan,
  decodeRunnerValue
} from "../packages/protocol/src/index.ts";
import type {
  RunnerCapabilityDetail,
  RunnerCapabilityList
} from "../packages/plugin-contract/src/index.ts";
import {
  BUNDLED_PLAYER_TYPE_VERSION,
  BUNDLED_TEAM_LEGACY_TYPE_VERSION,
  BUNDLED_TEAM_TYPE_VERSION,
  REGISTRY_DEFINITION_SCHEMA,
  createBundledDefinitionRegistry,
  createDefinitionRegistry,
  createRegistryEntry,
  definitionLockToRunnerTypeLock
} from "../packages/protocol-registry/src/index.ts";

const INITIAL_SHA = "a".repeat(40);

const repository: RepositoryGrant = {
  installationId: 71,
  repositoryId: 83,
  owner: "acme",
  name: "release-train",
  defaultBranch: "main",
  private: true,
  permissions: { contents: "write" }
};

const repositoryInput = { owner: repository.owner, name: repository.name };

const auth: AuthContext = {
  subject: "github:97",
  user: { id: "97", login: "release-operator" },
  installations: [{
    id: repository.installationId,
    accountLogin: repository.owner,
    accountType: "organization",
    repositories: [{ repositoryId: repository.repositoryId, permissions: { contents: "write" } }]
  }],
  selectedInstallationId: repository.installationId,
  client: "mcp"
};

test("bundled Team 1.0 remains executable while Team 1.1 enforces contiguous order", () => {
  assert.deepEqual(bundledRunnerRuntime.runnerCapabilities.map(capability =>
    `${capability.type.key}@${capability.type.schemaVersion}`), [
    `runner.player@${BUNDLED_PLAYER_TYPE_VERSION}`,
    `runner.team@${BUNDLED_TEAM_LEGACY_TYPE_VERSION}`,
    `runner.team@${BUNDLED_TEAM_TYPE_VERSION}`
  ]);
  for (const capability of bundledRunnerRuntime.runnerCapabilities) {
    assert.equal(capability.schema, "hunsu.runner-capability.v1");
    assert.equal(capability.runContractResolution.status, "available");
    assert.match(capability.valueSchema.digest, /^hunsu-runner-value-schema-v1:sha256:[0-9a-f]{64}$/u);
    assert.doesNotMatch(JSON.stringify(capability), /entrypoint|runner-executor|resource\.hunsu-codex-executor/u);
  }
  const legacyTeamType = bundledRunnerRuntime.runnerTypes.find(item =>
    item.type.key === "runner.team" && item.type.schemaVersion === BUNDLED_TEAM_LEGACY_TYPE_VERSION)?.type;
  const teamType = bundledRunnerRuntime.runnerTypes.find(item =>
    item.type.key === "runner.team" && item.type.schemaVersion === BUNDLED_TEAM_TYPE_VERSION)?.type;
  assert.ok(legacyTeamType);
  assert.ok(teamType);
  const legacyTeam = decodeRunnerValue({
    schema: "hunsu.runner-value.v1",
    type: legacyTeamType,
    name: "Legacy Verification Team",
    value: {
      strategy: { mode: "sequence", promptTemplate: "Use the preserved Team instructions.", maxRounds: 2 },
      players: [{
        name: "Legacy Verifier",
        role: "Verify",
        order: 7,
        promptTemplate: "Verify.",
        resources: [],
        runtimePolicy: { filesystem: "read_only", network: "enabled", approvals: "on_request" }
      }]
    }
  }, bundledRunnerRuntime.runnerTypes);
  if (!legacyTeam.ok) assert.fail(legacyTeam.error.message);
  const legacyExecution = bundledRunnerRuntime.execute(legacyTeam.value);
  if (!legacyExecution.ok) assert.fail(legacyExecution.error.message);
  assert.equal(legacyExecution.value.instructions, "Use the preserved Team instructions.");
  assert.deepEqual(legacyExecution.value.toolPolicy, {
    filesystem: "read_only",
    network: "enabled",
    approvals: "on_request"
  });

  const team = decodeRunnerValue({
    schema: "hunsu.runner-value.v1",
    type: teamType,
    name: "Verification Team",
    value: {
      strategy: { mode: "sequence", promptTemplate: "Verify in sequence.", maxRounds: 2 },
      players: [
        {
          name: "Verifier",
          role: "Verify",
          order: 2,
          promptTemplate: "Verify.",
          resources: [],
          runtimePolicy: { filesystem: "read_only", network: "enabled", approvals: "on_request" }
        },
        {
          name: "Builder",
          role: "Build",
          order: 1,
          promptTemplate: "Build.",
          resources: [],
          runtimePolicy: { filesystem: "worktree_write", network: "disabled", approvals: "never" }
        }
      ]
    }
  }, bundledRunnerRuntime.runnerTypes);
  if (!team.ok) assert.fail(team.error.message);
  const execution = bundledRunnerRuntime.execute(team.value);
  if (!execution.ok) assert.fail(execution.error.message);
  assert.equal(execution.value.instructions, [
    "Team strategy mode: sequence.",
    "Maximum rounds: 2.",
    "Team instructions: Verify in sequence.",
    "Ordered players:",
    "1. Builder [Build]: Build.",
    "2. Verifier [Verify]: Verify."
  ].join("\n"));
  assert.deepEqual(execution.value.toolPolicy, {
    filesystem: "worktree_write",
    network: "enabled",
    approvals: "on_request"
  });
  const invalidCurrent = decodeRunnerValue({
    schema: "hunsu.runner-value.v1",
    type: teamType,
    name: "Invalid Current Team",
    value: legacyTeam.value.value
  }, bundledRunnerRuntime.runnerTypes);
  assert.equal(invalidCurrent.ok, false);
});

test("trusted Runner runtime rejects missing and mismatched local executor adapters", () => {
  const fixture = releaseTrainFixture();
  const missing = createTrustedRunnerRuntime({ registry: fixture.registry, adapters: [] });
  assert.equal(missing.ok, false);
  if (missing.ok) assert.fail("A Runner Registry without a local executor adapter was accepted.");
  assert.equal(missing.error.code, "missing_executor_adapter");

  const mismatchedAdapter: TrustedRunnerExecutorAdapter = {
    executor: {
      ...fixture.executor,
      resource: {
        ...fixture.executor.resource,
        integrity: `hunsu-registry-definition-v2:sha256:${"f".repeat(64)}` as typeof fixture.executor.resource.integrity
      }
    },
    execute: releaseTrainExecution
  };
  const mismatched = createTrustedRunnerRuntime({ registry: fixture.registry, adapters: [mismatchedAdapter] });
  assert.equal(mismatched.ok, false);
  if (mismatched.ok) assert.fail("A local executor adapter with a mismatched resource lock was accepted.");
  assert.equal(mismatched.error.code, "executor_lock_mismatch");
});

test("repository-scoped Runner capability MCP reads are exact, bounded, and catalog-bound", async () => {
  const fixture = releaseTrainFixture();
  const bundledAdapters = createBundledRunnerExecutorAdapters(fixture.registry);
  if (!bundledAdapters.ok) assert.fail(bundledAdapters.error.message);
  const runtimeResult = createTrustedRunnerRuntime({
    registry: fixture.registry,
    adapters: [...bundledAdapters.value, { executor: fixture.executor, execute: releaseTrainExecution }]
  });
  if (!runtimeResult.ok) assert.fail(runtimeResult.error.message);
  const transport = new MemoryGitHubTransport([{ repository, initialSha: INITIAL_SHA }]);
  const service = new HunsuApplicationService({ transport, runnerRuntime: runtimeResult.value });
  const readAuth: AuthContext = {
    ...auth,
    installations: auth.installations.map(installation => ({
      ...installation,
      repositories: installation.repositories.map(item => ({
        ...item,
        permissions: { contents: "read" as const }
      }))
    }))
  };

  const first = await service.call("hunsu.runner_capabilities.list", {
    repository: repositoryInput,
    limit: 2
  }, readAuth);
  if (!first.ok) assert.fail(first.error.message);
  assert.equal(first.stateHeadSha, undefined);
  const firstPage = first.data as RunnerCapabilityList;
  assert.deepEqual(firstPage.repository, {
    installationId: repository.installationId,
    repositoryId: repository.repositoryId,
    owner: repository.owner,
    name: repository.name,
    defaultBranch: repository.defaultBranch
  });
  assert.match(firstPage.catalogDigest, /^hunsu-runner-capability-catalog-v1:sha256:[0-9a-f]{64}$/u);
  assert.deepEqual(firstPage.capabilities.map(capability => capability.type.key), [
    "runner.player",
    "runner.release-train"
  ]);
  assert.match(firstPage.nextCursor ?? "", new RegExp(`^${firstPage.catalogDigest}:[1-9][0-9]*$`, "u"));
  assert.doesNotMatch(
    JSON.stringify(firstPage),
    /entrypoint|runner-executor|release-train-executor/u
  );

  const second = await service.call("hunsu.runner_capabilities.list", {
    repository: repositoryInput,
    cursor: firstPage.nextCursor,
    limit: 2
  }, readAuth);
  if (!second.ok) assert.fail(second.error.message);
  const secondPage = second.data as RunnerCapabilityList;
  assert.equal(secondPage.catalogDigest, firstPage.catalogDigest);
  assert.deepEqual(secondPage.capabilities.map(capability =>
    `${capability.type.key}@${capability.type.schemaVersion}`), [
    `runner.team@${BUNDLED_TEAM_LEGACY_TYPE_VERSION}`,
    `runner.team@${BUNDLED_TEAM_TYPE_VERSION}`
  ]);
  assert.equal(secondPage.nextCursor, null);

  const detailResult = await service.call("hunsu.runner_capabilities.get", {
    repository: repositoryInput,
    type: fixture.runnerType
  }, readAuth);
  if (!detailResult.ok) assert.fail(detailResult.error.message);
  const detail = detailResult.data as RunnerCapabilityDetail;
  assert.deepEqual(detail.repository, firstPage.repository);
  assert.equal(detail.capability.schema, "hunsu.runner-capability.v1");
  assert.deepEqual(detail.capability.type, fixture.runnerType);
  assert.equal(detail.capability.displayName, "Release Train");
  assert.deepEqual(detail.capability.valueSchema.root, {
    type: "object",
    properties: {
      stages: {
        type: "array",
        items: { type: "string", minLength: 1, maxLength: 128 },
        minItems: 1,
        maxItems: 16,
        uniqueItems: true
      },
      strict: { type: "boolean" }
    },
    required: ["stages", "strict"],
    additionalProperties: false
  });
  assert.deepEqual(detail.capability.runContractResolution, { status: "available" });
  assert.doesNotMatch(JSON.stringify(detail), /entrypoint|runner-executor|release-train-executor/u);

  const oversized = await service.call("hunsu.runner_capabilities.list", {
    repository: repositoryInput,
    limit: 51
  }, readAuth);
  assert.equal(oversized.ok, false);
  if (!oversized.ok) assert.equal(oversized.error.code, "invalid_request");

  const partial = await service.call("hunsu.runner_capabilities.get", {
    repository: repositoryInput,
    type: { key: "runner.release-train" }
  }, readAuth);
  assert.equal(partial.ok, false);
  if (!partial.ok) assert.equal(partial.error.code, "invalid_request");

  const unavailable = await service.call("hunsu.runner_capabilities.get", {
    repository: repositoryInput,
    type: { ...fixture.runnerType, integrity: `hunsu-runner-type-v1:sha256:${"f".repeat(64)}` }
  }, readAuth);
  assert.equal(unavailable.ok, false);
  if (!unavailable.ok) assert.equal(unavailable.error.code, "not_found");

  const bundledService = new HunsuApplicationService({ transport });
  const stale = await bundledService.call("hunsu.runner_capabilities.list", {
    repository: repositoryInput,
    cursor: firstPage.nextCursor,
    limit: 2
  }, readAuth);
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.equal(stale.error.code, "invalid_request");

  const state = await transport.readBranch(repository, "hunsu/state");
  if (!state.ok) assert.fail(state.error.message);
  assert.equal(state.value, undefined, "read-only Runner discovery must not initialize or mutate repository state");
});

test("custom Release Train Runner creates, reconstructs, and starts with its trusted RunContract", async () => {
  const fixture = releaseTrainFixture();
  const bundledAdapters = createBundledRunnerExecutorAdapters(fixture.registry);
  if (!bundledAdapters.ok) assert.fail(bundledAdapters.error.message);
  const runtimeResult = createTrustedRunnerRuntime({
    registry: fixture.registry,
    adapters: [...bundledAdapters.value, { executor: fixture.executor, execute: releaseTrainExecution }]
  });
  if (!runtimeResult.ok) assert.fail(runtimeResult.error.message);
  assert.equal(runtimeResult.ok, true);
  const runtime = runtimeResult.value;
  assert.deepEqual(runtime.runnerTypes.map(item => String(item.type.key)).sort(), [
    "runner.player",
    "runner.release-train",
    "runner.team",
    "runner.team"
  ]);
  assert.deepEqual(runtime.runnerCapabilities.map(capability => capability.type.key), [
    "runner.player",
    "runner.release-train",
    "runner.team",
    "runner.team"
  ]);
  const releaseCapability = runtime.runnerCapabilities.find(capability => capability.type.key === "runner.release-train");
  assert.ok(releaseCapability);
  assert.deepEqual(releaseCapability.type, fixture.runnerType);
  assert.equal(releaseCapability.displayName, "Release Train");
  assert.deepEqual(releaseCapability.valueSchema.root, {
    type: "object",
    properties: {
      stages: {
        type: "array",
        items: { type: "string", minLength: 1, maxLength: 128 },
        minItems: 1,
        maxItems: 16,
        uniqueItems: true
      },
      strict: { type: "boolean" }
    },
    required: ["stages", "strict"],
    additionalProperties: false
  });
  assert.doesNotMatch(JSON.stringify(releaseCapability), /entrypoint|runner-executor|release-train-executor/u);

  const initialPlan = {
    schema: "hunsu.node-plan.v1" as const,
    nextGoals: [{
      key: "ship-release",
      title: "Ship the production release",
      desiredOutcome: "Every Release Train stage completes with strict verification.",
      acceptanceCriteria: ["Build and verify stages both pass"],
      constraints: ["Do not move main"],
      priority: 100
    }],
    how: {
      schema: "hunsu.runner-value.v1" as const,
      type: fixture.runnerType,
      name: "Production Release Train",
      value: { stages: ["build", "verify"], strict: true }
    }
  };
  const decodedPlan = decodeNodePlan(initialPlan, runtime.runnerTypes);
  if (!decodedPlan.ok) assert.fail(decodedPlan.error.message);
  assert.equal(decodedPlan.ok, true);
  const goalDigest = String(computeGoalDigest(decodedPlan.value.nextGoals[0]!));

  const transport = new MemoryGitHubTransport([{ repository, initialSha: INITIAL_SHA }]);
  const creator = new HunsuApplicationService({ transport, runnerRuntime: runtime });
  const created = await creator.call("hunsu.projects.create", {
    repository: repositoryInput,
    projectId: "release-project",
    title: "Release Project",
    rootNodeSha: INITIAL_SHA,
    initialPlan,
    idempotencyKey: "release-project-create",
    expectedStateSha: INITIAL_SHA,
    confirmedByUser: true
  }, auth);
  if (!created.ok) assert.fail(created.error.message);
  assert.equal(created.ok, true);
  assert.ok(created.stateHeadSha);

  // A fresh service instance must reconstruct the opaque event and Node payload
  // with the same injected Registry before it can start the Run.
  const reconstructed = new HunsuApplicationService({ transport, runnerRuntime: runtime });
  const project = await reconstructed.call("hunsu.projects.get", {
    repository: repositoryInput,
    projectId: "release-project"
  }, auth);
  assert.equal(project.ok, true, project.ok ? undefined : project.error.message);

  const node = await reconstructed.call("hunsu.nodes.get", {
    repository: repositoryInput,
    projectId: "release-project",
    nodeSha: INITIAL_SHA
  }, auth);
  if (!node.ok) assert.fail(node.error.message);
  assert.equal(node.ok, true);
  const nodeData = node.data as { plan: { how: { typeKey: string; value: unknown } } };
  assert.equal(nodeData.plan.how.typeKey, "runner.release-train");
  assert.deepEqual(nodeData.plan.how.value, { stages: ["build", "verify"], strict: true });
  assert.doesNotMatch(JSON.stringify(nodeData.plan.how), /entrypoint|runner-executor/u, "Executable adapter metadata leaked into Node state.");

  const started = await reconstructed.call("hunsu.runs.start", {
    repository: repositoryInput,
    projectId: "release-project",
    sourceNodeSha: INITIAL_SHA,
    goalDigest,
    runId: "release-run",
    idempotencyKey: "release-run-start",
    expectedStateSha: created.stateHeadSha
  }, auth);
  if (!started.ok) assert.fail(started.error.message);
  assert.equal(started.ok, true);
  const contract = started.data as {
    schema: string;
    instructions: string;
    runner: { type: { key: string }; value: unknown };
    toolPolicy: unknown;
  };
  assert.equal(contract.schema, "hunsu.run-contract.v2");
  assert.equal(contract.runner.type.key, "runner.release-train");
  assert.deepEqual(contract.runner.value, { stages: ["build", "verify"], strict: true });
  assert.equal(contract.instructions, "Run release stages in order: build -> verify. Strict verification is required.");
  assert.deepEqual(contract.toolPolicy, {
    filesystem: "worktree_write",
    network: "enabled",
    approvals: "on_request"
  });
});

function releaseTrainFixture() {
  const bundled = value(createBundledDefinitionRegistry());
  const resource = value(createRegistryEntry("qa", {
    schema: REGISTRY_DEFINITION_SCHEMA,
    kind: "resource",
    key: "resource.release-train-executor",
    version: "1.0.0",
    resource: { type: "plugin", name: "release-train", version: "1.0.0" }
  }));
  const runner = value(createRegistryEntry("qa", {
    schema: REGISTRY_DEFINITION_SCHEMA,
    kind: "runner_type",
    key: "runner.release-train",
    version: "1.0.0",
    runnerType: {
      displayName: "Release Train",
      valueSchema: {
        type: "object",
        properties: {
          stages: {
            type: "array",
            items: { type: "string", minLength: 1, maxLength: 128 },
            minItems: 1,
            maxItems: 16,
            uniqueItems: true
          },
          strict: { type: "boolean" }
        },
        required: ["stages", "strict"],
        additionalProperties: false
      },
      executor: {
        schema: "hunsu.runner-executor.v1",
        resource: resource.lock,
        entrypoint: "custom.release-train.v1"
      }
    }
  }));
  const registry = value(createDefinitionRegistry([...bundled.entries, resource, runner]));
  const runnerType = value(definitionLockToRunnerTypeLock(runner.lock));
  if (runner.definition.kind !== "runner_type") throw new Error("Release Train definition is not a Runner type.");
  return { registry, runnerType, executor: runner.definition.runnerType.executor };
}

function releaseTrainExecution(runner: Parameters<TrustedRunnerExecutorAdapter["execute"]>[0]) {
  const payload = runner.value as unknown as { readonly stages: readonly string[]; readonly strict: boolean };
  return runnerAdapterOk({
    instructions: `Run release stages in order: ${payload.stages.join(" -> ")}. ${payload.strict ? "Strict verification is required." : "Best-effort verification is allowed."}`,
    toolPolicy: {
      filesystem: "worktree_write",
      network: "enabled",
      approvals: payload.strict ? "on_request" : "never"
    }
  });
}

function value<Value>(result: { readonly ok: true; readonly value: Value } | { readonly ok: false; readonly error: unknown }): Value {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}
