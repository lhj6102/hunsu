import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  createDefaultHarness,
  decodeArtifactActionDefinitionArray,
  harnessEntityFromSnapshot,
  err,
  ok,
  rootHarnessSnapshot,
  tryProjectBoard,
  tryApplyCommand,
  validateHarnessEntity,
  validateDomainEvent,
  type Result
} from "@hunsu/protocol";
import type { AgentConversationRef, ArtifactActionDefinition, BoardProjection, Command, Destination, DomainEvent, ExecutorEntity, ExecutorId, GuardrailConfig, Harness, HubPackageLock, HunsuOrigin, MoveId, MoveRecord, NodeId, ExecutionPlan, PathId, MemberPath, PositiveInteger, ResourceEntity, WorktreeRef } from "@hunsu/protocol";
import { GitError } from "./errors.ts";
import { ensureGitRepository, git } from "./git.ts";
import { parseCommitSha, parseRuntimeChecksum } from "./primitives.ts";
import type { CommitSha, RuntimeChecksum } from "./primitives.ts";

export const HUNSU_COMPLETED_DESTINATIONS_PATH = ".hunsu/completed-destinations.hunsu";
export const HUNSU_DESTINATIONS_PATH = ".hunsu/destinations.hunsu";
export const HUNSU_HARNESS_PATH = ".hunsu/harness.hunsu";
export const HUNSU_EXECUTORS_PATH = ".hunsu/executors.hunsu";
export const HUNSU_RESOURCES_PATH = ".hunsu/resources.hunsu";
export const HUNSU_ARTIFACT_ACTIONS_PATH = ".hunsu/artifact-actions.hunsu";
export const HUNSU_CURRENT_EXECUTION_PATH = ".hunsu/current-execution.hunsu";
export const HUNSU_PREVIOUS_EXECUTION_PATH = ".hunsu/previous-execution.hunsu";
export const HUNSU_HUNSU_DRAFT_PATH = ".hunsu/hunsu-draft.hunsu";
export const HUNSU_RUNTIME_PATHS = [HUNSU_COMPLETED_DESTINATIONS_PATH, HUNSU_DESTINATIONS_PATH, HUNSU_HARNESS_PATH, HUNSU_EXECUTORS_PATH, HUNSU_RESOURCES_PATH, HUNSU_ARTIFACT_ACTIONS_PATH] as const;
export const HUNSU_LEGACY_STATE_PATH = ".hunsu/state.hunsu";
export const HUNSU_RUNTIME_ENCODING = "gzip+base64url";
export const HUNSU_DRAFT_RUNTIME_FILE_NAMES = ["destinations.json", "harness.json", "executors.json", "resources.json", "artifact-actions.json"] as const;
export const HUNSU_SELF_COMMIT_REF: MoveCommitRef = { type: "self" };
export const HUNSU_SELF_COMMIT_SENTINEL = "__HUNSU_SELF_COMMIT__";
const HUNSU_RUNTIME_HEADER = "HUNSU_RUNTIME_FILE_V1";
const LEGACY_STATE_HEADER = "HUNSU_STATE_V1";
const DOMAIN_EVENT_REF_PREFIX = "refs/hunsu/events";
const DOMAIN_EVENT_REF_FORMAT = "%(refname)\t%(objectname)\t%(objecttype)";
const DOMAIN_EVENT_REF_SEPARATOR = "\t";

export type DomainStore = {
  root: string;
  eventRefs: DomainEventRef[];
  events: DomainEvent[];
  board: BoardProjection;
  runtimePaths: typeof HUNSU_RUNTIME_PATHS;
  runtime: HunsuRuntimeState;
  source: "worktree-runtime" | "reachable-runtime" | "legacy-state" | "legacy-refs" | "empty";
  checksum: RuntimeChecksum;
  commit?: CommitSha;
};

export type DomainEventRef = {
  ref: string;
  object: string;
  objectType: string;
  ordinal: number;
};

export type DomainStoreError = {
  type: "DomainStoreError";
  message: string;
};

export type CompletedDestinationEntry = {
  destinationId: string;
  title: string;
  completedAt?: string;
  resultCommit: CommitSha | typeof HUNSU_SELF_COMMIT_SENTINEL | MoveCommitRef;
  moveId: MoveId;
  harnessId?: string;
  digest: {
    summary: string;
    evidence: string[];
    changedPaths?: string[];
    checks?: Array<{ command: string; status: "passed" | "failed"; summary?: string }>;
    risks?: string[];
    transcriptDigest?: string;
  };
};

export type HunsuCompletedDestinationsFile = {
  schema: "hunsu.completed-destinations.v1";
  order: "oldest-first-tail-append";
  entries: CompletedDestinationEntry[];
};

export type HunsuPendingDestinationsFile = {
  schema: "hunsu.destinations.v1";
  order: "queue-head-is-current";
  destinations: Destination[];
  compatibility: {
    events: DomainEvent[];
    updatedAt?: string;
  };
};

export type HunsuHarnessFile = {
  schema: "hunsu.harness.v1";
  origins?: HunsuOrigin[];
  harness: {
    name: string;
    rootTeamId: ExecutorId;
    guardrails?: GuardrailConfig[];
    lock?: HubPackageLock;
  };
};

export type HunsuExecutorsFile = {
  schema: "hunsu.executors.v1";
  executors: ExecutorEntity[];
};

export type HunsuResourcesFile = {
  schema: "hunsu.resources.v1";
  resources: ResourceEntity[];
  bindings: Array<{
    destinationId: string;
    executorPackageBindings?: BoardProjection["nodes"][number]["executorPackageBindings"];
    resourcePackageBindings?: BoardProjection["nodes"][number]["resourcePackageBindings"];
  }>;
};

export type HunsuArtifactActionsFile = {
  schema: "hunsu.artifact-actions.v1";
  order: "display-order";
  actions: ArtifactActionDefinition[];
};

export type HunsuRuntimeEventLog = {
  events: DomainEvent[];
  updatedAt?: string;
};

export type HunsuCurrentExecutionFile = {
  schema: "hunsu.current-execution.v1";
  execution: ExecutionPlan;
  updatedAt?: string;
};

export type MoveCommitRef =
  | { type: "self" }
  | { type: "external"; commit: CommitSha };

export type RouteNodeLifecycle = "Waiting" | "Executing" | "Completed" | "Failed";

export type PreviousExecutionAgentSessionRef = {
  sessionId: string;
  ownerKind: "TeamPlan" | "ExecutionPlan" | "MoveFinalizer";
  providerThreadId?: string;
  providerTurnId?: string;
  state: "waiting" | "starting" | "executing" | "interactWait" | "completed" | "failed";
  startedAt?: string;
  completedAt?: string;
  error?: string;
};

export type PlanNodeExecutionRecord = {
  nodeType: "PlanNode";
  lifecycle: Extract<RouteNodeLifecycle, "Completed" | "Failed">;
  session?: PreviousExecutionAgentSessionRef;
  completedAt?: string;
  error?: string;
};

