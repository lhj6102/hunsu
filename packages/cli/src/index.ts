#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildMoveCommitMessage,
  buildHunsuCommitMessage,
  createHunsuCommit,
  createMoveCommit,
  createSquashMoveCommit,
  defaultHunsuRun,
  dryRunCommands,
  ensureGitRepository,
  git,
  initializeDomainStore,
  listArtifactActions,
  listArtifactActionRuns,
  loadBoardFromGit,
  loadDomainStore,
  inspectHunsuPort,
  nextHunsuId,
  applyHunsuPort,
  planHunsuPort,
  planArtifactActionRun,
  readArtifactActionRun,
  resolveMove,
  parseMoveEventStatus,
  startArtifactActionRun,
  stopArtifactActionRun,
  updateMainToMove,
  writeCommands
} from "@hunsu/core";
import { startStudioBridge } from "@hunsu/bridge";
import type { ArtifactActionRunInput, ArtifactActionRunPlan, ArtifactActionRunRecord, Board, HunsuEvent, HunsuPortPlan, MoveEvent, MoveEventStatus, RunTimeline } from "@hunsu/core";
import { validateHarness } from "@hunsu/protocol";
import type { BoardProjection, Command, DomainEvent, HarnessSnapshot, NodeRecord, Destination, DestinationSeedInput } from "@hunsu/protocol";

