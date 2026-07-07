import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { buildTeamPlanningPrompt, type CodexProviderStatus, type TeamPlanningInput, type HunsuDraftSessionInput, type HunsuDraftTurnInput, type MoveFinalizerInput, type MemberPathRunInput, type ResumeRunInput, type Runner, type RunnerEvent, type RunnerRun } from "../packages/codex-runner/src/index.ts";
import { resolveLocalRuntimeConfig, unwrapConfigResult } from "../packages/config/src/index.ts";
import { createDefaultHarness, createDefaultManagerConfig, createDefaultMemberConfig, harnessEntityFromSnapshot, makeNodeId, makePositiveInteger, promptTemplateFromText, rootHarnessSnapshot, type HubPackageLock, type Harness, type HarnessSnapshot, type HunsuOrigin, type NonEmptyText, type ExecutionPlan } from "../packages/protocol/src/index.ts";
import {
  HUB_PACKAGE_MANIFEST_SCHEMA,
  computeManifestIntegrity,
  type HubPackageManifest,
  type ManagerPackageManifest,
  type TeamPackageManifest
} from "../packages/protocol-registry/src/index.ts";
import {
  boardFromEvents,
  applyStudioPort,
  browseFilesystem,
  completeStudioMoveFromExecuteCompletion,
  completeStudioMove,
  createFilesystemBrowseGrant,
  createStudioServer,
  createStudioRoadmap,
  createStudioState,
  decideStudioLine,
  executeStudioCommand,
  executeStudioCommands,
  findArtifact,
  listCodexSkills,
  listRoadmapRegistry,
  filesystemBrowseRoots,
  inspectStudioPort,
  openStudioRoadmap,
  pauseStudioRun,
  planStudioArtifactActionRun,
  readMoveFileBlob,
  readMoveDiff,
  readMoveFileTree,
  readWorktreeStatus,
  resumeStudioRun,
  resolveRoadmapRepositoryPath,
  selectStudioRepository,
  startStudioArtifactActionRun,
  startStudioRun,
  stopStudioRun,
  subscribeAgentSessionEvents,
  subscribeStudioLiveEvents,
  listCodexPlugins,
  materializeCodexSkillsForExecute,
  prepareMemberCodexEnvironmentForExecute,
  type AgentSessionEvent,
  type StudioLiveEvent,
  type StudioRunState
} from "../apps/local/src/index.ts";
import { HUNSU_CURRENT_EXECUTION_PATH, HUNSU_DESTINATIONS_PATH, HUNSU_EXECUTORS_PATH, HUNSU_HARNESS_PATH, HUNSU_HUNSU_DRAFT_PATH, HUNSU_PREVIOUS_EXECUTION_PATH, HUNSU_RESOURCES_PATH, HUNSU_RUNTIME_PATHS, decodeHunsuRuntimeFileText, readHunsuRuntimeStateAtRef, readPreviousExecutionChain, writeCommands, type ArtifactActionCommandRunner } from "../packages/core/src/index.ts";
import type { ArtifactActionDefinition, BoardProjection, Command, Destination, NodeRecord } from "../packages/protocol/src/index.ts";

function requireDomainValue<T>(result: { ok: true; value: T } | { ok: false; error: { message: string } }): T {
  if (result.ok) {
    return result.value;
  }
  throw new Error(result.error.message);
}

function nt(value: string): NonEmptyText {
  return value as NonEmptyText;
}

const HUNSU_DRAFT_PREV_ARTIFACT_ACTIONS_PATH = ".hunsu-prev/artifact-actions.json";
const HUNSU_DRAFT_REQUEST_DESTINATIONS_PATH = ".hunsu-request/destinations.json";
const HUNSU_DRAFT_REQUEST_HARNESS_PATH = ".hunsu-request/harness.json";
const HUNSU_DRAFT_REQUEST_EXECUTORS_PATH = ".hunsu-request/executors.json";
const HUNSU_DRAFT_REQUEST_RESOURCES_PATH = ".hunsu-request/resources.json";
const HUNSU_DRAFT_REQUEST_ARTIFACT_ACTIONS_PATH = ".hunsu-request/artifact-actions.json";
const HUNSU_DRAFT_RUNTIME_FILES = ["destinations.json", "harness.json", "executors.json", "resources.json", "artifact-actions.json"] as const;

test("Local server command handler persists domain events through Git-backed store", async () => {
  const repo = createRepo();
  const state = createStudioState();

  const result = await executeStudioCommand({
    type: "CreateInitialTeam",
    requestId: "req_server",
    lineId: "run/req_server",
    title: "Server persistence",
    goal: "Persist Studio commands",
    destinations: [{ id: "destination_001", title: "Write domain event store" }]
  }, state, { cwd: repo, persist: true });

  assert.equal(result.board.requests[0].id, "req_server");
  assert.equal(HUNSU_RUNTIME_PATHS.every(path => existsSync(join(repo, path))), true);
  assert.match(readHunsuEventText(repo), /InitialTeamCreated/);
});

test("Local server creates an Initial Team in one protocol command", async () => {
  const repo = createRepo();
  const state = createStudioState();

  const result = await executeStudioCommands([
    {
      type: "CreateInitialTeam",
      requestId: "req_batch",
      lineId: "run/req_batch",
      title: "Batch Initial Team",
      goal: "Create Initial Team and route together",
      destinations: [{ id: "destination_001", title: "Batch Destination" }]
    }
  ], state, { cwd: repo, persist: true });

  assert.equal(result.board.requests[0].id, "req_batch");
  assert.equal(result.board.lines[0].id, "run/req_batch");
  assert.match(readHunsuEventText(repo), /InitialTeamCreated/);
});

