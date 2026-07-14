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
import {
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

test("bundled Player and Team retain trusted local executor adapters", () => {
  const teamType = bundledRunnerRuntime.runnerTypes.find(item => item.type.key === "runner.team")?.type;
  assert.ok(teamType);
  const team = decodeRunnerValue({
    schema: "hunsu.runner-value.v1",
    type: teamType,
    name: "Verification Team",
    value: {
      strategy: { mode: "sequence", promptTemplate: "Verify in sequence.", maxRounds: 2 },
      players: [
        {
          name: "Builder",
          role: "Build",
          order: 1,
          promptTemplate: "Build.",
          resources: [],
          runtimePolicy: { filesystem: "worktree_write", network: "disabled", approvals: "never" }
        },
        {
          name: "Verifier",
          role: "Verify",
          order: 2,
          promptTemplate: "Verify.",
          resources: [],
          runtimePolicy: { filesystem: "read_only", network: "enabled", approvals: "on_request" }
        }
      ]
    }
  }, bundledRunnerRuntime.runnerTypes);
  if (!team.ok) assert.fail(team.error.message);
  const execution = bundledRunnerRuntime.execute(team.value);
  if (!execution.ok) assert.fail(execution.error.message);
  assert.equal(execution.value.instructions, "Verify in sequence.");
  assert.deepEqual(execution.value.toolPolicy, {
    filesystem: "worktree_write",
    network: "enabled",
    approvals: "on_request"
  });
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
    "runner.team"
  ]);

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
