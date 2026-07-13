import { err, ok } from "@hunsu/protocol";
import { canonicalJson, sha256Hex } from "./canonical.ts";
import {
  decodeDefinitionLock,
  decodeRegistryDefinition,
  decodeRegistryIntegrity,
  decodeRegistryOrigin
} from "./decoder.ts";
import {
  REGISTRY_INTEGRITY_PREFIX,
  REGISTRY_SNAPSHOT_SCHEMA,
  type DefinitionLock,
  type DefinitionRegistry,
  type RegistryDefinition,
  type RegistryEntry,
  type RegistryIntegrity,
  type RegistryResult,
  type RunnerDefinition,
  type TeamDefinition
} from "./model.ts";

export function canonicalizeRegistryDefinition(value: unknown): RegistryResult<string> {
  const definition = decodeRegistryDefinition(value);
  if (!definition.ok) return definition;
  return canonicalJson(definition.value);
}

export function computeRegistryIntegrity(value: unknown): RegistryResult<RegistryIntegrity> {
  const canonical = canonicalizeRegistryDefinition(value);
  if (!canonical.ok) return canonical;
  return ok(`${REGISTRY_INTEGRITY_PREFIX}${sha256Hex(canonical.value)}` as RegistryIntegrity);
}

export function verifyRegistryIntegrity(value: unknown, expectedValue: unknown): RegistryResult<true> {
  const expected = decodeRegistryIntegrity(expectedValue, "$.integrity");
  if (!expected.ok) return expected;
  const actual = computeRegistryIntegrity(value);
  if (!actual.ok) return actual;
  return expected.value === actual.value
    ? ok(true)
    : integrityError("$.integrity", expected.value, actual.value);
}

export function createDefinitionLock(originValue: unknown, definitionValue: unknown): RegistryResult<DefinitionLock> {
  const origin = decodeRegistryOrigin(originValue, "$.origin");
  if (!origin.ok) return origin;
  const definition = decodeRegistryDefinition(definitionValue, "$.definition");
  if (!definition.ok) return definition;
  const integrity = computeRegistryIntegrity(definition.value);
  if (!integrity.ok) return integrity;
  return ok({
    origin: origin.value,
    kind: definition.value.kind,
    key: definition.value.key,
    version: definition.value.version,
    integrity: integrity.value
  });
}

export function createRegistryEntry(originValue: unknown, definitionValue: unknown): RegistryResult<RegistryEntry> {
  const definition = decodeRegistryDefinition(definitionValue, "$.definition");
  if (!definition.ok) return definition;
  const lock = createDefinitionLock(originValue, definition.value);
  if (!lock.ok) return lock;
  return ok({ lock: lock.value, definition: definition.value });
}

export function createDefinitionRegistry(entries: readonly unknown[]): RegistryResult<DefinitionRegistry> {
  return decodeDefinitionRegistry({ schema: REGISTRY_SNAPSHOT_SCHEMA, entries });
}

export function decodeDefinitionRegistry(value: unknown, path = "$" ): RegistryResult<DefinitionRegistry> {
  const record = exactRecord(value, path, ["schema", "entries"]);
  if (!record.ok) return record;
  if (record.value.schema !== REGISTRY_SNAPSHOT_SCHEMA) {
    return decodeError(`${path}.schema`, `schema must be ${REGISTRY_SNAPSHOT_SCHEMA}`);
  }
  if (!Array.isArray(record.value.entries)) return decodeError(`${path}.entries`, "entries must be an array");

  const entries: RegistryEntry[] = [];
  const identities = new Set<string>();
  for (let index = 0; index < record.value.entries.length; index += 1) {
    const entryPath = `${path}.entries[${index}]`;
    const entry = exactRecord(record.value.entries[index], entryPath, ["lock", "definition"]);
    if (!entry.ok) return entry;
    const lock = decodeDefinitionLock(entry.value.lock, `${entryPath}.lock`);
    if (!lock.ok) return lock;
    const definition = decodeRegistryDefinition(entry.value.definition, `${entryPath}.definition`);
    if (!definition.ok) return definition;
    if (lock.value.kind !== definition.value.kind || lock.value.key !== definition.value.key || lock.value.version !== definition.value.version) {
      return identityError(entryPath, "lock kind, key, and version must exactly match the definition");
    }
    const actual = computeRegistryIntegrity(definition.value);
    if (!actual.ok) return actual;
    if (lock.value.integrity !== actual.value) {
      return integrityError(`${entryPath}.lock.integrity`, lock.value.integrity, actual.value);
    }
    const identity = definitionIdentity(lock.value);
    if (identities.has(identity)) return identityError(entryPath, `duplicate registry entry ${identity}`);
    identities.add(identity);
    entries.push({ lock: lock.value, definition: definition.value });
  }

  const registry: DefinitionRegistry = { schema: REGISTRY_SNAPSHOT_SCHEMA, entries };
  for (let index = 0; index < entries.length; index += 1) {
    const references = definitionReferences(entries[index]!.definition);
    for (let referenceIndex = 0; referenceIndex < references.length; referenceIndex += 1) {
      const reference = references[referenceIndex]!;
      const resolved = resolveEntry(registry, reference.lock, `${path}.entries[${index}].definition.${reference.path}`);
      if (!resolved.ok) {
        if (entries[index]!.definition.kind === "team") {
          return teamError(resolved.error.path, describeError(resolved.error));
        }
        return resolved;
      }
    }
  }
  return ok(registry);
}

