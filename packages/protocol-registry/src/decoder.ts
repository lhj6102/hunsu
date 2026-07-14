import {
  err,
  makeRunnerSchemaVersion,
  makeRunnerTypeIntegrity,
  makeRunnerTypeKey,
  makeRunnerTypeOrigin,
  ok,
  type RunnerTypeLock
} from "@hunsu/protocol";
import {
  REGISTRY_DEFINITION_SCHEMA,
  REGISTRY_INTEGRITY_PREFIX,
  type CoachDefinition,
  type DefinitionIntegrity,
  type DefinitionKind,
  type DefinitionLock,
  type RegisteredResource,
  type RegistryDefinition,
  type RegistryIntegrity,
  type RegistryKey,
  type RegistryOrigin,
  type RegistryResult,
  type RegistryVersion,
  type ResourceDefinition,
  type RunnerExecutorContract,
  type RunnerTypeDefinition,
  type RunnerValueSchema,
  type SkillDefinition
} from "./model.ts";

const DEFINITION_KINDS = ["runner_type", "coach", "skill", "resource"] as const;
const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const RUNNER_SCHEMA_TYPES = ["object", "array", "string", "string_enum", "integer", "number", "boolean", "null"] as const;
const MAX_SCHEMA_DEPTH = 32;
const MAX_SCHEMA_PROPERTIES = 256;
const MAX_RUNNER_COLLECTION_ITEMS = 10_000;
const MAX_RUNNER_STRING_LENGTH = 1_000_000;

export function decodeDefinitionLock(value: unknown, path = "$" ): RegistryResult<DefinitionLock> {
  const record = exactRecord(value, path, ["origin", "kind", "key", "version", "integrity"]);
  if (!record.ok) return record;
  const origin = decodeRegistryOrigin(record.value.origin, `${path}.origin`);
  if (!origin.ok) return origin;
  const kind = oneOf(record.value.kind, DEFINITION_KINDS, `${path}.kind`);
  if (!kind.ok) return kind;
  const key = decodeRegistryKey(record.value.key, `${path}.key`);
  if (!key.ok) return key;
  const version = decodeRegistryVersion(record.value.version, `${path}.version`);
  if (!version.ok) return version;
  const integrity = decodeDefinitionIntegrity(record.value.integrity, kind.value, `${path}.integrity`);
  if (!integrity.ok) return integrity;
  return ok({
    origin: origin.value,
    kind: kind.value,
    key: key.value,
    version: version.value,
    integrity: integrity.value
  });
}

export function decodeRunnerTypeLock(value: unknown, path = "$" ): RegistryResult<RunnerTypeLock> {
  const record = exactRecord(value, path, ["origin", "key", "schemaVersion", "integrity"]);
  if (!record.ok) return record;
  const origin = makeRunnerTypeOrigin(record.value.origin, `${path}.origin`);
  if (!origin.ok) return invalid(origin.error.field, origin.error.message);
  const key = makeRunnerTypeKey(record.value.key, `${path}.key`);
  if (!key.ok) return invalid(key.error.field, key.error.message);
  const schemaVersion = makeRunnerSchemaVersion(record.value.schemaVersion, `${path}.schemaVersion`);
  if (!schemaVersion.ok) return invalid(schemaVersion.error.field, schemaVersion.error.message);
  const integrity = makeRunnerTypeIntegrity(record.value.integrity, `${path}.integrity`);
  if (!integrity.ok) return invalid(integrity.error.field, integrity.error.message);
  return ok({ origin: origin.value, key: key.value, schemaVersion: schemaVersion.value, integrity: integrity.value });
}

export function decodeRegistryDefinition(value: unknown, path = "$" ): RegistryResult<RegistryDefinition> {
  if (!isRecord(value)) return invalid(path, "definition must be an object");
  const kind = oneOf(value.kind, DEFINITION_KINDS, `${path}.kind`);
  if (!kind.ok) return kind;
  switch (kind.value) {
    case "runner_type":
      return decodeRunnerTypeDefinition(value, path);
    case "coach":
      return decodeCoachDefinition(value, path);
    case "skill":
      return decodeSkillDefinition(value, path);
    case "resource":
      return decodeResourceDefinition(value, path);
  }
}