test("Local server creates a Roadmap root inside an existing Git parent", () => {
  const parent = createRepo();
  const child = join(parent, "t3");
  const registryPath = join(parent, "roadmaps.json");
  const state = createStudioState();

  const result = createStudioRoadmap({ path: child, title: "t3" }, state, { persist: true, roadmapRegistryPath: registryPath });

  assert.equal(result.repository.root, child);
  assert.equal(run("git", ["rev-parse", "--show-toplevel"], child).trim(), child);
  assert.equal(existsSync(join(child, ".git")), true);
  assert.equal(run("git", ["status", "--short"], child), "");
  assert.match(readHunsuEventText(child), /InitialTeamCreated/);
  assert.match(result.board.requests[0].goal, /minimal Hello World web project/);
  assert.equal(result.board.destinations[0].title, "Create a runnable Hello World web app");
  assert.doesNotMatch(JSON.stringify({
    goal: result.board.requests[0].goal,
    destinations: result.board.destinations,
    teamPromptTemplate: result.board.nodes[0].harness.team.promptTemplate
  }), /\.hunsu/);
  assert.equal(result.board.nodes[0].teamName, "T1");
  assert.deepEqual(result.board.nodes[0].harness.members.map(member => member.id), ["faker", "keria"]);
  assert.match(result.board.nodes[0].harness.members[0].promptTemplate.template, /pragmatic engineer/);
  assert.deepEqual(result.board.nodes[0].harness.members[0].execution, { kind: "worktree_write", network: "disabled" });
  assert.deepEqual(result.board.nodes[0].harness.members[0].approval, { policy: "on_request", reviewer: "auto_review" });
  assert.match(result.board.nodes[0].harness.members[1].promptTemplate.template, /careful reviewer/);
  assert.deepEqual(result.board.nodes[0].harness.members[1].execution, { kind: "worktree_write", network: "disabled" });
  assert.deepEqual(result.board.nodes[0].harness.members[1].approval, { policy: "never" });
  const runtime = readHunsuRuntimeStateAtRef(child)?.runtime;
  assert.equal(runtime?.harness.harness.rootTeamId, "root-team");
  assert.equal(Object.prototype.hasOwnProperty.call(runtime?.harness.harness ?? {}, "members"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(runtime?.harness.harness ?? {}, "executors"), false);
  assert.deepEqual(runtime?.executors.executors.map(executor => executor.id), ["root-team", "faker", "keria"]);
  assert.deepEqual(runtime?.resources.bindings.map(binding => binding.destinationId), ["destination_001"]);
  assert.equal(result.roadmap.repositoryPath, child);

  const reopened = createStudioRoadmap({ path: child, title: "t3" }, state, { persist: true, roadmapRegistryPath: registryPath });
  assert.equal(reopened.repository.root, child);
  assert.equal(reopened.board.requests.length, 1);
});

test("Local server scopes runs to the selected Roadmap repository", async () => {
  const parent = createRepo();
  const repoA = join(parent, "roadmap-a");
  const repoB = join(parent, "roadmap-b");
  const registryPath = join(parent, "roadmaps.json");
  const state = createStudioState();
  const first = createStudioRoadmap({ path: repoA, title: "roadmap-a" }, state, { persist: true, roadmapRegistryPath: registryPath });
  const second = createStudioRoadmap({ path: repoB, title: "roadmap-b" }, state, { persist: true, roadmapRegistryPath: registryPath });
  state.runs["run/req_hello-world-web-project"] = {
    ...studioRunFixture(),
    runId: "run/req_hello-world-web-project",
    executeId: "F0001",
    requestId: "req_hello-world-web-project",
    lineId: "run/req_hello-world-web-project",
    repositoryPath: first.repository.root,
    sourceNodeId: requireDomainValue(makeNodeId("req_hello-world-web-project:root")),
    status: "arrived"
  };
  const server = createStudioServer({ cwd: second.repository.root, state, persist: true, roadmapRegistryPath: registryPath });

  const currentResponse = await requestStudioServerJson(server, "GET", "/api/runs");
  assert.deepEqual(currentResponse.body.runs, []);

  const secondResponse = await requestStudioServerJson(server, "GET", `/api/roadmaps/${encodeURIComponent(second.roadmap.roadmapId)}/runs`);
  assert.deepEqual(secondResponse.body.runs, []);

  const firstResponse = await requestStudioServerJson(server, "GET", `/api/roadmaps/${encodeURIComponent(first.roadmap.roadmapId)}/runs`);
  assert.equal(firstResponse.body.runs.length, 1);
  assert.equal(firstResponse.body.runs[0].repositoryPath, first.repository.root);
});

test("Local HUNSU Draft commits request-file edits from draft agent turns", async () => {
  const parent = createRepo();
  const repo = join(parent, "hunsu-draft-agent-file-edit-roadmap");
  const registryPath = join(parent, "roadmaps.json");
  const state = createStudioState();
  const opened = createStudioRoadmap({ path: repo, title: "hunsu-draft-agent-file-edit-roadmap" }, state, { persist: true, roadmapRegistryPath: registryPath });
  const sourceNode = opened.board.nodes[0];
  const sourceLine = opened.board.lines[0];
  const runner = new RequestFileEditingRunner();
  const server = createStudioServer({ cwd: repo, state, persist: true, roadmapRegistryPath: registryPath, runner });
  const baseUrl = `/api/roadmaps/${encodeURIComponent(opened.roadmap.roadmapId)}/hunsu/drafts`;

  const start = await requestStudioServerJson(server, "POST", baseUrl, { sourceNodeId: String(sourceNode.id), sourceLineId: String(sourceLine.id) });
  assert.equal(start.status, 202);
  const draftSessionId = start.body.draft.draftSessionId;
  assert.equal(start.body.draft.routeId, `hunsu-draft:${draftSessionId}`);
  assert.equal(start.body.draft.manager.id, "manager.hunsu.default");
  assert.equal(start.body.draft.managerLock, undefined);
  assert.equal(start.body.draft.worktree.path.includes("hunsu-routes"), true);
  assert.notEqual(start.body.draft.worktree.path, repo);
  assert.equal(existsSync(join(start.body.draft.worktree.path, HUNSU_HUNSU_DRAFT_PATH)), true);
  for (const file of HUNSU_DRAFT_RUNTIME_FILES) {
    assert.equal(existsSync(join(start.body.draft.worktree.path, ".hunsu-prev", file)), true);
    assert.equal(existsSync(join(start.body.draft.worktree.path, ".hunsu-request", file)), true);
    assert.deepEqual(
      JSON.parse(readFileSync(join(start.body.draft.worktree.path, ".hunsu-prev", file), "utf8")),
      JSON.parse(readFileSync(join(start.body.draft.worktree.path, ".hunsu-request", file), "utf8"))
    );
  }
  const previousArtifactActions = JSON.parse(readFileSync(join(start.body.draft.worktree.path, HUNSU_DRAFT_PREV_ARTIFACT_ACTIONS_PATH), "utf8"));
  assert.equal(previousArtifactActions.schema, "hunsu.artifact-actions.v1");
  assert.deepEqual(previousArtifactActions.actions, []);
  const requestHarness = JSON.parse(readFileSync(join(start.body.draft.worktree.path, HUNSU_DRAFT_REQUEST_HARNESS_PATH), "utf8"));
  const requestExecutors = JSON.parse(readFileSync(join(start.body.draft.worktree.path, HUNSU_DRAFT_REQUEST_EXECUTORS_PATH), "utf8"));
  const requestResources = JSON.parse(readFileSync(join(start.body.draft.worktree.path, HUNSU_DRAFT_REQUEST_RESOURCES_PATH), "utf8"));
  assert.equal(requestHarness.schema, "hunsu.harness.v1");
  assert.equal(requestHarness.harness.rootTeamId, "root-team");
  assert.equal(Object.prototype.hasOwnProperty.call(requestHarness.harness, "members"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(requestHarness.harness, "executors"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(requestHarness.harness, "plan"), false);
  assert.equal(requestExecutors.schema, "hunsu.executors.v1");
  assert.deepEqual(requestExecutors.executors.map((executor: { id: string }) => executor.id), ["root-team", "faker", "keria"]);
  assert.equal(requestResources.schema, "hunsu.resources.v1");
  assert.deepEqual(requestResources.bindings.map((binding: { destinationId: string }) => binding.destinationId), ["destination_001"]);
  assert.equal(start.body.draft.activeAgentSessionId, start.body.draft.draftAgentSessionId);
  assert.deepEqual(start.body.draft.agentSessionIds, [start.body.draft.draftAgentSessionId]);
  assert.equal(start.body.draft.providerThreadId, "thread-hunsu-draft-prepared");
  assert.equal(runner.hunsuDraftPrepared?.draftSessionId, draftSessionId);
  assert.equal(runner.hunsuDraftPrepared?.manager.id, "manager.hunsu.default");
  assert.equal(runner.hunsuDraftPrepared?.repositoryPath, start.body.draft.worktree.path);
  assert.match(runner.hunsuDraftPrepared?.draftCheckCommand ?? "", /\/diff-artifacts/);
  assert.match(runner.hunsuDraftPrepared?.draftCheckCommand ?? "", /response=check-command/);
  assert.match(start.body.draft.sourceArtifactId, /^hda_/);
  assert.equal(start.body.draft.currentArtifactId, start.body.draft.sourceArtifactId);
  const routeRuntime = requireDomainValue(decodeHunsuRuntimeFileText<{ manager: { id: string }; managerLock?: HubPackageLock }>(
    readFileSync(join(start.body.draft.worktree.path, HUNSU_HUNSU_DRAFT_PATH), "utf8"),
    HUNSU_HUNSU_DRAFT_PATH
  ));
  assert.equal(routeRuntime.manager.id, "manager.hunsu.default");
  assert.equal(routeRuntime.managerLock, undefined);
  const startedSessions = await requestStudioServerJson(server, "GET", `/api/roadmaps/${encodeURIComponent(opened.roadmap.roadmapId)}/agent-sessions`);
  const startedDraftSession = startedSessions.body.sessions.find((session: { owner: { kind: string }; routeRef: { routeKind: string } }) => session.owner.kind === "HunsuDraft" && session.routeRef.routeKind === "HunsuDraft");
  assert.equal(Boolean(startedDraftSession), true);
  assert.equal(startedDraftSession.owner.draftSessionId, draftSessionId);
  assert.equal(startedDraftSession.routeRef.kind, "Route");
  assert.equal(startedDraftSession.routeRef.routeId, `hunsu-draft:${draftSessionId}`);
  assert.equal(startedDraftSession.routeRef.sourceNodeId, String(sourceNode.id));
  assert.equal(startedDraftSession.routeRef.worktree.path, start.body.draft.worktree.path);
  assert.equal(startedDraftSession.provider.providerThreadId, "thread-hunsu-draft-prepared");
  assert.equal(startedDraftSession.state.type, "waiting");
  const message = await requestStudioServerJson(server, "POST", `${baseUrl}/${encodeURIComponent(draftSessionId)}/messages`, {
    message: "typecheck Artifact Action을 요청 파일에 추가해줘"
  });

  assert.equal(message.status, 202);
  assert.equal(message.body.draft.status, "draft");
  assert.equal(runner.hunsuDraftTurn?.manager.id, "manager.hunsu.default");
  assert.equal(run("git", ["status", "--short", "--", ".hunsu", ".hunsu-request"], start.body.draft.worktree.path), "");
  const lastCommitFiles = run("git", ["show", "--name-only", "--format=", "HEAD"], start.body.draft.worktree.path);
  assert.match(lastCommitFiles, /\.hunsu-request\/artifact-actions\.json/);
  assert.match(lastCommitFiles, /\.hunsu\/hunsu-draft\.hunsu/);
});

test("Local HUNSU Draft resolves locked Manager packages and materializes Manager Skills only in the Draft worktree", async () => {
  const parent = createRepo();
  const repo = join(parent, "hunsu-draft-locked-manager-roadmap");
  const registryPath = join(parent, "roadmaps.json");
  const state = createStudioState();
  const opened = createStudioRoadmap({ path: repo, title: "hunsu-draft-locked-manager-roadmap" }, state, { persist: true, roadmapRegistryPath: registryPath });
  const originServer = await startOriginServer(repo, "motorhome");
  try {
    const managerManifest: ManagerPackageManifest = {
      schema: HUB_PACKAGE_MANIFEST_SCHEMA,
      kind: "manager",
      key: "manager.idea-helper",
      version: "1.0.0",
      manager: createDefaultManagerConfig("manager.idea-helper", "Explore options before editing request files.", [{
        kind: "local-snapshot",
        name: nt("draft-helper"),
        sourcePath: nt("/skills/draft-helper"),
        contentHash: nt("sha256:draft-helper"),
        snapshotRef: nt("snapshot:draft-helper"),
        snapshotFiles: [{ path: nt("SKILL.md"), text: "# Draft Helper\n\nHelp Hunsu Drafts.\n" }]
      }])
    };
    const managerLock = writeOriginManifest(repo, managerManifest);
    await executeStudioCommand({
      type: "RegisterHunsuOrigin",
      origin: originServer.origin
    }, state, { cwd: repo, persist: true });
    const runner = new FakeRunner();
    const server = createStudioServer({ cwd: repo, state, persist: true, roadmapRegistryPath: registryPath, runner });
    const baseUrl = `/api/roadmaps/${encodeURIComponent(opened.roadmap.roadmapId)}/hunsu/drafts`;
    const start = await requestStudioServerJson(server, "POST", baseUrl, {
      sourceNodeId: String(opened.board.nodes[0].id),
      sourceLineId: String(opened.board.lines[0].id),
      managerLock
    });

    assert.equal(start.status, 202);
    assert.equal(start.body.draft.manager.id, "manager.idea-helper");
    assert.deepEqual(start.body.draft.managerLock, managerLock);
    assert.equal(runner.hunsuDraftPrepared?.manager.promptTemplate.template, "Explore options before editing request files.");
    assert.equal(existsSync(join(start.body.draft.worktree.path, ".agents", "skills", "draft-helper", "SKILL.md")), true);
    assert.equal(existsSync(join(repo, ".agents", "skills", "draft-helper", "SKILL.md")), false);
    const routeRuntime = requireDomainValue(decodeHunsuRuntimeFileText<{ manager: { id: string }; managerLock?: HubPackageLock }>(
      readFileSync(join(start.body.draft.worktree.path, HUNSU_HUNSU_DRAFT_PATH), "utf8"),
      HUNSU_HUNSU_DRAFT_PATH
    ));
    assert.equal(routeRuntime.manager.id, "manager.idea-helper");
    assert.deepEqual(routeRuntime.managerLock, managerLock);
  } finally {
    await closeServer(originServer.server);
  }
});

test("Local HUNSU Draft streams runner items into the shared AgentSession", async () => {
  const parent = createRepo();
  const repo = join(parent, "hunsu-draft-agent-session-stream-roadmap");
  const registryPath = join(parent, "roadmaps.json");
  const state = createStudioState();
  const opened = createStudioRoadmap({ path: repo, title: "hunsu-draft-agent-session-stream-roadmap" }, state, { persist: true, roadmapRegistryPath: registryPath });
  const sourceNode = opened.board.nodes[0];
  const sourceLine = opened.board.lines[0];
  const runner = new HunsuDraftStreamingRunner();
  const server = createStudioServer({ cwd: repo, state, persist: true, roadmapRegistryPath: registryPath, runner });
  const baseUrl = `/api/roadmaps/${encodeURIComponent(opened.roadmap.roadmapId)}/hunsu/drafts`;

  const start = await requestStudioServerJson(server, "POST", baseUrl, { sourceNodeId: String(sourceNode.id), sourceLineId: String(sourceLine.id) });
  const draftSessionId = start.body.draft.draftSessionId;
  const sessionId = start.body.draft.draftAgentSessionId;
  const events: AgentSessionEvent[] = [];
  const unsubscribe = subscribeAgentSessionEvents(state, event => events.push(event), { cwd: repo, sessionId });

  const message = await requestStudioServerJson(server, "POST", `${baseUrl}/${encodeURIComponent(draftSessionId)}/messages`, {
    message: "할일 추가: 한국시간 표시"
  });
  const secondMessage = await requestStudioServerJson(server, "POST", `${baseUrl}/${encodeURIComponent(draftSessionId)}/messages`, {
    message: "두번째 요청도 대화에 보여야 합니다"
  });
  unsubscribe();

  assert.equal(message.status, 202);
  assert.equal(secondMessage.status, 202);
  assert.equal(events.some(event => event.type === "agentMessage.delta" && event.title === "Reasoning"), true);
  assert.deepEqual(
    events
      .filter((event): event is Extract<AgentSessionEvent, { type: "agentMessage.completed" }> =>
        event.type === "agentMessage.completed" && event.messageType === "hunsuDraft.user"
      )
      .map(event => event.text),
    ["할일 추가: 한국시간 표시", "두번째 요청도 대화에 보여야 합니다"]
  );
  const draftSession = state.agentSessions[sessionId];
  assert.ok(draftSession);
  assert.deepEqual(
    draftSession.messages
      .filter((item: { type: string }) => item.type === "hunsuDraft.user")
      .map((item: { text?: string }) => item.text),
    ["할일 추가: 한국시간 표시", "두번째 요청도 대화에 보여야 합니다"]
  );
  assert.deepEqual(
    draftSession.messages
      .filter((item: { type: string }) => ["reasoning", "commandExecution", "fileChange", "agentMessage"].includes(item.type))
      .map((item: { title: string; text?: string; summary?: string[]; output?: string }) => item.title),
    [
      "Reasoning", "Running command", "File changes", "Assistant",
      "Reasoning", "Running command", "File changes", "Assistant"
    ]
  );
  const reasoningMessages = draftSession.messages.filter((item: { type: string }) => item.type === "reasoning");
  const commandMessages = draftSession.messages.filter((item: { type: string }) => item.type === "commandExecution");
  const fileChangeMessages = draftSession.messages.filter((item: { type: string }) => item.type === "fileChange");
  const reasoningMessage = reasoningMessages.at(-1);
  const commandMessage = commandMessages.at(-1);
  const fileChangeMessage = fileChangeMessages.at(-1);
  assert.equal(reasoningMessages.length, 2);
  assert.equal(commandMessages.length, 2);
  assert.equal(fileChangeMessages.length, 2);
  assert.ok(reasoningMessage);
  assert.ok(commandMessage);
  assert.ok(fileChangeMessage);
  assert.deepEqual(reasoningMessages.map((item: { summary?: string[] }) => item.summary), [["Reading request files"], ["Reading request files"]]);
  assert.deepEqual(reasoningMessage.summary, ["Reading request files"]);
  assert.equal(commandMessage.output, "check passed\n");
  assert.deepEqual(fileChangeMessage.changes, [{ path: ".hunsu-request/destinations.json", kind: "updated" }]);
  assert.equal(draftSession.activeItemIds.length, 0);
});

test("Local HUNSU Draft creates DiffArtifacts and approval records changed files", async () => {
  const parent = createRepo();
  const repo = join(parent, "hunsu-draft-action-roadmap");
  const registryPath = join(parent, "roadmaps.json");
  const state = createStudioState();
  const opened = createStudioRoadmap({ path: repo, title: "hunsu-draft-action-roadmap" }, state, { persist: true, roadmapRegistryPath: registryPath });
  const sourceNode = opened.board.nodes[0];
  const sourceLine = opened.board.lines[0];
  const server = createStudioServer({ cwd: repo, state, persist: true, roadmapRegistryPath: registryPath, runner: new FakeRunner() });
  const baseUrl = `/api/roadmaps/${encodeURIComponent(opened.roadmap.roadmapId)}/hunsu/drafts`;

  const start = await requestStudioServerJson(server, "POST", baseUrl, { sourceNodeId: String(sourceNode.id), sourceLineId: String(sourceLine.id) });
  const draftSessionId = start.body.draft.draftSessionId;
  const requestPath = join(start.body.draft.worktree.path, HUNSU_DRAFT_REQUEST_ARTIFACT_ACTIONS_PATH);

  writeFileSync(requestPath, "{ invalid json\n", "utf8");
  const failedArtifact = await requestStudioServerJson(server, "POST", `${baseUrl}/${encodeURIComponent(draftSessionId)}/diff-artifacts`, {});
  assert.equal(failedArtifact.status, 202);
  assert.equal(failedArtifact.body.diffArtifact.status, "failed");
  assert.match(failedArtifact.body.diffArtifact.errors[0], /Cannot read \.hunsu-request\/artifact-actions\.json/);
  assert.notEqual(failedArtifact.body.draft.status, "ready");
  assert.equal(failedArtifact.body.draft.readyDraft, undefined);

  const compactFailedArtifact = await requestStudioServerJson(server, "POST", `${baseUrl}/${encodeURIComponent(draftSessionId)}/diff-artifacts?response=check-command`, {});
  assert.equal(compactFailedArtifact.status, 202);
  assert.equal(compactFailedArtifact.body.status, "failed");
  assert.match(compactFailedArtifact.body.marker, /status="failed"/);
  assert.match(compactFailedArtifact.body.failedReason, /Cannot read \.hunsu-request\/artifact-actions\.json/);
  assert.equal("draft" in compactFailedArtifact.body, false);
  assert.equal("board" in compactFailedArtifact.body, false);
  assert.equal("files" in compactFailedArtifact.body, false);

  writeFileSync(requestPath, JSON.stringify({
    schema: "hunsu.artifact-actions.v1",
    order: "display-order",
    actions: [{
      id: "typecheck",
      title: "Typecheck",
      kind: "check",
      sourceScope: "move-or-commit",
      runner: { type: "command", command: "pnpm run typecheck" },
      evidence: { attach: true, paths: ["reports/typecheck.txt"] },
      displayOrder: 0
    }]
  }, null, 2) + "\n", "utf8");

  const diffArtifact = await requestStudioServerJson(server, "POST", `${baseUrl}/${encodeURIComponent(draftSessionId)}/diff-artifacts`, {});
  assert.equal(diffArtifact.status, 202);
  assert.equal(diffArtifact.body.diffArtifact.status, "pass");
  assert.equal("summary" in diffArtifact.body.diffArtifact, false);
  assert.deepEqual(diffArtifact.body.diffArtifact.files.map((file: { path: string; kind: string; summary?: string }) => [file.path, file.kind, "summary" in file]), [
    [HUNSU_DRAFT_REQUEST_ARTIFACT_ACTIONS_PATH, "updated", false]
  ]);
  assert.match(diffArtifact.body.diffArtifact.files[0].diff, /diff --git a\/\.hunsu-prev\/artifact-actions\.json b\/\.hunsu-request\/artifact-actions\.json/);
  assert.match(diffArtifact.body.diffArtifact.files[0].diff, /\+      "id": "typecheck"/);
  assert.equal(diffArtifact.body.draft.status, "ready");
  assert.equal(diffArtifact.body.draft.latestDiffArtifactId, diffArtifact.body.diffArtifact.diffArtifactId);
  assert.equal(diffArtifact.body.diffArtifact.newTeamName, "Gen.G");
  assert.equal(diffArtifact.body.draft.readyDraft.summary, "Artifact Actions 1 added.");
  assert.equal(diffArtifact.body.draft.readyDraft.changedFiles[0].path, HUNSU_DRAFT_REQUEST_ARTIFACT_ACTIONS_PATH);
  assert.deepEqual(diffArtifact.body.draft.readyDraft.teamSnapshot.artifactActions.map((action: { id: string }) => action.id), ["typecheck"]);

  const compactDiffArtifact = await requestStudioServerJson(server, "POST", `${baseUrl}/${encodeURIComponent(draftSessionId)}/diff-artifacts?response=check-command`, {});
  assert.equal(compactDiffArtifact.status, 202);
  assert.equal(compactDiffArtifact.body.status, "pass");
  assert.match(compactDiffArtifact.body.marker, /status="pass"/);
  assert.equal(compactDiffArtifact.body.changedFiles[0].path, HUNSU_DRAFT_REQUEST_ARTIFACT_ACTIONS_PATH);
  assert.equal(compactDiffArtifact.body.changedFiles[0].kind, "updated");
  assert.equal("diff" in compactDiffArtifact.body.changedFiles[0], false);
  assert.equal("draft" in compactDiffArtifact.body, false);
  assert.equal("board" in compactDiffArtifact.body, false);

  const fetchedArtifact = await requestStudioServerJson(server, "GET", `${baseUrl}/${encodeURIComponent(draftSessionId)}/diff-artifacts/${encodeURIComponent(diffArtifact.body.diffArtifact.diffArtifactId)}`);
  assert.equal(fetchedArtifact.status, 200);
  assert.equal(fetchedArtifact.body.diffArtifact.diffArtifactId, diffArtifact.body.diffArtifact.diffArtifactId);

  const duplicateApprove = await requestStudioServerJson(server, "POST", `${baseUrl}/${encodeURIComponent(draftSessionId)}/approve`, {
    diffArtifactId: diffArtifact.body.diffArtifact.diffArtifactId,
    teamName: sourceNode.teamName
  });
  assert.equal(duplicateApprove.status, 400);
  assert.match(duplicateApprove.body.error, /Team name is already used/);

  const approve = await requestStudioServerJson(server, "POST", `${baseUrl}/${encodeURIComponent(draftSessionId)}/approve`, {
    diffArtifactId: diffArtifact.body.diffArtifact.diffArtifactId,
    teamName: "Cloud9"
  });
  assert.equal(approve.status, 202);
  assert.equal(approve.body.draft.status, "confirmed");
  assert.deepEqual(approve.body.hunsu.changedFiles.map((file: { path: string }) => file.path), [HUNSU_DRAFT_REQUEST_ARTIFACT_ACTIONS_PATH]);
  const confirmedNode = approve.body.board.nodes.find((node: { id: string }) => node.id === approve.body.hunsu.toNodeId);
  assert.equal(approve.body.hunsu.newTeamName, "Cloud9");
  assert.equal(confirmedNode.teamName, "Cloud9");
  assert.deepEqual(confirmedNode.artifactActions.map((action: { id: string }) => action.id), ["typecheck"]);
  const runtime = readHunsuRuntimeStateAtRef(repo)?.runtime;
  assert.deepEqual(runtime?.artifactActions.actions.map(action => action.id), ["typecheck"]);

  const restartedState = createStudioState();
  const restartedServer = createStudioServer({ cwd: repo, state: restartedState, persist: true, roadmapRegistryPath: registryPath, runner: new FakeRunner() });
  const rehydrated = await requestStudioServerJson(restartedServer, "GET", baseUrl);
  const rehydratedDraft = rehydrated.body.drafts.find((draft: { draftSessionId: string }) => draft.draftSessionId === draftSessionId);
  assert.equal(rehydratedDraft.status, "confirmed");
  assert.equal(rehydratedDraft.latestDiffArtifactId, diffArtifact.body.diffArtifact.diffArtifactId);
  assert.equal(rehydratedDraft.diffArtifacts[diffArtifact.body.diffArtifact.diffArtifactId].status, "pass");
  assert.equal(rehydratedDraft.diffArtifacts[diffArtifact.body.diffArtifact.diffArtifactId].files[0].path, HUNSU_DRAFT_REQUEST_ARTIFACT_ACTIONS_PATH);
});

test("Local HUNSU Draft composes Team snapshots from Harness and Executor runtime files", async () => {
  const parent = createRepo();
  const repo = join(parent, "hunsu-draft-member-roadmap");
  const registryPath = join(parent, "roadmaps.json");
  const state = createStudioState();
  const opened = createStudioRoadmap({ path: repo, title: "hunsu-draft-member-roadmap" }, state, { persist: true, roadmapRegistryPath: registryPath });
  const sourceNode = opened.board.nodes[0];
  const sourceLine = opened.board.lines[0];
  const server = createStudioServer({ cwd: repo, state, persist: true, roadmapRegistryPath: registryPath, runner: new FakeRunner() });
  const baseUrl = `/api/roadmaps/${encodeURIComponent(opened.roadmap.roadmapId)}/hunsu/drafts`;

  const start = await requestStudioServerJson(server, "POST", baseUrl, { sourceNodeId: String(sourceNode.id), sourceLineId: String(sourceLine.id) });
  const draftSessionId = start.body.draft.draftSessionId;
  const harnessPath = join(start.body.draft.worktree.path, HUNSU_DRAFT_REQUEST_HARNESS_PATH);
  const executorsPath = join(start.body.draft.worktree.path, HUNSU_DRAFT_REQUEST_EXECUTORS_PATH);
  const harnessFile = JSON.parse(readFileSync(harnessPath, "utf8")) as { harness: { rootTeamId: string } };
  assert.equal(harnessFile.harness.rootTeamId, "root-team");
  assert.equal(Object.prototype.hasOwnProperty.call(harnessFile.harness, "members"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(harnessFile.harness, "plan"), false);

  const executorsFile = JSON.parse(readFileSync(executorsPath, "utf8")) as { executors: Array<Record<string, any>> };
  const promptPrototyper = createDefaultMemberConfig("prompt_prototyper", "Prototype prompt variants for user-facing UI work.");
  const rootTeam = executorsFile.executors.find(executor => executor.kind === "team" && executor.id === harnessFile.harness.rootTeamId);
  assert.ok(rootTeam);
  rootTeam.members.push({
    executorId: promptPrototyper.id,
    visibleProfile: {
      kind: "member",
      label: promptPrototyper.id,
      summary: "Prototype prompt variants for user-facing UI work."
    }
  });
  executorsFile.executors.push({
    kind: "member",
    id: promptPrototyper.id,
    promptTemplate: promptPrototyper.promptTemplate,
    resources: [],
    runtimePolicy: {
      model: promptPrototyper.model,
      reasoningEffort: promptPrototyper.reasoningEffort,
      serviceTier: promptPrototyper.serviceTier,
      execution: promptPrototyper.execution,
      approval: promptPrototyper.approval
    }
  });
  writeFileSync(executorsPath, JSON.stringify(executorsFile, null, 2) + "\n", "utf8");

  const diffArtifact = await requestStudioServerJson(server, "POST", `${baseUrl}/${encodeURIComponent(draftSessionId)}/diff-artifacts`, {});

  assert.equal(diffArtifact.status, 202);
  assert.equal(diffArtifact.body.diffArtifact.status, "pass");
  assert.deepEqual(diffArtifact.body.diffArtifact.files.map((file: { path: string; kind: string }) => [file.path, file.kind]), [
    [HUNSU_DRAFT_REQUEST_EXECUTORS_PATH, "updated"]
  ]);
  assert.match(diffArtifact.body.diffArtifact.files[0].diff, /\+      "id": "prompt_prototyper"/);
  assert.deepEqual(diffArtifact.body.draft.readyDraft.teamSnapshot.harness.members.map((member: { id: string }) => member.id), ["faker", "keria", "prompt_prototyper"]);

  const approve = await requestStudioServerJson(server, "POST", `${baseUrl}/${encodeURIComponent(draftSessionId)}/approve`, { diffArtifactId: diffArtifact.body.diffArtifact.diffArtifactId });
  assert.equal(approve.status, 202);
  const confirmedNode = approve.body.board.nodes.find((node: { id: string }) => node.id === approve.body.hunsu.toNodeId);
  assert.deepEqual(confirmedNode.harness.members.map((member: { id: string }) => member.id), ["faker", "keria", "prompt_prototyper"]);
  const runtime = readHunsuRuntimeStateAtRef(repo)?.runtime;
  assert.deepEqual(runtime?.executors.executors.map(executor => executor.id), ["root-team", "faker", "keria", "prompt_prototyper"]);
  assert.equal(runtime?.harness.harness.rootTeamId, "root-team");
  assert.equal(Object.prototype.hasOwnProperty.call(runtime?.harness.harness ?? {}, "members"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(runtime?.harness.harness ?? {}, "plan"), false);
});

test("Local HUNSU Draft rejects Harness-owned Member definitions", async () => {
  const parent = createRepo();
  const repo = join(parent, "hunsu-draft-planner-members-roadmap");
  const registryPath = join(parent, "roadmaps.json");
  const state = createStudioState();
  const opened = createStudioRoadmap({ path: repo, title: "hunsu-draft-planner-members-roadmap" }, state, { persist: true, roadmapRegistryPath: registryPath });
  const sourceNode = opened.board.nodes[0];
  const sourceLine = opened.board.lines[0];
  const server = createStudioServer({ cwd: repo, state, persist: true, roadmapRegistryPath: registryPath, runner: new FakeRunner() });
  const baseUrl = `/api/roadmaps/${encodeURIComponent(opened.roadmap.roadmapId)}/hunsu/drafts`;

  const start = await requestStudioServerJson(server, "POST", baseUrl, { sourceNodeId: String(sourceNode.id), sourceLineId: String(sourceLine.id) });
  const draftSessionId = start.body.draft.draftSessionId;
  const harnessPath = join(start.body.draft.worktree.path, HUNSU_DRAFT_REQUEST_HARNESS_PATH);
  const harnessFile = JSON.parse(readFileSync(harnessPath, "utf8")) as { harness: Record<string, unknown> };
  harnessFile.harness.members = [createDefaultMemberConfig("harness_owned", "This must live in executors.json.")];
  writeFileSync(harnessPath, JSON.stringify(harnessFile, null, 2) + "\n", "utf8");

  const diffArtifact = await requestStudioServerJson(server, "POST", `${baseUrl}/${encodeURIComponent(draftSessionId)}/diff-artifacts`, {});

  assert.equal(diffArtifact.status, 202);
  assert.equal(diffArtifact.body.diffArtifact.status, "failed");
  assert.match(diffArtifact.body.diffArtifact.failedReason, /members is stored in executors\.json, not harness\.json/);
  assert.equal(diffArtifact.body.draft.readyDraft, undefined);
});

test("Local HUNSU Draft DiffArtifact rejects ConfirmHunsuDraft projection failures", async () => {
  const parent = createRepo();
  const repo = join(parent, "hunsu-draft-invalid-projection-roadmap");
  const registryPath = join(parent, "roadmaps.json");
  const state = createStudioState();
  const opened = createStudioRoadmap({ path: repo, title: "hunsu-draft-invalid-projection-roadmap" }, state, { persist: true, roadmapRegistryPath: registryPath });
  const sourceNode = opened.board.nodes[0];
  const sourceLine = opened.board.lines[0];
  const server = createStudioServer({ cwd: repo, state, persist: true, roadmapRegistryPath: registryPath, runner: new FakeRunner() });
  const baseUrl = `/api/roadmaps/${encodeURIComponent(opened.roadmap.roadmapId)}/hunsu/drafts`;

  const start = await requestStudioServerJson(server, "POST", baseUrl, { sourceNodeId: String(sourceNode.id), sourceLineId: String(sourceLine.id) });
  const draftSessionId = start.body.draft.draftSessionId;
  const requestPath = join(start.body.draft.worktree.path, HUNSU_DRAFT_REQUEST_DESTINATIONS_PATH);
  const destinationsFile = JSON.parse(readFileSync(requestPath, "utf8")) as { destinations: unknown[] };
  destinationsFile.destinations.push({
    id: "destination_002",
    requestId: "req_show-korean-time-main-screen",
    title: "Display Korean time on the main screen",
    status: "pending",
    source: "hunsu",
    createdBy: "DIRECTOR",
    updatedBy: "DIRECTOR",
    priority: 90
  });
  writeFileSync(requestPath, JSON.stringify(destinationsFile, null, 2) + "\n", "utf8");

  const diffArtifact = await requestStudioServerJson(server, "POST", `${baseUrl}/${encodeURIComponent(draftSessionId)}/diff-artifacts`, {});

  assert.equal(diffArtifact.status, 202);
  assert.equal(diffArtifact.body.diffArtifact.status, "failed");
  assert.equal(diffArtifact.body.draft.status, "draft");
  assert.equal(diffArtifact.body.draft.readyDraft, undefined);
  assert.match(diffArtifact.body.diffArtifact.failedReason, /does not match source request/);
  assert.match(diffArtifact.body.diffArtifact.errors[0], /Destination destination_002 request req_show-korean-time-main-screen does not match source request/);
});

test("Local HUNSU Draft DiffArtifact reports changed Artifact Action runtime files", async () => {
  const parent = createRepo();
  const repo = join(parent, "hunsu-draft-action-diff-roadmap");
  const registryPath = join(parent, "roadmaps.json");
  const state = createStudioState();
  const opened = createStudioRoadmap({ path: repo, title: "hunsu-draft-action-diff-roadmap" }, state, { persist: true, roadmapRegistryPath: registryPath });
  const typecheckAction = checkArtifactAction("typecheck", "Typecheck", 0, "pnpm run typecheck");
  const lintAction = checkArtifactAction("lint", "Lint", 1, "pnpm run lint");
  addArtifactActionToCurrentLine(repo, "H0001", typecheckAction);
  const boardWithActions = addArtifactActionToCurrentLine(repo, "H0002", lintAction);
  const sourceLine = boardWithActions.lines.find(line => {
    const node = boardWithActions.nodes.find(candidate => candidate.id === line.currentNodeId);
    return node?.artifactActions.length === 2;
  });
  assert.ok(sourceLine);
  const sourceNode = boardWithActions.nodes.find(node => node.id === sourceLine.currentNodeId);
  assert.ok(sourceNode);
  const server = createStudioServer({ cwd: repo, state: createStudioState(), persist: true, roadmapRegistryPath: registryPath, runner: new FakeRunner() });
  const baseUrl = `/api/roadmaps/${encodeURIComponent(opened.roadmap.roadmapId)}/hunsu/drafts`;

  const updateDraft = await requestStudioServerJson(server, "POST", baseUrl, { sourceNodeId: String(sourceNode.id), sourceLineId: String(sourceLine.id) });
  writeFileSync(join(updateDraft.body.draft.worktree.path, HUNSU_DRAFT_REQUEST_ARTIFACT_ACTIONS_PATH), JSON.stringify({
    schema: "hunsu.artifact-actions.v1",
    order: "display-order",
    actions: [{ ...typecheckAction, title: "Typecheck Project" }]
  }, null, 2) + "\n", "utf8");
  const updateDiffArtifact = await requestStudioServerJson(server, "POST", `${baseUrl}/${encodeURIComponent(updateDraft.body.draft.draftSessionId)}/diff-artifacts`, {});
  assert.equal(updateDiffArtifact.body.diffArtifact.status, "pass");
  assert.equal("summary" in updateDiffArtifact.body.diffArtifact, false);
  assert.equal("summary" in updateDiffArtifact.body.diffArtifact.files[0], false);
  assert.equal(updateDiffArtifact.body.diffArtifact.files[0].path, HUNSU_DRAFT_REQUEST_ARTIFACT_ACTIONS_PATH);
  assert.match(updateDiffArtifact.body.diffArtifact.files[0].diff, /-      "title": "Typecheck"/);
  assert.match(updateDiffArtifact.body.diffArtifact.files[0].diff, /\+      "title": "Typecheck Project"/);

  const reorderDraft = await requestStudioServerJson(server, "POST", baseUrl, { sourceNodeId: String(sourceNode.id), sourceLineId: String(sourceLine.id) });
  writeFileSync(join(reorderDraft.body.draft.worktree.path, HUNSU_DRAFT_REQUEST_ARTIFACT_ACTIONS_PATH), JSON.stringify({
    schema: "hunsu.artifact-actions.v1",
    order: "display-order",
    actions: [
      { ...lintAction, displayOrder: 0 },
      { ...typecheckAction, displayOrder: 1 }
    ]
  }, null, 2) + "\n", "utf8");
  const reorderDiffArtifact = await requestStudioServerJson(server, "POST", `${baseUrl}/${encodeURIComponent(reorderDraft.body.draft.draftSessionId)}/diff-artifacts`, {});
  assert.equal(reorderDiffArtifact.body.diffArtifact.status, "pass");
  assert.equal("summary" in reorderDiffArtifact.body.diffArtifact, false);
  assert.equal("summary" in reorderDiffArtifact.body.diffArtifact.files[0], false);
  assert.equal(reorderDiffArtifact.body.diffArtifact.files[0].path, HUNSU_DRAFT_REQUEST_ARTIFACT_ACTIONS_PATH);
  assert.match(reorderDiffArtifact.body.diffArtifact.files[0].diff, /diff --git a\/\.hunsu-prev\/artifact-actions\.json b\/\.hunsu-request\/artifact-actions\.json/);
});

test("Local HUNSU Draft approval rejects stale DiffArtifacts", async () => {
  const parent = createRepo();
  const repo = join(parent, "hunsu-draft-stale-diff-artifact-roadmap");
  const registryPath = join(parent, "roadmaps.json");
  const state = createStudioState();
  const opened = createStudioRoadmap({ path: repo, title: "hunsu-draft-stale-diff-artifact-roadmap" }, state, { persist: true, roadmapRegistryPath: registryPath });
  const sourceNode = opened.board.nodes[0];
  const sourceLine = opened.board.lines[0];
  const server = createStudioServer({ cwd: repo, state, persist: true, roadmapRegistryPath: registryPath, runner: new FakeRunner() });
  const baseUrl = `/api/roadmaps/${encodeURIComponent(opened.roadmap.roadmapId)}/hunsu/drafts`;

  const start = await requestStudioServerJson(server, "POST", baseUrl, { sourceNodeId: String(sourceNode.id), sourceLineId: String(sourceLine.id) });
  const draftSessionId = start.body.draft.draftSessionId;
  const requestPath = join(start.body.draft.worktree.path, HUNSU_DRAFT_REQUEST_ARTIFACT_ACTIONS_PATH);
  writeFileSync(requestPath, JSON.stringify({
    schema: "hunsu.artifact-actions.v1",
    order: "display-order",
    actions: [{
      id: "typecheck",
      title: "Typecheck",
      kind: "check",
      sourceScope: "move-or-commit",
      runner: { type: "command", command: "pnpm run typecheck" },
      displayOrder: 0
    }]
  }, null, 2) + "\n", "utf8");
  const diffArtifact = await requestStudioServerJson(server, "POST", `${baseUrl}/${encodeURIComponent(draftSessionId)}/diff-artifacts`, {});
  assert.equal(diffArtifact.body.diffArtifact.status, "pass");

  writeFileSync(requestPath, JSON.stringify({
    schema: "hunsu.artifact-actions.v1",
    order: "display-order",
    actions: [{
      id: "lint",
      title: "Lint",
      kind: "check",
      sourceScope: "move-or-commit",
      runner: { type: "command", command: "pnpm run lint" },
      displayOrder: 0
    }]
  }, null, 2) + "\n", "utf8");

  const approve = await requestStudioServerJson(server, "POST", `${baseUrl}/${encodeURIComponent(draftSessionId)}/approve`, { diffArtifactId: diffArtifact.body.diffArtifact.diffArtifactId });
  assert.equal(approve.status, 400);
  assert.match(approve.body.error, /request files changed after this DiffArtifact/);
});

test("Local HUNSU Draft discard does not change board HUNSU count", async () => {
  const parent = createRepo();
  const repo = join(parent, "hunsu-draft-discard");
  const registryPath = join(parent, "roadmaps.json");
  const state = createStudioState();
  const opened = createStudioRoadmap({ path: repo, title: "hunsu-draft-discard" }, state, { persist: true, roadmapRegistryPath: registryPath });
  const server = createStudioServer({ cwd: repo, state, persist: true, roadmapRegistryPath: registryPath, runner: new FakeRunner() });
  const baseUrl = `/api/roadmaps/${encodeURIComponent(opened.roadmap.roadmapId)}/hunsu/drafts`;
  const start = await requestStudioServerJson(server, "POST", baseUrl, { sourceNodeId: String(opened.board.nodes[0].id), sourceLineId: String(opened.board.lines[0].id) });

  const discard = await requestStudioServerJson(server, "POST", `${baseUrl}/${encodeURIComponent(start.body.draft.draftSessionId)}/discard`, {});

  assert.equal(discard.status, 202);
  assert.equal(discard.body.draft.status, "discarded");
  assert.equal(discard.body.board.hunsus.length, 0);
  assert.equal(currentPersistedBoard(repo).hunsus.length, 0);
});

test("Local server preserves full access Member config in Initial Team snapshot", async () => {
  const state = createStudioState();
  const protocol = createDefaultHarness();
  if (protocol.kind === "team_execution_plan") {
    protocol.members = [
      createDefaultMemberConfig("ezreal", "Use full access when explicitly requested.", [], { kind: "unrestricted", network: "enabled" }, { policy: "never" })
    ];
  }

  await seedRequestAndLine(state, "/repo", false, protocol);

  const board = boardFromEvents(state.events);
  const member = board.nodes[0].harness.members[0];
  assert.equal(member.id, "ezreal");
  assert.deepEqual(member.execution, { kind: "unrestricted", network: "enabled" });
  assert.deepEqual(member.approval, { policy: "never" });
});

test("Local server projects BOARD from committed runtime state across worktrees", async () => {
  const repo = createRepo();
  writeFileSync(join(repo, "baseline.txt"), "baseline\n", "utf8");
  run("git", ["add", "baseline.txt"], repo);
  run("git", ["commit", "-m", "baseline"], repo);
  const state = createStudioState();
  await executeStudioCommands([
    {
      type: "CreateInitialTeam",
      requestId: "req_worktree",
      lineId: "run/req_worktree",
      title: "Worktree projection",
      goal: "Read board from shared Git refs",
      destinations: [{ id: "destination_001", title: "Keep BOARD visible from another worktree" }]
    }
  ], state, { cwd: repo, persist: true });

  const worktreeParent = mkdtempSync(join(tmpdir(), "hunsu-shared-events-"));
  const worktree = join(worktreeParent, "worktree");
  try {
    run("git", ["worktree", "add", worktree, "HEAD"], repo);
    rmSync(join(worktree, ".hunsu"), { recursive: true, force: true });

    const selected = selectStudioRepository(worktree, createStudioState(), { persist: true });

    assert.equal(selected.board.requests[0].id, "req_worktree");
    assert.equal(selected.board.lines[0].id, "run/req_worktree");
    assert.equal(existsSync(join(worktree, ".hunsu", "events", "domain.jsonl")), false);
  } finally {
    run("git", ["worktree", "remove", "--force", worktree], repo);
    rmSync(worktreeParent, { recursive: true, force: true });
  }
});

test("Local server starts an injected runner with Team context", async () => {
  const state = createStudioState();
  const runner = new FakeRunner();
  await seedRequestAndLine(state);

  const result = await startStudioRun({
    requestId: "req_batch",
    lineId: "run/req_batch",
    selectedDestinationIds: ["destination_001"]
  }, state, { cwd: "/repo", persist: false, runner });

  assert.equal(result.run.status, "running");
  assert.equal(runner.started?.runId, "run/req_batch");
  assert.equal(runner.started?.requestGoal, "Create Initial Team and route together");
  assert.deepEqual(runner.started?.selectedDestinationIds, ["destination_001"]);
  assert.equal(runner.started?.activeDestinations[0].title, "Batch Destination");

  await waitFor(() => state.runs["run/req_batch"].debugEvents.length === 1);
  assert.equal(state.runs["run/req_batch"].debugEvents[0].type, "runner.status.changed");
});

test("Local server scopes Roadmap run ids so parallel Roadmaps do not share runner events", async () => {
  const state = createStudioState();
  const firstRunner = new FakeRunner();
  const secondRunner = new FakeRunner();
  await seedRequestAndLine(state);

  const first = await startStudioRun({
    requestId: "req_batch",
    lineId: "run/req_batch",
    selectedDestinationIds: ["destination_001"]
  }, state, { cwd: "/repo-a", persist: false, runner: firstRunner, roadmapId: "roadmap_a" });
  const second = await startStudioRun({
    requestId: "req_batch",
    lineId: "run/req_batch",
    selectedDestinationIds: ["destination_001"]
  }, state, { cwd: "/repo-b", persist: false, runner: secondRunner, roadmapId: "roadmap_b" });

  assert.equal(first.run.lineId, "run/req_batch");
  assert.equal(second.run.lineId, "run/req_batch");
  assert.notEqual(first.run.runId, second.run.runId);
  assert.equal(firstRunner.started?.runId, first.run.runId);
  assert.equal(secondRunner.started?.runId, second.run.runId);
  assert.deepEqual(Object.keys(state.runs).sort(), [first.run.runId, second.run.runId].sort());
});

test("Local server resolves Origin manifest lock into Team input", async () => {
  const repo = createRepo();
  const state = createStudioState();
  const manifest = createHarnessManifest();
  const { server, origin } = await startOriginServer(repo, "motorhome");
  const harnessLock = writeOriginManifest(repo, manifest, origin.name);
  const runner = new FakeRunner();
  try {
    await seedRequestAndLine(state, repo, true, rootHarnessSnapshot(manifest.team), harnessLock, origin);

    const decoded = decodeRuntimeHarness(repo);
    assert.deepEqual(decoded.origins[0], origin);
    assert.deepEqual(decoded.protocols[0]?.harnessLock, harnessLock);
    assert.equal(Object.prototype.hasOwnProperty.call(decoded.bindings[0] ?? {}, "harnessLock"), false);

    await startStudioRun({
      requestId: "req_batch",
      lineId: "run/req_batch",
      selectedDestinationIds: ["destination_001"]
    }, state, {
      cwd: repo,
      persist: true,
      runner,
      apmSkillRegistryClient: {
        async resolveSkill(ref) {
          return {
            kind: "registry-package",
            registryKind: "apm",
            name: nt(ref.name),
            registry: nt(ref.registry),
            package: nt(ref.package),
            version: nt(ref.version),
            integrity: nt("sha256:origin-skill-integrity"),
            contentHash: nt("hunsu-test-origin-skill")
          };
        },
        async fetchSkillFiles() {
          return [{ path: nt("SKILL.md"), text: "# Origin Skill\n\nUse Origin APM skill evidence.\n" }];
        }
      }
    });
    await waitFor(() => Boolean(runner.started));

    assert.deepEqual(runner.started?.harnessLock, harnessLock);
    const azir = runner.started?.harness?.members.find(member => member.id === "azir");
    assert.match(runner.started?.harness?.team.promptTemplate.template ?? "", /Origin says: {{ currentDestination.title }}/);
    const teamSkill = azir?.skills[0];
    assert.equal(teamSkill?.name, "origin-skill");
    assert.equal(teamSkill?.kind, "registry-package");
    assert.equal(teamSkill?.package, "@apm/skills/origin-skill");
    const teamConfig = readFileSync(join(runner.started!.repositoryPath, ".codex", "config.toml"), "utf8");
    assert.match(teamConfig, /HUNSU-MANAGED-CODEX-ENVIRONMENT/);
    assert.doesNotMatch(teamConfig, /origin-skill/);
    assert.equal(run("git", ["status", "--short"], runner.started!.repositoryPath), "");

    const prompt = buildTeamPlanningPrompt(runner.started!);
    assert.match(prompt, /<role>[\s\S]*Follow Origin protocol instructions/);
    assert.match(prompt, /<role>[\s\S]*Origin says: Batch Destination/);
    assert.match(prompt, /<goal>[\s\S]*Batch Destination/);
    assert.match(prompt, /<member id="azir">/);
    assert.doesNotMatch(prompt, /Resolved Harness|Prompt Template|motorhome\/codex\.webapp\.team|hunsu-json-c14n-v1|skills/);
  } finally {
    await closeServer(server);
    if (runner.started?.repositoryPath && existsSync(runner.started.repositoryPath)) {
      run("git", ["worktree", "remove", "--force", runner.started.repositoryPath], repo);
    }
    rmSync(join(tmpdir(), "hunsu-executes"), { recursive: true, force: true });
  }
});

test("Local server does not switch Origin from environment variables alone", async () => {
  const repo = createRepo();
  const state = createStudioState();
  const manifest = createHarnessManifest();
  const { server, origin } = await startOriginServer(repo, "motorhome");
  const previousEnv = process.env.HUNSU_ORIGIN_URL;
  const harnessLock = writeOriginManifest(repo, manifest, origin.name);
  const runner = new FakeRunner();
  process.env.HUNSU_ORIGIN_URL = "http://127.0.0.1:9";
  try {
      await seedRequestAndLine(state, repo, true, rootHarnessSnapshot(manifest.team), harnessLock, origin);
    await startStudioRun({
      requestId: "req_batch",
      lineId: "run/req_batch",
      selectedDestinationIds: ["destination_001"]
    }, state, {
      cwd: repo,
      persist: true,
      runner,
      apmSkillRegistryClient: {
        async resolveSkill(ref) {
          return {
            kind: "registry-package",
            registryKind: "apm",
            name: nt(ref.name),
            registry: nt(ref.registry),
            package: nt(ref.package),
            version: nt(ref.version),
            integrity: nt("sha256:origin-skill-integrity"),
            contentHash: nt("hunsu-test-origin-skill")
          };
        },
        async fetchSkillFiles() {
          return [{ path: nt("SKILL.md"), text: "# Origin Skill\n\nUse Origin APM skill evidence.\n" }];
        }
      }
    });
    await waitFor(() => Boolean(runner.started));

    assert.deepEqual(runner.started?.harnessLock, harnessLock);
    assert.match(buildTeamPlanningPrompt(runner.started!), /Origin says: Batch Destination/);
  } finally {
    if (previousEnv === undefined) {
      delete process.env.HUNSU_ORIGIN_URL;
    } else {
      process.env.HUNSU_ORIGIN_URL = previousEnv;
    }
    await closeServer(server);
  }
});

test("Local server rejects team package lock integrity mismatch before Team execution", async () => {
  const repo = createRepo();
  const state = createStudioState();
  const manifest = createHarnessManifest();
  const { server, origin } = await startOriginServer(repo, "motorhome");
  const harnessLock = writeOriginManifest(repo, manifest, origin.name);
  const runner = new FakeRunner();
  try {
      await seedRequestAndLine(state, repo, true, rootHarnessSnapshot(manifest.team), {
      ...harnessLock,
      integrity: "hunsu-json-c14n-v1+sha256:0000000000000000000000000000000000000000000000000000000000000000" as NonEmptyText
    }, origin);

    await assert.rejects(
      () => startStudioRun({ requestId: "req_batch", lineId: "run/req_batch" }, state, { cwd: repo, persist: true, runner }),
      /Hub package integrity mismatch/
    );
    assert.equal(runner.started, undefined);
  } finally {
    await closeServer(server);
  }
});

test("Local server rejects missing and unsupported team package manifests before Team execution", async () => {
  const missingRepo = createRepo();
  const missingState = createStudioState();
  const missingOrigin = await startOriginServer(missingRepo, "motorhome");
  const missingRef: HubPackageLock = {
    origin: missingOrigin.origin.name,
    kind: "team",
    key: "missing.protocol" as NonEmptyText,
    version: "1.0.0" as NonEmptyText,
    integrity: "hunsu-json-c14n-v1+sha256:1111111111111111111111111111111111111111111111111111111111111111" as NonEmptyText
  };
  const missingRunner = new FakeRunner();
  try {
    await seedRequestAndLine(missingState, missingRepo, true, createDefaultHarness("Missing manifest."), missingRef, missingOrigin.origin);
    await assert.rejects(
      () => startStudioRun({ requestId: "req_batch", lineId: "run/req_batch" }, missingState, { cwd: missingRepo, persist: true, runner: missingRunner }),
      /Missing Hub package manifest/
    );
    assert.equal(missingRunner.started, undefined);
  } finally {
    await closeServer(missingOrigin.server);
  }

  const unsupportedRepo = createRepo();
  const unsupportedState = createStudioState();
  const manifest = createHarnessManifest();
  const unsupportedOrigin = await startOriginServer(unsupportedRepo, "motorhome");
  const unsupportedRef = writeUnsupportedHarnessManifest(unsupportedRepo, manifest, unsupportedOrigin.origin.name);
  const unsupportedRunner = new FakeRunner();
  try {
    await seedRequestAndLine(unsupportedState, unsupportedRepo, true, rootHarnessSnapshot(manifest.team), unsupportedRef, unsupportedOrigin.origin);
    await assert.rejects(
      () => startStudioRun({ requestId: "req_batch", lineId: "run/req_batch" }, unsupportedState, { cwd: unsupportedRepo, persist: true, runner: unsupportedRunner }),
      /Unsupported Hub package manifest schema/
    );
    assert.equal(unsupportedRunner.started, undefined);
  } finally {
    await closeServer(unsupportedOrigin.server);
  }
});

test("Local server derives assistant transcript from app-server item events", async () => {
  const state = createStudioState();
  const runner = new TranscriptRunner();
  await seedRequestAndLine(state);

  await startStudioRun({
    requestId: "req_batch",
    lineId: "run/req_batch",
    selectedDestinationIds: ["destination_001"]
  }, state, { cwd: "/repo", persist: false, runner });

  await waitFor(() =>
    state.runs["run/req_batch"].assistantTranscript[0]?.status === "completed"
    && state.runs["run/req_batch"].debugEvents.some(event => event.type === "runner.item.completed")
  );
  const run = state.runs["run/req_batch"];
  assert.equal(run.assistantTranscript[0].text, "Hello");
  assert.equal(run.debugEvents.filter(event => event.type === "runner.item.delta" && event.deltaKind === "agentMessage").length, 5);
  assert.equal(run.debugEvents.some(event => event.type === "runner.appServer.message"), false);
});

test("Local server accumulates Codex app-server items separately from raw transcript", async () => {
  const state = createStudioState();
  const runner = new AppServerItemRunner();
  await seedRequestAndLine(state);

  await startStudioRun({
    requestId: "req_batch",
    lineId: "run/req_batch",
    selectedDestinationIds: ["destination_001"]
  }, state, { cwd: "/repo", persist: false, runner });

  await waitFor(() => state.runs["run/req_batch"].codexItems[0]?.status === "completed");
  const run = state.runs["run/req_batch"];
  assert.equal(run.rawAppServerMessages.length, 1);
  assert.equal(run.rawAppServerMessages[0].method, "item/started");
  assert.equal(run.debugEvents.some(event => event.type === "runner.appServer.message"), false);
  assert.equal(run.codexItems[0].type, "commandExecution");
  assert.equal(run.codexItems[0].output, "hello\n");
  assert.equal(run.codexItems[0].title, "Exploring");
  assert.equal(run.codexItems[0].command, "cat src/app.ts");
  assert.equal(run.codexItems[0].commandActions?.[0]?.type, "read");
  assert.equal(run.liveStatus?.phase, "working");
});

test("Local server exposes Codex provider status through the runner boundary", async () => {
  const runner = new FakeRunner();
  runner.providerStatusResponse = {
    backend: "app-server",
    available: true,
    account: { account: { type: "chatgpt", email: "test@example.com", planType: "plus" }, requiresOpenaiAuth: false },
    rateLimits: { rateLimits: { limitId: "codex", primary: null, secondary: null, credits: null, planType: "plus", rateLimitReachedType: null } }
  };
  const server = createStudioServer({ cwd: "/repo", persist: false, runner });
  const response = await requestStudioServerJson(server, "GET", "/api/codex/status");

  assert.equal(response.status, 200);
  assert.equal(response.body.backend, "app-server");
  assert.equal(response.body.available, true);
  assert.equal(response.body.account.account.email, "test@example.com");
});

test("Local server requires allowed browser origins and pairing tokens for protected APIs", async () => {
  const runner = new FakeRunner();
  runner.providerStatusResponse = { backend: "app-server", available: true };
  const server = createStudioServer({
    cwd: "/repo",
    persist: false,
    runner,
    security: {
      authToken: "local-test-token",
      allowedOrigins: ["https://studio.example.test"]
    }
  });

  const rejectedOrigin = await requestStudioServerJson(server, "GET", "/api/codex/status", undefined, {
    headers: {
      origin: "https://evil.example.test",
      authorization: "Bearer local-test-token"
    }
  });
  assert.equal(rejectedOrigin.status, 403);
  assert.equal(rejectedOrigin.headers["access-control-allow-origin"], undefined);

  const missingToken = await requestStudioServerJson(server, "GET", "/api/codex/status", undefined, {
    headers: { origin: "https://studio.example.test" }
  });
  assert.equal(missingToken.status, 401);
  assert.equal(missingToken.headers["access-control-allow-origin"], "https://studio.example.test");

  const accepted = await requestStudioServerJson(server, "GET", "/api/codex/status", undefined, {
    headers: {
      origin: "https://studio.example.test",
      "x-hunsu-local-token": "local-test-token"
    }
  });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.headers["access-control-allow-origin"], "https://studio.example.test");
  assert.equal(accepted.body.available, true);
});

test("Local server default Codex runner uses resolved app-server config", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunsu-codex-config-"));
  const scriptPath = join(root, "fake-codex-app-server.mjs");
  writeFileSync(scriptPath, `import { createInterface } from "node:readline";

let requestCount = 0;
const rl = createInterface({ input: process.stdin });
rl.on("line", line => {
  const message = JSON.parse(line);
  if (message.id === undefined) {
    return;
  }
  requestCount += 1;
  const result = message.method === "initialize"
    ? { argv: process.argv.slice(2), env: process.env.HUNSU_FAKE_CODEX_ENV ?? null }
    : { ok: true };
  process.stdout.write(JSON.stringify({ id: message.id, result }) + "\\n");
  if (requestCount >= 3) {
    setTimeout(() => process.exit(0), 10);
  }
});
`, "utf8");
  const runtimeConfig = unwrapConfigResult(resolveLocalRuntimeConfig({}, {
    cwd: root,
    codexAppServer: {
      command: process.execPath,
      args: [scriptPath, "configured-arg"],
      environment: { HUNSU_FAKE_CODEX_ENV: "configured-env" }
    }
  }));
  const server = createStudioServer({ cwd: root, persist: false, runtimeConfig });
  const response = await requestStudioServerJson(server, "GET", "/api/codex/status");

  assert.equal(response.status, 200);
  assert.equal(response.body.available, true);
  assert.deepEqual(response.body.initialized.argv, ["configured-arg"]);
  assert.equal(response.body.initialized.env, "configured-env");
});

test("Local server uses resolved runtime config for Roadmap registry path", async () => {
  const runner = new FakeRunner();
  const root = mkdtempSync(join(tmpdir(), "hunsu-runtime-config-"));
  const registryPath = join(root, "roadmaps.json");
  writeFileSync(registryPath, `${JSON.stringify({
    version: 1,
    roadmaps: [{
      roadmapId: "roadmap_config",
      displayName: "Config Roadmap",
      repositoryPath: root,
      lastOpenedAt: "2026-01-01T00:00:00.000Z",
      health: "ok"
    }]
  })}\n`, "utf8");
  const runtimeConfig = unwrapConfigResult(resolveLocalRuntimeConfig({}, {
    cwd: root,
    roadmapRegistryPath: registryPath
  }));
  const server = createStudioServer({ cwd: root, persist: false, runner, runtimeConfig });
  const response = await requestStudioServerJson(server, "GET", "/api/roadmaps/recent");

  assert.equal(response.status, 200);
  assert.equal(response.body.roadmaps[0].roadmapId, "roadmap_config");
});

test("Local Route worktrees use resolved runtime config root", async () => {
  const repo = createRepo();
  const state = createStudioState();
  const runner = new FakeRunner();
  const routeWorktreeRoot = mkdtempSync(join(tmpdir(), "hunsu-route-root-"));
  await seedRequestAndLine(state, repo, true);

  try {
    await startStudioRun({
      requestId: "req_batch",
      lineId: "run/req_batch",
      selectedDestinationIds: ["destination_001"]
    }, state, { cwd: repo, persist: true, runner, routeWorktreeRoot });

    assert.equal(runner.started?.repositoryPath.startsWith(routeWorktreeRoot), true);
  } finally {
    if (runner.started?.repositoryPath && existsSync(runner.started.repositoryPath)) {
      run("git", ["worktree", "remove", "--force", runner.started.repositoryPath], repo);
    }
  }
});

test("Local server starts the next Route worktree from the current MOVE commit", async () => {
  const repo = createRepo();
  writeFileSync(join(repo, "baseline.txt"), "baseline\n", "utf8");
  run("git", ["add", "baseline.txt"], repo);
  run("git", ["commit", "-m", "baseline"], repo);
  const state = createStudioState();
  await executeStudioCommands([
    {
      type: "CreateInitialTeam",
      requestId: "req_chain",
      lineId: "run/req_chain",
      title: "Chained worktree",
      goal: "Keep Route worktrees chained by MOVE commits",
      destinations: [
        { id: "destination_001", title: "First destination" },
        { id: "destination_002", title: "Second destination" }
      ]
    }
  ], state, { cwd: repo, persist: true });
  writeFileSync(join(repo, "move-one.txt"), "move one\n", "utf8");
  run("git", ["add", "move-one.txt"], repo);
  run("git", ["commit", "-m", "move one"], repo);
  const moveCommit = run("git", ["rev-parse", "HEAD"], repo).trim();
  await executeStudioCommand({
    type: "RecordMove",
    lineId: "run/req_chain",
    moveId: "M0001",
    summary: "Reached the first destination",
    commit: moveCommit,
    reachedDestinationIds: ["destination_001"],
    evidence: ["move one committed"],
    executeId: "F0001",
    actor: "codex"
  }, state, { cwd: repo, persist: true });
  writeFileSync(join(repo, "unrelated-main.txt"), "main kept moving\n", "utf8");
  run("git", ["add", "unrelated-main.txt"], repo);
  run("git", ["commit", "-m", "unrelated main work"], repo);
  const unrelatedCommit = run("git", ["rev-parse", "HEAD"], repo).trim();

  const result = await startStudioRun({
    requestId: "req_chain",
    lineId: "run/req_chain",
    selectedDestinationIds: ["destination_002"]
  }, state, { cwd: repo, persist: true, runner: new FakeRunner() });

  try {
    assert.equal(result.run.executeId, "F0002");
    assert.equal(result.run.worktree?.baseRef, moveCommit);
    assert.notEqual(result.run.worktree?.baseRef, unrelatedCommit);
    assert.equal(run("git", ["rev-parse", `${result.run.worktree?.branch}^{commit}`], repo).trim(), moveCommit);
  } finally {
    if (result.run.worktree?.path && existsSync(result.run.worktree.path)) {
      run("git", ["worktree", "remove", "--force", result.run.worktree.path], repo);
    }
  }
});

test("Local server does not reuse persisted Execute branch ids after restart", async () => {
  const repo = createRepo();
  writeFileSync(join(repo, "baseline.txt"), "baseline\n", "utf8");
  run("git", ["add", "baseline.txt"], repo);
  run("git", ["commit", "-m", "baseline"], repo);
  const baseline = run("git", ["rev-parse", "HEAD"], repo).trim();
  const state = createStudioState();
  await executeStudioCommands([
    {
      type: "CreateInitialTeam",
      requestId: "req_restart",
      lineId: "run/req_restart",
      title: "Restart-safe Execute ids",
      goal: "Avoid moving old Execute branches",
      destinations: [{ id: "destination_001", title: "First destination" }]
    },
    {
      type: "RecordMove",
      lineId: "run/req_restart",
      moveId: "M0001",
      summary: "Reached the first destination",
      commit: baseline,
      reachedDestinationIds: ["destination_001"],
      evidence: ["baseline commit"],
      executeId: "F0001",
      actor: "codex"
    }
  ], state, { cwd: repo, persist: true });
  run("git", ["update-ref", "refs/heads/hunsu/routes/F0002", baseline], repo);
  const restartedState = createStudioState();
  const nextDestination = { id: "destination_002", title: "Second destination" };
  await executeStudioCommand(
    destinationRuntimeChangeCommand(currentPersistedBoard(repo), "run/req_restart", "h001", nextDestination),
    restartedState,
    { cwd: repo, persist: true }
  );

  const result = await startStudioRun({
    requestId: "req_restart",
    lineId: "run/req_restart/fork-h001",
    selectedDestinationIds: ["destination_002"]
  }, restartedState, { cwd: repo, persist: true, runner: new FakeRunner() });

  try {
    assert.equal(result.run.executeId, "F0003");
    assert.equal(run("git", ["rev-parse", "refs/heads/hunsu/routes/F0002"], repo).trim(), baseline);
  } finally {
    if (result.run.worktree?.path && existsSync(result.run.worktree.path)) {
      run("git", ["worktree", "remove", "--force", result.run.worktree.path], repo);
    }
  }
});

test("Local server rejects non-executable Harness kinds before launching a worktree Execute", async () => {
  const protocols = [
    nonExecutableHarness("role_squad"),
    nonExecutableHarness("council_vote"),
    nonExecutableHarness("court_debate")
  ];

  for (const protocol of protocols) {
    const state = createStudioState();
    const runner = new FakeRunner();
    await seedRequestAndLine(state, "/repo", false, protocol);

    await assert.rejects(() => startStudioRun({
      requestId: "req_batch",
      lineId: "run/req_batch",
      selectedDestinationIds: ["destination_001"]
    }, state, { cwd: "/repo", persist: false, runner }), /not executable yet/);

    assert.equal(runner.started, undefined);
    assert.equal(state.runs["run/req_batch"], undefined);
  }
});

test("Local server publishes runner updates to live subscribers", async () => {
  const state = createStudioState();
  const runner = new FakeRunner();
  const events: StudioLiveEvent[] = [];
  await seedRequestAndLine(state);
  const unsubscribe = subscribeStudioLiveEvents(state, event => events.push(event));

  await startStudioRun({
    requestId: "req_batch",
    lineId: "run/req_batch",
    selectedDestinationIds: ["destination_001"]
  }, state, { cwd: "/repo", persist: false, runner });

  await waitFor(() => events.some(event => event.type === "run.updated" && event.run.debugEventCount === 1));
  unsubscribe();

  assert.equal(events[0].type, "runs.snapshot");
  assert.equal(events.filter(event => event.type === "run.updated").length >= 2, true);
  const updated = events.find((event): event is Extract<StudioLiveEvent, { type: "run.updated" }> =>
    event.type === "run.updated" && event.run.debugEventCount === 1
  );
  assert.equal("debugEvents" in (updated?.run ?? {}), false);
  assert.equal("codexItems" in (updated?.run ?? {}), false);
  assert.equal("assistantTranscript" in (updated?.run ?? {}), false);
});

test("Local server streams AgentSession message deltas without full run snapshots", async () => {
  const state = createStudioState();
  const runner = new TranscriptRunner();
  const events: AgentSessionEvent[] = [];
  await seedRequestAndLine(state);
  const unsubscribe = subscribeAgentSessionEvents(state, event => events.push(event), { cwd: "/repo", sessionId: "F0001:plan:1" });

  await startStudioRun({
    requestId: "req_batch",
    lineId: "run/req_batch",
    selectedDestinationIds: ["destination_001"]
  }, state, { cwd: "/repo", persist: false, runner });

  await waitFor(() => events.filter(event => event.type === "agentMessage.delta").length === 5);
  unsubscribe();

  const run = state.runs["run/req_batch"];
  const planSession = run.agentSessions.find(session => session.owner.kind === "TeamPlan");
  assert.ok(planSession);
  assert.equal(planSession.messages[0].text, "Hello");
  const deltaEvents = events.filter((event): event is Extract<AgentSessionEvent, { type: "agentMessage.delta" }> => event.type === "agentMessage.delta");
  assert.deepEqual(deltaEvents.map(event => event.delta), ["H", "e", "l", "l", "o"]);
  assert.equal(deltaEvents[0].role, "assistant");
  assert.equal(deltaEvents[0].messageType, "agentMessage");
  assert.equal(deltaEvents[0].title, "Assistant");
  assert.equal(deltaEvents[0].createdAt, planSession.messages[0].createdAt);
  const completedEvent = events.find((event): event is Extract<AgentSessionEvent, { type: "agentMessage.completed" }> => event.type === "agentMessage.completed");
  assert.ok(completedEvent);
  assert.equal("message" in completedEvent, false);
  assert.equal(completedEvent.messageId, planSession.messages[0].messageId);
  assert.equal(completedEvent.status, "completed");
  assert.equal(completedEvent.createdAt, planSession.messages[0].createdAt);
  assert.equal(events.every(event => event.type === "agentSession.snapshot" || event.sessionId === planSession.sessionId), true);
});

test("Local server streams reasoning deltas as Reasoning AgentSession messages", async () => {
  const state = createStudioState();
  const runner = new ReasoningDeltaRunner();
  const events: AgentSessionEvent[] = [];
  await seedRequestAndLine(state);
  const unsubscribe = subscribeAgentSessionEvents(state, event => events.push(event), { cwd: "/repo", sessionId: "F0001:plan:1" });

  await startStudioRun({
    requestId: "req_batch",
    lineId: "run/req_batch",
    selectedDestinationIds: ["destination_001"]
  }, state, { cwd: "/repo", persist: false, runner });

  await waitFor(() => events.some(event => event.type === "agentMessage.delta" && event.title === "Reasoning"));
  unsubscribe();

  const delta = events.find((event): event is Extract<AgentSessionEvent, { type: "agentMessage.delta" }> => event.type === "agentMessage.delta");
  assert.ok(delta);
  assert.equal(delta.role, "reasoning");
  assert.equal(delta.messageType, "reasoning");
  assert.equal(delta.title, "Reasoning");
  assert.equal(delta.field, "summary");

  const run = state.runs["run/req_batch"];
  const planSession = run.agentSessions.find(session => session.owner.kind === "TeamPlan");
  assert.ok(planSession);
  assert.equal(planSession.messages[0].role, "reasoning");
  assert.equal(planSession.messages[0].title, "Reasoning");
  assert.deepEqual(planSession.messages[0].summary, ["Considering path options"]);
});

test("Local server keeps run summaries bounded during large streaming", async () => {
  const state = createStudioState();
  const runner = new HeavyStreamingRunner();
  const events: StudioLiveEvent[] = [];
  await seedRequestAndLine(state);
  const unsubscribe = subscribeStudioLiveEvents(state, event => events.push(event));

  await startStudioRun({
    requestId: "req_batch",
    lineId: "run/req_batch",
    selectedDestinationIds: ["destination_001"]
  }, state, { cwd: "/repo", persist: false, runner });

  await waitForEventually(() =>
    state.runs["run/req_batch"].debugEvents.some(event => event.type === "runner.item.completed")
  );
  unsubscribe();

  const run = state.runs["run/req_batch"];
  const planSession = run.agentSessions.find(session => session.owner.kind === "TeamPlan");
  assert.ok(planSession);
  assert.equal(run.debugEvents.length <= 100, true);
  assert.equal(jsonBytes(run.debugEvents) <= 256 * 1024, true);
  assert.equal(run.rawAppServerMessages.length <= 50, true);
  assert.equal(jsonBytes(run.rawAppServerMessages) <= 256 * 1024, true);
  assert.equal(jsonBytes(run.codexItems) <= 512 * 1024, true);
  assert.equal(jsonBytes(run.assistantTranscript) <= 256 * 1024, true);
  assert.equal(jsonBytes(planSession.messages) <= 1024 * 1024, true);
  assert.equal(run.codexItems[0]?.text?.includes("...[truncated]"), true);
  assert.equal(run.assistantTranscript[0]?.text.includes("...[truncated]"), true);
  assert.equal(planSession.messages[0]?.text?.includes("...[truncated]"), true);

  const runUpdatedEvents = events.filter((event): event is Extract<StudioLiveEvent, { type: "run.updated" }> => event.type === "run.updated");
  assert.equal(runUpdatedEvents.length >= 2, true);
  assert.equal(Math.max(...runUpdatedEvents.map(event => jsonBytes(event))) < 64 * 1024, true);
  assert.equal(runUpdatedEvents.some(event => event.run.debugEventCount <= 100 && event.run.codexItemCount === 1), true);
  for (const event of runUpdatedEvents) {
    assert.equal("debugEvents" in event.run, false);
    assert.equal("rawAppServerMessages" in event.run, false);
    assert.equal("codexItems" in event.run, false);
    assert.equal("assistantTranscript" in event.run, false);
    assert.equal(event.run.agentSessions.every(session => session.messages.length === 0), true);
  }
});

test("Local server bridges app-server session deltas to AgentSession SSE without waiting for completion", async () => {
  const repo = createRepo();
  const state = createStudioState();
  const timeline = createSubscribeStreamTimeline();
  const acks = new SubscribeStreamDeltaAcks(timeline);
  const runner = new TimelineStreamingRunner(timeline, acks);
  const server = createStudioServer({ state, cwd: repo, persist: false, runner });
  const baseUrl = await listenUrl(server);
  const controller = new AbortController();
  const timelinePath = join(tmpdir(), `hunsu-subscribe-stream-${Date.now()}.json`);

  try {
    await seedRequestAndLine(state, repo, false);
    const ssePromise = collectAgentSessionSseTimeline(
      `${baseUrl}/api/agent-sessions/${encodeURIComponent("F0001:plan:1")}/events`,
      timeline,
      acks,
      runner.deltas.length,
      controller.signal
    );
    void ssePromise.catch(() => undefined);
    await withSubscribeStreamTimeout(waitFor(() => timeline.entries.some(entry => entry.source === "sse-connected")), 1_000, timeline, timelinePath);

    await startStudioRun({
      requestId: "req_batch",
      lineId: "run/req_batch",
      selectedDestinationIds: ["destination_001"]
    }, state, { cwd: repo, persist: false, runner });

    await withSubscribeStreamTimeout(ssePromise, 3_000, timeline, timelinePath);
    await withSubscribeStreamTimeout(waitFor(() => timeline.entries.some(entry => entry.source === "app-server-completed")), 1_000, timeline, timelinePath);
    assertSubscribeStreamTimeline(timeline, runner.deltas, timelinePath);
  } finally {
    writeFileSync(timelinePath, JSON.stringify(timeline, null, 2), "utf8");
    controller.abort();
    await closeServer(server);
  }
});

test("Local server removes AgentSession subscribers on close", async () => {
  const state = createStudioState();
  const runner = new DelayedDeltaRunner();
  const events: AgentSessionEvent[] = [];
  await seedRequestAndLine(state);
  const unsubscribe = subscribeAgentSessionEvents(state, event => events.push(event), { cwd: "/repo", sessionId: "F0001:plan:1" });

  await startStudioRun({
    requestId: "req_batch",
    lineId: "run/req_batch",
    selectedDestinationIds: ["destination_001"]
  }, state, { cwd: "/repo", persist: false, runner });

  await waitFor(() => events.some(event => event.type === "agentMessage.delta" && event.delta === "first"));
  unsubscribe();
  await delay(60);

  assert.equal(events.some(event => event.type === "agentMessage.delta" && event.delta === " second"), false);
  assert.equal(state.runs["run/req_batch"].agentSessions[0].messages[0].text, "first second");
  assert.equal(state.agentSessionSubscribers.size, 0);
});

test("Local server exposes AgentSession snapshots for reconnect recovery", async () => {
  const state = createStudioState();
  const runner = new TranscriptRunner();
  await seedRequestAndLine(state, "/repo", false);
  await startStudioRun({
    requestId: "req_batch",
    lineId: "run/req_batch",
    selectedDestinationIds: ["destination_001"]
  }, state, { cwd: "/repo", persist: false, runner });
  await waitFor(() => state.runs["run/req_batch"].agentSessions[0]?.messages[0]?.text === "Hello");

  const server = createStudioServer({ cwd: "/repo", persist: false, state, runner });
  const response = await requestStudioServerJson(server, "GET", "/api/agent-sessions");

  assert.equal(response.status, 200);
  assert.deepEqual(response.body.sessions[0].messages, []);

  const sessionResponse = await requestStudioServerJson(server, "GET", `/api/agent-sessions/${encodeURIComponent(response.body.sessions[0].sessionId)}`);
  assert.equal(sessionResponse.status, 200);
  assert.equal(sessionResponse.body.session.messages[0].text, "Hello");
});

test("Local server artifact lookup reads artifacts from the board projection", async () => {
  const state = createStudioState();
  await seedRequestAndLine(state);
  const result = await executeStudioCommand({
    type: "RecordArtifact",
    artifact: {
      id: "artifact_001",
      owner: { type: "line", id: "run/req_batch" },
      kind: "diff-summary",
      text: "Changed Studio runner event flow."
    }
  }, state, { cwd: "/repo", persist: false });

  const artifact = findArtifact(result.board, "artifact_001");

  assert.equal(artifact?.kind, "diff-summary");
  assert.equal(artifact?.text, "Changed Studio runner event flow.");
});

test("Local server reports worktree visibility", () => {
  const repo = createRepo();
  writeFileSync(join(repo, "scratch.txt"), "uncommitted\n", "utf8");

  const status = readWorktreeStatus(repo);

  assert.equal(status.clean, false);
  assert.equal(status.changes[0].path, "scratch.txt");
});

test("Local server lists Codex skill folders as queryable Skill bindings", () => {
  const home = mkdtempSync(join(tmpdir(), "hunsu-home-"));
  const skillDir = join(home, ".codex", "skills", "playwright-cli");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), "# Playwright CLI\n\nUse for UI checks.\n", "utf8");

  const skills = listCodexSkills({}, home);

  assert.equal(skills.length, 1);
  assert.equal(skills[0].kind, "local-snapshot");
  assert.equal(skills[0].name, "playwright-cli");
  assert.equal(skills[0].sourcePath, skillDir);
  assert.match(skills[0].snapshotRef, /^codex-skill:/);
  assert.equal(skills[0].files[0].path, "SKILL.md");
  assert.match(skills[0].files[0].text ?? "", /Use for UI checks/);
  assert.equal(skills[0].snapshotFiles?.[0]?.path, "SKILL.md");
  assert.match(skills[0].snapshotFiles?.[0]?.text ?? "", /Use for UI checks/);
});

test("Local server materializes local snapshot Member Skills into ignored Codex skill folders", async () => {
  const repo = createRepo();
  const protocol = createDefaultHarness("Use materialized skills.", [{
    kind: "local-snapshot",
    name: nt("ui-inspector"),
    sourcePath: nt("origin:test/ui-inspector"),
    contentHash: nt("hash-ui-inspector"),
    snapshotRef: nt("origin-skill:test:ui-inspector:hash-ui-inspector"),
    snapshotFiles: [
      { path: nt("SKILL.md"), text: "# UI Inspector\n\nUse browser evidence.\n" },
      { path: nt("references/checks.md"), text: "Confirm the focused task only.\n" }
    ]
  }]);

  await materializeCodexSkillsForExecute(repo, protocol);

  assert.equal(readFileSync(join(repo, ".agents", "skills", "ui-inspector", "SKILL.md"), "utf8"), "# UI Inspector\n\nUse browser evidence.\n");
  assert.equal(readFileSync(join(repo, ".agents", "skills", "ui-inspector", "references", "checks.md"), "utf8"), "Confirm the focused task only.\n");
  const configText = readFileSync(join(repo, ".codex", "config.toml"), "utf8");
  assert.match(configText, /HUNSU-MANAGED-CODEX-ENVIRONMENT/);
  assert.equal(configText.includes(`path = ${JSON.stringify(join(repo, ".agents", "skills", "ui-inspector", "SKILL.md"))}\nenabled = true`), true);
  assert.equal(run("git", ["status", "--short"], repo), "");
  await assert.rejects(
    () => materializeCodexSkillsForExecute(repo, createDefaultHarness("Bad skill.", [{
      kind: "local-snapshot",
      name: nt("bad-skill"),
      sourcePath: nt("origin:test/bad"),
      contentHash: nt("hash-bad"),
      snapshotRef: nt("origin-skill:test:bad:hash-bad"),
      snapshotFiles: [{ path: nt("../outside.md"), text: "nope\n" }]
    }])),
    /Invalid Skill snapshot file path/
  );
});

test("Local server prepares local-root-installed Member Skills into isolated worktree config", async () => {
  const repo = createRepo();
  const home = mkdtempSync(join(tmpdir(), "hunsu-codex-home-"));
  const skillDir = join(home, ".codex", "skills", "ui-inspector");
  const ambientSkillDir = join(home, ".codex", "skills", "ambient-helper");
  const projectSkillDir = join(repo, ".agents", "skills", "project-only");
  mkdirSync(join(skillDir, "references"), { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), "# UI Inspector\n\nUse browser evidence.\n", "utf8");
  writeFileSync(join(skillDir, "references", "checks.md"), "Confirm the focused task only.\n", "utf8");
  mkdirSync(ambientSkillDir, { recursive: true });
  writeFileSync(join(ambientSkillDir, "SKILL.md"), "# Ambient Helper\n\nShould be disabled.\n", "utf8");
  mkdirSync(projectSkillDir, { recursive: true });
  writeFileSync(join(projectSkillDir, "SKILL.md"), "# Project Only\n\nShould be disabled unless requested.\n", "utf8");
  const protocol = createDefaultHarness("Use installed skills.");
  protocol.members[0].skills = [{ kind: "local-root-installed", name: nt("ui-inspector") }];

  await prepareMemberCodexEnvironmentForExecute(repo, protocol, {
    phase: "member",
    executorId: "azir",
    env: {},
    home
  });

  assert.equal(readFileSync(join(repo, ".agents", "skills", "ui-inspector", "SKILL.md"), "utf8"), "# UI Inspector\n\nUse browser evidence.\n");
  assert.equal(readFileSync(join(repo, ".agents", "skills", "ui-inspector", "references", "checks.md"), "utf8"), "Confirm the focused task only.\n");
  const configText = readFileSync(join(repo, ".codex", "config.toml"), "utf8");
  assert.equal(configText.includes(`path = ${JSON.stringify(join(repo, ".agents", "skills", "ui-inspector", "SKILL.md"))}\nenabled = true`), true);
  assert.equal(configText.includes(`path = ${JSON.stringify(join(skillDir, "SKILL.md"))}\nenabled = false`), true);
  assert.equal(configText.includes(`path = ${JSON.stringify(join(ambientSkillDir, "SKILL.md"))}\nenabled = false`), true);
  assert.equal(configText.includes(`path = ${JSON.stringify(join(projectSkillDir, "SKILL.md"))}\nenabled = false`), true);
  assert.equal(run("git", ["status", "--short"], repo), "");
});

test("Local server rejects missing and ambiguous local-root-installed Member Skills before Codex starts", async () => {
  const missingRepo = createRepo();
  const missingHome = mkdtempSync(join(tmpdir(), "hunsu-codex-home-"));
  const missingHarness = createDefaultHarness("Use missing skill.");
  missingHarness.members[0].skills = [{ kind: "local-root-installed", name: nt("missing-skill") }];

  await assert.rejects(
    () => prepareMemberCodexEnvironmentForExecute(missingRepo, missingHarness, {
      phase: "member",
      executorId: "azir",
      env: {},
      home: missingHome
    }),
    /missing Skill: missing-skill/
  );

  const ambiguousRepo = createRepo();
  const ambiguousHome = mkdtempSync(join(tmpdir(), "hunsu-codex-home-"));
  const firstSkillDir = join(ambiguousHome, ".codex", "skills", "dupe-skill");
  const secondSkillDir = join(ambiguousHome, ".agents", "skills", "dupe-skill");
  mkdirSync(firstSkillDir, { recursive: true });
  mkdirSync(secondSkillDir, { recursive: true });
  writeFileSync(join(firstSkillDir, "SKILL.md"), "# Duplicate\n\nFirst.\n", "utf8");
  writeFileSync(join(secondSkillDir, "SKILL.md"), "# Duplicate\n\nSecond.\n", "utf8");
  const ambiguousHarness = createDefaultHarness("Use ambiguous skill.");
  ambiguousHarness.members[0].skills = [{ kind: "local-root-installed", name: nt("dupe-skill") }];

  await assert.rejects(
    () => prepareMemberCodexEnvironmentForExecute(ambiguousRepo, ambiguousHarness, {
      phase: "member",
      executorId: "azir",
      env: {},
      home: ambiguousHome
    }),
    /ambiguous across local roots/
  );
});

test("Local server prepares Member Plugin bindings into isolated worktree config", async () => {
  const repo = createRepo();
  const home = mkdtempSync(join(tmpdir(), "hunsu-codex-home-"));
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(join(home, ".codex", "config.toml"), [
    "[plugins.\"github@openai-curated\"]",
    "enabled = true",
    "",
    "[plugins.\"figma@openai-curated\"]",
    "enabled = true",
    ""
  ].join("\n"), "utf8");
  const harness = createDefaultHarness("Use GitHub plugin.");
  harness.members[0].plugins = [{ kind: "local-root-installed", id: "github@openai-curated" }];

  assert.deepEqual(listCodexPlugins({}, home), ["figma@openai-curated", "github@openai-curated"]);

  await prepareMemberCodexEnvironmentForExecute(repo, harness, {
    phase: "member",
    executorId: "azir",
    env: {},
    home
  });

  const configText = readFileSync(join(repo, ".codex", "config.toml"), "utf8");
  assert.equal(configText.includes("[plugins.\"github@openai-curated\"]\nenabled = true"), true);
  assert.equal(configText.includes("[plugins.\"figma@openai-curated\"]\nenabled = false"), true);
  assert.equal(run("git", ["status", "--short"], repo), "");

  const missingHarness = createDefaultHarness("Use missing plugin.");
  missingHarness.members[0].plugins = [{ kind: "local-root-installed", id: "slack@openai-curated" }];
  await assert.rejects(
    () => prepareMemberCodexEnvironmentForExecute(repo, missingHarness, {
      phase: "member",
      executorId: "azir",
      env: {},
      home
    }),
    /missing Plugin: slack@openai-curated/
  );
});

test("Local server refuses to merge user-authored Codex config during environment preparation", async () => {
  const repo = createRepo();
  mkdirSync(join(repo, ".codex"), { recursive: true });
  writeFileSync(join(repo, ".codex", "config.toml"), "model = \"user-config\"\n", "utf8");

  await assert.rejects(
    () => prepareMemberCodexEnvironmentForExecute(repo, createDefaultHarness(), {
      phase: "team",
      env: {},
      home: mkdtempSync(join(tmpdir(), "hunsu-codex-home-"))
    }),
    /cannot overwrite non-Hunsu Codex config/
  );
});

test("Local server materializes APM Member Skills before Codex runs", async () => {
  const repo = createRepo();
  const lock = {
    kind: "registry-package",
    registryKind: "apm",
    name: nt("general-engineer"),
    registry: nt("https://apm.example.test"),
    package: nt("@apm/skills/general-engineer"),
    version: nt("1.2.3"),
    integrity: nt("sha256:general-engineer-integrity"),
    contentHash: nt("hunsu-test-content-hash")
  } as const;
  const protocol = createDefaultHarness("Use APM skills.", [lock]);
  let fetched = false;

  await materializeCodexSkillsForExecute(repo, protocol, {
    apmSkillRegistryClient: {
      async resolveSkill() {
        return lock;
      },
      async fetchSkillFiles(requested) {
        fetched = true;
        assert.equal(requested.package, lock.package);
        return [{ path: nt("SKILL.md"), text: "# General Engineer\n\nKeep implementation practical.\n" }];
      }
    }
  });

  assert.equal(fetched, true);
  assert.equal(readFileSync(join(repo, ".agents", "skills", "general-engineer", "SKILL.md"), "utf8"), "# General Engineer\n\nKeep implementation practical.\n");
  const configText = readFileSync(join(repo, ".codex", "config.toml"), "utf8");
  assert.equal(configText.includes(`path = ${JSON.stringify(join(repo, ".agents", "skills", "general-engineer", "SKILL.md"))}\nenabled = true`), true);
  assert.equal(run("git", ["status", "--short"], repo), "");
  await assert.rejects(
    () => materializeCodexSkillsForExecute(repo, createDefaultHarness("Use bad APM skill.", [{ ...lock, name: nt("bad-apm"), contentHash: nt("sha256:bad") }]), {
      apmSkillRegistryClient: {
        async resolveSkill() {
          return { ...lock, name: nt("bad-apm"), contentHash: nt("sha256:bad") };
        },
        async fetchSkillFiles() {
          return [{ path: nt("SKILL.md"), text: "# Bad\n" }];
        }
      }
    }),
    /contentHash mismatch/
  );
});

test("Local server installs skillMeta Member Skills before Codex runs", async () => {
  const repo = createRepo();
  const protocol = createDefaultHarness("Use skills CLI metadata.", [{
    kind: "skillMeta",
    name: nt("web-design-guidelines"),
    source: nt("vercel-labs/agent-skills"),
    agent: "codex"
  }]);
  let installed = false;

  await materializeCodexSkillsForExecute(repo, protocol, {
    skillMetaInstaller: {
      async install(skill, cwd) {
        installed = true;
        assert.equal(skill.source, "vercel-labs/agent-skills");
        assert.equal(skill.name, "web-design-guidelines");
        assert.equal(skill.agent, "codex");
        const skillDir = join(cwd, ".agents", "skills", "web-design-guidelines");
        mkdirSync(join(skillDir, "references"), { recursive: true });
        writeFileSync(join(skillDir, "SKILL.md"), "# Web Design Guidelines\n\nUse polished product UI judgment.\n", "utf8");
        writeFileSync(join(skillDir, "references", "layout.md"), "Prefer direct usable screens.\n", "utf8");
      }
    }
  });

  assert.equal(installed, true);
  assert.equal(readFileSync(join(repo, ".agents", "skills", "web-design-guidelines", "SKILL.md"), "utf8"), "# Web Design Guidelines\n\nUse polished product UI judgment.\n");
  assert.equal(readFileSync(join(repo, ".agents", "skills", "web-design-guidelines", "references", "layout.md"), "utf8"), "Prefer direct usable screens.\n");
  const configText = readFileSync(join(repo, ".codex", "config.toml"), "utf8");
  assert.equal(configText.includes(`path = ${JSON.stringify(join(repo, ".agents", "skills", "web-design-guidelines", "SKILL.md"))}\nenabled = true`), true);
  assert.equal(run("git", ["status", "--short"], repo), "");
});

test("Local server selects a repository root for the control plane", () => {
  const repo = createRepo();
  const state = createStudioState();

  const result = selectStudioRepository(repo, state, { persist: false });

  assert.equal(result.repository.root, repo);
  assert.match(result.repository.branch, /main/);
});

test("Local server initializes an empty folder before creating the Initial Team", async () => {
  const repo = mkdtempSync(join(tmpdir(), "hunsu-empty-project-"));
  const state = createStudioState();

  const selected = selectStudioRepository(repo, state, { persist: false });

  assert.equal(selected.repository.root, repo);
  assert.equal(existsSync(join(repo, ".git")), true);
  assert.match(selected.repository.branch, /main/);
  assert.equal(run("git", ["config", "--local", "--get", "user.name"], repo).trim(), "Hunsu Studio");
  assert.equal(run("git", ["config", "--local", "--get", "user.email"], repo).trim(), "hunsu@example.invalid");

  const result = await executeStudioCommands([
    {
      type: "CreateInitialTeam",
      requestId: "req_initial",
      lineId: "run/req_initial",
      title: "Initial Team",
      goal: "Start from an empty folder",
      destinations: [{ id: "destination_001", title: "Define the first goal" }]
    }
  ], state, { cwd: selected.repository.root, persist: true });

  assert.equal(result.board.lines[0].id, "run/req_initial");
  assert.match(readHunsuEventText(repo), /InitialTeamCreated/);
});

test("Local server Roadmap Registry stores only local reopen metadata", async () => {
  const repo = createRepo();
  const registryPath = join(mkdtempSync(join(tmpdir(), "hunsu-roadmap-registry-")), "roadmaps.json");
  const state = createStudioState();

  const opened = applyStudioPort({
    path: repo,
    title: "Registry Roadmap",
    goal: "Keep graph in Git refs"
  }, state, { roadmapRegistryPath: registryPath });
  const reopened = openStudioRoadmap({ path: repo, title: "Registry Roadmap" }, state, { persist: true, roadmapRegistryPath: registryPath });

  const entries = listRoadmapRegistry({ roadmapRegistryPath: registryPath });
  const registryText = readFileSync(registryPath, "utf8");

  assert.equal(entries.length, 1);
  assert.equal(entries[0].roadmapId, opened.roadmap.roadmapId);
  assert.equal(reopened.roadmap.roadmapId, opened.roadmap.roadmapId);
  assert.equal(entries[0].repositoryPath, repo);
  assert.equal(resolveRoadmapRepositoryPath(opened.roadmap.roadmapId, { roadmapRegistryPath: registryPath }), repo);
  assert.doesNotMatch(registryText, /InitialTeamCreated|Keep graph in Git refs/);
  assert.match(readHunsuEventText(repo), /InitialTeamCreated/);
});

test("Local server ports existing Git projects instead of opening them implicitly", () => {
  const repo = createRepo();
  writeFileSync(join(repo, "package.json"), JSON.stringify({
    scripts: { dev: "vite --host 127.0.0.1 --port 5173" },
    packageManager: "pnpm@10.0.0"
  }), "utf8");
  const registryPath = join(mkdtempSync(join(tmpdir(), "hunsu-port-registry-")), "roadmaps.json");
  const state = createStudioState();

  assert.throws(() => openStudioRoadmap({ path: repo }, state, { persist: true, roadmapRegistryPath: registryPath }), /Use Hunsu Port/);

  const inspected = inspectStudioPort({ path: repo, title: "Ported Studio Project", goal: "Run the Studio fixture through Artifact Actions" });
  const ported = applyStudioPort({ path: repo, title: "Ported Studio Project", goal: "Run the Studio fixture through Artifact Actions" }, state, { roadmapRegistryPath: registryPath });
  const opened = openStudioRoadmap({ path: repo }, state, { persist: true, roadmapRegistryPath: registryPath });

  assert.equal(inspected.port.isGitRepository, true);
  assert.equal(inspected.port.artifactActions.configured, false);
  assert.equal(inspected.port.recommendedFiles.length, 0);
  assert.equal(inspected.plan?.files.length, 0);
  assert.deepEqual(ported.port.writtenFiles, []);
  assert.equal(opened.roadmap.roadmapId, ported.roadmap.roadmapId);
  assert.equal(listRoadmapRegistry({ roadmapRegistryPath: registryPath }).length, 1);
});

test("Local server browses server folders and marks Git-backed Roadmaps", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunsu-folder-browser-"));
  const plainFolder = join(root, "plain-folder");
  const roadmapFolder = join(root, "roadmap-folder");
  const gitOnlyFolder = join(root, "git-only-folder");
  mkdirSync(plainFolder);
  mkdirSync(roadmapFolder);
  mkdirSync(gitOnlyFolder);
  mkdirSync(join(root, ".hidden-folder"));
  mkdirSync(join(root, "node_modules"));
  run("git", ["init", "-b", "main"], gitOnlyFolder);
  run("git", ["init", "-b", "main"], roadmapFolder);
  run("git", ["config", "user.email", "test@example.com"], roadmapFolder);
  run("git", ["config", "user.name", "Test User"], roadmapFolder);

  await executeStudioCommands([
    {
      type: "CreateInitialTeam",
      requestId: "req_browser",
      lineId: "run/req_browser",
      title: "Browser Roadmap",
      goal: "Expose server-side folders",
      destinations: [{ id: "destination_001", title: "Select Roadmap folders without typing paths" }]
    }
  ], createStudioState(), { cwd: roadmapFolder, persist: true });

  const roots = filesystemBrowseRoots(root);
  const browse = browseFilesystem(root, { cwd: root });
  const names = browse.entries.map(entry => entry.name);
  const roadmapEntry = browse.entries.find(entry => entry.name === "roadmap-folder");
  const plainEntry = browse.entries.find(entry => entry.name === "plain-folder");
  const gitOnlyEntry = browse.entries.find(entry => entry.name === "git-only-folder");
  const childBrowse = browseFilesystem(plainFolder, { cwd: root });
  const missingChildBrowse = browseFilesystem(join(root, "missing-folder", "new-roadmap"), { cwd: root });

  assert.equal(roots.includes(root), true);
  assert.equal(roots.includes(tmpdir()), true);
  assert.equal(browse.path, root);
  assert.equal(names.includes(".hidden-folder"), false);
  assert.equal(names.includes("node_modules"), false);
  assert.equal(plainEntry?.isGitRepository, false);
  assert.equal(plainEntry?.isRoadmap, false);
  assert.equal(gitOnlyEntry?.isGitRepository, true);
  assert.equal(gitOnlyEntry?.isRoadmap, false);
  assert.equal(roadmapEntry?.isGitRepository, true);
  assert.equal(roadmapEntry?.isRoadmap, true);
  assert.equal(childBrowse.parent, root);
  assert.equal(missingChildBrowse.path, root);

  assert.ok(roadmapEntry);
  assert.ok(plainEntry);
  const grantState = createStudioState();
  const registryPath = join(root, "roadmaps.json");
  const roadmapGrant = createFilesystemBrowseGrant({ rootId: roadmapEntry.rootId, path: roadmapFolder }, grantState, { cwd: root });
  const openedByGrant = openStudioRoadmap({ browseToken: roadmapGrant.capability.browseToken, path: plainFolder }, grantState, { persist: false, roadmapRegistryPath: registryPath });
  const missingFolderGrant = createFilesystemBrowseGrant({ rootId: plainEntry.rootId, path: join(plainFolder, "new-roadmap") }, grantState, { cwd: root });
  mkdirSync(join(plainFolder, ".ssh"));

  assert.equal(openedByGrant.repository.root, roadmapFolder);
  assert.equal(missingFolderGrant.capability.path, join(plainFolder, "new-roadmap"));
  assert.throws(() => createFilesystemBrowseGrant({ rootId: plainEntry.rootId, path: join(plainFolder, ".ssh") }, grantState, { cwd: root }), /protected/);
  assert.throws(() => openStudioRoadmap({ browseToken: "browse_missing" }, grantState, { persist: false, roadmapRegistryPath: registryPath }), /unknown/);
});

