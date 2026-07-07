import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  HUNSU_COMPLETED_DESTINATIONS_PATH,
  HUNSU_DESTINATIONS_PATH,
  HUNSU_RUNTIME_PATHS,
  applyHunsuPort,
  buildMoveCommitMessage,
  createHunsuCommit,
  createSquashMoveCommit,
  decodeDomainEventText,
  decodeHunsuRuntimeFileText,
  loadBoardFromGit,
  readHunsuRuntimeStateAtRef,
  resolveMove,
  writeCommands
} from "../packages/core/src/index.ts";
import type { ArtifactActionDefinition, BoardProjection, Command, NodeRecord } from "../packages/protocol/src/index.ts";
import { main } from "../packages/cli/src/index.ts";

test("loadBoardFromGit reads Hunsu move trailers from Git history", () => {
  const repo = createRepo();
  writeFileSync(join(repo, "file.txt"), "one\n", "utf8");
  run("git", ["add", "file.txt"], repo);
  run("git", ["commit", "-m", buildMoveCommitMessage({
    run: "run/example",
    goal: "example-goal",
    move: "0001",
    evidence: "unit:pass"
  })], repo);

  const board = loadBoardFromGit({ cwd: repo });

  assert.equal(board.moves.length, 1);
  assert.equal(board.runs[0].runId, "run/example");
  assert.equal(resolveMove(board, "M0001").goal, "example-goal");
});

test("loadBoardFromGit handles Git log output larger than the default spawn buffer", () => {
  const repo = createRepo();
  writeFileSync(join(repo, "file.txt"), "one\n", "utf8");
  run("git", ["add", "file.txt"], repo);
  const messageFile = join(repo, "message.txt");
  writeFileSync(messageFile, buildMoveCommitMessage({
    run: "run/large-history",
    goal: "large-history-goal",
    move: "0001",
    evidence: "x".repeat(2 * 1024 * 1024)
  }), "utf8");
  run("git", ["commit", "-F", messageFile], repo);

  const board = loadBoardFromGit({ cwd: repo });

  assert.equal(board.moves.length, 1);
  assert.equal(resolveMove(board, "M0001").goal, "large-history-goal");
});

test("createHunsuCommit records an artifact on a new run ref without changing the worktree", () => {
  const repo = createRepo();
  writeFileSync(join(repo, "file.txt"), "one\n", "utf8");
  run("git", ["add", "file.txt"], repo);
  run("git", ["commit", "-m", buildMoveCommitMessage({
    run: "run/example",
    goal: "example-goal",
    move: "0001",
    evidence: "unit:pass"
  })], repo);
  const beforeBranch = run("git", ["branch", "--show-current"], repo).trim();
  const board = loadBoardFromGit({ cwd: repo });
  const targetMove = resolveMove(board, "M0001");

  const result = createHunsuCommit({
    cwd: repo,
    id: "h001",
    targetMove,
    newRun: "run/example-h001",
    artifactText: "Observation: Try a different frame.\nInstruction: Re-run from here."
  });

  assert.match(result.commitSha, /^[0-9a-f]{40}$/);
  assert.equal(run("git", ["branch", "--show-current"], repo).trim(), beforeBranch);
  assert.equal(run("git", ["show", `${result.commitSha}:.hunsu/hunsus/h001.md`], repo), "Observation: Try a different frame.\nInstruction: Re-run from here.\n");
  const updatedBoard = loadBoardFromGit({ cwd: repo });
  assert.equal(updatedBoard.hunsus.length, 1);
  assert.equal(updatedBoard.hunsus[0].newRun, "run/example-h001");
  assert.throws(() => createHunsuCommit({
    cwd: repo,
    id: "h001",
    targetMove,
    newRun: "run/example-h001",
    artifactText: "Observation: Duplicate."
  }), /Ref already exists/);
});

