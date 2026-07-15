import {
  err,
  ok,
  type RunnerTypeIntegrity,
  type RunnerTypeLock,
  type RunnerValueTypeDecoder,
  type RunnerValueTypeRegistry
} from "@hunsu/protocol";
import { canonicalJson, sha256Hex } from "./canonical.ts";
import {
  decodeDefinitionIntegrity,
  decodeDefinitionLock,
  decodeRegistryDefinition,
  decodeRegistryOrigin,
  decodeRunnerTypeLock
} from "./decoder.ts";
import {
  REGISTRY_INTEGRITY_PREFIX,
  REGISTRY_SNAPSHOT_SCHEMA,
  RUNNER_TYPE_INTEGRITY_PREFIX,
  type DefinitionIntegrity,
  type DefinitionKind,
  type DefinitionLock,
  type DefinitionRegistry,
  type RegistryDefinition,
  type RegistryEntry,
  type RegistryResult,
  type ResolvedRunnerType,
  type RunnerTypeDefinition
} from "./model.ts";
import { decodeRunnerValuePayload } from "./runner-value.ts";

export function canonicalizeRegistryDefinition(value: unknown): RegistryResult<string> {
  const definition = decodeRegistryDefinition(value);
  if (!definition.ok) return definition;
  return canonicalJson(definition.value);
}

export function computeDefinitionIntegrity(value: unknown): RegistryResult<DefinitionIntegrity> {
  const definition = decodeRegistryDefinition(value);
  if (!definition.ok) return definition;
  const canonical = canonicalJson(definition.value);
  if (!canonical.ok) return canonical;
  const prefix = definition.value.kind === "runner_type" ? RUNNER_TYPE_INTEGRITY_PREFIX : REGISTRY_INTEGRITY_PREFIX;
  return ok(`${prefix}${sha256Hex(canonical.value)}` as DefinitionIntegrity);
}

export function verifyDefinitionIntegrity(value: unknown, expectedValue: unknown): RegistryResult<true> {
  const definition = decodeRegistryDefinition(value);
  if (!definition.ok) return definition;
  const expected = decodeDefinitionIntegrity(expectedValue, definition.value.kind, "$.integrity");
  if (!expected.ok) return expected;
  const actual = computeDefinitionIntegrity(definition.value);
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
  const integrity = computeDefinitionIntegrity(definition.value);
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
    const actual = computeDefinitionIntegrity(definition.value);
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
    for (const reference of references) {
      const resolved = resolveEntry(registry, reference.lock, `${path}.entries[${index}].definition.${reference.path}`);
      if (!resolved.ok) return resolved;
      if (resolved.value.definition.kind !== reference.lock.kind) {
        return resolutionError(reference.path, `definition must resolve to kind ${reference.lock.kind}`);
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

export function definitionLockToRunnerTypeLock(lockValue: unknown): RegistryResult<RunnerTypeLock> {
  const lock = decodeDefinitionLock(lockValue, "$.lock");
  if (!lock.ok) return lock;
  if (lock.value.kind !== "runner_type") return resolutionError("$.lock.kind", "definition lock must target a Runner type");
  return decodeRunnerTypeLock({
    origin: lock.value.origin,
    key: lock.value.key,
    schemaVersion: lock.value.version,
    integrity: lock.value.integrity
  }, "$.lock");
}

export function resolveRunnerTypeDefinition(registryValue: unknown, lockValue: unknown): RegistryResult<ResolvedRunnerType> {
  const registry = decodeDefinitionRegistry(registryValue, "$.registry");
  if (!registry.ok) return registry;
  const lock = decodeRunnerTypeLock(lockValue, "$.lock");
  if (!lock.ok) return lock;
  const entry = registry.value.entries.find(candidate =>
    candidate.lock.kind === "runner_type"
    && String(candidate.lock.origin) === String(lock.value.origin)
    && String(candidate.lock.key) === String(lock.value.key)
    && String(candidate.lock.version) === String(lock.value.schemaVersion)
  );
  if (!entry || entry.definition.kind !== "runner_type") {
    return resolutionError("$.lock", `Runner type not found: ${lock.value.origin}/${lock.value.key}@${lock.value.schemaVersion}`);
  }
  if (entry.lock.integrity !== lock.value.integrity) {
    return integrityError("$.lock.integrity", lock.value.integrity, entry.lock.integrity);
  }
  return ok({ lock: lock.value, definition: entry.definition });
}

export function createRunnerValueTypeDecoder(registryValue: unknown, lockValue: unknown): RegistryResult<RunnerValueTypeDecoder> {
  const resolved = resolveRunnerTypeDefinition(registryValue, lockValue);
  if (!resolved.ok) return resolved;
  return ok(decoderFor(resolved.value.lock, resolved.value.definition));
}

export function createRunnerValueTypeRegistry(registryValue: unknown): RegistryResult<RunnerValueTypeRegistry> {
  const registry = decodeDefinitionRegistry(registryValue, "$.registry");
  if (!registry.ok) return registry;
  const decoders: RunnerValueTypeDecoder[] = [];
  for (const entry of registry.value.entries) {
    if (entry.definition.kind !== "runner_type") continue;
    const lock = definitionLockToRunnerTypeLock(entry.lock);
    if (!lock.ok) return lock;
    decoders.push(decoderFor(lock.value, entry.definition));
  }
  return ok(decoders);
}

function decoderFor(lock: RunnerTypeLock, definition: RunnerTypeDefinition): RunnerValueTypeDecoder {
  return {
    type: lock,
    decode: (value, path) => decodeRunnerValuePayload(definition.runnerType.valueSchema, value, path)
  };
}

function resolveEntry(registry: DefinitionRegistry, lock: DefinitionLock, path: string): RegistryResult<RegistryEntry> {
  const entry = registry.entries.find(candidate => sameIdentity(candidate.lock, lock));
  if (!entry) return resolutionError(path, `definition not found: ${definitionIdentity(lock)}`);
  if (entry.lock.integrity !== lock.integrity) return integrityError(`${path}.integrity`, lock.integrity, entry.lock.integrity);
  return ok(entry);
}

function definitionReferences(definition: RegistryDefinition): readonly { readonly path: string; readonly lock: DefinitionLock }[] {
  switch (definition.kind) {
    case "runner_type":
      return [{ path: "runnerType.executor.resource", lock: definition.runnerType.executor.resource }];
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

function integrityError(path: string, expected: DefinitionIntegrity, actual: DefinitionIntegrity): RegistryResult<never> {
  return err({ type: "RegistryIntegrityError", path, expected, actual });
}

function resolutionError(path: string, message: string): RegistryResult<never> {
  return err({ type: "RegistryResolutionError", path, message });
}
