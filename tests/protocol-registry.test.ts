import assert from "node:assert/strict";
import test from "node:test";
import { createDefaultHarness, createDefaultManagerConfig, createDefaultMemberConfig, harnessEntityFromSnapshot, renderPromptTemplate, rootHarnessSnapshot, promptTemplateFromText, type Harness, type HubPackageLock, type HunsuOrigin, type NonEmptyText } from "../packages/protocol/src/index.ts";
import {
  HUB_PACKAGE_MANIFEST_SCHEMA,
  MANIFEST_INTEGRITY_PREFIX_V1,
  assertValidHubPackageManifest,
  canonicalizeManifest,
  computeManifestIntegrity,
  hydrateTeamPackage,
  hubSeedPackageManifests,
  hubPackageHumanUrl,
  hubPackageVersionRef,
  parseHubPackageRefFromUrl,
  resolveHubPackageManifestFromOrigin,
  summarizeHubPackageManifest,
  verifyManifestIntegrity,
  type HubPackageManifest,
  type TeamPackageManifest
} from "../packages/protocol-registry/src/index.ts";

test("hub package registry computes deterministic manifest integrity", () => {
  const manifest = createTeamManifest();
  const first = computeManifestIntegrity(manifest);
  const second = computeManifestIntegrity(JSON.parse(JSON.stringify(manifest)));

  assert.equal(first.startsWith(MANIFEST_INTEGRITY_PREFIX_V1), true);
  assert.match(first.slice(MANIFEST_INTEGRITY_PREFIX_V1.length), /^[0-9a-f]{64}$/);
  assert.equal(first, second);
  assert.equal(verifyManifestIntegrity(manifest, first), true);
});

test("hub package canonicalization is stable across object key order", () => {
  const manifest = createTeamManifest();
  const reordered = {
    team: manifest.team,
    version: manifest.version,
    key: manifest.key,
    kind: manifest.kind,
    schema: manifest.schema
  };

  assert.equal(canonicalizeManifest(manifest), canonicalizeManifest(reordered));
  assert.equal(computeManifestIntegrity(manifest), computeManifestIntegrity(reordered));
});

test("hub package registry excludes only top-level manifest integrity from the hash", () => {
  const manifest = createTeamManifest();
  const withTopLevelIntegrity = {
    ...manifest,
    integrity: "hunsu-json-c14n-v1+sha256:ignored"
  };
  const changedNestedIntegrity = createTeamManifest({
    team: harnessEntityFromSnapshot(createDefaultHarness("Implement."))
  });

  assert.equal(computeManifestIntegrity(manifest), computeManifestIntegrity(withTopLevelIntegrity));
  assert.notEqual(computeManifestIntegrity(manifest), computeManifestIntegrity(changedNestedIntegrity));
});

test("hub package registry validates team, member, manager, and skill packages", () => {
  assert.doesNotThrow(() => assertValidHubPackageManifest(createTeamManifest()));
  assert.doesNotThrow(() => assertValidHubPackageManifest({
    schema: HUB_PACKAGE_MANIFEST_SCHEMA,
    kind: "member",
    key: "members.reviewer",
    version: "1.0.0",
    member: createDefaultMemberConfig("reviewer", "Review with care.")
  }));
  assert.doesNotThrow(() => assertValidHubPackageManifest({
    schema: HUB_PACKAGE_MANIFEST_SCHEMA,
    kind: "manager",
    key: "manager.idea-helper",
    version: "1.0.0",
    manager: createDefaultManagerConfig("manager.idea-helper", "Explore divergent Hunsu changes.")
  }));
  assert.doesNotThrow(() => assertValidHubPackageManifest({
    schema: HUB_PACKAGE_MANIFEST_SCHEMA,
    kind: "skill",
    key: "skills.repo-audit",
    version: "1.0.0",
    skill: {
      name: "repo-audit",
      contentHash: "sha256:repo-audit",
      files: [{ path: "SKILL.md", text: "# Repo Audit\n" }]
    }
  }));
});