test("createSquashMoveCommit advances a run with one move commit", () => {
  const repo = createRepo();
  writeFileSync(join(repo, "file.txt"), "base\n", "utf8");
  run("git", ["add", "file.txt"], repo);
  run("git", ["commit", "-m", "base"], repo);
  run("git", ["branch", "run/example"], repo);
  run("git", ["checkout", "-b", "work/example", "run/example"], repo);
  writeFileSync(join(repo, "file.txt"), "base\nwork\n", "utf8");
  run("git", ["add", "file.txt"], repo);
  run("git", ["commit", "-m", "internal work"], repo);

  const result = createSquashMoveCommit({
    cwd: repo,
    fromRef: "work/example",
    runRef: "run/example",
    message: buildMoveCommitMessage({
      run: "run/example",
      goal: "squashed-goal",
      move: "0002",
      evidence: "unit:pass"
    })
  });

  assert.equal(run("git", ["rev-parse", "run/example"], repo).trim(), result.commitSha);
  assert.equal(run("git", ["branch", "--show-current"], repo).trim(), "work/example");
  const board = loadBoardFromGit({ cwd: repo });
  assert.equal(board.moves.length, 1);
  assert.equal(resolveMove(board, "M0002").goal, "squashed-goal");
});

test("CLI board command prints reconstructed runs", async () => {
  const repo = createRepo();
  writeFileSync(join(repo, "file.txt"), "one\n", "utf8");
  run("git", ["add", "file.txt"], repo);
  run("git", ["commit", "-m", buildMoveCommitMessage({
    run: "run/example",
    goal: "example-goal",
    move: "0001",
    evidence: "unit:pass"
  })], repo);

  const output = await captureCli(repo, ["board"]);

  assert.match(output, /Hunsu board/);
  assert.match(output, /run\/example/);
  assert.match(output, /M0001 example-goal complete/);
});

test("CLI board, runs, and show support JSON output", async () => {
  const repo = createRepo();
  writeFileSync(join(repo, "file.txt"), "one\n", "utf8");
  run("git", ["add", "file.txt"], repo);
  run("git", ["commit", "-m", buildMoveCommitMessage({
    run: "run/example",
    goal: "example-goal",
    move: "0001",
    evidence: "unit:pass"
  })], repo);

  const board = JSON.parse(await captureCli(repo, ["board", "--json"]));
  const runs = JSON.parse(await captureCli(repo, ["runs", "--json"]));
  const detail = JSON.parse(await captureCli(repo, ["show", "M0001", "--json"]));

  assert.equal(board.runs[0].id, "run/example");
  assert.equal(board.moves[0].id, "M0001");
  assert.equal(runs[0].moves[0], "M0001");
  assert.equal(detail.move.goal, "example-goal");
});

