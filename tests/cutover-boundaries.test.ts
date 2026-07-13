import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const retiredTerms = [
  ["road", "map"].join(""),
  ["desti", "nation"].join(""),
  ["exec", "utor"].join(""),
  ["mem", "ber"].join(""),
  ["man", "ager"].join(""),
  ["bri", "dge"].join(""),
  ["stu", "dio"].join("")
];

test("the product cutover has one vocabulary and one operating model", () => {
  const searchableRoots = [
    "apps",
    "packages",
    "plugins",
    "scripts",
    "tests",
    "docs"
  ];
  const files = searchableRoots.flatMap(directory => walk(join(root, directory)))
    .concat(["README.md", "AGENTS.md", "CONTRIBUTING.md", "SECURITY.md", "PRIVACY.md", "package.json", "turbo.json"].map(file => join(root, file)))
    .filter(file => !file.endsWith("worker-configuration.d.ts"))
    .filter(file => [".ts", ".tsx", ".js", ".mjs", ".json", ".md", ".yml", ".yaml"].includes(extname(file)) || file.endsWith("AGENTS.md"));

  const violations: string[] = [];
  const pattern = new RegExp("\\b(?:" + retiredTerms.join("|") + ")\\b", "iu");
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    if (pattern.test(source)) violations.push(relative(root, file));
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

test("pure domain packages and Web preserve dependency boundaries", () => {
  const pureSources = [...walk(join(root, "packages/protocol/src")), ...walk(join(root, "packages/core/src"))];
  const forbiddenPure = [
    ["node", ":fs"].join(""),
    ["node", ":http"].join(""),
    ["@octo", "kit"].join(""),
    ["github", "-store"].join(""),
    ["co", "dex"].join("")
  ];
  for (const file of pureSources) {
    const source = readFileSync(file, "utf8").toLowerCase();
    for (const dependency of forbiddenPure) {
      assert.equal(source.includes(dependency), false, `${relative(root, file)} must not depend on ${dependency}`);
    }
  }

  const webSources = walk(join(root, "apps/web/src"));
  for (const file of webSources) {
    const source = readFileSync(file, "utf8");
    assert.equal(/@hunsu\/(?:core|github-store)|node:/u.test(source), false, `${relative(root, file)} crosses the Web boundary`);
  }
});

test("repository workflows cannot operate the Hunsu product lifecycle", () => {
  const workflowRoot = join(root, ".github/workflows");
  const sources = existsSync(workflowRoot) ? walk(workflowRoot).map(file => readFileSync(file, "utf8")).join("\n") : "";
  assert.equal(/hunsu\/run|hunsu\/state|hunsu\.runs\.|\/mcp\b|\.hunsu\/projects/iu.test(sources), false);
});

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
