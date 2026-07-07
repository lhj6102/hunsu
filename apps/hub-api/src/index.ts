import {
  assertValidHubPackageManifest,
  computeManifestIntegrity,
  summarizeHubPackageManifest,
  type HubPackageKind,
  type HubPackageManifest,
  type HubPackageSummary
} from "../../../packages/protocol-registry/src/index.ts";
import {
  resolveHubApiWorkerRuntimeConfig,
  type HubApiWorkerRuntimeConfig,
  type HubApiWorkerRuntimeEnv
} from "@hunsu/config/cloudflare";

type D1Result<T = unknown> = { results?: T[]; success?: boolean; error?: string; meta?: unknown };
type D1PreparedStatement = {
  bind: (...values: unknown[]) => D1PreparedStatement;
  first: <T = unknown>() => Promise<T | null>;
  all: <T = unknown>() => Promise<D1Result<T>>;
  run: () => Promise<D1Result>;
};
type D1Database = {
  prepare: (query: string) => D1PreparedStatement;
  batch?: (statements: D1PreparedStatement[]) => Promise<D1Result[]>;
};
type R2ObjectBody = { text: () => Promise<string> };
type R2Bucket = {
  get: (key: string) => Promise<R2ObjectBody | null>;
  put: (key: string, value: string, options?: { httpMetadata?: Record<string, string> }) => Promise<unknown>;
};
type Queue = { send: (message: unknown) => Promise<void> };

export type HubApiEnv = HubApiWorkerRuntimeEnv & {
  HUB_DB: D1Database;
  HUB_PACKAGES: R2Bucket;
  HUB_PUBLISH_QUEUE?: Queue;
};

type PackageRow = {
  package_id: string;
  version_id: string;
  kind: HubPackageKind;
  key: string;
  version: string;
  integrity: string;
  title: string;
  manifest_r2_key: string;
};

type ExecutorEntityRow = {
  entity_kind: "team" | "member";
  package_id: string;
  latest_package_version_id: string;
  package_kind: HubPackageKind;
  package_key: string;
  version: string;
  integrity: string;
  manifest_r2_key: string;
  executor_id: string;
  title: string;
};

type TeamMembershipRow = {
  package_id: string;
  latest_package_version_id: string;
  parent_team_executor_id: string;
  child_executor_id: string;
  child_executor_kind: "team" | "member";
  visible_profile_json: string;
};

type ResourceRow = {
  package_id?: string;
  latest_package_version_id?: string;
  resource_kind: "skill" | "plugin" | "package";
  resource_key: string;
  title: string;
  package_kind: HubPackageKind;
  package_key: string;
  version: string;
};

export type HubResourceSummary = {
  origin: string;
  resourceKind: "skill" | "plugin" | "package";
  resourceKey: string;
  title: string;
  packageKind: HubPackageKind;
  packageKey: string;
  version: string;
};

type PublishRequest = {
  manifest?: unknown;
  publishedBy?: string;
};

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "authorization,content-type,x-hunsu-admin-token"
};

export default {
  async fetch(request: Request, env: HubApiEnv): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    return routeHubRequest(request, env);
  }
};