export type PathNodeExecutionRecord = {
  nodeType: "PathNode";
  pathId: PathId;
  executorId: string;
  goal: string;
  requires: MemberPath["requires"];
  lifecycle: RouteNodeLifecycle;
  session?: PreviousExecutionAgentSessionRef;
  commit?: CommitSha;
  parentCommit?: CommitSha;
  treeChanged?: boolean;
  startedAt?: string;
  completedAt?: string;
  error?: string;
};

export type RouteNodeExecutionRecord = PlanNodeExecutionRecord | PathNodeExecutionRecord;

export type HunsuPreviousExecutionFile = {
  schema: "hunsu.previous-execution.v1";
  sourceMoveCommit: CommitSha;
  targetMoveId: MoveId;
  executeId: string;
  runId: string;
  lineId: string;
  sourceNodeId?: NodeId;
  sourceMoveId?: MoveId;
  targetMoveOrdinal?: PositiveInteger;
  selectedDestinationIds: string[];
  worktree?: WorktreeRef;
  conversationRef?: AgentConversationRef;
  plan: PlanNodeExecutionRecord;
  paths: PathNodeExecutionRecord[];
  pathCommits: Record<string, CommitSha>;
  terminalPathId?: PathId;
  terminalPathCommit?: CommitSha;
  finalizerSession?: PreviousExecutionAgentSessionRef;
  moveFinalizerCommit?: MoveCommitRef;
  moveFinalizerMessage?: string;
  startedAt?: string;
  completedAt?: string;
};

export type PreviousExecutionState =
  | { type: "none" }
  | { type: "present"; value: HunsuPreviousExecutionFile };

export type CurrentExecutionState =
  | { type: "none" }
  | { type: "present"; value: HunsuCurrentExecutionFile };

export type HunsuRuntimeState = {
  completed: HunsuCompletedDestinationsFile;
  destinations: HunsuPendingDestinationsFile;
  harness: HunsuHarnessFile;
  executors: HunsuExecutorsFile;
  resources: HunsuResourcesFile;
  artifactActions: HunsuArtifactActionsFile;
  currentExecution: CurrentExecutionState;
  previousExecution: PreviousExecutionState;
  eventLog: HunsuRuntimeEventLog;
};

export type HunsuDraftRuntimeFileName = (typeof HUNSU_DRAFT_RUNTIME_FILE_NAMES)[number];

export type HunsuDraftRuntimeBundle = Pick<HunsuRuntimeState, "destinations" | "harness" | "executors" | "resources" | "artifactActions">;

export type HunsuDraftRuntimeValidation = {
  previous: HunsuDraftRuntimeBundle;
  request: HunsuDraftRuntimeBundle;
  requestRuntime: HunsuRuntimeState;
};

export type EncodedHunsuRuntimeFile = {
  text: string;
  checksum: RuntimeChecksum;
};

type DecodedRuntimeFile<T> = {
  value: T;
  checksum: RuntimeChecksum;
};

type LegacyRuntimeState = {
  version: 1;
  events: DomainEvent[];
  updatedAt?: string;
};

export function loadDomainStore(cwd = process.cwd()): DomainStore {
  const root = ensureGitRepository(cwd);
  const worktreeRuntime = readHunsuRuntimeStateFromWorktree(root);
  const reachableRuntime = readLatestReachableHunsuRuntimeState(root);
  if (worktreeRuntime && (!reachableRuntime || runtimeEventCount(worktreeRuntime.runtime) >= runtimeEventCount(reachableRuntime.runtime))) {
    return domainStoreFromRuntime(root, worktreeRuntime.runtime, "worktree-runtime", [], worktreeRuntime.checksum);
  }
  if (reachableRuntime) {
    return domainStoreFromRuntime(root, reachableRuntime.runtime, "reachable-runtime", [], reachableRuntime.checksum, reachableRuntime.commit);
  }
  const legacyState = readLegacyHunsuRuntimeStateFromWorktree(root) ?? readLegacyHunsuRuntimeStateAtRef(root, "HEAD");
  if (legacyState) {
    const runtime = runtimeFromEvents(legacyState.state.events, undefined, legacyState.state.events);
    return domainStoreFromRuntime(root, runtime, "legacy-state", [], checksumRuntimeState(runtime));
  }
  const eventRefs = readDomainEventRefs(root);
  if (eventRefs.length > 0) {
    const events = eventRefs.map(ref => unwrapDomainStoreResult(readDomainEventObject(root, ref)));
    const runtime = runtimeFromEvents(events, undefined, events);
    return domainStoreFromRuntime(root, runtime, "legacy-refs", eventRefs, checksumRuntimeState(runtime));
  }
  const runtime = runtimeFromEvents([]);
  return domainStoreFromRuntime(root, runtime, "empty", [], checksumRuntimeState(runtime));
}

export function initializeDomainStore(cwd = process.cwd(), options: { commitMessage?: string } = {}): DomainStore {
  const root = ensureGitRepository(cwd);
  const store = loadDomainStore(root);
  if (store.source === "worktree-runtime") {
    return store;
  }
  writeHunsuRuntimeState(root, store.runtime);
  commitRuntimeStateIfRequested(root, options.commitMessage);
  return {
    ...store,
    source: "worktree-runtime"
  };
}

export function dryRunCommand(command: Command, cwd = process.cwd()): { store: DomainStore; acceptedEvents: DomainEvent[]; board: BoardProjection } {
  return dryRunCommands([command], cwd);
}

export function dryRunCommands(commands: Command[], cwd = process.cwd()): { store: DomainStore; acceptedEvents: DomainEvent[]; board: BoardProjection } {
  const store = loadDomainStore(cwd);
  const nextEvents = commands.reduce((events, command) => {
    const result = tryApplyCommand(events, command);
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    return result.value;
  }, store.events);
  const acceptedEvents = nextEvents.slice(store.events.length);
  return { store, acceptedEvents, board: projectDomainEvents(nextEvents, "dry-run commands") };
}

export function writeCommand(command: Command, options: { cwd?: string; commitMessage?: string; previousExecution?: PreviousExecutionState; selfCommitMoveIds?: string[] } = {}): { acceptedEvents: DomainEvent[]; board: BoardProjection } {
  return writeCommands([command], options);
}

export function writeCommands(commands: Command[], options: { cwd?: string; commitMessage?: string; previousExecution?: PreviousExecutionState; selfCommitMoveIds?: string[] } = {}): { acceptedEvents: DomainEvent[]; board: BoardProjection } {
  const cwd = options.cwd ?? process.cwd();
  const { store, acceptedEvents, board } = dryRunCommands(commands, cwd);
  if (acceptedEvents.length > 0) {
    const nextRuntime = runtimeFromEvents([...store.events, ...acceptedEvents], store.runtime, acceptedEvents, options.previousExecution);
    writeHunsuRuntimeState(store.root, nextRuntime, { selfCommitMoveIds: options.selfCommitMoveIds });
    commitRuntimeStateIfRequested(store.root, options.commitMessage);
  }
  return { acceptedEvents, board };
}

