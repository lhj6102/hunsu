import assert from "node:assert/strict";
import test from "node:test";
import {
  hubMarketplaceSections,
  hubMarketplacePath,
  hubPackageDetailPath,
  hubResourceDetailPath,
  parseHubPath,
  kindLabel,
  packagesForMarketplace,
  resourcesForMarketplace,
  type HubPackageSummary,
  type HubResourceSummary
} from "../apps/web/src/features/hub/hubMarketplace.ts";
import { parseStudioRoute } from "../apps/web/src/app/routes.ts";

test("Hub marketplace model groups Executors, Managers, and independent Skills & Plugins", () => {
  assert.deepEqual(hubMarketplaceSections.map(section => section.label), [
    "Executor Marketplace",
    "Hunsu Marketplace",
    "Skills & Plugins"
  ]);
  assert.deepEqual(hubMarketplaceSections.find(section => section.id === "executor")?.kinds, ["team", "member"]);
  assert.deepEqual(hubMarketplaceSections.find(section => section.id === "hunsu")?.kinds, ["manager"]);
  assert.deepEqual(hubMarketplaceSections.find(section => section.id === "resources")?.kinds, ["skill"]);
});

test("Hub marketplace filters Manager cards outside Executor listings", () => {
  const packages: HubPackageSummary[] = [
    packageSummary("team", "team.superloopy.crew"),
    packageSummary("member", "member.reviewer"),
    packageSummary("manager", "manager.idea-helper"),
    packageSummary("skill", "skills.repo-audit")
  ];

  assert.deepEqual(packagesForMarketplace(packages, "executor").map(item => item.kind), ["team", "member"]);
  assert.deepEqual(packagesForMarketplace(packages, "executor", ["member"]).map(item => item.kind), ["member"]);
  assert.deepEqual(packagesForMarketplace(packages, "hunsu").map(item => item.kind), ["manager"]);
  assert.deepEqual(packagesForMarketplace(packages, "resources").map(item => item.kind), ["skill"]);
  assert.equal(kindLabel("manager"), "Manager");
});

test("Hub marketplace exposes Plugin requirements only through Skills & Plugins resources", () => {
  const resources: HubResourceSummary[] = [
    resourceSummary("plugin", "manager:manager.researcher:github@openai-curated"),
    resourceSummary("skill", "manager:manager.researcher:researcher")
  ];

  assert.deepEqual(resourcesForMarketplace(resources, "executor"), []);
  assert.deepEqual(resourcesForMarketplace(resources, "hunsu"), []);
  assert.deepEqual(resourcesForMarketplace(resources, "resources").map(item => item.resourceKind), ["plugin"]);
  assert.deepEqual(resourcesForMarketplace(resources, "resources", ["skill"]), []);
  assert.deepEqual(resourcesForMarketplace(resources, "resources", ["plugin"]).map(item => item.resourceKind), ["plugin"]);
});

test("Hub marketplace URL strategy maps list and detail routes", () => {
  assert.equal(hubMarketplacePath("executor"), "/hub/executor");
  assert.equal(hubMarketplacePath("executor", ["member"]), "/hub/executor?tag=member");
  assert.deepEqual(parseHubPath("/hub"), { marketplaceId: "executor", tags: [] });
  assert.deepEqual(parseHubPath("/hub/executor", "?tag=team&tag=member"), { marketplaceId: "executor", tags: ["team", "member"] });
  assert.deepEqual(parseHubPath("/hub/hunsu", "?tag=manager"), { marketplaceId: "hunsu", tags: ["manager"] });
  assert.deepEqual(parseHubPath("/hub/resources", "?tag=skill"), { marketplaceId: "resources", tags: ["skill"] });
  assert.deepEqual(parseHubPath("/hub/executor/team/@motorhome/team.superloopy.crew/versions/1.0.2"), {
    marketplaceId: "executor",
    tags: [],
    detail: {
      origin: "motorhome",
      kind: "team",
      key: "team.superloopy.crew",
      version: "1.0.2"
    }
  });
  assert.deepEqual(parseHubPath("/hub/executor/member/@motorhome/team.superloopy.crew/executors/build/versions/1.0.2", "?tag=member"), {
    marketplaceId: "executor",
    tags: ["member"],
    detail: {
      origin: "motorhome",
      kind: "member",
      key: "team.superloopy.crew",
      executorId: "build",
      version: "1.0.2"
    }
  });
  const pluginRequirement = resourceSummary("plugin", "manager:manager.researcher:github@openai-curated");
  assert.equal(
    hubResourceDetailPath(pluginRequirement),
    "/hub/resources/plugin/manager/@motorhome/manager.researcher/resources/manager%3Amanager.researcher%3Agithub%40openai-curated/versions/1.0.0"
  );
  assert.deepEqual(parseHubPath(hubResourceDetailPath(pluginRequirement), "?tag=plugin"), {
    marketplaceId: "resources",
    tags: ["plugin"],
    resourceDetail: {
      origin: "motorhome",
      resourceKind: "plugin",
      resourceKey: "manager:manager.researcher:github@openai-curated",
      packageKind: "manager",
      packageKey: "manager.researcher",
      version: "1.0.0"
    }
  });
  assert.equal(hubPackageDetailPath(packageSummary("manager", "manager.researcher")), "/hub/hunsu/manager/@motorhome/manager.researcher/versions/1.0.0");
  assert.deepEqual(parseStudioRoute({ pathname: "/hub/hunsu", search: "?tag=manager" } as Location), { kind: "hub" });
});


function packageSummary(kind: HubPackageSummary["kind"], key: string): HubPackageSummary {
  return {
    origin: "motorhome",
    entryKind: "package",
    kind,
    key,
    version: "1.0.0",
    integrity: "hunsu-json-c14n-v1+sha256:0000000000000000000000000000000000000000000000000000000000000000",
    label: key,
    sourcePackageKind: kind,
    sourcePackageKey: key,
    sourcePackageVersion: "1.0.0"
  };
}

function resourceSummary(resourceKind: HubResourceSummary["resourceKind"], resourceKey: string): HubResourceSummary {
  return {
    origin: "motorhome",
    resourceKind,
    resourceKey,
    title: resourceKey.split(":").at(-1) ?? resourceKey,
    packageKind: "manager",
    packageKey: "manager.researcher",
    version: "1.0.0"
  };
}
