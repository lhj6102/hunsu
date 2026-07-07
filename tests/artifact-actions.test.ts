import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  HUNSU_ARTIFACT_ACTIONS_PATH,
  applyHunsuPort,
  decodeHunsuRuntimeFileText,
  encodeHunsuRuntimeFile,
  hunsuDraftRuntimeBundleFromRuntime,
  listArtifactActions,
  listArtifactActionRuns,
  loadDomainStore,
  planArtifactActionRun,
  readArtifactActionRun,
  startArtifactActionRun,
  stopArtifactActionRun,
  validateDraftRuntimeBundle,
  writeCommands,
  type ArtifactActionCommandRunner
} from "../packages/core/src/index.ts";
import type { ArtifactActionDefinition, BoardProjection, Command, NodeRecord } from "../packages/protocol/src/index.ts";
import { decodeArtifactActionDefinition } from "../packages/protocol/src/index.ts";

test("Artifact Actions are durable Hunsu state and rebuild into node snapshots", () => {
  const repo = createActionRepo();
  const board = addHostAction(repo);
  const text = decodeHunsuRuntimeFileText<{ actions: unknown[] }>(
    readFile(HUNSU_ARTIFACT_ACTIONS_PATH, repo),
    HUNSU_ARTIFACT_ACTIONS_PATH
  );

  assert.equal(text.ok, true);
  assert.equal(text.value.actions.length, 1);
  assert.deepEqual(board.artifactActions.map(action => String(action.id)), ["host-web"]);
  assert.equal(board.nodes.at(-1)?.artifactActions[0]?.title, "Host Web");
  assert.deepEqual(listArtifactActions(repo).map(action => String(action.id)), ["host-web"]);
});

test("Artifact Action planning resolves aliases, required env, and action proxy paths", () => {
  const repo = createActionRepo();
  const board = addHostAction(repo);
  const head = run("git", ["rev-parse", "HEAD"], repo).trim();
  const moveNode = board.nodes.at(-1);

  const plan = planArtifactActionRun({
    cwd: repo,
    actionId: "host-web",
    commit: "HEAD",
    roadmapId: "roadmap_test",
    env: { WEB_PORT: "9999", TOKEN: "override-token", EXTRA: "extra" },
    ambientEnv: { TOKEN: "ambient-token" },
    now: "2026-01-01T00:00:00.000Z"
  });

  assert.equal(moveNode?.artifactActions.length, 1);
  assert.equal(plan.run.runId, `host-web-${head.slice(0, 12)}-20260101t00000`);
  assert.equal(plan.run.env.WEB_PORT, "5173");
  assert.equal(plan.run.env.API_URL, "http://api:4187");
  assert.equal(plan.run.env.TOKEN, "<secret>");
  assert.equal(plan.commands[0].args.includes("build"), true);
  assert.equal(plan.commands[1].args.includes("up"), true);
  assert.equal(plan.run.aliases?.web.externalPath, `/api/roadmaps/roadmap_test/action-runs/${plan.run.runId}/proxy/web/`);
  assert.throws(() => planArtifactActionRun({ cwd: repo, actionId: "host-web", commit: "HEAD" }), /TOKEN is required/);
});

test("Artifact Action updates must leave a valid full action definition", () => {
  const repo = createActionRepo();
  addHostAction(repo);
  const store = loadDomainStore(repo);
  const previous = hunsuDraftRuntimeBundleFromRuntime(store.runtime);
  const request = {
    ...previous,
    artifactActions: {
      ...previous.artifactActions,
      actions: previous.artifactActions.actions.map(action => action.id === "host-web"
        ? { ...action, kind: "check" }
        : action)
    }
  } as unknown as typeof previous;

  const validation = validateDraftRuntimeBundle(previous, request, store.runtime);
  assert.equal(validation.ok, false);
  if (!validation.ok) {
    assert.match(validation.error.message, /runner\.type must be command for check actions/);
  }
});

test("Artifact Action runtime files validate encoded action definitions", () => {
  const repo = createActionRepo();
  addHostAction(repo);
  const [action] = listArtifactActions(repo);
  if (!action) {
    throw new Error("Expected fixture action");
  }
  const invalidFile = encodeHunsuRuntimeFile({
    schema: "hunsu.artifact-actions.v1",
    order: "display-order",
    actions: [{
      ...action,
      env: { TOKEN: { required: false } },
      aliases: { web: {} }
    }]
  });

  writeFileSync(join(repo, HUNSU_ARTIFACT_ACTIONS_PATH), invalidFile.text, "utf8");

  assert.throws(() => loadDomainStore(repo), /Invalid Artifact Actions runtime file/);
});

