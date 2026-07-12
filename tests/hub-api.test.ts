import assert from "node:assert/strict";
import test from "node:test";
import { createDefaultHarness, createDefaultManagerConfig, harnessEntityFromSnapshot, type NonEmptyText } from "../packages/protocol/src/index.ts";
import { HUB_PACKAGE_MANIFEST_SCHEMA } from "../packages/protocol-registry/src/index.ts";
import { routeHubRequest, type HubApiEnv } from "../apps/hub-api/src/index.ts";

const RELEASE_SHA = "0123456789abcdef0123456789abcdef01234567";

test("Hub API health exposes credential-free deployment identity", async () => {
  const env = createMemoryHubEnv();
  const response = await routeHubRequest(new Request("https://hub.example.test/health"), env);
  const body = await response.json() as any;

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(body, {
    status: "ok",
    service: "hunsu-hub-api",
    target: "preview",
    origin: "motorhome",
    release: RELEASE_SHA
  });
});

test("Hub API publishes, lists, and serves immutable package manifests", async () => {
  const env = createMemoryHubEnv();
  const manifest = {
    schema: HUB_PACKAGE_MANIFEST_SCHEMA,
    kind: "team",
    key: "codex.execution-plan.webapp",
    version: "1.0.0",
    team: harnessEntityFromSnapshot(createDefaultHarness("Plan {{ currentDestination.title }}."))
  };
  const publish = await routeHubRequest(new Request("https://hub.example.test/api/hub/packages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": "Bearer test-token"
    },
    body: JSON.stringify({ manifest, publishedBy: "tester" })
  }), env);
  assert.equal(publish.status, 201);
  const publishedBody = await publish.json() as any;
  assert.equal(publishedBody.summary.origin, "motorhome");
  assert.equal(publishedBody.summary.kind, "team");

  const list = await routeHubRequest(new Request("https://hub.example.test/api/hub/packages"), env);
  const listBody = await list.json() as any;
  assert.equal(list.status, 200);
  assert.equal(listBody.packages.length, 3);
  const teamEntry = listBody.packages.find((item: any) => item.kind === "team" && item.executorId === "root-team");
  const memberEntries = listBody.packages.filter((item: any) => item.kind === "member");
  assert.equal(teamEntry.integrity, publishedBody.summary.integrity);
  assert.equal(teamEntry.memberCount, 2);
  assert.equal(teamEntry.entryKind, "executor");
  assert.equal(teamEntry.sourcePackageKind, "team");
  assert.equal(teamEntry.sourcePackageKey, "codex.execution-plan.webapp");
  assert.deepEqual(memberEntries.map((item: any) => item.executorId).sort(), ["azir", "galio"]);
  assert.deepEqual(memberEntries.map((item: any) => item.memberOf), [["root-team"], ["root-team"]]);
  assert.deepEqual((env as any).__teamEntities.map((entity: any) => entity.executor_id), ["root-team"]);
  assert.deepEqual((env as any).__memberEntities.map((entity: any) => entity.executor_id), ["azir", "galio"]);
  assert.deepEqual((env as any).__teamMembershipEntities.map((entity: any) => [entity.parent_team_executor_id, entity.child_executor_id, entity.child_executor_kind]), [
    ["root-team", "azir", "member"],
    ["root-team", "galio", "member"]
  ]);

  const raw = await routeHubRequest(new Request("https://hub.example.test/v1/packages/team/codex.execution-plan.webapp/versions/1.0.0"), env);
  const rawBody = await raw.json() as any;
  assert.equal(raw.status, 200);
  assert.equal(raw.headers.get("cache-control"), "public, max-age=31536000, immutable");
  assert.equal(rawBody.integrity, publishedBody.summary.integrity);

  const duplicate = await routeHubRequest(new Request("https://hub.example.test/api/hub/packages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": "Bearer test-token"
    },
    body: JSON.stringify({ manifest })
  }), env);
  assert.equal(duplicate.status, 409);
});