type ParsedArgs = {
  command?: string;
  rest: string[];
  flags: Map<string, string | boolean>;
};

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const parsed = parseArgs(argv);

  try {
    switch (parsed.command) {
      case "init":
        initCommand();
        return 0;
      case "board":
        boardCommand(parsed);
        return 0;
      case "run":
      case "execute":
        runCommand(parsed);
        return 0;
      case "runs":
        runsCommand(parsed);
        return 0;
      case "studio":
        await studioCommand(parsed);
        return 0;
      case "request":
      case "roadmap":
        requestCommand(parsed);
        return 0;
      case "destination":
      case "destination":
        destinationCommand(parsed);
        return 0;
      case "show":
        showCommand(parsed);
        return 0;
      case "move":
        moveCommand(parsed);
        return 0;
      case "hunsu":
        hunsuCommand(parsed);
        return 0;
      case "port":
        portCommand(parsed);
        return 0;
      case "executing-protocol":
      case "executing-protocol":
        harnessCommand(parsed);
        return 0;
      case "member":
        memberCommand(parsed);
        return 0;
      case "select":
        selectCommand(parsed);
        return 0;
      case "action":
        actionCommand(parsed);
        return 0;
      case "help":
      case undefined:
        printHelp();
        return 0;
      default:
        throw new Error(`Unknown command: ${parsed.command}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    return 1;
  }
}

function initCommand(): void {
  const root = ensureGitRepository();
  const hunsuDir = join(root, ".hunsu");
  mkdirSync(join(hunsuDir, "cache"), { recursive: true });
  mkdirSync(join(hunsuDir, "templates"), { recursive: true });
  mkdirSync(join(hunsuDir, "runner"), { recursive: true });
  mkdirSync(join(hunsuDir, "logs"), { recursive: true });
  writeIfMissing(join(hunsuDir, "config.yml"), defaultConfig());
  writeIfMissing(join(hunsuDir, "templates", "move.md"), defaultMoveTemplate());
  writeIfMissing(join(hunsuDir, "templates", "hunsu.md"), defaultHunsuTemplate());
  writeIfMissing(join(hunsuDir, "runner", "codex.yml"), "enabled: true\n");
  initializeDomainStore(root);
  console.log(`Initialized Hunsu at ${hunsuDir}`);
}

async function studioCommand(parsed: ParsedArgs): Promise<void> {
  await startStudioBridge({
    cwd: getFlag(parsed, "cwd") ?? process.cwd(),
    webUrl: getFlag(parsed, "web-url"),
    noOpen: hasFlag(parsed, "no-open"),
    dryRun: hasFlag(parsed, "dry-run"),
    json: hasFlag(parsed, "json")
  });
}

function boardCommand(parsed: ParsedArgs): void {
  const board = loadBoardFromGit();
  const runFilter = getFlag(parsed, "run");
  const runs = runFilter ? board.runs.filter(run => run.runId === runFilter) : board.runs;

  if (hasFlag(parsed, "json")) {
    console.log(JSON.stringify(formatBoardJson(board, runs), null, 2));
    return;
  }

  if (runs.length === 0) {
    console.log(runFilter ? `No run found for ${runFilter}` : "No Hunsu board events found.");
    return;
  }

  console.log("Hunsu board");
  for (const run of runs) {
    console.log(formatRun(run));
  }
}

function runsCommand(parsed: ParsedArgs): void {
  const board = loadBoardFromGit();
  if (hasFlag(parsed, "json")) {
    console.log(JSON.stringify(board.runs.map(formatRunJson), null, 2));
    return;
  }
  if (board.runs.length === 0) {
    console.log("No Hunsu runs found.");
    return;
  }
  for (const run of board.runs) {
    console.log(`${run.runId}  moves:${run.moves.length}  hunsus:${run.hunsus.length}`);
  }
}

function showCommand(parsed: ParsedArgs): void {
  const selector = parsed.rest[0];
  if (!selector) {
    throw new Error("Usage: hunsu show <move-id|commit-sha>");
  }
  const board = loadBoardFromGit();
  const move = resolveMove(board, selector, { runId: getFlag(parsed, "run") });
  if (hasFlag(parsed, "json")) {
    console.log(JSON.stringify(formatMoveDetailJson(move, board), null, 2));
    return;
  }
  console.log(formatMoveDetail(move, board));
}

function requestCommand(parsed: ParsedArgs): void {
  const subcommand = parsed.rest[0];
  switch (subcommand) {
    case "port":
      portCommand({ ...parsed, rest: parsed.rest.slice(1) });
      return;
    case "create":
      requestCreateCommand(parsed);
      return;
    case "show":
      requestShowCommand(parsed);
      return;
    default:
      throw new Error("Usage: hunsu request <create|show>");
  }
}

function runCommand(parsed: ParsedArgs): void {
  const subcommand = parsed.rest[0];
  switch (subcommand) {
    case "start":
      runStartCommand(parsed);
      return;
    case "pause":
      runPauseCommand(parsed);
      return;
    case "resume":
      runResumeCommand(parsed);
      return;
    case "status":
      runStatusCommand(parsed);
      return;
    default:
      throw new Error("Usage: hunsu run <start|pause|resume|status>");
  }
}

function runStartCommand(parsed: ParsedArgs): void {
  const requestId = requiredFlag(parsed, "request");
  const lineId = getFlag(parsed, "id") ?? getFlag(parsed, "line") ?? `run/${requestId}`;
  const command: Command = {
    type: "StartLine",
    requestId,
    lineId
  };
  const result = runDomainCommands(parsed, [command], `hunsu: start line ${lineId}`);
  printDomainMutationResult(parsed, result, `${hasFlag(parsed, "write") ? "Started" : "Dry run: would start"} ${lineId}`);
}

function runPauseCommand(parsed: ParsedArgs): void {
  const lineId = parsed.rest[1];
  if (!lineId) {
    throw new Error("Usage: hunsu run pause <run-id> [--write]");
  }
  const command: Command = {
    type: "PauseLine",
    lineId
  };
  const result = runDomainCommands(parsed, [command], `hunsu: pause line ${lineId}`);
  printDomainMutationResult(parsed, result, `${hasFlag(parsed, "write") ? "Paused" : "Dry run: would pause"} ${lineId}`);
}

function runResumeCommand(parsed: ParsedArgs): void {
  const lineId = parsed.rest[1];
  if (!lineId) {
    throw new Error("Usage: hunsu run resume <run-id> [--write]");
  }
  const command: Command = {
    type: "ResumeLine",
    lineId
  };
  const result = runDomainCommands(parsed, [command], `hunsu: resume line ${lineId}`);
  printDomainMutationResult(parsed, result, `${hasFlag(parsed, "write") ? "Resumed" : "Dry run: would resume"} ${lineId}`);
}

function runStatusCommand(parsed: ParsedArgs): void {
  const lineId = parsed.rest[1];
  if (!lineId) {
    throw new Error("Usage: hunsu run status <run-id> [--json]");
  }
  const board = loadDomainStore().board;
  const line = board.lines.find(candidate => candidate.id === lineId);
  if (!line) {
    throw new Error(`No run found for ${lineId}`);
  }
  const requestDestinations = board.destinations.filter(destination => destination.requestId === line.requestId);
  const result = {
    ...line,
    destinations: {
      pending: requestDestinations.filter(destination => destination.status === "pending").map(destination => destination.id),
      blocked: requestDestinations.filter(destination => destination.status === "blocked").map(destination => destination.id),
      reached: requestDestinations.filter(destination => destination.status === "reached").map(destination => destination.id)
    },
    moves: board.moves.filter(move => move.lineId === line.id)
  };
  if (hasFlag(parsed, "json")) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`${line.id} ${line.status}  moves:${line.moveIds.length}  pending:${result.destinations.pending.length}`);
}

function requestCreateCommand(parsed: ParsedArgs): void {
  const title = requiredFlag(parsed, "title");
  const requestFile = requiredFlag(parsed, "file");
  const destinationsFile = getFlag(parsed, "destinations") ?? getFlag(parsed, "destinations");
  if (!destinationsFile) {
    throw new Error("Missing --destinations");
  }
  const requestId = getFlag(parsed, "id") ?? createId("req", title);
  const lineId = getFlag(parsed, "line") ?? `run/${requestId}`;
  const goal = readFileSync(requestFile, "utf8").trim();
  const destinations = parseDestinationsFile(destinationsFile);
  const harnessFile = getFlag(parsed, "executing-protocol") ?? getFlag(parsed, "executing-protocol");
  const harness = harnessFile ? parseHarnessFile(harnessFile) : undefined;
  const commands: Command[] = [
    {
      type: "CreateInitialTeam",
      requestId,
      lineId,
      title,
      goal,
      destinations,
      harness
    }
  ];

  const result = runDomainCommands(parsed, commands, `hunsu: create initial Team ${lineId}`);
  if (hasFlag(parsed, "json")) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`${hasFlag(parsed, "write") ? "Created" : "Dry run: would create"} Initial Team ${lineId}`);
  console.log(`${lineId}  destinations:${destinations.length}`);
}

function requestShowCommand(parsed: ParsedArgs): void {
  const requestId = parsed.rest[1];
  if (!requestId) {
    throw new Error("Usage: hunsu request show <request-id> [--json]");
  }
  const board = loadDomainStore().board;
  const request = board.requests.find(candidate => candidate.id === requestId);
  if (!request) {
    throw new Error(`No request found for ${requestId}`);
  }
  const result = formatRequestJson(board, requestId);
  if (hasFlag(parsed, "json")) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`${request.id} ${request.title}`);
  console.log(`Destinations: ${result.destinations.length}`);
  console.log(`Lines: ${result.lines.length}`);
}

function destinationCommand(parsed: ParsedArgs): void {
  const subcommand = parsed.rest[0];
  switch (subcommand) {
    case "list":
      destinationListCommand(parsed);
      return;
    case "claim":
      destinationClaimCommand(parsed);
      return;
    case "start":
      destinationStartCommand(parsed);
      return;
	    case "block":
	      destinationBlockCommand(parsed);
	      return;
	    default:
	      throw new Error("Usage: hunsu destination <list|claim|start|block>");
	  }
	}

function destinationListCommand(parsed: ParsedArgs): void {
  const requestId = requiredFlag(parsed, "request");
  const destinations = loadDomainStore().board.destinations.filter(destination => destination.requestId === requestId);
  if (hasFlag(parsed, "json")) {
    console.log(JSON.stringify(destinations, null, 2));
    return;
  }
  if (destinations.length === 0) {
    console.log(`No Destinations found for ${requestId}`);
    return;
  }
  for (const destination of destinations) {
    console.log(`${destination.id} ${destination.status} p:${destination.priority ?? 0} ${destination.title}`);
  }
}

function destinationClaimCommand(parsed: ParsedArgs): void {
  const destinationId = parsed.rest[1];
  if (!destinationId) {
    throw new Error("Usage: hunsu destination claim <destination-id> [--actor <actor>] [--write]");
  }
  const command: Command = {
    type: "ClaimDestination",
    destinationId,
    actor: getFlag(parsed, "actor") ?? "codex"
  };
  const result = runDomainCommands(parsed, [command], `hunsu: claim destination ${destinationId}`);
  printDomainMutationResult(parsed, result, `${hasFlag(parsed, "write") ? "Claimed" : "Dry run: would claim"} Destination ${destinationId}`);
}

function destinationStartCommand(parsed: ParsedArgs): void {
  const destinationId = parsed.rest[1];
  if (!destinationId) {
    throw new Error("Usage: hunsu destination start <destination-id> [--actor <actor>] [--write]");
  }
  const command: Command = {
    type: "StartDestinationWork",
    destinationId,
    actor: getFlag(parsed, "actor") ?? "codex"
  };
  const result = runDomainCommands(parsed, [command], `hunsu: start destination ${destinationId}`);
  printDomainMutationResult(parsed, result, `${hasFlag(parsed, "write") ? "Started" : "Dry run: would start"} Destination ${destinationId}`);
}

function destinationBlockCommand(parsed: ParsedArgs): void {
  const destinationId = parsed.rest[1];
  if (!destinationId) {
    throw new Error("Usage: hunsu destination block <destination-id> --reason <reason> [--actor <actor>] [--write]");
  }
  const command: Command = {
    type: "ReportDestinationBlocked",
    destinationId,
    reason: requiredFlag(parsed, "reason"),
    actor: getFlag(parsed, "actor") ?? "codex"
  };
  const result = runDomainCommands(parsed, [command], `hunsu: block destination ${destinationId}`);
  printDomainMutationResult(parsed, result, `${hasFlag(parsed, "write") ? "Blocked" : "Dry run: would block"} Destination ${destinationId}`);
}

function destinationUnblockCommand(parsed: ParsedArgs): void {
  throwDraftRuntimeFileWorkflow("destination unblock");
}

function destinationAddCommand(parsed: ParsedArgs): void {
  throwDraftRuntimeFileWorkflow("destination add");
}

function destinationEditCommand(parsed: ParsedArgs): void {
  throwDraftRuntimeFileWorkflow("destination edit");
}

function destinationCancelCommand(parsed: ParsedArgs): void {
  throwDraftRuntimeFileWorkflow("destination cancel");
}

function destinationReprioritizeCommand(parsed: ParsedArgs): void {
  throwDraftRuntimeFileWorkflow("destination reprioritize");
}

function throwDraftRuntimeFileWorkflow(command: string): never {
  throw new Error(`${command} is no longer a direct CLI mutation. Start a Hunsu Draft, edit .hunsu-request runtime files, create a DiffArtifact with the Draft check command, then confirm that DiffArtifact in Studio.`);
}

function moveCommand(parsed: ParsedArgs): void {
  const subcommand = parsed.rest[0];
  if (subcommand === "reach") {
    moveReachCommand(parsed);
    return;
  }
  if (subcommand !== "commit" && subcommand !== "squash") {
    throw new Error("Usage: hunsu move <commit|squash|reach> --run <run> --goal <goal> --move <number>");
  }
  const run = requiredFlag(parsed, "run");
  const goal = requiredFlag(parsed, "goal");
  const move = getFlag(parsed, "move") ?? getFlag(parsed, "number") ?? "0001";
  const message = buildMoveCommitMessage({
    run,
    goal,
    move,
    summary: getFlag(parsed, "summary"),
    why: getFlag(parsed, "why"),
    alternatives: getFlag(parsed, "alternatives"),
    evidence: getFlag(parsed, "evidence"),
    risks: getFlag(parsed, "risks"),
    next: getFlag(parsed, "next"),
    role: getFlag(parsed, "role"),
    actor: getFlag(parsed, "actor"),
    status: parseMoveStatus(getFlag(parsed, "status"))
  });

  if (subcommand === "squash") {
    const fromRef = requiredFlag(parsed, "from");
    if (parsed.flags.get("write") === true) {
      const result = createSquashMoveCommit({ fromRef, runRef: run, message });
      console.log(`Created squash move ${result.commitSha}`);
      console.log(`Updated ${result.runRef}`);
      return;
    }
    console.log(`Dry run: would squash ${fromRef} onto ${run}`);
    console.log(message.trimEnd());
    return;
  }

  if (parsed.flags.get("write") === true) {
    const result = createMoveCommit(message);
    console.log(`Created move commit ${result.commitSha}`);
    return;
  }

  console.log(message.trimEnd());
}

function moveReachCommand(parsed: ParsedArgs): void {
  const lineId = requiredFlag(parsed, "run");
  const destinationId = getFlag(parsed, "destination") ?? requiredFlag(parsed, "destination");
  const fromRef = requiredFlag(parsed, "from");
  const board = loadDomainStore().board;
  const moveId = getFlag(parsed, "move") ?? nextDomainMoveId(board);
  const summary = requiredFlag(parsed, "summary");
  const commit = git(["rev-parse", "--verify", fromRef]).trim();
  const reachedDestinationIds = splitList(destinationId);
  if (reachedDestinationIds.length !== 1) {
    throw new Error("MOVE must reach exactly one Destination");
  }
  const evidence = splitList(getFlag(parsed, "evidence"));
  const risks = splitList(getFlag(parsed, "risks"));
  const command: Command = {
    type: "RecordMove",
    lineId,
    moveId,
    summary,
    commit,
    reachedDestinationIds: [reachedDestinationIds[0] as string],
    evidence,
    risks: risks.length > 0 ? risks : undefined,
    actor: getFlag(parsed, "actor") ?? "codex"
  };
  const result = runDomainCommands(parsed, [command], `hunsu: record move ${moveId}`);
  printDomainMutationResult(parsed, result, `${hasFlag(parsed, "write") ? "Recorded" : "Dry run: would record"} MOVE ${moveId}`);
}

function hunsuCommand(parsed: ParsedArgs): void {
  if (parsed.rest[0] === "create") {
    hunsuCreateCommand(parsed);
    return;
  }
  if (parsed.rest[0] === "apply") {
    hunsuApplyCommand(parsed);
    return;
  }
  const [selector, artifactPath] = parsed.rest;
  if (!selector || !artifactPath) {
    throw new Error("Usage: hunsu hunsu <move-id|commit-sha> <artifact.md> [--write]");
  }
  const board = loadBoardFromGit();
  const targetMove = resolveMove(board, selector, { runId: getFlag(parsed, "run") });
  const id = getFlag(parsed, "id") ?? nextHunsuId(board);
  const newRun = getFlag(parsed, "new-run") ?? defaultHunsuRun(targetMove.runId, id);
  const artifactText = readFileSync(artifactPath, "utf8");
  const options = {
    id,
    targetMove,
    newRun,
    artifactText,
    actor: getFlag(parsed, "actor"),
    role: getFlag(parsed, "role"),
    priority: getFlag(parsed, "priority")
  };

  if (parsed.flags.get("write") === true) {
    const result = createHunsuCommit(options);
    console.log(`Created ${result.runRef} at ${result.commitSha}`);
    console.log(`Created ${result.markerRef}`);
    console.log(`Recorded ${result.artifactPath}`);
    return;
  }

  console.log(`Dry run: would create ${newRun} from ${targetMove.commit.sha}`);
  console.log(buildHunsuCommitMessage(options).trimEnd());
}

function hunsuCreateCommand(parsed: ParsedArgs): void {
  throwDraftRuntimeFileWorkflow("hunsu create");
}

function hunsuApplyCommand(parsed: ParsedArgs): void {
  const hunsuId = parsed.rest[1];
  if (!hunsuId) {
    throw new Error("Usage: hunsu hunsu apply <hunsu-id> [--json]");
  }
  const board = loadDomainStore().board;
  const hunsu = board.hunsus.find(candidate => candidate.id === hunsuId);
  if (!hunsu) {
    throw new Error(`No HUNSU found for ${hunsuId}`);
  }
  const result = { hunsu, status: "already-applied" };
  if (hasFlag(parsed, "json")) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`${hunsu.id} already applied`);
}

function harnessCommand(parsed: ParsedArgs): void {
  const subcommand = parsed.rest[0];
  switch (subcommand) {
    case "show":
      harnessShowCommand(parsed);
      return;
    case "set":
      harnessSetCommand(parsed);
      return;
    default:
      throw new Error("Usage: hunsu executing-protocol <show|set>");
  }
}

function harnessShowCommand(parsed: ParsedArgs): void {
  const from = requiredFlag(parsed, "from");
  const board = loadDomainStore().board;
  const source = sourceNodeFromSelector(board, from);
  if (hasFlag(parsed, "json")) {
    console.log(JSON.stringify(source.node.harness, null, 2));
    return;
  }
  console.log(`${from} ${formatHarnessKind(source.node.harness.kind)}`);
  console.log(JSON.stringify(source.node.harness, null, 2));
}

function harnessSetCommand(parsed: ParsedArgs): void {
  throwDraftRuntimeFileWorkflow("executing-protocol set");
}

function memberCommand(parsed: ParsedArgs): void {
  const section = parsed.rest[0];
  const action = parsed.rest[1];
  if (action !== "set" && !(section === "skill" && (action === "add" || action === "remove"))) {
    throw new Error("Usage: hunsu member <prompt|model|reasoning|service-tier> set --from <move-id> --member <member-id> ...");
  }
  switch (section) {
    case "prompt":
      memberPromptSetCommand(parsed);
      return;
    case "model":
      memberModelSetCommand(parsed);
      return;
    case "reasoning":
      memberReasoningSetCommand(parsed);
      return;
    case "service-tier":
      memberServiceTierSetCommand(parsed);
      return;
    case "skill":
      if (action === "add") {
        memberSkillAddCommand(parsed);
        return;
      }
      memberSkillRemoveCommand(parsed);
      return;
    default:
      throw new Error("Usage: hunsu member <prompt|model|reasoning|service-tier|skill>");
  }
}

function memberPromptSetCommand(parsed: ParsedArgs): void {
  throwDraftRuntimeFileWorkflow("member prompt set");
}

function memberModelSetCommand(parsed: ParsedArgs): void {
  throwDraftRuntimeFileWorkflow("member model set");
}

function memberReasoningSetCommand(parsed: ParsedArgs): void {
  throwDraftRuntimeFileWorkflow("member reasoning set");
}

function memberServiceTierSetCommand(parsed: ParsedArgs): void {
  throwDraftRuntimeFileWorkflow("member service-tier set");
}

function memberSkillAddCommand(parsed: ParsedArgs): void {
  throwDraftRuntimeFileWorkflow("member skill add");
}

function memberSkillRemoveCommand(parsed: ParsedArgs): void {
  throwDraftRuntimeFileWorkflow("member skill remove");
}

function selectCommand(parsed: ParsedArgs): void {
  const [runId, selector] = parsed.rest;
  if (!runId || !selector) {
    throw new Error("Usage: hunsu select <run> <move-id|commit-sha> [--write --allow-write-main]");
  }
  const board = loadBoardFromGit();
  const move = resolveMove(board, selector, { runId });
  if (parsed.flags.get("write") === true) {
    if (parsed.flags.get("allow-write-main") !== true) {
      throw new Error("Refusing to update main without --allow-write-main");
    }
    updateMainToMove(move);
    console.log(`Updated main to ${move.commit.sha}`);
    return;
  }
  console.log(`Dry run: main would point to ${move.runId}:${move.moveId}@${move.commit.sha}`);
}

function portCommand(parsed: ParsedArgs): void {
  const subcommand = parsed.rest[0];
  switch (subcommand) {
    case "inspect":
      portInspectCommand(parsed);
      return;
    case "plan":
      portPlanCommand(parsed);
      return;
    case "apply":
      portApplyCommand(parsed);
      return;
    default:
      throw new Error("Usage: hunsu port <inspect|plan|apply> <path>");
  }
}

function portInspectCommand(parsed: ParsedArgs): void {
  const path = parsed.rest[1];
  if (!path) {
    throw new Error("Usage: hunsu port inspect <path> [--json]");
  }
  const inspection = inspectHunsuPort(path);
  if (hasFlag(parsed, "json")) {
    console.log(JSON.stringify(inspection, null, 2));
    return;
  }
  console.log(`Hunsu Port inspection: ${inspection.root}`);
  console.log(`Git: ${inspection.isGitRepository ? "yes" : "no"}`);
  console.log(`Roadmap: ${inspection.isHunsuRoadmap ? "yes" : "no"}`);
  console.log(`Package manager: ${inspection.packageManager ?? "unknown"}`);
  console.log(`Artifact Actions: ${inspection.artifactActions.configured ? inspection.artifactActions.count : "none"}`);
  for (const file of inspection.recommendedFiles) {
    console.log(`Create ${file.path}: ${file.reason}`);
  }
  for (const issue of inspection.issues) {
    console.log(`Issue: ${issue}`);
  }
}

function portPlanCommand(parsed: ParsedArgs): void {
  const plan = planHunsuPort(portInputFromFlags(parsed));
  if (hasFlag(parsed, "json")) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }
  printPortPlan(plan);
}

function portApplyCommand(parsed: ParsedArgs): void {
  const input = portInputFromFlags(parsed);
  if (!hasFlag(parsed, "write")) {
    const plan = planHunsuPort(input);
    if (hasFlag(parsed, "json")) {
      console.log(JSON.stringify({ dryRun: true, plan }, null, 2));
      return;
    }
    console.log("Dry run: would apply Hunsu Port");
    printPortPlan(plan);
    return;
  }
  const result = applyHunsuPort(input);
  if (hasFlag(parsed, "json")) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`Ported ${result.root}`);
  console.log(`Files: ${result.writtenFiles.length > 0 ? result.writtenFiles.join(", ") : "none"}`);
  console.log(`Events: ${result.acceptedEvents.map(event => event.type).join(", ") || "none"}`);
}

function portInputFromFlags(parsed: ParsedArgs): Parameters<typeof planHunsuPort>[0] {
  const path = parsed.rest[1];
  if (!path) {
    throw new Error("Usage: hunsu port <plan|apply> <path> --title <title> --goal <goal>");
  }
  return {
    cwd: path,
    title: getFlag(parsed, "title"),
    goal: getFlag(parsed, "goal"),
    destinations: parsePortDestinations(parsed)
  };
}

function parsePortDestinations(parsed: ParsedArgs): DestinationSeedInput[] | undefined {
  const destinationsFile = getFlag(parsed, "destinations");
  if (destinationsFile) {
    return parseDestinationsFile(destinationsFile);
  }
  const destination = getFlag(parsed, "destination");
  if (!destination) {
    return undefined;
  }
  return splitList(destination).map((title, index) => ({
    id: `destination_${String(index + 1).padStart(3, "0")}`,
    title,
    priority: Math.max(0, 100 - index)
  }));
}

function printPortPlan(plan: HunsuPortPlan): void {
  console.log(`Hunsu Port plan: ${plan.root}`);
  console.log(`Title: ${plan.title}`);
  console.log(`Goal: ${plan.goal}`);
  console.log(`Destinations: ${plan.destinations.map(destination => destination.title).join(", ")}`);
  console.log(`Roadmap events: ${plan.commands.length}`);
  if (plan.files.length === 0) {
    console.log("Files: none");
  } else {
    console.log("Files:");
    for (const file of plan.files) {
      console.log(`  ${file.action} ${file.path}`);
    }
  }
}

function actionCommand(parsed: ParsedArgs): void {
  const subcommand = parsed.rest[0];
  switch (subcommand) {
    case "list":
      actionListCommand(parsed);
      return;
    case "plan":
      actionPlanCommand(parsed);
      return;
    case "run":
      actionRunCommand(parsed);
      return;
    case "status":
      actionStatusCommand(parsed);
      return;
    case "stop":
      actionStopCommand(parsed);
      return;
    default:
      throw new Error("Usage: hunsu action <list|plan|run|status|stop>");
  }
}

function actionListCommand(parsed: ParsedArgs): void {
  const actions = listArtifactActions(process.cwd(), getFlag(parsed, "move"));
  if (hasFlag(parsed, "json")) {
    console.log(JSON.stringify({ actions }, null, 2));
    return;
  }
  if (actions.length === 0) {
    console.log("No Artifact Actions configured.");
    return;
  }
  for (const action of actions) {
    console.log(`${action.id} ${action.kind} ${action.title}`);
  }
}

function actionPlanCommand(parsed: ParsedArgs): void {
  const plan = planArtifactActionRun(actionInputFromFlags(parsed));
  if (hasFlag(parsed, "json")) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }
  printActionPlan(plan);
}

function actionRunCommand(parsed: ParsedArgs): void {
  const run = startArtifactActionRun(actionInputFromFlags(parsed));
  if (hasFlag(parsed, "json")) {
    console.log(JSON.stringify(run, null, 2));
    return;
  }
  printActionRun(run);
}

function actionStatusCommand(parsed: ParsedArgs): void {
  const runId = parsed.rest[1];
  if (runId) {
    const run = readArtifactActionRun(process.cwd(), runId);
    if (hasFlag(parsed, "json")) {
      console.log(JSON.stringify(run, null, 2));
      return;
    }
    printActionRun(run);
    return;
  }
  const runs = listArtifactActionRuns(process.cwd());
  if (hasFlag(parsed, "json")) {
    console.log(JSON.stringify({ runs }, null, 2));
    return;
  }
  if (runs.length === 0) {
    console.log("No Artifact Action Runs found.");
    return;
  }
  for (const run of runs) {
    const source = run.source.moveId ?? run.source.commit.slice(0, 12);
    console.log(`${run.runId} ${run.status} ${run.actionId} ${source}`);
  }
}

function actionStopCommand(parsed: ParsedArgs): void {
  const runId = parsed.rest[1];
  if (!runId) {
    throw new Error("Usage: hunsu action stop <run-id> [--json]");
  }
  const run = stopArtifactActionRun(process.cwd(), runId);
  if (hasFlag(parsed, "json")) {
    console.log(JSON.stringify(run, null, 2));
    return;
  }
  console.log(`Stopped Artifact Action Run ${run.runId}`);
}

function actionInputFromFlags(parsed: ParsedArgs): ArtifactActionRunInput {
  const actionId = parsed.rest[1] ?? getFlag(parsed, "action");
  if (!actionId) {
    throw new Error("Usage: hunsu action <plan|run> <action-id> [--move <move-id>|--commit <ref>]");
  }
  return {
    actionId,
    moveId: getFlag(parsed, "move"),
    commit: getFlag(parsed, "commit"),
    roadmapId: getFlag(parsed, "roadmap"),
    env: parseActionEnvOverrides(getFlag(parsed, "env"))
  };
}

function parseActionEnvOverrides(value: string | undefined): Record<string, string> | undefined {
  if (!value) {
    return undefined;
  }
  const entries = value
    .split(",")
    .map(item => item.trim())
    .filter(Boolean)
    .map(item => {
      const index = item.indexOf("=");
      if (index <= 0) {
        throw new Error(`Invalid --env entry: ${item}`);
      }
      return [item.slice(0, index), item.slice(index + 1)] as const;
    });
  return Object.fromEntries(entries);
}

function printActionPlan(plan: ArtifactActionRunPlan): void {
  printActionRun(plan.run);
  console.log("Commands:");
  for (const command of plan.commands) {
    console.log(`  ${command.command} ${command.args.join(" ")}`);
  }
}

function printActionRun(run: ArtifactActionRunRecord): void {
  console.log(`Artifact Action Run ${run.runId} ${run.status}`);
  console.log(`Action: ${run.actionId} (${run.action.kind})`);
  console.log(`Source: ${run.source.moveId ?? run.source.ref} ${run.source.commit.slice(0, 12)}`);
  for (const alias of Object.values(run.aliases ?? {})) {
    console.log(`Alias ${alias.alias}: ${alias.externalPath}${alias.directUrl ? ` -> ${alias.directUrl}` : ""}`);
  }
  if (run.exitCode !== undefined) {
    console.log(`Exit: ${run.exitCode}`);
  }
  if (run.error) {
    console.log(`Error: ${run.error}`);
  }
}

function formatRun(run: RunTimeline): string {
  const lines = [`\n${run.runId}  moves:${run.moves.length}  hunsus:${run.hunsus.length}`];
  for (const event of run.events) {
    if (event.type === "move") {
      lines.push(`  ${event.moveId} ${event.goal} ${event.status} ${event.commit.shortSha}`);
    } else {
      lines.push(`  ${event.hunsuId} hunsu from ${event.target.slice(0, 12)} -> ${event.newRun} ${event.commit.shortSha}`);
    }
  }
  return lines.join("\n");
}

function formatBoardJson(board: Board, runs: RunTimeline[]): object {
  return {
    runs: runs.map(formatRunJson),
    moves: board.moves.map(formatMoveJson),
    hunsus: board.hunsus.map(formatHunsuJson)
  };
}

function formatRunJson(run: RunTimeline): object {
  return {
    id: run.runId,
    moves: run.moves.map(move => move.moveId),
    hunsus: run.hunsus.map(hunsu => hunsu.hunsuId),
    events: run.events.map(event => (event.type === "move" ? { type: "move", id: event.moveId } : { type: "hunsu", id: event.hunsuId }))
  };
}

function formatMoveJson(move: MoveEvent): object {
  return {
    id: move.moveId,
    runId: move.runId,
    moveNumber: move.moveNumber,
    goal: move.goal,
    status: move.status,
    role: move.role,
    actor: move.actor,
    commit: move.commit.sha,
    shortCommit: move.commit.shortSha,
    subject: move.commit.subject
  };
}

function formatHunsuJson(hunsu: HunsuEvent): object {
  return {
    id: hunsu.hunsuId,
    target: hunsu.target,
    sourceRun: hunsu.sourceRun,
    newRun: hunsu.newRun,
    role: hunsu.role,
    actor: hunsu.actor,
    priority: hunsu.priority,
    commit: hunsu.commit.sha,
    shortCommit: hunsu.commit.shortSha
  };
}

function formatMoveDetailJson(move: MoveEvent, board: Board): object {
  const attached = board.hunsus.filter(hunsu => hunsu.target === move.commit.sha || move.commit.sha.startsWith(hunsu.target));
  return {
    move: formatMoveJson(move),
    hunsus: attached.map(formatHunsuJson)
  };
}

function runDomainCommands(parsed: ParsedArgs, commands: Command[], commitMessage: string): { acceptedEvents: DomainEvent[]; board: BoardProjection } {
  if (hasFlag(parsed, "write")) {
    return writeCommands(commands, { commitMessage });
  }
  const { acceptedEvents, board } = dryRunCommands(commands);
  return { acceptedEvents, board };
}

function printDomainMutationResult(
  parsed: ParsedArgs,
  result: { acceptedEvents: DomainEvent[]; board: BoardProjection },
  message: string
): void {
  if (hasFlag(parsed, "json")) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(message);
  console.log(`Events: ${result.acceptedEvents.map(event => event.type).join(", ")}`);
}

function formatRequestJson(board: BoardProjection, requestId: string): { request: object; destinations: Destination[]; lines: object[] } {
  const request = board.requests.find(candidate => candidate.id === requestId);
  if (!request) {
    throw new Error(`No request found for ${requestId}`);
  }
  return {
    request,
    destinations: board.destinations.filter(destination => destination.requestId === requestId),
    lines: board.lines
      .filter(line => line.requestId === requestId)
      .map(line => ({
        ...line,
        pendingDestinations: board.destinations
          .filter(destination => destination.requestId === requestId && (destination.status === "pending" || destination.status === "blocked"))
          .map(destination => destination.id)
      }))
  };
}

type ProtocolHunsuSource = {
  node: NodeRecord;
  lineId: string;
  sourceMoveId?: string;
  target: { type: "move"; id: string } | { type: "node"; id: string };
};

function sourceNodeFromSelector(board: BoardProjection, selector: string): ProtocolHunsuSource {
  const move = board.moves.find(candidate => candidate.id === selector);
  if (move) {
    if (!move.toNodeId) {
      throw new Error(`MOVE ${selector} has no Team Snapshot node`);
    }
    const node = board.nodes.find(candidate => candidate.id === move.toNodeId);
    if (!node) {
      throw new Error(`MOVE ${selector} node ${move.toNodeId} was not found`);
    }
    return { node, lineId: move.lineId, sourceMoveId: move.id, target: { type: "move", id: move.id } };
  }
  const node = board.nodes.find(candidate => candidate.id === selector);
  if (node?.lineId) {
    return { node, lineId: node.lineId, target: { type: "node", id: node.id } };
  }
  throw new Error(`No MOVE or node found for ${selector}`);
}

function parseMoveStatus(value: string | undefined): MoveEventStatus | undefined {
  if (value === undefined) {
    return undefined;
  }
  try {
    return parseMoveEventStatus(value, "CLI --status");
  } catch (_error) {
    throw new Error("--status must be one of: complete, failed, blocked");
  }
}

function formatHarnessKind(kind: HarnessSnapshot["kind"]): string {
  switch (kind) {
    case "team_execution_plan":
      return "team_execution_plan";
    case "role_squad":
      return "role_squad";
    case "council_vote":
      return "council_vote";
    case "court_debate":
      return "court_debate";
  }
}

function parseDestinationsFile(path: string): DestinationSeedInput[] {
  const lines = readFileSync(path, "utf8")
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .map(line => line.replace(/^[-*]\s+/, "").replace(/^\[[ xX]\]\s+/, "").trim())
    .filter(line => line.length > 0);
  return lines.map((title, index) => ({
    id: `destination_${String(index + 1).padStart(3, "0")}`,
    title,
    priority: Math.max(0, 100 - index)
  }));
}

function parseHarnessFile(path: string): HarnessSnapshot {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  const validation = validateHarness(parsed);
  if (!validation.ok) {
    throw new Error(`Invalid Harness JSON: ${path}: ${validation.error.message}`);
  }
  return validation.value;
}

function createId(prefix: string, value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  return `${prefix}_${slug || "untitled"}`;
}

function lineForRequest(board: BoardProjection, requestId: string): string {
  const requestLines = board.lines.filter(candidate => candidate.requestId === requestId && candidate.status !== "abandoned");
  const line = requestLines.findLast(candidate => candidate.status === "active") ?? requestLines.at(-1);
  if (!line) {
    throw new Error(`No line found for request ${requestId}`);
  }
  return line.id;
}

function findDestination(board: BoardProjection, destinationId: string): Destination {
  const destination = board.destinations.find(candidate => candidate.id === destinationId);
  if (!destination) {
    throw new Error(`No Destination found for ${destinationId}`);
  }
  return destination;
}

function resolveDomainTarget(board: BoardProjection, selector: string): { type: "destination"; id: string } | { type: "move"; id: string } | { type: "line"; id: string } {
  if (board.destinations.some(destination => destination.id === selector)) {
    return { type: "destination", id: selector };
  }
  if (board.moves.some(move => move.id === selector)) {
    return { type: "move", id: selector };
  }
  if (board.lines.some(line => line.id === selector)) {
    return { type: "line", id: selector };
  }
  throw new Error(`No Destination, MOVE, or route found for ${selector}`);
}

function lineForTarget(board: BoardProjection, target: { type: "destination"; id: string } | { type: "move"; id: string } | { type: "line"; id: string }): string {
  if (target.type === "line") {
    return target.id;
  }
  if (target.type === "move") {
    const move = board.moves.find(candidate => candidate.id === target.id);
    if (!move) {
      throw new Error(`No MOVE found for ${target.id}`);
    }
    return move.lineId;
  }
  return lineForRequest(board, findDestination(board, target.id).requestId);
}

function firstContentLine(text: string): string | undefined {
  return text
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(line => line.length > 0)
    ?.replace(/^#+\s*/, "");
}

function nextDomainHunsuId(board: BoardProjection): string {
  const highest = board.hunsus.reduce((max, hunsu) => {
    const match = hunsu.id.match(/^h(\d+)$/i);
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0);
  return `h${String(highest + 1).padStart(3, "0")}`;
}

function nextDomainMoveId(board: BoardProjection): string {
  const highest = board.moves.reduce((max, move) => {
    const match = move.id.match(/^M(\d+)$/i);
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0);
  return `M${String(highest + 1).padStart(4, "0")}`;
}

function splitList(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(",")
    .map(item => item.trim())
    .filter(item => item.length > 0);
}

function parseOptionalNumber(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Expected number, received ${value}`);
  }
  return parsed;
}

function removeUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

function formatMoveDetail(move: MoveEvent, board: Board): string {
  const attached = board.hunsus.filter(hunsu => hunsu.target === move.commit.sha || move.commit.sha.startsWith(hunsu.target));
  const lines = [
    `${move.runId}:${move.moveId}`,
    `Commit: ${move.commit.sha}`,
    `Goal: ${move.goal}`,
    `Status: ${move.status}`,
    `Role: ${move.role}`,
    `Actor: ${move.actor}`,
    `Subject: ${move.commit.subject}`
  ];

  if (attached.length > 0) {
    lines.push("Hunsus:");
    for (const hunsu of attached) {
      lines.push(`  ${formatHunsu(hunsu)}`);
    }
  }

  return lines.join("\n");
}

function formatHunsu(hunsu: HunsuEvent): string {
  return `${hunsu.hunsuId} ${hunsu.sourceRun} -> ${hunsu.newRun} ${hunsu.commit.shortSha}`;
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command, ...tokens] = argv;
  const rest: string[] = [];
  const flags = new Map<string, string | boolean>();

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith("--")) {
      rest.push(token);
      continue;
    }
    const flag = token.slice(2);
    const next = tokens[index + 1];
    if (!next || next.startsWith("--")) {
      flags.set(flag, true);
      continue;
    }
    flags.set(flag, next);
    index += 1;
  }

  return { command, rest, flags };
}