export function encodeHunsuRuntimeFile(value: unknown): EncodedHunsuRuntimeFile {
  const json = `${JSON.stringify(value)}\n`;
  const checksum = parseRuntimeChecksum(sha256(json));
  const payload = gzipSync(Buffer.from(json, "utf8")).toString("base64url");
  return {
    checksum,
    text: `${HUNSU_RUNTIME_HEADER}\nencoding: ${HUNSU_RUNTIME_ENCODING}\nchecksum: sha256:${checksum}\n\n${payload}\n`
  };
}

export function decodeHunsuRuntimeFileText<T = unknown>(text: string, source: string): Result<T, DomainStoreError> {
  const decoded = decodeRuntimeEnvelope(text, source, HUNSU_RUNTIME_HEADER);
  if (!decoded.ok) {
    return decoded;
  }
  return ok(decoded.value.value as T);
}

export function decodeRuntimeBundleToDraftFiles(runtime: HunsuRuntimeState): Record<HunsuDraftRuntimeFileName, unknown> {
  const bundle = hunsuDraftRuntimeBundleFromRuntime(runtime);
  return {
    "destinations.json": bundle.destinations,
    "harness.json": bundle.harness,
    "executors.json": bundle.executors,
    "resources.json": bundle.resources,
    "artifact-actions.json": bundle.artifactActions
  };
}

export function hunsuDraftRuntimeBundleFromRuntime(runtime: HunsuRuntimeState): HunsuDraftRuntimeBundle {
  return {
    destinations: cloneJson(runtime.destinations) as HunsuPendingDestinationsFile,
    harness: cloneJson(runtime.harness) as HunsuHarnessFile,
    executors: cloneJson(runtime.executors) as HunsuExecutorsFile,
    resources: cloneJson(runtime.resources) as HunsuResourcesFile,
    artifactActions: cloneJson(runtime.artifactActions) as HunsuArtifactActionsFile
  };
}

export function readDraftRuntimeBundle(cwd: string, dir: string): Result<HunsuDraftRuntimeBundle, DomainStoreError> {
  const root = ensureGitRepository(cwd);
  const destinations = readDraftRuntimeJson(root, dir, "destinations.json");
  if (!destinations.ok) return destinations;
  const harness = readDraftRuntimeJson(root, dir, "harness.json");
  if (!harness.ok) return harness;
  const executors = readDraftRuntimeJson(root, dir, "executors.json");
  if (!executors.ok) return executors;
  const resources = readDraftRuntimeJson(root, dir, "resources.json");
  if (!resources.ok) return resources;
  const artifactActions = readDraftRuntimeJson(root, dir, "artifact-actions.json");
  if (!artifactActions.ok) return artifactActions;
  return ok({
    destinations: destinations.value as HunsuPendingDestinationsFile,
    harness: harness.value as HunsuHarnessFile,
    executors: executors.value as HunsuExecutorsFile,
    resources: resources.value as HunsuResourcesFile,
    artifactActions: artifactActions.value as HunsuArtifactActionsFile
  });
}

export function validateDraftRuntimeBundle(
  previous: HunsuDraftRuntimeBundle,
  request: HunsuDraftRuntimeBundle,
  sourceRuntime: HunsuRuntimeState
): Result<HunsuDraftRuntimeValidation, DomainStoreError> {
  const sourceBundle = hunsuDraftRuntimeBundleFromRuntime(sourceRuntime);
  if (stableJson(previous) !== stableJson(sourceBundle)) {
    return domainStoreError(".hunsu-prev no longer matches the source runtime bundle");
  }
  if (stableJson(request.destinations.compatibility) !== stableJson(sourceRuntime.destinations.compatibility)) {
    return domainStoreError(".hunsu-request/destinations.json compatibility is Local-owned and must not be edited");
  }
  try {
    const requestRuntime = validateRuntimeState({
      completed: sourceRuntime.completed,
      destinations: request.destinations,
      harness: request.harness,
      executors: request.executors,
      resources: request.resources,
      artifactActions: request.artifactActions,
      currentExecution: sourceRuntime.currentExecution,
      previousExecution: sourceRuntime.previousExecution,
      eventLog: sourceRuntime.eventLog
    }, "draft request runtime");
    return ok({
      previous: hunsuDraftRuntimeBundleFromRuntime(sourceRuntime),
      request: hunsuDraftRuntimeBundleFromRuntime(requestRuntime),
      requestRuntime
    });
  } catch (error) {
    return domainStoreError(error instanceof Error ? error.message : String(error));
  }
}

export function encodeDraftRuntimeBundleToHunsuFiles(
  request: HunsuDraftRuntimeBundle
): Record<typeof HUNSU_DESTINATIONS_PATH | typeof HUNSU_HARNESS_PATH | typeof HUNSU_EXECUTORS_PATH | typeof HUNSU_RESOURCES_PATH | typeof HUNSU_ARTIFACT_ACTIONS_PATH, EncodedHunsuRuntimeFile> {
  return {
    [HUNSU_DESTINATIONS_PATH]: encodeHunsuRuntimeFile(request.destinations),
    [HUNSU_HARNESS_PATH]: encodeHunsuRuntimeFile(request.harness),
    [HUNSU_EXECUTORS_PATH]: encodeHunsuRuntimeFile(request.executors),
    [HUNSU_RESOURCES_PATH]: encodeHunsuRuntimeFile(request.resources),
    [HUNSU_ARTIFACT_ACTIONS_PATH]: encodeHunsuRuntimeFile(request.artifactActions)
  };
}

export function readHunsuRuntimeStateFromWorktree(cwd = process.cwd()): { runtime: HunsuRuntimeState; checksum: RuntimeChecksum } | undefined {
  const root = ensureGitRepository(cwd);
  if (!HUNSU_RUNTIME_PATHS.every(path => existsSync(join(root, path)))) {
    return undefined;
  }
  return readHunsuRuntimeStateFromSource(path => readFileSync(join(root, path), "utf8"), "worktree", currentHeadCommit(root));
}

export function readHunsuRuntimeStateAtRef(cwd = process.cwd(), ref = "HEAD"): { runtime: HunsuRuntimeState; checksum: RuntimeChecksum } | undefined {
  const root = ensureGitRepository(cwd);
  try {
    const commit = parseCommitSha(git(["rev-parse", "--verify", `${ref}^{commit}`], { cwd: root }).trim());
    return readHunsuRuntimeStateFromSource(path => git(["show", `${commit}:${path}`], { cwd: root }), commit, commit);
  } catch (error) {
    if (error instanceof GitError) {
      return undefined;
    }
    throw error;
  }
}

