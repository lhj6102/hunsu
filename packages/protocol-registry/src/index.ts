import { createHash } from "node:crypto";
import {
  createDefaultHarness,
  createDefaultManagerConfig,
  createDefaultMemberConfig,
  harnessEntityFromSnapshot,
  makeNonEmptyText,
  validateHarnessEntity,
  validateManagerConfig,
  validateMemberConfig,
  type Harness,
  type HubPackageKind,
  type HubPackageLock,
  type HunsuOrigin,
  type ManagerConfig,
  type NonEmptyText,
  type MemberConfig,
  type SkillSnapshotFile
} from "@hunsu/protocol";

export type { HubPackageKind, HubPackageLock, HunsuOrigin } from "@hunsu/protocol";

export const HUB_PACKAGE_MANIFEST_SCHEMA = "hunsu.hub-package-manifest.v1" as const;
export const MANIFEST_INTEGRITY_PREFIX_V1 = "hunsu-json-c14n-v1+sha256:" as const;

export type TeamPackageManifest = {
  schema: typeof HUB_PACKAGE_MANIFEST_SCHEMA;
  kind: "team";
  key: string;
  version: string;
  team: Harness;
  integrity?: string;
};

export type MemberPackageManifest = {
  schema: typeof HUB_PACKAGE_MANIFEST_SCHEMA;
  kind: "member";
  key: string;
  version: string;
  member: MemberConfig;
  integrity?: string;
};

export type ManagerPackageManifest = {
  schema: typeof HUB_PACKAGE_MANIFEST_SCHEMA;
  kind: "manager";
  key: string;
  version: string;
  manager: ManagerConfig;
  integrity?: string;
};

export type SkillPackageManifest = {
  schema: typeof HUB_PACKAGE_MANIFEST_SCHEMA;
  kind: "skill";
  key: string;
  version: string;
  skill: {
    name: string;
    contentHash: string;
    files?: SkillSnapshotFile[];
  };
  integrity?: string;
};

export type HubPackageManifest = TeamPackageManifest | MemberPackageManifest | ManagerPackageManifest | SkillPackageManifest;

export type HubPackageSummary = {
  origin: string;
  entryKind: "package" | "executor";
  kind: HubPackageKind;
  key: string;
  version: string;
  integrity: string;
  label: string;
  sourcePackageKind: HubPackageKind;
  sourcePackageKey: string;
  sourcePackageVersion: string;
  executorId?: string;
  memberOf?: string[];
  promptTemplateEngine?: string;
  memberCount?: number;
  skillCount?: number;
  pluginRequirementCount?: number;
};

export type HubPackageRef = {
  origin: NonEmptyText;
  kind: HubPackageKind;
  key: NonEmptyText;
  version: NonEmptyText;
};

export type HttpHubPackageResolverOptions = {
  origins: HunsuOrigin[];
  fetch?: typeof fetch;
};

export type ResolvedHubPackageManifest = {
  lock: HubPackageLock;
  manifest: HubPackageManifest;
  integrity: string;
  origin: HunsuOrigin;
};

export function hubSeedPackageManifests(): HubPackageManifest[] {
  return [
    superloopyCrewManifest(),
    skillsCurationManifest(),
    defaultHunsuManagerManifest(),
    ideaHelperManagerManifest(),
    researcherManagerManifest(),
    researcherSkillManifest()
  ];
}

function superloopyCrewManifest(): TeamPackageManifest {
  const harness = createDefaultHarness("Plan a convergent crew run using only direct Members visible to this Team.");
  harness.members = [
    createDefaultMemberConfig("build", "Implement the selected task with focused changes."),
    createDefaultMemberConfig("review", "Review the implementation for regressions and missed requirements."),
    createDefaultMemberConfig("test", "Run targeted checks and summarize evidence."),
    createDefaultMemberConfig("gate", "Decide whether the result is ready to finalize."),
    createDefaultMemberConfig("audit", "Audit risks, hidden assumptions, and release notes."),
    createDefaultMemberConfig("navigation", "Keep the crew oriented around the selected Destination.")
  ];
  return {
    schema: HUB_PACKAGE_MANIFEST_SCHEMA,
    kind: "team",
    key: "team.superloopy.crew",
    version: "1.0.2",
    team: harnessEntityFromSnapshot(harness)
  };
}

