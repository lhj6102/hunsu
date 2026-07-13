import {
  err,
  makeNonEmptyText,
  makePositiveInteger,
  makePromptTemplate,
  makeResourceName,
  ok,
  type NonEmptyText,
  type PositiveInteger,
  type PromptTemplate,
  type ResourceName
} from "@hunsu/protocol";
import {
  REGISTRY_DEFINITION_SCHEMA,
  REGISTRY_INTEGRITY_PREFIX,
  type CoachDefinition,
  type DefinitionKind,
  type DefinitionLock,
  type PlayerDefinition,
  type RegisteredResource,
  type RegistryDefinition,
  type RegistryIntegrity,
  type RegistryKey,
  type RegistryOrigin,
  type RegistryResult,
  type RegistryVersion,
  type ResourceDefinition,
  type SkillDefinition,
  type TeamDefinition,
  type TeamPlayerDefinition
} from "./model.ts";

const DEFINITION_KINDS = ["player", "team", "coach", "skill", "resource"] as const;
const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

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
  const integrity = decodeRegistryIntegrity(record.value.integrity, `${path}.integrity`);
  if (!integrity.ok) return integrity;
  return ok({ origin: origin.value, kind: kind.value, key: key.value, version: version.value, integrity: integrity.value });
}

export function decodeRegistryDefinition(value: unknown, path = "$" ): RegistryResult<RegistryDefinition> {
  if (!isRecord(value)) return invalid(path, "definition must be an object");
  const kind = oneOf(value.kind, DEFINITION_KINDS, `${path}.kind`);
  if (!kind.ok) return kind;
  switch (kind.value) {
    case "player":
      return decodePlayerDefinition(value, path);
    case "team":
      return decodeTeamDefinition(value, path);
    case "coach":
      return decodeCoachDefinition(value, path);
    case "skill":
      return decodeSkillDefinition(value, path);
    case "resource":
      return decodeResourceDefinition(value, path);
  }
}

function decodePlayerDefinition(value: unknown, path: string): RegistryResult<PlayerDefinition> {
  const header = decodeHeader(value, "player", "player", path);
  if (!header.ok) return header;
  const player = exactRecord(header.value.payload, `${path}.player`, ["promptTemplate", "resources", "runtimePolicy"]);
  if (!player.ok) return player;
  const promptTemplate = promptTemplateText(player.value.promptTemplate, `${path}.player.promptTemplate`);
  if (!promptTemplate.ok) return promptTemplate;
  const resources = decodeLocks(player.value.resources, ["skill", "resource"], `${path}.player.resources`);
  if (!resources.ok) return resources;
  const runtimePolicy = decodeRuntimePolicy(player.value.runtimePolicy, `${path}.player.runtimePolicy`);
  if (!runtimePolicy.ok) return runtimePolicy;
  return ok({ ...header.value.header, kind: "player", player: { promptTemplate: promptTemplate.value, resources: resources.value, runtimePolicy: runtimePolicy.value } });
}