export function readReachableHunsuRuntimeStates(cwd = process.cwd()): Array<{ commit: CommitSha; runtime: HunsuRuntimeState; checksum: RuntimeChecksum }> {
  const root = ensureGitRepository(cwd);
  let commits: string[];
  try {
    commits = git(["rev-list", "--date-order", "--all", "--", HUNSU_DESTINATIONS_PATH], { cwd: root })
      .trim()
      .split(/\r?\n/)
      .filter(Boolean);
  } catch (error) {
    if (error instanceof GitError) {
      return [];
    }
    throw error;
  }
  return commits.flatMap(commit => {
    const commitSha = parseCommitSha(commit);
    const state = readHunsuRuntimeStateAtRef(root, commitSha);
    return state ? [{ commit: commitSha, ...state }] : [];
  });
}

export function readPreviousExecutionChain(cwd = process.cwd(), ref?: string): Array<{ commit: CommitSha; execution: HunsuPreviousExecutionFile }> {
  const root = ensureGitRepository(cwd);
  const visited = new Set<string>();
  const chain: Array<{ commit: CommitSha; execution: HunsuPreviousExecutionFile }> = [];
  let nextRef: string | undefined = ref ?? readLatestReachableHunsuRuntimeState(root)?.commit ?? "HEAD";
  while (nextRef) {
    let commit: CommitSha;
    try {
      commit = parseCommitSha(git(["rev-parse", "--verify", `${nextRef}^{commit}`], { cwd: root }).trim());
    } catch (error) {
      if (error instanceof GitError) {
        break;
      }
      throw error;
    }
    if (visited.has(commit)) {
      break;
    }
    visited.add(commit);
    const state = readHunsuRuntimeStateAtRef(root, commit);
    if (!state || state.runtime.previousExecution.type !== "present") {
      break;
    }
    chain.push({ commit, execution: state.runtime.previousExecution.value });
    nextRef = state.runtime.previousExecution.value.sourceMoveCommit;
  }
  return chain;
}

export function hasHunsuRuntimeState(cwd = process.cwd()): boolean {
  const root = ensureGitRepository(cwd);
  return readHunsuRuntimeStateFromWorktree(root) !== undefined || readLatestReachableHunsuRuntimeState(root) !== undefined;
}

export function readDomainEventRefs(cwd = process.cwd()): DomainEventRef[] {
  const root = ensureGitRepository(cwd);
  const output = git(["for-each-ref", `--format=${DOMAIN_EVENT_REF_FORMAT}`, DOMAIN_EVENT_REF_PREFIX], { cwd: root }).trim();
  if (!output) {
    return [];
  }
  return output
    .split(/\r?\n/)
    .map(parseDomainEventRef)
    .filter(ref => ref.objectType === "blob")
    .sort((left, right) => left.ordinal - right.ordinal || left.ref.localeCompare(right.ref));
}

export function readDomainEventObject(cwd: string, ref: Pick<DomainEventRef, "object" | "ref">): Result<DomainEvent, DomainStoreError> {
  const root = ensureGitRepository(cwd);
  const text = git(["cat-file", "-p", ref.object], { cwd: root });
  return decodeDomainEventText(text, ref.ref);
}