function skillsCurationManifest(): TeamPackageManifest {
  const harness = createDefaultHarness("Curate reusable Codex skills and validate installation metadata before publication.");
  const skillsCatalog = {
    kind: "skillMeta" as const,
    name: requireMetadataText("skills-catalog", "team.skills-curation.discover.skills[0].name"),
    source: requireMetadataText("github:vercel-labs/skills", "team.skills-curation.discover.skills[0].source"),
    agent: "codex" as const
  };
  harness.members = [
    createDefaultMemberConfig("discover", "Find candidate skills and summarize their purpose.", [skillsCatalog]),
    createDefaultMemberConfig("curate", "Normalize skill metadata and prepare installable entries."),
    createDefaultMemberConfig("verify", "Check skill instructions and installation evidence.")
  ];
  return {
    schema: HUB_PACKAGE_MANIFEST_SCHEMA,
    kind: "team",
    key: "team.skills-curation",
    version: "1.0.2",
    team: harnessEntityFromSnapshot(harness)
  };
}

function defaultHunsuManagerManifest(): ManagerPackageManifest {
  return {
    schema: HUB_PACKAGE_MANIFEST_SCHEMA,
    kind: "manager",
    key: "manager.hunsu.default",
    version: "1.0.0",
    manager: createDefaultManagerConfig()
  };
}

function ideaHelperManagerManifest(): ManagerPackageManifest {
  return {
    schema: HUB_PACKAGE_MANIFEST_SCHEMA,
    kind: "manager",
    key: "manager.idea-helper",
    version: "1.0.0",
    manager: createDefaultManagerConfig(
      "manager.idea-helper",
      [
        "Help the user explore divergent Hunsu options before committing to an editable draft.",
        "Generate alternatives, tradeoffs, naming choices, and likely downstream implications.",
        "Only edit .hunsu-request files when the user chooses a concrete option."
      ].join(" ")
    )
  };
}

function researcherManagerManifest(): ManagerPackageManifest {
  return {
    schema: HUB_PACKAGE_MANIFEST_SCHEMA,
    kind: "manager",
    key: "manager.researcher",
    version: "1.0.0",
    manager: createDefaultManagerConfig(
      "manager.researcher",
      [
        "Gather and synthesize context for a proposed Hunsu change before editing draft runtime files.",
        "Prioritize evidence, source boundaries, and unresolved assumptions.",
        "When a file-backed change is requested, edit only the relevant .hunsu-request files."
      ].join(" "),
      [{
        kind: "skillMeta",
        name: requireMetadataText("researcher", "manager.researcher.skills[0].name"),
        source: requireMetadataText("github:vercel-labs/skills", "manager.researcher.skills[0].source"),
        agent: "codex"
      }]
    )
  };
}

function researcherSkillManifest(): SkillPackageManifest {
  return {
    schema: HUB_PACKAGE_MANIFEST_SCHEMA,
    kind: "skill",
    key: "skill.researcher",
    version: "1.0.0",
    skill: {
      name: "researcher",
      contentHash: "sha256:vercel-labs-skills-researcher-seed",
      files: [{
        path: requireMetadataText("SKILL.md", "skill.researcher.files[0].path"),
        text: [
          "---",
          "name: researcher",
          "description: Gather evidence, source boundaries, and unresolved assumptions before Hunsu Draft changes.",
          "---",
          "",
          "# Researcher",
          "",
          "Use this seed skill as an installable Hub example based on github:vercel-labs/skills for context gathering and synthesis."
        ].join("\n")
      }]
    }
  };
}

type JsonPrimitive = string | number | boolean | null;
type CanonicalJsonValue = JsonPrimitive | CanonicalJsonValue[] | { [key: string]: CanonicalJsonValue };

export function canonicalizeManifest(manifest: HubPackageManifest | unknown): string {
  assertValidHubPackageManifest(manifest);
  const { integrity: _integrity, ...manifestWithoutIntegrity } = manifest;
  return JSON.stringify(toCanonicalJsonValue(manifestWithoutIntegrity, "manifest"));
}