test("CLI Initial Team and executable Destination commands record Git-backed domain events", async () => {
  const repo = createRepo();
  writeFileSync(join(repo, "request.md"), "Create the Studio control plane.\n", "utf8");
  writeFileSync(join(repo, "destinations.md"), "- Define protocol commands\n- Scaffold Bridge server\n", "utf8");

  assert.match(await captureCli(repo, [
    "request",
    "create",
    "--id",
    "req_studio",
    "--title",
    "Studio MVP",
    "--file",
    "request.md",
    "--destinations",
    "destinations.md",
    "--write"
  ]), /Created Initial Team run\/req_studio/);

  for (const argv of [
    ["destination", "add", "--request", "req_studio", "--id", "destination_003", "--title", "Wire Codex runner", "--write"],
    ["destination", "edit", "destination_001", "--title", "Wire Codex runner as Team adapter", "--write"],
    ["destination", "cancel", "destination_002", "--reason", "Server scaffold covered elsewhere", "--write"],
    ["destination", "reprioritize", "destination_001", "--priority", "42", "--write"],
    ["destination", "unblock", "destination_001", "--write"]
  ]) {
    const failed = await captureCliExit(repo, argv);
    assert.equal(failed.code, 1);
    assert.match(failed.stderr, /Usage: hunsu destination <list\|claim\|start\|block>/);
  }

  assert.match(await captureCli(repo, [
    "destination",
    "claim",
    "destination_001",
    "--actor",
    "codex",
    "--write"
  ]), /Claimed Destination destination_001/);

  assert.match(await captureCli(repo, [
    "destination",
    "start",
    "destination_001",
    "--actor",
    "codex",
    "--write"
  ]), /Started Destination destination_001/);

  assert.match(await captureCli(repo, [
    "destination",
    "block",
    "destination_002",
    "--reason",
    "Needs product decision",
    "--write"
  ]), /Blocked Destination destination_002/);

  const destinationsAfterDestinationHunsus = JSON.parse(await captureCli(repo, ["destination", "list", "--request", "req_studio", "--json"]));
  assert.equal(destinationsAfterDestinationHunsus.find((destination: { id: string }) => destination.id === "destination_001").status, "in_progress");
  assert.equal(destinationsAfterDestinationHunsus.find((destination: { id: string }) => destination.id === "destination_002").status, "blocked");
  assert.equal(destinationsAfterDestinationHunsus.some((destination: { id: string }) => destination.id === "destination_003"), false);

  assert.match(await captureCli(repo, ["run", "pause", "run/req_studio", "--write"]), /Paused run\/req_studio/);
  assert.match(await captureCli(repo, ["run", "resume", "run/req_studio", "--write"]), /Resumed run\/req_studio/);
  writeFileSync(join(repo, "baseline.txt"), "baseline\n", "utf8");
  run("git", ["add", "baseline.txt"], repo);
  run("git", ["commit", "-m", "baseline project commit"], repo);
  assert.match(await captureCli(repo, [
    "move",
    "reach",
    "--run",
    "run/req_studio",
    "--destination",
    "destination_001",
    "--from",
    "HEAD",
    "--summary",
    "Defined protocol commands",
    "--evidence",
    "unit:pass",
    "--write"
  ]), /Recorded MOVE M0001/);
  const completedBeforeHunsu = readFileSync(join(repo, HUNSU_COMPLETED_DESTINATIONS_PATH), "utf8");
  writeFileSync(join(repo, "hunsu.md"), "# Tighten the server contract\n\nRequire JSON errors for command failures.\n", "utf8");
  const failedHunsuCreate = await captureCliExit(repo, [
    "hunsu",
    "create",
    "--target",
    "M0001",
    "--file",
    "hunsu.md",
    "--write"
  ]);
  assert.equal(failedHunsuCreate.code, 1);
  assert.match(failedHunsuCreate.stderr, /hunsu create is no longer a direct CLI mutation/);
  assert.equal(readFileSync(join(repo, HUNSU_COMPLETED_DESTINATIONS_PATH), "utf8"), completedBeforeHunsu);
  const failedHunsuApply = await captureCliExit(repo, ["hunsu", "apply", "h006"]);
  assert.equal(failedHunsuApply.code, 1);
  assert.match(failedHunsuApply.stderr, /No HUNSU found for h006/);

  const request = JSON.parse(await captureCli(repo, ["request", "show", "req_studio", "--json"]));
  const status = JSON.parse(await captureCli(repo, ["run", "status", "run/req_studio", "--json"]));
  const destinations = JSON.parse(await captureCli(repo, ["destination", "list", "--request", "req_studio", "--json"]));
  const eventText = readHunsuEventText(repo);

  assert.equal(request.request.id, "req_studio");
  assert.equal(request.lines[0].id, "run/req_studio");
  assert.equal(status.status, "active");
  assert.deepEqual(status.moveIds, ["M0001"]);
  assert.equal(Array.isArray(destinations), true);
  assert.doesNotMatch(eventText, /HunsuRecorded/);
  assert.equal(HUNSU_RUNTIME_PATHS.every(path => existsSync(join(repo, path))), true);
});