export async function routeHubRequest(request: Request, env: HubApiEnv): Promise<Response> {
  try {
    return await handleHubRequest(request, env);
  } catch (error) {
    if (error instanceof ResponseError) {
      return json(error, error.status);
    }
    return json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
}

async function handleHubRequest(request: Request, env: HubApiEnv): Promise<Response> {
  requireHubBindings(env);
  const runtimeConfig = requireRuntimeConfig(env);
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/api/hub/packages") {
    return json({ packages: await listPackages(env, runtimeConfig.originName) });
  }
  if (request.method === "GET" && url.pathname === "/api/hub/resources") {
    return json({ resources: await listResources(env, runtimeConfig.originName) });
  }
  const apiVersion = matchPackageVersionPath(url.pathname, "/api/hub/packages");
  if (request.method === "GET" && apiVersion) {
    const manifest = await readManifest(env, apiVersion.kind, apiVersion.key, apiVersion.version);
    return json({ manifest, summary: summarizeHubPackageManifest(manifest, runtimeConfig.originName) });
  }
  const rawVersion = matchPackageVersionPath(url.pathname, "/v1/packages");
  if (request.method === "GET" && rawVersion) {
    const manifest = await readManifest(env, rawVersion.kind, rawVersion.key, rawVersion.version);
    return json(manifest, 200, {
      "cache-control": "public, max-age=31536000, immutable"
    });
  }
  if (request.method === "POST" && (url.pathname === "/api/hub/packages" || url.pathname.match(/^\/api\/hub\/packages\/[^/]+\/[^/]+\/versions$/))) {
    requireAdmin(request, runtimeConfig);
    const body = await request.json() as PublishRequest;
    const manifest = body.manifest ?? body;
    return json(await publishManifest(env, runtimeConfig.originName, manifest, body.publishedBy), 201);
  }
  return json({ error: "Not found" }, 404);
}

async function listPackages(env: HubApiEnv, originName: string): Promise<HubPackageSummary[]> {
  const rows = await env.HUB_DB.prepare(`
    /* hub:list-package-versions */
    SELECT p.id AS package_id, v.id AS version_id, p.kind, p.key, v.version, v.integrity, p.title, v.manifest_r2_key
    FROM packages p
    JOIN package_versions v ON v.package_id = p.id
    WHERE v.status = 'published'
    ORDER BY p.kind ASC, p.key ASC, v.published_at DESC
  `).all<PackageRow>();
  const executorRows = await env.HUB_DB.prepare(`
    /* hub:list-executor-entities */
    SELECT 'team' AS entity_kind, e.package_id, e.latest_package_version_id, p.kind AS package_kind, p.key AS package_key, v.version, v.integrity, v.manifest_r2_key, e.executor_id, e.title
    FROM team_entities e
    JOIN packages p ON p.id = e.package_id
    JOIN package_versions v ON v.id = e.latest_package_version_id
    WHERE v.status = 'published'
    UNION ALL
    SELECT 'member' AS entity_kind, e.package_id, e.latest_package_version_id, p.kind AS package_kind, p.key AS package_key, v.version, v.integrity, v.manifest_r2_key, e.executor_id, e.title
    FROM member_entities e
    JOIN packages p ON p.id = e.package_id
    JOIN package_versions v ON v.id = e.latest_package_version_id
    WHERE v.status = 'published'
    ORDER BY package_key ASC, entity_kind DESC, executor_id ASC
  `).all<ExecutorEntityRow>();
  const membershipRows = await env.HUB_DB.prepare(`
    /* hub:list-team-memberships */
    SELECT m.package_id, m.latest_package_version_id, m.parent_team_executor_id, m.child_executor_id, m.child_executor_kind, m.visible_profile_json
    FROM team_membership_entities m
    JOIN package_versions v ON v.id = m.latest_package_version_id
    WHERE v.status = 'published'
  `).all<TeamMembershipRow>();
  const resourceRows = await env.HUB_DB.prepare(`
    /* hub:list-resource-entities-for-packages */
    SELECT r.package_id, r.latest_package_version_id, r.resource_kind, r.resource_key, r.title, p.kind AS package_kind, p.key AS package_key, v.version
    FROM resource_entities r
    JOIN packages p ON p.id = r.package_id
    JOIN package_versions v ON v.id = r.latest_package_version_id
    WHERE v.status = 'published'
  `).all<ResourceRow>();
  const manifestByVersionId = new Map<string, HubPackageManifest>();
  const manifestForRow = async (row: { version_id: string; manifest_r2_key: string } | { latest_package_version_id: string; manifest_r2_key: string }): Promise<HubPackageManifest> => {
    const versionId = "latest_package_version_id" in row ? row.latest_package_version_id : row.version_id;
    const existing = manifestByVersionId.get(versionId);
    if (existing) {
      return existing;
    }
    const manifest = await readManifestBlob(env, row.manifest_r2_key);
    manifestByVersionId.set(versionId, manifest);
    return manifest;
  };
  const summaries: HubPackageSummary[] = [];
  for (const row of rows.results ?? []) {
    if (row.kind === "team" || row.kind === "member") {
      continue;
    }
    summaries.push(summarizeHubPackageManifest(await manifestForRow(row), originName));
  }
  const memberships = membershipRows.results ?? [];
  const resources = resourceRows.results ?? [];
  for (const row of executorRows.results ?? []) {
    summaries.push(executorSummaryFromEntityRow(row, await manifestForRow(row), memberships, resources, originName));
  }
  return summaries.sort((left, right) => `${left.kind}:${left.sourcePackageKey}:${left.executorId ?? left.key}`.localeCompare(`${right.kind}:${right.sourcePackageKey}:${right.executorId ?? right.key}`));
}