function decodeTeamDefinition(value: unknown, path: string): RegistryResult<TeamDefinition> {
  const header = decodeHeader(value, "team", "team", path);
  if (!header.ok) return header;
  const team = exactRecord(header.value.payload, `${path}.team`, ["strategy", "players"]);
  if (!team.ok) return team;
  const strategy = exactRecord(team.value.strategy, `${path}.team.strategy`, ["mode", "promptTemplate", "maxRounds"]);
  if (!strategy.ok) return strategy;
  const mode = oneOf(strategy.value.mode, ["sequence", "parallel", "coordinated"] as const, `${path}.team.strategy.mode`);
  if (!mode.ok) return mode;
  const promptTemplate = promptTemplateText(strategy.value.promptTemplate, `${path}.team.strategy.promptTemplate`);
  if (!promptTemplate.ok) return promptTemplate;
  const maxRounds = positiveInteger(strategy.value.maxRounds, `${path}.team.strategy.maxRounds`);
  if (!maxRounds.ok) return maxRounds;
  if (!Array.isArray(team.value.players) || team.value.players.length === 0) {
    return invalid(`${path}.team.players`, "Team must contain at least one Player");
  }
  const players: TeamPlayerDefinition[] = [];
  const playerIdentities = new Set<string>();
  const orders = new Set<number>();
  for (let index = 0; index < team.value.players.length; index += 1) {
    const playerPath = `${path}.team.players[${index}]`;
    const playerSlot = exactRecord(team.value.players[index], playerPath, ["player", "role", "order"]);
    if (!playerSlot.ok) return playerSlot;
    const player = decodeDefinitionLock(playerSlot.value.player, `${playerPath}.player`);
    if (!player.ok) return player;
    if (player.value.kind !== "player") return invalid(`${playerPath}.player.kind`, "Team membership must lock a Player definition");
    const role = nonEmptyText(playerSlot.value.role, `${playerPath}.role`);
    if (!role.ok) return role;
    const order = positiveInteger(playerSlot.value.order, `${playerPath}.order`);
    if (!order.ok) return order;
    const playerLock = player.value as DefinitionLock<"player">;
    const identity = lockIdentity(playerLock);
    if (playerIdentities.has(identity)) return teamMembershipError(playerPath, `duplicate Player membership ${identity}`);
    if (orders.has(order.value)) return teamMembershipError(`${playerPath}.order`, `duplicate Team order ${order.value}`);
    playerIdentities.add(identity);
    orders.add(order.value);
    players.push({ player: playerLock, role: role.value, order: order.value });
  }
  return ok({
    ...header.value.header,
    kind: "team",
    team: {
      strategy: { mode: mode.value, promptTemplate: promptTemplate.value, maxRounds: maxRounds.value },
      players: players as [TeamPlayerDefinition, ...TeamPlayerDefinition[]]
    }
  });
}

function decodeCoachDefinition(value: unknown, path: string): RegistryResult<CoachDefinition> {
  const header = decodeHeader(value, "coach", "coach", path);
  if (!header.ok) return header;
  const coach = exactRecord(header.value.payload, `${path}.coach`, ["promptTemplate", "resources", "policy"]);
  if (!coach.ok) return coach;
  const promptTemplate = promptTemplateText(coach.value.promptTemplate, `${path}.coach.promptTemplate`);
  if (!promptTemplate.ok) return promptTemplate;
  const resources = decodeLocks(coach.value.resources, ["skill", "resource"], `${path}.coach.resources`);
  if (!resources.ok) return resources;
  const policy = exactRecord(coach.value.policy, `${path}.coach.policy`, ["goalChanges", "runnerChanges", "hunsu", "selection"]);
  if (!policy.ok) return policy;
  if (policy.value.goalChanges !== "propose_only") return invalid(`${path}.coach.policy.goalChanges`, "goalChanges must be propose_only");
  if (policy.value.runnerChanges !== "propose_only") return invalid(`${path}.coach.policy.runnerChanges`, "runnerChanges must be propose_only");
  if (policy.value.hunsu !== "propose_only") return invalid(`${path}.coach.policy.hunsu`, "hunsu must be propose_only");
  if (policy.value.selection !== "user_only") return invalid(`${path}.coach.policy.selection`, "selection must be user_only");
  return ok({
    ...header.value.header,
    kind: "coach",
    coach: {
      promptTemplate: promptTemplate.value,
      resources: resources.value,
      policy: { goalChanges: "propose_only", runnerChanges: "propose_only", hunsu: "propose_only", selection: "user_only" }
    }
  });
}