test("Hub API publishes Manager packages and persists Manager resources", async () => {
  const env = createMemoryHubEnv();
  const manifest = {
    schema: HUB_PACKAGE_MANIFEST_SCHEMA,
    kind: "manager",
    key: "manager.researcher",
    version: "1.0.0",
    manager: createDefaultManagerConfig("manager.researcher", "Research before editing Hunsu Draft files.", [{
      kind: "skillMeta",
      name: "researcher" as NonEmptyText,
      source: "github:vercel-labs/skills" as NonEmptyText,
      agent: "codex"
    }], [{ kind: "local-root-installed", id: "github@openai-curated" }])
  };
  const publish = await routeHubRequest(new Request("https://hub.example.test/api/hub/packages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": "Bearer test-token"
    },
    body: JSON.stringify({ manifest, publishedBy: "tester" })
  }), env);
  const publishedBody = await publish.json() as any;

  assert.equal(publish.status, 201);
  assert.equal(publishedBody.summary.kind, "manager");
  assert.equal(publishedBody.summary.skillCount, 1);
  assert.equal(publishedBody.summary.pluginRequirementCount, 1);
  assert.deepEqual((env as any).__managerEntities.map((entity: any) => entity.manager_id), ["manager.researcher"]);
  assert.deepEqual((env as any).__resourceEntities.map((entity: any) => [entity.resource_kind, entity.resource_key]).sort(), [
    ["plugin", "manager:manager.researcher:github@openai-curated"],
    ["skill", "manager:manager.researcher:researcher"]
  ]);
  const resources = await routeHubRequest(new Request("https://hub.example.test/api/hub/resources"), env);
  const resourcesBody = await resources.json() as any;
  assert.equal(resources.status, 200);
  assert.deepEqual(resourcesBody.resources.map((resource: any) => [resource.resourceKind, resource.resourceKey]).sort(), [
    ["plugin", "manager:manager.researcher:github@openai-curated"],
    ["skill", "manager:manager.researcher:researcher"]
  ]);

  const raw = await routeHubRequest(new Request("https://hub.example.test/v1/packages/manager/manager.researcher/versions/1.0.0"), env);
  const rawBody = await raw.json() as any;
  assert.equal(raw.status, 200);
  assert.equal(rawBody.kind, "manager");
  assert.equal(rawBody.integrity, publishedBody.summary.integrity);
});

test("Hub API write endpoints require admin token", async () => {
  const env = createMemoryHubEnv();
  const response = await routeHubRequest(new Request("https://hub.example.test/api/hub/packages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({})
  }), env);

  assert.equal(response.status, 401);
});

test("Hub API write endpoints fail closed when admin secret is missing", async () => {
  const env = createMemoryHubEnv();
  delete env.HUNSU_HUB_ADMIN_TOKEN;

  const response = await routeHubRequest(new Request("https://hub.example.test/api/hub/packages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({})
  }), env);

  assert.equal(response.status, 503);
});

test("Hub API runtime fails closed when origin config is missing", async () => {
  const env = createMemoryHubEnv();
  delete env.HUNSU_HUB_ORIGIN_NAME;

  const response = await routeHubRequest(new Request("https://hub.example.test/api/hub/packages"), env);
  const body = await response.json() as any;

  assert.equal(response.status, 500);
  assert.match(body.error, /HUNSU_HUB_ORIGIN_NAME/);
});