export function resolveRegistryDefinition(registryValue: unknown, lockValue: unknown): RegistryResult<RegistryDefinition> {
  const registry = decodeDefinitionRegistry(registryValue, "$.registry");
  if (!registry.ok) return registry;
  const lock = decodeDefinitionLock(lockValue, "$.lock");
  if (!lock.ok) return lock;
  const entry = resolveEntry(registry.value, lock.value, "$.lock");
  return entry.ok ? ok(entry.value.definition) : entry;
}

export function resolveRunnerDefinition(registryValue: unknown, lockValue: unknown): RegistryResult<RunnerDefinition> {
  const lock = decodeDefinitionLock(lockValue, "$.lock");
  if (!lock.ok) return lock;
  if (lock.value.kind !== "player" && lock.value.kind !== "team") {
    return resolutionError("$.lock.kind", "Runner definition lock must target a Player or Team");
  }
  const definition = resolveRegistryDefinition(registryValue, lock.value);
  if (!definition.ok) return definition;
  return definition.value.kind === "player" || definition.value.kind === "team"
    ? ok(definition.value)
    : resolutionError("$.lock.kind", "resolved definition is not a Runner");
}

export function validateTeamMembership(teamValue: unknown, registryValue: unknown): RegistryResult<true> {
  const team = decodeRegistryDefinition(teamValue, "$.team");
  if (!team.ok) return team;
  if (team.value.kind !== "team") return teamError("$.team.kind", "definition must be a Team");
  const registry = decodeDefinitionRegistry(registryValue, "$.registry");
  if (!registry.ok) return registry;
  for (let index = 0; index < team.value.team.players.length; index += 1) {
    const resolved = resolveEntry(registry.value, team.value.team.players[index]!.player, `$.team.team.players[${index}].player`);
    if (!resolved.ok) return teamError(resolved.error.path, describeError(resolved.error));
    if (resolved.value.definition.kind !== "player") return teamError(`$.team.team.players[${index}].player`, "Team membership must resolve to a Player");
  }
  return ok(true);
}

function resolveEntry(registry: DefinitionRegistry, lock: DefinitionLock, path: string): RegistryResult<RegistryEntry> {
  const entry = registry.entries.find(candidate => sameIdentity(candidate.lock, lock));
  if (!entry) return resolutionError(path, `definition not found: ${definitionIdentity(lock)}`);
  if (entry.lock.integrity !== lock.integrity) return integrityError(`${path}.integrity`, lock.integrity, entry.lock.integrity);
  return ok(entry);
}

function definitionReferences(definition: RegistryDefinition): readonly { readonly path: string; readonly lock: DefinitionLock }[] {
  switch (definition.kind) {
    case "player":
      return definition.player.resources.map((lock, index) => ({ path: `player.resources[${index}]`, lock }));
    case "team":
      return definition.team.players.map((playerSlot, index) => ({ path: `team.players[${index}].player`, lock: playerSlot.player }));
    case "coach":
      return definition.coach.resources.map((lock, index) => ({ path: `coach.resources[${index}]`, lock }));
    case "skill":
      return definition.skill.resources.map((lock, index) => ({ path: `skill.resources[${index}]`, lock }));
    case "resource":
      return [];
  }
}

function sameIdentity(left: DefinitionLock, right: DefinitionLock): boolean {
  return left.origin === right.origin && left.kind === right.kind && left.key === right.key && left.version === right.version;
}

function definitionIdentity(lock: Pick<DefinitionLock, "origin" | "kind" | "key" | "version">): string {
  return `${lock.origin}/${lock.kind}/${lock.key}@${lock.version}`;
}

function exactRecord(value: unknown, path: string, keys: readonly string[]): RegistryResult<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return decodeError(path, "value must be an object");
  const record = value as Record<string, unknown>;
  const allowed = new Set(keys);
  const unknown = Object.keys(record).filter(key => !allowed.has(key)).sort();
  if (unknown.length > 0) return decodeError(path, `unsupported keys: ${unknown.join(", ")}`);
  const missing = keys.filter(key => !Object.hasOwn(record, key));
  if (missing.length > 0) return decodeError(path, `missing keys: ${missing.join(", ")}`);
  return ok(record);
}

function decodeError(path: string, message: string): RegistryResult<never> {
  return err({ type: "RegistryDecodeError", path, message });
}

function identityError(path: string, message: string): RegistryResult<never> {
  return err({ type: "RegistryIdentityError", path, message });
}

function integrityError(path: string, expected: RegistryIntegrity, actual: RegistryIntegrity): RegistryResult<never> {
  return err({ type: "RegistryIntegrityError", path, expected, actual });
}

function resolutionError(path: string, message: string): RegistryResult<never> {
  return err({ type: "RegistryResolutionError", path, message });
}

function teamError(path: string, message: string): RegistryResult<never> {
  return err({ type: "TeamMembershipError", path, message });
}

function describeError(error: Exclude<RegistryResult<never>, { ok: true }>["error"]): string {
  return error.type === "RegistryIntegrityError"
    ? `integrity mismatch: expected ${error.expected}, actual ${error.actual}`
    : error.message;
}
