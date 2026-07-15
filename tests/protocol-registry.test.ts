import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { Result, RunnerTypeLock } from "../packages/protocol/src/index.ts";
import {
  BUNDLED_PLAYER_TYPE_KEY,
  BUNDLED_TEAM_TYPE_KEY,
  REGISTRY_DEFINITION_SCHEMA,
  REGISTRY_INTEGRITY_PREFIX,
  REGISTRY_SNAPSHOT_SCHEMA,
  RUNNER_TYPE_INTEGRITY_PREFIX,
  canonicalizeRegistryDefinition,
  computeDefinitionIntegrity,
  createBundledDefinitionRegistry,
  createDefinitionRegistry,
  createRegistryEntry,
  createRunnerValueTypeDecoder,
  createRunnerValueTypeRegistry,
  decodeDefinitionRegistry,
  decodeRegistryDefinition,
  definitionLockToRunnerTypeLock,
  resolveRunnerTypeDefinition,
  verifyDefinitionIntegrity,
  type DefinitionLock,
  type DefinitionRegistry,
  type RegistryError,
  type RegistryResult,
  type RunnerTypeDefinition
} from "../packages/protocol-registry/src/index.ts";

test("definition integrity is deterministic and Runner types use their protocol lock prefix", () => {
  const resource = pluginResourceDefinition();
  const reordered = {
    resource: { version: "2.1.0", name: "github", type: "plugin" },
    version: "1.0.0",
    key: "resource.github",
    kind: "resource",
    schema: REGISTRY_DEFINITION_SCHEMA
  };
  const canonical = value(canonicalizeRegistryDefinition(resource));
  assert.equal(canonical, value(canonicalizeRegistryDefinition(reordered)));
  assert.equal(
    value(computeDefinitionIntegrity(resource)),
    `${REGISTRY_INTEGRITY_PREFIX}${createHash("sha256").update(canonical, "utf8").digest("hex")}`
  );

  const fixture = completeRegistry();
  assert.equal(fixture.runner.lock.integrity.startsWith(RUNNER_TYPE_INTEGRITY_PREFIX), true);
  assert.equal(value(verifyDefinitionIntegrity(fixture.runner.definition, fixture.runner.lock.integrity)), true);
  const runner = fixture.runner.definition as RunnerTypeDefinition;
  assert.equal(runner.runnerType.valueSchema.type, "object");
  if (runner.runnerType.valueSchema.type === "object") {
    const reorderedRequired = {
      ...runner,
      runnerType: {
        ...runner.runnerType,
        valueSchema: {
          ...runner.runnerType.valueSchema,
          required: [...runner.runnerType.valueSchema.required].reverse()
        }
      }
    };
    assert.equal(value(computeDefinitionIntegrity(reorderedRequired)), fixture.runner.lock.integrity);
  }
});

test("registry resolves an extensible Runner type through an exact type lock", () => {
  const fixture = completeRegistry();
  const lock = value(definitionLockToRunnerTypeLock(fixture.runner.lock));
  const resolved = value(resolveRunnerTypeDefinition(fixture.registry, lock));
  assert.equal(resolved.definition.kind, "runner_type");
  assert.equal(resolved.definition.runnerType.displayName, "Release Train");
  assert.equal(resolved.definition.runnerType.executor.entrypoint, "custom.release-train.v1");
  assert.deepEqual(resolved.lock, lock);
});

test("bundled Player and Team are ordinary Runner type entries, not a closed union", () => {
  const registry = value(createBundledDefinitionRegistry());
  const runnerTypes = registry.entries.filter(entry => entry.definition.kind === "runner_type");
  assert.deepEqual(runnerTypes.map(entry => entry.definition.key), [BUNDLED_PLAYER_TYPE_KEY, BUNDLED_TEAM_TYPE_KEY]);

  const decoders = value(createRunnerValueTypeRegistry(registry));
  assert.equal(decoders.length, 2);
  const player = decoders.find(decoder => decoder.type.key === BUNDLED_PLAYER_TYPE_KEY);
  const team = decoders.find(decoder => decoder.type.key === BUNDLED_TEAM_TYPE_KEY);
  assert.ok(player);
  assert.ok(team);

  const playerValue = {
    promptTemplate: "Implement one Goal.",
    resources: [],
    runtimePolicy: { filesystem: "worktree_write", network: "enabled", approvals: "on_request" }
  } as const;
  assert.equal(player.decode(playerValue, "$.value").ok, true);
  assert.equal(player.decode({ ...playerValue, unknown: true }, "$.value").ok, false);

  const teamValue = {
    strategy: { mode: "sequence", promptTemplate: "Coordinate.", maxRounds: 2 },
    players: [{
      name: "Builder",
      role: "build",
      order: 1,
      promptTemplate: "Build.",
      resources: [],
      runtimePolicy: { filesystem: "worktree_write", network: "enabled", approvals: "on_request" }
    }]
  } as const;
  assert.equal(team.decode(teamValue, "$.value").ok, true);
  assert.equal(team.decode({ ...teamValue, strategy: { ...teamValue.strategy, mode: "unknown" } }, "$.value").ok, false);
});

test("custom Runner payload decoder rejects extras, missing fields, wrong variants, and duplicates", () => {
  const fixture = completeRegistry();
  const lock = value(definitionLockToRunnerTypeLock(fixture.runner.lock));
  const decoder = value(createRunnerValueTypeDecoder(fixture.registry, lock));
  assert.equal(decoder.decode({ stages: ["build", "verify"], strict: true }, "$.value").ok, true);

  const invalid = [
    { stages: ["build"], strict: true, extra: "no" },
    { stages: ["build"] },
    { stages: [], strict: true },
    { stages: ["build", "build"], strict: true },
    { stages: ["build"], strict: "yes" }
  ] as const;
  for (const candidate of invalid) assert.equal(decoder.decode(candidate, "$.value").ok, false);
});