test("decodeDomainEventText validates Git-backed domain event payloads", () => {
  const valid = decodeDomainEventText(JSON.stringify({
    type: "RequestCreated",
    request: {
      id: "req_001",
      title: "Studio MVP",
      goal: "Create the first Studio control plane",
      createdBy: "SYSTEM"
    }
  }), "refs/hunsu/events/E000001-RequestCreated");
  assert.equal(valid.ok, true);

  const empty = decodeDomainEventText("", "refs/hunsu/events/E000001-empty");
  assert.equal(empty.ok, false);
  if (!empty.ok) {
    assert.match(empty.error.message, /Empty Hunsu domain event object/);
  }

  const malformed = decodeDomainEventText("{", "refs/hunsu/events/E000001-malformed");
  assert.equal(malformed.ok, false);
  if (!malformed.ok) {
    assert.match(malformed.error.message, /Invalid Hunsu domain event JSON/);
  }

  const unknown = decodeDomainEventText(JSON.stringify({ type: "MysteryEvent" }), "refs/hunsu/events/E000001-mystery");
  assert.equal(unknown.ok, false);
  if (!unknown.ok) {
    assert.match(unknown.error.message, /Invalid Hunsu domain event object/);
  }

  const invalidNestedPrimitive = decodeDomainEventText(JSON.stringify({
    type: "RequestCreated",
    request: {
      id: "req with spaces",
      title: "Studio MVP",
      goal: "Create the first Studio control plane",
      createdBy: "SYSTEM"
    }
  }), "refs/hunsu/events/E000001-invalid-request");
  assert.equal(invalidNestedPrimitive.ok, false);
  if (!invalidNestedPrimitive.ok) {
    assert.match(invalidNestedPrimitive.error.message, /requestId/);
  }
});

test("CLI rejects direct Harness and Member mutation commands", async () => {
  const repo = createRepo();
  writeFileSync(join(repo, "request.md"), "Create the Studio control plane.\n", "utf8");
  writeFileSync(join(repo, "destinations.md"), "- Define protocol commands\n", "utf8");

  await captureCli(repo, [
    "request",
    "create",
    "--id",
    "req_protocol",
    "--title",
    "Protocol CLI",
    "--file",
    "request.md",
    "--destinations",
    "destinations.md",
    "--write"
  ]);

  const rootNodeId = "req_protocol:root";
  const shown = JSON.parse(await captureCli(repo, ["executing-protocol", "show", "--from", rootNodeId, "--json"]));
  assert.equal(shown.kind, "team_execution_plan");
  const before = readHunsuEventText(repo);

  const protocol = {
    ...shown,
    maxAttemptCount: 3,
    members: shown.members.map((member: { id: string; model: string }) =>
      member.id === "azir"
        ? {
        ...member,
        model: "gpt-5.3-codex"
      }
        : member
    )
  };
  writeFileSync(join(repo, "executing-protocol.json"), JSON.stringify(protocol), "utf8");
  const failedProtocolSet = await captureCliExit(repo, [
    "executing-protocol",
    "set",
    "--from",
    rootNodeId,
    "--file",
    "executing-protocol.json",
    "--json",
    "--write"
  ]);
  assert.equal(failedProtocolSet.code, 1);
  assert.match(failedProtocolSet.stderr, /executing-protocol set is no longer a direct CLI mutation/);

  writeFileSync(join(repo, "prompt.md"), "Prefer protocol changes before UI changes.\n", "utf8");
  const failedPromptSet = await captureCliExit(repo, [
    "member",
    "prompt",
    "set",
    "--from",
    rootNodeId,
    "--member",
    "azir",
    "--file",
    "prompt.md",
    "--json",
    "--write"
  ]);
  assert.equal(failedPromptSet.code, 1);
  assert.match(failedPromptSet.stderr, /member prompt set is no longer a direct CLI mutation/);

  const failedReasoningSet = await captureCliExit(repo, [
    "member",
    "reasoning",
    "set",
    "--from",
    rootNodeId,
    "--member",
    "galio",
    "--effort",
    "high",
    "--json",
    "--write"
  ]);
  assert.equal(failedReasoningSet.code, 1);
  assert.match(failedReasoningSet.stderr, /member reasoning set is no longer a direct CLI mutation/);

  writeFileSync(join(repo, "skill.json"), JSON.stringify({
    kind: "local-snapshot",
    name: "playwright-cli",
    sourcePath: "/workspace/.agents/skills/playwright-cli",
    contentHash: "hash-playwright-cli",
    snapshotRef: "codex-skill:hash-playwright-cli",
    snapshotFiles: [{ path: "SKILL.md", text: "# Playwright CLI\n" }]
  }), "utf8");
  const failedSkillAdd = await captureCliExit(repo, [
    "member",
    "skill",
    "add",
    "--from",
    rootNodeId,
    "--member",
    "azir",
    "--skill",
    "skill.json",
    "--json",
    "--write"
  ]);
  assert.equal(failedSkillAdd.code, 1);
  assert.match(failedSkillAdd.stderr, /member skill add is no longer a direct CLI mutation/);
  assert.equal(readHunsuEventText(repo), before);
});