test("Local server completes a run by verifying and recording a MOVE", async () => {
  const repo = createRepo();
  writeFileSync(join(repo, "completed.txt"), "done\n", "utf8");
  run("git", ["add", "completed.txt"], repo);
  run("git", ["commit", "-m", "complete work"], repo);
  const state = createStudioState();
  await seedRequestAndLine(state);
  state.runs["run/req_batch"] = { ...studioRunFixture(), repositoryPath: repo };

  const result = await completeStudioMove({
    runId: "run/req_batch",
    fromRef: "HEAD",
    summary: "Completed batch Destination",
    destinationIds: ["destination_001"],
    evidence: ["node --test tests/local.test.ts"]
  }, state, { cwd: repo, persist: false });

  assert.equal(result.moveId, "M0001");
  assert.equal(result.run.status, "arrived");
  assert.equal(result.board.moves[0].reachedDestinationIds[0], "destination_001");
  assert.equal(result.board.moves[0].toNodeId, result.board.lines[0].currentNodeId);
  assert.equal(result.board.nodes.find(node => node.id === result.board.lines[0].currentNodeId)?.destinations.find(destination => destination.id === "destination_001")?.status, "reached");
  assert.equal(result.board.destinations.find(destination => destination.id === "destination_001")?.status, "reached");
});