function createMemoryHubEnv(): HubApiEnv {
  const packages = new Map<string, any>();
  const versions = new Map<string, any>();
  const teamEntities = new Map<string, any>();
  const memberEntities = new Map<string, any>();
  const teamMembershipEntities = new Map<string, any>();
  const managerEntities = new Map<string, any>();
  const resourceEntities = new Map<string, any>();
  const r2 = new Map<string, string>();
  const db = {
    prepare(query: string) {
      let values: unknown[] = [];
      const statement = {
        bind(...nextValues: unknown[]) {
          values = nextValues;
          return statement;
        },
        async first<T>() {
          if (query.includes("SELECT v.id")) {
            const [kind, key, version] = values;
            const pkg = packages.get(`${kind}:${key}`);
            const row = pkg ? versions.get(`${pkg.id}@${version}`) : undefined;
            return row ? { id: row.id } as T : null;
          }
          if (query.includes("SELECT v.manifest_r2_key")) {
            const [kind, key, version] = values;
            const pkg = packages.get(`${kind}:${key}`);
            const row = pkg ? versions.get(`${pkg.id}@${version}`) : undefined;
            return row ? { manifest_r2_key: row.manifest_r2_key } as T : null;
          }
          return null;
        },
        async all<T>() {
          if (query.includes("hub:list-package-versions")) {
            const rows = [...versions.values()].filter(version => version.status === "published").map(version => {
              const pkg = packages.get(version.package_id);
              return {
                package_id: pkg.id,
                version_id: version.id,
                kind: pkg.kind,
                key: pkg.key,
                version: version.version,
                integrity: version.integrity,
                title: pkg.title,
                manifest_r2_key: version.manifest_r2_key
              };
            }) as T[];
            return { results: rows, success: true };
          }
          if (query.includes("hub:list-executor-entities")) {
            const teamRows = [...teamEntities.values()].map(entity => {
              const pkg = packages.get(entity.package_id);
              const version = versions.get(entity.latest_package_version_id);
              return {
                entity_kind: "team",
                package_id: entity.package_id,
                latest_package_version_id: entity.latest_package_version_id,
                package_kind: pkg.kind,
                package_key: pkg.key,
                version: version.version,
                integrity: version.integrity,
                manifest_r2_key: version.manifest_r2_key,
                executor_id: entity.executor_id,
                title: entity.title
              };
            });
            const memberRows = [...memberEntities.values()].map(entity => {
              const pkg = packages.get(entity.package_id);
              const version = versions.get(entity.latest_package_version_id);
              return {
                entity_kind: "member",
                package_id: entity.package_id,
                latest_package_version_id: entity.latest_package_version_id,
                package_kind: pkg.kind,
                package_key: pkg.key,
                version: version.version,
                integrity: version.integrity,
                manifest_r2_key: version.manifest_r2_key,
                executor_id: entity.executor_id,
                title: entity.title
              };
            });
            return { results: [...teamRows, ...memberRows] as T[], success: true };
          }
          if (query.includes("hub:list-team-memberships")) {
            return { results: [...teamMembershipEntities.values()] as T[], success: true };
          }
          if (query.includes("hub:list-resource-entities-for-packages")) {
            const rows = [...resourceEntities.values()].map(resource => {
              const pkg = packages.get(resource.package_id);
              const version = versions.get(resource.latest_package_version_id);
              return {
                package_id: resource.package_id,
                latest_package_version_id: resource.latest_package_version_id,
                resource_kind: resource.resource_kind,
                resource_key: resource.resource_key,
                title: resource.title,
                package_kind: pkg.kind,
                package_key: pkg.key,
                version: version.version
              };
            }) as T[];
            return { results: rows, success: true };
          }
          if (query.includes("FROM resource_entities")) {
            const rows = [...resourceEntities.values()].map(resource => {
              const pkg = packages.get(resource.package_id);
              const version = versions.get(resource.latest_package_version_id);
              return {
                resource_kind: resource.resource_kind,
                resource_key: resource.resource_key,
                title: resource.title,
                package_kind: pkg.kind,
                package_key: pkg.key,
                version: version.version
              };
            }) as T[];
            return { results: rows, success: true };
          }
          const rows = [...versions.values()].map(version => {
            const pkg = packages.get(version.package_id);
            return {
              kind: pkg.kind,
              key: pkg.key,
              version: version.version,
              integrity: version.integrity,
              title: pkg.title,
              manifest_r2_key: version.manifest_r2_key
            };
          }) as T[];
          return { results: rows, success: true };
        },
        async run() {
          if (query.includes("INSERT INTO packages")) {
            const [id, kind, key, title, created_at, updated_at] = values;
            packages.set(String(id), { id, kind, key, title, created_at, updated_at });
            packages.set(`${kind}:${key}`, { id, kind, key, title, created_at, updated_at });
          }
          if (query.includes("INSERT INTO package_versions")) {
            const [id, package_id, version, integrity, manifest_r2_key, published_at, published_by] = values;
            if (versions.has(String(id))) {
              throw new Error("duplicate version");
            }
            versions.set(String(id), { id, package_id, version, integrity, manifest_r2_key, status: "published", published_at, published_by });
          }
          if (query.includes("INSERT INTO team_entities")) {
            const [id, package_id, latest_package_version_id, executor_id, title, created_at, updated_at] = values;
            teamEntities.set(`${package_id}:${executor_id}`, { id, package_id, latest_package_version_id, executor_id, title, created_at, updated_at });
          }
          if (query.includes("INSERT INTO member_entities")) {
            const [id, package_id, latest_package_version_id, executor_id, title, created_at, updated_at] = values;
            memberEntities.set(`${package_id}:${executor_id}`, { id, package_id, latest_package_version_id, executor_id, title, created_at, updated_at });
          }
          if (query.includes("INSERT INTO manager_entities")) {
            const [id, package_id, latest_package_version_id, manager_id, title, created_at, updated_at] = values;
            managerEntities.set(`${package_id}:${manager_id}`, { id, package_id, latest_package_version_id, manager_id, title, created_at, updated_at });
          }
          if (query.includes("INSERT INTO team_membership_entities")) {
            const [id, package_id, latest_package_version_id, parent_team_executor_id, child_executor_id, child_executor_kind, visible_profile_json, position, created_at, updated_at] = values;
            teamMembershipEntities.set(`${package_id}:${parent_team_executor_id}:${child_executor_id}`, { id, package_id, latest_package_version_id, parent_team_executor_id, child_executor_id, child_executor_kind, visible_profile_json, position, created_at, updated_at });
          }
          if (query.includes("INSERT INTO resource_entities")) {
            const [id, package_id, latest_package_version_id, resource_kind, resource_key, title, created_at, updated_at] = values;
            resourceEntities.set(`${package_id}:${resource_kind}:${resource_key}`, { id, package_id, latest_package_version_id, resource_kind, resource_key, title, created_at, updated_at });
          }
          return { success: true };
        }
      };
      return statement;
    },
    async batch(statements: any[]) {
      for (const statement of statements) {
        await statement.run();
      }
      return statements.map(() => ({ success: true }));
    }
  };
  const env = {
    HUB_DB: db,
    HUB_PACKAGES: {
      async get(key: string) {
        const value = r2.get(key);
        return value === undefined ? null : { text: async () => value };
      },
      async put(key: string, value: string) {
        r2.set(key, value);
      }
    },
    HUNSU_HUB_ORIGIN_NAME: "motorhome",
    HUNSU_DEPLOY_TARGET: "preview",
    HUNSU_RELEASE_SHA: RELEASE_SHA,
    HUNSU_HUB_ADMIN_TOKEN: "test-token"
  } as HubApiEnv;
  Object.defineProperties(env, {
    __teamEntities: { get: () => [...teamEntities.values()] },
    __memberEntities: { get: () => [...memberEntities.values()] },
    __teamMembershipEntities: { get: () => [...teamMembershipEntities.values()] },
    __managerEntities: { get: () => [...managerEntities.values()] },
    __resourceEntities: { get: () => [...resourceEntities.values()] }
  });
  return env;
}