export function decodeDomainEventText(text: string, ref: string): Result<DomainEvent, DomainStoreError> {
  const trimmed = text.trim();
  if (!trimmed) {
    return domainStoreError(`Empty Hunsu domain event object: ${ref}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    return domainStoreError(`Invalid Hunsu domain event JSON in ${ref}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const validation = validateDomainEvent(parsed);
  if (!validation.ok) {
    return domainStoreError(`Invalid Hunsu domain event object in ${ref}: ${validation.error.message}`);
  }
  return ok(validation.value);
}

function runtimeFromEvents(
  events: DomainEvent[],
  previous?: HunsuRuntimeState,
  acceptedEvents: DomainEvent[] = [],
  previousExecutionOverride?: PreviousExecutionState
): HunsuRuntimeState {
  const board = projectDomainEvents(events, "runtime events");
  const eventLog = {
    events,
    updatedAt: acceptedEvents.length > 0 ? new Date().toISOString() : previous?.eventLog.updatedAt
  };
  return {
    completed: completedDestinationsFromEvents(board, previous?.completed, previous ? acceptedEvents : events),
    destinations: {
      schema: "hunsu.destinations.v1",
      order: "queue-head-is-current",
      destinations: pendingQueueFromBoard(board),
      compatibility: {
        events: eventLog.events,
        updatedAt: eventLog.updatedAt
      }
    },
    ...harnessExecutorsResourcesFilesFromBoard(board, previous),
    artifactActions: artifactActionsFileFromBoard(board),
    currentExecution: currentExecutionFromEvents(previous?.currentExecution, acceptedEvents),
    previousExecution: previousExecutionFromEvents(previous?.previousExecution, acceptedEvents, previousExecutionOverride),
    eventLog
  };
}

function currentExecutionFromEvents(
  previous: CurrentExecutionState | undefined,
  acceptedEvents: DomainEvent[]
): CurrentExecutionState {
  if (acceptedEvents.some(event => event.type === "HunsuRecorded" || event.type === "LineForkedByHunsu" || event.type === "MoveRecorded")) {
    return { type: "none" };
  }
  return previous ?? { type: "none" };
}

function previousExecutionFromEvents(
  previous: PreviousExecutionState | undefined,
  acceptedEvents: DomainEvent[],
  override: PreviousExecutionState | undefined
): PreviousExecutionState {
  if (override) {
    return override;
  }
  if (acceptedEvents.some(event => event.type === "HunsuRecorded" || event.type === "LineForkedByHunsu")) {
    return { type: "none" };
  }
  if (acceptedEvents.some(event => event.type === "MoveRecorded")) {
    return { type: "none" };
  }
  return previous ?? { type: "none" };
}

function completedDestinationsFromEvents(
  board: BoardProjection,
  previous: HunsuCompletedDestinationsFile | undefined,
  acceptedEvents: DomainEvent[]
): HunsuCompletedDestinationsFile {
  const entries = previous ? [...previous.entries] : [];
  for (const event of acceptedEvents) {
    if (event.type !== "MoveRecorded" || event.move.outcome !== "arrived") {
      continue;
    }
    for (const destinationId of event.move.reachedDestinationIds) {
      if (entries.some(entry => entry.moveId === event.move.id && entry.destinationId === destinationId)) {
        continue;
      }
      entries.push(completedEntryForMove(board, event.move, destinationId));
    }
  }
  return {
    schema: "hunsu.completed-destinations.v1",
    order: "oldest-first-tail-append",
    entries
  };
}

function completedEntryForMove(board: BoardProjection, move: MoveRecord, destinationId: string): CompletedDestinationEntry {
  const destination = move.snapshot?.destinations.find(candidate => candidate.id === destinationId)
    ?? board.destinations.find(candidate => candidate.id === destinationId);
  return {
    destinationId,
    title: destination?.title ?? destinationId,
    completedAt: move.recordedAt,
    resultCommit: runtimeCommitRef(move.commit),
    moveId: move.id,
    harnessId: "default",
    digest: {
      summary: move.summary,
      evidence: [...move.evidence],
      risks: move.risks ? [...move.risks] : undefined
    }
  };
}

function pendingQueueFromBoard(board: BoardProjection): Destination[] {
  return board.destinations
    .filter(destination => destination.status !== "reached" && destination.status !== "canceled" && destination.status !== "superseded")
    .sort((left, right) => (right.priority ?? 0) - (left.priority ?? 0) || left.id.localeCompare(right.id));
}

function harnessExecutorsResourcesFilesFromBoard(board: BoardProjection, previous: HunsuRuntimeState | undefined): Pick<HunsuRuntimeState, "harness" | "executors" | "resources"> {
  const activeLine = board.lines.findLast(line => line.status === "active") ?? board.lines.at(-1);
  const activeNode = activeLine ? board.nodes.find(node => node.id === activeLine.currentNodeId) : undefined;
  const harnessGraph = activeNode?.harnessGraph
    ?? (previous ? runtimeHarnessGraph(previous) : harnessEntityFromSnapshot(createDefaultHarness()));
  return {
    harness: {
      schema: "hunsu.harness.v1",
      origins: board.origins.map(origin => ({ ...origin })),
      harness: {
        name: "Default Harness",
        rootTeamId: harnessGraph.rootTeamId,
        guardrails: harnessGraph.guardrails.map(guardrail => ({ ...guardrail })),
        lock: activeNode?.harnessLock ? { ...activeNode.harnessLock } : previous?.harness.harness.lock
      }
    },
    executors: {
      schema: "hunsu.executors.v1",
      executors: cloneJson(harnessGraph.executors) as ExecutorEntity[]
    },
    resources: {
      schema: "hunsu.resources.v1",
      resources: cloneJson(harnessGraph.resources) as ResourceEntity[],
      bindings: board.destinations.map(destination => {
        const previousBinding = previous?.resources.bindings.find(binding => binding.destinationId === destination.id);
        return {
          destinationId: destination.id,
          executorPackageBindings: activeNode?.executorPackageBindings?.map(binding => ({ executorId: binding.executorId, lock: { ...binding.lock } })) ?? previousBinding?.executorPackageBindings,
          resourcePackageBindings: activeNode?.resourcePackageBindings?.map(binding => ({ name: binding.name, lock: { ...binding.lock } })) ?? previousBinding?.resourcePackageBindings
        };
      })
    }
  };
}

function artifactActionsFileFromBoard(board: BoardProjection): HunsuArtifactActionsFile {
  return {
    schema: "hunsu.artifact-actions.v1",
    order: "display-order",
    actions: board.artifactActions
      .map(cloneArtifactAction)
      .sort((left, right) => left.displayOrder - right.displayOrder || String(left.id).localeCompare(String(right.id)))
  };
}

function cloneArtifactAction(action: ArtifactActionDefinition): ArtifactActionDefinition {
  return {
    ...action,
    env: action.env ? Object.fromEntries(Object.entries(action.env).map(([key, value]) => [key, { ...value }])) : undefined,
    runner: { ...action.runner },
    aliases: action.aliases ? Object.fromEntries(Object.entries(action.aliases).map(([key, value]) => [key, { ...value }])) : undefined,
    evidence: action.evidence ? { ...action.evidence, paths: action.evidence.paths?.slice() } : undefined
  };
}

function readHunsuRuntimeStateFromSource(read: (path: string) => string, label: string, selfCommit?: CommitSha): { runtime: HunsuRuntimeState; checksum: RuntimeChecksum } | undefined {
  const completed = decodeRequiredRuntimeFile<HunsuCompletedDestinationsFile>(read, HUNSU_COMPLETED_DESTINATIONS_PATH, label);
  const destinations = decodeRequiredRuntimeFile<HunsuPendingDestinationsFile>(read, HUNSU_DESTINATIONS_PATH, label);
  const harness = decodeRequiredRuntimeFile<HunsuHarnessFile>(read, HUNSU_HARNESS_PATH, label);
  const executors = decodeRequiredRuntimeFile<HunsuExecutorsFile>(read, HUNSU_EXECUTORS_PATH, label);
  const resources = decodeRequiredRuntimeFile<HunsuResourcesFile>(read, HUNSU_RESOURCES_PATH, label);
  const artifactActions = decodeRequiredRuntimeFile<HunsuArtifactActionsFile>(read, HUNSU_ARTIFACT_ACTIONS_PATH, label);
  if (!completed || !destinations || !harness || !executors || !resources || !artifactActions) {
    return undefined;
  }
  const currentExecution = decodeOptionalRuntimeFile<HunsuCurrentExecutionFile>(read, HUNSU_CURRENT_EXECUTION_PATH, label);
  const previousExecution = decodeOptionalRuntimeFile<HunsuPreviousExecutionFile>(read, HUNSU_PREVIOUS_EXECUTION_PATH, label);
  const runtime = validateRuntimeState({
    completed: completed.value,
    destinations: destinations.value,
    harness: harness.value,
    executors: executors.value,
    resources: resources.value,
    artifactActions: artifactActions.value,
    currentExecution: currentExecution ? { type: "present", value: currentExecution.value } : { type: "none" },
    previousExecution: previousExecution ? { type: "present", value: previousExecution.value } : { type: "none" }
  }, label, selfCommit);
  return {
    runtime,
    checksum: parseRuntimeChecksum(sha256([completed.checksum, destinations.checksum, harness.checksum, executors.checksum, resources.checksum, artifactActions.checksum, currentExecution?.checksum ?? "none", previousExecution?.checksum ?? "none"].join("\n")))
  };
}

function decodeRequiredRuntimeFile<T>(read: (path: string) => string, path: string, label: string): DecodedRuntimeFile<T> | undefined {
  try {
    const decoded = decodeRuntimeEnvelope(read(path), `${label}:${path}`, HUNSU_RUNTIME_HEADER);
    return decoded.ok ? { value: decoded.value.value as T, checksum: decoded.value.checksum } : unwrapDomainStoreResult(decoded);
  } catch (error) {
    if (error instanceof GitError) {
      return undefined;
    }
    throw error;
  }
}

function decodeOptionalRuntimeFile<T>(read: (path: string) => string, path: string, label: string): DecodedRuntimeFile<T> | undefined {
  try {
    const decoded = decodeRuntimeEnvelope(read(path), `${label}:${path}`, HUNSU_RUNTIME_HEADER);
    return decoded.ok ? { value: decoded.value.value as T, checksum: decoded.value.checksum } : unwrapDomainStoreResult(decoded);
  } catch (error) {
    if (error instanceof GitError || isMissingFileError(error)) {
      return undefined;
    }
    throw error;
  }
}

function validateRuntimeState(runtime: Omit<HunsuRuntimeState, "eventLog"> & { eventLog?: HunsuRuntimeEventLog }, source: string, selfCommit?: CommitSha): HunsuRuntimeState {
  if (runtime.completed.schema !== "hunsu.completed-destinations.v1" || runtime.completed.order !== "oldest-first-tail-append" || !Array.isArray(runtime.completed.entries)) {
    throw new Error(`Invalid completed Destinations runtime file in ${source}`);
  }
  if (runtime.destinations.schema !== "hunsu.destinations.v1" || runtime.destinations.order !== "queue-head-is-current" || !Array.isArray(runtime.destinations.destinations)) {
    throw new Error(`Invalid pending Destinations runtime file in ${source}`);
  }
  if (!runtime.destinations.compatibility || !Array.isArray(runtime.destinations.compatibility.events)) {
    throw new Error(`Invalid pending Destinations compatibility data in ${source}`);
  }
  const events: DomainEvent[] = [];
  for (const [index, event] of runtime.destinations.compatibility.events.entries()) {
    const validation = validateDomainEvent(resolveRuntimeEventSelfCommit(event, selfCommit));
    if (!validation.ok) {
      throw new Error(`Invalid Hunsu runtime event ${index} in ${source}: ${validation.error.message}`);
    }
    events.push(validation.value);
  }
  const eventLog = {
    events,
    updatedAt: typeof runtime.destinations.compatibility.updatedAt === "string"
      ? runtime.destinations.compatibility.updatedAt
      : runtime.eventLog?.updatedAt
  };
  if (runtime.harness.schema !== "hunsu.harness.v1" || !runtime.harness.harness || typeof runtime.harness.harness.name !== "string") {
    throw new Error(`Invalid Harness runtime file in ${source}`);
  }
  if (Object.prototype.hasOwnProperty.call(runtime.harness.harness, "executors")) {
    throw new Error(`Invalid Harness runtime file in ${source}: Executor definitions are stored in executors.json`);
  }
  if (Object.prototype.hasOwnProperty.call(runtime.harness.harness, "members")) {
    throw new Error(`Invalid Harness runtime file in ${source}: members is stored in executors.json, not harness.json`);
  }
  if (Object.prototype.hasOwnProperty.call(runtime.harness.harness, "plan")) {
    throw new Error(`Invalid Harness runtime file in ${source}: root Team planner is stored in executors.json, not harness.json`);
  }
  if (typeof runtime.harness.harness.rootTeamId !== "string" || !runtime.harness.harness.rootTeamId.trim()) {
    throw new Error(`Invalid Harness runtime file in ${source}: rootTeamId must reference the locked root Team`);
  }
  if (runtime.executors.schema !== "hunsu.executors.v1" || !Array.isArray(runtime.executors.executors)) {
    throw new Error(`Invalid Executors runtime file in ${source}`);
  }
  if (runtime.resources.schema !== "hunsu.resources.v1" || !Array.isArray(runtime.resources.resources) || !Array.isArray(runtime.resources.bindings)) {
    throw new Error(`Invalid Resources runtime file in ${source}`);
  }
  const artifactActions = validateArtifactActionsRuntimeFile(runtime.artifactActions, source);
  const graph = runtimeHarnessGraph({
    ...runtime,
    artifactActions
  }, source);
  rootHarnessSnapshot(graph);
  const currentExecution = validateCurrentExecutionState(runtime.currentExecution, source);
  const previousExecution = validatePreviousExecutionState(runtime.previousExecution, source, selfCommit);
  return {
    completed: runtime.completed,
    destinations: {
      ...runtime.destinations,
      compatibility: { ...runtime.destinations.compatibility, events }
    },
    harness: {
      ...runtime.harness,
      harness: {
        name: runtime.harness.harness.name,
        rootTeamId: graph.rootTeamId,
        guardrails: graph.guardrails.map(guardrail => ({ ...guardrail })),
        lock: runtime.harness.harness.lock
      }
    },
    executors: {
      ...runtime.executors,
      executors: graph.executors
    },
    resources: {
      ...runtime.resources,
      resources: graph.resources
    },
    artifactActions,
    currentExecution,
    previousExecution,
    eventLog
  };
}

function runtimeHarnessGraph(runtime: Pick<HunsuRuntimeState, "harness" | "executors" | "resources" | "artifactActions">, source = "runtime"): Harness {
  const graph = validateHarnessEntity({
    rootTeamId: runtime.harness.harness.rootTeamId,
    executors: runtime.executors.executors,
    resources: runtime.resources.resources,
    guardrails: runtime.harness.harness.guardrails ?? [],
    artifactActions: runtime.artifactActions.actions
  }, `${source} Harness graph`);
  if (!graph.ok) {
    throw new Error(`Invalid Harness runtime graph in ${source}: ${graph.error.message}`);
  }
  return graph.value;
}

function validateArtifactActionsRuntimeFile(value: HunsuArtifactActionsFile, source: string): HunsuArtifactActionsFile {
  if (value.schema !== "hunsu.artifact-actions.v1" || value.order !== "display-order" || !Array.isArray(value.actions)) {
    throw new Error(`Invalid Artifact Actions runtime file in ${source}`);
  }
  const actions = decodeArtifactActionDefinitionArray(value.actions, "artifactActions.actions");
  if (!actions.ok) {
    throw new Error(`Invalid Artifact Actions runtime file in ${source}: ${actions.error.message}`);
  }
  return { ...value, actions: actions.value };
}

function validateCurrentExecutionState(value: CurrentExecutionState | undefined, source: string): CurrentExecutionState {
  if (!value || value.type === "none") {
    return { type: "none" };
  }
  if (value.type !== "present" || !value.value || value.value.schema !== "hunsu.current-execution.v1") {
    throw new Error(`Invalid current execution runtime file in ${source}`);
  }
  if (!value.value.execution || typeof value.value.execution !== "object") {
    throw new Error(`Invalid current execution payload in ${source}`);
  }
  return value;
}

function validatePreviousExecutionState(value: PreviousExecutionState | undefined, source: string, selfCommit?: CommitSha): PreviousExecutionState {
  if (!value || value.type === "none") {
    return { type: "none" };
  }
  if (value.type !== "present" || !value.value || value.value.schema !== "hunsu.previous-execution.v1") {
    throw new Error(`Invalid previous execution runtime file in ${source}`);
  }
  if (!value.value.sourceMoveCommit || !value.value.targetMoveId || !value.value.executeId || !value.value.runId || !value.value.lineId) {
    throw new Error(`Invalid previous execution identity in ${source}`);
  }
  if (!value.value.plan || value.value.plan.nodeType !== "PlanNode") {
    throw new Error(`Invalid previous execution PlanNode in ${source}`);
  }
  if (!Array.isArray(value.value.paths)) {
    throw new Error(`Invalid previous execution PathNode list in ${source}`);
  }
  const moveFinalizerCommit = value.value.moveFinalizerCommit;
  if (isSelfMoveCommitRef(moveFinalizerCommit)) {
    if (!selfCommit) {
      throw new Error(`Cannot resolve previous execution self commit in ${source}`);
    }
    return { type: "present", value: { ...value.value, moveFinalizerCommit: { type: "external", commit: selfCommit } } };
  }
  return value;
}

function resolveRuntimeEventSelfCommit(event: DomainEvent, selfCommit: CommitSha | undefined): unknown {
  if (event.type !== "MoveRecorded") {
    return event;
  }
  const commit = (event.move as { commit?: unknown }).commit;
  if (isSelfMoveCommitRef(commit)) {
    if (!selfCommit) {
      throw new Error("Cannot resolve self MOVE commit without containing commit");
    }
    return { ...event, move: { ...event.move, commit: selfCommit } };
  }
  if (commit === HUNSU_SELF_COMMIT_SENTINEL) {
    if (!selfCommit) {
      throw new Error("Cannot resolve self MOVE commit without containing commit");
    }
    return { ...event, move: { ...event.move, commit: selfCommit } };
  }
  return event;
}

function isSelfMoveCommitRef(value: unknown): value is Extract<MoveCommitRef, { type: "self" }> {
  return Boolean(value && typeof value === "object" && (value as { type?: unknown }).type === "self");
}

function runtimeCommitRef(value: unknown): CompletedDestinationEntry["resultCommit"] {
  if (isSelfMoveCommitRef(value)) {
    return HUNSU_SELF_COMMIT_REF;
  }
  if (value === HUNSU_SELF_COMMIT_SENTINEL) {
    return HUNSU_SELF_COMMIT_SENTINEL;
  }
  return parseCommitSha(String(value));
}

function writeHunsuRuntimeState(cwd: string, runtime: HunsuRuntimeState, options: { selfCommitMoveIds?: string[] } = {}): void {
  const root = ensureGitRepository(cwd);
  writeRuntimeFile(root, HUNSU_COMPLETED_DESTINATIONS_PATH, runtime.completed);
  writeRuntimeFile(root, HUNSU_DESTINATIONS_PATH, destinationsForEncoding(runtime, options.selfCommitMoveIds ?? []));
  writeRuntimeFile(root, HUNSU_HARNESS_PATH, runtime.harness);
  writeRuntimeFile(root, HUNSU_EXECUTORS_PATH, runtime.executors);
  writeRuntimeFile(root, HUNSU_RESOURCES_PATH, runtime.resources);
  writeRuntimeFile(root, HUNSU_ARTIFACT_ACTIONS_PATH, runtime.artifactActions);
  writeCurrentExecutionRuntimeFile(root, runtime.currentExecution);
  writePreviousExecutionRuntimeFile(root, runtime.previousExecution, options.selfCommitMoveIds ?? []);
}

function writeRuntimeFile(root: string, path: string, value: unknown): void {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, encodeHunsuRuntimeFile(value).text, "utf8");
}

function writeCurrentExecutionRuntimeFile(root: string, state: CurrentExecutionState): void {
  const file = join(root, HUNSU_CURRENT_EXECUTION_PATH);
  if (state.type === "none") {
    if (existsSync(file)) {
      rmSync(file, { force: true });
    }
    return;
  }
  writeRuntimeFile(root, HUNSU_CURRENT_EXECUTION_PATH, state.value);
}

function writePreviousExecutionRuntimeFile(root: string, state: PreviousExecutionState, selfCommitMoveIds: string[]): void {
  const file = join(root, HUNSU_PREVIOUS_EXECUTION_PATH);
  if (state.type === "none") {
    if (existsSync(file)) {
      rmSync(file, { force: true });
    }
    return;
  }
  const value = previousExecutionForEncoding(state.value, selfCommitMoveIds);
  writeRuntimeFile(root, HUNSU_PREVIOUS_EXECUTION_PATH, value);
}

function destinationsForEncoding(runtime: HunsuRuntimeState, selfCommitMoveIds: string[]): HunsuPendingDestinationsFile {
  return {
    ...runtime.destinations,
    compatibility: {
      events: runtime.eventLog.events.map(event => eventForEncoding(event, selfCommitMoveIds)),
      updatedAt: runtime.eventLog.updatedAt
    }
  };
}

function eventForEncoding(event: DomainEvent, selfCommitMoveIds: string[]): DomainEvent {
  if (event.type !== "MoveRecorded" || !selfCommitMoveIds.includes(String(event.move.id))) {
    return event;
  }
  return { ...event, move: { ...event.move, commit: HUNSU_SELF_COMMIT_REF } as unknown as MoveRecord };
}

function previousExecutionForEncoding(value: HunsuPreviousExecutionFile, selfCommitMoveIds: string[]): HunsuPreviousExecutionFile {
  if (!value.moveFinalizerCommit || value.moveFinalizerCommit.type !== "external" || !selfCommitMoveIds.includes(value.targetMoveId)) {
    return value;
  }
  return { ...value, moveFinalizerCommit: HUNSU_SELF_COMMIT_REF };
}

function commitRuntimeStateIfRequested(cwd: string, commitMessage: string | undefined): void {
  if (!commitMessage) {
    return;
  }
  const paths = stageableRuntimePaths(cwd);
  if (paths.length === 0) {
    return;
  }
  git(["add", "--all", "--", ...paths], { cwd });
  const status = git(["status", "--porcelain=v1", "--", ...paths], { cwd }).trim();
  if (!status) {
    return;
  }
  git(["commit", "--only", "-m", commitMessage, "--", ...paths], { cwd });
}

function stageableRuntimePaths(cwd: string): string[] {
  return [...HUNSU_RUNTIME_PATHS, HUNSU_CURRENT_EXECUTION_PATH, HUNSU_PREVIOUS_EXECUTION_PATH].filter(path => existsSync(join(cwd, path)) || isTrackedPath(cwd, path));
}

function isTrackedPath(cwd: string, path: string): boolean {
  try {
    git(["ls-files", "--error-unmatch", path], { cwd });
    return true;
  } catch (error) {
    if (error instanceof GitError) {
      return false;
    }
    throw error;
  }
}

function domainStoreFromRuntime(
  root: string,
  runtime: HunsuRuntimeState,
  source: DomainStore["source"],
  eventRefs: DomainEventRef[],
  checksum: RuntimeChecksum,
  commit?: CommitSha
): DomainStore {
  const events = [...runtime.eventLog.events];
  return {
    root,
    eventRefs,
    events,
    board: projectDomainEvents(events, source),
    runtimePaths: HUNSU_RUNTIME_PATHS,
    runtime,
    source,
    checksum,
    commit
  };
}

function projectDomainEvents(events: DomainEvent[], source: string): BoardProjection {
  const projected = tryProjectBoard(events);
  if (!projected.ok) {
    throw new Error(`Invalid Hunsu domain event stream in ${source}: ${projected.error.message}`);
  }
  return projected.value;
}

function readLatestReachableHunsuRuntimeState(cwd: string): { commit: CommitSha; runtime: HunsuRuntimeState; checksum: RuntimeChecksum } | undefined {
  return readReachableHunsuRuntimeStates(cwd)
    .sort((left, right) => runtimeEventCount(right.runtime) - runtimeEventCount(left.runtime))
    .at(0);
}

function runtimeEventCount(runtime: HunsuRuntimeState): number {
  return runtime.eventLog.events.length;
}

function checksumRuntimeState(runtime: HunsuRuntimeState): RuntimeChecksum {
  return parseRuntimeChecksum(sha256([
    encodeHunsuRuntimeFile(runtime.completed).checksum,
    encodeHunsuRuntimeFile(destinationsForEncoding(runtime, [])).checksum,
    encodeHunsuRuntimeFile(runtime.harness).checksum,
    encodeHunsuRuntimeFile(runtime.executors).checksum,
    encodeHunsuRuntimeFile(runtime.resources).checksum,
    encodeHunsuRuntimeFile(runtime.artifactActions).checksum,
    runtime.currentExecution.type === "present" ? encodeHunsuRuntimeFile(runtime.currentExecution.value).checksum : "none",
    runtime.previousExecution.type === "present" ? encodeHunsuRuntimeFile(runtime.previousExecution.value).checksum : "none"
  ].join("\n")));
}

function decodeRuntimeEnvelope(text: string, source: string, expectedHeader: string): Result<{ value: unknown; checksum: RuntimeChecksum }, DomainStoreError> {
  const normalized = text.replace(/\r\n/g, "\n");
  const separator = normalized.indexOf("\n\n");
  if (separator === -1) {
    return domainStoreError(`Invalid Hunsu runtime envelope in ${source}`);
  }
  const header = normalized.slice(0, separator).split("\n");
  const payload = normalized.slice(separator + 2).trim();
  if (header[0] !== expectedHeader) {
    return domainStoreError(`Invalid Hunsu runtime header in ${source}`);
  }
  const metadata = new Map(header.slice(1).map(line => {
    const index = line.indexOf(":");
    return index === -1 ? [line.trim(), ""] : [line.slice(0, index).trim(), line.slice(index + 1).trim()];
  }));
  if (metadata.get("encoding") !== HUNSU_RUNTIME_ENCODING) {
    return domainStoreError(`Unsupported Hunsu runtime encoding in ${source}: ${metadata.get("encoding") ?? "missing"}`);
  }
  const expectedChecksum = metadata.get("checksum")?.replace(/^sha256:/, "");
  if (!expectedChecksum) {
    return domainStoreError(`Missing Hunsu runtime checksum in ${source}`);
  }
  let json: string;
  try {
    json = gunzipSync(Buffer.from(payload, "base64url")).toString("utf8");
  } catch (error) {
    return domainStoreError(`Invalid Hunsu runtime payload in ${source}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const actualChecksum = sha256(json);
  if (actualChecksum !== expectedChecksum) {
    return domainStoreError(`Hunsu runtime checksum mismatch in ${source}`);
  }
  try {
    return ok({ value: JSON.parse(json), checksum: parseRuntimeChecksum(actualChecksum) });
  } catch (error) {
    return domainStoreError(`Invalid Hunsu runtime JSON in ${source}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function readLegacyHunsuRuntimeStateFromWorktree(cwd: string): { state: LegacyRuntimeState; checksum: RuntimeChecksum } | undefined {
  const root = ensureGitRepository(cwd);
  const path = join(root, HUNSU_LEGACY_STATE_PATH);
  if (!existsSync(path)) {
    return undefined;
  }
  const state = unwrapDomainStoreResult(decodeLegacyHunsuRuntimeStateText(readFileSync(path, "utf8"), path));
  return { state, checksum: checksumLegacyRuntimeState(state) };
}

function readLegacyHunsuRuntimeStateAtRef(cwd: string, ref: string): { state: LegacyRuntimeState; checksum: RuntimeChecksum } | undefined {
  const root = ensureGitRepository(cwd);
  try {
    const text = git(["show", `${ref}:${HUNSU_LEGACY_STATE_PATH}`], { cwd: root });
    const state = unwrapDomainStoreResult(decodeLegacyHunsuRuntimeStateText(text, `${ref}:${HUNSU_LEGACY_STATE_PATH}`));
    return { state, checksum: checksumLegacyRuntimeState(state) };
  } catch (error) {
    if (error instanceof GitError) {
      return undefined;
    }
    throw error;
  }
}

function decodeLegacyHunsuRuntimeStateText(text: string, source: string): Result<LegacyRuntimeState, DomainStoreError> {
  const decoded = decodeRuntimeEnvelope(text, source, LEGACY_STATE_HEADER);
  if (!decoded.ok) {
    return decoded;
  }
  const value = decoded.value.value;
  if (!value || typeof value !== "object") {
    return domainStoreError(`Invalid legacy Hunsu runtime state JSON in ${source}: expected object`);
  }
  const record = value as { version?: unknown; events?: unknown; updatedAt?: unknown };
  if (record.version !== 1 || !Array.isArray(record.events)) {
    return domainStoreError(`Invalid legacy Hunsu runtime state in ${source}`);
  }
  const events: DomainEvent[] = [];
  for (const [index, event] of record.events.entries()) {
    const validation = validateDomainEvent(event);
    if (!validation.ok) {
      return domainStoreError(`Invalid legacy Hunsu runtime state event ${index} in ${source}: ${validation.error.message}`);
    }
    events.push(validation.value);
  }
  return ok({
    version: 1,
    events,
    ...(typeof record.updatedAt === "string" ? { updatedAt: record.updatedAt } : {})
  });
}

function checksumLegacyRuntimeState(state: LegacyRuntimeState): RuntimeChecksum {
  return parseRuntimeChecksum(sha256(`${JSON.stringify(state)}\n`));
}

function domainStoreError(message: string): Result<never, DomainStoreError> {
  return err({ type: "DomainStoreError", message });
}

function readDraftRuntimeJson(root: string, dir: string, fileName: HunsuDraftRuntimeFileName): Result<unknown, DomainStoreError> {
  const path = join(root, dir, fileName);
  try {
    return ok(JSON.parse(readFileSync(path, "utf8")) as unknown);
  } catch (error) {
    return domainStoreError(`Cannot read ${dir}/${fileName}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortJson(entry)]));
  }
  return value;
}

function unwrapDomainStoreResult<T>(result: Result<T, DomainStoreError>): T {
  if (result.ok) {
    return result.value;
  }
  throw new Error(result.error.message);
}

function currentHeadCommit(cwd: string): CommitSha | undefined {
  try {
    return parseCommitSha(git(["rev-parse", "--verify", "HEAD^{commit}"], { cwd }).trim());
  } catch (error) {
    if (error instanceof GitError) {
      return undefined;
    }
    throw error;
  }
}

function isMissingFileError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return "code" in error && (error as { code?: unknown }).code === "ENOENT";
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function parseDomainEventRef(line: string): DomainEventRef {
  const [ref, object, objectType] = line.split(DOMAIN_EVENT_REF_SEPARATOR);
  return {
    ref,
    object,
    objectType,
    ordinal: parseDomainEventOrdinal(ref)
  };
}

function parseDomainEventOrdinal(ref: string): number {
  const leaf = ref.slice(ref.lastIndexOf("/") + 1);
  const match = leaf.match(/^E(\d+)(?:-|$)/);
  return match ? Number.parseInt(match[1], 10) : Number.MAX_SAFE_INTEGER;
}