test("Local server rejects multi-Destination Execute starts and completions", async () => {
  const state = createStudioState();
  await seedRequestAndLine(state);

  await assert.rejects(
    startStudioRun({
      requestId: "req_batch",
      lineId: "run/req_batch",
      selectedDestinationIds: ["destination_001", "destination_002"]
    }, state, { cwd: "/repo", persist: false, runner: new FakeRunner() }),
    /Execute must select exactly one Destination/
  );

  state.runs["run/req_batch"] = { ...studioRunFixture(), selectedDestinationIds: ["destination_001", "destination_002"] };
  await assert.rejects(
    completeStudioMove({
      runId: "run/req_batch",
      fromRef: "HEAD",
      summary: "Invalid multi-Destination completion",
      evidence: ["node --test tests/local.test.ts"]
    }, state, { cwd: "/repo", persist: false }),
    /MOVE completion requires exactly one Destination/
  );

  state.runs["run/req_batch"] = { ...studioRunFixture(), selectedDestinationIds: ["destination_001"] };
  await assert.rejects(
    completeStudioMove({
      runId: "run/req_batch",
      fromRef: "HEAD",
      summary: "Invalid explicit multi-Destination completion",
      destinationIds: ["destination_001", "destination_002"],
      evidence: ["node --test tests/local.test.ts"]
    }, state, { cwd: "/repo", persist: false }),
    /MOVE completion requires exactly one Destination/
  );
});

