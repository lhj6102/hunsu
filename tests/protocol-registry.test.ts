import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { Result, RunnerTypeLock } from "../packages/protocol/src/index.ts";
import {
  BUNDLED_PLAYER_TYPE_KEY,
  BUNDLED_PLAYER_TYPE_VERSION,
  BUNDLED_TEAM_TYPE_KEY,
  BUNDLED_TEAM_LEGACY_TYPE_VERSION,
  BUNDLED_TEAM_TYPE_VERSION,
  REGISTRY_DEFINITION_SCHEMA,
  REGISTRY_INTEGRITY_PREFIX,
  REGISTRY_SNAPSHOT_SCHEMA,
  RUNNER_TYPE_INTEGRITY_PREFIX,
  RUNNER_VALUE_SCHEMA_DIGEST_PREFIX,
  RUNNER_VALUE_SCHEMA_SCHEMA,
  canonicalizeRegistryDefinition,
  canonicalizeRunnerValueSchema,
  computeDefinitionIntegrity,
  computeRunnerValueSchemaDigest,
  createBundledDefinitionRegistry,
  createDefinitionRegistry,
  createRegistryEntry,
  createRunnerValueTypeDecoder,
  createRunnerValueTypeRegistry,
  decodeDefinitionRegistry,
  decodeRegistryDefinition,
  decodeRunnerValueSchema,
  definitionLockToRunnerTypeLock,
  listRunnerTypeCapabilityDefinitions,
  resolveRunnerTypeDefinition,
  runnerTypeCapabilityDefinition,
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

test("public Runner capability definitions expose canonical schemas without executor metadata", () => {
  const fixture = completeRegistry();
  const lock = value(definitionLockToRunnerTypeLock(fixture.runner.lock));
  const capability = value(runnerTypeCapabilityDefinition(fixture.registry, lock));
  assert.equal(capability.displayName, "Release Train");
  assert.deepEqual(capability.type, lock);
  assert.equal(capability.valueSchema.schema, RUNNER_VALUE_SCHEMA_SCHEMA);
  assert.match(capability.valueSchema.digest, new RegExp(`^${RUNNER_VALUE_SCHEMA_DIGEST_PREFIX}[0-9a-f]{64}$`, "u"));
  assert.equal(capability.valueSchema.root.type, "object");
  assert.doesNotMatch(JSON.stringify(capability), /entrypoint|runner-executor|resource\.github/u);

  const canonical = value(canonicalizeRunnerValueSchema(capability.valueSchema.root));
  assert.equal(
    capability.valueSchema.digest,
    `${RUNNER_VALUE_SCHEMA_DIGEST_PREFIX}${createHash("sha256").update(canonical, "utf8").digest("hex")}`
  );
  if (capability.valueSchema.root.type !== "object") assert.fail("Release Train schema is not an object.");
  const reordered = {
    ...capability.valueSchema.root,
    properties: {
      strict: capability.valueSchema.root.properties.strict,
      stages: capability.valueSchema.root.properties.stages
    },
    required: [...capability.valueSchema.root.required].reverse()
  };
  assert.equal(value(computeRunnerValueSchemaDigest(reordered)), capability.valueSchema.digest);
  const changed = {
    ...capability.valueSchema.root,
    properties: {
      ...capability.valueSchema.root.properties,
      strict: { type: "null" }
    }
  };
  assert.notEqual(value(computeRunnerValueSchemaDigest(changed)), capability.valueSchema.digest);

  const listed = value(listRunnerTypeCapabilityDefinitions(fixture.registry));
  assert.deepEqual(listed, [capability]);
});

test("bundled Team preserves its 1.0 lock while 1.1 adds contiguous ordered players", () => {
  const registry = value(createBundledDefinitionRegistry());
  const runnerTypes = registry.entries.filter(entry => entry.definition.kind === "runner_type");
  assert.deepEqual(runnerTypes.map(entry => ({ key: entry.definition.key, version: entry.definition.version })), [
    { key: BUNDLED_PLAYER_TYPE_KEY, version: BUNDLED_PLAYER_TYPE_VERSION },
    { key: BUNDLED_TEAM_TYPE_KEY, version: BUNDLED_TEAM_LEGACY_TYPE_VERSION },
    { key: BUNDLED_TEAM_TYPE_KEY, version: BUNDLED_TEAM_TYPE_VERSION }
  ]);
  const legacyDefinition = runnerTypes.find(entry => entry.definition.key === BUNDLED_TEAM_TYPE_KEY
    && entry.definition.version === BUNDLED_TEAM_LEGACY_TYPE_VERSION);
  const currentDefinition = runnerTypes.find(entry => entry.definition.key === BUNDLED_TEAM_TYPE_KEY
    && entry.definition.version === BUNDLED_TEAM_TYPE_VERSION);
  assert.ok(legacyDefinition && legacyDefinition.definition.kind === "runner_type");
  assert.ok(currentDefinition && currentDefinition.definition.kind === "runner_type");
  assert.equal(
    legacyDefinition.lock.integrity,
    "hunsu-runner-type-v1:sha256:faa36a365179585fcbdfd7409e0087c827b721c1159f9405f88ed38ba0185dfe"
  );
  assert.equal(legacyDefinition.definition.runnerType.executor.entrypoint, "bundled.team.v1");
  assert.equal(currentDefinition.definition.runnerType.executor.entrypoint, "bundled.team.v1.1");
  assert.notEqual(currentDefinition.lock.integrity, legacyDefinition.lock.integrity);

  const decoders = value(createRunnerValueTypeRegistry(registry));
  assert.equal(decoders.length, 3);
  const player = decoders.find(decoder => decoder.type.key === BUNDLED_PLAYER_TYPE_KEY
    && decoder.type.schemaVersion === BUNDLED_PLAYER_TYPE_VERSION);
  const legacyTeam = decoders.find(decoder => decoder.type.key === BUNDLED_TEAM_TYPE_KEY
    && decoder.type.schemaVersion === BUNDLED_TEAM_LEGACY_TYPE_VERSION);
  const team = decoders.find(decoder => decoder.type.key === BUNDLED_TEAM_TYPE_KEY
    && decoder.type.schemaVersion === BUNDLED_TEAM_TYPE_VERSION);
  assert.ok(player);
  assert.ok(legacyTeam);
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
    players: [
      {
        name: "Verifier",
        role: "verify",
        order: 2,
        promptTemplate: "Verify.",
        resources: [],
        runtimePolicy: { filesystem: "read_only", network: "disabled", approvals: "never" }
      },
      {
        name: "Builder",
        role: "build",
        order: 1,
        promptTemplate: "Build.",
        resources: [],
        runtimePolicy: { filesystem: "worktree_write", network: "enabled", approvals: "on_request" }
      }
    ]
  } as const;
  assert.equal(team.decode(teamValue, "$.value").ok, true);
  assert.equal(legacyTeam.decode(teamValue, "$.value").ok, true);
  assert.equal(team.decode({ ...teamValue, strategy: { ...teamValue.strategy, mode: "unknown" } }, "$.value").ok, false);
  const duplicateOrder = {
    ...teamValue,
    players: [teamValue.players[0], { ...teamValue.players[1], order: 2 }]
  } as const;
  const gappedOrder = {
    ...teamValue,
    players: [teamValue.players[1], { ...teamValue.players[0], order: 3 }]
  } as const;
  assert.equal(legacyTeam.decode(duplicateOrder, "$.value").ok, true);
  assert.equal(legacyTeam.decode(gappedOrder, "$.value").ok, true);
  assert.equal(team.decode(duplicateOrder, "$.value").ok, false);
  assert.equal(team.decode(gappedOrder, "$.value").ok, false);

  const teamCapabilities = value(listRunnerTypeCapabilityDefinitions(registry))
    .filter(capability => capability.type.key === BUNDLED_TEAM_TYPE_KEY);
  assert.deepEqual(teamCapabilities.map(capability => capability.type.schemaVersion), [
    BUNDLED_TEAM_LEGACY_TYPE_VERSION,
    BUNDLED_TEAM_TYPE_VERSION
  ]);
});