export function decodeRunnerValueSchema(value: unknown, path = "$", depth = 0): RegistryResult<RunnerValueSchema> {
  if (depth > MAX_SCHEMA_DEPTH) return invalid(path, `Runner value schema exceeds depth ${MAX_SCHEMA_DEPTH}`);
  if (!isRecord(value)) return invalid(path, "Runner value schema must be an object");
  const type = oneOf(value.type, RUNNER_SCHEMA_TYPES, `${path}.type`);
  if (!type.ok) return type;
  switch (type.value) {
    case "object": {
      const record = exactRecord(value, path, ["type", "properties", "required", "additionalProperties"]);
      if (!record.ok) return record;
      if (record.value.additionalProperties !== false) return invalid(`${path}.additionalProperties`, "additionalProperties must be false");
      if (!isRecord(record.value.properties)) return invalid(`${path}.properties`, "properties must be an object");
      const propertyKeys = Object.keys(record.value.properties);
      if (propertyKeys.length > MAX_SCHEMA_PROPERTIES) return invalid(`${path}.properties`, `properties cannot exceed ${MAX_SCHEMA_PROPERTIES} fields`);
      const properties: Record<string, RunnerValueSchema> = {};
      for (const key of propertyKeys.sort()) {
        if (!/^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/u.test(key)) return invalid(`${path}.properties`, `invalid property key ${JSON.stringify(key)}`);
        const property = decodeRunnerValueSchema(record.value.properties[key], `${path}.properties.${key}`, depth + 1);
        if (!property.ok) return property;
        Object.defineProperty(properties, key, {
          value: property.value,
          enumerable: true,
          configurable: true,
          writable: true
        });
      }
      const required = stringList(record.value.required, `${path}.required`);
      if (!required.ok) return required;
      for (const key of required.value) {
        if (!Object.hasOwn(properties, key)) return invalid(`${path}.required`, `required property ${key} is not defined`);
      }
      return ok({ type: "object", properties, required: [...required.value].sort(), additionalProperties: false });
    }
    case "array": {
      const record = exactRecord(value, path, ["type", "items", "minItems", "maxItems", "uniqueItems"]);
      if (!record.ok) return record;
      const items = decodeRunnerValueSchema(record.value.items, `${path}.items`, depth + 1);
      if (!items.ok) return items;
      const bounds = collectionBounds(record.value.minItems, record.value.maxItems, path);
      if (!bounds.ok) return bounds;
      if (typeof record.value.uniqueItems !== "boolean") return invalid(`${path}.uniqueItems`, "uniqueItems must be boolean");
      return ok({ type: "array", items: items.value, ...bounds.value, uniqueItems: record.value.uniqueItems });
    }
    case "string": {
      const record = exactRecord(value, path, ["type", "minLength", "maxLength"]);
      if (!record.ok) return record;
      const bounds = stringBounds(record.value.minLength, record.value.maxLength, path);
      return bounds.ok ? ok({ type: "string", ...bounds.value }) : bounds;
    }
    case "string_enum": {
      const record = exactRecord(value, path, ["type", "values"]);
      if (!record.ok) return record;
      const values = nonEmptyStringList(record.value.values, `${path}.values`);
      return values.ok ? ok({ type: "string_enum", values: values.value }) : values;
    }
    case "integer":
    case "number": {
      const record = exactRecord(value, path, ["type", "minimum", "maximum"]);
      if (!record.ok) return record;
      const bounds = numberBounds(record.value.minimum, record.value.maximum, path, type.value === "integer");
      return bounds.ok ? ok({ type: type.value, ...bounds.value }) : bounds;
    }
    case "boolean":
    case "null": {
      const record = exactRecord(value, path, ["type"]);
      return record.ok ? ok({ type: type.value }) : record;
    }
  }
}

function decodeRunnerTypeDefinition(value: unknown, path: string): RegistryResult<RunnerTypeDefinition> {
  const header = decodeHeader(value, "runner_type", "runnerType", path);
  if (!header.ok) return header;
  const runnerType = exactRecord(header.value.payload, `${path}.runnerType`, ["displayName", "valueSchema", "executor"]);
  if (!runnerType.ok) return runnerType;
  const displayName = nonEmptyText(runnerType.value.displayName, `${path}.runnerType.displayName`, 256);
  if (!displayName.ok) return displayName;
  const valueSchema = decodeRunnerValueSchema(runnerType.value.valueSchema, `${path}.runnerType.valueSchema`);
  if (!valueSchema.ok) return valueSchema;
  const executor = decodeExecutorContract(runnerType.value.executor, `${path}.runnerType.executor`);
  if (!executor.ok) return executor;
  return ok({
    ...header.value.header,
    kind: "runner_type",
    runnerType: { displayName: displayName.value, valueSchema: valueSchema.value, executor: executor.value }
  });
}