test("Artifact Action definitions reject env aliases that are not declared", () => {
  const result = decodeArtifactActionDefinition({
    id: "host-web",
    title: "Host Web",
    kind: "host",
    sourceScope: "move",
    env: { API_URL: { fromAliasUrl: "api" } },
    runner: { type: "command", command: "pnpm dev" },
    aliases: { web: { target: "localhost:5173" } },
    displayOrder: 1
  }, "action");

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error.message, /action\.env\.API_URL\.fromAliasUrl references unknown alias: api/);
  }
});

test("Artifact Action evidence paths must be non-empty", () => {
  const result = decodeArtifactActionDefinition({
    id: "check-web",
    title: "Check Web",
    kind: "check",
    sourceScope: "move",
    runner: { type: "command", command: "pnpm test" },
    evidence: { paths: [""] },
    displayOrder: 1
  }, "action");

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error.message, /action\.evidence\.paths\[0\] must be a non-empty string/);
  }
});

test("Artifact Action host runs are stored and stopped from detached source worktrees", () => {
  const repo = createActionRepo();
  addHostAction(repo);
  const actionWorktreeRoot = mkdtempSync(join(tmpdir(), "hunsu-action-root-"));
  const calls: string[] = [];
  const cwdCalls: string[] = [];
  const runner: ArtifactActionCommandRunner = (command, args, options) => {
    calls.push(`${command} ${args.join(" ")}`);
    cwdCalls.push(options.cwd);
    if (args.includes("port")) {
      return { status: 0, stdout: args.includes("web") ? "0.0.0.0:49173\n" : "127.0.0.1:49187\n", stderr: "" };
    }
    return { status: 0, stdout: "", stderr: "" };
  };

  const runRecord = startArtifactActionRun({
    cwd: repo,
    actionId: "host-web",
    commit: "HEAD",
    env: { TOKEN: "token" },
    now: "2026-01-01T00:00:00.000Z",
    worktreeRoot: actionWorktreeRoot
  }, { runner });
  const stored = readArtifactActionRun(repo, runRecord.runId);
  const stopped = stopArtifactActionRun(repo, runRecord.runId, { runner });

  assert.equal(runRecord.status, "running");
  assert.equal(runRecord.aliases?.web.directUrl, "http://127.0.0.1:49173");
  assert.equal(stored.status, "running");
  assert.equal(listArtifactActionRuns(repo)[0].runId, runRecord.runId);
  assert.equal(stopped.status, "stopped");
  assert.equal(existsSync(join(repo, ".hunsu", "action-runs", `${runRecord.runId}.json`)), true);
  assert.equal(calls.some(call => call.includes(" build")), true);
  assert.equal(calls.some(call => call.includes(" up -d")), true);
  assert.equal(calls.some(call => call.includes(" down")), true);
  assert.equal(cwdCalls.every(cwd => cwd !== repo), true);
  assert.equal(cwdCalls.every(cwd => cwd.startsWith(actionWorktreeRoot)), true);
  assert.equal(runRecord.sourceWorktree?.path.startsWith(actionWorktreeRoot), true);
});

test("Artifact Action check runs finite commands and removes the detached worktree", () => {
  const repo = createActionRepo();
  addCheckAction(repo);
  const cwdCalls: string[] = [];
  const runner: ArtifactActionCommandRunner = (_command, _args, options) => {
    cwdCalls.push(options.cwd);
    return { status: 0, stdout: "ok\n", stderr: "" };
  };

  const runRecord = startArtifactActionRun({
    cwd: repo,
    actionId: "typecheck",
    commit: "HEAD",
    now: "2026-01-01T00:00:00.000Z"
  }, { runner });

  assert.equal(runRecord.status, "succeeded");
  assert.equal(runRecord.exitCode, 0);
  assert.equal(runRecord.stdout, "ok\n");
  assert.equal(runRecord.sourceWorktree?.removedAt !== undefined, true);
  assert.equal(cwdCalls.every(cwd => cwd !== repo), true);
});

function createActionRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "hunsu-action-test-"));
  run("git", ["init", "-b", "main"], repo);
  run("git", ["config", "user.email", "test@hunsu.app"], repo);
  run("git", ["config", "user.name", "Test User"], repo);
  writeFileSync(join(repo, "app.txt"), "artifact action\n", "utf8");
  writeFileSync(join(repo, "docker-compose.yml"), "services:\n  web:\n    image: node:22\n  api:\n    image: node:22\n", "utf8");
  run("git", ["add", "."], repo);
  run("git", ["commit", "-m", "action fixture"], repo);
  applyHunsuPort({
    cwd: repo,
    title: "Action Product",
    goal: "Run the product through Artifact Actions."
  });
  return repo;
}