test("CLI rejects direct Harness set before writing events", async () => {
  const repo = createRepo();
  writeFileSync(join(repo, "request.md"), "Create the Studio control plane.\n", "utf8");
  writeFileSync(join(repo, "destinations.md"), "- Define protocol commands\n", "utf8");
  await captureCli(repo, [
    "request",
    "create",
    "--id",
    "req_invalid_protocol",
    "--title",
    "Invalid Protocol CLI",
    "--file",
    "request.md",
    "--destinations",
    "destinations.md",
    "--write"
  ]);
  const before = readHunsuEventText(repo);
  writeFileSync(join(repo, "bad-protocol.json"), JSON.stringify({
    kind: "team_execution_plan",
    maxAttemptCount: 0,
    team: { prompt: "" },
    members: []
  }), "utf8");

  const failed = await captureCliExit(repo, [
    "executing-protocol",
    "set",
    "--from",
    "req_invalid_protocol:root",
    "--file",
    "bad-protocol.json",
    "--write"
  ]);

  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /executing-protocol set is no longer a direct CLI mutation/);
  assert.equal(readHunsuEventText(repo), before);
});

test("CLI runs, show, and select read the reconstructed board", async () => {
  const repo = createRepo();
  writeFileSync(join(repo, "file.txt"), "one\n", "utf8");
  run("git", ["add", "file.txt"], repo);
  run("git", ["commit", "-m", buildMoveCommitMessage({
    run: "run/example",
    goal: "example-goal",
    move: "0001",
    evidence: "unit:pass"
  })], repo);

  assert.match(await captureCli(repo, ["runs"]), /run\/example  moves:1/);
  assert.match(await captureCli(repo, ["show", "M0001"]), /Goal: example-goal/);
  assert.match(await captureCli(repo, ["select", "run/example", "M0001"]), /Dry run: main would point to run\/example:M0001/);
});

test("CLI board command handles an empty repository", async () => {
  const repo = createRepo();

  const output = await captureCli(repo, ["board"]);

  assert.match(output, /No Hunsu board events found/);
});

test("CLI action list and plan expose configured Artifact Actions", async () => {
  const repo = createRepo();
  writeActionFixture(repo);
  run("git", ["add", "."], repo);
  run("git", ["commit", "-m", "action fixture"], repo);
  const ported = applyHunsuPort({
    cwd: repo,
    title: "Action CLI",
    goal: "Run the product through Artifact Actions."
  });
  addHostAction(repo, ported.board);
  const head = run("git", ["rev-parse", "HEAD"], repo).trim();

  const actions = JSON.parse(await captureCli(repo, ["action", "list", "--json"]));
  const plan = JSON.parse(await captureCli(repo, ["action", "plan", "host-web", "--commit", "HEAD", "--roadmap", "roadmap_cli", "--env", "TOKEN=token", "--json"]));

  assert.equal(actions.actions[0].id, "host-web");
  assert.equal(plan.run.runId, `host-web-${head.slice(0, 12)}-${plan.run.createdAt.replace(/[^0-9A-Za-z]/g, "").slice(0, 14).toLowerCase()}`);
  assert.equal(plan.run.aliases.web.externalPath, `/api/roadmaps/roadmap_cli/action-runs/${plan.run.runId}/proxy/web/`);
  assert.equal(plan.run.env.API_URL, "http://api:4187");
  assert.equal(plan.commands[0].args.includes("build"), true);
});