function decodeExecutorContract(value: unknown, path: string): RegistryResult<RunnerExecutorContract> {
  const record = exactRecord(value, path, ["schema", "resource", "entrypoint"]);
  if (!record.ok) return record;
  if (record.value.schema !== "hunsu.runner-executor.v1") return invalid(`${path}.schema`, "schema must be hunsu.runner-executor.v1");
  const resource = decodeDefinitionLock(record.value.resource, `${path}.resource`);
  if (!resource.ok) return resource;
  if (resource.value.kind !== "resource") return invalid(`${path}.resource.kind`, "executor must lock a resource definition");
  const entrypoint = nonEmptyText(record.value.entrypoint, `${path}.entrypoint`, 256);
  if (!entrypoint.ok) return entrypoint;
  return ok({
    schema: "hunsu.runner-executor.v1",
    resource: resource.value as DefinitionLock<"resource">,
    entrypoint: entrypoint.value
  });
}

function decodeCoachDefinition(value: unknown, path: string): RegistryResult<CoachDefinition> {
  const header = decodeHeader(value, "coach", "coach", path);
  if (!header.ok) return header;
  const coach = exactRecord(header.value.payload, `${path}.coach`, ["promptTemplate", "resources", "policy"]);
  if (!coach.ok) return coach;
  const promptTemplate = nonEmptyText(coach.value.promptTemplate, `${path}.coach.promptTemplate`, 100_000);
  if (!promptTemplate.ok) return promptTemplate;
  const resources = decodeLocks(coach.value.resources, ["skill", "resource"], `${path}.coach.resources`);
  if (!resources.ok) return resources;
  const policy = exactRecord(coach.value.policy, `${path}.coach.policy`, ["transitions", "selection", "rejection"]);
  if (!policy.ok) return policy;
  if (policy.value.transitions !== "propose_only") return invalid(`${path}.coach.policy.transitions`, "transitions must be propose_only");
  if (policy.value.selection !== "user_only") return invalid(`${path}.coach.policy.selection`, "selection must be user_only");
  if (policy.value.rejection !== "user_only") return invalid(`${path}.coach.policy.rejection`, "rejection must be user_only");
  return ok({
    ...header.value.header,
    kind: "coach",
    coach: {
      promptTemplate: promptTemplate.value,
      resources: resources.value,
      policy: { transitions: "propose_only", selection: "user_only", rejection: "user_only" }
    }
  });
}

function decodeSkillDefinition(value: unknown, path: string): RegistryResult<SkillDefinition> {
  const header = decodeHeader(value, "skill", "skill", path);
  if (!header.ok) return header;
  const skill = exactRecord(header.value.payload, `${path}.skill`, ["name", "instructions", "resources"]);
  if (!skill.ok) return skill;
  const name = nonEmptyText(skill.value.name, `${path}.skill.name`, 256);
  if (!name.ok) return name;
  const instructions = nonEmptyText(skill.value.instructions, `${path}.skill.instructions`, 100_000);
  if (!instructions.ok) return instructions;
  const resources = decodeLocks(skill.value.resources, ["resource"], `${path}.skill.resources`);
  if (!resources.ok) return resources;
  return ok({ ...header.value.header, kind: "skill", skill: { name: name.value, instructions: instructions.value, resources: resources.value } });
}

function decodeResourceDefinition(value: unknown, path: string): RegistryResult<ResourceDefinition> {
  const header = decodeHeader(value, "resource", "resource", path);
  if (!header.ok) return header;
  if (!isRecord(header.value.payload)) return invalid(`${path}.resource`, "resource must be an object");
  const type = oneOf(header.value.payload.type, ["skill", "plugin"] as const, `${path}.resource.type`);
  if (!type.ok) return type;
  let resource: RegisteredResource;
  if (type.value === "skill") {
    const record = exactRecord(header.value.payload, `${path}.resource`, ["type", "name", "source"]);
    if (!record.ok) return record;
    const name = nonEmptyText(record.value.name, `${path}.resource.name`, 256);
    if (!name.ok) return name;
    const source = nonEmptyText(record.value.source, `${path}.resource.source`, 2048);
    if (!source.ok) return source;
    resource = { type: "skill", name: name.value, source: source.value };
  } else {
    const record = exactRecord(header.value.payload, `${path}.resource`, ["type", "name", "version"]);
    if (!record.ok) return record;
    const name = nonEmptyText(record.value.name, `${path}.resource.name`, 256);
    if (!name.ok) return name;
    const version = decodeRegistryVersion(record.value.version, `${path}.resource.version`);
    if (!version.ok) return version;
    resource = { type: "plugin", name: name.value, version: version.value };
  }
  return ok({ ...header.value.header, kind: "resource", resource });
}