function executorSummaryFromEntityRow(
  row: ExecutorEntityRow,
  manifest: HubPackageManifest,
  memberships: TeamMembershipRow[],
  resources: ResourceRow[],
  originName: string
): HubPackageSummary {
  const executor = manifest.kind === "team"
    ? manifest.team.executors.find(candidate => candidate.kind === row.entity_kind && candidate.id === row.executor_id)
    : manifest.kind === "member" && row.entity_kind === "member" && manifest.member.id === row.executor_id
      ? manifest.member
      : undefined;
  const memberOf = memberships
    .filter(membership => membership.package_id === row.package_id && membership.child_executor_id === row.executor_id)
    .map(membership => membership.parent_team_executor_id)
    .sort();
  const visibleProfile = memberships
    .filter(membership => membership.package_id === row.package_id && membership.child_executor_id === row.executor_id)
    .map(readVisibleProfile)
    .find(Boolean);
  const directMembershipCount = memberships
    .filter(membership => membership.package_id === row.package_id && membership.parent_team_executor_id === row.executor_id)
    .length;
  const memberResourceCounts = resourceCountsForExecutor(row, resources);
  const packageResourceCounts = resourceCountsForPackage(row, resources);
  const isRootTeam = manifest.kind === "team" && row.entity_kind === "team" && manifest.team.rootTeamId === row.executor_id;
  const label = String(visibleProfile?.label ?? (isRootTeam ? row.package_key : row.title));
  return {
    origin: originName,
    entryKind: "executor",
    kind: row.entity_kind,
    key: executorCatalogKey(row.package_key, row.executor_id, isRootTeam && row.package_kind === "team"),
    version: row.version,
    integrity: row.integrity,
    label,
    sourcePackageKind: row.package_kind,
    sourcePackageKey: row.package_key,
    sourcePackageVersion: row.version,
    executorId: row.executor_id,
    memberOf,
    promptTemplateEngine: promptTemplateEngineForExecutor(executor),
    memberCount: row.entity_kind === "team" ? directMembershipCount : undefined,
    skillCount: row.entity_kind === "team" ? packageResourceCounts.skill : memberResourceCounts.skill,
    pluginRequirementCount: row.entity_kind === "team" ? packageResourceCounts.plugin : memberResourceCounts.plugin
  };
}

function executorCatalogKey(packageKey: string, executorId: string, isRootTeam: boolean): string {
  return isRootTeam ? packageKey : `${packageKey}#${executorId}`;
}

function promptTemplateEngineForExecutor(executor: unknown): string | undefined {
  if (!executor || typeof executor !== "object") {
    return undefined;
  }
  const record = executor as { kind?: string; planner?: { promptTemplate?: { engine?: unknown } }; promptTemplate?: { engine?: unknown } };
  if (record.kind === "team" && typeof record.planner?.promptTemplate?.engine === "string") {
    return record.planner.promptTemplate.engine;
  }
  if (typeof record.promptTemplate?.engine === "string") {
    return record.promptTemplate.engine;
  }
  return undefined;
}

function resourceCountsForPackage(row: ExecutorEntityRow, resources: ResourceRow[]): { skill: number; plugin: number } {
  return countResources(resources.filter(resource => resource.package_id === row.package_id));
}