test("hub package registry rejects old planner, persona, and plugin package shapes", () => {
  for (const kind of ["planner", "persona", "plugin"] as const) {
    assert.throws(() => assertValidHubPackageManifest({
      schema: HUB_PACKAGE_MANIFEST_SCHEMA,
      kind,
      key: `${kind}.legacy`,
      version: "1.0.0"
    }), /manifest\.kind must be team, member, manager, or skill/);
  }

  assert.throws(() => assertValidHubPackageManifest({
    schema: HUB_PACKAGE_MANIFEST_SCHEMA,
    kind: "team",
    key: "planner.legacy",
    version: "1.0.0",
    planner: { harness: createDefaultHarness("legacy") }
  }), /unsupported keys: planner/);

  assert.throws(() => assertValidHubPackageManifest({
    schema: HUB_PACKAGE_MANIFEST_SCHEMA,
    kind: "member",
    key: "persona.legacy",
    version: "1.0.0",
    persona: createDefaultMemberConfig("legacy", "legacy")
  }), /unsupported keys: persona/);

  assert.throws(() => assertValidHubPackageManifest({
    schema: HUB_PACKAGE_MANIFEST_SCHEMA,
    kind: "skill",
    key: "plugin.legacy",
    version: "1.0.0",
    plugin: { id: "github" }
  }), /unsupported keys: plugin/);
});

test("hub package registry exposes Team and Manager seed package examples", () => {
  const seeds = hubSeedPackageManifests();
  const keys = seeds.map(seed => seed.key).sort();

  assert.deepEqual(keys, [
    "manager.hunsu.default",
    "manager.idea-helper",
    "manager.researcher",
    "skill.researcher",
    "team.skills-curation",
    "team.superloopy.crew"
  ]);
  for (const seed of seeds) {
    assert.doesNotThrow(() => assertValidHubPackageManifest(seed));
    assert.equal(computeManifestIntegrity(seed).startsWith(MANIFEST_INTEGRITY_PREFIX_V1), true);
  }
  assert.deepEqual(seeds.map(seed => seed.kind).sort(), ["manager", "manager", "manager", "skill", "team", "team"]);
  const skillsCuration = seeds.find(seed => seed.key === "team.skills-curation");
  assert.equal(skillsCuration?.kind, "team");
  const discover = skillsCuration?.kind === "team" ? skillsCuration.team.executors.find(executor => executor.kind === "member" && executor.id === "discover") : undefined;
  const firstSkill = discover?.kind === "member" && discover.resources[0]?.kind === "skill" ? discover.resources[0].skill : undefined;
  assert.equal(firstSkill?.kind, "skillMeta");
  assert.equal(firstSkill?.kind === "skillMeta" ? firstSkill.source : undefined, "github:vercel-labs/skills");
  const researcher = seeds.find(seed => seed.key === "manager.researcher");
  assert.equal(researcher?.kind, "manager");
  const managerSkill = researcher?.kind === "manager" ? researcher.manager.skills[0] : undefined;
  assert.equal(managerSkill?.kind, "skillMeta");
  assert.equal(managerSkill?.kind === "skillMeta" ? managerSkill.source : undefined, "github:vercel-labs/skills");
  const skill = seeds.find(seed => seed.key === "skill.researcher");
  assert.equal(skill?.kind, "skill");
  assert.equal(skill?.kind === "skill" ? skill.skill.name : undefined, "researcher");
});

test("hub package registry summarizes manager resources and integrity", () => {
  const manifest = {
    schema: HUB_PACKAGE_MANIFEST_SCHEMA,
    kind: "manager" as const,
    key: "manager.researcher",
    version: "1.0.0",
    manager: createDefaultManagerConfig("manager.researcher", "Research before editing.", [{
      kind: "skillMeta",
      name: "researcher" as NonEmptyText,
      source: "github:vercel-labs/skills" as NonEmptyText,
      agent: "codex"
    }], [{ kind: "local-root-installed", id: "github@openai-curated" }])
  };
  const summary = summarizeHubPackageManifest(manifest, "motorhome");

  assert.equal(summary.kind, "manager");
  assert.equal(summary.label, "manager.researcher");
  assert.equal(summary.promptTemplateEngine, "hunsu-template-v1");
  assert.equal(summary.skillCount, 1);
  assert.equal(summary.pluginRequirementCount, 1);
  assert.equal(summary.integrity, computeManifestIntegrity(manifest));
});