test("CLI port inspect and apply convert a Git project into a Hunsu Roadmap", async () => {
  const repo = createRepo();
  writeFileSync(join(repo, "package.json"), JSON.stringify({
    scripts: { dev: "vite --host 127.0.0.1 --port 5173", "test:e2e": "playwright test" },
    packageManager: "pnpm@10.0.0"
  }), "utf8");
  writeFileSync(join(repo, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");

  const inspection = JSON.parse(await captureCli(repo, ["port", "inspect", ".", "--json"]));
  const applied = JSON.parse(await captureCli(repo, [
    "port",
    "apply",
    ".",
    "--title",
    "CLI Port",
    "--goal",
    "Make the CLI fixture action-ready",
    "--json",
    "--write"
  ]));

  assert.equal(inspection.packageManager, "pnpm");
  assert.equal(inspection.artifactActions.configured, false);
  assert.equal(inspection.recommendedFiles.length, 0);
  assert.deepEqual(applied.writtenFiles, []);
  assert.equal(applied.acceptedEvents[0].type, "InitialTeamCreated");
  assert.match(readHunsuEventText(repo), /InitialTeamCreated/);
});

test("CLI init creates the MVP .hunsu layout", async () => {
  const repo = createRepo();

  const output = await captureCli(repo, ["init"]);

  assert.match(output, /Initialized Hunsu/);
  assert.equal(existsSync(join(repo, ".hunsu", "config.yml")), true);
  assert.equal(existsSync(join(repo, ".hunsu", "templates", "move.md")), true);
  assert.equal(existsSync(join(repo, ".hunsu", "templates", "hunsu.md")), true);
  assert.equal(existsSync(join(repo, ".hunsu", "runner", "codex.yml")), true);
  assert.equal(HUNSU_RUNTIME_PATHS.every(path => existsSync(join(repo, path))), true);
  assert.deepEqual(readHunsuEvents(repo), []);
  assert.equal(existsSync(join(repo, ".hunsu", "cache")), true);
  assert.equal(existsSync(join(repo, ".hunsu", "logs")), true);
  assert.equal(existsSync(join(repo, ".hunsu", "events")), false);
});

test("Hunsu runtime state decodes deterministically from a commit SHA", async () => {
  const repo = createRepo();
  writeFileSync(join(repo, "request.md"), "Create the Studio control plane.\n", "utf8");
  writeFileSync(join(repo, "destinations.md"), "- Persist runtime state\n", "utf8");

  await captureCli(repo, [
    "request",
    "create",
    "--id",
    "req_state",
    "--title",
    "Runtime State",
    "--file",
    "request.md",
    "--destinations",
    "destinations.md",
    "--write"
  ]);
  const commit = run("git", ["rev-parse", "HEAD"], repo).trim();
  const first = readHunsuRuntimeStateAtRef(repo, commit);
  const firstFiles = readRuntimeFilesAtCommit(repo, commit);

  writeFileSync(join(repo, HUNSU_DESTINATIONS_PATH), readFileSync(join(repo, HUNSU_DESTINATIONS_PATH), "utf8").replace("HUNSU_RUNTIME_FILE_V1", "CORRUPTED"), "utf8");
  const second = readHunsuRuntimeStateAtRef(repo, commit);
  const secondFiles = readRuntimeFilesAtCommit(repo, commit);

  assert.deepEqual(second?.runtime.eventLog.events, first?.runtime.eventLog.events);
  assert.deepEqual(secondFiles, firstFiles);
  assert.equal(second?.checksum, first?.checksum);
});

test("Hunsu runtime commits do not include unrelated staged files", async () => {
  const repo = createRepo();
  writeFileSync(join(repo, "request.md"), "Create the Studio control plane.\n", "utf8");
  writeFileSync(join(repo, "destinations.md"), "- Persist runtime state\n", "utf8");
  writeFileSync(join(repo, "unrelated.txt"), "keep staged\n", "utf8");
  run("git", ["add", "unrelated.txt"], repo);

  await captureCli(repo, [
    "request",
    "create",
    "--id",
    "req_boundary",
    "--title",
    "Runtime Boundary",
    "--file",
    "request.md",
    "--destinations",
    "destinations.md",
    "--write"
  ]);

  assert.throws(() => run("git", ["show", "HEAD:unrelated.txt"], repo), /path 'unrelated.txt' exists on disk, but not in 'HEAD'/);
  assert.match(run("git", ["status", "--short"], repo), /^A  unrelated\.txt/m);
});

function createRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "hunsu-test-"));
  run("git", ["init", "-b", "main"], repo);
  run("git", ["config", "user.email", "test@hunsu.app"], repo);
  run("git", ["config", "user.name", "Test User"], repo);
  return repo;
}