function resourceCountsForExecutor(row: ExecutorEntityRow, resources: ResourceRow[]): { skill: number; plugin: number } {
  const prefix = `member:${row.executor_id}:`;
  return countResources(resources.filter(resource => resource.package_id === row.package_id && resource.resource_key.startsWith(prefix)));
}

function countResources(resources: ResourceRow[]): { skill: number; plugin: number } {
  const skills = new Set<string>();
  const plugins = new Set<string>();
  for (const resource of resources) {
    if (resource.resource_kind === "skill") {
      skills.add(resource.resource_key);
    } else if (resource.resource_kind === "plugin") {
      plugins.add(resource.resource_key);
    }
  }
  return { skill: skills.size, plugin: plugins.size };
}

function readVisibleProfile(row: TeamMembershipRow): { label?: string } | undefined {
  try {
    const parsed = JSON.parse(row.visible_profile_json) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return undefined;
    }
    const label = (parsed as { label?: unknown }).label;
    return typeof label === "string" && label.trim() ? { label } : undefined;
  } catch {
    return undefined;
  }
}

async function listResources(env: HubApiEnv, originName: string): Promise<HubResourceSummary[]> {
  const rows = await env.HUB_DB.prepare(`
    SELECT r.resource_kind, r.resource_key, r.title, p.kind AS package_kind, p.key AS package_key, v.version
    FROM resource_entities r
    JOIN packages p ON p.id = r.package_id
    JOIN package_versions v ON v.id = r.latest_package_version_id
    WHERE v.status = 'published'
    ORDER BY r.resource_kind ASC, r.title ASC, p.key ASC
  `).all<ResourceRow>();
  return (rows.results ?? []).map(row => ({
    origin: originName,
    resourceKind: row.resource_kind,
    resourceKey: row.resource_key,
    title: row.title,
    packageKind: row.package_kind,
    packageKey: row.package_key,
    version: row.version
  }));
}

async function readManifest(env: HubApiEnv, kind: HubPackageKind, key: string, version: string): Promise<HubPackageManifest> {
  const row = await env.HUB_DB.prepare(`
    SELECT v.manifest_r2_key
    FROM packages p
    JOIN package_versions v ON v.package_id = p.id
    WHERE p.kind = ? AND p.key = ? AND v.version = ? AND v.status = 'published'
  `).bind(kind, key, version).first<{ manifest_r2_key: string }>();
  if (!row) {
    throw new ResponseError(`Missing Hub package manifest: ${kind}/${key}@${version}`, 404);
  }
  return readManifestBlob(env, row.manifest_r2_key);
}

async function readManifestBlob(env: HubApiEnv, manifestKey: string): Promise<HubPackageManifest> {
  const object = await env.HUB_PACKAGES.get(manifestKey);
  if (!object) {
    throw new ResponseError(`Missing Hub package blob: ${manifestKey}`, 404);
  }
  const parsed = JSON.parse(await object.text()) as unknown;
  assertValidHubPackageManifest(parsed);
  return parsed;
}