test("Local server rejects non-head Destination Execute starts", async () => {
  const state = createStudioState();
  await executeStudioCommands([{
    type: "CreateInitialTeam",
    requestId: "req_batch",
    lineId: "run/req_batch",
    title: "Batch Initial Team",
    goal: "Create Initial Team and route together",
    destinations: [
      { id: "destination_low", title: "Low priority Destination", priority: 10 },
      { id: "destination_high", title: "High priority Destination", priority: 100 }
    ]
  }], state, { cwd: "/repo", persist: false });

  await assert.rejects(
    startStudioRun({
      requestId: "req_batch",
      lineId: "run/req_batch",
      selectedDestinationIds: ["destination_low"]
    }, state, { cwd: "/repo", persist: false, runner: new FakeRunner() }),
    /Execute must select the next Destination in the queue/
  );
});

test("Local server executes Team ExecutionPlan without prebuilding Member Paths", async () => {
  const repo = createRepo();
  const state = createStudioState();
  const runner = new CompletingRunner();
  const liveEvents: StudioLiveEvent[] = [];
  await seedRequestAndLine(state);
  const unsubscribe = subscribeStudioLiveEvents(state, event => liveEvents.push(event), { cwd: repo });

  await startStudioRun({
    requestId: "req_batch",
    lineId: "run/req_batch",
    selectedDestinationIds: ["destination_001"]
  }, state, { cwd: repo, persist: false, runner });

  await waitFor(() => state.runs["run/req_batch"].status === "arrived");
  unsubscribe();
  const runState = state.runs["run/req_batch"];
  const planPendingEvent = liveEvents.find(event =>
    event.type === "run.updated"
    && event.run.planExecutionTransition?.previousState === "none"
    && event.run.planExecutionTransition?.nextState === "pending"
  );
  const planCompletedEventIndex = liveEvents.findIndex(event =>
    event.type === "run.updated"
    && event.run.agentSessions.some(session => session.owner.kind === "TeamPlan" && session.state.type === "completed")
  );
  const pathStartedEventIndex = liveEvents.findIndex(event =>
    event.type === "run.updated"
    && (event.run.memberPathRuns?.length ?? 0) > 0
  );
  assert.equal(runState.error, undefined);
  assert.notEqual(planCompletedEventIndex, -1);
  assert.notEqual(pathStartedEventIndex, -1);
  if (planCompletedEventIndex >= 0 && liveEvents[planCompletedEventIndex]?.type === "run.updated") {
    assert.equal(liveEvents[planCompletedEventIndex].run.executionPlanPlan, undefined);
  }
  assert.equal(runState.memberPathRuns?.length, 3);
  assert.equal(runState.executionPlanPlan, undefined);
  assert.deepEqual(runState.memberPathRuns?.map(path => path.pathId), [
    "selected-destination.evaluate.1",
    "selected-destination.execute.2",
    "selected-destination.evaluate.3"
  ]);
  assert.deepEqual(runState.memberPathRuns?.map(path => path.requires), [
    "PrevMove",
    ["selected-destination.evaluate.1"],
    ["selected-destination.execute.2"]
  ]);
  const executorCommittedEvent = liveEvents.find(event =>
    event.type === "run.updated"
    && event.run.memberPathRuns?.some(pathRun =>
      pathRun.pathId === "selected-destination.execute.2"
      && pathRun.status === "completed"
      && "commit" in pathRun
      && Boolean(pathRun.commit)
      && pathRun.currentExecutionFile?.path === HUNSU_CURRENT_EXECUTION_PATH
    )
  );
  const evaluatorCommittedEvent = liveEvents.find(event =>
    event.type === "run.updated"
    && event.run.memberPathRuns?.some(pathRun =>
      pathRun.pathId === "selected-destination.evaluate.1"
      && pathRun.status === "completed"
      && "commit" in pathRun
      && Boolean(pathRun.commit)
      && pathRun.currentExecutionTransition?.next?.path === HUNSU_CURRENT_EXECUTION_PATH
    )
  );
  const pathPendingEvent = liveEvents.find(event =>
    event.type === "run.updated"
    && event.run.memberPathRuns?.some(pathRun =>
      pathRun.pathId === "selected-destination.evaluate.1"
      && (pathRun.status === "starting" || pathRun.status === "executing")
      && pathRun.currentExecutionTransition?.previous?.path === HUNSU_CURRENT_EXECUTION_PATH
      && pathRun.currentExecutionTransition?.nextState === "pending"
    )
  );
  const arrivedEvent = liveEvents.find(event => event.type === "run.updated" && event.run.status === "arrived");
  assert.notEqual(planPendingEvent, undefined);
  assert.notEqual(pathPendingEvent, undefined);
  assert.notEqual(evaluatorCommittedEvent, undefined);
  assert.notEqual(executorCommittedEvent, undefined);
  assert.equal(arrivedEvent?.type === "run.updated" ? arrivedEvent.board?.moves[0]?.outcome : undefined, "arrived");
});

test("Local server rejects Team delegation outside direct Harness members", async () => {
  const repo = createRepo();
  const state = createStudioState();
  const runner = new GrandchildDelegationRunner();
  await seedRequestAndLine(state);

  await startStudioRun({
    requestId: "req_batch",
    lineId: "run/req_batch",
    selectedDestinationIds: ["destination_001"]
  }, state, { cwd: repo, persist: false, runner });

  await waitFor(() => state.runs["run/req_batch"].status === "accident");
  const runState = state.runs["run/req_batch"];
  const board = boardFromEvents(state.events);

  assert.equal(board.moves[0].outcome, "accident");
  assert.match(board.moves[0].failureReason ?? "", /cannot delegate to Executor grandchild/);
  assert.equal(runner.memberPathRun, undefined);
  assert.deepEqual(runState.memberPathRuns ?? [], []);
});

test("Local server delegates through nested Teams with direct Member scope", async () => {
  const repo = createRepo();
  const state = createStudioState();
  const runner = new NestedTeamDelegationRunner();
  await seedRequestAndLine(state);
  const sourceBoard = boardFromEvents(state.events);
  const sourceNode = sourceBoard.nodes[0];
  const sourceLine = sourceBoard.lines[0];
  assert.ok(sourceNode);
  assert.ok(sourceLine);
  const harnessGraph = nestedTeamHarnessGraph();
  const newLineId = `${sourceLine.id}/fork-H0001`;

  await executeStudioCommand({
    type: "ConfirmHunsuDraft",
    actor: "DIRECTOR",
    at: "2026-06-16T00:00:01.000Z",
    draft: {
      id: "draft-H0001",
      status: "ready",
      sourceLineId: String(sourceLine.id),
      sourceNodeId: String(sourceNode.id),
      target: { type: "node", id: String(sourceNode.id) },
      newTeamName: "Nested Team",
      summary: "Install nested Team Executor graph.",
      teamSnapshot: {
        teamName: "Nested Team",
        moveOrdinal: sourceNode.ordinal,
        destinations: sourceNode.destinations.map(cloneTestJson),
        harness: rootHarnessSnapshot(harnessGraph),
        harnessGraph,
        artifactActions: sourceNode.artifactActions.map(cloneTestJson)
      },
      changedFiles: [{
        path: HUNSU_DRAFT_REQUEST_EXECUTORS_PATH,
        kind: "updated",
        summary: "Executors graph updated."
      }],
      hunsuId: "H0001",
      newLineId,
      conversationRef: {
        provider: "local",
        conversationHash: "conversation-H0001",
        contextHash: "context-H0001",
        startedAt: "2026-06-16T00:00:00.000Z",
        endedAt: "2026-06-16T00:00:01.000Z"
      },
      createdAt: "2026-06-16T00:00:00.000Z",
      updatedAt: "2026-06-16T00:00:01.000Z"
    }
  }, state, { cwd: repo, persist: false });

  await startStudioRun({
    requestId: "req_batch",
    lineId: newLineId,
    selectedDestinationIds: ["destination_001"]
  }, state, { cwd: repo, persist: false, runner });

  const runState = Object.values(state.runs).find(run => run.lineId === newLineId);
  for (let attempts = 0; attempts < 100 && runState?.status !== "arrived"; attempts += 1) {
    await delay(10);
  }
  const diagnosticBoard = boardFromEvents(state.events);
  assert.equal(runState?.status, "arrived", JSON.stringify({
    status: runState?.status,
    error: runState?.error,
    memberPathRuns: runState?.memberPathRuns,
    teamScopes: runner.teamPlanningInputs.map(input => input.teamScopeId),
    moves: diagnosticBoard.moves.map(move => ({ outcome: move.outcome, failureReason: move.failureReason }))
  }, null, 2));
  assert.deepEqual(runner.teamPlanningInputs.map(input => input.teamScopeId), ["root-team", "child-team"]);
  assert.deepEqual(runner.teamPlanningInputs[0]?.harness?.members.map(member => member.id), ["child-team"]);
  assert.deepEqual(runner.teamPlanningInputs[1]?.harness?.members.map(member => member.id), ["azir"]);
  assert.deepEqual(runState?.memberPathRuns?.map(pathRun => pathRun.executorId), ["azir"]);
});

test("Local server auto-records a MOVE after terminal Path completion", async () => {
  const repo = createRepo();
  const state = createStudioState();
  const runner = new CompletingRunner();
  await seedRequestAndLine(state);

  await startStudioRun({
    requestId: "req_batch",
    lineId: "run/req_batch",
    selectedDestinationIds: ["destination_001"]
  }, state, { cwd: repo, persist: false, runner });

  await waitFor(() => state.runs["run/req_batch"].status === "arrived");
  const board = boardFromEvents(state.events);

  assert.equal(state.runs["run/req_batch"].finalResponse, "Recorded MOVE M0001 Arrived");
  assert.equal(state.runs["run/req_batch"].attemptCount, 1);
  assert.match(state.runs["run/req_batch"].memberEvaluations?.[0]?.summary ?? "", /Verified the implementation/);
  const runState = state.runs["run/req_batch"];
  const pathCommits = runState.pathCommits ?? {};
  assert.equal(runState.providerTeamPlanningTurnId, "turn-team");
  assert.equal(runState.executionPlanPlan, undefined);
  assert.equal(runState.memberPathRuns?.map(pathRun => pathRun.status).join(","), "completed,completed,completed");
  assert.deepEqual(runState.memberPathRuns?.map(pathRun => pathRun.status === "completed" ? pathRun.session.providerTurnId : undefined), ["turn-member-galio", "turn-member-azir", "turn-member-galio"]);
  assert.equal(typeof pathCommits.PrevMove, "string");
  assert.equal(typeof pathCommits["current-execution.plan"], "string");
  assert.equal(typeof pathCommits["selected-destination.evaluate.1"], "string");
  assert.equal(typeof pathCommits["selected-destination.execute.2"], "string");
  assert.equal(typeof pathCommits["selected-destination.evaluate.3"], "string");
  const evaluatorNextExecution = readCurrentExecutionAtCommit(repo, pathCommits["selected-destination.evaluate.1"])?.execution;
  assert.equal(firstGoalStage(evaluatorNextExecution), "needs_execution");
  const executorNextExecution = readCurrentExecutionAtCommit(repo, pathCommits["selected-destination.execute.2"])?.execution;
  assert.equal(firstGoalStage(executorNextExecution), "needs_evaluation");
  assert.equal(readCurrentExecutionAtCommit(repo, pathCommits["selected-destination.evaluate.3"]), undefined);
  assert.equal(runState.terminalMemberPathId, "selected-destination.evaluate.3");
  assert.equal(runState.terminalPathCommit, pathCommits["selected-destination.evaluate.3"]);
  assert.match(runState.moveFinalizerMessage ?? "", /Complete batch Destination/);
  assert.equal(runner.moveFinalizerRun?.completionSummary, "Verified the implementation and the endpoint responded as expected.");
  assert.equal(board.moves[0].id, "M0001");
  assert.equal(board.moves[0].outcome, "arrived");
  assert.equal(board.moves[0].commit, runState.moveFinalizerCommit);
  assert.notEqual(board.moves[0].commit, pathCommits["selected-destination.evaluate.3"]);
  assert.equal(run("git", ["rev-parse", `${board.moves[0].commit}^`], repo).trim(), pathCommits["selected-destination.evaluate.3"]);
  assert.equal(board.edges[0].type, "move");
  assert.equal(board.nodes.find(node => node.id === board.moves[0].toNodeId)?.source.type, "move");
  assert.equal(board.destinations.find(destination => destination.id === "destination_001")?.status, "reached");
  const message = run("git", ["log", "--format=%B", "--max-count=1"], repo);
  assert.match(message, /Complete batch Destination/);
  assert.match(message, /Hunsu-Event: move/);
  assert.match(message, /Hunsu-Move: M0001/);
  const pathMessage = run("git", ["show", "-s", "--format=%B", pathCommits["selected-destination.evaluate.3"]], repo);
  assert.match(pathMessage, /Hunsu-Event: member-path/);
  assert.match(pathMessage, /Hunsu-Path: selected-destination\.evaluate\.3/);
  assert.match(pathMessage, /Hunsu-Goal: Verify the implementation and report what you observed/);
  assert.equal(run("git", ["show", `${pathCommits["selected-destination.execute.2"]}:auto.txt`], repo), "done\n");
  assert.equal(run("git", ["show", `${board.moves[0].commit}:auto.txt`], repo), "done\n");
  assert.equal(run("git", ["status", "--short"], repo), "");
});