function getFlag(parsed: ParsedArgs, key: string): string | undefined {
  const value = parsed.flags.get(key);
  return typeof value === "string" ? value : undefined;
}

function hasFlag(parsed: ParsedArgs, key: string): boolean {
  return parsed.flags.get(key) === true;
}

function requiredFlag(parsed: ParsedArgs, key: string): string {
  const value = getFlag(parsed, key);
  if (!value) {
    throw new Error(`Missing --${key}`);
  }
  return value;
}

function writeIfMissing(path: string, contents: string): void {
  if (existsSync(path)) {
    return;
  }
  writeFileSync(path, contents, "utf8");
}

function defaultConfig(): string {
  return `runtime:
  default_runner: codex
  max_goal_minutes: 45

git:
  require_trailers: true
  main_mode: manual
  allow_write_main: false

members:
  default: [azir]
  verification: [galio]

approval:
  require_human_for:
    - write_main
    - database_migration
    - auth_policy_change
    - payment_flow_change
`;
}

function defaultMoveTemplate(): string {
  return `move: <summary>

Goal: <goal>
Why: <why>
Evidence: <evidence>
Risks: <risks>
Next: <next>

Hunsu-Event: move
Hunsu-Run: <run-id>
Hunsu-Move: <number>
Hunsu-Goal: <goal-id>
Hunsu-Role: team
Hunsu-Actor: agent:codex
Hunsu-Status: complete
`;
}