async function publishManifest(env: HubApiEnv, originName: string, input: unknown, publishedBy?: string): Promise<{ summary: HubPackageSummary; manifest: HubPackageManifest }> {
  assertValidHubPackageManifest(input);
  const integrity = computeManifestIntegrity(input);
  const manifest = { ...input, integrity } as HubPackageManifest;
  const now = new Date().toISOString();
  const packageId = packageIdFor(manifest.kind, manifest.key);
  const versionId = `${packageId}@${manifest.version}`;
  const manifestKey = manifestR2Key(manifest.kind, manifest.key, manifest.version);
  const title = packageTitle(manifest);
  const existing = await env.HUB_DB.prepare(`
    SELECT v.id
    FROM packages p
    JOIN package_versions v ON v.package_id = p.id
    WHERE p.kind = ? AND p.key = ? AND v.version = ?
  `).bind(manifest.kind, manifest.key, manifest.version).first<{ id: string }>();
  if (existing) {
    throw new ResponseError(`Hub package version already exists: ${manifest.kind}/${manifest.key}@${manifest.version}`, 409);
  }
  await env.HUB_PACKAGES.put(manifestKey, `${JSON.stringify(manifest, null, 2)}\n`, {
    httpMetadata: { contentType: "application/json" }
  });
  const statements = [
    env.HUB_DB.prepare(`
      INSERT INTO packages (id, kind, key, title, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(kind, key) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at
    `).bind(packageId, manifest.kind, manifest.key, title, now, now),
    env.HUB_DB.prepare(`
      INSERT INTO package_versions (id, package_id, version, integrity, manifest_r2_key, status, published_at, published_by)
      VALUES (?, ?, ?, ?, ?, 'published', ?, ?)
    `).bind(versionId, packageId, manifest.version, integrity, manifestKey, now, publishedBy ?? "admin-token"),
    ...entityStatementsForManifest(env, manifest, packageId, versionId, now),
    env.HUB_DB.prepare(`
      INSERT INTO audit_log (id, actor, action, target_kind, target_id, metadata_json, created_at)
      VALUES (?, ?, 'publish-package-version', 'package_version', ?, ?, ?)
    `).bind(`audit_${versionId}_${Date.now()}`, publishedBy ?? "admin-token", versionId, JSON.stringify({ integrity }), now)
  ];
  if (env.HUB_DB.batch) {
    await env.HUB_DB.batch(statements);
  } else {
    for (const statement of statements) {
      await statement.run();
    }
  }
  await env.HUB_PUBLISH_QUEUE?.send({ type: "package-version-published", kind: manifest.kind, key: manifest.key, version: manifest.version, integrity });
  return { summary: summarizeHubPackageManifest(manifest, originName), manifest };
}

function entityStatementsForManifest(
  env: HubApiEnv,
  manifest: HubPackageManifest,
  packageId: string,
  versionId: string,
  now: string
): D1PreparedStatement[] {
  switch (manifest.kind) {
    case "team": {
      const rootTeamId = manifest.team.rootTeamId;
      return [
        ...manifest.team.executors.filter(executor => executor.kind === "team").map(executor => upsertTeamEntity(env, {
          id: stableEntityId("team", packageId, executor.id),
          packageId,
          versionId,
          executorId: executor.id,
          title: executor.id === rootTeamId ? manifest.key : executor.id,
          now
        })),
        ...manifest.team.executors.filter(executor => executor.kind === "member").map(member => upsertMemberEntity(env, {
          id: stableEntityId("member", packageId, member.id),
          packageId,
          versionId,
          executorId: member.id,
          title: member.id,
          now
        })),
        ...teamMembershipStatementsForHarness(env, manifest.team, packageId, versionId, now),
        ...resourceStatementsForHarness(env, manifest.team, packageId, versionId, now)
      ];
    }
    case "member":
      return [
        upsertMemberEntity(env, {
          id: stableEntityId("member", packageId, manifest.member.id),
          packageId,
          versionId,
          executorId: manifest.member.id,
          title: manifest.member.id,
          now
        }),
        ...resourceStatementsForMember(env, manifest.member.id, manifest.member.skills, manifest.member.plugins, packageId, versionId, now)
      ];
    case "manager":
      return [
        upsertManagerEntity(env, {
          id: stableEntityId("manager", packageId, manifest.manager.id),
          packageId,
          versionId,
          managerId: manifest.manager.id,
          title: manifest.manager.id,
          now
        }),
        ...resourceStatementsForManager(env, manifest, packageId, versionId, now)
      ];
    case "skill":
      return [upsertResourceEntity(env, {
        id: stableEntityId("resource", packageId, `skill:${manifest.skill.name}`),
        packageId,
        versionId,
        resourceKind: "skill",
        resourceKey: manifest.skill.name,
        title: manifest.skill.name,
        now
      })];
  }
}