function decodeHeader<Kind extends DefinitionKind>(value: unknown, kind: Kind, payloadKey: string, path: string): RegistryResult<{
  readonly header: { readonly schema: typeof REGISTRY_DEFINITION_SCHEMA; readonly kind: Kind; readonly key: RegistryKey; readonly version: RegistryVersion };
  readonly payload: unknown;
}> {
  const record = exactRecord(value, path, ["schema", "kind", "key", "version", payloadKey]);
  if (!record.ok) return record;
  if (record.value.schema !== REGISTRY_DEFINITION_SCHEMA) return invalid(`${path}.schema`, `schema must be ${REGISTRY_DEFINITION_SCHEMA}`);
  if (record.value.kind !== kind) return invalid(`${path}.kind`, `kind must be ${kind}`);
  const key = decodeRegistryKey(record.value.key, `${path}.key`);
  if (!key.ok) return key;
  const version = decodeRegistryVersion(record.value.version, `${path}.version`);
  if (!version.ok) return version;
  return ok({ header: { schema: REGISTRY_DEFINITION_SCHEMA, kind, key: key.value, version: version.value }, payload: record.value[payloadKey] });
}

function decodeLocks<Kinds extends readonly DefinitionKind[]>(value: unknown, kinds: Kinds, path: string): RegistryResult<readonly DefinitionLock<Kinds[number]>[]> {
  if (!Array.isArray(value)) return invalid(path, "definition locks must be an array");
  const locks: DefinitionLock<Kinds[number]>[] = [];
  const identities = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const lock = decodeDefinitionLock(value[index], `${path}[${index}]`);
    if (!lock.ok) return lock;
    if (!kinds.includes(lock.value.kind)) return invalid(`${path}[${index}].kind`, `kind must be one of ${kinds.join(", ")}`);
    const identity = lockIdentity(lock.value);
    if (identities.has(identity)) return invalid(`${path}[${index}]`, `duplicate definition lock ${identity}`);
    identities.add(identity);
    locks.push(lock.value as DefinitionLock<Kinds[number]>);
  }
  return ok(locks);
}

export function decodeRegistryOrigin(value: unknown, path = "$" ): RegistryResult<RegistryOrigin> {
  if (typeof value !== "string" || !/^[a-z0-9](?:[a-z0-9._-]{0,127})$/u.test(value)) {
    return invalid(path, "origin must be a lowercase committed identifier");
  }
  return ok(value as RegistryOrigin);
}

export function decodeRegistryKey(value: unknown, path = "$" ): RegistryResult<RegistryKey> {
  if (typeof value !== "string" || value.length > 192 || !/^[a-z0-9](?:[a-z0-9._/-]*[a-z0-9])?$/u.test(value) || value.includes("//")) {
    return invalid(path, "key must be a lowercase stable definition key");
  }
  return ok(value as RegistryKey);
}

export function decodeRegistryVersion(value: unknown, path = "$" ): RegistryResult<RegistryVersion> {
  if (typeof value !== "string" || !SEMVER.test(value)) return invalid(path, "version must be an exact semantic version");
  return ok(value as RegistryVersion);
}

export function decodeRegistryIntegrity(value: unknown, path = "$" ): RegistryResult<RegistryIntegrity> {
  if (typeof value !== "string" || !value.startsWith(REGISTRY_INTEGRITY_PREFIX) || !/^[0-9a-f]{64}$/u.test(value.slice(REGISTRY_INTEGRITY_PREFIX.length))) {
    return invalid(path, `integrity must use ${REGISTRY_INTEGRITY_PREFIX} followed by 64 lowercase hexadecimal characters`);
  }
  return ok(value as RegistryIntegrity);
}

