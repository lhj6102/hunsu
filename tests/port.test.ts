import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { HUNSU_DESTINATIONS_PATH, HUNSU_RUNTIME_PATHS, applyHunsuPort, decodeHunsuRuntimeFileText, inspectHunsuPort, planHunsuPort } from "../packages/core/src/index.ts";

test("Hunsu Port inspects a Git project and plans Artifact Action-ready state", () => {
  const repo = createNodeRepo();

  const inspection = inspectHunsuPort(repo);
  const plan = planHunsuPort({
    cwd: repo,
    title: "Ported Product",
    goal: "Run the product through Artifact Actions."
  });

  assert.equal(inspection.isGitRepository, true);
  assert.equal(inspection.isHunsuRoadmap, false);
  assert.equal(inspection.packageManager, "pnpm");
  assert.equal(inspection.packageScripts.dev, "vite --host 127.0.0.1 --port 5173");
  assert.equal(inspection.artifactActions.configured, false);
  assert.equal(inspection.artifactActions.count, 0);
  assert.deepEqual(plan.files, []);
  assert.equal(plan.commands[0].type, "CreateInitialTeam");
});

test("Hunsu Port apply writes Initial Team state without implicit Artifact Action files", () => {
  const repo = createNodeRepo();

  const result = applyHunsuPort({
    cwd: repo,
    title: "Ported Product",
    goal: "Run the product through Artifact Actions."
  });

  assert.deepEqual(result.writtenFiles, []);
  assert.equal(HUNSU_RUNTIME_PATHS.every(path => existsSync(join(repo, path))), true);
  assert.equal(result.acceptedEvents[0].type, "InitialTeamCreated");
  assert.equal(result.board.requests[0].title, "Ported Product");
  assert.match(readHunsuEventText(repo), /InitialTeamCreated/);

  const after = inspectHunsuPort(repo);
  assert.equal(after.isHunsuRoadmap, true);
  assert.equal(after.artifactActions.configured, false);
});

function createNodeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "hunsu-port-test-"));
  run("git", ["init", "-b", "main"], repo);
  run("git", ["config", "user.email", "test@hunsu.app"], repo);
  run("git", ["config", "user.name", "Test User"], repo);
  writeFileSync(join(repo, "package.json"), JSON.stringify({
    scripts: {
      dev: "vite --host 127.0.0.1 --port 5173",
      "test:e2e": "playwright test"
    },
    devDependencies: {
      "@playwright/test": "^1.0.0",
      vite: "^6.0.0"
    },
    packageManager: "pnpm@10.0.0"
  }, null, 2), "utf8");
  writeFileSync(join(repo, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
  return repo;
}

function readHunsuEventText(cwd: string): string {
  const text = readFileSync(join(cwd, HUNSU_DESTINATIONS_PATH), "utf8");
  const decoded = decodeHunsuRuntimeFileText<{ compatibility: { events: unknown[] } }>(text, HUNSU_DESTINATIONS_PATH);
  assert.equal(decoded.ok, true);
  return JSON.stringify(decoded.value.compatibility.events);
}

function run(command: string, args: string[], cwd: string): string {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed\n${result.stderr}\n${result.stdout}`);
  }
  return result.stdout;
}