function resourceStatementsForManager(
  env: HubApiEnv,
  manifest: Extract<HubPackageManifest, { kind: "manager" }>,
  packageId: string,
  versionId: string,
  now: string
): D1PreparedStatement[] {
  return [
    ...manifest.manager.skills.map(skill => upsertResourceEntity(env, {
      id: stableEntityId("resource", packageId, `manager:${manifest.manager.id}:skill:${skill.name}`),
      packageId,
      versionId,
      resourceKind: "skill",
      resourceKey: `manager:${manifest.manager.id}:${skill.name}`,
      title: skill.name,
      now
    })),
    ...manifest.manager.plugins.map(plugin => upsertResourceEntity(env, {
      id: stableEntityId("resource", packageId, `manager:${manifest.manager.id}:plugin:${plugin.id}`),
      packageId,
      versionId,
      resourceKind: "plugin",
      resourceKey: `manager:${manifest.manager.id}:${plugin.id}`,
      title: plugin.id,
      now
    }))
  ];
}

function teamMembershipStatementsForHarness(
  env: HubApiEnv,
  harness: Extract<HubPackageManifest, { kind: "team" }>["team"],
  packageId: string,
  versionId: string,
  now: string
): D1PreparedStatement[] {
  const executorKind = new Map(harness.executors.map(executor => [executor.id, executor.kind] as const));
  return harness.executors.flatMap(executor => {
    if (executor.kind !== "team") {
      return [];
    }
    return executor.members.map((membership, index) => upsertTeamMembershipEntity(env, {
      id: stableEntityId("membership", packageId, `${executor.id}->${membership.executorId}`),
      packageId,
      versionId,
      title: `${executor.id}->${membership.executorId}`,
      parentTeamExecutorId: executor.id,
      childExecutorId: membership.executorId,
      childExecutorKind: executorKind.get(membership.executorId) ?? membership.visibleProfile.kind,
      visibleProfileJson: JSON.stringify(membership.visibleProfile),
      position: index,
      now
    }));
  });
}

function resourceStatementsForHarness(
  env: HubApiEnv,
  harness: Extract<HubPackageManifest, { kind: "team" }>["team"],
  packageId: string,
  versionId: string,
  now: string
): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [];
  const seen = new Set<string>();
  const push = (stableKeyPrefix: string, resourceKeyPrefix: string, binding: Extract<HubPackageManifest, { kind: "team" }>["team"]["resources"][number]["binding"]) => {
    const identity = resourceIdentity(binding);
    if (seen.has(identity)) {
      return;
    }
    seen.add(identity);
    statements.push(resourceStatementForBinding(env, stableKeyPrefix, resourceKeyPrefix, binding, packageId, versionId, now));
  };
  for (const executor of harness.executors) {
    if (executor.kind !== "member") {
      continue;
    }
    for (const binding of executor.resources) {
      push(`member:${executor.id}`, `member:${executor.id}`, binding);
    }
  }
  for (const resource of harness.resources) {
    push(`resource:${resource.id}`, String(resource.id), resource.binding);
  }
  return statements;
}

function resourceStatementsForMember(
  env: HubApiEnv,
  executorId: string,
  skills: Array<{ name: string }>,
  plugins: Array<{ id: string }>,
  packageId: string,
  versionId: string,
  now: string
): D1PreparedStatement[] {
  return [
    ...skills.map(skill => upsertResourceEntity(env, {
      id: stableEntityId("resource", packageId, `member:${executorId}:skill:${skill.name}`),
      packageId,
      versionId,
      resourceKind: "skill",
      resourceKey: `member:${executorId}:${skill.name}`,
      title: skill.name,
      now
    })),
    ...plugins.map(plugin => upsertResourceEntity(env, {
      id: stableEntityId("resource", packageId, `member:${executorId}:plugin:${plugin.id}`),
      packageId,
      versionId,
      resourceKind: "plugin",
      resourceKey: `member:${executorId}:${plugin.id}`,
      title: plugin.id,
      now
    }))
  ];
}