function decodeSkillDefinition(value: unknown, path: string): RegistryResult<SkillDefinition> {
  const header = decodeHeader(value, "skill", "skill", path);
  if (!header.ok) return header;
  const skill = exactRecord(header.value.payload, `${path}.skill`, ["name", "instructions", "resources"]);
  if (!skill.ok) return skill;
  const name = resourceName(skill.value.name, `${path}.skill.name`);
  if (!name.ok) return name;
  const instructions = nonEmptyText(skill.value.instructions, `${path}.skill.instructions`);
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
    const name = resourceName(record.value.name, `${path}.resource.name`);
    if (!name.ok) return name;
    const source = nonEmptyText(record.value.source, `${path}.resource.source`);
    if (!source.ok) return source;
    resource = { type: "skill", name: name.value, source: source.value };
  } else {
    const record = exactRecord(header.value.payload, `${path}.resource`, ["type", "name", "version"]);
    if (!record.ok) return record;
    const name = resourceName(record.value.name, `${path}.resource.name`);
    if (!name.ok) return name;
    const version = semanticVersionText(record.value.version, `${path}.resource.version`);
    if (!version.ok) return version;
    resource = { type: "plugin", name: name.value, version: version.value };
  }
  return ok({ ...header.value.header, kind: "resource", resource });
}

function decodeHeader<Kind extends DefinitionKind>(value: unknown, kind: Kind, payloadKey: Kind, path: string): RegistryResult<{
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
  if (!Array.isArray(value)) return invalid(path, "resources must be an array");
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

function decodeRuntimePolicy(value: unknown, path: string): RegistryResult<PlayerDefinition["player"]["runtimePolicy"]> {
  const record = exactRecord(value, path, ["fileAccess", "network", "approval"]);
  if (!record.ok) return record;
  const fileAccess = oneOf(record.value.fileAccess, ["read_only", "project_write"] as const, `${path}.fileAccess`);
  if (!fileAccess.ok) return fileAccess;
  const network = oneOf(record.value.network, ["denied", "allowed"] as const, `${path}.network`);
  if (!network.ok) return network;
  const approval = oneOf(record.value.approval, ["user", "automatic"] as const, `${path}.approval`);
  if (!approval.ok) return approval;
  return ok({ fileAccess: fileAccess.value, network: network.value, approval: approval.value });
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

function exactRecord(value: unknown, path: string, keys: readonly string[]): RegistryResult<Record<string, unknown>> {
  if (!isRecord(value)) return invalid(path, "value must be an object");
  const allowed = new Set(keys);
  const unknown = Object.keys(value).filter(key => !allowed.has(key)).sort();
  if (unknown.length > 0) return invalid(path, `unsupported keys: ${unknown.join(", ")}`);
  const missing = keys.filter(key => !Object.hasOwn(value, key));
  if (missing.length > 0) return invalid(path, `missing keys: ${missing.join(", ")}`);
  return ok(value);
}

function nonEmptyText(value: unknown, path: string): RegistryResult<NonEmptyText> {
  const parsed = makeNonEmptyText(value, path);
  if (!parsed.ok || typeof value !== "string" || value.length > 100_000) {
    return invalid(path, "value must be non-empty text of at most 100000 characters");
  }
  return ok(parsed.value);
}

function promptTemplateText(value: unknown, path: string): RegistryResult<PromptTemplate> {
  const parsed = makePromptTemplate(value, path);
  return parsed.ok && typeof value === "string" && value.length <= 100_000
    ? ok(parsed.value)
    : invalid(path, "value must be a non-empty prompt template of at most 100000 characters");
}

function resourceName(value: unknown, path: string): RegistryResult<ResourceName> {
  const parsed = makeResourceName(value, path);
  return parsed.ok && typeof value === "string" && value.length <= 256
    ? ok(parsed.value)
    : invalid(path, "value must be a non-empty resource name of at most 256 characters");
}

function semanticVersionText(value: unknown, path: string): RegistryResult<NonEmptyText> {
  const text = nonEmptyText(value, path);
  return text.ok && typeof value === "string" && SEMVER.test(value)
    ? text
    : invalid(path, "value must be an exact semantic version");
}

function positiveInteger(value: unknown, path: string): RegistryResult<PositiveInteger> {
  const parsed = makePositiveInteger(value, path);
  return parsed.ok ? ok(parsed.value) : invalid(path, "value must be a positive safe integer");
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

function teamMembershipError(path: string, message: string): RegistryResult<never> {
  return err({ type: "TeamMembershipError", path, message });
}