export function decodeDefinitionIntegrity(value: unknown, kind: DefinitionKind, path: string): RegistryResult<DefinitionIntegrity> {
  if (kind === "runner_type") {
    const integrity = makeRunnerTypeIntegrity(value, path);
    return integrity.ok ? ok(integrity.value) : invalid(integrity.error.field, integrity.error.message);
  }
  return decodeRegistryIntegrity(value, path);
}

function collectionBounds(minimum: unknown, maximum: unknown, path: string): RegistryResult<{ readonly minItems: number; readonly maxItems: number }> {
  if (!Number.isSafeInteger(minimum) || Number(minimum) < 0) return invalid(`${path}.minItems`, "minItems must be a non-negative safe integer");
  if (!Number.isSafeInteger(maximum) || Number(maximum) < Number(minimum) || Number(maximum) > MAX_RUNNER_COLLECTION_ITEMS) {
    return invalid(`${path}.maxItems`, `maxItems must be between minItems and ${MAX_RUNNER_COLLECTION_ITEMS}`);
  }
  return ok({ minItems: Number(minimum), maxItems: Number(maximum) });
}

function stringBounds(minimum: unknown, maximum: unknown, path: string): RegistryResult<{ readonly minLength: number; readonly maxLength: number }> {
  if (!Number.isSafeInteger(minimum) || Number(minimum) < 0) return invalid(`${path}.minLength`, "minLength must be a non-negative safe integer");
  if (!Number.isSafeInteger(maximum) || Number(maximum) < Number(minimum) || Number(maximum) > MAX_RUNNER_STRING_LENGTH) {
    return invalid(`${path}.maxLength`, `maxLength must be between minLength and ${MAX_RUNNER_STRING_LENGTH}`);
  }
  return ok({ minLength: Number(minimum), maxLength: Number(maximum) });
}

function numberBounds(minimum: unknown, maximum: unknown, path: string, integer: boolean): RegistryResult<{ readonly minimum: number; readonly maximum: number }> {
  const valid = (value: unknown) => typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0) && (!integer || Number.isSafeInteger(value));
  if (!valid(minimum)) return invalid(`${path}.minimum`, `minimum must be a finite${integer ? " safe integer" : " number"}`);
  if (!valid(maximum) || Number(maximum) < Number(minimum)) return invalid(`${path}.maximum`, "maximum must be valid and greater than or equal to minimum");
  return ok({ minimum: Number(minimum), maximum: Number(maximum) });
}

function nonEmptyText(value: unknown, path: string, maxLength: number): RegistryResult<string> {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maxLength) {
    return invalid(path, `value must be non-empty text of at most ${maxLength} characters`);
  }
  return ok(value);
}

function stringList(value: unknown, path: string): RegistryResult<readonly string[]> {
  if (!Array.isArray(value)) return invalid(path, "value must be an array of unique strings");
  const values: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    if (typeof value[index] !== "string" || seen.has(value[index])) return invalid(`${path}[${index}]`, "value must be a unique string");
    seen.add(value[index]);
    values.push(value[index]);
  }
  return ok(values);
}

function nonEmptyStringList(value: unknown, path: string): RegistryResult<readonly [string, ...string[]]> {
  const values = stringList(value, path);
  if (!values.ok) return values;
  if (values.value.length === 0) return invalid(path, "value must contain at least one string");
  return ok(values.value as [string, ...string[]]);
}

function exactRecord(value: unknown, path: string, keys: readonly string[]): RegistryResult<Record<string, unknown>> {
  if (!isRecord(value)) return invalid(path, "value must be an object");
  const allowed = new Set(keys);
  const unknown = Object.keys(value).filter(key => !allowed.has(key)).sort();
  if (unknown.length > 0) return invalid(path, `unsupported keys: ${unknown.join(", ")}`);
  const missing = keys.filter(key => !Object.hasOwn(value, key));
  if (missing.length > 0) return invalid(path, `missing keys: ${missing.join(", ")}`);
  return ok(value);
}

function oneOf<const Values extends readonly string[]>(value: unknown, values: Values, path: string): RegistryResult<Values[number]> {
  return typeof value === "string" && values.includes(value)
    ? ok(value as Values[number])
    : invalid(path, `value must be one of ${values.join(", ")}`);
}

function lockIdentity(lock: Pick<DefinitionLock, "origin" | "kind" | "key" | "version">): string {
  return `${lock.origin}/${lock.kind}/${lock.key}@${lock.version}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(path: string, message: string): RegistryResult<never> {
  return err({ type: "RegistryDecodeError", path, message });
}