test("hub package registry rejects old Harness-only manifests", () => {
  const oldManifest = {
    schema: "hunsu.executing-protocol-manifest.v2",
    key: "codex.execution-plan.webapp",
    version: "1.0.0",
    harness: createDefaultHarness("legacy"),
    skills: []
  };

  assert.throws(() => assertValidHubPackageManifest(oldManifest), /Unsupported Hub package manifest schema/);
  assert.throws(() => computeManifestIntegrity(oldManifest), /Unsupported Hub package manifest schema/);
});

test("hub package registry rejects cyclic Team package graphs", () => {
  assert.throws(() => assertValidHubPackageManifest(createTeamManifest({
    team: cyclicTeamGraph()
  })), /cyclic Team Memberships: root-team -> child-team -> root-team/);
});

test("hub package registry fetches Origin manifests, renders protocol templates, and hydrates team skills", async () => {
  const manifest = createTeamManifest({
    team: harnessEntityFromSnapshot(createDefaultHarness("Current: {{ currentDestination.title }}", [
        {
          kind: "registry-package",
          registryKind: "apm",
          name: "ui-inspector" as NonEmptyText,
          registry: "https://apm.example.test" as NonEmptyText,
          package: "@apm/skills/ui-inspector" as NonEmptyText,
          version: "1.2.3" as NonEmptyText,
          integrity: "sha256:ui-inspector-integrity" as NonEmptyText,
          contentHash: "sha256:ui-inspector" as NonEmptyText
        },
        {
          kind: "skillMeta",
          name: "web-design-guidelines" as NonEmptyText,
          source: "vercel-labs/agent-skills" as NonEmptyText,
          agent: "codex"
        }
      ]))
  });
  const lock = lockForManifest(manifest, "motorhome");
  const origin: HunsuOrigin = {
    name: "motorhome" as NonEmptyText,
    url: "https://hub.example.test" as NonEmptyText,
    transport: "http"
  };
  const resolved = await resolveHubPackageManifestFromOrigin(lock, {
    origins: [origin],
    fetch: async url => new Response(JSON.stringify({ ...manifest, integrity: lock.integrity }), {
      status: String(url).includes("/v1/packages/team/") ? 200 : 404,
      headers: { "content-type": "application/json" }
    })
  });
  const rendered = renderPromptTemplate(resolved.manifest.kind === "team" ? rootHarnessSnapshot(resolved.manifest.team).team.promptTemplate : createDefaultHarness().team.promptTemplate, {
    currentDestination: {
      id: "destination_001",
      requestId: "req_001",
      title: "Registry-backed work",
      source: "initial-execute-team",
      createdBy: "SYSTEM",
      updatedBy: "SYSTEM",
      status: "pending"
    }
  });
  const graph = hydrateTeamPackage(resolved.manifest);
  const protocol = rootHarnessSnapshot(graph);

  assert.equal(resolved.integrity, lock.integrity);
  assert.deepEqual(resolved.origin, origin);
  assert.equal(rendered, "Current: Registry-backed work");
  assert.equal(protocol.kind, "team_execution_plan");
  const azir = protocol.members.find(member => member.id === "azir");
  assert.equal(azir?.skills[0]?.name, "ui-inspector");
  assert.equal(azir?.skills[0]?.kind, "registry-package");
  assert.equal(azir?.skills[1]?.name, "web-design-guidelines");
  assert.equal(azir?.skills[1]?.kind, "skillMeta");
});