function resourceStatementForBinding(
  env: HubApiEnv,
  stableKeyPrefix: string,
  resourceKeyPrefix: string,
  binding: Extract<HubPackageManifest, { kind: "team" }>["team"]["resources"][number]["binding"],
  packageId: string,
  versionId: string,
  now: string
): D1PreparedStatement {
  if (binding.kind === "skill") {
    return upsertResourceEntity(env, {
      id: stableEntityId("resource", packageId, `${stableKeyPrefix}:skill:${binding.skill.name}`),
      packageId,
      versionId,
      resourceKind: "skill",
      resourceKey: `${resourceKeyPrefix}:${binding.skill.name}`,
      title: binding.skill.name,
      now
    });
  }
  if (binding.kind === "plugin") {
    return upsertResourceEntity(env, {
      id: stableEntityId("resource", packageId, `${stableKeyPrefix}:plugin:${binding.plugin.id}`),
      packageId,
      versionId,
      resourceKind: "plugin",
      resourceKey: `${resourceKeyPrefix}:${binding.plugin.id}`,
      title: binding.plugin.id,
      now
    });
  }
  return upsertResourceEntity(env, {
    id: stableEntityId("resource", packageId, `${stableKeyPrefix}:package:${binding.lock.kind}:${binding.lock.key}:${binding.lock.version}`),
    packageId,
    versionId,
    resourceKind: "package",
    resourceKey: `${resourceKeyPrefix}:${binding.lock.kind}:${binding.lock.key}:${binding.lock.version}`,
    title: `${binding.lock.kind}/${binding.lock.key}@${binding.lock.version}`,
    now
  });
}

function resourceIdentity(binding: Extract<HubPackageManifest, { kind: "team" }>["team"]["resources"][number]["binding"]): string {
  if (binding.kind === "skill") {
    return `skill:${binding.skill.name}`;
  }
  if (binding.kind === "plugin") {
    return `plugin:${binding.plugin.id}`;
  }
  return `package:${binding.lock.kind}:${binding.lock.key}:${binding.lock.version}`;
}

function upsertTeamEntity(env: HubApiEnv, input: EntityStatementInput & { executorId: string }): D1PreparedStatement {
  return env.HUB_DB.prepare(`
    INSERT INTO team_entities (id, package_id, latest_package_version_id, executor_id, title, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(package_id, executor_id) DO UPDATE SET latest_package_version_id = excluded.latest_package_version_id, title = excluded.title, updated_at = excluded.updated_at
  `).bind(input.id, input.packageId, input.versionId, input.executorId, input.title, input.now, input.now);
}

function upsertMemberEntity(env: HubApiEnv, input: EntityStatementInput & { executorId: string }): D1PreparedStatement {
  return env.HUB_DB.prepare(`
    INSERT INTO member_entities (id, package_id, latest_package_version_id, executor_id, title, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(package_id, executor_id) DO UPDATE SET latest_package_version_id = excluded.latest_package_version_id, title = excluded.title, updated_at = excluded.updated_at
  `).bind(input.id, input.packageId, input.versionId, input.executorId, input.title, input.now, input.now);
}

function upsertManagerEntity(env: HubApiEnv, input: EntityStatementInput & { managerId: string }): D1PreparedStatement {
  return env.HUB_DB.prepare(`
    INSERT INTO manager_entities (id, package_id, latest_package_version_id, manager_id, title, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(package_id, manager_id) DO UPDATE SET latest_package_version_id = excluded.latest_package_version_id, title = excluded.title, updated_at = excluded.updated_at
  `).bind(input.id, input.packageId, input.versionId, input.managerId, input.title, input.now, input.now);
}