test("custom Runner payloads preserve __proto__ as an own canonical JSON field", () => {
  const executor = entry(pluginResourceDefinition());
  const definition = JSON.parse(JSON.stringify({
    schema: REGISTRY_DEFINITION_SCHEMA,
    kind: "runner_type",
    key: "runner.opaque-map",
    version: "1.0.0",
    runnerType: {
      displayName: "Opaque map",
      valueSchema: {
        type: "object",
        properties: { placeholder: { type: "boolean" } },
        required: ["__proto__"],
        additionalProperties: false
      },
      executor: {
        schema: "hunsu.runner-executor.v1",
        resource: executor.lock,
        entrypoint: "custom.opaque-map.v1"
      }
    }
  }).replace('"placeholder"', '"__proto__"'));
  const runner = entry(definition);
  const registry = value(createDefinitionRegistry([executor, runner]));
  const lock = value(definitionLockToRunnerTypeLock(runner.lock));
  const decoder = value(createRunnerValueTypeDecoder(registry, lock));
  const decoded = decoder.decode(JSON.parse('{"__proto__":true}'), "$.value");

  assert.equal(decoded.ok, true);
  if (!decoded.ok || typeof decoded.value !== "object" || decoded.value === null || Array.isArray(decoded.value)) return;
  const record = decoded.value as { readonly [key: string]: import("../packages/protocol/src/index.ts").CanonicalJsonValue };
  assert.equal(Object.hasOwn(record, "__proto__"), true);
  assert.equal(record["__proto__"], true);
  assert.equal(Object.getPrototypeOf(decoded.value), Object.prototype);
});

test("strict v2 decoders reject v1 schemas, extra keys, partial locks, and tampering", () => {
  const definition = pluginResourceDefinition();
  const cases: unknown[] = [
    { ...definition, schema: "hunsu.registry-definition.v1" },
    { ...definition, extra: true },
    { ...definition, kind: "player" },
    { ...definition, version: "latest" },
    { ...definition, resource: { ...definition.resource, extra: true } }
  ];
  for (const candidate of cases) assert.equal(decodeRegistryDefinition(candidate).ok, false);

  const partialSnapshot = decodeDefinitionRegistry({
    schema: REGISTRY_SNAPSHOT_SCHEMA,
    entries: [{ definition }]
  });
  assert.equal(partialSnapshot.ok, false);

  const fixture = completeRegistry();
  const changedIntegrity: RunnerTypeLock = {
    ...value(definitionLockToRunnerTypeLock(fixture.runner.lock)),
    integrity: `${RUNNER_TYPE_INTEGRITY_PREFIX}${"0".repeat(64)}` as RunnerTypeLock["integrity"]
  };
  const mismatch = resolveRunnerTypeDefinition(fixture.registry, changedIntegrity);
  assert.equal(mismatch.ok, false);
  if (!mismatch.ok) assert.equal(mismatch.error.type, "RegistryIntegrityError");
});

test("registry rejects unresolved executor resources and duplicate identities", () => {
  const fixture = completeRegistry();
  const unresolved = createDefinitionRegistry([fixture.runner]);
  assert.equal(unresolved.ok, false);
  if (!unresolved.ok) assert.equal(unresolved.error.type, "RegistryResolutionError");

  const duplicate = createDefinitionRegistry([fixture.executor, fixture.executor]);
  assert.equal(duplicate.ok, false);
  if (!duplicate.ok) assert.equal(duplicate.error.type, "RegistryIdentityError");

  const tampered = {
    lock: fixture.executor.lock,
    definition: pluginResourceDefinition({ resource: { type: "plugin", name: "github", version: "9.0.0" } })
  };
  const integrity = createDefinitionRegistry([tampered]);
  assert.equal(integrity.ok, false);
  if (!integrity.ok) assert.equal(integrity.error.type, "RegistryIntegrityError");
});

function completeRegistry(): {
  readonly registry: DefinitionRegistry;
  readonly executor: ReturnType<typeof entry>;
  readonly runner: ReturnType<typeof entry>;
} {
  const executor = entry(pluginResourceDefinition());
  const runner = entry(customRunnerTypeDefinition(executor.lock));
  return { registry: value(createDefinitionRegistry([executor, runner])), executor, runner };
}

function pluginResourceDefinition(overrides: { readonly resource?: { readonly type: "plugin"; readonly name: string; readonly version: string } } = {}) {
  return {
    schema: REGISTRY_DEFINITION_SCHEMA,
    kind: "resource",
    key: "resource.github",
    version: "1.0.0",
    resource: { type: "plugin", name: "github", version: "2.1.0" },
    ...overrides
  };
}

function customRunnerTypeDefinition(executor: DefinitionLock): unknown {
  return {
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
        resource: executor,
        entrypoint: "custom.release-train.v1"
      }
    }
  };
}

function entry(definition: unknown) {
  return value(createRegistryEntry("official", definition));
}

function value<T>(result: Result<T, RegistryError>): T;
function value<T>(result: RegistryResult<T>): T;
function value<T>(result: Result<T, RegistryError>): T {
  assert.equal(result.ok, true, result.ok ? undefined : `${result.error.type} at ${result.error.path}`);
  if (!result.ok) throw new Error("unreachable");
  return result.value;
}