function defaultHunsuTemplate(): string {
  return `hunsu: <summary>

Observation: <what is wrong or worth exploring>
Instruction: <new direction to execute>
Acceptance: <how the new run will be judged>
Constraints: <limits or safety requirements>
`;
}

function printHelp(): void {
  console.log(`hunsu

Commands:
  init
  studio [--web-url <url>] [--no-open] [--dry-run] [--json]
  board [--run <route>]
  runs
  show <move-id|commit-sha> [--run <route>]
  roadmap create --title <title> --file request.md --destinations destinations.md [--write]
  roadmap show <request-id> [--json]
  roadmap port inspect <path> [--json]
  roadmap port apply <path> --title <title> --goal <goal> [--destination <title>] [--write]
  port inspect <path> [--json]
  port plan <path> --title <title> --goal <goal> [--destination <title>] [--json]
  port apply <path> --title <title> --goal <goal> [--destination <title>] [--write]
  destination list --request <request-id> [--json]
  destination claim <destination-id> [--actor <actor>] [--write]
  destination start <destination-id> [--actor <actor>] [--write]
  destination block <destination-id> --reason <reason> [--actor <actor>] [--write]
  execute start --request <request-id> [--id <route-id>] [--write]
  execute pause <route-id> [--write]
  execute resume <route-id> [--write]
  execute status <route-id> [--json]
  move commit --run <run> --goal <goal> --move <number>
  move squash --from <work-ref> --run <run> --goal <goal> --move <number> [--write]
  move reach --run <route-id> --destination <destination-id> --from <ref> --summary <summary> --evidence <evidence> [--write]
  hunsu apply <hunsu-id>
  hunsu <move-id|commit-sha> <artifact.md> [--write]
  executing-protocol show --from <move-id|node-id> [--json]
  select <run> <move-id|commit-sha> [--write --allow-write-main]
  action list [--move <move-id>] [--json]
  action plan <action-id> [--move <move-id>|--commit <ref>] [--roadmap <id>] [--env KEY=VALUE,...] [--json]
  action run <action-id> [--move <move-id>|--commit <ref>] [--roadmap <id>] [--env KEY=VALUE,...] [--json]
  action status [run-id] [--json]
  action stop <run-id> [--json]
`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  process.exitCode = await main();
}