test("contiguous ordered array schemas lock exact item and order invariants", () => {
  const itemSchema = {
    type: "object",
    properties: {
      order: { type: "integer", minimum: 1, maximum: 3 },
      label: { type: "string", minLength: 1, maxLength: 32 }
    },
    required: ["label", "order"],
    additionalProperties: false
  } as const;
  const schema = {
    type: "contiguous_ordered_array",
    items: itemSchema,
    minItems: 1,
    maxItems: 3,
    orderField: "order",
    startAt: 1
  } as const;
  assert.deepEqual(value(decodeRunnerValueSchema(schema)), schema);

  const invalid: readonly unknown[] = [
    { ...schema, extra: true },
    { ...schema, items: { type: "integer", minimum: 1, maximum: 3 } },
    { ...schema, orderField: "missing" },
    {
      ...schema,
      items: {
        ...itemSchema,
        properties: { ...itemSchema.properties, order: { type: "string", minLength: 1, maxLength: 3 } }
      }
    },
    { ...schema, items: { ...itemSchema, required: ["label"] } },
    {
      ...schema,
      items: {
        ...itemSchema,
        properties: { ...itemSchema.properties, order: { type: "integer", minimum: 1, maximum: 2 } }
      }
    }
  ];
  for (const candidate of invalid) assert.equal(decodeRunnerValueSchema(candidate).ok, false);
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