function run(command: string, args: string[], cwd: string): string {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed\n${result.stderr}\n${result.stdout}`);
  }
  return result.stdout;
}

function readHunsuEventText(cwd: string): string {
  return JSON.stringify(readHunsuEvents(cwd));
}

function readHunsuEvents(cwd: string): unknown[] {
  const text = readFileSync(join(cwd, HUNSU_DESTINATIONS_PATH), "utf8");
  const decoded = decodeHunsuRuntimeFileText<{ compatibility: { events: unknown[] } }>(text, HUNSU_DESTINATIONS_PATH);
  assert.equal(decoded.ok, true);
  return decoded.value.compatibility.events;
}

function readRuntimeFilesAtCommit(cwd: string, commit: string): unknown[] {
  return HUNSU_RUNTIME_PATHS.map(path => {
    const decoded = decodeHunsuRuntimeFileText(run("git", ["show", `${commit}:${path}`], cwd), path);
    assert.equal(decoded.ok, true);
    return decoded.value;
  });
}

function writeActionFixture(repo: string): void {
  writeFileSync(join(repo, "docker-compose.yml"), "services:\n  web:\n    image: node:22\n  api:\n    image: node:22\n", "utf8");
}

function addHostAction(repo: string, board: BoardProjection): void {
  const line = board.lines[0];
  if (!line) {
    throw new Error("Expected ported fixture to include a line");
  }
  const sourceNode = board.nodes.find(node => node.id === line.currentNodeId);
  if (!sourceNode) {
    throw new Error("Expected ported fixture current line to point at a node");
  }
  const action = {
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
      web: { service: "web", containerPort: 5173 },
      api: { service: "api", containerPort: 4187 }
    },
    displayOrder: 1
  } as unknown as ArtifactActionDefinition;
  writeCommands([hunsuRuntimeChangeCommand({
    hunsuId: "H0001",
    sourceLineId: String(line.id),
    sourceNode,
    newLineId: `${line.id}/fork-H0001`,
    summary: "Add host-web Artifact Action.",
    artifactActions: [...sourceNode.artifactActions.map(cloneTestJson), action]
  })], { cwd: repo });
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

async function captureCli(cwd: string, argv: string[]): Promise<string> {
  const result = await captureCliExit(cwd, argv);
  assert.equal(result.code, 0);
  return result.stdout;
}

async function captureCliExit(cwd: string, argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const originalCwd = process.cwd();
  const originalLog = console.log;
  const originalError = console.error;
  const lines: string[] = [];
  const errors: string[] = [];
  console.log = (...values: unknown[]) => {
    lines.push(values.join(" "));
  };
  console.error = (...values: unknown[]) => {
    errors.push(values.join(" "));
  };

  try {
    process.chdir(cwd);
    const code = await main(argv);
    return { code, stdout: lines.join("\n"), stderr: errors.join("\n") };
  } finally {
    process.chdir(originalCwd);
    console.log = originalLog;
    console.error = originalError;
  }
}

function latestHunsuNodeId(board: { hunsus: Array<{ toNodeId?: string }> }): string {
  const nodeId = board.hunsus.at(-1)?.toNodeId;
  if (typeof nodeId !== "string") {
    throw new Error("Expected latest HUNSU to reference a node");
  }
  return nodeId;
}

function protocolMember(
  board: { nodes: Array<{ id: string; harness: { members: Array<Record<string, unknown> & { id: string }> } }> },
  nodeId: string,
  executorId: string
): { promptTemplate: { template: string }; skills: Array<{ name: string; snapshotFiles?: Array<{ path: string; text: string }> }>; model: string; reasoningEffort: string; serviceTier?: string } {
  const node = board.nodes.find(candidate => candidate.id === nodeId);
  assert.ok(node);
  const member = node.harness.members.find(candidate => candidate.id === executorId);
  assert.ok(member);
  return member as unknown as { promptTemplate: { template: string }; skills: Array<{ name: string; snapshotFiles?: Array<{ path: string; text: string }> }>; model: string; reasoningEffort: string; serviceTier?: string };
}