function addHostAction(repo: string): BoardProjection {
  return writeCommands([actionCommand("H0001", {
    id: "host-web",
    title: "Host Web",
    kind: "host",
    sourceScope: "move-or-commit",
    env: {
      WEB_PORT: { alias: "web" },
      API_URL: { fromAliasUrl: "api" },
      TOKEN: { required: true, secret: true }
    },
    runner: { type: "docker_compose", file: "docker-compose.yml", projectName: "action-{shortCommit}" },
    aliases: {
      web: { service: "web", containerPort: 5173, healthPath: "/" },
      api: { service: "api", containerPort: 4187 }
    },
    displayOrder: 1
  }, repo)], { cwd: repo }).board;
}

function addCheckAction(repo: string): BoardProjection {
  return writeCommands([actionCommand("H0001", {
    id: "typecheck",
    title: "Typecheck",
    kind: "check",
    sourceScope: "move-or-commit",
    runner: { type: "command", command: "pnpm typecheck" },
    evidence: { attach: true, paths: ["reports/typecheck.txt"] },
    displayOrder: 1
  }, repo)], { cwd: repo }).board;
}

function actionCommand(hunsuId: string, action: Record<string, unknown>, repo = process.cwd()): Command {
  const board = loadDomainStore(repo).board;
  const line = board.lines[0];
  if (!line) {
    throw new Error("Expected fixture to have a line");
  }
  const sourceNode = board.nodes.find(node => node.id === line.currentNodeId);
  if (!sourceNode) {
    throw new Error("Expected fixture line to point at a node");
  }
  return hunsuRuntimeChangeCommand({
    hunsuId,
    sourceLineId: String(line.id),
    sourceNode,
    newLineId: `${line.id}/fork-${hunsuId}`,
    summary: `Add ${String(action.id)} Artifact Action.`,
    artifactActions: [...sourceNode.artifactActions.map(cloneTestJson), action as unknown as ArtifactActionDefinition]
  });
}

function hunsuRuntimeChangeCommand(input: {
  hunsuId: string;
  sourceLineId: string;
  sourceNode: NodeRecord;
  newLineId: string;
  summary: string;
  artifactActions: ArtifactActionDefinition[];
}): Command {
  return {
    type: "ConfirmHunsuDraft",
    actor: "DIRECTOR",
    at: "2026-06-16T00:00:01.000Z",
    draft: {
      id: `draft-${input.hunsuId}`,
      status: "ready",
      sourceLineId: input.sourceLineId,
      sourceNodeId: String(input.sourceNode.id),
      sourceMoveId: input.sourceNode.source.type === "move" ? String(input.sourceNode.source.moveId) : undefined,
      target: { type: "node", id: String(input.sourceNode.id) },
      newTeamName: input.sourceNode.teamName ?? "Team",
      summary: input.summary,
      teamSnapshot: {
        teamName: input.sourceNode.teamName ?? "Team",
        moveOrdinal: input.sourceNode.ordinal,
        destinations: input.sourceNode.destinations.map(cloneTestJson),
        harness: cloneTestJson(input.sourceNode.harness),
        harnessGraph: cloneTestJson(input.sourceNode.harnessGraph),
        harnessLock: input.sourceNode.harnessLock ? cloneTestJson(input.sourceNode.harnessLock) : undefined,
        executorPackageBindings: input.sourceNode.executorPackageBindings?.map(cloneTestJson),
        resourcePackageBindings: input.sourceNode.resourcePackageBindings?.map(cloneTestJson),
        artifactActions: input.artifactActions
      },
      changedFiles: [{
        path: ".hunsu-request/artifact-actions.json",
        kind: "updated",
        summary: "Artifact Actions 1 added."
      }],
      hunsuId: input.hunsuId,
      newLineId: input.newLineId,
      conversationRef: {
        provider: "local",
        conversationHash: `conversation-${input.hunsuId}`,
        contextHash: `context-${input.hunsuId}`,
        startedAt: "2026-06-16T00:00:00.000Z",
        endedAt: "2026-06-16T00:00:01.000Z"
      },
      createdAt: "2026-06-16T00:00:00.000Z",
      updatedAt: "2026-06-16T00:00:01.000Z"
    }
  };
}

function cloneTestJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function readFile(path: string, cwd: string): string {
  return readFileSync(join(cwd, path), "utf8");
}

function run(command: string, args: string[], cwd: string): string {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed\n${result.stderr}\n${result.stdout}`);
  }
  return result.stdout;
}