test("hub package registry validates member package Skill bindings through protocol domain rules", () => {
  assert.throws(() => assertValidHubPackageManifest({
    schema: HUB_PACKAGE_MANIFEST_SCHEMA,
    kind: "member",
    key: "members.bad-skill",
    version: "1.0.0",
    member: {
      ...createDefaultMemberConfig("bad-skill", "Review with care."),
      skills: [{
        kind: "skillMeta",
        name: "web-design-guidelines",
        source: "vercel-labs/agent-skills",
        skill: "duplicate-selector",
        agent: "codex"
      }]
    }
  }), /unsupported keys: skill/);
});

test("hub package human URLs use provider refs and keep integrity out of the public URL", () => {
  const manifest = createTeamManifest();
  const lock = lockForManifest(manifest, "motorhome");
  const url = hubPackageHumanUrl("https://hub.example.test", lock);

  assert.equal(url, "https://hub.example.test/hub/executor/team/@motorhome/codex.execution-plan.webapp/versions/1.0.0");
  assert.equal(url.includes(lock.integrity), false);
  assert.equal(hubPackageVersionRef(lock.origin, lock.key, lock.version), "@motorhome/codex.execution-plan.webapp@1.0.0");
  assert.deepEqual(parseHubPackageRefFromUrl(url), {
    origin: lock.origin,
    kind: lock.kind,
    key: lock.key,
    version: lock.version
  });
  assert.throws(() => parseHubPackageRefFromUrl("https://hub.example.test/hub/packages/team/codex/versions/1.0.0"), /@\:origin/);
});

test("hub package URL parser supports manager locks", () => {
  const manifest: HubPackageManifest = {
    schema: HUB_PACKAGE_MANIFEST_SCHEMA,
    kind: "manager",
    key: "manager.idea-helper",
    version: "1.0.0",
    manager: createDefaultManagerConfig("manager.idea-helper", "Explore alternatives.")
  };
  const lock = lockForManifest(manifest, "motorhome");
  const url = hubPackageHumanUrl("https://hub.example.test", lock);

  assert.equal(url, "https://hub.example.test/hub/hunsu/manager/@motorhome/manager.idea-helper/versions/1.0.0");
  assert.deepEqual(parseHubPackageRefFromUrl(url), {
    origin: lock.origin,
    kind: lock.kind,
    key: lock.key,
    version: lock.version
  });
});

function createTeamManifest(overrides: Partial<TeamPackageManifest> = {}): TeamPackageManifest {
  return {
    schema: HUB_PACKAGE_MANIFEST_SCHEMA,
    kind: "team",
    key: "codex.execution-plan.webapp",
    version: "1.0.0",
    team: harnessEntityFromSnapshot(createDefaultHarness("Implement the selected Destination.")),
    ...overrides
  };
}

function cyclicTeamGraph(): Harness {
  const graph = harnessEntityFromSnapshot(createDefaultHarness("Cycle."));
  const root = graph.executors.find((executor): executor is Extract<Harness["executors"][number], { kind: "team" }> => executor.kind === "team" && executor.id === graph.rootTeamId);
  assert.ok(root);
  root.members = [{
    executorId: "child-team" as NonEmptyText,
    visibleProfile: {
      kind: "team",
      label: "Child Team" as NonEmptyText,
      summary: "Cycles back to root." as NonEmptyText
    }
  }];
  graph.executors.push({
    kind: "team",
    id: "child-team" as NonEmptyText,
    planner: {
      promptTemplate: promptTemplateFromText("Delegate back to root.")
    },
    members: [{
      executorId: graph.rootTeamId,
      visibleProfile: {
        kind: "team",
        label: "Root Team" as NonEmptyText,
        summary: "Root team." as NonEmptyText
      }
    }]
  });
  return graph;
}

function lockForManifest(manifest: HubPackageManifest, origin: string): HubPackageLock {
  return {
    origin: origin as NonEmptyText,
    kind: manifest.kind,
    key: manifest.key as NonEmptyText,
    version: manifest.version as NonEmptyText,
    integrity: computeManifestIntegrity(manifest) as NonEmptyText
  };
}
