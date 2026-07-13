import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { Result } from "../packages/protocol/src/index.ts";
import {
  REGISTRY_DEFINITION_SCHEMA,
  REGISTRY_INTEGRITY_PREFIX,
  REGISTRY_SNAPSHOT_SCHEMA,
  canonicalizeRegistryDefinition,
  computeRegistryIntegrity,
  createDefinitionLock,
  createDefinitionRegistry,
  createRegistryEntry,
  decodeDefinitionRegistry,
  decodeRegistryDefinition,
  resolveRegistryDefinition,
  resolveRunnerDefinition,
  validateTeamMembership,
  verifyRegistryIntegrity,
  type DefinitionLock,
  type DefinitionRegistry,
  type RegistryDefinition,
  type RegistryEntry,
  type RegistryError
} from "../packages/protocol-registry/src/index.ts";

test("registry canonical integrity is deterministic and verified without stored integrity fields", () => {
  const resource = pluginResourceDefinition();
  const reordered = {
    resource: { version: "2.1.0", name: "github", type: "plugin" },
    version: "1.0.0",
    key: "resource.github",
    kind: "resource",
    schema: REGISTRY_DEFINITION_SCHEMA
  };
  const canonical = value(canonicalizeRegistryDefinition(resource));
  const reorderedCanonical = value(canonicalizeRegistryDefinition(reordered));
  const integrity = value(computeRegistryIntegrity(resource));

  assert.equal(canonical, reorderedCanonical);
  assert.equal(integrity, `${REGISTRY_INTEGRITY_PREFIX}${createHash("sha256").update(canonical, "utf8").digest("hex")}`);
  assert.equal(value(verifyRegistryIntegrity(reordered, integrity)), true);

  const changed = pluginResourceDefinition({ resource: { type: "plugin", name: "github", version: "2.2.0" } });
  const mismatch = verifyRegistryIntegrity(changed, integrity);
  assert.equal(mismatch.ok, false);
  if (!mismatch.ok) assert.equal(mismatch.error.type, "RegistryIntegrityError");
});

test("registry resolves exact locked Player, Team, Coach, Skill, and resource definitions", () => {
  const fixture = completeRegistry();

  const player = value(resolveRunnerDefinition(fixture.registry, fixture.player.lock));
  const team = value(resolveRunnerDefinition(fixture.registry, fixture.team.lock));
  const coach = value(resolveRegistryDefinition(fixture.registry, fixture.coach.lock));
  const skill = value(resolveRegistryDefinition(fixture.registry, fixture.skill.lock));
  const resource = value(resolveRegistryDefinition(fixture.registry, fixture.resource.lock));

  assert.equal(player.kind, "player");
  assert.equal(team.kind, "team");
  assert.equal(coach.kind, "coach");
  assert.equal(skill.kind, "skill");
  assert.equal(resource.kind, "resource");
  assert.equal(value(validateTeamMembership(fixture.team.definition, fixture.registry)), true);
});

test("registry exact resolution rejects a changed version or integrity", () => {
  const fixture = completeRegistry();
  const changedVersion = { ...fixture.player.lock, version: "1.0.1" };
  const missing = resolveRegistryDefinition(fixture.registry, changedVersion);
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.error.type, "RegistryResolutionError");

  const changedIntegrity = { ...fixture.player.lock, integrity: `${REGISTRY_INTEGRITY_PREFIX}${"0".repeat(64)}` };
  const mismatch = resolveRegistryDefinition(fixture.registry, changedIntegrity);
  assert.equal(mismatch.ok, false);
  if (!mismatch.ok) assert.equal(mismatch.error.type, "RegistryIntegrityError");
});

test("strict decoders reject unknown schemas, keys, values, and partial locks", () => {
  const definition = pluginResourceDefinition();
  const cases: unknown[] = [
    { ...definition, schema: "hunsu.registry-definition.v2" },
    { ...definition, extra: true },
    { ...definition, kind: "unknown" },
    { ...definition, version: "latest" },
    { ...definition, version: "1.0.0-01" },
    { ...definition, resource: { ...definition.resource, extra: true } }
  ];
  for (const candidate of cases) {
    const decoded = decodeRegistryDefinition(candidate);
    assert.equal(decoded.ok, false);
    if (!decoded.ok) assert.equal(decoded.error.type, "RegistryDecodeError");
  }

  const partialSnapshot = decodeDefinitionRegistry({ schema: REGISTRY_SNAPSHOT_SCHEMA, entries: [{ definition }] });
  assert.equal(partialSnapshot.ok, false);
  if (!partialSnapshot.ok) assert.equal(partialSnapshot.error.type, "RegistryDecodeError");
});

