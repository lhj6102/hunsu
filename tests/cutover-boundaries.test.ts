import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const retiredTerms = [
  ["road", "map"].join(""),
  ["desti", "nation"].join(""),
  ["mem", "ber"].join(""),
  ["man", "ager"].join(""),
  ["bri", "dge"].join(""),
  ["stu", "dio"].join("")
];

test("the product cutover has one vocabulary and one operating model", () => {
  const searchableRoots = ["apps", "packages", "plugins", "scripts", "tests", "docs"];
  const files = searchableRoots.flatMap(directory => walk(join(root, directory)))
    .concat(["README.md", "AGENTS.md", "CONTRIBUTING.md", "SECURITY.md", "PRIVACY.md", "package.json", "turbo.json"].map(file => join(root, file)))
    .filter(file => !file.endsWith("worker-configuration.d.ts"))
    .filter(isSearchableSource);

  const violations: string[] = [];
  const pattern = new RegExp("\\b(?:" + retiredTerms.join("|") + ")\\b", "iu");
  for (const file of files) {
    if (pattern.test(readFileSync(file, "utf8"))) violations.push(relative(root, file));
  }
  assert.deepEqual(violations, []);

  for (const removed of [
    ["apps", ["bri", "dge"].join("")],
    ["apps", ["con", "nect-api"].join("")],
    ["packages", ["co", "dex-runner"].join("")]
  ]) {
    assert.deepEqual(walk(join(root, ...removed)), [], removed.join("/") + " must not contain product files");
  }
});

test("the v2 API and plugin expose no standalone Goal or Runner lifecycle", () => {
  const apiSources = sourceFiles(join(root, "apps/api/src"));
  const forbiddenApiPatterns = [
    /hunsu\.(?:goals|runners)\./u,
    /\bweb(?:Goal|Runners|Coach)\s*\(/u,
    /\b(?:goalDetailProjection|runnerDirectoryProjection|coachViewProjection)\b/u
  ];
  const violations = matchingFiles(apiSources, forbiddenApiPatterns);
  assert.deepEqual(violations, [], "apps/api must not retain v1 dispatchers, projections, or CRUD methods");

  const httpSource = readFileSync(join(root, "apps/api/src/http.ts"), "utf8").replaceAll("\\/", "/");
  assert.equal(/\/(?:goals|runners)(?:\/|["'`$])/u.test(httpSource), false, "retired resource routes must return 404");
  assert.equal(/\/coach(?:\/|["'`$])/u.test(httpSource), false, "the retired Project Coach route must not alias Coaching");

  const skillsRoot = join(root, "plugins/hunsu/skills");
  const skills = existsSync(skillsRoot)
    ? readdirSync(skillsRoot, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort()
    : [];
  assert.deepEqual(skills, ["hunsu-coach", "hunsu-diverge", "hunsu-project", "hunsu-run"]);
  assert.deepEqual(
    matchingFiles(sourceFiles(skillsRoot), [/hunsu\.(?:goals|runners)\./u]),
    [],
    "v2 skills must not call removed Goal or Runner tools"
  );
});

test("the runtime reads and writes only the .hunsu/v2 state namespace", () => {
  const stateStore = readFileSync(join(root, "packages/github-store/src/state-store.ts"), "utf8");
  assert.match(stateStore, /const STATE_ROOT = "\.hunsu\/v2";/u);

  const runtimeSources = [
    "apps/api/src",
    "packages/core/src",
    "packages/github-store/src",
    "packages/projections/src",
    "packages/protocol/src"
  ].flatMap(path => sourceFiles(join(root, path)))
    .filter(file => !file.endsWith("worker-configuration.d.ts"));
  const forbiddenStateArtifacts = [
    /\.hunsu\/workspace\.json/u,
    /\.hunsu\/projects\//u,
    /\.hunsu\/v1(?:\/|\b)/u,
    /\.hunsu\/state\.hunsu/u,
    /hunsu\.workspace\.v1/u,
    /hunsu\.project-event\.v1/u,
    /\b(?:decodeV1|decodeLegacy|legacyDecoder|v1Decoder|dualWrite|writeBoth|migrateV1|migrateLegacy)\b/iu
  ];
  assert.deepEqual(
    matchingFiles(runtimeSources, forbiddenStateArtifacts),
    [],
    "the runtime must not decode, migrate, alias, or dual-write v1 state"
  );
});

test("Project navigation has only Node graph and Events destinations", () => {
  const navigation = readFileSync(join(root, "apps/web/src/features/app-shell/ProjectAppShell.tsx"), "utf8");
  const labels = [...navigation.matchAll(/<(?:ProjectNavItem|MobileNavItem)\b[\s\S]*?\blabel="([^"]+)"/gu)]
    .map(match => match[1]!)
    .filter(label => label !== "Projects");
  assert.deepEqual([...new Set(labels)].sort(), ["Events", "Node graph"]);
  assert.equal(labels.filter(label => label === "Node graph").length, 2, "desktop and mobile navigation must expose Node graph");
  assert.equal(labels.filter(label => label === "Events").length, 2, "desktop and mobile navigation must expose Events");

  const routes = readFileSync(join(root, "apps/web/src/app/routes.ts"), "utf8");
  const routeKinds = new Set([...routes.matchAll(/kind: "([a-z_]+)"/gu)].map(match => match[1]!));
  assert.deepEqual([...routeKinds].sort(), ["events", "graph", "not_found", "projects"]);
});

test("repository workflows cannot operate the Hunsu product lifecycle", () => {
  const workflowRoot = join(root, ".github/workflows");
  const sources = existsSync(workflowRoot) ? walk(workflowRoot).map(file => readFileSync(file, "utf8")).join("\n") : "";
  assert.equal(/hunsu\/run|hunsu\/state|hunsu\.runs\.|\/mcp\b|\.hunsu\/(?:v2|projects|workspace\.json)/iu.test(sources), false);
});

function matchingFiles(files: readonly string[], patterns: readonly RegExp[]): string[] {
  return files.filter(file => {
    const source = readFileSync(file, "utf8");
    return patterns.some(pattern => pattern.test(source));
  }).map(file => relative(root, file)).sort();
}

function sourceFiles(directory: string): string[] {
  return walk(directory).filter(file => [".ts", ".tsx", ".js", ".mjs", ".json", ".md", ".yml", ".yaml"].includes(extname(file)));
}

function isSearchableSource(file: string): boolean {
  return [".ts", ".tsx", ".js", ".mjs", ".json", ".md", ".yml", ".yaml"].includes(extname(file)) || file.endsWith("AGENTS.md");
}

function walk(directory: string): string[] {
  if (!existsSync(directory)) return [];
  const output: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "dist" || entry.name === "node_modules") continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) output.push(...walk(path));
    else if (entry.isFile()) output.push(path);
  }
  return output;
}