export function computeManifestIntegrity(manifest: HubPackageManifest | unknown): string {
  const canonical = canonicalizeManifest(manifest);
  return `${MANIFEST_INTEGRITY_PREFIX_V1}${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

export function verifyManifestIntegrity(manifest: HubPackageManifest | unknown, integrity: string): boolean {
  if (!integrity.startsWith(MANIFEST_INTEGRITY_PREFIX_V1)) {
    return false;
  }
  try {
    return computeManifestIntegrity(manifest) === integrity;
  } catch {
    return false;
  }
}

export async function resolveHubPackageManifestFromOrigin(lock: HubPackageLock, options: HttpHubPackageResolverOptions): Promise<ResolvedHubPackageManifest> {
  if (!lock.integrity.startsWith(MANIFEST_INTEGRITY_PREFIX_V1)) {
    throw new Error(`Unsupported Hub package integrity prefix: ${lock.integrity}`);
  }
  const origin = options.origins.find(candidate => candidate.name === lock.origin);
  if (!origin) {
    throw new Error(`Unknown Origin: ${lock.origin}`);
  }
  if (origin.transport !== "http") {
    throw new Error(`Origin ${origin.name} uses unsupported transport ${origin.transport}`);
  }
  const fetchImpl = options.fetch ?? fetch;
  const response = await fetchImpl(hubPackageManifestUrl(origin.url, lock.kind, lock.key, lock.version));
  if (!response.ok) {
    if (response.status === 404) {
      throw new Error(`Missing Hub package manifest: ${lock.origin}/${lock.kind}/${lock.key}@${lock.version}`);
    }
    throw new Error(`Origin ${origin.name} returned ${response.status} for ${lock.kind}/${lock.key}@${lock.version}`);
  }
  const parsed = await response.json() as unknown;
  assertValidHubPackageManifest(parsed);
  if (parsed.kind !== lock.kind || parsed.key !== lock.key || parsed.version !== lock.version) {
    throw new Error(`Hub package manifest from ${origin.name} does not match requested ${lock.kind}/${lock.key}@${lock.version}`);
  }
  const integrity = computeManifestIntegrity(parsed);
  if (integrity !== lock.integrity) {
    throw new Error(`Hub package integrity mismatch for ${lock.origin}/${lock.kind}/${lock.key}@${lock.version}: expected ${lock.integrity}, got ${integrity}`);
  }
  return { lock: { ...lock }, manifest: parsed, integrity, origin: { ...origin } };
}

export function hubPackageManifestUrl(originUrl: string, kind: HubPackageKind, key: string, version: string): string {
  const base = new URL(originUrl);
  const path = `/v1/packages/${kind}/${encodeURIComponent(key)}/versions/${encodeURIComponent(version)}`;
  return new URL(path, base).toString();
}

export function hubPackageEntityRef(origin: string, key: string): string {
  return `@${origin}/${key}`;
}

export function hubPackageVersionRef(origin: string, key: string, version: string): string {
  return `${hubPackageEntityRef(origin, key)}@${version}`;
}

export function hubPackageHumanUrl(originUrl: string, lock: HubPackageLock): string {
  const base = new URL(originUrl);
  const path = `/hub/${marketplaceIdForPackageKind(lock.kind)}/${lock.kind}/@${encodeURIComponent(lock.origin)}/${encodeURIComponent(lock.key)}/versions/${encodeURIComponent(lock.version)}`;
  return new URL(path, base).toString();
}

export function parseHubPackageRefFromUrl(rawUrl: string): HubPackageRef {
  const url = new URL(rawUrl, "https://hub.local");
  const match = url.pathname.match(/^\/hub\/(executor|hunsu|resources)\/(team|member|manager|skill)\/@([^/]+)\/([^/]+)\/versions\/([^/]+)$/);
  if (!match) {
    throw new Error("Hub package URL must use /hub/:marketplace/:kind/@:origin/:key/versions/:version");
  }
  const marketplaceId = match[1];
  const kind = match[2] as HubPackageKind;
  if (marketplaceId !== marketplaceIdForPackageKind(kind)) {
    throw new Error(`Hub package URL marketplace ${marketplaceId} does not match ${kind}`);
  }
  return {
    origin: requireMetadataText(decodeURIComponent(match[3] ?? ""), "ref.origin"),
    kind,
    key: requireMetadataText(decodeURIComponent(match[4] ?? ""), "ref.key"),
    version: requireMetadataText(decodeURIComponent(match[5] ?? ""), "ref.version")
  };
}

function marketplaceIdForPackageKind(kind: HubPackageKind): "executor" | "hunsu" | "resources" {
  if (kind === "manager") return "hunsu";
  if (kind === "skill") return "resources";
  return "executor";
}

function requireMetadataText(value: unknown, field: string): NonEmptyText {
  const result = makeNonEmptyText(value, field);
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.value;
}

export function summarizeHubPackageManifest(manifest: HubPackageManifest, origin: string): HubPackageSummary {
  assertValidHubPackageManifest(manifest);
  const integrity = manifest.integrity ?? computeManifestIntegrity(manifest);
  switch (manifest.kind) {
    case "team": {
      const rootTeam = rootTeamForPackage(manifest.team);
      const resourceCounts = resourceCountsForHarness(manifest.team);
      return {
        origin,
        entryKind: "package",
        kind: manifest.kind,
        key: manifest.key,
        version: manifest.version,
        integrity,
        label: manifest.key,
        sourcePackageKind: manifest.kind,
        sourcePackageKey: manifest.key,
        sourcePackageVersion: manifest.version,
        promptTemplateEngine: rootTeam.planner.promptTemplate.engine,
        memberCount: rootTeam.members.length,
        skillCount: resourceCounts.skill,
        pluginRequirementCount: resourceCounts.plugin
      };
    }
    case "member":
      return {
        origin,
        entryKind: "package",
        kind: manifest.kind,
        key: manifest.key,
        version: manifest.version,
        integrity,
        label: manifest.member.id,
        sourcePackageKind: manifest.kind,
        sourcePackageKey: manifest.key,
        sourcePackageVersion: manifest.version,
        executorId: manifest.member.id,
        promptTemplateEngine: manifest.member.promptTemplate.engine,
        skillCount: manifest.member.skills.length,
        pluginRequirementCount: manifest.member.plugins.length
      };
    case "manager":
      return {
        origin,
        entryKind: "package",
        kind: manifest.kind,
        key: manifest.key,
        version: manifest.version,
        integrity,
        label: manifest.manager.id,
        sourcePackageKind: manifest.kind,
        sourcePackageKey: manifest.key,
        sourcePackageVersion: manifest.version,
        promptTemplateEngine: manifest.manager.promptTemplate.engine,
        skillCount: manifest.manager.skills.length,
        pluginRequirementCount: manifest.manager.plugins.length
      };
    case "skill":
      return {
        origin,
        entryKind: "package",
        kind: manifest.kind,
        key: manifest.key,
        version: manifest.version,
        integrity,
        label: manifest.skill.name,
        sourcePackageKind: manifest.kind,
        sourcePackageKey: manifest.key,
        sourcePackageVersion: manifest.version
      };
  }
}

export function hydrateTeamPackage(manifest: HubPackageManifest): Harness {
  assertValidHubPackageManifest(manifest);
  if (manifest.kind !== "team") {
    throw new Error(`Hub package ${manifest.kind}/${manifest.key}@${manifest.version} is not a team package`);
  }
  return cloneJson(manifest.team) as Harness;
}

export function assertValidHubPackageManifest(manifest: unknown): asserts manifest is HubPackageManifest {
  const record = requireRecord(manifest, "manifest");
  if (record.schema !== HUB_PACKAGE_MANIFEST_SCHEMA) {
    throw new Error(`Unsupported Hub package manifest schema: ${String(record.schema)}`);
  }
  requireExactKeys(record, ["integrity", "key", "kind", "team", "member", "manager", "schema", "skill", "version"], "manifest");
  const kind = requireHubPackageKind(record.kind, "manifest.kind");
  requireNonEmptyString(record.key, "manifest.key");
  requireNonEmptyString(record.version, "manifest.version");
  if (record.integrity !== undefined) {
    requireNonEmptyString(record.integrity, "manifest.integrity");
  }
  switch (kind) {
    case "team":
      assertValidTeamPayload(record.team);
      if (record.member !== undefined || record.manager !== undefined || record.skill !== undefined) {
        throw new Error("Team package manifest must not include member, manager, or skill payloads");
      }
      return;
    case "member":
      assertValidMemberPayload(record.member);
      if (record.team !== undefined || record.manager !== undefined || record.skill !== undefined) {
        throw new Error("Member package manifest must not include team, manager, or skill payloads");
      }
      return;
    case "manager":
      assertValidManagerPayload(record.manager);
      if (record.team !== undefined || record.member !== undefined || record.skill !== undefined) {
        throw new Error("Manager package manifest must not include team, member, or skill payloads");
      }
      return;
    case "skill":
      assertValidSkillPayload(record.skill);
      if (record.team !== undefined || record.member !== undefined || record.manager !== undefined) {
        throw new Error("Skill package manifest must not include team, member, or manager payloads");
      }
      return;
  }
}

function assertValidTeamPayload(value: unknown): void {
  const graph = validateHarnessEntity(value, "manifest.team");
  if (!graph.ok) {
    throw new Error(`Invalid manifest.team: ${graph.error.message}`);
  }
}

function assertValidMemberPayload(value: unknown): void {
  const member = validateMemberConfig(value, "manifest.member");
  if (!member.ok) {
    throw new Error(`Invalid manifest.member: ${member.error.message}`);
  }
}

function assertValidManagerPayload(value: unknown): void {
  const manager = validateManagerConfig(value, "manifest.manager");
  if (!manager.ok) {
    throw new Error(`Invalid manifest.manager: ${manager.error.message}`);
  }
}

function assertValidSkillPayload(value: unknown): void {
  const record = requireRecord(value, "manifest.skill");
  requireExactKeys(record, ["contentHash", "files", "name"], "manifest.skill");
  requireNonEmptyString(record.name, "manifest.skill.name");
  requireNonEmptyString(record.contentHash, "manifest.skill.contentHash");
  if (record.files !== undefined) {
    if (!Array.isArray(record.files)) {
      throw new Error("manifest.skill.files must be an array");
    }
    for (const [index, file] of record.files.entries()) {
      const item = requireRecord(file, `manifest.skill.files[${index}]`);
      requireExactKeys(item, ["path", "text"], `manifest.skill.files[${index}]`);
      requireNonEmptyString(item.path, `manifest.skill.files[${index}].path`);
      requireString(item.text, `manifest.skill.files[${index}].text`);
    }
  }
}

function rootTeamForPackage(team: Harness): Extract<Harness["executors"][number], { kind: "team" }> {
  const rootTeam = team.executors.find((executor): executor is Extract<Harness["executors"][number], { kind: "team" }> => executor.kind === "team" && executor.id === team.rootTeamId);
  if (!rootTeam) {
    throw new Error(`Team package rootTeamId ${team.rootTeamId} does not reference a Team Executor`);
  }
  return rootTeam;
}

function resourceCountsForHarness(harness: Harness): { skill: number; plugin: number } {
  const identities = new Set<string>();
  for (const resource of harness.resources) {
    identities.add(resourceIdentity(resource.binding));
  }
  for (const executor of harness.executors) {
    if (executor.kind !== "member") {
      continue;
    }
    for (const binding of executor.resources) {
      identities.add(resourceIdentity(binding));
    }
  }
  let skill = 0;
  let plugin = 0;
  for (const identity of identities) {
    if (identity.startsWith("skill:")) skill += 1;
    if (identity.startsWith("plugin:")) plugin += 1;
  }
  return { skill, plugin };
}

function resourceIdentity(binding: Harness["resources"][number]["binding"]): string {
  if (binding.kind === "skill") {
    return `skill:${binding.skill.name}`;
  }
  if (binding.kind === "plugin") {
    return `plugin:${binding.plugin.id}`;
  }
  return `package:${binding.lock.kind}:${binding.lock.key}:${binding.lock.version}`;
}

function requireHubPackageKind(value: unknown, path: string): HubPackageKind {
  if (value === "team" || value === "member" || value === "manager" || value === "skill") {
    return value;
  }
  throw new Error(`${path} must be team, member, manager, or skill`);
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireExactKeys(record: Record<string, unknown>, allowedKeys: string[], path: string): void {
  const missing = allowedKeys.filter(key => key !== "integrity" && key !== "team" && key !== "member" && key !== "manager" && key !== "skill" && key !== "files" && !(key in record));
  if (missing.length > 0) {
    throw new Error(`${path} is missing required keys: ${missing.join(", ")}`);
  }
  const extra = Object.keys(record).filter(key => !allowedKeys.includes(key));
  if (extra.length > 0) {
    throw new Error(`${path} has unsupported keys: ${extra.join(", ")}`);
  }
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== "string") {
    throw new Error(`${path} must be a string`);
  }
  return value;
}

function requireNonEmptyString(value: unknown, path: string): string {
  const text = requireString(value, path);
  if (text.trim().length === 0) {
    throw new Error(`${path} must be non-empty`);
  }
  return text;
}

function toCanonicalJsonValue(value: unknown, path: string): CanonicalJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`${path} must be a finite number`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => {
      if (item === undefined) {
        throw new Error(`${path}[${index}] must not be undefined`);
      }
      return toCanonicalJsonValue(item, `${path}[${index}]`);
    });
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const canonical: { [key: string]: CanonicalJsonValue } = {};
    for (const key of Object.keys(record).sort()) {
      const child = record[key];
      if (child === undefined) {
        continue;
      }
      canonical[key] = toCanonicalJsonValue(child, `${path}.${key}`);
    }
    return canonical;
  }
  throw new Error(`${path} must be JSON-serializable`);
}

function cloneJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}