test("Local server prepares separate Codex environments for Team, Member Paths, and MOVE finalizer", async () => {
  const repo = createRepo();
  const state = createStudioState();
  const codexHome = mkdtempSync(join(tmpdir(), "hunsu-codex-home-"));
  const installedSkillDir = join(codexHome, "skills", "env-skill");
  mkdirSync(installedSkillDir, { recursive: true });
  writeFileSync(join(installedSkillDir, "SKILL.md"), "# Env Skill\n\nUse only for the executor.\n", "utf8");
  const previousCodexHome = process.env.CODEX_HOME;
  const protocol = createDefaultHarness();
  protocol.members[0].skills = [{ kind: "local-root-installed", name: nt("env-skill") }];
  const snapshots: Array<{ phase: string; materialized: boolean; enabled: boolean }> = [];
  const snapshotEnvironment = (phase: string, repositoryPath: string): void => {
    const materializedSkillPath = join(repositoryPath, ".agents", "skills", "env-skill", "SKILL.md");
    const configText = readFileSync(join(repositoryPath, ".codex", "config.toml"), "utf8");
    snapshots.push({
      phase,
      materialized: existsSync(materializedSkillPath),
      enabled: configText.includes(`path = ${JSON.stringify(materializedSkillPath)}\nenabled = true`)
    });
  };
  class InspectingRunner extends CompletingRunner {
    override async runTeamPlanning(input: TeamPlanningInput): Promise<RunnerRun> {
      snapshotEnvironment("team", input.repositoryPath);
      return super.runTeamPlanning(input);
    }

    override async runMemberPath(input: MemberPathRunInput): Promise<RunnerRun> {
      snapshotEnvironment(`member:${input.memberPath.executorId}`, input.repositoryPath);
      return super.runMemberPath(input);
    }

    override async runMoveFinalizer(input: MoveFinalizerInput): Promise<RunnerRun> {
      snapshotEnvironment("move-finalizer", input.repositoryPath);
      return super.runMoveFinalizer(input);
    }
  }

  try {
    process.env.CODEX_HOME = codexHome;
    await seedRequestAndLine(state, repo, false, protocol);

    await startStudioRun({
      requestId: "req_batch",
      lineId: "run/req_batch",
      selectedDestinationIds: ["destination_001"]
    }, state, { cwd: repo, persist: false, runner: new InspectingRunner() });

    await waitFor(() => state.runs["run/req_batch"].status === "arrived");
  } finally {
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
  }

  assert.deepEqual(snapshots.map(snapshot => snapshot.phase), [
    "team",
    "member:galio",
    "member:azir",
    "member:galio",
    "move-finalizer"
  ]);
  assert.deepEqual(snapshots.map(snapshot => snapshot.materialized), [false, false, true, false, false]);
  assert.deepEqual(snapshots.map(snapshot => snapshot.enabled), [false, false, true, false, false]);
  assert.equal(run("git", ["status", "--short"], repo), "");
});

test("Local server treats worktree-write as permission, not a required tree change per Path", async () => {
  const repo = createRepo();
  const state = createStudioState();
  const runner = new CompletingRunner();
  const protocol = createDefaultHarness();
  if (protocol.kind === "team_execution_plan") {
    protocol.members = protocol.members.map(member => ({
      ...member,
      execution: { kind: "worktree_write", network: "disabled" }
    }));
  }
  await seedRequestAndLine(state, repo, false, protocol);

  await startStudioRun({
    requestId: "req_batch",
    lineId: "run/req_batch",
    selectedDestinationIds: ["destination_001"]
  }, state, { cwd: repo, persist: false, runner });

  await waitFor(() => state.runs["run/req_batch"].status === "arrived");
  const board = boardFromEvents(state.events);
  const runState = state.runs["run/req_batch"];
  const pathRuns = runState.memberPathRuns ?? [];

  assert.equal(board.moves[0].outcome, "arrived");
  assert.deepEqual(pathRuns.map(pathRun => pathRun.status), ["completed", "completed", "completed"]);
  assert.deepEqual(pathRuns.map(pathRun => "treeChanged" in pathRun ? pathRun.treeChanged : undefined), [true, true, true]);
  assert.equal(runState.terminalMemberPathId, "selected-destination.evaluate.3");
  assert.equal(runState.terminalPathCommit, runState.pathCommits?.["selected-destination.evaluate.3"]);
  assert.equal(runner.moveFinalizerRun?.terminalPathCommit, runState.pathCommits?.["selected-destination.evaluate.3"]);
});

test("Local server scopes runner event collection to each provider turn", async () => {
  const repo = createRepo();
  const state = createStudioState();
  const runner = new SlowDetachingStreamingRunner();
  await seedRequestAndLine(state);

  await startStudioRun({
    requestId: "req_batch",
    lineId: "run/req_batch",
    selectedDestinationIds: ["destination_001"]
  }, state, { cwd: repo, persist: false, runner });

  await waitForEventually(() => state.runs["run/req_batch"].status === "arrived");
  const runState = state.runs["run/req_batch"];
  const agentDeltas = runState.debugEvents
    .filter((event): event is Extract<RunnerEvent, { type: "runner.item.delta" }> => event.type === "runner.item.delta" && event.deltaKind === "agentMessage");
  const deltasByTurn = new Map<string, string[]>();
  for (const event of agentDeltas) {
    const key = event.providerTurnId ?? "unknown";
    deltasByTurn.set(key, [...(deltasByTurn.get(key) ?? []), event.delta]);
  }

  assert.deepEqual(deltasByTurn.get("turn-member-azir"), ["The", " first"]);
  assert.deepEqual(deltasByTurn.get("turn-member-galio"), ["The", " review", "The", " review"]);
  assert.deepEqual(deltasByTurn.get("turn-finalizer"), ["The", " final"]);
  assert.deepEqual(runState.memberPathRuns?.map(pathRun => pathRun.status === "completed" ? pathRun.session.providerTurnId : undefined), ["turn-member-galio", "turn-member-azir", "turn-member-galio"]);
  assert.equal(runState.codexItems.find(item => item.itemId === "msg-member-azir")?.text, "The first");
  assert.equal(runState.codexItems.find(item => item.itemId === "msg-member-galio")?.text, "The reviewThe review");
  assert.equal(runState.codexItems.find(item => item.itemId === "msg-finalizer")?.text, "The final");
  assert.equal(runState.codexItems.some(item => item.itemId === "msg-other-run"), false);
});

test("Local server records an Accident when terminal Path completion has no MOVE product changes", async () => {
  const repo = createRepo();
  const state = createStudioState();
  const runner = new CleanPassRunner();
  const protocol = createDefaultHarness();
  if (protocol.kind === "team_execution_plan") {
    protocol.members = protocol.members.map(member =>
      member.id === "azir"
        ? { ...member, execution: { kind: "worktree_write", network: "disabled" } }
        : member
    );
  }
  await seedRequestAndLine(state, "/repo", false, protocol);

  await startStudioRun({
    requestId: "req_batch",
    lineId: "run/req_batch",
    selectedDestinationIds: ["destination_001"]
  }, state, { cwd: repo, persist: false, runner });

  await waitFor(() => state.runs["run/req_batch"].status === "accident");
  const board = boardFromEvents(state.events);
  const runState = state.runs["run/req_batch"];

  assert.equal(board.moves[0].outcome, "accident");
  assert.equal(board.moves[0].failureReason, "Terminal Path completed, but Studio could not record Arrived MOVE because the Route worktree had no product file changes.");
  assert.equal(board.lines[0].status, "failed");
  assert.equal(board.destinations.find(destination => destination.id === "destination_001")?.status, "pending");
  assert.deepEqual(runState.memberPathRuns?.map(pathRun => pathRun.status), ["completed"]);
  assert.deepEqual(runState.memberPathRuns?.map(pathRun => "treeChanged" in pathRun ? pathRun.treeChanged : undefined), [true]);
  assert.equal(runState.terminalMemberPathId, "selected-destination.evaluate.1");
  assert.equal(runState.terminalPathCommit, runState.pathCommits?.["selected-destination.evaluate.1"]);
  assert.equal(runState.error, undefined);
  assert.equal(runState.finalResponse, "Recorded MOVE M0001 Accident");
  assert.equal(runState.liveStatus?.phase, "idle");
  assert.equal(runner.moveFinalizerRun, undefined);
  assert.equal(run("git", ["status", "--short"], repo), "");
});

test("Local server records an Accident for malformed evaluator output", async () => {
  const repo = createRepo();
  const state = createStudioState();
  const runner = new NaturalLanguageTerminalRunner();
  await seedRequestAndLine(state);

  await startStudioRun({
    requestId: "req_batch",
    lineId: "run/req_batch",
    selectedDestinationIds: ["destination_001"]
  }, state, { cwd: repo, persist: false, runner });

  await waitFor(() => state.runs["run/req_batch"].status === "accident");
  const board = boardFromEvents(state.events);
  const runState = state.runs["run/req_batch"];

  assert.equal(board.moves[0].outcome, "accident");
  assert.equal(runState.memberPathRuns?.at(-1)?.status, "completed");
  assert.match(runState.error ?? board.moves[0].failureReason ?? "", /Goal evaluator final response must be a JSON object/);
  assert.equal(runState.liveStatus?.phase, "idle");
});

test("Local server can complete a MOVE directly from Execute completion facts", async () => {
  const repo = createRepo();
  writeFileSync(join(repo, "direct.txt"), "done\n", "utf8");
  const state = createStudioState();
  await seedRequestAndLine(state);
  state.runs["run/req_batch"] = { ...studioRunFixture(), repositoryPath: repo };

  const result = await completeStudioMoveFromExecuteCompletion({
    summary: "Completed direct Destination",
    evidence: ["direct check"],
    risks: []
  }, state, { cwd: repo, persist: false, runId: "run/req_batch" });

  assert.equal(result?.moveId, "M0001");
  assert.equal(result?.run.status, "arrived");
  assert.equal(result?.board.moves[0].summary, "Completed direct Destination");
  assert.deepEqual(result?.board.moves[0].reachedDestinationIds, ["destination_001"]);
});

test("Local server creates and removes an isolated Route worktree for persisted Team work", async () => {
  const repo = createRepo();
  const state = createStudioState();
  const runner = new CompletingRunner();
  await seedRequestAndLine(state, repo, true);
  const liveEvents: StudioLiveEvent[] = [];
  const unsubscribe = subscribeStudioLiveEvents(state, event => liveEvents.push(event), { cwd: repo });

  await startStudioRun({
    requestId: "req_batch",
    lineId: "run/req_batch",
    selectedDestinationIds: ["destination_001"]
  }, state, { cwd: repo, persist: true, runner });

  await waitFor(() => state.runs["run/req_batch"].status === "arrived");
  unsubscribe();
  const runState = state.runs["run/req_batch"];
  const board = currentPersistedBoard(repo);
  const arrivedEvent = liveEvents.find((event): event is Extract<StudioLiveEvent, { type: "run.updated" }> =>
    event.type === "run.updated" && event.run.status === "arrived"
  );

  assert.notEqual(runner.started?.repositoryPath, repo);
  assert.match(runner.started?.worktreeHash ?? "", /^[0-9a-f]+$/);
  assert.equal(existsSync(runner.started?.repositoryPath ?? ""), false);
  assert.equal(runState.worktree?.removedAt !== undefined, true);
  assert.equal(board.moves[0].outcome, "arrived");
  assert.equal(arrivedEvent?.board?.moves[0]?.outcome, "arrived");
  assert.deepEqual(arrivedEvent?.board?.moves[0]?.reachedDestinationIds, ["destination_001"]);
  assert.equal(board.moves[0].worktree?.worktreeHash, runner.started?.worktreeHash);
  assert.match(run("git", ["show-ref", "--verify", "refs/hunsu/moves/M0001"], repo), /refs\/hunsu\/moves\/M0001/);
  const moveHead = run("git", ["rev-parse", "refs/hunsu/moves/M0001"], repo).trim();
  assert.equal(moveHead, board.moves[0].commit);
  assert.equal(run("git", ["rev-parse", `${moveHead}^`], repo).trim(), runState.terminalPathCommit);
  assert.match(run("git", ["show", "-s", "--format=%B", board.moves[0].commit], repo), /Hunsu-Event: move/);
  assert.equal(run("git", ["show", `${moveHead}:auto.txt`], repo), "done\n");
  for (const path of HUNSU_RUNTIME_PATHS) {
    assert.match(run("git", ["show", `${moveHead}:${path}`], repo), /HUNSU_RUNTIME_FILE_V1/);
  }
  assert.match(run("git", ["show", `${moveHead}:${HUNSU_PREVIOUS_EXECUTION_PATH}`], repo), /HUNSU_RUNTIME_FILE_V1/);
  const previous = readPreviousExecutionChain(repo, moveHead)[0]?.execution;
  assert.equal(previous?.schema, "hunsu.previous-execution.v1");
  assert.equal(previous?.targetMoveId, "M0001");
  assert.equal(previous?.plan.lifecycle, "Completed");
  assert.deepEqual(previous?.paths.map(path => [path.pathId, path.lifecycle, path.session?.providerTurnId]), [
    ["selected-destination.evaluate.1", "Completed", "turn-member-galio"],
    ["selected-destination.execute.2", "Completed", "turn-member-azir"],
    ["selected-destination.evaluate.3", "Completed", "turn-member-galio"]
  ]);
  assert.equal(previous?.pathCommits["selected-destination.evaluate.3"], runState.terminalPathCommit);
  const diff = readMoveDiff(board, "M0001", repo);
  assert.equal(diff.baseCommit, previous?.sourceMoveCommit);
  assert.equal(diff.headCommit, runState.terminalPathCommit);
  assert.deepEqual(diff.files.map(file => [file.path, file.kind]), [["auto.txt", "added"]]);
  assert.match(diff.files[0].patch, /\+done/);

  rmSync(join(tmpdir(), "hunsu-executes"), { recursive: true, force: true });
});

test("Local server rehydrates completed Execute metadata from previous execution after restart", async () => {
  const repo = createRepo();
  const state = createStudioState();
  const runner = new CompletingRunner();
  await seedRequestAndLine(state, repo, true);

  await startStudioRun({
    requestId: "req_batch",
    lineId: "run/req_batch",
    selectedDestinationIds: ["destination_001"]
  }, state, { cwd: repo, persist: true, runner });
  await waitFor(() => state.runs["run/req_batch"].status === "arrived");

  const restarted = createStudioState();
  const liveEvents: StudioLiveEvent[] = [];
  const unsubscribe = subscribeStudioLiveEvents(restarted, event => liveEvents.push(event), { cwd: repo });
  unsubscribe();

  const snapshot = liveEvents.find((event): event is Extract<StudioLiveEvent, { type: "runs.snapshot" }> => event.type === "runs.snapshot");
  assert.equal(snapshot?.runs.length, 1);
  const rehydrated = snapshot?.runs[0];
  assert.equal(rehydrated?.source, "rehydrated");
  assert.equal(rehydrated?.status, "arrived");
  assert.equal(rehydrated?.executionPlanPlan, undefined);
  assert.deepEqual(rehydrated?.memberPathRuns?.map(path => path.status), ["completed", "completed", "completed"]);
  assert.equal(rehydrated?.agentSessions.every(session => session.messages.length === 0), true);
  assert.deepEqual(rehydrated?.agentSessions.map(session => session.owner.kind), ["TeamPlan", "ExecutionPlan", "ExecutionPlan", "ExecutionPlan", "MoveFinalizer"]);

  const sessionEvents: AgentSessionEvent[] = [];
  const unsubscribeSessions = subscribeAgentSessionEvents(restarted, event => sessionEvents.push(event), { cwd: repo });
  unsubscribeSessions();
  const sessionSnapshot = sessionEvents.find((event): event is Extract<AgentSessionEvent, { type: "agentSession.snapshot" }> => event.type === "agentSession.snapshot");
  assert.equal(sessionSnapshot?.sessions.length, 5);
  assert.equal(sessionSnapshot?.sessions.every(session => session.messages.length === 0), true);
});

test("Local server removes previous execution metadata on HUNSU", async () => {
  const repo = createRepo();
  const state = createStudioState();
  const runner = new CompletingRunner();
  await seedRequestAndLine(state, repo, true);
  await startStudioRun({
    requestId: "req_batch",
    lineId: "run/req_batch",
    selectedDestinationIds: ["destination_001"]
  }, state, { cwd: repo, persist: true, runner });
  await waitFor(() => state.runs["run/req_batch"].status === "arrived");
  assert.equal(readPreviousExecutionChain(repo).length, 1);

  const hunsuState = createStudioState();
  await executeStudioCommand(
    destinationRuntimeChangeCommand(currentPersistedBoard(repo), "run/req_batch", "h001", { id: "destination_002", title: "New route destination" }),
    hunsuState,
    { cwd: repo, persist: true }
  );

  assert.equal(readPreviousExecutionChain(repo).length, 0);
  assert.throws(
    () => run("git", ["show", `HEAD:${HUNSU_PREVIOUS_EXECUTION_PATH}`], repo),
    /path .* does not exist|exists on disk, but not in 'HEAD'|Path .* does not exist/
  );
});

test("Local server refuses to trust agent-authored Hunsu runtime file changes", async () => {
  const repo = createRepo();
  const state = createStudioState();
  const runner = new RuntimeFileMutatingRunner();
  await seedRequestAndLine(state, repo, true);

  await startStudioRun({
    requestId: "req_batch",
    lineId: "run/req_batch",
    selectedDestinationIds: ["destination_001"]
  }, state, { cwd: repo, persist: true, runner });

  await waitFor(() => state.runs["run/req_batch"].status === "accident" || state.runs["run/req_batch"].status === "failed");
  const runState = state.runs["run/req_batch"];
  assert.equal(runState.status, "accident");
  assert.match(runState.finalResponse ?? "", /Recorded MOVE M0001 Accident/);
  assert.equal(runState.memberEvaluations?.length ?? 0, 0);
  assert.equal(runState.memberPathRuns?.[0]?.status, "completed");
  assert.equal(runState.memberPathRuns?.[1]?.status, "failed");
  assert.match(runState.memberPathRuns?.[1]?.error ?? "", /control-plane files/);
  assert.equal(runState.pathCommits?.["selected-destination.execute.2"], undefined);
  assert.equal(currentPersistedBoard(repo).moves[0].outcome, "accident");

  rmSync(join(tmpdir(), "hunsu-executes"), { recursive: true, force: true });
});

test("Local server records an Accident when Team execution throws", async () => {
  const repo = createRepo();
  const state = createStudioState();
  const runner = new ThrowingRunner();
  await seedRequestAndLine(state);

  await startStudioRun({
    requestId: "req_batch",
    lineId: "run/req_batch",
    selectedDestinationIds: ["destination_001"]
  }, state, { cwd: repo, persist: false, runner });

  await waitFor(() => state.runs["run/req_batch"].status === "accident");
  const board = boardFromEvents(state.events);

  assert.equal(board.moves[0].outcome, "accident");
  assert.match(board.moves[0].failureReason ?? "", /agent crashed/);
  assert.equal(board.destinations.find(destination => destination.id === "destination_001")?.status, "pending");
});

test("Local server requires approval before completing a risky MOVE", async () => {
  const repo = createRepo();
  writeFileSync(join(repo, "risky.txt"), "done\n", "utf8");
  run("git", ["add", "risky.txt"], repo);
  run("git", ["commit", "-m", "risky work"], repo);
  const state = createStudioState();
  await seedRequestAndLine(state);
  state.runs["run/req_batch"] = { ...studioRunFixture(), repositoryPath: repo };

  await assert.rejects(() => completeStudioMove({
    runId: "run/req_batch",
    fromRef: "HEAD",
    summary: "Risky completion",
    destinationIds: ["destination_001"],
    evidence: ["node --test tests/local.test.ts"],
    risks: ["Touches orchestration behavior"]
  }, state, { cwd: repo, persist: false }), /requires explicit approval/);
});

test("Local server reads structured MOVE diff against the previous MOVE", async () => {
  const repo = createRepo();
  writeFileSync(join(repo, "diff.txt"), "previous\n", "utf8");
  run("git", ["add", "diff.txt"], repo);
  run("git", ["commit", "-m", "move one"], repo);
  const firstCommit = run("git", ["rev-parse", "HEAD"], repo).trim();
  writeFileSync(join(repo, "diff.txt"), "review\n", "utf8");
  run("git", ["add", "diff.txt"], repo);
  run("git", ["commit", "-m", "move two"], repo);
  const secondCommit = run("git", ["rev-parse", "HEAD"], repo).trim();
  const state = createStudioState();
  await executeStudioCommands([
    {
      type: "CreateInitialTeam",
      requestId: "req_batch",
      lineId: "run/req_batch",
      title: "Batch Initial Team",
      goal: "Create Initial Team and route together",
      destinations: [
        { id: "destination_001", title: "First Destination" },
        { id: "destination_002", title: "Second Destination" }
      ]
    },
    {
      type: "RecordMove",
      lineId: "run/req_batch",
      moveId: "M0001",
      summary: "First diff review move",
      commit: firstCommit,
      reachedDestinationIds: ["destination_001"],
      evidence: ["git show HEAD"],
      actor: "codex"
    }
  ], state, { cwd: repo, persist: false });
  const result = await executeStudioCommand({
    type: "RecordMove",
    lineId: "run/req_batch",
    moveId: "M0002",
    summary: "Second diff review move",
    commit: secondCommit,
    reachedDestinationIds: ["destination_002"],
    evidence: ["git diff M0001..M0002"],
    actor: "codex"
  }, state, { cwd: repo, persist: false });

  const diff = readMoveDiff(result.board, "M0002", repo);
  const tree = readMoveFileTree(result.board, "M0002", repo);
  const blob = readMoveFileBlob(result.board, "M0002", repo, "diff.txt");

  assert.equal(diff.baseMoveId, "M0001");
  assert.equal(diff.baseCommit, firstCommit);
  assert.equal(diff.commit, secondCommit);
  assert.equal(diff.headCommit, secondCommit);
  assert.match(diff.text, /diff.txt/);
  assert.deepEqual(diff.files.map(file => [file.path, file.kind]), [["diff.txt", "modified"]]);
  assert.equal(diff.tree.some(node => node.kind === "file" && node.path === "diff.txt" && node.changeKind === "modified"), true);
  assert.match(diff.files[0].patch, /-previous/);
  assert.match(diff.files[0].patch, /\+review/);
  assert.match(diff.text, /review/);
  assert.equal(tree.changedPaths.includes("diff.txt"), true);
  assert.equal(tree.nodes.some(node => node.kind === "textFile" && node.path === "diff.txt"), true);
  assert.equal(blob.kind, "text");
  if (blob.kind === "text") {
    assert.match(blob.text, /review/);
  }
});

test("Local server plans and starts Roadmap-scoped Artifact Action Runs", () => {
  const repo = createRepo();
  writeActionFixture(repo);
  run("git", ["add", "."], repo);
  run("git", ["commit", "-m", "action fixture"], repo);
  const state = createStudioState();
  const registryPath = join(mkdtempSync(join(tmpdir(), "hunsu-action-registry-")), "roadmaps.json");
  const ported = applyStudioPort({ path: repo, title: "Action Product", goal: "Run Artifact Actions" }, state, { roadmapRegistryPath: registryPath });
  addHostAction(repo, ported.board);
  const head = run("git", ["rev-parse", "HEAD"], repo).trim();
  const actionRunner: ArtifactActionCommandRunner = (_command, args) => {
    if (args.includes("port")) {
      return { status: 0, stdout: args.includes("web") ? "0.0.0.0:59173\n" : "127.0.0.1:59187\n", stderr: "" };
    }
    return { status: 0, stdout: "", stderr: "" };
  };

  const plan = planStudioArtifactActionRun({ actionId: "host-web", commit: "HEAD", env: { TOKEN: "token" } }, { cwd: repo, roadmapId: "roadmap_server", actionRunner });
  const runRecord = startStudioArtifactActionRun({ actionId: "host-web", commit: "HEAD", env: { TOKEN: "token" } }, { cwd: repo, roadmapId: "roadmap_server", actionRunner });

  assert.equal(plan.run.runId.startsWith(`host-web-${head.slice(0, 12)}`), true);
  assert.equal(plan.run.aliases?.web.externalPath, `/api/roadmaps/roadmap_server/action-runs/${plan.run.runId}/proxy/web/`);
  assert.equal(runRecord.status, "running");
  assert.equal(runRecord.aliases?.web.directUrl, "http://127.0.0.1:59173");
});

test("Local server Artifact Action Runs use resolved runtime config root", async () => {
  const repo = createRepo();
  writeActionFixture(repo);
  run("git", ["add", "."], repo);
  run("git", ["commit", "-m", "action fixture"], repo);
  const state = createStudioState();
  const registryPath = join(mkdtempSync(join(tmpdir(), "hunsu-action-registry-")), "roadmaps.json");
  const ported = applyStudioPort({ path: repo, title: "Action Product", goal: "Run Artifact Actions" }, state, { roadmapRegistryPath: registryPath });
  addHostAction(repo, ported.board);
  const actionWorktreeRoot = mkdtempSync(join(tmpdir(), "hunsu-local-action-root-"));
  const runtimeConfig = unwrapConfigResult(resolveLocalRuntimeConfig({}, {
    cwd: repo,
    actionWorktreeRoot
  }));
  const actionRunner: ArtifactActionCommandRunner = (_command, args) => {
    if (args.includes("port")) {
      return { status: 0, stdout: "127.0.0.1:59173\n", stderr: "" };
    }
    return { status: 0, stdout: "", stderr: "" };
  };
  const server = createStudioServer({ cwd: repo, persist: true, runtimeConfig, actionRunner });
  const response = await requestStudioServerJson(server, "POST", "/api/artifact-actions/host-web/runs", { commit: "HEAD", env: { TOKEN: "token" } });
  const worktreePath = response.body.run.sourceWorktree.path;

  try {
    assert.equal(response.status, 202);
    assert.equal(response.body.run.status, "running");
    assert.equal(worktreePath.startsWith(actionWorktreeRoot), true);
  } finally {
    if (existsSync(worktreePath)) {
      run("git", ["worktree", "remove", "--force", worktreePath], repo);
    }
  }
});