test("Team validation rejects duplicate and unresolved Player membership", () => {
  const player = value(createRegistryEntry("official", playerDefinition([])));
  const duplicateTeam = teamDefinition(player.lock, [
    { player: player.lock, role: "build", order: 1 },
    { player: player.lock, role: "review", order: 2 }
  ]);
  const duplicate = createRegistryEntry("official", duplicateTeam);
  assert.equal(duplicate.ok, false);
  if (!duplicate.ok) assert.equal(duplicate.error.type, "TeamMembershipError");

  const team = value(createRegistryEntry("official", teamDefinition(player.lock)));
  const unresolved = createDefinitionRegistry([team]);
  assert.equal(unresolved.ok, false);
  if (!unresolved.ok) assert.equal(unresolved.error.type, "TeamMembershipError");
});

test("registry snapshots reject lock identity drift, duplicate identities, and tampered definitions", () => {
  const fixture = completeRegistry();
  const identityDrift = {
    ...fixture.resource,
    lock: { ...fixture.resource.lock, key: "resource.different" }
  };
  const drift = createDefinitionRegistry([identityDrift]);
  assert.equal(drift.ok, false);
  if (!drift.ok) assert.equal(drift.error.type, "RegistryIdentityError");

  const duplicate = createDefinitionRegistry([fixture.resource, fixture.resource]);
  assert.equal(duplicate.ok, false);
  if (!duplicate.ok) assert.equal(duplicate.error.type, "RegistryIdentityError");

  const tampered = {
    lock: fixture.resource.lock,
    definition: pluginResourceDefinition({ resource: { type: "plugin", name: "github", version: "9.0.0" } })
  };
  const integrity = createDefinitionRegistry([tampered]);
  assert.equal(integrity.ok, false);
  if (!integrity.ok) assert.equal(integrity.error.type, "RegistryIntegrityError");
});

function completeRegistry(): {
  readonly registry: DefinitionRegistry;
  readonly resource: RegistryEntry;
  readonly skill: RegistryEntry;
  readonly player: RegistryEntry;
  readonly team: RegistryEntry;
  readonly coach: RegistryEntry;
} {
  const resource = value(createRegistryEntry("official", pluginResourceDefinition()));
  const skill = value(createRegistryEntry("official", skillDefinition(resource.lock)));
  const player = value(createRegistryEntry("official", playerDefinition([skill.lock, resource.lock])));
  const team = value(createRegistryEntry("official", teamDefinition(player.lock)));
  const coach = value(createRegistryEntry("official", coachDefinition([skill.lock])));
  const registry = value(createDefinitionRegistry([resource, skill, player, team, coach]));
  return { registry, resource, skill, player, team, coach };
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

function skillDefinition(resource: DefinitionLock): unknown {
  return {
    schema: REGISTRY_DEFINITION_SCHEMA,
    kind: "skill",
    key: "skill.repository-review",
    version: "1.0.0",
    skill: { name: "repository-review", instructions: "Review the repository and report evidence.", resources: [resource] }
  };
}

function playerDefinition(resources: readonly DefinitionLock[]): unknown {
  return {
    schema: REGISTRY_DEFINITION_SCHEMA,
    kind: "player",
    key: "player.builder",
    version: "1.0.0",
    player: {
      promptTemplate: "Implement the selected Goal.",
      resources,
      runtimePolicy: { fileAccess: "project_write", network: "denied", approval: "user" }
    }
  };
}

function teamDefinition(player: DefinitionLock, players = [{ player, role: "build", order: 1 }]): unknown {
  return {
    schema: REGISTRY_DEFINITION_SCHEMA,
    kind: "team",
    key: "team.delivery",
    version: "1.0.0",
    team: {
      strategy: { mode: "sequence", promptTemplate: "Coordinate the Players.", maxRounds: 2 },
      players
    }
  };
}

function coachDefinition(resources: readonly DefinitionLock[]): unknown {
  return {
    schema: REGISTRY_DEFINITION_SCHEMA,
    kind: "coach",
    key: "coach.product",
    version: "1.0.0",
    coach: {
      promptTemplate: "Review evidence and propose the next Goal change.",
      resources,
      policy: { goalChanges: "propose_only", runnerChanges: "propose_only", hunsu: "propose_only", selection: "user_only" }
    }
  };
}

function value<T>(result: Result<T, RegistryError>): T {
  assert.equal(result.ok, true, result.ok ? undefined : `${result.error.type} at ${result.error.path}`);
  if (!result.ok) throw new Error("unreachable");
  return result.value;
}