function upsertTeamMembershipEntity(env: HubApiEnv, input: EntityStatementInput & { parentTeamExecutorId: string; childExecutorId: string; childExecutorKind: "team" | "member"; visibleProfileJson: string; position: number }): D1PreparedStatement {
  return env.HUB_DB.prepare(`
    INSERT INTO team_membership_entities (id, package_id, latest_package_version_id, parent_team_executor_id, child_executor_id, child_executor_kind, visible_profile_json, position, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(package_id, parent_team_executor_id, child_executor_id) DO UPDATE SET latest_package_version_id = excluded.latest_package_version_id, child_executor_kind = excluded.child_executor_kind, visible_profile_json = excluded.visible_profile_json, position = excluded.position, updated_at = excluded.updated_at
  `).bind(input.id, input.packageId, input.versionId, input.parentTeamExecutorId, input.childExecutorId, input.childExecutorKind, input.visibleProfileJson, input.position, input.now, input.now);
}

function upsertResourceEntity(env: HubApiEnv, input: EntityStatementInput & { resourceKind: "skill" | "plugin" | "package"; resourceKey: string }): D1PreparedStatement {
  return env.HUB_DB.prepare(`
    INSERT INTO resource_entities (id, package_id, latest_package_version_id, resource_kind, resource_key, title, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(package_id, resource_kind, resource_key) DO UPDATE SET latest_package_version_id = excluded.latest_package_version_id, title = excluded.title, updated_at = excluded.updated_at
  `).bind(input.id, input.packageId, input.versionId, input.resourceKind, input.resourceKey, input.title, input.now, input.now);
}

type EntityStatementInput = {
  id: string;
  packageId: string;
  versionId: string;
  title: string;
  now: string;
};

function stableEntityId(kind: "team" | "member" | "manager" | "resource" | "membership", packageId: string, key: string): string {
  return `${kind}:${packageId}:${key}`;
}

function requireAdmin(request: Request, config: HubApiWorkerRuntimeConfig): void {
  if (!config.adminToken) {
    throw new ResponseError("Hub write API is not configured", 503);
  }
  const bearer = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  const header = request.headers.get("x-hunsu-admin-token");
  if (bearer !== config.adminToken && header !== config.adminToken) {
    throw new ResponseError("Unauthorized", 401);
  }
}

function requireRuntimeConfig(env: HubApiEnv): HubApiWorkerRuntimeConfig {
  const result = resolveHubApiWorkerRuntimeConfig(env);
  if (!result.ok) {
    throw new ResponseError(result.error.message, 500);
  }
  return result.value;
}

function requireHubBindings(env: HubApiEnv): void {
  if (typeof env.HUB_DB?.prepare !== "function") {
    throw new ResponseError("Cloudflare D1 binding HUB_DB is not configured", 500);
  }
  if (typeof env.HUB_PACKAGES?.get !== "function" || typeof env.HUB_PACKAGES?.put !== "function") {
    throw new ResponseError("Cloudflare R2 binding HUB_PACKAGES is not configured", 500);
  }
}

function matchPackageVersionPath(pathname: string, prefix: string): { kind: HubPackageKind; key: string; version: string } | undefined {
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = pathname.match(new RegExp(`^${escaped}/(team|member|manager|skill)/([^/]+)/versions/([^/]+)$`));
  if (!match) return undefined;
  return {
    kind: match[1] as HubPackageKind,
    key: decodeURIComponent(match[2] ?? ""),
    version: decodeURIComponent(match[3] ?? "")
  };
}

function packageIdFor(kind: HubPackageKind, key: string): string {
  return `${kind}:${key}`;
}

function manifestR2Key(kind: HubPackageKind, key: string, version: string): string {
  return `packages/${kind}/${encodeURIComponent(key)}/versions/${encodeURIComponent(version)}/manifest.json`;
}

function packageTitle(manifest: HubPackageManifest): string {
  if (manifest.kind === "member") return manifest.member.id;
  if (manifest.kind === "manager") return manifest.manager.id;
  if (manifest.kind === "skill") return manifest.skill.name;
  return manifest.key;
}

function json(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  const errorStatus = value instanceof ResponseError ? value.status : status;
  return new Response(`${JSON.stringify(value instanceof ResponseError ? { error: value.message } : value)}\n`, {
    status: errorStatus,
    headers: {
      ...CORS_HEADERS,
      "content-type": "application/json",
      ...headers
    }
  });
}

class ResponseError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}