test("Local server controls runtime pause, resume, and stop state", async () => {
  const state = createStudioState();
  const runner = new FakeRunner();
  await seedRequestAndLine(state);
  state.runs["run/req_batch"] = studioRunFixture();

  const paused = await pauseStudioRun({ runId: "run/req_batch" }, state, { cwd: "/repo", persist: false, runner });
  assert.equal(paused.run.status, "paused");
  assert.equal(paused.board.lines[0].status, "paused");
  assert.deepEqual(runner.paused, ["run/req_batch"]);

  const resumed = await resumeStudioRun({ runId: "run/req_batch" }, state, { cwd: "/repo", persist: false, runner });
  assert.equal(resumed.run.status, "running");
  assert.equal(resumed.board.lines[0].status, "active");
  await waitFor(() => runner.resumed?.runId === "run/req_batch");

  const stopped = await stopStudioRun({ runId: "run/req_batch" }, state, { cwd: "/repo", persist: false, runner });
  assert.equal(stopped.run.status, "stopped");
  assert.deepEqual(runner.stopped, ["run/req_batch"]);
});

test("Local server accepts and rejects lines for review decisions", async () => {
  const state = createStudioState();
  await seedRequestAndLine(state);
  state.runs["run/req_batch"] = studioRunFixture();

  const accepted = await decideStudioLine("accept", { lineId: "run/req_batch" }, state, { cwd: "/repo", persist: false });

  assert.equal(accepted.board.lines[0].status, "complete");
  assert.equal(state.runs["run/req_batch"].status, "finished");

  await executeStudioCommand({ type: "StartLine", requestId: "req_batch", lineId: "run/rejected" }, state, { cwd: "/repo", persist: false });
  const rejected = await decideStudioLine("reject", { lineId: "run/rejected", reason: "Wrong line" }, state, { cwd: "/repo", persist: false });

  assert.equal(rejected.board.lines.find(line => line.id === "run/rejected")?.status, "abandoned");
});

function createRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "hunsu-server-test-"));
  run("git", ["init", "-b", "main"], repo);
  run("git", ["config", "user.email", "test@example.com"], repo);
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

async function requestStudioServerJson(
  server: ReturnType<typeof createStudioServer>,
  method: string,
  url: string,
  body?: unknown,
  options: { headers?: Record<string, string> } = {}
): Promise<{ status: number; body: any; headers: Record<string, string> }> {
  const listener = server.listeners("request")[0] as ((request: any, response: any) => void) | undefined;
  assert.ok(listener);
  return await new Promise(resolve => {
    const bodyText = body === undefined ? "" : JSON.stringify(body);
    const request = {
      method,
      url,
      headers: lowerCaseHeaders(options.headers ?? {}),
      on: () => undefined,
      async *[Symbol.asyncIterator]() {
        if (bodyText) {
          yield Buffer.from(bodyText);
        }
      }
    };
    const response = {
      statusCode: 200,
      headers: {} as Record<string, string>,
      writeHead(status: number, headers?: Record<string, string>) {
        this.statusCode = status;
        this.headers = lowerCaseHeaders(headers ?? {});
      },
      end(body: string) {
        resolve({ status: this.statusCode, body: JSON.parse(body), headers: this.headers });
      }
    };
    listener(request, response);
  });
}

function lowerCaseHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
}

function readHunsuEventText(cwd: string): string {
  let text: string;
  const path = join(cwd, HUNSU_DESTINATIONS_PATH);
  if (existsSync(path)) {
    text = readFileSync(path, "utf8");
  } else {
    text = run("git", ["show", `HEAD:${HUNSU_DESTINATIONS_PATH}`], cwd);
  }
  const decoded = decodeHunsuRuntimeFileText<{ compatibility: { events: unknown[] } }>(text, HUNSU_DESTINATIONS_PATH);
  assert.equal(decoded.ok, true);
  return JSON.stringify(decoded.value.compatibility.events);
}

function readCurrentExecutionAtCommit(cwd: string, commit: string): { execution: ExecutionPlan } | undefined {
  let text: string;
  try {
    text = run("git", ["show", `${commit}:${HUNSU_CURRENT_EXECUTION_PATH}`], cwd);
  } catch (_error) {
    return undefined;
  }
  const decoded = decodeHunsuRuntimeFileText<{ execution: ExecutionPlan }>(text, HUNSU_CURRENT_EXECUTION_PATH);
  assert.equal(decoded.ok, true);
  return decoded.value;
}

function firstGoalStage(execution: ExecutionPlan | undefined): string | undefined {
  if (!execution) {
    return undefined;
  }
  if (execution.kind === "goal") {
    return execution.stage;
  }
  if (execution.kind === "continuation") {
    return firstGoalStage(execution.execution);
  }
  const [head] = execution.items;
  return head?.kind === "goal" ? head.stage : undefined;
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
    artifactActions: [...sourceNode.artifactActions.map(cloneTestJson), action],
    changedFilePath: HUNSU_DRAFT_REQUEST_ARTIFACT_ACTIONS_PATH,
    changedFileSummary: "Artifact Actions 1 added."
  })], { cwd: repo });
}

function checkArtifactAction(id: string, title: string, displayOrder: number, command: string): Record<string, unknown> {
  return {
    id,
    title,
    kind: "check",
    sourceScope: "move-or-commit",
    runner: { type: "command", command },
    evidence: { attach: true, paths: [`reports/${id}.txt`] },
    displayOrder
  };
}

function addArtifactActionToCurrentLine(repo: string, hunsuId: string, action: Record<string, unknown>): BoardProjection {
  const board = currentPersistedBoard(repo);
  const candidate = board.lines
    .map(line => ({
      line,
      node: board.nodes.find(node => node.id === line.currentNodeId)
    }))
    .sort((left, right) => (right.node?.artifactActions.length ?? 0) - (left.node?.artifactActions.length ?? 0))[0];
  if (!candidate) {
    throw new Error("Expected Roadmap fixture to include a line");
  }
  if (!candidate.node) {
    throw new Error("Expected current line to point at a node");
  }
  return writeCommands([hunsuRuntimeChangeCommand({
    hunsuId,
    sourceLineId: String(candidate.line.id),
    sourceNode: candidate.node,
    newLineId: `${candidate.line.id}/fork-${hunsuId}`,
    summary: `Add ${String(action.id)} Artifact Action.`,
    artifactActions: [...candidate.node.artifactActions.map(cloneTestJson), action as ArtifactActionDefinition],
    changedFilePath: HUNSU_DRAFT_REQUEST_ARTIFACT_ACTIONS_PATH,
    changedFileSummary: "Artifact Actions 1 added."
  })], { cwd: repo }).board;
}

function destinationRuntimeChangeCommand(board: BoardProjection, lineId: string, hunsuId: string, destination: { id: string; title: string; priority?: number }): Command {
  const line = board.lines.find(candidate => String(candidate.id) === lineId);
  if (!line) {
    throw new Error(`Expected line ${lineId}`);
  }
  const sourceNode = board.nodes.find(node => node.id === line.currentNodeId);
  if (!sourceNode) {
    throw new Error(`Expected current node for line ${lineId}`);
  }
  const runtimeDestination = {
    ...destination,
    requestId: sourceNode.requestId,
    status: "pending" as const,
    source: "hunsu" as const,
    createdBy: "DIRECTOR" as const,
    updatedBy: "DIRECTOR" as const
  } as Destination;
  return hunsuRuntimeChangeCommand({
    hunsuId,
    sourceLineId: String(line.id),
    sourceNode,
    newLineId: `${line.id}/fork-${hunsuId}`,
    summary: "Add destination through runtime request file.",
    destinations: [...sourceNode.destinations.map(cloneTestJson), runtimeDestination],
    changedFilePath: ".hunsu-request/destinations.json",
    changedFileSummary: "Destinations 1 added."
  });
}

function hunsuRuntimeChangeCommand(input: {
  hunsuId: string;
  sourceLineId: string;
  sourceNode: NodeRecord;
  newLineId: string;
  summary: string;
  destinations?: Destination[];
  artifactActions?: ArtifactActionDefinition[];
  changedFilePath: string;
  changedFileSummary: string;
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
        destinations: input.destinations ?? input.sourceNode.destinations.map(cloneTestJson),
        harness: cloneTestJson(input.sourceNode.harness),
        harnessGraph: cloneTestJson(input.sourceNode.harnessGraph),
        harnessLock: input.sourceNode.harnessLock ? cloneTestJson(input.sourceNode.harnessLock) : undefined,
        executorPackageBindings: input.sourceNode.executorPackageBindings?.map(cloneTestJson),
        resourcePackageBindings: input.sourceNode.resourcePackageBindings?.map(cloneTestJson),
        artifactActions: input.artifactActions ?? input.sourceNode.artifactActions.map(cloneTestJson)
      },
      changedFiles: [{
        path: input.changedFilePath,
        kind: "updated",
        summary: input.changedFileSummary
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

async function seedRequestAndLine(
  state: ReturnType<typeof createStudioState>,
  cwd = "/repo",
  persist = false,
  harness?: HarnessSnapshot,
  harnessLock?: HubPackageLock,
  origin?: HunsuOrigin
): Promise<void> {
  await executeStudioCommands([
    ...(origin ? [{
      type: "RegisterHunsuOrigin" as const,
      origin
    }] : []),
    {
      type: "CreateInitialTeam",
      requestId: "req_batch",
      lineId: "run/req_batch",
      title: "Batch Initial Team",
      goal: "Create Initial Team and route together",
      destinations: [{ id: "destination_001", title: "Batch Destination" }],
      harness,
      harnessLock
    }
  ], state, { cwd, persist });
}

function createHarnessManifest(overrides: Partial<TeamPackageManifest> = {}): TeamPackageManifest {
  return {
    schema: HUB_PACKAGE_MANIFEST_SCHEMA,
    kind: "team",
    key: "codex.webapp.team",
    version: "1.0.0",
    team: harnessEntityFromSnapshot(createDefaultHarness("Follow Origin protocol instructions.\nOrigin says: {{ currentDestination.title }}\nGoal: {{ requestGoal }}", [{
        kind: "registry-package",
        registryKind: "apm",
        name: "origin-skill" as NonEmptyText,
        registry: "https://apm.example.test" as NonEmptyText,
        package: "@apm/skills/origin-skill" as NonEmptyText,
        version: "1.0.0" as NonEmptyText,
        integrity: "sha256:origin-skill-integrity" as NonEmptyText,
        contentHash: "hunsu-test-origin-skill" as NonEmptyText
      }])),
    ...overrides
  };
}

async function startOriginServer(repo: string, name: string): Promise<{ server: Server; origin: HunsuOrigin }> {
  const storageRoot = join(repo, ".hunsu", "origin-store");
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://origin.test");
    const match = url.pathname.match(/^\/v1\/packages\/(team|member|manager|skill)\/([^/]+)\/versions\/([^/]+)$/);
    if (!match || request.method !== "GET") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end("{\"error\":\"Not found\"}\n");
      return;
    }
    const key = decodeURIComponent(match[2] ?? "");
    const version = decodeURIComponent(match[3] ?? "");
    const manifestPath = join(storageRoot, ...key.split("/"), `${version}.json`);
    if (!existsSync(manifestPath)) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end("{\"error\":\"Missing Hub package manifest\"}\n");
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(readFileSync(manifestPath, "utf8"));
  });
  const url = await listenUrl(server);
  return {
    server,
    origin: { name: name as NonEmptyText, url: url as NonEmptyText, transport: "http" }
  };
}

async function listenUrl(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Origin test server did not expose a TCP address");
  }
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    server.close(error => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function writeOriginManifest(repo: string, manifest: HubPackageManifest, origin = "motorhome"): HubPackageLock {
  const integrity = computeManifestIntegrity(manifest);
  const directory = join(repo, ".hunsu", "origin-store", ...manifest.key.split("/"));
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${manifest.version}.json`), JSON.stringify({ ...manifest, integrity }, null, 2), "utf8");
  return {
    origin: origin as NonEmptyText,
    kind: manifest.kind,
    key: manifest.key as NonEmptyText,
    version: manifest.version as NonEmptyText,
    integrity: integrity as NonEmptyText
  };
}

function writeUnsupportedHarnessManifest(repo: string, manifest: TeamPackageManifest, origin = "motorhome"): HubPackageLock {
  const directory = join(repo, ".hunsu", "origin-store", ...manifest.key.split("/"));
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${manifest.version}.json`), JSON.stringify({ ...manifest, schema: "hunsu.executing-protocol-manifest.v3" }, null, 2), "utf8");
  return {
    origin: origin as NonEmptyText,
    kind: manifest.kind,
    key: manifest.key as NonEmptyText,
    version: manifest.version as NonEmptyText,
    integrity: "hunsu-json-c14n-v1+sha256:2222222222222222222222222222222222222222222222222222222222222222" as NonEmptyText
  };
}

function decodeRuntimeHarness(cwd: string): { origins: HunsuOrigin[]; protocols: Array<{ harnessLock?: HubPackageLock }>; bindings: Array<{ executorPackageBindings?: unknown; resourcePackageBindings?: unknown }> } {
  const harnessText = run("git", ["show", `HEAD:${HUNSU_HARNESS_PATH}`], cwd);
  const resourcesText = run("git", ["show", `HEAD:${HUNSU_RESOURCES_PATH}`], cwd);
  const harness = decodeHunsuRuntimeFileText<{ origins: HunsuOrigin[]; harness: { lock?: HubPackageLock } }>(harnessText, HUNSU_HARNESS_PATH);
  const resources = decodeHunsuRuntimeFileText<{ bindings: Array<{ executorPackageBindings?: unknown; resourcePackageBindings?: unknown }> }>(resourcesText, HUNSU_RESOURCES_PATH);
  assert.equal(harness.ok, true);
  assert.equal(resources.ok, true);
  return {
    origins: harness.value.origins,
    protocols: [{ harnessLock: harness.value.harness.lock }],
    bindings: resources.value.bindings
  };
}

function currentPersistedBoard(cwd: string) {
  const state = createStudioState();
  selectStudioRepository(cwd, state, { persist: true });
  return selectStudioRepository(cwd, state, { persist: true }).board;
}

function studioRunFixture(): StudioRunState {
  return {
    runId: "run/req_batch",
    executeId: "F0001",
    requestId: "req_batch",
    lineId: "run/req_batch",
    repositoryPath: "/repo",
    provider: "codex",
    status: "running",
    selectedDestinationIds: ["destination_001"],
    providerThreadId: "thread-1",
    debugEvents: [],
    rawAppServerMessages: [],
    codexTurns: [],
    codexItems: [],
    agentSessions: [],
    activeItemIds: [],
    assistantTranscript: [],
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}

function nonExecutableHarness(kind: "role_squad" | "council_vote" | "court_debate"): HarnessSnapshot {
  switch (kind) {
    case "role_squad":
      return {
        kind,
        maxRoundCount: requireDomainValue(makePositiveInteger(3, "maxRoundCount")),
        team: { promptTemplate: promptTemplateFromText("Coordinate the squad.") },
        members: [
          createDefaultMemberConfig("planner", "Plan the attempt."),
          createDefaultMemberConfig("implementer", "Implement the attempt."),
          createDefaultMemberConfig("reviewer", "Review the attempt."),
          createDefaultMemberConfig("integrator", "Integrate the result.")
        ]
      };
    case "council_vote":
      return {
        kind,
        maxRoundCount: requireDomainValue(makePositiveInteger(3, "maxRoundCount")),
        voteRule: "majority",
        team: { promptTemplate: promptTemplateFromText("Coordinate the vote.") },
        members: [
          createDefaultMemberConfig("voter", "Vote on the result."),
          createDefaultMemberConfig("coordinator", "Coordinate the vote.")
        ]
      };
    case "court_debate":
      return {
        kind,
        maxRoundCount: requireDomainValue(makePositiveInteger(3, "maxRoundCount")),
        team: { promptTemplate: promptTemplateFromText("Coordinate the debate.") },
        members: [
          createDefaultMemberConfig("builder", "Argue for the result."),
          createDefaultMemberConfig("breaker", "Challenge the result."),
          createDefaultMemberConfig("judge", "Judge the debate.")
        ]
      };
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempts = 0; attempts < 50; attempts += 1) {
    if (predicate()) {
      return;
    }
    await delay(0);
  }
  assert.equal(predicate(), true);
}

async function waitForEventually(predicate: () => boolean): Promise<void> {
  for (let attempts = 0; attempts < 100; attempts += 1) {
    if (predicate()) {
      return;
    }
    await delay(10);
  }
  assert.equal(predicate(), true);
}

function jsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

function defaultExecutionPlanJson(): string {
  return JSON.stringify({
    kind: "queue",
    id: "builder-verifier",
    items: [{
      kind: "goal",
      stage: "needs_evaluation",
      id: "selected-destination",
      assignee: {
        executorId: "azir",
        goal: "Implement the selected Destination."
      },
      evaluator: {
        executorId: "galio",
        prompt: "Verify the implementation and report what you observed."
      },
      remainingAttempts: 2,
      requires: "PrevMove"
    }]
  });
}

function nestedTeamHarnessGraph(): Harness {
  const graph = harnessEntityFromSnapshot(createDefaultHarness());
  const rootTeam = graph.executors.find((executor): executor is Extract<Harness["executors"][number], { kind: "team" }> => executor.kind === "team" && executor.id === graph.rootTeamId);
  assert.ok(rootTeam);
  rootTeam.members = [{
    executorId: "child-team" as Harness["rootTeamId"],
    visibleProfile: {
      kind: "team",
      label: nt("Child Team"),
      summary: nt("Plans and executes implementation work.")
    }
  }];
  graph.executors.push({
    kind: "team",
    id: "child-team" as Harness["rootTeamId"],
    planner: {
      promptTemplate: promptTemplateFromText("Plan only for direct child Team members.")
    },
    members: [{
      executorId: "azir" as Harness["rootTeamId"],
      visibleProfile: {
        kind: "member",
        label: nt("Azir"),
        summary: nt("Implements the delegated nested Team goal.")
      }
    }]
  });
  return graph;
}

type SubscribeStreamTimelineSource =
  | "sse-connected"
  | "app-server-delta"
  | "runner-delta"
  | "sse-delta"
  | "app-server-completed";

type SubscribeStreamTimelineEntry = {
  source: SubscribeStreamTimelineSource;
  atMs: number;
  delta?: string;
  index?: number;
  method?: string;
  event?: string;
};

type SubscribeStreamTimeline = {
  originMs: number;
  entries: SubscribeStreamTimelineEntry[];
};

function createSubscribeStreamTimeline(): SubscribeStreamTimeline {
  return { originMs: performance.now(), entries: [] };
}

function recordSubscribeStreamTimeline(
  timeline: SubscribeStreamTimeline,
  entry: Omit<SubscribeStreamTimelineEntry, "atMs">
): void {
  timeline.entries.push({
    ...entry,
    atMs: Number((performance.now() - timeline.originMs).toFixed(3))
  });
}

class SubscribeStreamDeltaAcks {
  private readonly queued = new Map<string, number>();
  private readonly waiters = new Map<string, Array<() => void>>();
  private readonly timeline: SubscribeStreamTimeline;

  constructor(timeline: SubscribeStreamTimeline) {
    this.timeline = timeline;
  }

  acknowledge(delta: string): void {
    const waiters = this.waiters.get(delta);
    const waiter = waiters?.shift();
    if (waiter) {
      waiter();
      return;
    }
    this.queued.set(delta, (this.queued.get(delta) ?? 0) + 1);
  }

  async waitFor(delta: string, index: number): Promise<void> {
    const queuedCount = this.queued.get(delta) ?? 0;
    if (queuedCount > 0) {
      this.queued.set(delta, queuedCount - 1);
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Timed out waiting for SSE delta ${index}:${JSON.stringify(delta)}\n${formatSubscribeStreamTimeline(this.timeline)}`));
      }, 500);
      const resolveWaiter = () => {
        clearTimeout(timer);
        resolve();
      };
      const waiters = this.waiters.get(delta) ?? [];
      waiters.push(resolveWaiter);
      this.waiters.set(delta, waiters);
    });
  }
}

async function collectAgentSessionSseTimeline(
  url: string,
  timeline: SubscribeStreamTimeline,
  acks: SubscribeStreamDeltaAcks,
  expectedDeltaCount: number,
  signal: AbortSignal
): Promise<void> {
  const response = await fetch(url, { signal });
  assert.equal(response.ok, true);
  assert.ok(response.body);
  recordSubscribeStreamTimeline(timeline, { source: "sse-connected", event: "open" });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let deltaCount = 0;
  try {
    while (deltaCount < expectedDeltaCount) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf("\n\n");
        const sse = parseSseBlock(block);
        if (sse.event !== "agentMessage.delta" || !sse.data) {
          continue;
        }
        const event = JSON.parse(sse.data) as Extract<AgentSessionEvent, { type: "agentMessage.delta" }>;
        recordSubscribeStreamTimeline(timeline, {
          source: "sse-delta",
          event: sse.event,
          delta: event.delta,
          index: deltaCount
        });
        acks.acknowledge(event.delta);
        deltaCount += 1;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  assert.equal(deltaCount, expectedDeltaCount, formatSubscribeStreamTimeline(timeline));
}

function parseSseBlock(block: string): { event?: string; data?: string } {
  const data: string[] = [];
  let event: string | undefined;
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith("event:")) {
      event = line.slice("event:".length).trimStart();
    } else if (line.startsWith("data:")) {
      data.push(line.slice("data:".length).trimStart());
    }
  }
  return { event, data: data.length > 0 ? data.join("\n") : undefined };
}

function assertSubscribeStreamTimeline(timeline: SubscribeStreamTimeline, deltas: string[], timelinePath: string): void {
  const appServerDeltas = timeline.entries.filter((entry): entry is SubscribeStreamTimelineEntry & { source: "app-server-delta"; delta: string } => entry.source === "app-server-delta");
  const runnerDeltas = timeline.entries.filter((entry): entry is SubscribeStreamTimelineEntry & { source: "runner-delta"; delta: string } => entry.source === "runner-delta");
  const sseDeltas = timeline.entries.filter((entry): entry is SubscribeStreamTimelineEntry & { source: "sse-delta"; delta: string } => entry.source === "sse-delta");
  const completed = timeline.entries.find(entry => entry.source === "app-server-completed");
  const failureContext = () => `${formatSubscribeStreamTimeline(timeline)}\ntimelinePath=${timelinePath}`;

  assert.deepEqual(appServerDeltas.map(entry => entry.delta), deltas, failureContext());
  assert.deepEqual(runnerDeltas.map(entry => entry.delta), deltas, failureContext());
  assert.deepEqual(sseDeltas.map(entry => entry.delta), deltas, failureContext());
  assert.ok(completed, failureContext());

  for (let index = 0; index < deltas.length; index += 1) {
    const appServerDelta = appServerDeltas[index];
    const runnerDelta = runnerDeltas[index];
    const sseDelta = sseDeltas[index];
    assert.ok(appServerDelta && runnerDelta && sseDelta, failureContext());
    assert.ok(runnerDelta.atMs >= appServerDelta.atMs, failureContext());
    assert.ok(sseDelta.atMs >= runnerDelta.atMs, failureContext());
    assert.ok(sseDelta.atMs - runnerDelta.atMs < 250, failureContext());
    assert.ok(sseDelta.atMs < completed.atMs, failureContext());
    const nextAppServerDelta = appServerDeltas[index + 1];
    if (nextAppServerDelta) {
      assert.ok(sseDelta.atMs <= nextAppServerDelta.atMs, failureContext());
    }
  }
}

async function withSubscribeStreamTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeline: SubscribeStreamTimeline,
  timelinePath: string
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          writeFileSync(timelinePath, JSON.stringify(timeline, null, 2), "utf8");
          reject(new Error(`Subscribe stream timeline timed out after ${timeoutMs}ms\n${formatSubscribeStreamTimeline(timeline)}\ntimelinePath=${timelinePath}`));
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function formatSubscribeStreamTimeline(timeline: SubscribeStreamTimeline): string {
  return JSON.stringify(timeline.entries, null, 2);
}

class FakeRunner implements Runner {
  started?: TeamPlanningInput;
  memberPathRun?: MemberPathRunInput;
  moveFinalizerRun?: MoveFinalizerInput;
  hunsuDraftTurn?: HunsuDraftTurnInput;
  hunsuDraftResponse = "요청 파일을 확인했습니다. Draft check command로 DiffArtifact를 생성해 주세요.";
  resumed?: ResumeRunInput;
  providerStatusResponse?: CodexProviderStatus;
  hunsuDraftPrepared?: HunsuDraftSessionInput;
  paused: string[] = [];
  stopped: string[] = [];

  runTeamPlanning(input: TeamPlanningInput): Promise<RunnerRun> {
    this.started = input;
    return new Promise<RunnerRun>(() => undefined);
  }

  runMemberPath(input: MemberPathRunInput): Promise<RunnerRun> {
    this.memberPathRun = input;
    return new Promise<RunnerRun>(() => undefined);
  }

  runMoveFinalizer(input: MoveFinalizerInput): Promise<RunnerRun> {
    this.moveFinalizerRun = input;
    return new Promise<RunnerRun>(() => undefined);
  }

  prepareHunsuDraftSession(input: HunsuDraftSessionInput): Promise<RunnerRun> {
    this.hunsuDraftPrepared = input;
    return Promise.resolve({
      runId: input.runId,
      provider: "codex",
      providerThreadId: "thread-hunsu-draft-prepared"
    });
  }

  runHunsuDraftTurn(input: HunsuDraftTurnInput): Promise<RunnerRun> {
    this.hunsuDraftTurn = input;
    return Promise.resolve({
      runId: input.runId,
      provider: "codex",
      providerThreadId: input.providerThreadId ?? "thread-hunsu-draft",
      providerTurnId: "turn-hunsu-draft",
      finalResponse: this.hunsuDraftResponse
    });
  }

  resumeRun(input: ResumeRunInput): Promise<RunnerRun> {
    this.resumed = input;
    return new Promise<RunnerRun>(() => undefined);
  }

  pauseRun(runId: string): Promise<void> {
    this.paused.push(runId);
    return Promise.resolve();
  }

  stopRun(runId: string): Promise<void> {
    this.stopped.push(runId);
    return Promise.resolve();
  }

  providerStatus(): Promise<CodexProviderStatus> {
    return Promise.resolve(this.providerStatusResponse ?? { backend: "app-server", available: true });
  }

  async *events(runId: string): AsyncIterable<RunnerEvent> {
    yield { type: "runner.status.changed", runId, phase: "working", headline: "Started" };
  }
}

class TranscriptRunner extends FakeRunner {
  async *events(runId: string): AsyncIterable<RunnerEvent> {
    for (const delta of ["H", "e", "l", "l", "o"]) {
      yield {
        type: "runner.item.delta",
        runId,
        providerThreadId: "thread-team",
        providerTurnId: "turn-team",
        itemId: "msg_001",
        deltaKind: "agentMessage",
        delta
      };
    }
    yield {
      type: "runner.item.completed",
      runId,
      providerThreadId: "thread-team",
      providerTurnId: "turn-team",
      itemId: "msg_001",
      item: {
        id: "msg_001",
        type: "agentMessage",
        text: "Hello from completed payload",
        raw: { type: "agentMessage", id: "msg_001", text: "Hello from completed payload" }
      }
    };
  }
}

class ReasoningDeltaRunner extends FakeRunner {
  async *events(runId: string): AsyncIterable<RunnerEvent> {
    yield {
      type: "runner.item.delta",
      runId,
      providerThreadId: "thread-team",
      providerTurnId: "turn-team",
      itemId: "reasoning_001",
      deltaKind: "reasoningSummary",
      delta: "Considering path options"
    };
  }
}

class TimelineStreamingRunner extends FakeRunner {
  readonly deltas = ["alpha ", "beta ", "gamma ", "delta "];
  private readonly timeline: SubscribeStreamTimeline;
  private readonly acks: SubscribeStreamDeltaAcks;

  constructor(
    timeline: SubscribeStreamTimeline,
    acks: SubscribeStreamDeltaAcks
  ) {
    super();
    this.timeline = timeline;
    this.acks = acks;
  }

  async *events(runId: string): AsyncIterable<RunnerEvent> {
    for (const [index, delta] of this.deltas.entries()) {
      const rawMessage = {
        method: "item/agentMessage/delta",
        params: {
          threadId: "thread-team",
          turnId: "turn-team",
          itemId: "msg_timeline",
          delta
        }
      };
      recordSubscribeStreamTimeline(this.timeline, {
        source: "app-server-delta",
        method: rawMessage.method,
        delta,
        index
      });
      yield {
        type: "runner.appServer.message",
        runId,
        direction: "server-notification",
        providerThreadId: "thread-team",
        providerTurnId: "turn-team",
        method: rawMessage.method,
        message: rawMessage
      };
      recordSubscribeStreamTimeline(this.timeline, {
        source: "runner-delta",
        delta,
        index
      });
      yield {
        type: "runner.item.delta",
        runId,
        providerThreadId: "thread-team",
        providerTurnId: "turn-team",
        itemId: "msg_timeline",
        deltaKind: "agentMessage",
        delta
      };
      await this.acks.waitFor(delta, index);
    }
    recordSubscribeStreamTimeline(this.timeline, {
      source: "app-server-completed",
      method: "item/completed"
    });
    yield {
      type: "runner.appServer.message",
      runId,
      direction: "server-notification",
      providerThreadId: "thread-team",
      providerTurnId: "turn-team",
      method: "item/completed",
      message: {
        method: "item/completed",
        params: {
          threadId: "thread-team",
          turnId: "turn-team",
          item: { id: "msg_timeline", type: "agentMessage", text: this.deltas.join("") }
        }
      }
    };
    yield {
      type: "runner.item.completed",
      runId,
      providerThreadId: "thread-team",
      providerTurnId: "turn-team",
      itemId: "msg_timeline",
      item: {
        id: "msg_timeline",
        type: "agentMessage",
        text: this.deltas.join(""),
        raw: { type: "agentMessage", id: "msg_timeline", text: this.deltas.join("") }
      }
    };
  }
}

class DelayedDeltaRunner extends FakeRunner {
  async *events(runId: string): AsyncIterable<RunnerEvent> {
    yield {
      type: "runner.item.delta",
      runId,
      providerThreadId: "thread-team",
      providerTurnId: "turn-team",
      itemId: "msg_delayed",
      deltaKind: "agentMessage",
      delta: "first"
    };
    await delay(25);
    yield {
      type: "runner.item.delta",
      runId,
      providerThreadId: "thread-team",
      providerTurnId: "turn-team",
      itemId: "msg_delayed",
      deltaKind: "agentMessage",
      delta: " second"
    };
  }
}

class HeavyStreamingRunner extends FakeRunner {
  async *events(runId: string): AsyncIterable<RunnerEvent> {
    const rawPayload = "r".repeat(16 * 1024);
    for (let index = 0; index < 60; index += 1) {
      yield {
        type: "runner.appServer.message",
        runId,
        direction: "server-notification",
        providerThreadId: "thread-team",
        providerTurnId: "turn-team",
        method: "item/agentMessage/delta",
        message: {
          method: "item/agentMessage/delta",
          params: {
            threadId: "thread-team",
            turnId: "turn-team",
            itemId: "msg_heavy",
            index,
            rawPayload
          }
        }
      };
    }
    for (let index = 0; index < 1000; index += 1) {
      yield {
        type: "runner.item.delta",
        runId,
        providerThreadId: "thread-team",
        providerTurnId: "turn-team",
        itemId: "msg_heavy",
        deltaKind: "agentMessage",
        delta: "x".repeat(1024)
      };
    }
    yield {
      type: "runner.item.completed",
      runId,
      providerThreadId: "thread-team",
      providerTurnId: "turn-team",
      itemId: "msg_heavy",
      item: {
        id: "msg_heavy",
        type: "agentMessage",
        text: "y".repeat(1024 * 1024),
        raw: { type: "agentMessage", id: "msg_heavy", text: "y".repeat(1024 * 1024) }
      }
    };
  }
}

class AppServerItemRunner extends FakeRunner {
  async *events(runId: string): AsyncIterable<RunnerEvent> {
    yield {
      type: "runner.appServer.message",
      runId,
      direction: "server-notification",
      providerThreadId: "thread-team",
      providerTurnId: "turn-team",
      method: "item/started",
      message: { method: "item/started", params: { itemId: "cmd_001" } }
    };
    yield {
      type: "runner.item.started",
      runId,
      providerThreadId: "thread-team",
      providerTurnId: "turn-team",
      itemId: "cmd_001",
      item: {
        id: "cmd_001",
        type: "commandExecution",
        command: "cat src/app.ts",
        commandActions: [{ type: "read", command: "cat src/app.ts", path: "src/app.ts" }],
        raw: { type: "commandExecution", id: "cmd_001" }
      }
    };
    yield {
      type: "runner.item.delta",
      runId,
      providerThreadId: "thread-team",
      providerTurnId: "turn-team",
      itemId: "cmd_001",
      deltaKind: "commandOutput",
      delta: "hello\n"
    };
    yield {
      type: "runner.item.completed",
      runId,
      providerThreadId: "thread-team",
      providerTurnId: "turn-team",
      itemId: "cmd_001",
      item: {
        id: "cmd_001",
        type: "commandExecution",
        status: "completed",
        raw: { type: "commandExecution", id: "cmd_001", status: "completed" }
      }
    };
  }
}

class CompletingRunner implements Runner {
  started?: TeamPlanningInput;
  memberPathRun?: MemberPathRunInput;
  moveFinalizerRun?: MoveFinalizerInput;

  async runTeamPlanning(input: TeamPlanningInput): Promise<RunnerRun> {
    this.started = input;
    return {
      runId: input.runId,
      provider: "codex",
      providerThreadId: "thread-team",
      providerTurnId: "turn-team",
      finalResponse: defaultExecutionPlanJson()
    };
  }

  async runMemberPath(input: MemberPathRunInput): Promise<RunnerRun> {
    this.memberPathRun = input;
    if (input.memberPath.executorId === "azir") {
      writeFileSync(join(input.repositoryPath, "auto.txt"), "done\n", "utf8");
      return {
        runId: input.runId,
        provider: "codex",
        providerThreadId: "thread-member-azir",
        providerTurnId: "turn-member-azir",
        finalResponse: "Changed auto.txt and checked the worktree."
      };
    }
    const autoExists = existsSync(join(input.repositoryPath, "auto.txt"));
    return {
      runId: input.runId,
      provider: "codex",
      providerThreadId: "thread-member-galio",
      providerTurnId: "turn-member-galio",
      finalResponse: autoExists
        ? JSON.stringify({
            type: "pass",
            summary: "Verified the implementation and the endpoint responded as expected.",
            evidence: ["auto.txt exists"]
          })
        : JSON.stringify({
            type: "fail",
            reason: "auto.txt missing",
            feedback: "Create auto.txt with the completed result.",
            nextGoal: "Create auto.txt with the completed result."
          })
    };
  }

  async runMoveFinalizer(input: MoveFinalizerInput): Promise<RunnerRun> {
    this.moveFinalizerRun = input;
    return {
      runId: input.runId,
      provider: "codex",
      providerThreadId: "thread-finalizer",
      providerTurnId: "turn-finalizer",
      finalResponse: "Complete batch Destination\n\nSummary: auto.txt now contains the completed result."
    };
  }

  async runHunsuDraftTurn(input: HunsuDraftTurnInput): Promise<RunnerRun> {
    return {
      runId: input.runId,
      provider: "codex",
      providerThreadId: "thread-hunsu-draft",
      providerTurnId: "turn-hunsu-draft",
      finalResponse: "Draft reply"
    };
  }

  resumeRun(): Promise<RunnerRun> {
    throw new Error("unexpected resume");
  }

  pauseRun(): Promise<void> {
    return Promise.resolve();
  }

  stopRun(): Promise<void> {
    return Promise.resolve();
  }

  async *events(runId: string): AsyncIterable<RunnerEvent> {
    yield { type: "runner.status.changed", runId, phase: "working", headline: "Turn completed" };
  }
}

class GrandchildDelegationRunner extends CompletingRunner {
  override async runTeamPlanning(input: TeamPlanningInput): Promise<RunnerRun> {
    this.started = input;
    return {
      runId: input.runId,
      provider: "codex",
      providerThreadId: "thread-team",
      providerTurnId: "turn-team",
      finalResponse: JSON.stringify({
        kind: "goal",
        stage: "needs_evaluation",
        id: "selected-destination",
        assignee: {
          executorId: "grandchild",
          goal: "Bypass the direct Team membership boundary."
        },
        evaluator: null,
        remainingAttempts: 1,
        requires: "PrevMove"
      }, null, 2)
    };
  }

  override runMemberPath(input: MemberPathRunInput): Promise<RunnerRun> {
    this.memberPathRun = input;
    throw new Error("unexpected hidden Member Path");
  }
}

class NestedTeamDelegationRunner extends CompletingRunner {
  teamPlanningInputs: TeamPlanningInput[] = [];

  override async runTeamPlanning(input: TeamPlanningInput): Promise<RunnerRun> {
    this.started ??= input;
    this.teamPlanningInputs.push(input);
    const childScope = input.teamScopeId === "child-team";
    return {
      runId: input.runId,
      provider: "codex",
      providerThreadId: childScope ? "thread-child-team" : "thread-root-team",
      providerTurnId: childScope ? "turn-child-team" : "turn-root-team",
      finalResponse: JSON.stringify({
        kind: "goal",
        stage: "needs_evaluation",
        id: childScope ? "child-destination" : "root-destination",
        assignee: {
          executorId: childScope ? "azir" : "child-team",
          goal: childScope ? "Create the nested delegation marker." : "Delegate implementation to the child Team."
        },
        evaluator: null,
        remainingAttempts: 1,
        requires: "PrevMove"
      }, null, 2)
    };
  }

  override async runMemberPath(input: MemberPathRunInput): Promise<RunnerRun> {
    this.memberPathRun = input;
    assert.equal(input.memberPath.executorId, "azir");
    writeFileSync(join(input.repositoryPath, "auto.txt"), "nested\n", "utf8");
    return {
      runId: input.runId,
      provider: "codex",
      providerThreadId: "thread-member-azir",
      providerTurnId: "turn-member-azir",
      finalResponse: "Nested Team Member completed the work."
    };
  }
}

class RequestFileEditingRunner extends FakeRunner {
  override runHunsuDraftTurn(input: HunsuDraftTurnInput): Promise<RunnerRun> {
    this.hunsuDraftTurn = input;
    writeFileSync(join(input.repositoryPath, HUNSU_DRAFT_REQUEST_ARTIFACT_ACTIONS_PATH), JSON.stringify({
      schema: "hunsu.artifact-actions.v1",
      order: "display-order",
      actions: [{
        id: "typecheck",
        title: "Typecheck",
        kind: "check",
        sourceScope: "move-or-commit",
        runner: { type: "command", command: "pnpm run typecheck" },
        displayOrder: 0
      }]
    }, null, 2) + "\n", "utf8");
    return Promise.resolve({
      runId: input.runId,
      provider: "codex",
      providerThreadId: input.providerThreadId ?? "thread-hunsu-draft",
      providerTurnId: "turn-hunsu-draft",
      finalResponse: "Updated .hunsu-request/artifact-actions.json."
    });
  }
}

class HunsuDraftStreamingRunner extends FakeRunner {
  private eventTurnIndex = 0;

  override async *events(runId: string): AsyncIterable<RunnerEvent> {
    this.eventTurnIndex += 1;
    const providerThreadId = "thread-hunsu-draft-stream";
    const providerTurnId = `turn-hunsu-draft-stream-${this.eventTurnIndex}`;
    yield { type: "runner.turn.started", runId, providerThreadId, providerTurnId };
    yield {
      type: "runner.item.started",
      runId,
      providerThreadId,
      providerTurnId,
      itemId: "reasoning_stream_001",
      item: { id: "reasoning_stream_001", type: "reasoning", raw: { id: "reasoning_stream_001", type: "reasoning" } }
    };
    yield {
      type: "runner.item.delta",
      runId,
      providerThreadId,
      providerTurnId,
      itemId: "reasoning_stream_001",
      deltaKind: "reasoningSummary",
      delta: "Reading request files"
    };
    yield {
      type: "runner.item.completed",
      runId,
      providerThreadId,
      providerTurnId,
      itemId: "reasoning_stream_001",
      item: {
        id: "reasoning_stream_001",
        type: "reasoning",
        summary: ["Reading request files"],
        raw: { id: "reasoning_stream_001", type: "reasoning" }
      }
    };
    yield {
      type: "runner.item.started",
      runId,
      providerThreadId,
      providerTurnId,
      itemId: "command_stream_001",
      item: {
        id: "command_stream_001",
        type: "commandExecution",
        command: "node check.js",
        raw: { id: "command_stream_001", type: "commandExecution" }
      }
    };
    yield {
      type: "runner.item.delta",
      runId,
      providerThreadId,
      providerTurnId,
      itemId: "command_stream_001",
      deltaKind: "commandOutput",
      delta: "check passed\n"
    };
    yield {
      type: "runner.item.completed",
      runId,
      providerThreadId,
      providerTurnId,
      itemId: "command_stream_001",
      item: {
        id: "command_stream_001",
        type: "commandExecution",
        command: "node check.js",
        aggregatedOutput: "check passed\n",
        raw: { id: "command_stream_001", type: "commandExecution" }
      }
    };
    yield {
      type: "runner.item.completed",
      runId,
      providerThreadId,
      providerTurnId,
      itemId: "file_change_stream_001",
      item: {
        id: "file_change_stream_001",
        type: "fileChange",
        changes: [{ path: ".hunsu-request/destinations.json", kind: "updated" }],
        raw: { id: "file_change_stream_001", type: "fileChange" }
      }
    };
    yield {
      type: "runner.item.delta",
      runId,
      providerThreadId,
      providerTurnId,
      itemId: "assistant_stream_001",
      deltaKind: "agentMessage",
      delta: "Draft checked."
    };
    yield {
      type: "runner.item.completed",
      runId,
      providerThreadId,
      providerTurnId,
      itemId: "assistant_stream_001",
      item: {
        id: "assistant_stream_001",
        type: "agentMessage",
        text: "Draft checked.",
        raw: { id: "assistant_stream_001", type: "agentMessage" }
      }
    };
  }
}

type SlowDetachingSubscriber = {
  queue: RunnerEvent[];
  resolve?: () => void;
  closed: boolean;
};

class SlowDetachingStreamingRunner extends CompletingRunner {
  private readonly subscribers = new Set<SlowDetachingSubscriber>();

  override async runTeamPlanning(input: TeamPlanningInput): Promise<RunnerRun> {
    await delay(0);
    this.emitMessage(input.runId, "thread-team", "turn-team", "msg-team", ["Team"]);
    return super.runTeamPlanning(input);
  }

  override async runMemberPath(input: MemberPathRunInput): Promise<RunnerRun> {
    await delay(0);
    if (input.memberPath.executorId === "azir") {
      this.emitMessage(input.runId, "thread-member-azir", "turn-member-azir", "msg-member-azir", ["The", " first"]);
    } else {
      this.emitMessage(input.runId, "thread-member-galio", "turn-member-galio", "msg-member-galio", ["The", " review"]);
    }
    return super.runMemberPath(input);
  }

  override async runMoveFinalizer(input: MoveFinalizerInput): Promise<RunnerRun> {
    await delay(0);
    this.emitMessage(input.runId, "thread-finalizer", "turn-finalizer", "msg-finalizer", ["The", " final"]);
    return super.runMoveFinalizer(input);
  }

  override async *events(_runId: string): AsyncIterable<RunnerEvent> {
    const subscriber: SlowDetachingSubscriber = { queue: [], closed: false };
    this.subscribers.add(subscriber);
    try {
      while (true) {
        const event = subscriber.queue.shift();
        if (event) {
          yield event;
          continue;
        }
        if (subscriber.closed) {
          return;
        }
        await new Promise<void>(resolve => {
          subscriber.resolve = resolve;
        });
      }
    } finally {
      await delay(50);
      this.subscribers.delete(subscriber);
    }
  }

  private emitMessage(runId: string, providerThreadId: string, providerTurnId: string, itemId: string, deltas: string[]): void {
    this.openSubscribers();
    this.push({
      type: "runner.item.delta",
      runId: "other-run",
      providerThreadId: "thread-other-run",
      providerTurnId: "turn-other-run",
      itemId: "msg-other-run",
      deltaKind: "agentMessage",
      delta: "other run"
    });
    this.push({
      type: "runner.turn.started",
      runId,
      providerThreadId,
      providerTurnId
    });
    for (const delta of deltas) {
      this.push({
        type: "runner.item.delta",
        runId,
        providerThreadId,
        providerTurnId,
        itemId,
        deltaKind: "agentMessage",
        delta
      });
    }
    this.closeSubscribers();
  }

  private openSubscribers(): void {
    for (const subscriber of this.subscribers) {
      subscriber.closed = false;
    }
  }

  private push(event: RunnerEvent): void {
    for (const subscriber of this.subscribers) {
      subscriber.queue.push(event);
      subscriber.resolve?.();
      subscriber.resolve = undefined;
    }
  }

  private closeSubscribers(): void {
    for (const subscriber of this.subscribers) {
      subscriber.closed = true;
      subscriber.resolve?.();
      subscriber.resolve = undefined;
    }
  }
}

class RuntimeFileMutatingRunner extends CompletingRunner {
  override async runMemberPath(input: MemberPathRunInput): Promise<RunnerRun> {
    if (input.memberPath.executorId !== "azir") {
      return super.runMemberPath(input);
    }
    this.memberPathRun = input;
    writeFileSync(join(input.repositoryPath, "auto.txt"), "done\n", "utf8");
    writeFileSync(join(input.repositoryPath, HUNSU_DESTINATIONS_PATH), "agent-authored runtime mutation\n", "utf8");
    return {
      runId: input.runId,
      provider: "codex",
      providerThreadId: "thread-member-azir",
      providerTurnId: "turn-member-azir",
      finalResponse: "Changed auto.txt and runtime state."
    };
  }
}

class NaturalLanguageTerminalRunner extends CompletingRunner {
  override async runMemberPath(input: MemberPathRunInput): Promise<RunnerRun> {
    if (input.memberPath.executorId !== "galio") {
      return super.runMemberPath(input);
    }
    this.memberPathRun = input;
    return {
      runId: input.runId,
      provider: "codex",
      providerThreadId: "thread-member-galio",
      providerTurnId: "turn-member-galio",
      finalResponse: "Verified with a natural language report."
    };
  }
}

class CleanPassRunner implements Runner {
  started?: TeamPlanningInput;
  memberPathRun?: MemberPathRunInput;
  moveFinalizerRun?: MoveFinalizerInput;

  async runTeamPlanning(input: TeamPlanningInput): Promise<RunnerRun> {
    this.started = input;
    return {
      runId: input.runId,
      provider: "codex",
      providerThreadId: "thread-team",
      finalResponse: defaultExecutionPlanJson()
    };
  }

  async runMemberPath(input: MemberPathRunInput): Promise<RunnerRun> {
    this.memberPathRun = input;
    if (input.memberPath.executorId === "azir") {
      return {
        runId: input.runId,
        provider: "codex",
        providerThreadId: "thread-member-azir",
        providerTurnId: "turn-member-azir",
        finalResponse: "No changes were needed."
      };
    }
    return {
      runId: input.runId,
      provider: "codex",
      providerThreadId: "thread-member-galio",
      providerTurnId: "turn-member-galio",
      finalResponse: JSON.stringify({
        type: "pass",
        summary: "Reviewed the clean worktree and found no product changes."
      })
    };
  }

  async runMoveFinalizer(input: MoveFinalizerInput): Promise<RunnerRun> {
    this.moveFinalizerRun = input;
    return {
      runId: input.runId,
      provider: "codex",
      providerThreadId: "thread-finalizer",
      finalResponse: "Record clean completion\n\nNo file changes were needed."
    };
  }

  async runHunsuDraftTurn(input: HunsuDraftTurnInput): Promise<RunnerRun> {
    return {
      runId: input.runId,
      provider: "codex",
      providerThreadId: "thread-hunsu-draft",
      providerTurnId: "turn-hunsu-draft",
      finalResponse: "Draft reply"
    };
  }

  resumeRun(): Promise<RunnerRun> {
    throw new Error("unexpected resume");
  }

  pauseRun(): Promise<void> {
    return Promise.resolve();
  }

  stopRun(): Promise<void> {
    return Promise.resolve();
  }

  async *events(runId: string): AsyncIterable<RunnerEvent> {
    yield { type: "runner.status.changed", runId, phase: "working", headline: "Turn completed" };
  }
}

class ThrowingRunner implements Runner {
  runTeamPlanning(): Promise<RunnerRun> {
    throw new Error("agent crashed");
  }

  runMemberPath(): Promise<RunnerRun> {
    throw new Error("unexpected Member Path");
  }

  runMoveFinalizer(): Promise<RunnerRun> {
    throw new Error("unexpected MOVE finalizer");
  }

  runHunsuDraftTurn(): Promise<RunnerRun> {
    throw new Error("unexpected HUNSU Draft turn");
  }

  resumeRun(): Promise<RunnerRun> {
    throw new Error("unexpected resume");
  }

  pauseRun(): Promise<void> {
    return Promise.resolve();
  }

  stopRun(): Promise<void> {
    return Promise.resolve();
  }

  async *events(runId: string): AsyncIterable<RunnerEvent> {
    yield { type: "runner.error", runId, error: "agent crashed" };
  }
}
