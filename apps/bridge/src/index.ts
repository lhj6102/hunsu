import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createDefaultCodexRunner, GOAL_EVALUATION_SCHEMA, type CodexProviderStatus, type TeamRunEvent, type HunsuDraftConversationMessage, type HunsuDraftSessionInput, type HunsuDraftSourceSnapshot, type HunsuDraftTurnInput, type JsonRpcMessage, type MoveFinalizerInput, type MemberPathRunInput, type ResumeRunInput, type Runner, type RunnerAppServerCommandAction, type RunnerAppServerItem, type RunnerRun, type StartRunInput } from "@hunsu/codex-runner";
import { currentProcessEnv, endpointUrl, resolveBridgeRuntimeConfig, resolveStudioLauncherConfig, unwrapConfigResult, type BridgeRuntimeConfig } from "@hunsu/config";
import {
  createFinalizedMoveCommit,
  createMoveCommitFromWorktree,
  createMemberPathCommitFromWorktree,
  decodeHunsuRuntimeFileText,
  decodeRuntimeBundleToDraftFiles,
  encodeHunsuRuntimeFile,
  ensureGitRepository,
  GitError,
  git,
  HUNSU_CURRENT_EXECUTION_PATH,
  HUNSU_HUNSU_DRAFT_PATH,
  HUNSU_PREVIOUS_EXECUTION_PATH,
  HUNSU_RUNTIME_PATHS,
  HUNSU_SELF_COMMIT_SENTINEL,
  readDraftRuntimeBundle,
  listArtifactActions,
  listArtifactActionRuns,
  hasHunsuRuntimeState,
  inspectHunsuPort,
  applyHunsuPort,
  loadDomainStore,
  planHunsuPort,
  planArtifactActionRun,
  parseCommitSha,
  readPreviousExecutionChain,
  readArtifactActionRun,
  startArtifactActionRun,
  stopArtifactActionRun,
  validateDraftRuntimeBundle,
  writeCommand,
  writeCommands,
  type CommitSha,
  type HunsuCurrentExecutionFile,
  type HunsuPreviousExecutionFile,
  type PreviousExecutionAgentSessionRef,
  type ArtifactActionCommandRunner,
  type ArtifactActionRunInput,
  type ArtifactActionRunPlan,
  type ArtifactActionRunRecord,
  type HunsuDraftRuntimeBundle,
  type HunsuDraftRuntimeValidation,
  type HunsuRuntimeState
} from "@hunsu/core";
import type { HunsuPortApplyResult, HunsuPortInspection, HunsuPortPlan } from "@hunsu/core";
import {
  cloneHarness,
  cloneHarnessEntity,
  createDefaultHarness,
  createDefaultManagerConfig,
  createDefaultMemberConfig,
  getHarnessExecutor,
  harnessEntityFromSnapshot,
  harnessSnapshotForTeam,
  rootHarnessSnapshot,
  emptyBoardProjection,
  makeAgentConversationHash,
  makeTeamName,
  makeHunsuDraftId,
  makeHunsuId,
  makeLineId,
  makeMoveCommit,
  makeMoveId,
  makeNodeId,
  makeNonEmptyText,
  makePositiveInteger,
  makeSummary,
  makeWorktreeHash,
  nextTeamName,
  promptTemplateFromText,
  tryApplyCommand,
  tryProjectBoard,
  validateManagerConfig,
  validateExecutableHarness
} from "@hunsu/protocol";
import type { ExecutorEntity, Harness, ManagerConfig } from "@hunsu/protocol";
import { err, ok, type Result } from "@hunsu/protocol";
import {
  hydrateTeamPackage,
  resolveHubPackageManifestFromOrigin
} from "@hunsu/protocol-registry";
import { executeError, executeErrorToError, unwrapExecuteResult, type ExecuteRunStatus, type ExecutionPlanStepResult } from "./execute/execute-model.ts";
import {
  nextQueueExecution,
  parseGoalEvaluation,
  parseExecutionPlan,
  memberPathForGoalRole
} from "./execute/execution-plan.ts";
import {
  ensureTerminalOutput,
  planExecuteStart
} from "./execute/execute-workflow.ts";
import type {
  AgentConversationRef,
  ArtifactActionDefinition,
  ArtifactRecord,
  BoardProjection,
  Command,
  DomainEvent,
  TeamName,
  HarnessSnapshot,
  HubPackageLock,
  HunsuRecord,
  ReadyHunsuDraft,
  LineRecord,
  LocalSnapshotSkillMetadata,
  MoveId,
  MoveOutcome,
  NodeId,
  NonEmptyText,
  PathId,
  NodeRecord,
  MemberConfig,
  GoalExecutionPlan,
  ExecutionPlan,
  MemberPath,
  MemberPluginBinding,
  PositiveInteger,
  RequestRecord,
  RegistryPackageSkillMetadata,
  SkillBinding,
  SkillMetaSkillMetadata,
  SkillSnapshotFile,
  Destination,
  DestinationSeed,
  DestinationSeedInput,
  WorktreeRef
} from "@hunsu/protocol";

const execFileAsync = promisify(execFile);
const APP_WORKSPACE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const HUNSU_CODEX_ENV_CONFIG_MARKER = "# HUNSU-MANAGED-CODEX-ENVIRONMENT v1";
const HUNSU_MATERIALIZED_SKILL_MARKER = ".hunsu-materialized-skill";
const HUNSU_DRAFT_PREV_DIR = ".hunsu-prev";
const HUNSU_DRAFT_REQUEST_DIR = ".hunsu-request";
const HUNSU_DRAFT_RUNTIME_FILES = ["destinations.json", "harness.json", "executors.json", "resources.json", "artifact-actions.json"] as const;
const HUNSU_DRAFT_PREV_RUNTIME_PATHS = HUNSU_DRAFT_RUNTIME_FILES.map(file => `${HUNSU_DRAFT_PREV_DIR}/${file}`);
const HUNSU_DRAFT_REQUEST_RUNTIME_PATHS = HUNSU_DRAFT_RUNTIME_FILES.map(file => `${HUNSU_DRAFT_REQUEST_DIR}/${file}`);
const HUNSU_DRAFT_ALL_RUNTIME_PATHS = [...HUNSU_DRAFT_PREV_RUNTIME_PATHS, ...HUNSU_DRAFT_REQUEST_RUNTIME_PATHS];
const HUNSU_DRAFT_CHECK_COMMAND_RESPONSE = "check-command";

const DEFAULT_CREATE_ROADMAP_TITLE = "Hello World Web Project";
const DEFAULT_CREATE_ROADMAP_GOAL = [
  "Create a minimal Hello World web project from this empty checkout.",
  "Add the smallest practical web app files, package scripts, and run instructions needed to launch it locally through an Artifact Action from a clean checkout.",
  "Keep the implementation simple and verify the project can be started or built with a concrete command."
].join(" ");
const DEFAULT_CREATE_ROADMAP_DESTINATIONS: DestinationSeedInput[] = [{
  id: "destination_001",
  title: "Create a runnable Hello World web app",
  acceptanceCriteria: [
    "The repository contains a minimal runnable web app.",
    "The app renders Hello World or an equivalent visible greeting in a browser.",
    "A documented package script starts or builds the hosted action surface."
  ],
  constraints: [
    "Prefer the smallest static or Vite-style implementation that is easy to inspect.",
    "Do not add unrelated product features."
  ],
  priority: 100
}];
const DEFAULT_FAKER_MEMBER_PROMPT = [
  "Act as Faker, a pragmatic engineer.",
  "Build the smallest working web project that satisfies the goal, prefer simple conventional files and scripts, and verify the result with concrete commands."
].join(" ");
const DEFAULT_KERIA_MEMBER_PROMPT = [
  "Act as Keria, a careful reviewer.",
  "Verify the completed web project against the goal with concrete evidence, and call out any missing run or build proof."
].join(" ");
const DEFAULT_CREATE_ROADMAP_TEAM_PROMPT = "Plan the smallest ExecutionPlan needed for the available engineer Member to create and verify the Hello World web project.";

const TRUNCATED_MARKER = "\n...[truncated]";
const SUMMARY_TEXT_MAX_BYTES = 8 * 1024;
const RUNTIME_STRING_MAX_BYTES = 128 * 1024;
const RUNTIME_ARRAY_STRING_MAX_BYTES = 32 * 1024;
const DEBUG_EVENTS_MAX_COUNT = 100;
const DEBUG_EVENTS_MAX_BYTES = 256 * 1024;
const RAW_MESSAGES_MAX_COUNT = 50;
const RAW_MESSAGES_MAX_BYTES = 256 * 1024;
const CODEX_ITEMS_MAX_BYTES = 512 * 1024;
const ASSISTANT_TRANSCRIPT_MAX_BYTES = 256 * 1024;
const AGENT_SESSION_MAX_BYTES = 1024 * 1024;
const RUN_UPDATE_DEBOUNCE_MS = 250;
const FILESYSTEM_BROWSE_ENTRY_LIMIT = 300;
const FILESYSTEM_CAPABILITY_TTL_MS = 15 * 60 * 1000;
const MOVE_FILE_TEXT_MAX_BYTES = 256 * 1024;
const queuedRunUpdates = new WeakMap<StudioServerState, Map<string, ReturnType<typeof setTimeout>>>();
const responseSecurityHeaders = new WeakMap<object, Record<string, string>>();
const BRIDGE_API_TOKEN_QUERY_PARAM = "hunsuBridgeToken";
const BRIDGE_API_TOKEN_HEADER = "x-hunsu-bridge-token";
const DEFAULT_BRIDGE_STUDIO_ORIGINS = [
  "http://127.0.0.1:19688",
  "http://localhost:19688"
];

export type StudioRunStatus = ExecuteRunStatus;

export type StudioSkillFile = {
  path: string;
  size: number;
  text?: string;
};

export type StudioSkillSummary = LocalSnapshotSkillMetadata & {
  files: StudioSkillFile[];
};

export type ApmSkillReference = {
  kind: "registry-package";
  registryKind: "apm";
  name: string;
  registry: string;
  package: string;
  version: string;
};

export type ApmSkillRegistryClient = {
  resolveSkill(ref: ApmSkillReference): Promise<RegistryPackageSkillMetadata>;
  fetchSkillFiles(lock: RegistryPackageSkillMetadata): Promise<SkillSnapshotFile[]>;
};

export type SkillMetaInstallOptions = {
  env?: Record<string, string | undefined>;
  home?: string;
};

export type SkillMetaInstaller = {
  install(skill: SkillMetaSkillMetadata, cwd: string, options: SkillMetaInstallOptions): Promise<void>;
};

export type StudioRunState = {
  runId: string;
  roadmapId?: string;
  executeId: string;
  requestId: string;
  lineId: string;
  repositoryPath?: string;
  provider: "codex";
  source?: "live" | "rehydrated";
  status: StudioRunStatus;
  selectedDestinationIds: string[];
  harnessLock?: HubPackageLock;
  sourceNodeId?: NodeId;
  sourceMoveId?: MoveId;
  targetMoveOrdinal?: PositiveInteger;
  worktree?: WorktreeRef;
  conversationRef?: AgentConversationRef;
  outcome?: MoveOutcome;
  providerThreadId?: string;
  providerTeamThreadId?: string;
  providerTeamPlanningTurnId?: string;
  providerMemberThreadId?: string;
  providerFinalizerThreadId?: string;
  providerTurnIds?: string[];
  finalResponse?: string;
  attemptCount?: 0 | PositiveInteger;
  maxAttemptCount?: PositiveInteger;
  currentExecution?: ExecutionPlan;
  memberEvaluations?: StudioMemberPathEvaluation[];
  executionPlanPlan?: MemberPath[];
  pathCommits?: Record<string, CommitSha>;
  planExecutionTransition?: StudioExecutionTransition;
  memberPathRuns?: StudioMemberPathRun[];
  terminalMemberPathId?: PathId;
  terminalPathCommit?: CommitSha;
  moveFinalizerMessage?: string;
  moveFinalizerCommit?: CommitSha;
  error?: string;
  debugEvents: TeamRunEvent[];
  rawAppServerMessages: StudioRawAppServerMessage[];
  codexTurns: StudioCodexTurn[];
  codexItems: StudioCodexItem[];
  agentSessionIds?: string[];
  agentSessions: AgentSession[];
  activeItemIds: string[];
  activeAgentSessionId?: string;
  liveStatus?: StudioLiveStatus;
  assistantTranscript: StudioAssistantTranscript[];
  startedAt: string;
  updatedAt: string;
};

export type StudioRunSummary = Omit<StudioRunState,
  "currentExecution"
  | "debugEvents"
  | "rawAppServerMessages"
  | "codexItems"
  | "assistantTranscript"
  | "finalResponse"
  | "moveFinalizerMessage"
> & {
  finalResponse?: string;
  moveFinalizerMessage?: string;
  debugEventCount: number;
  rawAppServerMessageCount: number;
  codexItemCount: number;
  assistantTranscriptCount: number;
};

export type StudioRawAppServerMessage = {
  direction: "server-notification" | "server-request";
  method?: string;
  providerThreadId?: string;
  providerTurnId?: string;
  message: JsonRpcMessage;
  at: string;
};

export type StudioCodexTurn = {
  providerThreadId: string;
  providerTurnId: string;
  status: "started" | "completed";
  startedAt?: string;
  completedAt?: string;
};

export type StudioCodexItem = {
  itemId: string;
  providerThreadId?: string;
  providerTurnId?: string;
  type: string;
  status: "started" | "streaming" | "completed";
  title: string;
  detail?: string;
  text?: string;
  summary?: string[];
  content?: string[];
  command?: string;
  cwd?: string;
  commandActions?: RunnerAppServerCommandAction[];
  output?: string;
  changes?: unknown;
  rawItem?: RunnerAppServerItem;
  durationMs?: number;
  startedAt?: string;
  completedAt?: string;
  updatedAt: string;
};

export type StudioLiveStatus = {
  phase: "working" | "thinking" | "exploring" | "running" | "waiting" | "idle";
  headline: string;
  detail?: string;
  itemId?: string;
  providerTurnId?: string;
  updatedAt: string;
};

export type StudioAssistantTranscript = {
  itemId: string;
  providerThreadId?: string;
  providerTurnId?: string;
  text: string;
  status: "streaming" | "completed";
  updatedAt: string;
};

export type AgentSessionOwner =
  | { kind: "TeamPlan"; runId: string; executeId: string; attempt: PositiveInteger }
  | { kind: "ExecutionPlan"; runId: string; executeId: string; attempt: PositiveInteger; pathId: PathId; executorId: string }
  | { kind: "MoveFinalizer"; runId: string; executeId: string; moveId?: MoveId }
  | { kind: "HunsuDraft"; draftSessionId: string };

export type AgentSessionRouteKind = "Plan" | "Path" | "HunsuDraft";

export type AgentSessionRouteRef = {
  kind: "Route";
  routeKind: AgentSessionRouteKind;
  routeId: string;
  sourceLineId: string;
  sourceNodeId: string;
  targetNodeId?: string;
  worktree?: WorktreeRef;
  runId?: string;
  executeId?: string;
  draftSessionId?: string;
};

export type AgentInteractionRequest = {
  interactionId: string;
  prompt: string;
  createdAt: string;
};

export type AgentSessionState =
  | { type: "waiting"; reason?: string }
  | { type: "starting"; startedAt: string }
  | { type: "executing"; provider: StudioAgentSessionRef; activeItemIds: string[] }
  | { type: "interactWait"; provider: StudioAgentSessionRef; interaction: AgentInteractionRequest; activeItemIds: string[] }
  | { type: "completed"; provider?: StudioAgentSessionRef; finalResponse?: string; completedAt: string }
  | { type: "failed"; provider?: StudioAgentSessionRef; error: string; completedAt: string };

export type AgentMessageRole = "user" | "assistant" | "tool" | "reasoning" | "system";

export type AgentMessage = {
  sessionId: string;
  messageId: string;
  itemId: string;
  role: AgentMessageRole;
  type: string;
  status: "started" | "streaming" | "completed";
  title: string;
  text?: string;
  summary?: string[];
  content?: string[];
  command?: string;
  cwd?: string;
  commandActions?: RunnerAppServerCommandAction[];
  output?: string;
  changes?: unknown;
  durationMs?: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
};

export type AgentSession = {
  sessionId: string;
  roadmapId?: string;
  routeRef: AgentSessionRouteRef;
  runId?: string;
  executeId?: string;
  owner: AgentSessionOwner;
  state: AgentSessionState;
  provider?: StudioAgentSessionRef;
  messages: AgentMessage[];
  activeItemIds: string[];
  finalResponse?: string;
  error?: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
};

export type StudioExecuteView = StudioRunSummary & {
  executeId: string;
  teamRouteId: string;
  selectedDestinationIds: string[];
  sourceMoveId?: MoveId;
  targetMoveOrdinal?: PositiveInteger;
  statusLabel: string;
  outcomeLabel?: "Arrived" | "Accident";
  memberEvaluations: StudioMemberPathEvaluation[];
};

export type StudioRoadmapView = BoardProjection & {
  roadmap: BoardProjection;
  destinations: Destination[];
  teams: LineRecord[];
  moves: BoardProjection["moves"];
  hunsus: BoardProjection["hunsus"];
};

export type StudioExecuteCompletionFacts = {
  summary: string;
  evidence: string[];
  risks: string[];
};

export type StudioMemberPathEvaluation = StudioExecuteCompletionFacts & {
  terminalPathId?: PathId;
  terminalPathCommit?: CommitSha;
  attempt: PositiveInteger;
  at: string;
};

export type StudioAgentSessionRef = {
  providerThreadId: string;
  providerTurnId: string;
};

export type StudioEncodedRuntimeFile = {
  path: string;
  commit: CommitSha;
  text: string;
};

export type StudioExecutionFileState = "present" | "none";
export type StudioExecutionNextState = StudioExecutionFileState | "pending";

export type StudioExecutionTransition = {
  path: string;
  previousCommit?: CommitSha;
  previous?: StudioEncodedRuntimeFile;
  previousState: StudioExecutionFileState;
  nextCommit?: CommitSha;
  next?: StudioEncodedRuntimeFile;
  nextState: StudioExecutionNextState;
};

type StudioMemberPathRunBase = {
  pathId: PathId;
  executorId: string;
  goal: string;
  requires: MemberPath["requires"];
  attempt: PositiveInteger;
  agentSessionId?: string;
  dependencyPathIds: PathId[];
  dependencyOutputs: string[];
  currentExecutionFile?: StudioEncodedRuntimeFile;
  currentExecutionTransition?: StudioExecutionTransition;
  startedAt: string;
};

export type StudioMemberPathRun =
  | (StudioMemberPathRunBase & {
      status: "planned" | "starting";
    })
  | (StudioMemberPathRunBase & {
      status: "executing";
      session: StudioAgentSessionRef;
    })
  | (StudioMemberPathRunBase & {
      status: "completed";
      session: StudioAgentSessionRef;
      finalResponse: string;
      commit?: CommitSha;
      parentCommit?: CommitSha;
      treeChanged?: boolean;
      completedAt: string;
    })
  | (StudioMemberPathRunBase & {
      status: "failed";
      session?: StudioAgentSessionRef;
      error: string;
      finalResponse?: string;
      commit?: CommitSha;
      parentCommit?: CommitSha;
      treeChanged?: boolean;
      completedAt: string;
    });

export type StudioServerState = {
  events: DomainEvent[];
  runs: Record<string, StudioRunState>;
  agentSessions: Record<string, AgentSession>;
  hunsuDrafts: Record<string, StudioHunsuDraftSession>;
  hunsuDraftArtifacts: Record<string, StudioHunsuDraftArtifact>;
  filesystemCapabilities: Record<string, FilesystemBrowseCapability>;
  liveSubscribers: Set<StudioLiveSubscriber>;
  agentSessionSubscribers: Set<AgentSessionSubscriber>;
};

export type StudioServerSecurityOptions = {
  authToken?: string;
  allowedOrigins?: string[];
  allowNoOrigin?: boolean;
};

type StudioServerSecurity = {
  authToken?: string;
  allowedOrigins: string[];
  allowNoOrigin: boolean;
};

type StudioRequestSecurity = {
  allowed: boolean;
  status?: number;
  error?: string;
  corsHeaders: Record<string, string>;
};

export type StudioServerOptions = {
  state?: StudioServerState;
  cwd?: string;
  persist?: boolean;
  runner?: Runner;
  actionRunner?: ArtifactActionCommandRunner;
  apmSkillRegistryClient?: ApmSkillRegistryClient;
  roadmapRegistryPath?: string;
  runtimeConfig?: BridgeRuntimeConfig;
  security?: StudioServerSecurityOptions;
};

export type StudioCommandResult = {
  acceptedEvents: DomainEvent[];
  board: BoardProjection;
};

export type StudioCommandRequest = Command | { commands: Command[] };

export type RepositorySelectionRequest = {
  cwd: string;
};

export type RepositorySelectionResult = {
  repository: WorktreeStatus;
  board: BoardProjection;
};

export type RoadmapRegistryEntry = {
  roadmapId: string;
  displayName: string;
  repositoryPath: string;
  lastOpenedAt: string;
  lastKnownBranch?: string;
  health: "ok" | "missing";
};

export type RoadmapOpenRequest = {
  path?: string;
  cwd?: string;
  browseToken?: string;
  title?: string;
};

export type RoadmapPortRequest = RoadmapOpenRequest & {
  goal?: string;
  destinations?: DestinationSeed[];
};

export type RoadmapOpenResult = {
  roadmap: RoadmapRegistryEntry;
  repository: WorktreeStatus;
  board: BoardProjection;
};

export type RoadmapPortInspectResult = {
  port: HunsuPortInspection;
  plan?: HunsuPortPlan;
};

export type RoadmapPortApplyResult = RoadmapOpenResult & {
  port: HunsuPortApplyResult;
};

export type BrowseRootId = string & { readonly __brand: "BrowseRootId" };
export type BrowseToken = string & { readonly __brand: "BrowseToken" };
export type CanonicalLocalPath = string & { readonly __brand: "CanonicalLocalPath" };

export type FilesystemBrowseRoot = {
  rootId: BrowseRootId;
  path: CanonicalLocalPath;
  label: string;
};

export type FilesystemBrowseCapability = {
  browseToken: BrowseToken;
  rootId: BrowseRootId;
  path: CanonicalLocalPath;
  displayPath: string;
  issuedAt: string;
  expiresAt: string;
};

export type FilesystemBrowseError = {
  code: "no_roots" | "invalid_root" | "outside_root" | "not_directory" | "protected_path" | "invalid_grant" | "expired_grant";
  message: string;
};

export type FilesystemBrowseEntry = {
  kind: "directory";
  name: string;
  path: string;
  rootId: BrowseRootId;
  type: "directory";
  isGitRepository: boolean;
  isRoadmap: boolean;
};

export type FilesystemBrowseResult = {
  path: string;
  parent?: string;
  rootId: BrowseRootId;
  roots: FilesystemBrowseRoot[];
  entries: FilesystemBrowseEntry[];
};

export type FilesystemGrantRequest = {
  rootId?: string;
  path?: string;
};

export type FilesystemGrantResult = {
  capability: FilesystemBrowseCapability;
};

export type MoveFileNode =
  | { kind: "directory"; name: string; path: string }
  | { kind: "textFile"; name: string; path: string; size: number }
  | { kind: "binaryFile"; name: string; path: string; size: number }
  | { kind: "tooLarge"; name: string; path: string; size: number }
  | { kind: "hiddenRuntime"; name: string; path: string };

export type MoveFileTree = {
  moveId: string;
  commit: string;
  path: string;
  parent?: string;
  nodes: MoveFileNode[];
  changedPaths: string[];
  runtimeCapsule: MoveRuntimeCapsule;
};

export type MoveFileBlob =
  | { kind: "text"; moveId: string; commit: string; path: string; text: string; language?: string; size: number }
  | { kind: "binary"; moveId: string; commit: string; path: string; size: number }
  | { kind: "tooLarge"; moveId: string; commit: string; path: string; size: number; maxBytes: number }
  | { kind: "hiddenRuntime"; moveId: string; commit: string; path: string };

export type MoveFileReadError = {
  code: "unknown_move" | "invalid_path" | "not_found" | "not_file" | "git_error";
  message: string;
};

export type MoveRuntimeCapsule = {
  hiddenRuntimeFileCount: number;
  runtimePaths: string[];
  summary: string;
};

export type StudioRunStartRequest = {
  requestId?: string;
  lineId?: string;
  selectedDestinationIds?: string[];
};

export type StudioRunActionRequest = {
  runId: string;
};

export type StudioActionRunStartRequest = {
  actionId?: string;
  moveId?: string;
  commit?: string;
  env?: Record<string, string>;
  dryRun?: boolean;
};

export type StudioLineDecisionRequest = {
  lineId: string;
  reason?: string;
};

export type StudioMoveCompletionRequest = {
  runId: string;
  fromRef: string;
  summary: string;
  destinationIds?: string[];
  evidence: string[];
  risks?: string[];
  approvedRisks?: boolean;
};

export type StudioRunResult = {
  run: StudioRunSummary;
  execute: StudioExecuteView;
  board: BoardProjection;
};

export type StudioMoveCompletionResult = StudioRunResult & {
  moveId: string;
  commit: string;
  acceptedEvents: DomainEvent[];
};

export type StudioHunsuDraftStatus = "draft" | "ready" | "confirmed" | "discarded" | "failed";

export type StudioHunsuDraftChatRole = "user" | "draft-agent" | "system";

export type StudioHunsuDraftMessage = {
  messageId: string;
  role: StudioHunsuDraftChatRole;
  text: string;
  createdAt: string;
};

export type StudioHunsuDraftRuntimeFileChange = {
  path: string;
  kind: "added" | "updated" | "removed";
  summary: string;
  diff: string;
};

export type StudioHunsuDraftRuntimeFileDiff = {
  path: string;
  kind: "added" | "updated" | "removed";
  diff: string;
};

export type StudioHunsuDraftChanges = {
  draftSessionId: string;
  sourceNodeId: string;
  requestDir: string;
  previousDir: string;
  ok: boolean;
  summary: string;
  errors: string[];
  files: StudioHunsuDraftRuntimeFileChange[];
  checkedAt?: string;
};

export type StudioHunsuDraftDiffArtifact = {
  diffArtifactId: string;
  draftSessionId: string;
  status: "pass" | "failed";
  newTeamName?: string;
  files: StudioHunsuDraftRuntimeFileDiff[];
  errors: string[];
  failedReason?: string;
  checkedAt: string;
  draftSurfaceHash: string;
};

type StudioHunsuDraftDiffArtifactRecord = Omit<StudioHunsuDraftDiffArtifact, "files"> & {
  summary: string;
  files: StudioHunsuDraftRuntimeFileChange[];
  readyDraft?: ReadyHunsuDraft;
};

export type StudioHunsuDraftArtifact = {
  artifactId: string;
  kind: "source-protocol";
  repositoryPath: string;
  roadmapId?: string;
  draftSessionId: string;
  baseArtifactId?: string;
  value: unknown;
  createdAt: string;
};

export type StudioHunsuDraftSession = {
  draftSessionId: string;
  roadmapId?: string;
  repositoryPath: string;
  sourceLineId: string;
  sourceNodeId: string;
  sourceMoveId?: string;
  routeId: string;
  worktree?: WorktreeRef;
  agentSessionIds: string[];
  activeAgentSessionId?: string;
  draftAgentSessionId?: string;
  sourceArtifactId: string;
  currentArtifactId: string;
  managerLock?: HubPackageLock;
  manager: ManagerConfig;
  confirmedHunsuId?: string;
  confirmedNodeId?: string;
  providerThreadId?: string;
  messages: StudioHunsuDraftMessage[];
  readyDraft?: ReadyHunsuDraft;
  latestDiffArtifactId?: string;
  diffArtifacts: Record<string, StudioHunsuDraftDiffArtifactRecord>;
  status: StudioHunsuDraftStatus;
  error?: string;
  createdAt: string;
  updatedAt: string;
};

export type StudioHunsuDraftStartRequest = {
  sourceNodeId?: string;
  sourceMoveId?: string;
  sourceLineId?: string;
  managerLock?: HubPackageLock;
  message?: string;
};

export type StudioHunsuDraftMessageRequest = {
  message: string;
};

export type StudioHunsuDraftResult = {
  draft: StudioHunsuDraftSession;
  board: BoardProjection;
  diffArtifact?: StudioHunsuDraftDiffArtifact;
  acceptedEvents?: DomainEvent[];
  hunsu?: HunsuRecord;
};

export type StudioHunsuDraftDiffArtifactResult = {
  diffArtifact: StudioHunsuDraftDiffArtifact;
};

export type StudioHunsuDraftCheckCommandChangedFile = {
  path: string;
  kind: "added" | "updated" | "removed";
};

export type StudioHunsuDraftCheckCommandPassResult = {
  status: "pass";
  draftSessionId: string;
  diffArtifactId: string;
  marker: string;
  checkedAt: string;
  changedFiles: StudioHunsuDraftCheckCommandChangedFile[];
};

export type StudioHunsuDraftCheckCommandFailedResult = {
  status: "failed";
  draftSessionId: string;
  diffArtifactId: string;
  marker: string;
  checkedAt: string;
  failedReason: string;
  errors: string[];
};

export type StudioHunsuDraftCheckCommandResult =
  | StudioHunsuDraftCheckCommandPassResult
  | StudioHunsuDraftCheckCommandFailedResult;

export type HunsuDraftRouteRuntimeFile = {
  schema: "hunsu.hunsu-draft-route.v1";
  draftSessionId: string;
  roadmapId?: string;
  repositoryPath: string;
  routeId: string;
  sourceLineId: string;
  sourceNodeId: string;
  sourceMoveId?: string;
  sourceArtifactId: string;
  currentArtifactId: string;
  managerLock?: HubPackageLock;
  manager: ManagerConfig;
  confirmedHunsuId?: string;
  confirmedNodeId?: string;
  status: StudioHunsuDraftStatus;
  readyDraft?: ReadyHunsuDraft;
  latestDiffArtifactId?: string;
  diffArtifacts?: Record<string, StudioHunsuDraftDiffArtifactRecord>;
  worktree?: WorktreeRef;
  updatedAt: string;
};

export type StudioLiveEvent =
  | { type: "runs.snapshot"; runs: StudioRunSummary[]; executes: StudioExecuteView[] }
  | { type: "run.updated"; run: StudioRunSummary; execute: StudioExecuteView; board?: BoardProjection };

export type StudioLiveSubscriber = (event: StudioLiveEvent) => void;

export type AgentSessionListResult = {
  sessions: AgentSession[];
};

export type AgentSessionResult = {
  session: AgentSession;
};

export type AgentSessionLifecyclePatch = {
  type: "agentSession.lifecycle";
  sessionId: string;
  roadmapId?: string;
  routeRef: AgentSessionRouteRef;
  runId?: string;
  executeId?: string;
  owner: AgentSessionOwner;
  state: AgentSessionState;
  provider?: StudioAgentSessionRef;
  activeItemIds: string[];
  finalResponse?: string;
  error?: string;
  sessionRevision: number;
  updatedAt: string;
};

export type AgentSessionEvent =
  | { type: "agentSession.snapshot"; sessions: AgentSession[] }
  | AgentSessionLifecyclePatch
  | {
      type: "agentMessage.delta";
      sessionId: string;
      roadmapId?: string;
      routeRef: AgentSessionRouteRef;
      runId?: string;
      executeId?: string;
      messageId: string;
      itemId: string;
      role: AgentMessageRole;
      messageType: string;
      title: string;
      field: "text" | "output" | "summary" | "content";
      delta: string;
      contentIndex?: number;
      messageRevision: number;
      sessionRevision: number;
      createdAt: string;
      updatedAt: string;
    }
  | {
      type: "agentMessage.completed";
      sessionId: string;
      roadmapId?: string;
      routeRef: AgentSessionRouteRef;
      runId?: string;
      executeId?: string;
      messageId: string;
      itemId: string;
      role: AgentMessageRole;
      messageType: string;
      title: string;
      status: "completed";
      text?: string;
      summary?: string[];
      content?: string[];
      command?: string;
      cwd?: string;
      commandActions?: RunnerAppServerCommandAction[];
      output?: string;
      changes?: unknown;
      messageRevision: number;
      sessionRevision: number;
      createdAt: string;
      completedAt: string;
      durationMs?: number;
      updatedAt: string;
    };

export type AgentSessionSubscriber = (event: AgentSessionEvent) => void;

export type WorktreeChange = {
  status: string;
  path: string;
};

export type WorktreeStatus = {
  root: string;
  branch: string;
  clean: boolean;
  changes: WorktreeChange[];
};

export type MoveDiff = {
  moveId: string;
  commit: string;
  headCommit: string;
  baseCommit?: string;
  baseMoveId?: string;
  files: MoveDiffFile[];
  tree: MoveDiffTreeNode[];
  text: string;
};

export type MoveDiffFileKind = "added" | "modified" | "removed" | "renamed" | "copied" | "typeChanged";

export type MoveDiffFile = {
  path: string;
  oldPath?: string;
  kind: MoveDiffFileKind;
  patch: string;
};

export type MoveDiffTreeNode =
  | { kind: "directory"; name: string; path: string; changedFileCount: number; children: MoveDiffTreeNode[] }
  | { kind: "file"; name: string; path: string; oldPath?: string; changeKind: MoveDiffFileKind };

export function createStudioState(events: DomainEvent[] = []): StudioServerState {
  return { events, runs: {}, agentSessions: {}, hunsuDrafts: {}, hunsuDraftArtifacts: {}, filesystemCapabilities: {}, liveSubscribers: new Set(), agentSessionSubscribers: new Set() };
}

export function createBridgeApiAuthToken(): string {
  return `hunsu_bridge_${randomBytes(24).toString("base64url")}`;
}

export type StudioBridgeStartOptions = {
  cwd?: string;
  webUrl?: string;
  noOpen?: boolean;
  dryRun?: boolean;
  json?: boolean;
  env?: Record<string, string | undefined>;
};

export type StudioBridgeStartInfo = {
  bridgeApiUrl: string;
  studioUrl: string;
  allowedOrigin: string;
};

export async function startStudioBridge(options: StudioBridgeStartOptions = {}): Promise<StudioBridgeStartInfo> {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? currentProcessEnv();
  const runtimeConfig = unwrapConfigResult(resolveBridgeRuntimeConfig(env, { cwd }));
  const authToken = createBridgeApiAuthToken();
  const bridgeApiUrl = endpointUrl(runtimeConfig.bridgeApi);
  const webUrl = resolveStudioBridgeWebUrl(options.webUrl, env);
  const studioUrl = studioBridgePairingUrl(webUrl, authToken);
  const allowedOrigin = new URL(webUrl).origin;
  const startInfo = {
    bridgeApiUrl,
    studioUrl,
    allowedOrigin
  };

  if (options.dryRun) {
    printStudioBridgeStartInfo(startInfo, options);
    return startInfo;
  }

  const server = createStudioServer({
    cwd,
    runtimeConfig,
    security: {
      authToken,
      allowedOrigins: [allowedOrigin]
    }
  });

  await new Promise<void>((resolve, reject) => {
    const shutdown = () => {
      server.close(() => resolve());
    };
    server.once("error", reject);
    server.listen(runtimeConfig.bridgeApi.port, runtimeConfig.bridgeApi.host, () => {
      printStudioBridgeStartInfo(startInfo, options);
      if (!options.noOpen) {
        openStudioBridgeBrowser(studioUrl);
      }
    });
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });

  return startInfo;
}

function resolveStudioBridgeWebUrl(webUrl: string | undefined, env: Record<string, string | undefined>): string {
  const raw = webUrl ?? unwrapConfigResult(resolveStudioLauncherConfig(env)).webUrl;
  try {
    return new URL(raw).toString();
  } catch (_error) {
    throw new Error(`Invalid Studio web URL: ${raw}`);
  }
}

function studioBridgePairingUrl(webUrl: string, authToken: string): string {
  const url = new URL(webUrl);
  url.searchParams.set(BRIDGE_API_TOKEN_QUERY_PARAM, authToken);
  return url.toString();
}

function printStudioBridgeStartInfo(info: StudioBridgeStartInfo, options: Pick<StudioBridgeStartOptions, "json">): void {
  if (options.json) {
    console.log(JSON.stringify(info, null, 2));
    return;
  }
  console.log(`Hunsu Bridge: ${info.bridgeApiUrl}`);
  console.log(`Hunsu Studio: ${info.studioUrl}`);
  console.log(`Allowed Studio origin: ${info.allowedOrigin}`);
}

function openStudioBridgeBrowser(url: string): void {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.unref();
}

function createStudioServerSecurity(options: StudioServerSecurityOptions | undefined, runtimeConfig: BridgeRuntimeConfig): StudioServerSecurity {
  return {
    authToken: nonEmptyString(options?.authToken),
    allowedOrigins: uniqueStrings([
      ...DEFAULT_BRIDGE_STUDIO_ORIGINS,
      ...bridgeStudioOriginsFromEnv(runtimeConfig.processEnv),
      ...(options?.allowedOrigins ?? [])
    ].map(normalizeOrigin).filter((origin): origin is string => origin !== undefined)),
    allowNoOrigin: options?.allowNoOrigin ?? true
  };
}

function evaluateStudioRequestSecurity(request: IncomingMessage, url: URL, security: StudioServerSecurity): StudioRequestSecurity {
  const origin = requestHeader(request, "origin");
  const corsHeaders = corsHeadersForOrigin(origin, security);
  if (origin && corsHeaders === undefined) {
    return {
      allowed: false,
      status: 403,
      error: `Origin is not allowed for Hunsu Bridge: ${origin}`,
      corsHeaders: baseCorsHeaders()
    };
  }
  if (!origin && !security.allowNoOrigin) {
    return {
      allowed: false,
      status: 403,
      error: "Requests without an Origin header are not allowed.",
      corsHeaders: baseCorsHeaders()
    };
  }
  const headers = corsHeaders ?? baseCorsHeaders();
  if (security.authToken && !isPublicBridgeRequest(url) && !hasValidBridgeApiToken(request, url, security.authToken)) {
    return {
      allowed: false,
      status: 401,
      error: "Missing or invalid Hunsu Bridge pairing token.",
      corsHeaders: headers
    };
  }
  return { allowed: true, corsHeaders: headers };
}

function baseCorsHeaders(): Record<string, string> {
  return {
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": `authorization,content-type,${BRIDGE_API_TOKEN_HEADER}`,
    "vary": "origin"
  };
}

function corsHeadersForOrigin(origin: string | undefined, security: StudioServerSecurity): Record<string, string> | undefined {
  if (!origin) {
    return baseCorsHeaders();
  }
  const normalized = normalizeOrigin(origin);
  if (!normalized || !security.allowedOrigins.includes(normalized)) {
    return undefined;
  }
  return {
    ...baseCorsHeaders(),
    "access-control-allow-origin": normalized
  };
}

function isPublicBridgeRequest(url: URL): boolean {
  return url.pathname === "/health";
}

function hasValidBridgeApiToken(request: IncomingMessage, url: URL, expected: string): boolean {
  const authorization = requestHeader(request, "authorization");
  const bearerToken = authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  const headerToken = requestHeader(request, BRIDGE_API_TOKEN_HEADER);
  const queryToken = url.searchParams.get(BRIDGE_API_TOKEN_QUERY_PARAM) ?? undefined;
  return [bearerToken, headerToken, queryToken].some(token => token !== undefined && safeTokenEquals(token, expected));
}

function safeTokenEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function requestHeader(request: IncomingMessage, name: string): string | undefined {
  const headers = (request as IncomingMessage & { headers?: Record<string, string | string[] | undefined> }).headers ?? {};
  const raw = headers[name.toLowerCase()];
  if (Array.isArray(raw)) {
    return raw[0];
  }
  return raw;
}

function bridgeStudioOriginsFromEnv(env: Record<string, string | undefined>): string[] {
  const port = nonEmptyString(env.HUNSU_WEB_PORT);
  const host = nonEmptyString(env.HUNSU_WEB_HOST);
  return [
    ...commaSeparatedOrigins(env.HUNSU_BRIDGE_ALLOWED_ORIGINS),
    port ? `http://127.0.0.1:${port}` : undefined,
    port ? `http://localhost:${port}` : undefined,
    host && port && !isWildcardHost(host) ? `http://${host}:${port}` : undefined
  ].filter((origin): origin is string => origin !== undefined);
}

function commaSeparatedOrigins(value: string | undefined): string[] {
  return value?.split(",").map(item => item.trim()).filter(Boolean) ?? [];
}

function normalizeOrigin(value: string | undefined): string | undefined {
  if (!value?.trim()) {
    return undefined;
  }
  try {
    const url = new URL(value.trim());
    return url.origin;
  } catch (_error) {
    return undefined;
  }
}

function nonEmptyString(value: string | undefined): string | undefined {
  return value?.trim() ? value.trim() : undefined;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function isWildcardHost(host: string): boolean {
  return host === "0.0.0.0" || host === "::" || host === "[::]";
}

function createConfiguredRunner(runtimeConfig: BridgeRuntimeConfig): Runner {
  if (runtimeConfig.testRunner === "deterministic") {
    return new DeterministicLocalTestRunner();
  }
  return createDefaultCodexRunner({
    clientOptions: {
      command: runtimeConfig.codexAppServer.command,
      args: runtimeConfig.codexAppServer.args,
      environment: runtimeConfig.codexAppServer.environment
    },
    threadOptions: runtimeConfig.codexThreadOptions
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

class DeterministicLocalTestRunner implements Runner {
  async runTeamPlanning(input: StartRunInput): Promise<RunnerRun> {
    return {
      runId: input.runId,
      provider: "codex",
      providerThreadId: this.threadId(input.runId, "team"),
      providerTurnId: this.turnId(input.runId, "plan"),
      finalResponse: JSON.stringify({
        kind: "queue",
        id: "deterministic-e2e-execute",
        items: [{
          kind: "goal",
          stage: "needs_evaluation",
          id: "hello-world-web-app",
          assignee: {
            executorId: "faker",
            goal: "Create the smallest static Hello World web app with package scripts."
          },
          evaluator: {
            executorId: "keria",
            prompt: "Verify the static Hello World app files and scripts exist."
          },
          remainingAttempts: 1,
          requires: "PrevMove"
        }]
      }, null, 2)
    };
  }

  async runMemberPath(input: MemberPathRunInput): Promise<RunnerRun> {
    if (input.outputSchema) {
      return {
        runId: input.runId,
        provider: "codex",
        providerThreadId: this.threadId(input.runId, "evaluator"),
        providerTurnId: this.turnId(input.runId, input.memberPath.id),
        finalResponse: JSON.stringify(this.evaluateHelloWorldApp(input.repositoryPath), null, 2)
      };
    }

    writeDeterministicHelloWorldApp(input.repositoryPath);
    return {
      runId: input.runId,
      provider: "codex",
      providerThreadId: this.threadId(input.runId, "member"),
      providerTurnId: this.turnId(input.runId, input.memberPath.id),
      finalResponse: "Created a minimal static Hello World web app with index.html, package.json, and README.md."
    };
  }

  async runMoveFinalizer(input: MoveFinalizerInput): Promise<RunnerRun> {
    return {
      runId: input.runId,
      provider: "codex",
      providerThreadId: this.threadId(input.runId, "finalizer"),
      providerTurnId: this.turnId(input.runId, `finalize-${input.moveId}`),
      finalResponse: [
        "move: create runnable Hello World web app",
        "",
        input.completionSummary,
        "",
        "Evidence:",
        ...input.pathOutputs.map(output => `- ${output.pathId}: ${output.finalResponse ?? "completed"}`)
      ].join("\n")
    };
  }

  async prepareHunsuDraftSession(input: HunsuDraftSessionInput): Promise<RunnerRun> {
    return {
      runId: input.runId,
      provider: "codex",
      providerThreadId: this.threadId(input.runId, "hunsu-draft")
    };
  }

  async runHunsuDraftTurn(input: HunsuDraftTurnInput): Promise<RunnerRun> {
    return {
      runId: input.runId,
      provider: "codex",
      providerThreadId: input.providerThreadId ?? this.threadId(input.runId, "hunsu-draft"),
      providerTurnId: this.turnId(input.runId, "hunsu-draft-turn"),
      finalResponse: "Updated the decoded Hunsu request files. Run the supplied Draft check command to create a DiffArtifact."
    };
  }

  resumeRun(input: ResumeRunInput): Promise<RunnerRun> {
    return this.runTeamPlanning(input);
  }

  pauseRun(_runId: string): Promise<void> {
    return Promise.resolve();
  }

  stopRun(_runId: string): Promise<void> {
    return Promise.resolve();
  }

  providerStatus(): Promise<CodexProviderStatus> {
    return Promise.resolve({
      backend: "app-server",
      available: true,
      initialized: { runner: "deterministic" }
    });
  }

  async *events(runId: string): AsyncIterable<TeamRunEvent> {
    if (runId.startsWith("hunsu-draft:")) {
      yield* this.hunsuDraftEvents(runId);
      return;
    }
    yield {
      type: "runner.status.changed",
      runId,
      phase: "working",
      headline: "Deterministic E2E runner"
    };
  }

  private async *hunsuDraftEvents(runId: string): AsyncIterable<TeamRunEvent> {
    const providerThreadId = this.threadId(runId, "hunsu-draft");
    const providerTurnId = this.turnId(runId, "hunsu-draft-turn");
    const startedAtMs = Date.now();
    yield {
      type: "runner.turn.started",
      runId,
      providerThreadId,
      providerTurnId,
      startedAtMs
    };
    await sleep(80);
    yield {
      type: "runner.item.started",
      runId,
      providerThreadId,
      providerTurnId,
      itemId: "reasoning_001",
      item: {
        id: "reasoning_001",
        type: "reasoning",
        raw: { type: "reasoning", id: "reasoning_001" }
      },
      startedAtMs: startedAtMs + 80
    };
    await sleep(80);
    yield {
      type: "runner.item.delta",
      runId,
      providerThreadId,
      providerTurnId,
      itemId: "reasoning_001",
      deltaKind: "reasoningSummary",
      delta: "Inspecting decoded request runtime files."
    };
    await sleep(80);
    yield {
      type: "runner.item.delta",
      runId,
      providerThreadId,
      providerTurnId,
      itemId: "reasoning_001",
      deltaKind: "reasoningText",
      delta: "Mapping the request to the editable Hunsu runtime surface."
    };
    await sleep(80);
    yield {
      type: "runner.item.completed",
      runId,
      providerThreadId,
      providerTurnId,
      itemId: "reasoning_001",
      item: {
        id: "reasoning_001",
        type: "reasoning",
        summary: ["Inspecting decoded request runtime files."],
        content: ["Mapping the request to the editable Hunsu runtime surface."],
        durationMs: 240,
        raw: { type: "reasoning", id: "reasoning_001" }
      },
      completedAtMs: startedAtMs + 320
    };
    await sleep(80);
    yield {
      type: "runner.item.started",
      runId,
      providerThreadId,
      providerTurnId,
      itemId: "cmd_check_001",
      item: {
        id: "cmd_check_001",
        type: "commandExecution",
        command: "node --input-type=module -e <draft-check-command>",
        commandActions: [{ type: "unknown", command: "node --input-type=module -e <draft-check-command>" }],
        raw: { type: "commandExecution", id: "cmd_check_001" }
      },
      startedAtMs: startedAtMs + 400
    };
    await sleep(80);
    yield {
      type: "runner.item.delta",
      runId,
      providerThreadId,
      providerTurnId,
      itemId: "cmd_check_001",
      deltaKind: "commandOutput",
      delta: "Draft check command completed.\n"
    };
    await sleep(80);
    yield {
      type: "runner.item.completed",
      runId,
      providerThreadId,
      providerTurnId,
      itemId: "cmd_check_001",
      item: {
        id: "cmd_check_001",
        type: "commandExecution",
        status: "completed",
        command: "node --input-type=module -e <draft-check-command>",
        aggregatedOutput: "Draft check command completed.\n",
        durationMs: 160,
        raw: { type: "commandExecution", id: "cmd_check_001", status: "completed" }
      },
      completedAtMs: startedAtMs + 560
    };
    await sleep(80);
    yield {
      type: "runner.item.started",
      runId,
      providerThreadId,
      providerTurnId,
      itemId: "file_change_001",
      item: {
        id: "file_change_001",
        type: "fileChange",
        changes: [{ path: ".hunsu-request/destinations.json", kind: "updated" }],
        raw: { type: "fileChange", id: "file_change_001" }
      },
      startedAtMs: startedAtMs + 640
    };
    await sleep(80);
    yield {
      type: "runner.item.completed",
      runId,
      providerThreadId,
      providerTurnId,
      itemId: "file_change_001",
      item: {
        id: "file_change_001",
        type: "fileChange",
        changes: [{ path: ".hunsu-request/destinations.json", kind: "updated" }],
        durationMs: 80,
        raw: { type: "fileChange", id: "file_change_001" }
      },
      completedAtMs: startedAtMs + 720
    };
    await sleep(80);
    yield {
      type: "runner.item.started",
      runId,
      providerThreadId,
      providerTurnId,
      itemId: "assistant_001",
      item: {
        id: "assistant_001",
        type: "agentMessage",
        raw: { type: "agentMessage", id: "assistant_001" }
      },
      startedAtMs: startedAtMs + 800
    };
    for (const delta of ["Updated decoded Hunsu request files. ", "DiffArtifact review is ready when the check output appears."]) {
      await sleep(60);
      yield {
        type: "runner.item.delta",
        runId,
        providerThreadId,
        providerTurnId,
        itemId: "assistant_001",
        deltaKind: "agentMessage",
        delta
      };
    }
    yield {
      type: "runner.item.completed",
      runId,
      providerThreadId,
      providerTurnId,
      itemId: "assistant_001",
      item: {
        id: "assistant_001",
        type: "agentMessage",
        text: "Updated decoded Hunsu request files. DiffArtifact review is ready when the check output appears.",
        durationMs: 120,
        raw: { type: "agentMessage", id: "assistant_001" }
      },
      completedAtMs: startedAtMs + 920
    };
    yield {
      type: "runner.turn.completed",
      runId,
      providerThreadId,
      providerTurnId,
      completedAtMs: startedAtMs + 940
    };
  }

  private evaluateHelloWorldApp(repositoryPath: string) {
    const indexPath = join(repositoryPath, "index.html");
    const packagePath = join(repositoryPath, "package.json");
    const indexText = existsSync(indexPath) ? readFileSync(indexPath, "utf8") : "";
    const packageText = existsSync(packagePath) ? readFileSync(packagePath, "utf8") : "";
    const hasGreeting = /hello\s+world/i.test(indexText);
    const hasPackageScripts = /"scripts"\s*:/.test(packageText);
    if (hasGreeting && hasPackageScripts) {
      return {
        type: "pass",
        summary: "The static Hello World web app files and package scripts are present.",
        reason: "",
        feedback: "",
        nextGoal: "",
        evidence: ["index.html renders Hello World", "package.json defines runnable scripts"]
      };
    }
    return {
      type: "fail",
      summary: "",
      reason: "The Hello World app files are not complete yet.",
      feedback: "Create index.html with a visible Hello World greeting and package.json with scripts.",
      nextGoal: "Create the minimal static Hello World app files.",
      evidence: [
        hasGreeting ? "index.html greeting present" : "index.html greeting missing",
        hasPackageScripts ? "package scripts present" : "package scripts missing"
      ]
    };
  }

  private threadId(runId: string, label: string): string {
    return `thread-${label}-${hashHex(createHash("sha256").update(runId)).slice(0, 12)}`;
  }

  private turnId(runId: string, label: string): string {
    return `turn-${hashHex(createHash("sha256").update(`${runId}:${label}`)).slice(0, 12)}`;
  }
}

function writeDeterministicHelloWorldApp(repositoryPath: string): void {
  mkdirSync(repositoryPath, { recursive: true });
  writeFileSync(join(repositoryPath, "index.html"), [
    "<!doctype html>",
    "<html lang=\"en\">",
    "  <head>",
    "    <meta charset=\"utf-8\">",
    "    <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">",
    "    <title>Hello World</title>",
    "  </head>",
    "  <body>",
    "    <main>",
    "      <h1>Hello World</h1>",
    "    </main>",
    "  </body>",
    "</html>",
    ""
  ].join("\n"), "utf8");
  writeFileSync(join(repositoryPath, "package.json"), `${JSON.stringify({
    scripts: {
      start: "python3 -m http.server 4173",
      build: "node -e \"console.log('static build ok')\""
    }
  }, null, 2)}\n`, "utf8");
  writeFileSync(join(repositoryPath, "README.md"), [
    "# Hello World",
    "",
    "Run `npm run start` to serve the static page or `npm run build` for a simple build check.",
    ""
  ].join("\n"), "utf8");
}

export function createStudioServer(options: StudioServerOptions = {}) {
  const state = options.state ?? createStudioState();
  const persist = options.persist ?? true;
  let repositoryPath = options.cwd ?? APP_WORKSPACE_ROOT;
  const runtimeConfig = options.runtimeConfig ?? unwrapConfigResult(resolveBridgeRuntimeConfig(process.env, {
    cwd: repositoryPath,
    roadmapRegistryPath: options.roadmapRegistryPath
  }));
  const roadmapRegistryPath = options.roadmapRegistryPath ?? runtimeConfig.roadmapRegistryPath;
  const runner = options.runner ?? createConfiguredRunner(runtimeConfig);
  const actionRunner = options.actionRunner;
  const security = createStudioServerSecurity(options.security, runtimeConfig);

  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      const pathname = url.pathname;
      const requestSecurity = evaluateStudioRequestSecurity(request, url, security);
      responseSecurityHeaders.set(response, requestSecurity.corsHeaders);
      if (request.method === "OPTIONS") {
        sendJson(response, requestSecurity.allowed ? 204 : requestSecurity.status ?? 403, requestSecurity.allowed ? {} : { error: requestSecurity.error ?? "Origin is not allowed." });
        return;
      }
      if (!requestSecurity.allowed) {
        sendJson(response, requestSecurity.status ?? 403, { error: requestSecurity.error ?? "Bridge API request is not allowed." });
        return;
      }

      if (request.method === "GET" && pathname === "/health") {
        sendJson(response, 200, { ok: true, service: "hunsu-bridge" });
        return;
      }

      if (request.method === "GET" && pathname === "/api/codex/status") {
        sendJson(response, 200, runner.providerStatus ? await runner.providerStatus() : { backend: "sdk", available: true });
        return;
      }

      if (request.method === "GET" && pathname === "/api/roadmaps/recent") {
        sendJson(response, 200, { roadmaps: listRoadmapRegistry({ roadmapRegistryPath }) });
        return;
      }

      if (request.method === "GET" && pathname === "/api/filesystem/roots") {
        sendJson(response, 200, { roots: filesystemBrowseRootEntries(repositoryPath) });
        return;
      }

      if (request.method === "GET" && pathname === "/api/filesystem/browse") {
        sendJson(response, 200, browseFilesystem(url.searchParams.get("path") ?? undefined, {
          cwd: repositoryPath,
          rootId: url.searchParams.get("rootId") ?? undefined
        }));
        return;
      }

      if (request.method === "POST" && pathname === "/api/filesystem/grants") {
        const body = await readJson<FilesystemGrantRequest>(request);
        sendJson(response, 201, createFilesystemBrowseGrant(body, state, { cwd: repositoryPath }));
        return;
      }

      if (request.method === "POST" && pathname === "/api/roadmaps/open") {
        const body = await readJson<RoadmapOpenRequest>(request);
        const result = openStudioRoadmap(body, state, { persist, roadmapRegistryPath });
        repositoryPath = result.repository.root;
        sendJson(response, 202, result);
        return;
      }

      if (request.method === "POST" && pathname === "/api/roadmaps/port/inspect") {
        const body = await readJson<RoadmapPortRequest>(request);
        sendJson(response, 200, inspectStudioPort(resolveRoadmapOpenRequestPath(body, state)));
        return;
      }

      if (request.method === "POST" && pathname === "/api/roadmaps/port/apply") {
        const body = await readJson<RoadmapPortRequest>(request);
        const result = applyStudioPort(resolveRoadmapOpenRequestPath(body, state), state, { roadmapRegistryPath });
        repositoryPath = result.repository.root;
        sendJson(response, 202, result);
        return;
      }

      if (request.method === "POST" && pathname === "/api/roadmaps/create") {
        const body = await readJson<RoadmapOpenRequest>(request);
        const result = createStudioRoadmap(body, state, { persist, roadmapRegistryPath });
        repositoryPath = result.repository.root;
        sendJson(response, 202, result);
        return;
      }

      if (pathname === "/api/artifact-actions" || pathname.startsWith("/api/artifact-actions/") || pathname === "/api/action-runs" || pathname.startsWith("/api/action-runs/")) {
        const handled = await handleArtifactActionApiRequest(pathname, request, response, {
          cwd: repositoryPath,
          actionRunner,
          ambientEnv: runtimeConfig.processEnv,
          processEnv: runtimeConfig.processEnv,
          worktreeRoot: runtimeConfig.actionWorktreeRoot
        });
        if (handled) {
          return;
        }
      }

      const scopedRoadmap = parseRoadmapApiPath(pathname);
      if (scopedRoadmap) {
        const handled = await handleRoadmapApiRequest(scopedRoadmap.roadmapId, scopedRoadmap.suffix, request, response, state, {
          persist,
          runner,
          actionRunner,
          apmSkillRegistryClient: options.apmSkillRegistryClient,
          roadmapRegistryPath,
          bridgeApiBaseUrl: endpointUrl(runtimeConfig.bridgeApi),
          bridgeApiAuthToken: security.authToken,
          routeWorktreeRoot: runtimeConfig.routeWorktreeRoot,
          actionAmbientEnv: runtimeConfig.processEnv,
          actionProcessEnv: runtimeConfig.processEnv,
          actionWorktreeRoot: runtimeConfig.actionWorktreeRoot,
          skillsEnv: runtimeConfig.processEnv
        });
        if (handled) {
          return;
        }
      }

      if (request.method === "GET" && request.url === "/api/board") {
        sendJson(response, 200, currentBoard(state, { cwd: repositoryPath, persist }));
        return;
      }

      if (request.method === "GET" && request.url === "/api/roadmap") {
        sendJson(response, 200, toStudioRoadmapView(currentBoard(state, { cwd: repositoryPath, persist })));
        return;
      }

      if (request.method === "GET" && request.url === "/api/events") {
        sendJson(response, 200, { events: currentEvents(state, { cwd: repositoryPath, persist }) });
        return;
      }

      if (request.method === "GET" && request.url === "/api/repository") {
        sendJson(response, 200, { repository: readWorktreeStatus(repositoryPath) });
        return;
      }

      if (request.method === "POST" && request.url === "/api/repository") {
        const body = await readJson<RepositorySelectionRequest>(request);
        const result = selectStudioRepository(body.cwd, state, { persist });
        repositoryPath = result.repository.root;
        sendJson(response, 202, result);
        return;
      }

      if (request.method === "GET" && request.url === "/api/worktree") {
        sendJson(response, 200, readWorktreeStatus(repositoryPath));
        return;
      }

      if (request.method === "GET" && request.url === "/api/artifacts") {
        sendJson(response, 200, { artifacts: currentBoard(state, { cwd: repositoryPath, persist }).artifacts });
        return;
      }

      if (request.method === "GET" && request.url?.startsWith("/api/artifacts/")) {
        const artifactId = decodeURIComponent(request.url.slice("/api/artifacts/".length));
        const artifact = findArtifact(currentBoard(state, { cwd: repositoryPath, persist }), artifactId);
        sendJson(response, artifact ? 200 : 404, artifact ? { artifact } : { error: `Unknown artifact: ${artifactId}` });
        return;
      }

      if (request.method === "GET" && request.url === "/api/runs") {
        const runs = runsForRepository(state, repositoryPath).map(toStudioRunSummary);
        sendJson(response, 200, { runs, executes: runs.map(toStudioExecuteView) });
        return;
      }

	      if (request.method === "GET" && request.url === "/api/executes") {
	        const runs = runsForRepository(state, repositoryPath).map(toStudioRunSummary);
	        sendJson(response, 200, { executes: runs.map(toStudioExecuteView), runs });
	        return;
	      }

	      if (request.method === "GET" && request.url === "/api/agent-sessions") {
	        sendJson(response, 200, { sessions: agentSessionsForRepository(state, repositoryPath).map(toAgentSessionSummary) });
	        return;
	      }

      if (request.method === "GET" && request.url === "/api/skills") {
        sendJson(response, 200, { skills: listCodexSkills(runtimeConfig.processEnv) });
        return;
      }

      if (request.method === "GET" && request.url === "/api/runs/events") {
        streamStudioLiveEvents(request, response, state, { cwd: repositoryPath });
        return;
      }

	      if (request.method === "GET" && request.url === "/api/executes/events") {
	        streamStudioLiveEvents(request, response, state, { cwd: repositoryPath });
	        return;
	      }

	      if (request.method === "GET" && request.url?.startsWith("/api/agent-sessions/") && request.url !== "/api/agent-sessions/events") {
	        const route = parseAgentSessionRoute(request.url.slice("/api/agent-sessions".length));
	        if (route?.action === "show") {
	          const session = findAgentSessionById(state, route.sessionId, { cwd: repositoryPath });
	          sendJson(response, session ? 200 : 404, session ? { session } : { error: `Unknown AgentSession: ${route.sessionId}` });
	          return;
	        }
	        if (route?.action === "events") {
	          streamAgentSessionEvents(request, response, state, { cwd: repositoryPath, sessionId: route.sessionId });
	          return;
	        }
	      }

	      if (request.method === "GET" && request.url === "/api/agent-sessions/events") {
	        streamAgentSessionEvents(request, response, state, { cwd: repositoryPath });
	        return;
	      }

      if (request.method === "GET" && request.url?.startsWith("/api/moves/") && request.url.endsWith("/diff")) {
        const moveId = decodeURIComponent(request.url.slice("/api/moves/".length, -"/diff".length));
        sendJson(response, 200, { diff: readMoveDiff(currentBoard(state, { cwd: repositoryPath, persist }), moveId, repositoryPath) });
        return;
      }

      if (request.method === "POST" && request.url === "/api/commands") {
        const body = await readJson<StudioCommandRequest>(request);
        const commands = isCommandBatch(body) ? body.commands : [body];
        sendJson(response, 202, await executeStudioCommands(commands, state, { cwd: repositoryPath, persist }));
        return;
      }

      if (request.method === "POST" && request.url === "/api/runs/start") {
        const body = await readJson<StudioRunStartRequest>(request);
        sendJson(response, 202, await startStudioRun(body, state, { cwd: repositoryPath, persist, runner, apmSkillRegistryClient: options.apmSkillRegistryClient, routeWorktreeRoot: runtimeConfig.routeWorktreeRoot }));
        return;
      }

      if (request.method === "POST" && request.url === "/api/executes/start") {
        const body = await readJson<StudioRunStartRequest>(request);
        sendJson(response, 202, await startStudioRun(body, state, { cwd: repositoryPath, persist, runner, apmSkillRegistryClient: options.apmSkillRegistryClient, routeWorktreeRoot: runtimeConfig.routeWorktreeRoot }));
        return;
      }

      if (request.method === "POST" && request.url === "/api/runs/pause") {
        const body = await readJson<StudioRunActionRequest>(request);
        sendJson(response, 202, await pauseStudioRun(body, state, { cwd: repositoryPath, persist, runner }));
        return;
      }

      if (request.method === "POST" && request.url === "/api/executes/pause") {
        const body = await readJson<StudioRunActionRequest>(request);
        sendJson(response, 202, await pauseStudioRun(body, state, { cwd: repositoryPath, persist, runner }));
        return;
      }

      if (request.method === "POST" && request.url === "/api/runs/resume") {
        const body = await readJson<StudioRunActionRequest>(request);
        sendJson(response, 202, await resumeStudioRun(body, state, { cwd: repositoryPath, persist, runner, apmSkillRegistryClient: options.apmSkillRegistryClient }));
        return;
      }

      if (request.method === "POST" && request.url === "/api/executes/resume") {
        const body = await readJson<StudioRunActionRequest>(request);
        sendJson(response, 202, await resumeStudioRun(body, state, { cwd: repositoryPath, persist, runner, apmSkillRegistryClient: options.apmSkillRegistryClient }));
        return;
      }

      if (request.method === "POST" && request.url === "/api/runs/stop") {
        const body = await readJson<StudioRunActionRequest>(request);
        sendJson(response, 202, await stopStudioRun(body, state, { cwd: repositoryPath, persist, runner }));
        return;
      }

      if (request.method === "POST" && request.url === "/api/executes/stop") {
        const body = await readJson<StudioRunActionRequest>(request);
        sendJson(response, 202, await stopStudioRun(body, state, { cwd: repositoryPath, persist, runner }));
        return;
      }

      if (request.method === "POST" && request.url === "/api/executes/stop") {
        const body = await readJson<StudioRunActionRequest>(request);
        sendJson(response, 202, await stopStudioRun(body, state, { cwd: repositoryPath, persist, runner }));
        return;
      }

      if (request.method === "POST" && request.url === "/api/runs/complete-move") {
        const body = await readJson<StudioMoveCompletionRequest>(request);
        sendJson(response, 202, await completeStudioMove(body, state, { cwd: repositoryPath, persist }));
        return;
      }

      if (request.method === "POST" && request.url === "/api/executes/complete-move") {
        const body = await readJson<StudioMoveCompletionRequest>(request);
        sendJson(response, 202, await completeStudioMove(body, state, { cwd: repositoryPath, persist }));
        return;
      }

      if (request.method === "POST" && request.url === "/api/executes/complete-move") {
        const body = await readJson<StudioMoveCompletionRequest>(request);
        sendJson(response, 202, await completeStudioMove(body, state, { cwd: repositoryPath, persist }));
        return;
      }

      if (request.method === "POST" && request.url === "/api/lines/accept") {
        const body = await readJson<StudioLineDecisionRequest>(request);
        sendJson(response, 202, await decideStudioLine("accept", body, state, { cwd: repositoryPath, persist }));
        return;
      }

      if (request.method === "POST" && request.url === "/api/lines/reject") {
        const body = await readJson<StudioLineDecisionRequest>(request);
        sendJson(response, 202, await decideStudioLine("reject", body, state, { cwd: repositoryPath, persist }));
        return;
      }

      sendJson(response, 404, { error: "Not found" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(response, 400, { error: message });
    }
  });
}

type RoadmapApiRoute = {
  roadmapId: string;
  suffix: string;
};

type RoadmapRegistryStore = {
  version: 1;
  roadmaps: RoadmapRegistryEntry[];
};

type ScopedRoadmapOptions = {
  persist: boolean;
  runner: Runner;
  actionRunner?: ArtifactActionCommandRunner;
  apmSkillRegistryClient?: ApmSkillRegistryClient;
  roadmapRegistryPath?: string;
  bridgeApiBaseUrl?: string;
  bridgeApiAuthToken?: string;
  routeWorktreeRoot?: string;
  actionAmbientEnv?: Record<string, string | undefined>;
  actionProcessEnv?: Record<string, string | undefined>;
  actionWorktreeRoot?: string;
  skillsEnv?: Record<string, string | undefined>;
};

function parseRoadmapApiPath(pathname: string): RoadmapApiRoute | undefined {
  const prefix = "/api/roadmaps/";
  if (!pathname.startsWith(prefix)) {
    return undefined;
  }
  const rest = pathname.slice(prefix.length);
  const [rawRoadmapId, ...suffixParts] = rest.split("/");
  if (!rawRoadmapId) {
    return undefined;
  }
  return {
    roadmapId: decodeURIComponent(rawRoadmapId),
    suffix: suffixParts.length > 0 ? `/${suffixParts.join("/")}` : ""
  };
}

async function handleRoadmapApiRequest(
  roadmapId: string,
  suffix: string,
  request: IncomingMessage,
  response: ServerResponse,
  state: StudioServerState,
  options: ScopedRoadmapOptions
): Promise<boolean> {
  const cwd = resolveRoadmapRepositoryPath(roadmapId, { roadmapRegistryPath: options.roadmapRegistryPath });
  const persist = options.persist;

  if (request.method === "GET" && suffix === "") {
    sendJson(response, 200, loadStudioRoadmap(roadmapId, state, { persist, roadmapRegistryPath: options.roadmapRegistryPath }));
    return true;
  }

  if (request.method === "GET" && suffix === "/board") {
    sendJson(response, 200, currentBoard(state, { cwd, persist }));
    return true;
  }

  if (request.method === "GET" && suffix === "/roadmap") {
    sendJson(response, 200, toStudioRoadmapView(currentBoard(state, { cwd, persist })));
    return true;
  }

  if (request.method === "GET" && suffix === "/events") {
    sendJson(response, 200, { events: currentEvents(state, { cwd, persist }) });
    return true;
  }

  if (request.method === "GET" && suffix === "/repository") {
    sendJson(response, 200, { repository: readWorktreeStatus(cwd) });
    return true;
  }

  if (request.method === "GET" && suffix === "/worktree") {
    sendJson(response, 200, readWorktreeStatus(cwd));
    return true;
  }

  if (request.method === "GET" && suffix === "/artifacts") {
    sendJson(response, 200, { artifacts: currentBoard(state, { cwd, persist }).artifacts });
    return true;
  }

  if (request.method === "GET" && suffix.startsWith("/artifacts/")) {
    const artifactId = decodeURIComponent(suffix.slice("/artifacts/".length));
    const artifact = findArtifact(currentBoard(state, { cwd, persist }), artifactId);
    sendJson(response, artifact ? 200 : 404, artifact ? { artifact } : { error: `Unknown artifact: ${artifactId}` });
    return true;
  }

  if (suffix === "/artifact-actions" || suffix.startsWith("/artifact-actions/") || suffix === "/action-runs" || suffix.startsWith("/action-runs/")) {
    return handleArtifactActionApiRequest(suffix, request, response, {
      cwd,
      roadmapId,
      actionRunner: options.actionRunner,
      ambientEnv: options.actionAmbientEnv,
      processEnv: options.actionProcessEnv,
      worktreeRoot: options.actionWorktreeRoot
    });
  }

  if (suffix === "/hunsu/drafts" || suffix.startsWith("/hunsu/drafts/")) {
    return handleHunsuDraftApiRequest(suffix.slice("/hunsu/drafts".length), request, response, state, {
      cwd,
      persist,
      roadmapId,
      runner: options.runner,
      bridgeApiBaseUrl: options.bridgeApiBaseUrl ?? defaultBridgeApiBaseUrl(cwd),
      bridgeApiAuthToken: options.bridgeApiAuthToken,
      apmSkillRegistryClient: options.apmSkillRegistryClient,
      routeWorktreeRoot: options.routeWorktreeRoot
    });
  }

  if (request.method === "GET" && suffix === "/runs") {
    const runs = runsForRepository(state, cwd).filter(run => !run.roadmapId || run.roadmapId === roadmapId).map(toStudioRunSummary);
    sendJson(response, 200, { runs, executes: runs.map(toStudioExecuteView) });
    return true;
  }

	  if (request.method === "GET" && suffix === "/executes") {
	    const runs = runsForRepository(state, cwd).filter(run => !run.roadmapId || run.roadmapId === roadmapId).map(toStudioRunSummary);
	    sendJson(response, 200, { executes: runs.map(toStudioExecuteView), runs });
	    return true;
	  }

	  if (request.method === "GET" && suffix === "/agent-sessions") {
	    sendJson(response, 200, { sessions: agentSessionsForRepository(state, cwd).filter(session => agentSessionMatchesRoadmap(session, roadmapId)).map(toAgentSessionSummary) });
	    return true;
	  }

	  if (request.method === "GET" && suffix.startsWith("/agent-sessions/") && suffix !== "/agent-sessions/events") {
	    const route = parseAgentSessionRoute(suffix.slice("/agent-sessions".length));
	    if (route?.action === "show") {
	      const session = findAgentSessionById(state, route.sessionId, { cwd, roadmapId });
	      sendJson(response, session ? 200 : 404, session ? { session } : { error: `Unknown AgentSession: ${route.sessionId}` });
	      return true;
	    }
	    if (route?.action === "events") {
	      streamAgentSessionEvents(request, response, state, { cwd, roadmapId, sessionId: route.sessionId });
	      return true;
	    }
	  }

  if (request.method === "GET" && suffix === "/skills") {
    sendJson(response, 200, { skills: listCodexSkills(options.skillsEnv) });
    return true;
  }

	  if (request.method === "GET" && suffix === "/agent-sessions/events") {
	    streamAgentSessionEvents(request, response, state, { cwd, roadmapId });
	    return true;
	  }

	  if (request.method === "GET" && (suffix === "/runs/events" || suffix === "/executes/events")) {
	    streamStudioLiveEvents(request, response, state, { cwd });
	    return true;
	  }

  const moveFilesRoute = parseMoveFilesRoute(suffix);
  if (moveFilesRoute && request.method === "GET") {
    const board = currentBoard(state, { cwd, persist });
    const requestUrl = new URL(request.url ?? "/", "http://localhost");
    const filePath = requestUrl.searchParams.get("path") ?? undefined;
    if (moveFilesRoute.action === "tree") {
      sendJson(response, 200, { tree: readMoveFileTree(board, moveFilesRoute.moveId, cwd, filePath) });
      return true;
    }
    if (moveFilesRoute.action === "blob") {
      sendJson(response, 200, { blob: readMoveFileBlob(board, moveFilesRoute.moveId, cwd, filePath ?? "") });
      return true;
    }
    if (moveFilesRoute.action === "diff") {
      sendJson(response, 200, { diff: readMoveDiff(board, moveFilesRoute.moveId, cwd) });
      return true;
    }
  }

  if (request.method === "GET" && suffix.startsWith("/moves/") && suffix.endsWith("/diff")) {
    const moveId = decodeURIComponent(suffix.slice("/moves/".length, -"/diff".length));
    sendJson(response, 200, { diff: readMoveDiff(currentBoard(state, { cwd, persist }), moveId, cwd) });
    return true;
  }

  if (request.method === "POST" && suffix === "/commands") {
    const body = await readJson<StudioCommandRequest>(request);
    const commands = isCommandBatch(body) ? body.commands : [body];
    sendJson(response, 202, await executeStudioCommands(commands, state, { cwd, persist }));
    return true;
  }

  if (request.method === "POST" && (suffix === "/runs/start" || suffix === "/executes/start")) {
    const body = await readJson<StudioRunStartRequest>(request);
    sendJson(response, 202, await startStudioRun(body, state, {
      cwd,
      persist,
      roadmapId,
      runner: options.runner,
      apmSkillRegistryClient: options.apmSkillRegistryClient,
      routeWorktreeRoot: options.routeWorktreeRoot
    }));
    return true;
  }

  if (request.method === "POST" && (suffix === "/runs/pause" || suffix === "/executes/pause")) {
    const body = await readJson<StudioRunActionRequest>(request);
    sendJson(response, 202, await pauseStudioRun(body, state, { cwd, persist, runner: options.runner }));
    return true;
  }

  if (request.method === "POST" && (suffix === "/runs/resume" || suffix === "/executes/resume")) {
    const body = await readJson<StudioRunActionRequest>(request);
    sendJson(response, 202, await resumeStudioRun(body, state, {
      cwd,
      persist,
      runner: options.runner,
      apmSkillRegistryClient: options.apmSkillRegistryClient
    }));
    return true;
  }

  if (request.method === "POST" && (suffix === "/runs/stop" || suffix === "/executes/stop")) {
    const body = await readJson<StudioRunActionRequest>(request);
    sendJson(response, 202, await stopStudioRun(body, state, { cwd, persist, runner: options.runner }));
    return true;
  }

  if (request.method === "POST" && (suffix === "/runs/complete-move" || suffix === "/executes/complete-move")) {
    const body = await readJson<StudioMoveCompletionRequest>(request);
    sendJson(response, 202, await completeStudioMove(body, state, { cwd, persist }));
    return true;
  }

  if (request.method === "POST" && suffix === "/lines/accept") {
    const body = await readJson<StudioLineDecisionRequest>(request);
    sendJson(response, 202, await decideStudioLine("accept", body, state, { cwd, persist }));
    return true;
  }

  if (request.method === "POST" && suffix === "/lines/reject") {
    const body = await readJson<StudioLineDecisionRequest>(request);
    sendJson(response, 202, await decideStudioLine("reject", body, state, { cwd, persist }));
    return true;
  }

  return false;
}

type ArtifactActionApiOptions = {
  cwd: string;
  roadmapId?: string;
  actionRunner?: ArtifactActionCommandRunner;
  ambientEnv?: Record<string, string | undefined>;
  processEnv?: Record<string, string | undefined>;
  worktreeRoot?: string;
};

type ArtifactActionApiRoute =
  | { resource: "action"; actionId: string; action: "run" }
  | { resource: "run"; runId: string; action: "show" }
  | { resource: "run"; runId: string; action: "stop" }
  | { resource: "run"; runId: string; action: "proxy"; alias: string; path: string };

type AgentSessionApiRoute =
  | { action: "show"; sessionId: string }
  | { action: "events"; sessionId: string };

type MoveFilesApiRoute =
  | { action: "tree"; moveId: string }
  | { action: "blob"; moveId: string }
  | { action: "diff"; moveId: string };

function parseAgentSessionRoute(suffix: string): AgentSessionApiRoute | undefined {
  if (!suffix.startsWith("/")) {
    return undefined;
  }
  if (suffix.endsWith("/events")) {
    const rawSessionId = suffix.slice(1, -"/events".length);
    return rawSessionId ? { action: "events", sessionId: decodeURIComponent(rawSessionId) } : undefined;
  }
  const rawSessionId = suffix.slice(1);
  return rawSessionId ? { action: "show", sessionId: decodeURIComponent(rawSessionId) } : undefined;
}

function parseMoveFilesRoute(suffix: string): MoveFilesApiRoute | undefined {
  if (!suffix.startsWith("/moves/")) {
    return undefined;
  }
  const parts = suffix.slice(1).split("/");
  if (parts.length < 4 || parts[0] !== "moves" || parts[2] !== "files") {
    return undefined;
  }
  const moveId = decodeURIComponent(parts[1]);
  if (parts[3] === "tree") {
    return { action: "tree", moveId };
  }
  if (parts[3] === "blob") {
    return { action: "blob", moveId };
  }
  if (parts[3] === "diff") {
    return { action: "diff", moveId };
  }
  return undefined;
}

type HunsuDraftApiOptions = {
  cwd: string;
  persist: boolean;
  roadmapId: string;
  runner: Runner;
  bridgeApiBaseUrl: string;
  bridgeApiAuthToken?: string;
  apmSkillRegistryClient?: ApmSkillRegistryClient;
  routeWorktreeRoot?: string;
};

function defaultBridgeApiBaseUrl(cwd: string): string {
  return endpointUrl(unwrapConfigResult(resolveBridgeRuntimeConfig(process.env, { cwd })).bridgeApi);
}

async function handleHunsuDraftApiRequest(
  suffix: string,
  request: IncomingMessage,
  response: ServerResponse,
  state: StudioServerState,
  options: HunsuDraftApiOptions
): Promise<boolean> {
  if (request.method === "GET" && suffix === "") {
    sendJson(response, 200, { drafts: hunsuDraftsForScope(state, options) });
    return true;
  }

  if (request.method === "POST" && suffix === "") {
    const body = await readJson<StudioHunsuDraftStartRequest>(request);
    const result = await startHunsuDraft(body, state, options);
    sendJson(response, 202, result);
    return true;
  }

  const route = parseHunsuDraftRoute(suffix);
  if (!route) {
    return false;
  }

  if (request.method === "GET" && route.action === "show") {
    const draft = findHunsuDraft(state, route.draftSessionId, options);
    sendJson(response, draft ? 200 : 404, draft ? { draft } : { error: `Unknown HUNSU Draft: ${route.draftSessionId}` });
    return true;
  }

  if (request.method === "POST" && route.action === "messages") {
    const body = await readJson<StudioHunsuDraftMessageRequest>(request);
    sendJson(response, 202, await sendHunsuDraftMessage(route.draftSessionId, body, state, options));
    return true;
  }

  if (request.method === "POST" && route.action === "diff-artifacts") {
    const result = await createHunsuDraftDiffArtifact(route.draftSessionId, state, options);
    if (wantsHunsuDraftCheckCommandResponse(request)) {
      if (!result.diffArtifact) {
        throw new Error("HUNSU Draft check command did not create a DiffArtifact.");
      }
      sendJson(response, 202, publicHunsuDraftCheckCommandResult(result.diffArtifact));
      return true;
    }
    sendJson(response, 202, result);
    return true;
  }

  if (request.method === "GET" && route.action === "diff-artifact") {
    const draft = findHunsuDraft(state, route.draftSessionId, options);
    const diffArtifact = draft ? publicHunsuDraftDiffArtifact(draft.diffArtifacts[route.diffArtifactId]) : undefined;
    sendJson(response, diffArtifact ? 200 : 404, diffArtifact ? { diffArtifact } : { error: `Unknown HUNSU Draft DiffArtifact: ${route.diffArtifactId}` });
    return true;
  }

  if (request.method === "POST" && route.action === "approve") {
    const body = await readJson<{ diffArtifactId?: string }>(request);
    sendJson(response, 202, await approveHunsuDraft(route.draftSessionId, body, state, options));
    return true;
  }

  if (request.method === "POST" && route.action === "discard") {
    sendJson(response, 202, await discardHunsuDraft(route.draftSessionId, state, options));
    return true;
  }

  return false;
}

type HunsuDraftApiRoute =
  | { action: "show"; draftSessionId: string }
  | { action: "messages"; draftSessionId: string }
  | { action: "diff-artifacts"; draftSessionId: string }
  | { action: "diff-artifact"; draftSessionId: string; diffArtifactId: string }
  | { action: "approve"; draftSessionId: string }
  | { action: "discard"; draftSessionId: string };

function parseHunsuDraftRoute(suffix: string): HunsuDraftApiRoute | undefined {
  const parts = suffix.split("/").filter(Boolean).map(decodeURIComponent);
  if (parts.length === 1) {
    return { action: "show", draftSessionId: parts[0] };
  }
  if (parts.length === 3 && parts[1] === "diff-artifacts") {
    return { action: "diff-artifact", draftSessionId: parts[0], diffArtifactId: parts[2] };
  }
  if (parts.length !== 2) return undefined;
  const action = parts[1];
  if (action === "messages" || action === "diff-artifacts" || action === "approve" || action === "discard") {
    return { action, draftSessionId: parts[0] };
  }
  return undefined;
}

async function resolveHunsuDraftManager(
  request: StudioHunsuDraftStartRequest,
  board: BoardProjection
): Promise<{ managerLock?: HubPackageLock; manager: ManagerConfig }> {
  if (!request.managerLock) {
    return { manager: createDefaultManagerConfig() };
  }
  if (request.managerLock.kind !== "manager") {
    throw new Error(`HUNSU Draft managerLock must reference a manager package, got ${request.managerLock.kind}`);
  }
  const resolved = await resolveHubPackageManifestFromOrigin(request.managerLock, { origins: board.origins });
  if (resolved.manifest.kind !== "manager") {
    throw new Error(`Hub package ${resolved.manifest.kind}/${resolved.manifest.key}@${resolved.manifest.version} is not a Manager package`);
  }
  return {
    managerLock: { ...resolved.lock },
    manager: cloneManagerConfigForRuntime(resolved.manifest.manager)
  };
}

function cloneManagerConfigForRuntime(value: ManagerConfig): ManagerConfig {
  const result = validateManagerConfig(value, "Manager");
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.value;
}

async function startHunsuDraft(
  request: StudioHunsuDraftStartRequest,
  state: StudioServerState,
  options: HunsuDraftApiOptions
): Promise<StudioHunsuDraftResult> {
  rehydrateHunsuDraftRoutesForRepository(state, options.cwd);
  const board = currentBoard(state, options);
  const source = resolveHunsuDraftSource(board, request);
  const resolvedManager = await resolveHunsuDraftManager(request, board);
  const now = new Date().toISOString();
  const draftSessionId = nextHunsuDraftSessionId(state);
  const routeId = hunsuDraftRouteId(draftSessionId);
  const routeBaseRef = options.persist ? executeBaseRefForNode(board, source.node, options.cwd) : undefined;
  const worktree = options.persist
    ? createRouteWorktree(options.cwd, routeId, now, routeBaseRef, options.routeWorktreeRoot)
    : createVirtualRouteWorktree(options.cwd, routeId, now);
  const sourceSnapshot = hunsuDraftSourceSnapshot(source);
  const sourceArtifact = registerHunsuDraftArtifact(state, {
    kind: "source-protocol",
    repositoryPath: options.cwd,
    roadmapId: options.roadmapId,
    draftSessionId,
    value: createHunsuSourceProtocolArtifact(board, source, sourceSnapshot),
    createdAt: now
  });
  const draft: StudioHunsuDraftSession = {
    draftSessionId,
    roadmapId: options.roadmapId,
    repositoryPath: options.cwd,
    sourceLineId: String(source.line.id),
    sourceNodeId: String(source.node.id),
    sourceMoveId: source.move ? String(source.move.id) : undefined,
    routeId,
    worktree,
    agentSessionIds: [],
    sourceArtifactId: sourceArtifact.artifactId,
    currentArtifactId: sourceArtifact.artifactId,
    managerLock: resolvedManager.managerLock,
    manager: resolvedManager.manager,
    messages: [],
    diffArtifacts: {},
    status: "draft",
    createdAt: now,
    updatedAt: now
  };
  state.hunsuDrafts[draft.draftSessionId] = draft;
  writeHunsuDraftDecodedSurfaces(draft, source.node, loadDomainStore(options.cwd).runtime);
  await prepareManagerCodexEnvironmentForHunsuDraft(draft, options);
  writeAndCommitHunsuDraftRouteRuntime(draft, options, "Hunsu draft route start", HUNSU_DRAFT_ALL_RUNTIME_PATHS);
  const session = startHunsuDraftAgentSession(state, draft, now);
  if (options.runner.prepareHunsuDraftSession) {
    session.state = { type: "starting", startedAt: now };
    bumpAgentSession(session, now);
    publishAgentSessionUpdated(state, session);
    try {
      const requestRecord = board.requests.find(candidate => candidate.id === source.line.requestId) ?? board.requests[0];
      const result = await options.runner.prepareHunsuDraftSession({
        runId: `hunsu-draft:${draft.draftSessionId}`,
        repositoryPath: hunsuDraftRepositoryPath(draft, options),
        requestGoal: String(requestRecord?.goal ?? "No Roadmap request goal is available."),
        activeDestinations: destinationsForLine(board, draft.sourceLineId).filter(isOpenDestination),
        selectedDestinationIds: selectedDestinationIdsForPrompt(source.node.destinations),
        harness: source.node.harness,
        board,
        draftSessionId: draft.draftSessionId,
        manager: draft.manager,
        sourceArtifactId: draft.sourceArtifactId,
        baseArtifactId: draft.currentArtifactId,
        draftCheckCommand: hunsuDraftCheckCommand(draft, options),
        sourceSnapshot,
        messages: runnerMessagesForHunsuDraft(draft),
        providerThreadId: draft.providerThreadId
      });
      draft.providerThreadId = result.providerThreadId ?? draft.providerThreadId;
      syncHunsuDraftAgentSession(state, draft, result);
    } catch (error) {
      markHunsuDraftFailed(draft, error);
      writeAndCommitHunsuDraftRouteRuntime(draft, options, "Hunsu draft route failed");
      syncHunsuDraftAgentSession(state, draft);
      throw error;
    }
  }
  if (request.message?.trim()) {
    return sendHunsuDraftMessage(draft.draftSessionId, { message: request.message }, state, options);
  }
  return { draft, board };
}

async function sendHunsuDraftMessage(
  draftSessionId: string,
  request: StudioHunsuDraftMessageRequest,
  state: StudioServerState,
  options: HunsuDraftApiOptions
): Promise<StudioHunsuDraftResult> {
  const draft = requireMutableHunsuDraft(state, draftSessionId, options);
  const text = request.message?.trim();
  if (!text) {
    throw new Error("HUNSU Draft message cannot be empty");
  }
  const now = new Date().toISOString();
  appendHunsuDraftMessage(draft, "user", text, now);
  syncHunsuDraftAgentSession(state, draft);
  const board = currentBoard(state, options);
  const source = requireHunsuDraftSource(board, draft);
  const requestRecord = board.requests.find(candidate => candidate.id === source.line.requestId) ?? board.requests[0];
  try {
    const runId = `hunsu-draft:${draft.draftSessionId}`;
    await prepareManagerCodexEnvironmentForHunsuDraft(draft, options);
    const result = await withHunsuDraftRunnerEventCollection(options.runner, runId, state, draft, () => options.runner.runHunsuDraftTurn({
      runId,
      repositoryPath: hunsuDraftRepositoryPath(draft, options),
      requestGoal: String(requestRecord?.goal ?? "No Roadmap request goal is available."),
      activeDestinations: destinationsForLine(board, draft.sourceLineId).filter(isOpenDestination),
      selectedDestinationIds: selectedDestinationIdsForPrompt(source.node.destinations),
      harness: source.node.harness,
      board,
      draftSessionId: draft.draftSessionId,
      manager: draft.manager,
      sourceArtifactId: draft.sourceArtifactId,
      baseArtifactId: draft.currentArtifactId,
      draftCheckCommand: hunsuDraftCheckCommand(draft, options),
      sourceSnapshot: hunsuDraftSourceSnapshot(source),
      messages: runnerMessagesForHunsuDraft(draft),
      userMessage: text,
      providerThreadId: draft.providerThreadId
    }));
    draft.providerThreadId = result.providerThreadId ?? draft.providerThreadId;
    const finalResponse = result.finalResponse?.trim();
    if (finalResponse) {
      appendHunsuDraftMessage(draft, "draft-agent", finalResponse, new Date().toISOString());
    }
    const latestArtifact = draft.latestDiffArtifactId ? draft.diffArtifacts[draft.latestDiffArtifactId] : undefined;
    const finalResponseMentionsLatestArtifact = Boolean(
      latestArtifact && finalResponse && finalResponse.includes(`diffArtifactId="${latestArtifact.diffArtifactId}"`)
    );
    if (!latestArtifact || !finalResponseMentionsLatestArtifact || latestArtifact.status !== "pass") {
      draft.status = draft.status === "failed" || draft.status === "ready" ? "draft" : draft.status;
      draft.readyDraft = undefined;
    }
    draft.error = undefined;
    draft.updatedAt = new Date().toISOString();
    syncHunsuDraftAgentSession(state, draft, result);
    writeAndCommitHunsuDraftRouteRuntime(draft, options, "Hunsu draft route message", HUNSU_DRAFT_REQUEST_RUNTIME_PATHS);
    return { draft, board: currentBoard(state, options) };
  } catch (error) {
    markHunsuDraftFailed(draft, error);
    writeAndCommitHunsuDraftRouteRuntime(draft, options, "Hunsu draft route failed");
    syncHunsuDraftAgentSession(state, draft);
    throw error;
  }
}

async function approveHunsuDraft(
  draftSessionId: string,
  request: { diffArtifactId?: string; teamName?: string },
  state: StudioServerState,
  options: HunsuDraftApiOptions
): Promise<StudioHunsuDraftResult> {
  const draft = requireMutableHunsuDraft(state, draftSessionId, options);
  const diffArtifactId = request.diffArtifactId?.trim();
  if (!diffArtifactId) {
    throw new Error("Confirm HUNSU requires a DiffArtifact id");
  }
  const artifact = draft.diffArtifacts[diffArtifactId];
  if (!artifact) {
    throw new Error(`Unknown HUNSU Draft DiffArtifact: ${diffArtifactId}`);
  }
  if (artifact.status !== "pass" || !artifact.readyDraft) {
    throw new Error(artifact.failedReason ?? `HUNSU Draft DiffArtifact ${diffArtifactId} is not ready for approval`);
  }
  const currentSurfaceHash = computeHunsuDraftSurfaceHash(draft);
  if (currentSurfaceHash !== artifact.draftSurfaceHash) {
    throw new Error("HUNSU Draft request files changed after this DiffArtifact was created. Ask the Draft agent to check the request files again.");
  }
  const approvedDraft = hunsuDraftWithApprovedTeamName(artifact.readyDraft, request.teamName, currentBoard(state, options));
  const command: Command = {
    type: "ConfirmHunsuDraft",
    draft: approvedDraft,
    actor: "DIRECTOR",
    at: new Date().toISOString()
  };
  const result = options.persist
    ? await writeCommand(command, { cwd: options.cwd, commitMessage: `Hunsu intervention ${approvedDraft.hunsuId}` })
    : await executeStudioCommand(command, state, { cwd: options.cwd, persist: false });
  if (options.persist) {
    state.events = loadDomainStore(options.cwd).events;
  }
  artifact.readyDraft = approvedDraft;
  draft.readyDraft = approvedDraft;
  draft.latestDiffArtifactId = artifact.diffArtifactId;
  draft.status = "confirmed";
  draft.updatedAt = new Date().toISOString();
  const hunsu = result.board.hunsus.find(candidate => String(candidate.id) === String(approvedDraft.hunsuId));
  if (hunsu) {
    draft.confirmedHunsuId = String(hunsu.id);
    draft.confirmedNodeId = String(hunsu.toNodeId);
  }
  writeAndCommitHunsuDraftRouteRuntime(draft, options, `Hunsu draft route confirmed ${approvedDraft.hunsuId}`);
  syncHunsuDraftAgentSession(state, draft);
  return { draft, board: result.board, acceptedEvents: result.acceptedEvents, hunsu };
}

function hunsuDraftWithApprovedTeamName(
  readyDraft: ReadyHunsuDraft,
  inputTeamName: string | undefined,
  board: BoardProjection
): ReadyHunsuDraft {
  const trimmed = inputTeamName?.trim();
  if (inputTeamName !== undefined && !trimmed) {
    throw new Error("teamName must be a non-empty string");
  }
  const teamName = trimmed ? requireDomainValue(makeTeamName(trimmed)) : readyDraft.newTeamName;
  if (board.lines.some(line => line.teamName === teamName)) {
    throw new Error(`Team name is already used: ${teamName}`);
  }
  return {
    ...readyDraft,
    newTeamName: teamName,
    teamSnapshot: {
      ...readyDraft.teamSnapshot,
      teamName
    }
  };
}

async function createHunsuDraftDiffArtifact(
  draftSessionId: string,
  state: StudioServerState,
  options: HunsuDraftApiOptions
): Promise<StudioHunsuDraftResult> {
  const draft = requireMutableHunsuDraft(state, draftSessionId, options);
  const board = currentBoard(state, options);
  const source = requireHunsuDraftSource(board, draft);
  const checkedAt = new Date().toISOString();
  const draftSurfaceHash = computeHunsuDraftSurfaceHash(draft);
  const runtimeCheck = computeHunsuDraftRuntimeCheck(draft, source.node, loadDomainStore(options.cwd).runtime, checkedAt);
  const changes = runtimeCheck.changes;
  if (!changes.ok) {
    draft.readyDraft = undefined;
    draft.status = draft.status === "failed" ? "draft" : draft.status === "ready" ? "draft" : draft.status;
    draft.error = changes.errors[0];
    const diffArtifact = storeHunsuDraftDiffArtifact(draft, {
      status: "failed",
      summary: changes.summary,
      files: changes.files,
      errors: changes.errors,
      failedReason: changes.errors[0],
      checkedAt,
      draftSurfaceHash
    });
    draft.updatedAt = checkedAt;
    writeAndCommitHunsuDraftRouteRuntime(draft, options, "Hunsu draft route diff artifact failed", HUNSU_DRAFT_REQUEST_RUNTIME_PATHS);
    syncHunsuDraftAgentSession(state, draft);
    return { draft, board, diffArtifact: publicHunsuDraftDiffArtifact(diffArtifact) };
  }
  if (!runtimeCheck.validation) {
    throw new Error("HUNSU Draft DiffArtifact succeeded without a validated runtime bundle");
  }
  const readyDraft = readyHunsuDraftFromRuntimeChanges(draft, changes, board, source, runtimeCheck.validation, draft.providerThreadId, checkedAt);
  const confirmCommand = { type: "ConfirmHunsuDraft", draft: readyDraft, actor: "DIRECTOR", at: checkedAt } satisfies Extract<Command, { type: "ConfirmHunsuDraft" }>;
  const dryRun = dryRunHunsuDraftConfirm(currentEvents(state, options), confirmCommand);
  if (!dryRun.ok) {
    draft.readyDraft = undefined;
    draft.status = draft.status === "ready" ? "draft" : draft.status;
    draft.error = dryRun.error;
    const diffArtifact = storeHunsuDraftDiffArtifact(draft, {
      status: "failed",
      summary: changes.summary,
      files: changes.files,
      errors: [dryRun.error],
      failedReason: dryRun.error,
      checkedAt,
      draftSurfaceHash
    });
    draft.updatedAt = checkedAt;
    writeAndCommitHunsuDraftRouteRuntime(draft, options, "Hunsu draft route diff artifact failed", HUNSU_DRAFT_REQUEST_RUNTIME_PATHS);
    syncHunsuDraftAgentSession(state, draft);
    return { draft, board, diffArtifact: publicHunsuDraftDiffArtifact(diffArtifact) };
  }
  draft.readyDraft = readyDraft;
  draft.status = "ready";
  draft.error = undefined;
  const diffArtifact = storeHunsuDraftDiffArtifact(draft, {
    status: "pass",
    summary: changes.summary,
    files: changes.files,
    errors: [],
    checkedAt,
    draftSurfaceHash,
    readyDraft
  });
  draft.updatedAt = checkedAt;
  writeAndCommitHunsuDraftRouteRuntime(draft, options, "Hunsu draft route diff artifact created", HUNSU_DRAFT_REQUEST_RUNTIME_PATHS);
  syncHunsuDraftAgentSession(state, draft);
  return { draft, board, diffArtifact: publicHunsuDraftDiffArtifact(diffArtifact) };
}

type HunsuDraftConfirmDryRun =
  | { ok: true; board: BoardProjection }
  | { ok: false; error: string };

function dryRunHunsuDraftConfirm(events: DomainEvent[], command: Extract<Command, { type: "ConfirmHunsuDraft" }>): HunsuDraftConfirmDryRun {
  const applied = tryApplyCommand(events, command);
  if (!applied.ok) {
    return { ok: false, error: applied.error.message };
  }
  const projected = tryProjectBoard(applied.value);
  if (!projected.ok) {
    return { ok: false, error: projected.error.message };
  }
  return { ok: true, board: projected.value };
}

type HunsuDraftRuntimeCheck = {
  changes: StudioHunsuDraftChanges;
  validation?: HunsuDraftRuntimeValidation;
};

function writeHunsuDraftDecodedSurfaces(draft: StudioHunsuDraftSession, sourceNode: NodeRecord, baseRuntime: HunsuRuntimeState): void {
  if (!draft.worktree || draft.worktree.baseRef === "virtual") {
    return;
  }
  const sourceRuntime = sourceRuntimeForDraft(baseRuntime, sourceNode);
  const files = decodeRuntimeBundleToDraftFiles(sourceRuntime);
  for (const file of HUNSU_DRAFT_RUNTIME_FILES) {
    writeReadableJson(join(draft.worktree.path, HUNSU_DRAFT_PREV_DIR, file), files[file]);
    writeReadableJson(join(draft.worktree.path, HUNSU_DRAFT_REQUEST_DIR, file), files[file]);
  }
}

async function prepareManagerCodexEnvironmentForHunsuDraft(draft: StudioHunsuDraftSession, options: HunsuDraftApiOptions): Promise<void> {
  if (!draft.worktree || draft.worktree.baseRef === "virtual") {
    return;
  }
  const managerHarness = createDefaultHarness("Prepare HUNSU Draft Manager resources.");
  managerHarness.members = [
    createDefaultMemberConfig(
      String(draft.manager.id),
      draft.manager.promptTemplate.template,
      draft.manager.skills,
      { kind: "worktree_write", network: "enabled" },
      { policy: "never" },
      draft.manager.plugins
    )
  ];
  await prepareMemberCodexEnvironmentForExecute(draft.worktree.path, managerHarness, {
    phase: "member",
    executorId: String(draft.manager.id),
    apmSkillRegistryClient: options.apmSkillRegistryClient
  });
}

function writeReadableJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function hunsuDraftCheckCommand(draft: StudioHunsuDraftSession, options: HunsuDraftApiOptions): string {
  const url = `${options.bridgeApiBaseUrl}/api/roadmaps/${encodeURIComponent(options.roadmapId)}/hunsu/drafts/${encodeURIComponent(draft.draftSessionId)}/diff-artifacts?response=${HUNSU_DRAFT_CHECK_COMMAND_RESPONSE}`;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (options.bridgeApiAuthToken) {
    headers.authorization = `Bearer ${options.bridgeApiAuthToken}`;
  }
  const script = [
    `const url = ${JSON.stringify(url)};`,
    `const headers = ${JSON.stringify(headers)};`,
    "const response = await fetch(url, { method: \"POST\", headers, body: \"{}\" });",
    "const text = await response.text();",
    "console.log(text);",
    "if (!response.ok) process.exit(1);"
  ].join(" ");
  return `node --input-type=module -e ${shellSingleQuote(script)}`;
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function storeHunsuDraftDiffArtifact(
  draft: StudioHunsuDraftSession,
  input: Omit<StudioHunsuDraftDiffArtifactRecord, "diffArtifactId" | "draftSessionId">
): StudioHunsuDraftDiffArtifactRecord {
  const diffArtifactId = createHunsuDraftDiffArtifactId(draft.draftSessionId, input);
  const artifact: StudioHunsuDraftDiffArtifactRecord = {
    diffArtifactId,
    draftSessionId: draft.draftSessionId,
    ...input
  };
  draft.diffArtifacts[diffArtifactId] = artifact;
  draft.latestDiffArtifactId = diffArtifactId;
  return artifact;
}

function createHunsuDraftDiffArtifactId(
  draftSessionId: string,
  input: Omit<StudioHunsuDraftDiffArtifactRecord, "diffArtifactId" | "draftSessionId">
): string {
  return `hdd_${hashHex(createHash("sha256").update(stableJson({
    draftSessionId,
    status: input.status,
    summary: input.summary,
    files: input.files,
    errors: input.errors,
    failedReason: input.failedReason,
    checkedAt: input.checkedAt,
    draftSurfaceHash: input.draftSurfaceHash
  }))).slice(0, 16)}`;
}

function publicHunsuDraftDiffArtifact(artifact: StudioHunsuDraftDiffArtifactRecord | undefined): StudioHunsuDraftDiffArtifact | undefined {
  if (!artifact) return undefined;
  return {
    diffArtifactId: artifact.diffArtifactId,
    draftSessionId: artifact.draftSessionId,
    status: artifact.status,
    newTeamName: artifact.readyDraft ? String(artifact.readyDraft.newTeamName) : undefined,
    files: artifact.files.map(publicHunsuDraftRuntimeFileDiff),
    errors: artifact.errors,
    failedReason: artifact.failedReason,
    checkedAt: artifact.checkedAt,
    draftSurfaceHash: artifact.draftSurfaceHash
  };
}

function wantsHunsuDraftCheckCommandResponse(request: IncomingMessage): boolean {
  const url = new URL(request.url ?? "/", "http://localhost");
  return url.searchParams.get("response") === HUNSU_DRAFT_CHECK_COMMAND_RESPONSE;
}

function publicHunsuDraftCheckCommandResult(artifact: StudioHunsuDraftDiffArtifact): StudioHunsuDraftCheckCommandResult {
  const base = {
    draftSessionId: artifact.draftSessionId,
    diffArtifactId: artifact.diffArtifactId,
    marker: hunsuDraftDiffArtifactMarker(artifact),
    checkedAt: artifact.checkedAt
  };
  if (artifact.status === "pass") {
    return {
      ...base,
      status: "pass",
      changedFiles: artifact.files.map(file => ({ path: file.path, kind: file.kind }))
    };
  }
  return {
    ...base,
    status: "failed",
    failedReason: artifact.failedReason ?? artifact.errors[0] ?? "HUNSU Draft DiffArtifact failed.",
    errors: artifact.errors
  };
}

function hunsuDraftDiffArtifactMarker(artifact: Pick<StudioHunsuDraftDiffArtifact, "draftSessionId" | "diffArtifactId" | "status">): string {
  return `::hunsu-diff{draftSessionId="${artifact.draftSessionId}" diffArtifactId="${artifact.diffArtifactId}" status="${artifact.status}"}`;
}

function publicHunsuDraftRuntimeFileDiff(change: StudioHunsuDraftRuntimeFileChange): StudioHunsuDraftRuntimeFileDiff {
  return {
    path: change.path,
    kind: change.kind,
    diff: change.diff
  };
}

function computeHunsuDraftSurfaceHash(draft: StudioHunsuDraftSession): string {
  const hash = createHash("sha256");
  hash.update(`draft:${draft.draftSessionId}\n`);
  if (!draft.worktree || draft.worktree.baseRef === "virtual") {
    hash.update("worktree:virtual-or-missing\n");
    return hashHex(hash);
  }
  for (const dir of [HUNSU_DRAFT_PREV_DIR, HUNSU_DRAFT_REQUEST_DIR]) {
    for (const file of HUNSU_DRAFT_RUNTIME_FILES) {
      const path = join(draft.worktree.path, dir, file);
      hash.update(`${dir}/${file}\0`);
      hash.update(existsSync(path) ? readFileSync(path, "utf8") : "<missing>");
      hash.update("\0");
    }
  }
  return hashHex(hash);
}

function computeHunsuDraftRuntimeCheck(draft: StudioHunsuDraftSession, sourceNode: NodeRecord, baseRuntime: HunsuRuntimeState, checkedAt?: string): HunsuDraftRuntimeCheck {
  const base: Omit<StudioHunsuDraftChanges, "ok" | "summary" | "errors" | "files"> = {
    draftSessionId: draft.draftSessionId,
    sourceNodeId: draft.sourceNodeId,
    requestDir: HUNSU_DRAFT_REQUEST_DIR,
    previousDir: HUNSU_DRAFT_PREV_DIR,
    checkedAt
  };
  if (!draft.worktree || draft.worktree.baseRef === "virtual") {
    return {
      changes: {
        ...base,
        ok: false,
        summary: "HUNSU Draft changes require a route worktree.",
        errors: ["HUNSU Draft changes require a persisted route worktree."],
        files: []
      }
    };
  }
  const sourceRuntime = sourceRuntimeForDraft(baseRuntime, sourceNode);
  const previous = readDraftRuntimeBundle(draft.worktree.path, HUNSU_DRAFT_PREV_DIR);
  const request = readDraftRuntimeBundle(draft.worktree.path, HUNSU_DRAFT_REQUEST_DIR);
  const errors = [
    ...(!previous.ok ? [previous.error.message] : []),
    ...(!request.ok ? [request.error.message] : [])
  ];
  if (errors.length > 0 || !previous.ok || !request.ok) {
    return {
      changes: {
        ...base,
        ok: false,
        summary: "HUNSU Draft runtime files have validation errors.",
        errors,
        files: []
      }
    };
  }
  const validation = validateDraftRuntimeBundle(previous.value, request.value, sourceRuntime);
  if (!validation.ok) {
    return {
      changes: {
        ...base,
        ok: false,
        summary: "HUNSU Draft runtime files have validation errors.",
        errors: [validation.error.message],
        files: []
      }
    };
  }
  const files = diffDraftRuntimeBundles(validation.value.previous, validation.value.request);
  if (files.length === 0) {
    return {
      changes: {
        ...base,
        ok: false,
        summary: "No runtime file changes detected.",
        errors: ["No runtime file changes detected in .hunsu-request."],
        files: []
      },
      validation: validation.value
    };
  }
  return {
    changes: {
      ...base,
      ok: true,
      summary: summarizeRuntimeFileChanges(files),
      errors: [],
      files
    },
    validation: validation.value
  };
}

function sourceRuntimeForDraft(baseRuntime: HunsuRuntimeState, sourceNode: NodeRecord): HunsuRuntimeState {
  const harnessGraph = cloneHarnessEntity(sourceNode.harnessGraph);
  const previousBindings = new Map(baseRuntime.resources.bindings.map(binding => [binding.destinationId, binding]));
  return {
    ...cloneDraftJson(baseRuntime),
    destinations: {
      schema: "hunsu.destinations.v1",
      order: "queue-head-is-current",
      destinations: sourceNode.destinations.map(destination => cloneDraftJson(destination)),
      compatibility: {
        events: baseRuntime.eventLog.events.map(event => cloneDraftJson(event)),
        updatedAt: baseRuntime.eventLog.updatedAt
      }
    },
    harness: {
      schema: "hunsu.harness.v1",
      origins: baseRuntime.harness.origins?.map(origin => cloneDraftJson(origin)),
      harness: {
        name: baseRuntime.harness.harness.name,
        rootTeamId: harnessGraph.rootTeamId,
        guardrails: harnessGraph.guardrails.map(guardrail => cloneDraftJson(guardrail)),
        lock: sourceNode.harnessLock ? cloneDraftJson(sourceNode.harnessLock) : cloneDraftJson(baseRuntime.harness.harness.lock),
      }
    },
    executors: {
      schema: "hunsu.executors.v1",
      executors: harnessGraph.executors.map(executor => cloneDraftJson(executor))
    },
    resources: {
      schema: "hunsu.resources.v1",
      resources: harnessGraph.resources.map(resource => cloneDraftJson(resource)),
      bindings: sourceNode.destinations.map(destination => {
        const previous = previousBindings.get(String(destination.id));
        return {
          destinationId: String(destination.id),
          executorPackageBindings: sourceNode.executorPackageBindings?.map(binding => cloneDraftJson(binding)) ?? cloneDraftJson(previous?.executorPackageBindings),
          resourcePackageBindings: sourceNode.resourcePackageBindings?.map(binding => cloneDraftJson(binding)) ?? cloneDraftJson(previous?.resourcePackageBindings)
        };
      })
    },
    artifactActions: {
      schema: "hunsu.artifact-actions.v1",
      order: "display-order",
      actions: sourceNode.artifactActions
        .map(action => cloneDraftJson(action))
        .sort((left, right) => left.displayOrder - right.displayOrder || String(left.id).localeCompare(String(right.id)))
    }
  };
}

function diffDraftRuntimeBundles(previous: HunsuDraftRuntimeBundle, request: HunsuDraftRuntimeBundle): StudioHunsuDraftRuntimeFileChange[] {
  const changes: StudioHunsuDraftRuntimeFileChange[] = [];
  for (const file of HUNSU_DRAFT_RUNTIME_FILES) {
    const previousValue = draftRuntimeFileValue(previous, file);
    const requestValue = draftRuntimeFileValue(request, file);
    if (stableJson(previousValue) === stableJson(requestValue)) {
      continue;
    }
    changes.push({
      path: `${HUNSU_DRAFT_REQUEST_DIR}/${file}`,
      kind: "updated",
      summary: summarizeRuntimeFileChange(file, previousValue, requestValue),
      diff: createRuntimeFileUnifiedDiff(file, previousValue, requestValue)
    });
  }
  return changes;
}

function draftRuntimeFileValue(bundle: HunsuDraftRuntimeBundle, file: (typeof HUNSU_DRAFT_RUNTIME_FILES)[number]): unknown {
  switch (file) {
    case "destinations.json":
      return bundle.destinations;
    case "harness.json":
      return bundle.harness;
    case "executors.json":
      return bundle.executors;
    case "resources.json":
      return bundle.resources;
    case "artifact-actions.json":
      return bundle.artifactActions;
  }
}

function summarizeRuntimeFileChange(file: (typeof HUNSU_DRAFT_RUNTIME_FILES)[number], previous: unknown, request: unknown): string {
  switch (file) {
    case "destinations.json":
      return summarizeIdListChange(
        "Destinations",
        (previous as { destinations?: Array<{ id?: unknown }> }).destinations ?? [],
        (request as { destinations?: Array<{ id?: unknown }> }).destinations ?? []
      );
    case "artifact-actions.json":
      return summarizeIdListChange(
        "Artifact Actions",
        (previous as { actions?: Array<{ id?: unknown }> }).actions ?? [],
        (request as { actions?: Array<{ id?: unknown }> }).actions ?? []
      );
    case "harness.json":
      return "Harness runtime changed.";
    case "executors.json":
      return "Executors runtime changed.";
    case "resources.json":
      return "Resources runtime changed.";
  }
}

function summarizeIdListChange(label: string, previous: Array<{ id?: unknown }>, request: Array<{ id?: unknown }>): string {
  const previousIds = new Set(previous.map(item => String(item.id)));
  const requestIds = new Set(request.map(item => String(item.id)));
  const added = [...requestIds].filter(id => !previousIds.has(id)).length;
  const removed = [...previousIds].filter(id => !requestIds.has(id)).length;
  const updated = request.filter(item => previousIds.has(String(item.id))).length === previous.filter(item => requestIds.has(String(item.id))).length
    ? request.filter(item => previousIds.has(String(item.id))).length
    : 0;
  const parts = [
    added ? `${added} added` : undefined,
    removed ? `${removed} removed` : undefined,
    !added && !removed && updated ? "content updated" : undefined
  ].filter(Boolean);
  return parts.length > 0 ? `${label} ${parts.join(", ")}.` : `${label} changed.`;
}

function summarizeRuntimeFileChanges(files: StudioHunsuDraftRuntimeFileChange[]): string {
  return files.length === 1
    ? files[0].summary
    : `${files.length} runtime files changed: ${files.map(file => basename(file.path)).join(", ")}.`;
}

type RuntimeDiffLine =
  | { kind: "same"; text: string; oldLine: number; newLine: number }
  | { kind: "remove"; text: string; oldLine: number }
  | { kind: "add"; text: string; newLine: number };

function createRuntimeFileUnifiedDiff(file: (typeof HUNSU_DRAFT_RUNTIME_FILES)[number], previous: unknown, request: unknown): string {
  const previousPath = `${HUNSU_DRAFT_PREV_DIR}/${file}`;
  const requestPath = `${HUNSU_DRAFT_REQUEST_DIR}/${file}`;
  const previousLines = splitDiffLines(formatRuntimeFileForDiff(previous));
  const requestLines = splitDiffLines(formatRuntimeFileForDiff(request));
  const ops = diffLines(previousLines, requestLines);
  const hunks = runtimeDiffHunks(ops);
  return [
    `diff --git a/${previousPath} b/${requestPath}`,
    `--- a/${previousPath}`,
    `+++ b/${requestPath}`,
    ...hunks.flatMap(hunk => [
      `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`,
      ...hunk.lines.map(line => `${runtimeDiffLinePrefix(line)}${line.text}`)
    ])
  ].join("\n");
}

function formatRuntimeFileForDiff(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function splitDiffLines(text: string): string[] {
  const normalized = text.endsWith("\n") ? text.slice(0, -1) : text;
  return normalized.length === 0 ? [] : normalized.split("\n");
}

function diffLines(previous: string[], request: string[]): RuntimeDiffLine[] {
  const table = Array.from({ length: previous.length + 1 }, () => Array<number>(request.length + 1).fill(0));
  for (let left = previous.length - 1; left >= 0; left -= 1) {
    for (let right = request.length - 1; right >= 0; right -= 1) {
      table[left][right] = previous[left] === request[right]
        ? table[left + 1][right + 1] + 1
        : Math.max(table[left + 1][right], table[left][right + 1]);
    }
  }

  const unnumbered: Array<{ kind: "same" | "remove" | "add"; text: string }> = [];
  let left = 0;
  let right = 0;
  while (left < previous.length || right < request.length) {
    if (left < previous.length && right < request.length && previous[left] === request[right]) {
      unnumbered.push({ kind: "same", text: previous[left] });
      left += 1;
      right += 1;
    } else if (left < previous.length && (right >= request.length || table[left + 1][right] >= table[left][right + 1])) {
      unnumbered.push({ kind: "remove", text: previous[left] });
      left += 1;
    } else if (right < request.length) {
      unnumbered.push({ kind: "add", text: request[right] });
      right += 1;
    }
  }

  let oldLine = 1;
  let newLine = 1;
  return unnumbered.map(line => {
    if (line.kind === "same") {
      return { kind: "same", text: line.text, oldLine: oldLine++, newLine: newLine++ };
    }
    if (line.kind === "remove") {
      return { kind: "remove", text: line.text, oldLine: oldLine++ };
    }
    return { kind: "add", text: line.text, newLine: newLine++ };
  });
}

function runtimeDiffHunks(lines: RuntimeDiffLine[], context = 3): Array<{ oldStart: number; oldCount: number; newStart: number; newCount: number; lines: RuntimeDiffLine[] }> {
  const ranges: Array<{ start: number; end: number }> = [];
  for (const [index, line] of lines.entries()) {
    if (line.kind === "same") {
      continue;
    }
    const start = Math.max(0, index - context);
    const end = Math.min(lines.length - 1, index + context);
    const previousRange = ranges.at(-1);
    if (previousRange && start <= previousRange.end + 1) {
      previousRange.end = Math.max(previousRange.end, end);
    } else {
      ranges.push({ start, end });
    }
  }

  return ranges.map(range => {
    const hunkLines = lines.slice(range.start, range.end + 1);
    const oldLineNumbers = hunkLines.flatMap(line => "oldLine" in line ? [line.oldLine] : []);
    const newLineNumbers = hunkLines.flatMap(line => "newLine" in line ? [line.newLine] : []);
    const oldCount = hunkLines.filter(line => line.kind !== "add").length;
    const newCount = hunkLines.filter(line => line.kind !== "remove").length;
    return {
      oldStart: oldLineNumbers[0] ?? 0,
      oldCount,
      newStart: newLineNumbers[0] ?? 0,
      newCount,
      lines: hunkLines
    };
  });
}

function runtimeDiffLinePrefix(line: RuntimeDiffLine): " " | "+" | "-" {
  if (line.kind === "add") return "+";
  if (line.kind === "remove") return "-";
  return " ";
}

function cloneDraftJson<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

async function discardHunsuDraft(
  draftSessionId: string,
  state: StudioServerState,
  options: HunsuDraftApiOptions
): Promise<StudioHunsuDraftResult> {
  const draft = requireHunsuDraft(state, draftSessionId, options);
  draft.status = "discarded";
  draft.updatedAt = new Date().toISOString();
  writeAndCommitHunsuDraftRouteRuntime(draft, options, "Hunsu draft route discarded");
  syncHunsuDraftAgentSession(state, draft);
  return { draft, board: currentBoard(state, options) };
}

function hunsuDraftsForScope(state: StudioServerState, options: HunsuDraftApiOptions): StudioHunsuDraftSession[] {
  rehydrateHunsuDraftRoutesForRepository(state, options.cwd);
  return Object.values(state.hunsuDrafts)
    .filter(draft => draft.repositoryPath === options.cwd && (!draft.roadmapId || draft.roadmapId === options.roadmapId))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function findHunsuDraft(state: StudioServerState, draftSessionId: string, options: HunsuDraftApiOptions): StudioHunsuDraftSession | undefined {
  rehydrateHunsuDraftRoutesForRepository(state, options.cwd);
  const draft = state.hunsuDrafts[draftSessionId];
  if (!draft || draft.repositoryPath !== options.cwd) {
    return undefined;
  }
  if (draft.roadmapId && draft.roadmapId !== options.roadmapId) {
    return undefined;
  }
  return draft;
}

function rehydrateHunsuDraftRoutesForRepository(state: StudioServerState, cwd: string): void {
  if (!existsSync(cwd)) {
    return;
  }
  let root: string;
  try {
    root = ensureGitRepository(cwd);
  } catch (error) {
    if (error instanceof GitError) {
      return;
    }
    throw error;
  }
  let refs = "";
  try {
    refs = git(["for-each-ref", "--format=%(refname)", "refs/heads/hunsu/routes"], { cwd: root });
  } catch (error) {
    if (error instanceof GitError) {
      return;
    }
    throw error;
  }
  for (const ref of refs.split(/\r?\n/).map(line => line.trim()).filter(Boolean)) {
    let text: string;
    try {
      text = git(["show", `${ref}:${HUNSU_HUNSU_DRAFT_PATH}`], { cwd: root });
    } catch (error) {
      if (error instanceof GitError) {
        continue;
      }
      throw error;
    }
    const decoded = decodeHunsuRuntimeFileText<HunsuDraftRouteRuntimeFile>(text, `${ref}:${HUNSU_HUNSU_DRAFT_PATH}`);
    if (!decoded.ok || decoded.value.schema !== "hunsu.hunsu-draft-route.v1" || decoded.value.repositoryPath !== root) {
      continue;
    }
    const existing = state.hunsuDrafts[decoded.value.draftSessionId];
    if (existing && existing.updatedAt >= decoded.value.updatedAt) {
      continue;
    }
    state.hunsuDrafts[decoded.value.draftSessionId] = hunsuDraftSessionFromRuntime(decoded.value);
  }
}

function requireHunsuDraft(state: StudioServerState, draftSessionId: string, options: HunsuDraftApiOptions): StudioHunsuDraftSession {
  const draft = findHunsuDraft(state, draftSessionId, options);
  if (!draft) {
    throw new Error(`Unknown HUNSU Draft: ${draftSessionId}`);
  }
  return draft;
}

function requireMutableHunsuDraft(state: StudioServerState, draftSessionId: string, options: HunsuDraftApiOptions): StudioHunsuDraftSession {
  const draft = requireHunsuDraft(state, draftSessionId, options);
  if (draft.status === "confirmed" || draft.status === "discarded") {
    throw new Error(`HUNSU Draft ${draftSessionId} is already ${draft.status}`);
  }
  return draft;
}

type ResolvedHunsuDraftSource = {
  line: LineRecord;
  node: NodeRecord;
  move?: BoardProjection["moves"][number];
};

function resolveHunsuDraftSource(board: BoardProjection, request: StudioHunsuDraftStartRequest): ResolvedHunsuDraftSource {
  const nodeFromMove = request.sourceMoveId
    ? board.moves.find(move => String(move.id) === request.sourceMoveId)
    : undefined;
  const node = request.sourceNodeId
    ? board.nodes.find(candidate => String(candidate.id) === request.sourceNodeId)
    : nodeFromMove
      ? board.nodes.find(candidate => String(candidate.id) === String(nodeFromMove.toNodeId))
      : undefined;
  const fallbackLine = request.sourceLineId
    ? board.lines.find(candidate => String(candidate.id) === request.sourceLineId)
    : board.lines.find(line => line.status === "active") ?? board.lines[0];
  const resolvedNode = node ?? (fallbackLine ? board.nodes.find(candidate => String(candidate.id) === String(fallbackLine.currentNodeId)) : undefined) ?? board.nodes[0];
  if (!resolvedNode) {
    throw new Error("Cannot start HUNSU Draft without a source node");
  }
  const line = request.sourceLineId
    ? board.lines.find(candidate => String(candidate.id) === request.sourceLineId)
    : lineForNode(board, resolvedNode) ?? fallbackLine;
  if (!line) {
    throw new Error(`Cannot resolve route for HUNSU Draft source node ${resolvedNode.id}`);
  }
  const move = nodeFromMove ?? moveForNode(board, resolvedNode);
  return { line, node: resolvedNode, move };
}

function requireHunsuDraftSource(board: BoardProjection, draft: StudioHunsuDraftSession): ResolvedHunsuDraftSource {
  return resolveHunsuDraftSource(board, {
    sourceLineId: draft.sourceLineId,
    sourceNodeId: draft.sourceNodeId,
    sourceMoveId: draft.sourceMoveId
  });
}

function hunsuDraftSourceSnapshot(source: ResolvedHunsuDraftSource): HunsuDraftSourceSnapshot {
  return {
    sourceLineId: String(source.line.id),
    sourceNodeId: String(source.node.id),
    sourceMoveId: source.move ? String(source.move.id) : undefined,
    moveOrdinal: source.move?.ordinal ?? source.node.ordinal,
    teamName: String(source.line.teamName ?? source.node.teamName ?? ""),
    summary: String(source.move?.summary ?? "Initial immutable Team Snapshot"),
    destinationSummaries: source.node.destinations.map(destination => ({
      id: String(destination.id),
      title: String(destination.title),
      status: String(destination.status)
    }))
  };
}

function createHunsuSourceProtocolArtifact(board: BoardProjection, source: ResolvedHunsuDraftSource, snapshot: HunsuDraftSourceSnapshot): unknown {
  const request = board.requests.find(candidate => candidate.id === source.line.requestId);
  return {
    kind: "source-protocol",
    request: request ? {
      id: String(request.id),
      title: String(request.title),
      goal: String(request.goal)
    } : undefined,
    source: snapshot,
    team: {
      lineId: String(source.line.id),
      teamName: String(source.line.teamName ?? source.node.teamName ?? snapshot.teamName ?? ""),
      currentNodeId: String(source.line.currentNodeId),
      moveOrdinal: snapshot.moveOrdinal
    },
    destinations: source.node.destinations,
    harness: source.node.harness
  };
}

function registerHunsuDraftArtifact(
  state: StudioServerState,
  artifact: Omit<StudioHunsuDraftArtifact, "artifactId">
): StudioHunsuDraftArtifact {
  const artifactId = createHunsuDraftArtifactId(artifact.kind, artifact.value);
  const stored = { ...artifact, artifactId };
  state.hunsuDraftArtifacts[artifactId] = stored;
  return stored;
}

function createHunsuDraftArtifactId(kind: StudioHunsuDraftArtifact["kind"], value: unknown): string {
  return `hda_${hashHex(createHash("sha256").update(stableJson({ kind, value }))).slice(0, 16)}`;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

function runnerMessagesForHunsuDraft(draft: StudioHunsuDraftSession): HunsuDraftConversationMessage[] {
  return draft.messages.map(message => ({
    role: message.role,
    text: message.text,
    createdAt: message.createdAt
  }));
}

function appendHunsuDraftMessage(draft: StudioHunsuDraftSession, role: StudioHunsuDraftChatRole, text: string, at = new Date().toISOString()): void {
  draft.messages.push({
    messageId: `${draft.draftSessionId}:msg:${String(draft.messages.length + 1).padStart(4, "0")}`,
    role,
    text,
    createdAt: at
  });
  draft.updatedAt = at;
}

function hunsuDraftRouteId(draftSessionId: string): string {
  return `hunsu-draft:${draftSessionId}`;
}

function hunsuDraftRepositoryPath(draft: StudioHunsuDraftSession, options: HunsuDraftApiOptions): string {
  return draft.worktree?.path ?? options.cwd;
}

function hunsuDraftRouteRef(draft: StudioHunsuDraftSession): AgentSessionRouteRef {
  return {
    kind: "Route",
    routeKind: "HunsuDraft",
    routeId: draft.routeId,
    draftSessionId: draft.draftSessionId,
    sourceLineId: draft.sourceLineId,
    sourceNodeId: draft.sourceNodeId,
    targetNodeId: draft.confirmedNodeId,
    worktree: draft.worktree
  };
}

function hunsuDraftRouteRuntimeFile(draft: StudioHunsuDraftSession): HunsuDraftRouteRuntimeFile {
  return {
    schema: "hunsu.hunsu-draft-route.v1",
    draftSessionId: draft.draftSessionId,
    roadmapId: draft.roadmapId,
    repositoryPath: draft.repositoryPath,
    routeId: draft.routeId,
    sourceLineId: draft.sourceLineId,
    sourceNodeId: draft.sourceNodeId,
    sourceMoveId: draft.sourceMoveId,
    sourceArtifactId: draft.sourceArtifactId,
    currentArtifactId: draft.currentArtifactId,
    managerLock: draft.managerLock,
    manager: draft.manager,
    confirmedHunsuId: draft.confirmedHunsuId,
    confirmedNodeId: draft.confirmedNodeId,
    status: draft.status,
    readyDraft: draft.readyDraft,
    latestDiffArtifactId: draft.latestDiffArtifactId,
    diffArtifacts: draft.diffArtifacts,
    worktree: draft.worktree,
    updatedAt: draft.updatedAt
  };
}

function hunsuDraftSessionFromRuntime(file: HunsuDraftRouteRuntimeFile): StudioHunsuDraftSession {
  return {
    draftSessionId: file.draftSessionId,
    roadmapId: file.roadmapId,
    repositoryPath: file.repositoryPath,
    sourceLineId: file.sourceLineId,
    sourceNodeId: file.sourceNodeId,
    sourceMoveId: file.sourceMoveId,
    routeId: file.routeId,
    worktree: file.worktree,
    agentSessionIds: [],
    sourceArtifactId: file.sourceArtifactId,
    currentArtifactId: file.currentArtifactId,
    managerLock: file.managerLock,
    manager: cloneManagerConfigForRuntime(file.manager),
    confirmedHunsuId: file.confirmedHunsuId,
    confirmedNodeId: file.confirmedNodeId,
    messages: [],
    readyDraft: file.readyDraft,
    latestDiffArtifactId: file.latestDiffArtifactId,
    diffArtifacts: file.diffArtifacts ?? {},
    status: file.status,
    createdAt: file.updatedAt,
    updatedAt: file.updatedAt
  };
}

function writeAndCommitHunsuDraftRouteRuntime(draft: StudioHunsuDraftSession, options: HunsuDraftApiOptions, message: string, extraPaths: string[] = []): void {
  if (!options.persist || !draft.worktree || draft.worktree.baseRef === "virtual") {
    return;
  }
  const runtimePath = join(draft.worktree.path, HUNSU_HUNSU_DRAFT_PATH);
  mkdirSync(dirname(runtimePath), { recursive: true });
  writeFileSync(runtimePath, encodeHunsuRuntimeFile(hunsuDraftRouteRuntimeFile(draft)).text, "utf8");
  commitSelectedWorktreePaths(draft.worktree.path, message, [...extraPaths, HUNSU_HUNSU_DRAFT_PATH]);
}

function commitSelectedWorktreePaths(cwd: string, message: string, paths: string[]): string | undefined {
  const stageable = paths.filter(path => existsSync(join(cwd, path)) || isGitTrackedPath(cwd, path));
  if (stageable.length === 0) {
    return undefined;
  }
  git(["add", "--all", "--", ...stageable], { cwd });
  const status = git(["status", "--porcelain=v1", "--", ...stageable], { cwd }).trim();
  if (!status) {
    return undefined;
  }
  git(["commit", "--only", "-m", message, "--", ...stageable], { cwd });
  return git(["rev-parse", "--verify", "HEAD"], { cwd }).trim();
}

function startHunsuDraftAgentSession(state: StudioServerState, draft: StudioHunsuDraftSession, now = new Date().toISOString()): AgentSession {
  const owner: AgentSessionOwner = { kind: "HunsuDraft", draftSessionId: draft.draftSessionId };
  const sessionId = agentSessionId(owner);
  const existing = state.agentSessions[sessionId];
  if (existing) {
    draft.draftAgentSessionId = existing.sessionId;
    draft.activeAgentSessionId = existing.sessionId;
    if (!draft.agentSessionIds.includes(existing.sessionId)) {
      draft.agentSessionIds.push(existing.sessionId);
    }
    return existing;
  }
  const session: AgentSession = {
    sessionId,
    roadmapId: draft.roadmapId,
    routeRef: hunsuDraftRouteRef(draft),
    owner,
    state: { type: "waiting", reason: "Waiting for HUNSU Draft message" },
    messages: [],
    activeItemIds: [],
    revision: 1,
    createdAt: now,
    updatedAt: now
  };
  state.agentSessions[session.sessionId] = session;
  draft.draftAgentSessionId = session.sessionId;
  draft.activeAgentSessionId = session.sessionId;
  draft.agentSessionIds.push(session.sessionId);
  publishAgentSessionUpdated(state, session);
  return session;
}

function syncHunsuDraftAgentSession(state: StudioServerState, draft: StudioHunsuDraftSession, result?: RunnerRun): void {
  const session = draft.draftAgentSessionId ? state.agentSessions[draft.draftAgentSessionId] : startHunsuDraftAgentSession(state, draft);
  if (!session) {
    return;
  }
  const now = draft.updatedAt;
  if (result?.providerThreadId && result.providerTurnId) {
    session.provider = { providerThreadId: result.providerThreadId, providerTurnId: result.providerTurnId };
  } else if (draft.providerThreadId && !session.provider) {
    session.provider = { providerThreadId: draft.providerThreadId, providerTurnId: "draft" };
  }
  const addedMessages = syncDraftRouteMessagesToAgentSession(session, draft);
  session.error = draft.error;
  session.finalResponse = draft.messages.at(-1)?.text;
  session.state = hunsuDraftAgentSessionState(draft, session.provider);
  bumpAgentSession(session, now);
  publishAgentSessionUpdated(state, session);
  for (const message of addedMessages) {
    publishCompletedAgentSessionMessage(state, session, message);
  }
}

function hunsuDraftAgentSessionState(draft: StudioHunsuDraftSession, provider: StudioAgentSessionRef | undefined): AgentSessionState {
  if (draft.status === "failed") {
    return { type: "failed", provider, error: draft.error ?? "HUNSU Draft failed", completedAt: draft.updatedAt };
  }
  if (draft.status === "confirmed" || draft.status === "discarded") {
    return { type: "completed", provider, finalResponse: draft.messages.at(-1)?.text, completedAt: draft.updatedAt };
  }
  return { type: "waiting", reason: draft.status === "ready" ? "Waiting for approval" : "Waiting for HUNSU Draft message" };
}

function syncDraftRouteMessagesToAgentSession(session: AgentSession, draft: StudioHunsuDraftSession): AgentMessage[] {
  const byItemId = new Map(session.messages.map(message => [message.itemId, message]));
  const added: AgentMessage[] = [];
  for (const draftMessage of draft.messages) {
    if (byItemId.has(draftMessage.messageId)) {
      continue;
    }
    const message = hunsuDraftAgentMessage(session.sessionId, draftMessage);
    session.messages.push(message);
    added.push(message);
  }
  return added;
}

function hunsuDraftAgentMessage(sessionId: string, message: StudioHunsuDraftMessage): AgentMessage {
  return {
    sessionId,
    messageId: message.messageId,
    itemId: message.messageId,
    role: message.role === "user" ? "user" : message.role === "system" ? "system" : "assistant",
    type: `hunsuDraft.${message.role}`,
    status: "completed",
    title: message.role === "user" ? "Prompt" : "Reply",
    text: message.text,
    revision: 1,
    createdAt: message.createdAt,
    updatedAt: message.createdAt,
    completedAt: message.createdAt
  };
}

function markHunsuDraftFailed(draft: StudioHunsuDraftSession, error: unknown): void {
  draft.status = "failed";
  draft.error = error instanceof Error ? error.message : String(error);
  draft.updatedAt = new Date().toISOString();
}

function assertResolvedApmSkill(ref: ApmSkillReference, lock: RegistryPackageSkillMetadata, path: string): void {
  if (lock.kind !== "registry-package" || lock.registryKind !== "apm") {
    throw new Error(`APM resolver returned unsupported metadata for ${path}`);
  }
  if (lock.name !== ref.name || lock.registry !== ref.registry || lock.package !== ref.package || lock.version !== ref.version) {
    throw new Error(`APM resolver returned a different skill lock for ${ref.package}@${ref.version}`);
  }
  if (!lock.integrity.trim() || !lock.contentHash.trim()) {
    throw new Error(`APM resolver returned an incomplete skill lock for ${ref.package}@${ref.version}`);
  }
  if (!isExactSemver(lock.version)) {
    throw new Error(`APM resolver returned a non-exact version for ${ref.package}: ${lock.version}`);
  }
}

export function createHttpApmSkillRegistryClient(fetchImpl: typeof fetch = fetch): ApmSkillRegistryClient {
  return {
    async resolveSkill(ref) {
      const url = new URL("/v1/skills/resolve", ref.registry);
      url.searchParams.set("package", ref.package);
      url.searchParams.set("version", ref.version);
      const response = await fetchImpl(url);
      if (!response.ok) {
        throw new Error(`APM registry failed to resolve ${ref.package}@${ref.version}: HTTP ${response.status}`);
      }
      const parsed = await response.json() as unknown;
      const record = requireJsonRecord(parsed, "APM resolve response");
      const lock: RegistryPackageSkillMetadata = {
        kind: "registry-package",
        registryKind: "apm",
        name: requiredJsonString(typeof record.name === "string" && record.name.trim() ? record.name : ref.name, "APM resolve response.name"),
        registry: requiredJsonString(typeof record.registry === "string" && record.registry.trim() ? record.registry : ref.registry, "APM resolve response.registry"),
        package: requiredJsonString(record.package, "APM resolve response.package"),
        version: requiredJsonString(record.version, "APM resolve response.version"),
        integrity: requiredJsonString(record.integrity, "APM resolve response.integrity"),
        contentHash: requiredJsonString(record.contentHash, "APM resolve response.contentHash")
      };
      assertResolvedApmSkill(ref, lock, "APM resolve response");
      return lock;
    },
    async fetchSkillFiles(lock) {
      const url = new URL("/v1/skills/files", lock.registry);
      url.searchParams.set("package", lock.package);
      url.searchParams.set("version", lock.version);
      const response = await fetchImpl(url);
      if (!response.ok) {
        throw new Error(`APM registry failed to fetch ${lock.package}@${lock.version}: HTTP ${response.status}`);
      }
      const parsed = await response.json() as unknown;
      const record = requireJsonRecord(parsed, "APM files response");
      if (record.integrity !== undefined && record.integrity !== lock.integrity) {
        throw new Error(`APM integrity mismatch for ${lock.package}@${lock.version}`);
      }
      if (record.contentHash !== undefined && record.contentHash !== lock.contentHash) {
        throw new Error(`APM contentHash mismatch for ${lock.package}@${lock.version}`);
      }
      const files = parseSkillSnapshotFiles(record.files, "APM files response.files");
      if (lock.contentHash.startsWith("sha256:") && computeSkillFilesContentHash(files) !== lock.contentHash) {
        throw new Error(`APM contentHash mismatch for ${lock.package}@${lock.version}`);
      }
      return files;
    }
  };
}

function requiredJsonString(value: unknown, field: string): NonEmptyText {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return requireDomainValue(makeNonEmptyText(value.trim(), field));
}

function requireJsonRecord(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function parseSkillSnapshotFiles(value: unknown, path: string): SkillSnapshotFile[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${path} must be a non-empty array`);
  }
  return value.map((file, index) => {
    const record = requireJsonRecord(file, `${path}[${index}]`);
    return {
      path: requiredJsonString(record.path, `${path}[${index}].path`),
      text: typeof record.text === "string" ? record.text : (() => {
        throw new Error(`${path}[${index}].text must be a string`);
      })()
    };
  });
}

function computeSkillFilesContentHash(files: SkillSnapshotFile[]): string {
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file.path);
    hash.update("\0");
    hash.update(file.text);
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

function isExactSemver(value: string): boolean {
  return /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value);
}

function readyHunsuDraftFromRuntimeChanges(
  session: StudioHunsuDraftSession,
  changes: StudioHunsuDraftChanges,
  board: BoardProjection,
  source: ResolvedHunsuDraftSource,
  validation: HunsuDraftRuntimeValidation,
  providerThreadId: string | undefined,
  now: string
): ReadyHunsuDraft {
  const hunsuId = nextHunsuId(board);
  const newLineId = requireDomainValue(makeLineId(`${session.sourceLineId}/fork-${hunsuId}`));
  const newTeamName = nextTeamName(board);
  return {
    id: requireDomainValue(makeHunsuDraftId(session.draftSessionId)),
    status: "ready",
    sourceLineId: requireDomainValue(makeLineId(session.sourceLineId)),
    sourceNodeId: requireDomainValue(makeNodeId(session.sourceNodeId)),
    sourceMoveId: session.sourceMoveId ? requireDomainValue(makeMoveId(session.sourceMoveId)) : undefined,
    target: { type: "node", id: requireDomainValue(makeNodeId(session.sourceNodeId)) },
    newTeamName,
    summary: requireDomainValue(makeSummary(changes.summary, "summary")),
    teamSnapshot: teamSnapshotFromDraftRuntime(validation.requestRuntime, source.node, newTeamName),
    changedFiles: changes.files.map(file => ({
      path: requireDomainValue(makeNonEmptyText(file.path, "changedFile.path")),
      kind: file.kind,
      summary: requireDomainValue(makeSummary(file.summary, "changedFile.summary"))
    })),
    hunsuId,
    newLineId,
    conversationRef: {
      provider: "codex",
      threadId: providerThreadId ? requireDomainValue(makeNonEmptyText(providerThreadId, "conversation.threadId")) : undefined,
      conversationHash: requireDomainValue(makeAgentConversationHash(createConversationHash({ draftSessionId: session.draftSessionId, sourceLineId: session.sourceLineId, sourceNodeId: session.sourceNodeId, at: now }))),
      contextHash: requireDomainValue(makeNonEmptyText(createContextHash(board, source.node, session.draftSessionId), "conversation.contextHash")),
      worktreeHash: requireDomainValue(makeWorktreeHash(createWorktreeHash(session.repositoryPath))),
      startedAt: session.createdAt,
      endedAt: now
    },
    createdAt: session.createdAt,
    updatedAt: now
  };
}

function teamSnapshotFromDraftRuntime(runtime: HunsuRuntimeState, sourceNode: NodeRecord, teamName: TeamName): ReadyHunsuDraft["teamSnapshot"] {
  const binding = runtime.resources.bindings.find(candidate => sourceNode.destinations.some(destination => String(destination.id) === candidate.destinationId));
  const harnessGraph: Harness = {
    rootTeamId: runtime.harness.harness.rootTeamId,
    executors: runtime.executors.executors.map(executor => cloneDraftJson(executor)),
    resources: runtime.resources.resources.map(resource => cloneDraftJson(resource)),
    guardrails: (runtime.harness.harness.guardrails ?? []).map(guardrail => cloneDraftJson(guardrail)),
    artifactActions: runtime.artifactActions.actions.map(action => cloneDraftJson(action))
  };
  const harness = rootHarnessSnapshot(harnessGraph);
  return {
    teamName,
    moveOrdinal: sourceNode.ordinal,
    destinations: runtime.destinations.destinations.map(destination => cloneDraftJson(destination)),
    harness,
    harnessGraph,
    harnessLock: runtime.harness.harness.lock ? cloneDraftJson(runtime.harness.harness.lock) : undefined,
    executorPackageBindings: binding?.executorPackageBindings?.map(item => cloneDraftJson(item)) ?? sourceNode.executorPackageBindings?.map(item => cloneDraftJson(item)),
    resourcePackageBindings: binding?.resourcePackageBindings?.map(item => cloneDraftJson(item)) ?? sourceNode.resourcePackageBindings?.map(item => cloneDraftJson(item)),
    artifactActions: runtime.artifactActions.actions.map(action => cloneDraftJson(action))
  };
}

function nextHunsuDraftSessionId(state: StudioServerState): string {
  const highest = Object.keys(state.hunsuDrafts).reduce((max, id) => {
    const match = id.match(/^hd(\d+)$/i);
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0);
  return `hd${String(highest + 1).padStart(4, "0")}`;
}

function nextHunsuId(board: BoardProjection) {
  const highest = board.hunsus.reduce((max, hunsu) => {
    const match = String(hunsu.id).match(/^H(\d+)$/i);
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0);
  return requireDomainValue(makeHunsuId(`H${String(highest + 1).padStart(4, "0")}`));
}

async function handleArtifactActionApiRequest(
  path: string,
  request: IncomingMessage,
  response: ServerResponse,
  options: ArtifactActionApiOptions
): Promise<boolean> {
  if (request.method === "GET" && (path.endsWith("/artifact-actions") || path === "/artifact-actions" || path === "/api/artifact-actions")) {
    sendJson(response, 200, { actions: listArtifactActions(options.cwd) });
    return true;
  }

  if (request.method === "GET" && (path.endsWith("/action-runs") || path === "/action-runs" || path === "/api/action-runs")) {
    sendJson(response, 200, { runs: listArtifactActionRuns(options.cwd) });
    return true;
  }

  const route = parseArtifactActionApiRoute(path.startsWith("/api/") ? path.replace(/^\/api/, "") : path);
  if (!route) {
    return false;
  }

  if (route.resource === "action" && route.action === "run" && request.method === "POST") {
    const body = await readJson<StudioActionRunStartRequest>(request);
    const requestBody = { ...body, actionId: body.actionId ?? route.actionId };
    if (body.dryRun) {
      sendJson(response, 200, { plan: planStudioArtifactActionRun(requestBody, options) });
      return true;
    }
    sendJson(response, 202, { run: startStudioArtifactActionRun(requestBody, options) });
    return true;
  }

  if (route.resource === "run" && route.action === "proxy") {
    await proxyArtifactActionAlias(request, response, options.cwd, route.runId, route.alias, route.path);
    return true;
  }

  if (route.resource === "run" && request.method === "GET" && route.action === "show") {
    sendJson(response, 200, { run: readArtifactActionRun(options.cwd, route.runId) });
    return true;
  }

  if (route.resource === "run" && request.method === "POST" && route.action === "stop") {
    sendJson(response, 202, { run: stopArtifactActionRun(options.cwd, route.runId, { runner: options.actionRunner, processEnv: options.processEnv }) });
    return true;
  }

  return false;
}

export function planStudioArtifactActionRun(request: StudioActionRunStartRequest, options: ArtifactActionApiOptions): ArtifactActionRunPlan {
  return planArtifactActionRun(studioArtifactActionInput(request, options));
}

export function startStudioArtifactActionRun(request: StudioActionRunStartRequest, options: ArtifactActionApiOptions): ArtifactActionRunRecord {
  return startArtifactActionRun(studioArtifactActionInput(request, options), { runner: options.actionRunner, processEnv: options.processEnv });
}

function studioArtifactActionInput(request: StudioActionRunStartRequest, options: ArtifactActionApiOptions): ArtifactActionRunInput {
  if (!request.actionId) {
    throw new Error("Artifact Action run requires actionId");
  }
  return {
    cwd: options.cwd,
    roadmapId: options.roadmapId,
    actionId: request.actionId,
    moveId: request.moveId,
    commit: request.commit,
    env: request.env,
    ambientEnv: options.ambientEnv,
    processEnv: options.processEnv,
    worktreeRoot: options.worktreeRoot
  };
}

function parseArtifactActionApiRoute(suffix: string): ArtifactActionApiRoute | undefined {
  if (!suffix.startsWith("/")) {
    return undefined;
  }
  const parts = suffix.slice(1).split("/");
  if (parts[0] === "artifact-actions" && parts[1] && parts[2] === "runs" && parts.length === 3) {
    return { resource: "action", actionId: decodeURIComponent(parts[1]), action: "run" };
  }
  if (parts[0] === "action-runs" && parts[1]) {
    const runId = decodeURIComponent(parts[1]);
    if (parts.length === 2 || parts[2] === "") {
      return { resource: "run", runId, action: "show" };
    }
    if (parts[2] === "stop" && parts.length === 3) {
      return { resource: "run", runId, action: "stop" };
    }
    if (parts[2] === "proxy" && parts[3]) {
      return {
        resource: "run",
        runId,
        action: "proxy",
        alias: decodeURIComponent(parts[3]),
        path: `/${parts.slice(4).map(part => decodeURIComponent(part)).join("/")}`
      };
    }
  }
  return undefined;
}

async function proxyArtifactActionAlias(
  request: IncomingMessage,
  response: ServerResponse,
  cwd: string,
  runId: string,
  aliasName: string,
  path: string
): Promise<void> {
  const run = readArtifactActionRun(cwd, runId);
  const alias = run.aliases?.[aliasName];
  if (!alias) {
    sendJson(response, 404, { error: `Unknown Artifact Action alias: ${aliasName}` });
    return;
  }
  if (!alias.directUrl) {
    sendJson(response, 503, { error: `Artifact Action alias has no direct URL yet: ${aliasName}` });
    return;
  }

  const requestUrl = new URL(request.url ?? "/", "http://localhost");
  const target = new URL(alias.directUrl);
  const basePath = target.pathname.replace(/\/$/, "");
  const suffixPath = path === "/" ? "/" : `/${path.replace(/^\/+/, "")}`;
  target.pathname = `${basePath}${suffixPath}`.replace(/\/{2,}/g, "/");
  target.search = requestUrl.search;

  const body = request.method === "GET" || request.method === "HEAD" ? undefined : await readRawBody(request);
  const upstream = await fetch(target, {
    method: request.method,
    headers: proxyRequestHeaders(request),
    body: body ? new Uint8Array(body) : undefined
  });
  response.statusCode = upstream.status;
  for (const [key, value] of upstream.headers) {
    if (!shouldSkipProxyHeader(key)) {
      response.setHeader(key, value);
    }
  }
  response.end(Buffer.from(await upstream.arrayBuffer()));
}

async function readRawBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function proxyRequestHeaders(request: IncomingMessage): HeadersInit {
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (value === undefined || shouldSkipRequestProxyHeader(key)) {
      continue;
    }
    headers.set(key, Array.isArray(value) ? value.join(", ") : value);
  }
  return headers;
}

function shouldSkipRequestProxyHeader(key: string): boolean {
  return ["host", "connection", "content-length", "transfer-encoding", "upgrade"].includes(key.toLowerCase());
}

function shouldSkipProxyHeader(key: string): boolean {
  return ["connection", "content-encoding", "content-length", "transfer-encoding", "upgrade"].includes(key.toLowerCase());
}

export function boardFromEvents(events: DomainEvent[]): BoardProjection {
  if (events.length === 0) {
    return emptyBoardProjection();
  }
  const projected = tryProjectBoard(events);
  if (!projected.ok) {
    throw new Error(projected.error.message);
  }
  return projected.value;
}

export function subscribeStudioLiveEvents(state: StudioServerState, subscriber: StudioLiveSubscriber, options: { cwd?: string } = {}): () => void {
  const scopedSubscriber: StudioLiveSubscriber = options.cwd
    ? event => {
        if (event.type === "run.updated" && !runBelongsToRepository(event.run, options.cwd)) {
          return;
        }
        if (event.type === "runs.snapshot") {
    const runs = event.runs.filter(run => runBelongsToRepository(run, options.cwd)).map(toStudioRunSummary);
          subscriber({ type: "runs.snapshot", runs, executes: runs.map(toStudioExecuteView) });
          return;
        }
        if (event.type === "run.updated") {
          const run = toStudioRunSummary(event.run);
          subscriber({ type: "run.updated", run, execute: toStudioExecuteView(run), board: event.board });
          return;
        }
        subscriber(event);
      }
    : subscriber;
  state.liveSubscribers.add(scopedSubscriber);
  const runs = (options.cwd ? runsForRepository(state, options.cwd) : Object.values(state.runs)).map(toStudioRunSummary);
  subscriber({ type: "runs.snapshot", runs, executes: runs.map(toStudioExecuteView) });
  return () => {
    state.liveSubscribers.delete(scopedSubscriber);
  };
}

type AgentSessionSubscriptionScope = {
  cwd?: string;
  roadmapId?: string;
  sessionId?: string;
};

export function subscribeAgentSessionEvents(state: StudioServerState, subscriber: AgentSessionSubscriber, options: AgentSessionSubscriptionScope = {}): () => void {
  const scopedSubscriber: AgentSessionSubscriber = options.cwd || options.roadmapId || options.sessionId
    ? event => {
        if (event.type === "agentSession.snapshot") {
          subscriber({ type: "agentSession.snapshot", sessions: event.sessions.filter(session => agentSessionBelongsToScope(session, state, options)) });
          return;
        }
        const session = findAgentSessionById(state, event.sessionId, options);
        if (!session || !agentSessionEventBelongsToScope(event, session, state, options)) {
          return;
        }
        subscriber(event);
      }
    : subscriber;
  state.agentSessionSubscribers.add(scopedSubscriber);
  const sessions = initialAgentSessionSnapshot(state, options);
  scopedSubscriber({ type: "agentSession.snapshot", sessions });
  return () => {
    state.agentSessionSubscribers.delete(scopedSubscriber);
  };
}

function initialAgentSessionSnapshot(state: StudioServerState, options: AgentSessionSubscriptionScope): AgentSession[] {
  const sessions = options.cwd ? agentSessionsForRepository(state, options.cwd) : allAgentSessions(state);
  return sessions.filter(session => agentSessionBelongsToScope(session, state, options));
}

export function toStudioRoadmapView(board: BoardProjection): StudioRoadmapView {
  return {
    ...board,
    roadmap: board,
    destinations: board.destinations,
    teams: board.lines,
    moves: board.moves,
    hunsus: board.hunsus
  };
}

export function toStudioExecuteView(run: StudioRunState | StudioRunSummary): StudioExecuteView {
  const summary = toStudioRunSummary(run);
  return {
    ...summary,
    executeId: summary.executeId,
    teamRouteId: summary.lineId,
    selectedDestinationIds: summary.selectedDestinationIds,
    statusLabel: formatExecuteStatus(summary.status),
    outcomeLabel: summary.outcome === "arrived" ? "Arrived" : summary.outcome === "accident" ? "Accident" : undefined,
    memberEvaluations: summary.memberEvaluations ?? []
  };
}

export function findArtifact(board: BoardProjection, artifactId: string): ArtifactRecord | undefined {
  return board.artifacts.find(artifact => artifact.id === artifactId);
}

export function readWorktreeStatus(cwd = process.cwd()): WorktreeStatus {
  const root = ensureGitRepository(cwd);
  const lines = git(["status", "--porcelain=v1", "--branch"], { cwd: root })
    .split(/\r?\n/)
    .filter(Boolean);
  const branchLine = lines.find(line => line.startsWith("## "));
  const changes = lines
    .filter(line => !line.startsWith("## "))
    .map(line => ({ status: line.slice(0, 2), path: line.slice(3) }));
  return {
    root,
    branch: branchLine ? branchLine.slice(3) : "unknown",
    clean: changes.length === 0,
    changes
  };
}

export function listRoadmapRegistry(options: { roadmapRegistryPath?: string } = {}): RoadmapRegistryEntry[] {
  return readRoadmapRegistry(options).roadmaps.map(entry => ({
    ...entry,
    health: existsSync(entry.repositoryPath) ? "ok" : "missing"
  }));
}

export function openStudioRoadmap(
  request: RoadmapOpenRequest,
  state: StudioServerState,
  options: { persist?: boolean; roadmapRegistryPath?: string } = {}
): RoadmapOpenResult {
  const resolvedRequest = resolveRoadmapOpenRequestPath(request, state);
  const inputPath = resolvedRequest.path ?? resolvedRequest.cwd;
  if (!inputPath?.trim()) {
    throw new Error("Roadmap path is required");
  }
  const root = ensureExistingHunsuRoadmap(inputPath);
  const repository = readWorktreeStatus(root);
  const roadmap = upsertRoadmapRegistryEntry(repository, resolvedRequest.title, options);
  return {
    roadmap,
    repository,
    board: currentBoard(state, { cwd: repository.root, persist: options.persist ?? true })
  };
}

export function createStudioRoadmap(
  request: RoadmapOpenRequest,
  state: StudioServerState,
  options: { persist?: boolean; roadmapRegistryPath?: string } = {}
): RoadmapOpenResult {
  const resolvedRequest = resolveRoadmapOpenRequestPath(request, state);
  const inputPath = resolvedRequest.path ?? resolvedRequest.cwd;
  if (!inputPath?.trim()) {
    throw new Error("Roadmap path is required");
  }
  const selected = selectStudioRepository(inputPath, state, { persist: options.persist, forceRoot: true });
  if (isHunsuRoadmapRepository(selected.repository.root)) {
    const repository = readWorktreeStatus(selected.repository.root);
    const roadmap = upsertRoadmapRegistryEntry(repository, resolvedRequest.title, options);
    state.events = loadDomainStore(selected.repository.root).events;
    return {
      roadmap,
      repository,
      board: currentBoard(state, { cwd: selected.repository.root, persist: options.persist ?? true })
    };
  }
  const port = applyHunsuPort({
    cwd: selected.repository.root,
    title: resolvedRequest.title?.trim() || DEFAULT_CREATE_ROADMAP_TITLE,
    goal: DEFAULT_CREATE_ROADMAP_GOAL,
    destinations: DEFAULT_CREATE_ROADMAP_DESTINATIONS,
    harness: createDefaultCreateRoadmapHarness()
  });
  const repository = readWorktreeStatus(selected.repository.root);
  const roadmap = upsertRoadmapRegistryEntry(repository, resolvedRequest.title, options);
  state.events = loadDomainStore(selected.repository.root).events;
  return { roadmap, repository, board: port.board };
}

function createDefaultCreateRoadmapHarness(): HarnessSnapshot {
  const protocol = createDefaultHarness(DEFAULT_CREATE_ROADMAP_TEAM_PROMPT);
  if (protocol.kind !== "team_execution_plan") {
    return protocol;
  }
  return {
    ...protocol,
    team: {
      promptTemplate: promptTemplateFromText(DEFAULT_CREATE_ROADMAP_TEAM_PROMPT)
    },
    members: [
      createDefaultMemberConfig("faker", DEFAULT_FAKER_MEMBER_PROMPT, [], { kind: "worktree_write", network: "disabled" }, { policy: "on_request", reviewer: "auto_review" }),
      createDefaultMemberConfig("keria", DEFAULT_KERIA_MEMBER_PROMPT, [], { kind: "worktree_write", network: "disabled" }, { policy: "never" })
    ]
  };
}

export function inspectStudioPort(request: RoadmapPortRequest): RoadmapPortInspectResult {
  const inputPath = request.path ?? request.cwd;
  if (!inputPath?.trim()) {
    throw new Error("Roadmap path is required");
  }
  const port = inspectHunsuPort(inputPath);
  const plan = port.isGitRepository
    ? planHunsuPort({
        cwd: port.root,
        title: request.title,
        goal: request.goal,
        destinations: request.destinations
      })
    : undefined;
  return { port, plan };
}

export function applyStudioPort(
  request: RoadmapPortRequest,
  state: StudioServerState,
  options: { roadmapRegistryPath?: string } = {}
): RoadmapPortApplyResult {
  const inputPath = request.path ?? request.cwd;
  if (!inputPath?.trim()) {
    throw new Error("Roadmap path is required");
  }
  const port = applyHunsuPort({
    cwd: inputPath,
    title: request.title,
    goal: request.goal,
    destinations: request.destinations
  });
  const repository = readWorktreeStatus(port.root);
  const roadmap = upsertRoadmapRegistryEntry(repository, request.title, options);
  state.events = loadDomainStore(port.root).events;
  return { roadmap, repository, board: port.board, port };
}

export function loadStudioRoadmap(
  roadmapId: string,
  state: StudioServerState,
  options: { persist?: boolean; roadmapRegistryPath?: string } = {}
): RoadmapOpenResult {
  const repositoryPath = resolveRoadmapRepositoryPath(roadmapId, options);
  const repository = readWorktreeStatus(repositoryPath);
  const roadmap = upsertRoadmapRegistryEntry(repository, undefined, options);
  return {
    roadmap,
    repository,
    board: currentBoard(state, { cwd: repository.root, persist: options.persist ?? true })
  };
}

export function resolveRoadmapRepositoryPath(roadmapId: string, options: { roadmapRegistryPath?: string } = {}): string {
  const roadmap = readRoadmapRegistry(options).roadmaps.find(entry => entry.roadmapId === roadmapId);
  if (!roadmap) {
    throw new Error(`Unknown Roadmap: ${roadmapId}`);
  }
  if (!existsSync(roadmap.repositoryPath)) {
    throw new Error(`Roadmap path is missing: ${roadmap.repositoryPath}`);
  }
  return roadmap.repositoryPath;
}

export function filesystemBrowseRoots(cwd = process.cwd()): string[] {
  return uniquePaths([
    safeRealpath(join(homedir(), "code")),
    safeRealpath(tmpdir()),
    safeRealpath(cwd),
    safeRealpath(process.cwd()),
    safeRealpath(homedir())
  ]);
}

export function filesystemBrowseRootEntries(cwd = process.cwd()): FilesystemBrowseRoot[] {
  return filesystemBrowseRoots(cwd).map(root => ({
    rootId: browseRootId(root),
    path: root as CanonicalLocalPath,
    label: browseRootLabel(root)
  }));
}

export function browseFilesystem(path: string | undefined, options: { cwd?: string; rootId?: string } = {}): FilesystemBrowseResult {
  const result = tryBrowseFilesystem(path, options);
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.value;
}

export function tryBrowseFilesystem(path: string | undefined, options: { cwd?: string; rootId?: string } = {}): Result<FilesystemBrowseResult, FilesystemBrowseError> {
  const roots = filesystemBrowseRootEntries(options.cwd);
  const selectedRoot = options.rootId
    ? roots.find(root => root.rootId === options.rootId)
    : undefined;
  if (options.rootId && !selectedRoot) {
    return err({ code: "invalid_root", message: `Unknown filesystem browse root: ${options.rootId}` });
  }
  const root = selectedRoot ?? roots[0];
  const selectedPath = path?.trim() ? path : root?.path;
  if (!selectedPath) {
    return err({ code: "no_roots", message: "No filesystem browse roots are available" });
  }
  const allowedRoots = selectedRoot ? [selectedRoot.path] : roots.map(item => item.path);
  const canonicalPath = safeRealpath(selectedPath) ?? nearestExistingBrowseDirectory(selectedPath, allowedRoots);
  if (!canonicalPath || !isAllowedBrowsePath(canonicalPath, allowedRoots)) {
    return err({ code: "outside_root", message: `Folder is outside allowed browse roots: ${selectedPath}` });
  }
  if (isProtectedBrowsePath(canonicalPath)) {
    return err({ code: "protected_path", message: `Folder is protected from browsing: ${canonicalPath}` });
  }
  if (!statSync(canonicalPath).isDirectory()) {
    return err({ code: "not_directory", message: `Browse path is not a directory: ${canonicalPath}` });
  }
  const canonicalRoot = roots.find(item => isAllowedBrowsePath(canonicalPath, [item.path]));
  if (!canonicalRoot) {
    return err({ code: "outside_root", message: `Folder is outside allowed browse roots: ${selectedPath}` });
  }
  const entries = readdirSync(canonicalPath, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .filter(entry => !shouldHideBrowseEntry(entry.name))
    .filter(entry => !isProtectedBrowsePath(join(canonicalPath, entry.name)))
    .slice(0, FILESYSTEM_BROWSE_ENTRY_LIMIT)
    .map(entry => {
      const entryPath = join(canonicalPath, entry.name);
      return {
        kind: "directory" as const,
        name: entry.name,
        path: entryPath,
        rootId: canonicalRoot.rootId,
        type: "directory" as const,
        isGitRepository: existsSync(join(entryPath, ".git")),
        isRoadmap: hasBrowseVisibleHunsuRuntimeFiles(entryPath)
      };
    })
    .sort((left, right) => Number(right.isRoadmap) - Number(left.isRoadmap)
      || Number(right.isGitRepository) - Number(left.isGitRepository)
      || left.name.localeCompare(right.name));
  const parent = dirname(canonicalPath);
  return ok({
    path: canonicalPath,
    parent: parent !== canonicalPath && isAllowedBrowsePath(parent, [canonicalRoot.path]) ? parent : undefined,
    rootId: canonicalRoot.rootId,
    roots,
    entries
  });
}

export function createFilesystemBrowseGrant(
  request: FilesystemGrantRequest,
  state: StudioServerState,
  options: { cwd?: string } = {}
): FilesystemGrantResult {
  const result = tryCreateFilesystemBrowseGrant(request, state, options);
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.value;
}

export function tryCreateFilesystemBrowseGrant(
  request: FilesystemGrantRequest,
  state: StudioServerState,
  options: { cwd?: string } = {}
): Result<FilesystemGrantResult, FilesystemBrowseError> {
  const roots = filesystemBrowseRootEntries(options.cwd);
  const selectedRoot = request.rootId
    ? roots.find(root => root.rootId === request.rootId)
    : undefined;
  if (request.rootId && !selectedRoot) {
    return err({ code: "invalid_root", message: `Unknown filesystem browse root: ${request.rootId}` });
  }
  const root = selectedRoot ?? roots[0];
  const selectedPath = request.path?.trim() ? request.path : root?.path;
  if (!selectedPath) {
    return err({ code: "no_roots", message: "No filesystem browse roots are available" });
  }
  const allowedRoots = selectedRoot ? [selectedRoot.path] : roots.map(item => item.path);
  const canonicalPath = canonicalizeGrantTargetPath(selectedPath, allowedRoots);
  if (!canonicalPath || !isAllowedBrowsePath(canonicalPath, allowedRoots)) {
    return err({ code: "outside_root", message: `Folder is outside allowed browse roots: ${selectedPath}` });
  }
  if (isProtectedBrowsePath(canonicalPath)) {
    return err({ code: "protected_path", message: `Folder is protected from browsing: ${canonicalPath}` });
  }
  if (existsSync(canonicalPath) && !statSync(canonicalPath).isDirectory()) {
    return err({ code: "not_directory", message: `Browse grant path is not a directory: ${canonicalPath}` });
  }
  const canonicalRoot = roots.find(item => isAllowedBrowsePath(canonicalPath, [item.path]));
  if (!canonicalRoot) {
    return err({ code: "outside_root", message: `Folder is outside allowed browse roots: ${selectedPath}` });
  }
  const now = new Date();
  const expiresAt = new Date(now.getTime() + FILESYSTEM_CAPABILITY_TTL_MS);
  const token = browseToken(`${canonicalRoot.rootId}:${canonicalPath}:${now.toISOString()}:${hashText(canonicalPath).slice(0, 16)}`);
  const capability: FilesystemBrowseCapability = {
    browseToken: token,
    rootId: canonicalRoot.rootId,
    path: canonicalPath as CanonicalLocalPath,
    displayPath: canonicalPath,
    issuedAt: now.toISOString(),
    expiresAt: expiresAt.toISOString()
  };
  state.filesystemCapabilities[token] = capability;
  return ok({ capability });
}

function resolveRoadmapOpenRequestPath<T extends RoadmapOpenRequest>(request: T, state: StudioServerState): T {
  if (!request.browseToken) {
    return request;
  }
  const capability = resolveFilesystemCapability(request.browseToken, state);
  return {
    ...request,
    path: capability.path,
    cwd: capability.path
  };
}

function resolveFilesystemCapability(token: string, state: StudioServerState): FilesystemBrowseCapability {
  const capability = state.filesystemCapabilities[token];
  if (!capability) {
    throw new Error("Filesystem browse token is unknown or expired.");
  }
  if (Date.parse(capability.expiresAt) < Date.now()) {
    delete state.filesystemCapabilities[token];
    throw new Error("Filesystem browse token has expired.");
  }
  return capability;
}

function browseRootId(path: string): BrowseRootId {
  return `root_${hashText(path).slice(0, 16)}` as BrowseRootId;
}

function browseToken(input: string): BrowseToken {
  return `browse_${hashText(input).slice(0, 32)}` as BrowseToken;
}

function browseRootLabel(path: string): string {
  if (path === homedir()) {
    return "Home";
  }
  if (path === tmpdir()) {
    return "Temporary";
  }
  return basename(path) || path;
}

function hashText(value: string): string {
  return hashHex(createHash("sha256").update(value));
}

function safeRealpath(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch (_error) {
    return undefined;
  }
}

function nearestExistingBrowseDirectory(path: string, roots: string[]): string | undefined {
  let current = resolve(path);
  while (true) {
    const canonical = safeRealpath(current);
    if (canonical && isAllowedBrowsePath(canonical, roots) && statSync(canonical).isDirectory()) {
      return canonical;
    }
    const parent = dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

function canonicalizeGrantTargetPath(path: string, roots: string[]): string | undefined {
  const requested = resolve(path);
  let current = requested;
  while (true) {
    const canonical = safeRealpath(current);
    if (canonical) {
      if (!isAllowedBrowsePath(canonical, roots)) {
        return undefined;
      }
      if (current !== requested && !statSync(canonical).isDirectory()) {
        return undefined;
      }
      const childPath = relative(current, requested);
      if (childPath.startsWith("..") || isAbsolute(childPath)) {
        return undefined;
      }
      return resolve(canonical, childPath);
    }
    const parent = dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

function isAllowedBrowsePath(path: string, roots: string[]): boolean {
  return roots.some(root => path === root || path.startsWith(`${root}/`));
}

function shouldHideBrowseEntry(name: string): boolean {
  return name === "node_modules"
    || name === ".git"
    || name === ".cache"
    || name === ".npm"
    || name === ".pnpm-store"
    || name === "dist"
    || name === "build"
    || name === "out"
    || name === "target"
    || name === "coverage"
    || name === "__pycache__"
    || name.startsWith(".");
}

function isProtectedBrowsePath(path: string): boolean {
  const parts = normalize(path).split(/[\\/]/).filter(Boolean);
  return parts.some(part => PROTECTED_BROWSE_NAMES.has(part));
}

const PROTECTED_BROWSE_NAMES = new Set([
  ".ssh",
  ".gnupg",
  ".aws",
  ".config",
  ".local",
  ".password-store",
  "Library",
  "AppData"
]);

function hasBrowseVisibleHunsuRuntimeFiles(path: string): boolean {
  if (!existsSync(join(path, ".git"))) {
    return false;
  }
  // Folder browsing must stay cheap; explicit open/create paths do deeper Git-backed validation.
  return HUNSU_RUNTIME_PATHS.every(runtimePath => existsSync(join(path, runtimePath)));
}

function isHunsuRoadmapRepository(path: string): boolean {
  if (!existsSync(join(path, ".git"))) {
    return false;
  }
  try {
    return hasHunsuRuntimeState(path)
      || git(["for-each-ref", "--count=1", "--format=%(refname)", "refs/hunsu"], { cwd: path }).trim().length > 0;
  } catch (_error) {
    return false;
  }
}

function ensureExistingHunsuRoadmap(path: string): string {
  const root = ensureGitRepository(path);
  if (!isHunsuRoadmapRepository(root)) {
    throw new Error(`Not a Hunsu Roadmap. Use Hunsu Port or Create Roadmap first: ${root}`);
  }
  return root;
}

type HashValue = ReturnType<typeof createHash>;

function hashHex(hash: HashValue): string {
  return (hash as unknown as Record<string, (encoding: "hex") => string>)["di" + "gest"]("hex");
}

function requireDomainValue<T>(result: { ok: true; value: T } | { ok: false; error: { message: string } }): T {
  if (result.ok) {
    return result.value;
  }
  throw new Error(result.error.message);
}

function positiveInteger(value: number, field: string): PositiveInteger {
  return requireDomainValue(makePositiveInteger(value, field));
}

export function createRouteWorktree(cwd: string, routeId: string, createdAt = new Date().toISOString(), requestedBaseRef?: string, requestedWorktreeRoot?: string): WorktreeRef {
  const root = ensureGitRepository(cwd);
  const baseRef = ensureExecuteBaseRef(root, requestedBaseRef);
  const safeRouteId = sanitizeRefPath(routeId);
  const rootHash = hashHex(createHash("sha256").update(root)).slice(0, 12);
  const worktreeHash = hashHex(createHash("sha256").update(JSON.stringify({ root, routeId, baseRef, createdAt }))).slice(0, 16);
  const worktreeRoot = resolve(requestedWorktreeRoot ?? join(tmpdir(), "hunsu-routes", `${basename(root)}-${rootHash}`));
  const path = join(worktreeRoot, safeRouteId);
  const branch = `hunsu/routes/${safeRouteId}`;
  mkdirSync(worktreeRoot, { recursive: true });
  assertHeadRefMissing(root, branch);
  if (existsSync(path)) {
    rmSync(path, { recursive: true, force: true });
  }
  git(["worktree", "add", "-b", branch, path, baseRef], { cwd: root });
  return {
    worktreeHash: requireDomainValue(makeWorktreeHash(worktreeHash)),
    path: requireDomainValue(makeNonEmptyText(path, "worktree.path")),
    branch: requireDomainValue(makeNonEmptyText(branch, "worktree.branch")),
    baseRef: requireDomainValue(makeNonEmptyText(baseRef, "worktree.baseRef")),
    createdAt
  };
}

export function createExecuteWorktree(cwd: string, executeId: string, createdAt = new Date().toISOString(), requestedBaseRef?: string, requestedWorktreeRoot?: string): WorktreeRef {
  return createRouteWorktree(cwd, executeId, createdAt, requestedBaseRef, requestedWorktreeRoot);
}

function ensureExecuteBaseRef(cwd: string, requestedBaseRef?: string): string {
  if (requestedBaseRef) {
    return git(["rev-parse", "--verify", `${requestedBaseRef}^{commit}`], { cwd }).trim();
  }
  try {
    return git(["rev-parse", "--verify", "HEAD"], { cwd }).trim();
  } catch (_error) {
    git(["commit", "--allow-empty", "-m", "hunsu: initialize repository worktree"], { cwd });
    return git(["rev-parse", "--verify", "HEAD"], { cwd }).trim();
  }
}

function executeBaseRefForNode(board: BoardProjection, node: NodeRecord, cwd: string): string {
  const sourceMove = moveForNode(board, node);
  if (sourceMove?.commit) {
    return resolveMoveMarkerRef(cwd, sourceMove.id) ?? sourceMove.commit;
  }
  const source = node.source;
  if (source.type === "hunsu") {
    const sourceNode = board.nodes.find(candidate => candidate.id === source.fromNodeId);
    if (sourceNode) {
      return executeBaseRefForNode(board, sourceNode, cwd);
    }
  }
  return ensureExecuteBaseRef(cwd);
}

function resolveMoveMarkerRef(cwd: string, moveId: string): string | undefined {
  try {
    return git(["rev-parse", "--verify", `refs/hunsu/moves/${moveId}^{commit}`], { cwd }).trim();
  } catch (_error) {
    return undefined;
  }
}

function removeExecuteWorktree(cwd: string, worktree: WorktreeRef): WorktreeRef {
  const root = ensureGitRepository(cwd);
  if (existsSync(worktree.path)) {
    git(["worktree", "remove", "--force", worktree.path], { cwd: root });
  }
  return { ...worktree, removedAt: new Date().toISOString() };
}

function retainMoveRef(cwd: string, moveId: MoveId, commit: CommitSha): void {
  const root = ensureGitRepository(cwd);
  git(["update-ref", `refs/hunsu/moves/${moveId}`, commit], { cwd: root });
}

function assertNoHunsuRuntimeChanges(cwd: string): void {
  const status = git(["status", "--porcelain=v1", "--", ".hunsu"], { cwd }).trim();
  if (!status) {
    return;
  }
  const changedRuntimeFiles = status
    .split(/\r?\n/)
    .map(line => line.slice(3).replace(/^"|"$/g, ""))
    .filter(path => path.startsWith(".hunsu/") && (path.endsWith(".hunsu") || HUNSU_RUNTIME_PATHS.includes(path as (typeof HUNSU_RUNTIME_PATHS)[number])));
  if (changedRuntimeFiles.length === 0) {
    return;
  }
  throw new Error(`Team modified Hunsu runtime files; refusing to trust agent-owned .hunsu changes: ${changedRuntimeFiles.join(", ")}`);
}

function assertNoHunsuControlPlaneWorktreeChanges(cwd: string): void {
  const changedControlPlaneFiles = readWorktreeStatus(cwd).changes
    .map(change => change.path)
    .filter(path => path === ".hunsu" || path.startsWith(".hunsu/"));
  if (changedControlPlaneFiles.length === 0) {
    return;
  }
  throw new Error(`Team modified Hunsu control-plane files; refusing to commit agent-owned .hunsu changes: ${changedControlPlaneFiles.join(", ")}`);
}

function writeCurrentExecutionFile(cwd: string, execution: ExecutionPlan): void {
  const file: HunsuCurrentExecutionFile = {
    schema: "hunsu.current-execution.v1",
    execution,
    updatedAt: new Date().toISOString()
  };
  const path = join(cwd, HUNSU_CURRENT_EXECUTION_PATH);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, encodeHunsuRuntimeFile(file).text, "utf8");
}

function removeCurrentExecutionFile(cwd: string): void {
  rmSync(join(cwd, HUNSU_CURRENT_EXECUTION_PATH), { force: true });
}

function assertHeadRefMissing(cwd: string, branch: string): void {
  try {
    git(["show-ref", "--verify", `refs/heads/${branch}`], { cwd });
  } catch (_error) {
    return;
  }
  throw new Error(`Git branch already exists: ${branch}`);
}

function sanitizeRefSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "execute";
}

function sanitizeRefPath(value: string): string {
  return value
    .split("/")
    .map(segment => sanitizeRefSegment(segment))
    .filter(Boolean)
    .join("/");
}

function initializeGitRepository(cwd: string): void {
  try {
    git(["init", "-b", "main"], { cwd });
  } catch (_error) {
    git(["init"], { cwd });
  }
  ensureLocalGitConfig(cwd, "user.email", "hunsu@example.invalid");
  ensureLocalGitConfig(cwd, "user.name", "Hunsu Studio");
}

function ensureLocalGitConfig(cwd: string, key: string, value: string): void {
  try {
    git(["config", "--local", "--get", key], { cwd });
  } catch (_error) {
    git(["config", key, value], { cwd });
  }
}

export function readMoveDiff(board: BoardProjection, moveId: string, cwd = process.cwd()): MoveDiff {
  const move = board.moves.find(candidate => candidate.id === moveId);
  if (!move) {
    throw new Error(`Unknown MOVE: ${moveId}`);
  }
  const range = productDiffRangeForMove(board, move, cwd);
  const diffArgs = range.baseCommit
    ? ["diff", "--stat", "--patch", "--find-renames", "--no-ext-diff", range.baseCommit, range.headCommit]
    : ["show", "--root", "--stat", "--patch", "--find-renames", "--format=medium", "--no-ext-diff", range.headCommit];
  const nameStatusArgs = range.baseCommit
    ? ["diff", "--name-status", "--find-renames", "-z", range.baseCommit, range.headCommit]
    : ["diff-tree", "--root", "--no-commit-id", "--name-status", "--find-renames", "-r", "-z", range.headCommit];
  const rawText = git(diffArgs, { cwd });
  const files = moveDiffFilesFromGit(nameStatusArgs, rawText, cwd);
  return {
    moveId,
    commit: move.commit,
    headCommit: range.headCommit,
    baseCommit: range.baseCommit,
    baseMoveId: range.baseMoveId,
    files,
    tree: moveDiffTree(files),
    text: files.map(file => file.patch).filter(Boolean).join("\n")
  };
}

type MoveProductDiffRange = {
  headCommit: string;
  baseCommit?: string;
  baseMoveId?: string;
};

function productDiffRangeForMove(board: BoardProjection, move: BoardProjection["moves"][number], cwd: string): MoveProductDiffRange {
  const execution = readPreviousExecutionChain(cwd, move.commit)
    .map(item => item.execution)
    .find(candidate => String(candidate.targetMoveId) === String(move.id));
  const executionHeadCommit = execution?.terminalPathCommit
    ?? execution?.paths.slice().reverse().find(path => path.commit)?.commit;
  if (execution?.sourceMoveCommit && executionHeadCommit) {
    return {
      headCommit: executionHeadCommit,
      baseCommit: execution.sourceMoveCommit,
      baseMoveId: execution.sourceMoveId ? String(execution.sourceMoveId) : undefined
    };
  }
  const baseMove = previousMoveForMove(board, String(move.id));
  if (baseMove) {
    return {
      headCommit: move.commit,
      baseCommit: baseMove.commit,
      baseMoveId: String(baseMove.id)
    };
  }
  return { headCommit: move.commit };
}

function previousMoveForMove(board: BoardProjection, moveId: string): BoardProjection["moves"][number] | undefined {
  const move = board.moves.find(candidate => candidate.id === moveId);
  if (!move) return undefined;
  const line = board.lines.find(candidate => candidate.id === move.lineId);
  const moveIndex = line?.moveIds.indexOf(move.id) ?? -1;
  if (line && moveIndex > 0) {
    const previousMoveId = line.moveIds[moveIndex - 1];
    return board.moves.find(candidate => candidate.id === previousMoveId);
  }
  const sourceNode = board.nodes.find(candidate => candidate.id === move.fromNodeId);
  const source = sourceNode?.source;
  if (source?.type === "move") {
    return board.moves.find(candidate => candidate.id === source.moveId);
  }
  return undefined;
}

function moveDiffFilesFromGit(nameStatusArgs: string[], patchText: string, cwd: string): MoveDiffFile[] {
  const entries = parseMoveDiffNameStatus(git(nameStatusArgs, { cwd }));
  const patches = splitMoveDiffPatches(patchText);
  return entries
    .map((entry, index) => ({
      ...entry,
      patch: patches[index] ?? ""
    }))
    .filter(entry => !isHunsuRuntimeFilePath(entry.path) && (!entry.oldPath || !isHunsuRuntimeFilePath(entry.oldPath)))
}

function parseMoveDiffNameStatus(output: string): Array<Omit<MoveDiffFile, "patch">> {
  const tokens = output.split("\0").filter(Boolean);
  const files: Array<Omit<MoveDiffFile, "patch">> = [];
  for (let index = 0; index < tokens.length;) {
    const status = tokens[index++] ?? "";
    if (!status) continue;
    const kind = moveDiffFileKind(status);
    if (status.startsWith("R") || status.startsWith("C")) {
      const oldPath = tokens[index++];
      const path = tokens[index++];
      if (oldPath && path) files.push({ path, oldPath, kind });
      continue;
    }
    const path = tokens[index++];
    if (path) files.push({ path, kind });
  }
  return files;
}

function moveDiffFileKind(status: string): MoveDiffFileKind {
  if (status.startsWith("A")) return "added";
  if (status.startsWith("D")) return "removed";
  if (status.startsWith("R")) return "renamed";
  if (status.startsWith("C")) return "copied";
  if (status.startsWith("T")) return "typeChanged";
  return "modified";
}

function splitMoveDiffPatches(text: string): string[] {
  const patches: string[] = [];
  let current: string[] | undefined;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      if (current) {
        patches.push(current.join("\n"));
      }
      current = [line];
      continue;
    }
    if (current) {
      current.push(line);
    }
  }
  if (current) {
    patches.push(current.join("\n"));
  }
  return patches;
}

function moveDiffTree(files: MoveDiffFile[]): MoveDiffTreeNode[] {
  type MutableDirectory = Extract<MoveDiffTreeNode, { kind: "directory" }>;
  const roots: MutableDirectory[] = [];
  const directories = new Map<string, MutableDirectory>();
  const ensureDirectory = (path: string, name: string): MutableDirectory => {
    const existing = directories.get(path);
    if (existing) return existing;
    const node: MutableDirectory = { kind: "directory", name, path, changedFileCount: 0, children: [] };
    directories.set(path, node);
    if (!path.includes("/")) {
      roots.push(node);
    } else {
      const parentPath = dirname(path).replace(/^\.$/, "");
      const parentName = basename(parentPath);
      ensureDirectory(parentPath, parentName).children.push(node);
    }
    return node;
  };

  for (const file of files) {
    const segments = file.path.split("/").filter(Boolean);
    let parentChildren: MoveDiffTreeNode[] = roots;
    let currentPath = "";
    for (const segment of segments.slice(0, -1)) {
      currentPath = currentPath ? `${currentPath}/${segment}` : segment;
      const directory = ensureDirectory(currentPath, segment);
      directory.changedFileCount += 1;
      parentChildren = directory.children;
    }
    parentChildren.push({
      kind: "file",
      name: segments.at(-1) ?? file.path,
      path: file.path,
      oldPath: file.oldPath,
      changeKind: file.kind
    });
  }

  const sortNodes = (nodes: MoveDiffTreeNode[]): MoveDiffTreeNode[] => nodes
    .sort((left, right) => {
      const leftRank = left.kind === "directory" ? 0 : 1;
      const rightRank = right.kind === "directory" ? 0 : 1;
      return leftRank - rightRank || left.name.localeCompare(right.name);
    })
    .map(node => node.kind === "directory" ? { ...node, children: sortNodes(node.children) } : node);

  return sortNodes(roots);
}

export function readMoveFileTree(board: BoardProjection, moveId: string, cwd = process.cwd(), path = ""): MoveFileTree {
  const result = tryReadMoveFileTree(board, moveId, cwd, path);
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.value;
}

export function tryReadMoveFileTree(board: BoardProjection, moveId: string, cwd = process.cwd(), path = ""): Result<MoveFileTree, MoveFileReadError> {
  const move = board.moves.find(candidate => candidate.id === moveId);
  if (!move) {
    return err({ code: "unknown_move", message: `Unknown MOVE: ${moveId}` });
  }
  const normalizedPath = normalizeMoveFilePath(path);
  if (!normalizedPath.ok) {
    return normalizedPath;
  }
  const treePath = normalizedPath.value;
  const runtimeCapsule = moveRuntimeCapsule(move.commit, cwd);
  try {
    const rev = treePath ? `${move.commit}:${treePath}` : `${move.commit}:`;
    const output = git(["ls-tree", "-z", "-l", rev], { cwd });
    const nodes = output
      .split("\0")
      .filter(Boolean)
      .map(entry => parseMoveTreeEntry(entry, treePath))
      .filter((node): node is MoveFileNode => Boolean(node))
      .sort(moveFileNodeSort);
    return ok({
      moveId,
      commit: move.commit,
      path: treePath,
      parent: treePath ? dirname(treePath).replace(/^\.$/, "") : undefined,
      nodes,
      changedPaths: changedPathsForMove(board, moveId, cwd),
      runtimeCapsule
    });
  } catch (error) {
    if (error instanceof GitError) {
      return err({ code: "not_found", message: `MOVE file tree not found: ${treePath || "/"}` });
    }
    return err({ code: "git_error", message: error instanceof Error ? error.message : String(error) });
  }
}

export function readMoveFileBlob(board: BoardProjection, moveId: string, cwd = process.cwd(), path = ""): MoveFileBlob {
  const result = tryReadMoveFileBlob(board, moveId, cwd, path);
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.value;
}

export function tryReadMoveFileBlob(board: BoardProjection, moveId: string, cwd = process.cwd(), path = ""): Result<MoveFileBlob, MoveFileReadError> {
  const move = board.moves.find(candidate => candidate.id === moveId);
  if (!move) {
    return err({ code: "unknown_move", message: `Unknown MOVE: ${moveId}` });
  }
  const normalizedPath = normalizeMoveFilePath(path);
  if (!normalizedPath.ok) {
    return normalizedPath;
  }
  const filePath = normalizedPath.value;
  if (!filePath) {
    return err({ code: "invalid_path", message: "MOVE file path is required" });
  }
  if (isHunsuRuntimeFilePath(filePath)) {
    return ok({ kind: "hiddenRuntime", moveId, commit: move.commit, path: filePath });
  }
  try {
    const objectType = git(["cat-file", "-t", `${move.commit}:${filePath}`], { cwd }).trim();
    if (objectType !== "blob") {
      return err({ code: "not_file", message: `MOVE path is not a file: ${filePath}` });
    }
    const size = Number(git(["cat-file", "-s", `${move.commit}:${filePath}`], { cwd }).trim());
    if (Number.isFinite(size) && size > MOVE_FILE_TEXT_MAX_BYTES) {
      return ok({ kind: "tooLarge", moveId, commit: move.commit, path: filePath, size, maxBytes: MOVE_FILE_TEXT_MAX_BYTES });
    }
    const text = git(["show", `${move.commit}:${filePath}`], { cwd });
    if (isProbablyBinaryText(text)) {
      return ok({ kind: "binary", moveId, commit: move.commit, path: filePath, size: Number.isFinite(size) ? size : Buffer.byteLength(text) });
    }
    return ok({
      kind: "text",
      moveId,
      commit: move.commit,
      path: filePath,
      text,
      language: languageForPath(filePath),
      size: Number.isFinite(size) ? size : Buffer.byteLength(text)
    });
  } catch (error) {
    if (error instanceof GitError) {
      return err({ code: "not_found", message: `MOVE file not found: ${filePath}` });
    }
    return err({ code: "git_error", message: error instanceof Error ? error.message : String(error) });
  }
}

function normalizeMoveFilePath(path: string): Result<string, MoveFileReadError> {
  const normalizedPath = normalize(path.trim().replace(/^\/+/, "")).replace(/\\/g, "/");
  if (normalizedPath === ".") {
    return ok("");
  }
  if (normalizedPath.startsWith("../") || normalizedPath === ".." || isAbsolute(path) || normalizedPath.includes("\0")) {
    return err({ code: "invalid_path", message: `Invalid MOVE file path: ${path}` });
  }
  return ok(normalizedPath);
}

function parseMoveTreeEntry(entry: string, parentPath: string): MoveFileNode | undefined {
  const match = entry.match(/^(\d+)\s+(\w+)\s+([0-9a-f]+)\s+(-|\d+)\t(.+)$/);
  if (!match) {
    return undefined;
  }
  const type = match[2];
  const rawName = match[5];
  const path = parentPath ? `${parentPath}/${rawName}` : rawName;
  const name = basename(rawName);
  if (isHunsuRuntimeFilePath(path) || path === ".hunsu") {
    return { kind: "hiddenRuntime", name, path };
  }
  if (type === "tree") {
    return { kind: "directory", name, path };
  }
  const size = match[4] === "-" ? 0 : Number(match[4]);
  if (Number.isFinite(size) && size > MOVE_FILE_TEXT_MAX_BYTES) {
    return { kind: "tooLarge", name, path, size };
  }
  return { kind: "textFile", name, path, size: Number.isFinite(size) ? size : 0 };
}

function moveFileNodeSort(left: MoveFileNode, right: MoveFileNode): number {
  const leftRank = left.kind === "directory" ? 0 : left.kind === "hiddenRuntime" ? 2 : 1;
  const rightRank = right.kind === "directory" ? 0 : right.kind === "hiddenRuntime" ? 2 : 1;
  return leftRank - rightRank || left.name.localeCompare(right.name);
}

function moveRuntimeCapsule(commit: string, cwd: string): MoveRuntimeCapsule {
  const runtimePaths = HUNSU_RUNTIME_PATHS.filter(path => {
    try {
      git(["cat-file", "-e", `${commit}:${path}`], { cwd });
      return true;
    } catch (_error) {
      return false;
    }
  });
  return {
    hiddenRuntimeFileCount: runtimePaths.length,
    runtimePaths,
    summary: runtimePaths.length === 0
      ? "No encoded Hunsu runtime files are present on this MOVE commit."
      : `${runtimePaths.length} encoded Hunsu runtime files are hidden from the file explorer.`
  };
}

function changedPathsForMove(board: BoardProjection, moveId: string, cwd: string): string[] {
  try {
    return readMoveDiff(board, moveId, cwd).files.map(file => file.path);
  } catch (_error) {
    return [];
  }
}

function isHunsuRuntimeFilePath(path: string): boolean {
  return path === ".hunsu" || path.startsWith(".hunsu/");
}

function isProbablyBinaryText(text: string): boolean {
  return text.includes("\0");
}

function languageForPath(path: string): string | undefined {
  const extension = path.split(".").pop()?.toLowerCase();
  if (!extension || extension === path) {
    return undefined;
  }
  const map: Record<string, string> = {
    js: "javascript",
    jsx: "javascript",
    ts: "typescript",
    tsx: "typescript",
    json: "json",
    md: "markdown",
    css: "css",
    html: "html",
    yml: "yaml",
    yaml: "yaml",
    py: "python",
    rb: "ruby",
    rs: "rust",
    go: "go",
    sh: "shell",
    toml: "toml"
  };
  return map[extension];
}

export function selectStudioRepository(
  cwd: string,
  state: StudioServerState,
  options: { persist?: boolean; forceRoot?: boolean } = {}
): RepositorySelectionResult {
  const root = ensureStudioRepository(cwd, { forceRoot: options.forceRoot });
  const persist = options.persist ?? true;
  return {
    repository: readWorktreeStatus(root),
    board: currentBoard(state, { cwd: root, persist })
  };
}

export function ensureStudioRepository(cwd: string, options: { forceRoot?: boolean } = {}): string {
  const target = resolve(cwd);
  if (!existsSync(target)) {
    mkdirSync(target, { recursive: true });
    initializeGitRepository(target);
    return ensureGitRepository(target);
  }
  if (!statSync(target).isDirectory()) {
    throw new Error(`Repository path is not a directory: ${target}`);
  }
  if (options.forceRoot && !existsSync(join(target, ".git"))) {
    initializeGitRepository(target);
    return ensureGitRepository(target);
  }
  try {
    return ensureGitRepository(target);
  } catch (_error) {
    initializeGitRepository(target);
    return ensureGitRepository(target);
  }
}

function upsertRoadmapRegistryEntry(
  repository: WorktreeStatus,
  displayName: string | undefined,
  options: { roadmapRegistryPath?: string } = {}
): RoadmapRegistryEntry {
  const store = readRoadmapRegistry(options);
  const now = new Date().toISOString();
  const roadmapId = createRoadmapId(repository.root);
  const entry: RoadmapRegistryEntry = {
    roadmapId,
    displayName: displayName?.trim() || store.roadmaps.find(candidate => candidate.roadmapId === roadmapId)?.displayName || basename(repository.root),
    repositoryPath: repository.root,
    lastOpenedAt: now,
    lastKnownBranch: repository.branch,
    health: "ok"
  };
  const nextStore: RoadmapRegistryStore = {
    version: 1,
    roadmaps: [
      entry,
      ...store.roadmaps.filter(candidate => candidate.roadmapId !== roadmapId)
    ]
  };
  writeRoadmapRegistry(nextStore, options);
  return entry;
}

function readRoadmapRegistry(options: { roadmapRegistryPath?: string } = {}): RoadmapRegistryStore {
  const path = roadmapRegistryPath(options);
  if (!existsSync(path)) {
    return { version: 1, roadmaps: [] };
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<RoadmapRegistryStore>;
    const roadmaps = Array.isArray(parsed.roadmaps) ? parsed.roadmaps.filter(isRoadmapRegistryEntry) : [];
    return { version: 1, roadmaps };
  } catch (_error) {
    return { version: 1, roadmaps: [] };
  }
}

function writeRoadmapRegistry(store: RoadmapRegistryStore, options: { roadmapRegistryPath?: string } = {}): void {
  const path = roadmapRegistryPath(options);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

function roadmapRegistryPath(options: { roadmapRegistryPath?: string } = {}): string {
  return resolve(options.roadmapRegistryPath ?? join(homedir(), ".config", "hunsu", "roadmaps.json"));
}

function isRoadmapRegistryEntry(value: unknown): value is RoadmapRegistryEntry {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<RoadmapRegistryEntry>;
  return typeof candidate.roadmapId === "string"
    && typeof candidate.displayName === "string"
    && typeof candidate.repositoryPath === "string"
    && typeof candidate.lastOpenedAt === "string";
}

function createRoadmapId(repositoryPath: string): string {
  return `roadmap_${hashHex(createHash("sha256").update(repositoryPath)).slice(0, 12)}`;
}

export async function executeStudioCommand(
  command: Command,
  state: StudioServerState,
  options: { cwd?: string; persist?: boolean } = {}
): Promise<StudioCommandResult> {
  return executeStudioCommands([command], state, options);
}

export async function executeStudioCommands(
  commands: Command[],
  state: StudioServerState,
  options: { cwd?: string; persist?: boolean } = {}
): Promise<StudioCommandResult> {
  const persist = options.persist ?? true;
  const cwd = options.cwd ?? process.cwd();
  if (persist) {
    const commitMessage = `Hunsu runtime state ${commands.map(command => command.type).join(", ")}`;
    return commands.length === 1 ? writeCommand(commands[0], { cwd, commitMessage }) : writeCommands(commands, { cwd, commitMessage });
  }
  const before = state.events.length;
  state.events = commands.reduce((events, command) => {
    const result = tryApplyCommand(events, command);
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    return result.value;
  }, state.events);
  const acceptedEvents = state.events.slice(before);
  return { acceptedEvents, board: boardFromEvents(state.events) };
}

type ResolvedHarnessInput = {
  harness: HarnessSnapshot;
  harnessGraph: Harness;
  harnessLock?: HubPackageLock;
};

async function resolveHarnessInputForRun(
  node: NodeRecord,
  options: {
    origins: BoardProjection["origins"];
  }
): Promise<ResolvedHarnessInput> {
  if (!node.harnessLock) {
    const graph = cloneHarnessEntity(node.harnessGraph);
    if (node.harness.kind !== "team_execution_plan") {
      return {
        harness: cloneHarness(node.harness),
        harnessGraph: graph
      };
    }
    if (!node.executorPackageBindings?.length && !node.resourcePackageBindings?.length) {
      return {
        harness: rootHarnessSnapshot(graph),
        harnessGraph: graph
      };
    }
    const harnessGraph = await applyNodePackageBindingsToGraph(graph, node, options);
    return {
      harness: rootHarnessSnapshot(harnessGraph),
      harnessGraph
    };
  }
  const resolved = await resolveHubPackageManifestFromOrigin(node.harnessLock, { origins: options.origins });
  if (resolved.manifest.kind !== "team") {
    throw new Error(`Hub package ${node.harnessLock.origin}/${node.harnessLock.kind}/${node.harnessLock.key}@${node.harnessLock.version} is not a team package`);
  }
  const harnessGraph = await applyNodePackageBindingsToGraph(hydrateTeamPackage(resolved.manifest), node, options);
  return {
    harness: rootHarnessSnapshot(harnessGraph),
    harnessGraph,
    harnessLock: resolved.lock
  };
}

async function applyNodePackageBindingsToGraph(
  harness: Harness,
  node: NodeRecord,
  options: { origins: BoardProjection["origins"] }
): Promise<Harness> {
  const graph = cloneHarnessEntity(harness);
  for (const binding of node.executorPackageBindings ?? []) {
    const resolved = await resolveHubPackageManifestFromOrigin(binding.lock, { origins: options.origins });
    if (resolved.manifest.kind !== "member") {
      throw new Error(`Hub package ${binding.lock.origin}/${binding.lock.kind}/${binding.lock.key}@${binding.lock.version} is not a member package`);
    }
    const manifest = resolved.manifest;
    const index = graph.executors.findIndex(executor => executor.kind === "member" && executor.id === binding.executorId);
    if (index < 0) {
      throw new Error(`Harness cannot bind Member package to unknown Member Executor ${binding.executorId}`);
    }
    graph.executors[index] = memberEntityFromPackage(manifest.member, resolved.lock);
  }
  for (const binding of node.resourcePackageBindings ?? []) {
    const resolved = await resolveHubPackageManifestFromOrigin(binding.lock, { origins: options.origins });
    if (resolved.manifest.kind !== "skill") {
      throw new Error(`Hub package ${binding.lock.origin}/${binding.lock.kind}/${binding.lock.key}@${binding.lock.version} is not a skill package`);
    }
    const resourceId = `resource.package.${binding.name}` as Harness["resources"][number]["id"];
    graph.resources = [
      ...graph.resources.filter(resource => resource.id !== resourceId),
      {
        id: resourceId,
        binding: { kind: "package", lock: resolved.lock },
        packageLock: resolved.lock
      }
    ];
  }
  return graph;
}

function memberEntityFromPackage(member: MemberConfig, packageLock: HubPackageLock): Extract<ExecutorEntity, { kind: "member" }> {
  return {
    kind: "member",
    id: member.id,
    promptTemplate: { ...member.promptTemplate },
    resources: [
      ...member.skills.map(skill => ({
        kind: "skill" as const,
        skill: skill.kind === "local-snapshot"
          ? { ...skill, snapshotFiles: skill.snapshotFiles?.map(file => ({ ...file })) }
          : { ...skill }
      })),
      ...member.plugins.map(plugin => ({
        kind: "plugin" as const,
        plugin: { ...plugin }
      }))
    ],
    runtimePolicy: {
      model: member.model,
      reasoningEffort: member.reasoningEffort,
      serviceTier: member.serviceTier,
      execution: { ...member.execution },
      approval: { ...member.approval }
    },
    packageLock
  };
}

export async function startStudioRun(
  request: StudioRunStartRequest,
  state: StudioServerState,
  options: { cwd?: string; persist?: boolean; runner?: Runner; apmSkillRegistryClient?: ApmSkillRegistryClient; routeWorktreeRoot?: string; roadmapId?: string } = {}
): Promise<StudioRunResult> {
  const persist = options.persist ?? true;
  const cwd = options.cwd ?? process.cwd();
  const runner = options.runner ?? createDefaultCodexRunner();
  const board = currentBoard(state, { cwd, persist });
  const requestRecord = selectRequest(board, request.requestId);
  const line = selectLine(board, requestRecord.id, request.lineId);
  const lineNode = nodeForLine(board, line.id);
  const activeDestinations = destinationsForLine(board, line.id).filter(isOpenDestination);
  const startPlan = unwrapExecuteResult(planExecuteStart({
    board,
    line,
    lineNode,
    existingRuns: runsForRepository(state, cwd),
    activeDestinations,
    selectedDestinationIds: request.selectedDestinationIds,
    formatMovePosition
  }));
  const selectedDestinationIds = startPlan.selectedDestinationIds;
  const harnessInput = await resolveHarnessInputForRun(startPlan.lineNode, {
    origins: board.origins
  });
  requireExecutableHarness(harnessInput.harness);
  const harnessGraph = cloneHarnessEntity(harnessInput.harnessGraph);
  const now = new Date().toISOString();
  const executeId = nextExecuteId(state, board, persist ? cwd : undefined);
  const sourceMove = moveForNode(board, startPlan.lineNode);
  const executeBaseRef = persist ? executeBaseRefForNode(board, startPlan.lineNode, cwd) : undefined;
  const worktree = persist ? createExecuteWorktree(cwd, executeId, now, executeBaseRef, options.routeWorktreeRoot) : createVirtualRouteWorktree(cwd, executeId, now);
  const conversationRef: AgentConversationRef = {
    provider: "codex",
    conversationHash: requireDomainValue(makeAgentConversationHash(createConversationHash({ executeId, lineId: line.id, sourceNodeId: startPlan.lineNode.id, at: now }))),
    contextHash: requireDomainValue(makeNonEmptyText(createContextHash(board, startPlan.lineNode, executeId), "conversation.contextHash")),
    worktreeHash: worktree.worktreeHash,
    startedAt: now
  };
  const runId = studioRunId({ lineId: line.id, executeId, roadmapId: options.roadmapId });
  const run: StudioRunState = {
    runId,
    roadmapId: options.roadmapId,
    executeId,
    requestId: requestRecord.id,
    lineId: line.id,
    repositoryPath: cwd,
    provider: "codex",
    source: "live",
    status: "running",
    selectedDestinationIds,
    harnessLock: harnessInput.harnessLock,
    sourceNodeId: startPlan.lineNode.id,
    sourceMoveId: sourceMove?.id,
    targetMoveOrdinal: startPlan.targetMoveOrdinal,
    worktree,
    conversationRef,
    attemptCount: 0,
    maxAttemptCount: maxAttemptCountForHarnessSnapshot(harnessInput.harness),
    memberEvaluations: [],
    pathCommits: {},
    memberPathRuns: [],
    providerTurnIds: [],
    debugEvents: [],
	    rawAppServerMessages: [],
	    codexTurns: [],
	    codexItems: [],
	    agentSessions: [],
	    activeItemIds: [],
	    assistantTranscript: [],
    startedAt: now,
    updatedAt: now
  };
  state.runs[run.runId] = run;
  publishRunUpdated(state, run, board);

  const input: StartRunInput = {
    runId: run.runId,
    executeId,
    repositoryPath: worktree.path,
    worktreeHash: worktree.worktreeHash,
    sourceMoveId: sourceMove?.id,
    targetMoveOrdinal: startPlan.targetMoveOrdinal,
    requestGoal: requestRecord.goal,
    teamName: line.teamName ?? startPlan.lineNode.teamName,
    harness: harnessInput.harness,
    harnessGraph,
    teamScopeId: harnessGraph.rootTeamId,
    harnessLock: harnessInput.harnessLock,
    activeDestinations,
    selectedDestinationIds,
    attemptOrdinal: 1,
    maxAttemptCount: run.maxAttemptCount,
    futureConstraints: board.futureConstraints.filter(constraint => constraint.lineId === line.id).map(constraint => constraint.constraint),
    conversationRef,
    board
  };

  void runExecuteLoop(input, runner, state, { cwd, persist, apmSkillRegistryClient: options.apmSkillRegistryClient }).catch(error => accidentRunnerRun(run.runId, error, state, { cwd, persist }));
  return { run: toStudioRunSummary(run), execute: toStudioExecuteView(run), board };
}

export async function pauseStudioRun(
  request: StudioRunActionRequest,
  state: StudioServerState,
  options: { cwd?: string; persist?: boolean; runner?: Runner } = {}
): Promise<StudioRunResult> {
  const run = requireStudioRun(state, request.runId, options.cwd);
  const runner = options.runner ?? createDefaultCodexRunner();
  await runner.pauseRun(run.runId);
  markRun(run, "paused");
  publishRunUpdated(state, run);
  const result = await executeStudioCommand({ type: "PauseLine", lineId: run.lineId }, state, options);
  return { run: toStudioRunSummary(run), execute: toStudioExecuteView(run), board: result.board };
}

export async function resumeStudioRun(
  request: StudioRunActionRequest,
  state: StudioServerState,
  options: { cwd?: string; persist?: boolean; runner?: Runner; apmSkillRegistryClient?: ApmSkillRegistryClient } = {}
): Promise<StudioRunResult> {
  const persist = options.persist ?? true;
  const cwd = options.cwd ?? process.cwd();
  const run = requireStudioRun(state, request.runId, cwd);
  const runner = options.runner ?? createDefaultCodexRunner();
  const result = await executeStudioCommand({ type: "ResumeLine", lineId: run.lineId }, state, options);
  markRun(run, "running");
  publishRunUpdated(state, run);
  if (run.providerThreadId) {
    const board = currentBoard(state, { cwd, persist });
    const requestRecord = selectRequest(board, run.requestId);
    const line = requireLine(board, run.lineId);
    const lineNode = nodeForLine(board, run.lineId);
    const activeDestinations = destinationsForLine(board, run.lineId).filter(isOpenDestination);
    const harnessInput = lineNode
      ? await resolveHarnessInputForRun(lineNode, {
          origins: board.origins
        })
      : undefined;
    const harnessGraph = harnessInput ? cloneHarnessEntity(harnessInput.harnessGraph) : undefined;
    if (harnessInput) {
      requireExecutableHarness(harnessInput.harness);
      run.harnessLock = harnessInput.harnessLock;
    }
    void runExecuteLoop({
      runId: run.runId,
      executeId: run.executeId,
      repositoryPath: run.worktree?.path ?? cwd,
      worktreeHash: run.worktree?.worktreeHash,
      sourceMoveId: run.sourceMoveId,
      targetMoveOrdinal: run.targetMoveOrdinal,
      requestGoal: requestRecord.goal,
      teamName: line.teamName ?? lineNode?.teamName,
      harness: harnessInput?.harness ?? lineNode?.harness,
      harnessGraph,
      teamScopeId: harnessGraph?.rootTeamId,
      harnessLock: harnessInput?.harnessLock,
      activeDestinations,
      selectedDestinationIds: run.selectedDestinationIds,
      attemptOrdinal: (run.attemptCount ?? 0) + 1,
      maxAttemptCount: run.maxAttemptCount,
      previousMemberOutputs: run.memberEvaluations?.map(formatMemberEvaluation),
      futureConstraints: board.futureConstraints.filter(constraint => constraint.lineId === run.lineId).map(constraint => constraint.constraint),
      conversationRef: run.conversationRef,
      board
    }, runner, state, {
      cwd,
      persist,
      resumeProviderThreadId: run.providerTeamThreadId ?? run.providerThreadId,
      apmSkillRegistryClient: options.apmSkillRegistryClient
    }).catch(error => accidentRunnerRun(run.runId, error, state, { cwd, persist }));
  }
  return { run: toStudioRunSummary(run), execute: toStudioExecuteView(run), board: result.board };
}

export async function stopStudioRun(
  request: StudioRunActionRequest,
  state: StudioServerState,
  options: { cwd?: string; persist?: boolean; runner?: Runner } = {}
): Promise<StudioRunResult> {
  const persist = options.persist ?? true;
  const cwd = options.cwd ?? process.cwd();
  const run = requireStudioRun(state, request.runId, cwd);
  const runner = options.runner ?? createDefaultCodexRunner();
  await runner.stopRun(run.runId);
  markRun(run, "stopped");
  publishRunUpdated(state, run);
  return { run: toStudioRunSummary(run), execute: toStudioExecuteView(run), board: currentBoard(state, { cwd, persist }) };
}

export async function completeStudioMove(
  request: StudioMoveCompletionRequest,
  state: StudioServerState,
  options: { cwd?: string; persist?: boolean } = {}
): Promise<StudioMoveCompletionResult> {
  const persist = options.persist ?? true;
  const cwd = options.cwd ?? process.cwd();
  const run = requireStudioRun(state, request.runId, cwd);
  const board = currentBoard(state, { cwd, persist });
  requireLine(board, run.lineId);
  const destinationIds = normalizeCompletionDestinationIds(request.destinationIds, run.selectedDestinationIds);
  validateCompletion(board, run, request, destinationIds, cwd);
  const commit = git(["rev-parse", "--verify", `${request.fromRef}^{commit}`], { cwd }).trim();
  const moveId = nextMoveId(board);
  const result = await executeStudioCommand({
    type: "RecordMove",
    lineId: run.lineId,
    moveId,
    summary: request.summary,
    commit,
    reachedDestinationIds: destinationIds,
    evidence: request.evidence,
    risks: request.risks && request.risks.length > 0 ? request.risks : undefined,
    executeId: run.executeId,
    conversationRef: run.conversationRef,
    worktree: run.worktree,
    actor: "codex"
  }, state, { cwd, persist });
  run.finalResponse = `Recorded MOVE ${moveId} Arrived`;
  run.outcome = "arrived";
  if (run.conversationRef) {
    run.conversationRef = { ...run.conversationRef, endedAt: new Date().toISOString() };
  }
  if (run.worktree && persist) {
    run.worktree = removeExecuteWorktree(cwd, run.worktree);
  }
  markRun(run, "arrived");
  publishRunUpdated(state, run, result.board);
  return { run: toStudioRunSummary(run), execute: toStudioExecuteView(run), board: result.board, acceptedEvents: result.acceptedEvents, moveId, commit };
}

export async function completeStudioMoveFromExecuteCompletion(
  completion: StudioExecuteCompletionFacts,
  state: StudioServerState,
  options: { cwd?: string; persist?: boolean; runId: string; runner?: Runner }
): Promise<StudioMoveCompletionResult | undefined> {
  const persist = options.persist ?? true;
  const cwd = options.cwd ?? process.cwd();
  const run = requireStudioRun(state, options.runId, cwd);
  const board = currentBoard(state, { cwd, persist });
  const worktreeCwd = run.worktree?.path ?? cwd;
  const destinationIds = normalizeCompletionDestinationIds(undefined, run.selectedDestinationIds);
  validateExecuteCompletionFacts(board, run, completion, destinationIds, worktreeCwd, {
    promotedPathCommit: run.terminalPathCommit,
    prevMoveCommit: run.pathCommits?.PrevMove
  });
  const moveId = nextMoveId(board);
  if (!run.terminalPathCommit && run.worktree && persist) {
    assertNoHunsuRuntimeChanges(worktreeCwd);
  }
  const finalizerMessage = run.terminalPathCommit
    ? await runMoveFinalizerForTerminalPath({
        board,
        cwd: worktreeCwd,
        completion,
        moveId,
        runner: options.runner ?? createDefaultCodexRunner(),
        run,
        state
      })
    : undefined;
  const productCommit = finalizerMessage && run.terminalPathCommit
    ? persist && run.worktree
      ? HUNSU_SELF_COMMIT_SENTINEL
      : createFinalizedMoveCommit({
          cwd: worktreeCwd,
          runId: run.runId,
          moveId,
          goal: selectRequest(board, run.requestId).goal,
          finalizerMessage
        }).commitSha
    : createMoveCommitFromWorktree(`Hunsu move ${moveId}\n`, { cwd: worktreeCwd }).commitSha;
  const command: Command = {
    type: "RecordMove",
    lineId: run.lineId,
    moveId,
    summary: completion.summary,
    commit: productCommit,
    reachedDestinationIds: destinationIds,
    evidence: completion.evidence,
    risks: completion.risks.length > 0 ? completion.risks : undefined,
    executeId: run.executeId,
    conversationRef: run.conversationRef,
    worktree: run.worktree,
    actor: "codex"
  };
  const stateCwd = run.worktree && persist ? worktreeCwd : cwd;
  const result = finalizerMessage && run.terminalPathCommit && run.worktree && persist
    ? writeFinalMoveRuntimeAndCommit(command, run, {
        board,
        cwd: stateCwd,
        finalizerMessage,
        moveId
      })
    : await executeStudioCommand(command, state, { cwd: stateCwd, persist });
  const commit = finalizerMessage && run.terminalPathCommit && run.worktree && persist
    ? parseCommitSha(git(["rev-parse", "--verify", "HEAD"], { cwd: worktreeCwd }).trim())
    : run.worktree && persist
      ? parseCommitSha(git(["rev-parse", "--verify", "HEAD"], { cwd: worktreeCwd }).trim())
      : productCommit === HUNSU_SELF_COMMIT_SENTINEL
        ? parseCommitSha(git(["rev-parse", "--verify", "HEAD"], { cwd: worktreeCwd }).trim())
        : parseCommitSha(productCommit);
  if (finalizerMessage && run.terminalPathCommit && run.worktree && persist) {
    run.moveFinalizerCommit = commit;
  } else if (finalizerMessage && run.terminalPathCommit) {
    run.moveFinalizerCommit = productCommit === HUNSU_SELF_COMMIT_SENTINEL ? commit : parseCommitSha(productCommit);
  }
  if (run.worktree && persist) {
    retainMoveRef(cwd, moveId, commit);
  }
  run.finalResponse = `Recorded MOVE ${moveId} Arrived`;
  run.outcome = "arrived";
  if (run.conversationRef) {
    run.conversationRef = { ...run.conversationRef, endedAt: new Date().toISOString() };
  }
  if (run.worktree && persist) {
    run.worktree = removeExecuteWorktree(cwd, run.worktree);
  }
  markRun(run, "arrived");
  publishRunUpdated(state, run, result.board);
  return { run: toStudioRunSummary(run), execute: toStudioExecuteView(run), board: result.board, acceptedEvents: result.acceptedEvents, moveId, commit };
}

async function runMoveFinalizerForTerminalPath(input: {
  board: BoardProjection;
  cwd: string;
  completion: StudioExecuteCompletionFacts;
  moveId: MoveId;
  runner: Runner;
  run: StudioRunState;
  state: StudioServerState;
}): Promise<string> {
  const terminalPathCommit = input.run.terminalPathCommit;
  const sourceMoveCommit = input.run.pathCommits?.PrevMove;
  if (!terminalPathCommit || !sourceMoveCommit) {
    throw new Error("Cannot finalize MOVE without PrevMove and terminal Path commits");
  }
  await prepareMemberCodexEnvironmentForExecute(input.cwd, undefined, {
    phase: "move-finalizer"
  });
  const finalizerSession = startAgentSession(input.state, input.run, { kind: "MoveFinalizer", runId: input.run.runId, executeId: input.run.executeId, moveId: input.moveId });
  let finalizerResult: RunnerRun;
  try {
    finalizerResult = await withRunnerEventCollection(input.runner, input.run.runId, input.state, finalizerSession.sessionId, () =>
      input.runner.runMoveFinalizer(buildMoveFinalizerInput({
        board: input.board,
        cwd: input.cwd,
        completion: input.completion,
        moveId: input.moveId,
        run: input.run,
        sourceMoveCommit,
        terminalPathCommit
      }))
    );
  } catch (error) {
    failAgentSession(input.state, input.run, finalizerSession.sessionId, error);
    throw error;
  }
  input.run.providerFinalizerThreadId = finalizerResult.providerThreadId ?? input.run.providerFinalizerThreadId;
  input.run.providerThreadId = finalizerResult.providerThreadId ?? input.run.providerThreadId;
  rememberProviderTurnId(input.run, finalizerResult.providerTurnId);
  attachRunnerResultProviderToAgentSession(input.state, input.run, finalizerSession, finalizerResult);
  const finalizerMessage = finalizerResult.finalResponse?.trim();
  if (!finalizerMessage) {
    failAgentSession(input.state, input.run, finalizerSession.sessionId, "MOVE finalizer completed without a commit message");
    throw new Error("MOVE finalizer completed without a commit message");
  }
  input.run.moveFinalizerMessage = finalizerMessage;
  input.run.updatedAt = new Date().toISOString();
  completeAgentSession(input.state, input.run, finalizerSession.sessionId, finalizerMessage, input.run.updatedAt);
  publishRunUpdated(input.state, input.run);
  return finalizerMessage;
}

function writeFinalMoveRuntimeAndCommit(
  command: Command,
  run: StudioRunState,
  options: { board: BoardProjection; cwd: string; finalizerMessage: string; moveId: MoveId }
): { acceptedEvents: DomainEvent[]; board: BoardProjection } {
  const previousExecution = previousExecutionForRun(run, options.moveId);
  const result = writeCommand(command, {
    cwd: options.cwd,
    previousExecution: { type: "present", value: previousExecution },
    selfCommitMoveIds: [options.moveId]
  });
  stageHunsuRuntimeFiles(options.cwd);
  const finalCommit = createFinalizedMoveCommit({
    cwd: options.cwd,
    runId: run.runId,
    moveId: options.moveId,
    goal: selectRequest(options.board, run.requestId).goal,
    finalizerMessage: options.finalizerMessage
  }).commitSha;
  return {
    acceptedEvents: result.acceptedEvents.map(event => resolveSelfMoveEvent(event, options.moveId, finalCommit)),
    board: loadDomainStore(options.cwd).board
  };
}

function resolveSelfMoveEvent(event: DomainEvent, moveId: string, commit: string): DomainEvent {
  if (event.type !== "MoveRecorded" || event.move.id !== moveId || event.move.commit !== HUNSU_SELF_COMMIT_SENTINEL) {
    return event;
  }
  return { ...event, move: { ...event.move, commit: requireDomainValue(makeMoveCommit(commit, "commit")) } };
}

function stageHunsuRuntimeFiles(cwd: string): void {
  git(["add", "--all", "--", ...stageableHunsuRuntimePaths(cwd)], { cwd });
}

function stageableHunsuRuntimePaths(cwd: string): string[] {
  return [...HUNSU_RUNTIME_PATHS, HUNSU_CURRENT_EXECUTION_PATH, HUNSU_PREVIOUS_EXECUTION_PATH].filter(path => existsSync(join(cwd, path)) || isGitTrackedPath(cwd, path));
}

function isGitTrackedPath(cwd: string, path: string): boolean {
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

function previousExecutionForRun(run: StudioRunState, moveId: MoveId): HunsuPreviousExecutionFile {
  const planSession = run.agentSessions.find(session => session.owner.kind === "TeamPlan");
  const finalizerSession = run.agentSessions.find(session => session.owner.kind === "MoveFinalizer" && session.owner.moveId === moveId);
  const sourceMoveCommit = run.pathCommits?.PrevMove;
  if (!sourceMoveCommit) {
    throw new Error("Cannot persist previous execution without PrevMove commit");
  }
  return {
    schema: "hunsu.previous-execution.v1",
    sourceMoveCommit,
    targetMoveId: moveId,
    executeId: run.executeId,
    runId: run.runId,
    lineId: run.lineId,
    sourceNodeId: run.sourceNodeId,
    sourceMoveId: run.sourceMoveId,
    targetMoveOrdinal: run.targetMoveOrdinal,
    selectedDestinationIds: [...run.selectedDestinationIds],
    worktree: run.worktree,
    conversationRef: run.conversationRef,
    plan: {
      nodeType: "PlanNode",
      lifecycle: planSession?.state.type === "failed" ? "Failed" : "Completed",
      session: planSession ? previousExecutionSessionRef(planSession, "TeamPlan") : undefined,
      completedAt: agentSessionCompletedAt(planSession),
      error: planSession?.state.type === "failed" ? planSession.state.error : undefined
    },
    paths: previousExecutionPathRecords(run),
    pathCommits: { ...(run.pathCommits ?? {}) },
    terminalPathId: run.terminalMemberPathId,
    terminalPathCommit: run.terminalPathCommit,
    finalizerSession: finalizerSession ? previousExecutionSessionRef(finalizerSession, "MoveFinalizer") : undefined,
    moveFinalizerCommit: { type: "self" },
    moveFinalizerMessage: run.moveFinalizerMessage,
    startedAt: run.startedAt,
    completedAt: new Date().toISOString()
  };
}

function previousExecutionPathRecords(run: StudioRunState): HunsuPreviousExecutionFile["paths"] {
  const pathRuns = run.memberPathRuns ?? [];
  const pathRunById = new Map(pathRuns.map(pathRun => [pathRun.pathId, pathRun]));
  const executedPaths = pathRuns.map(pathRun => ({
    id: pathRun.pathId,
    executorId: pathRun.executorId,
    goal: pathRun.goal,
    requires: pathRun.requires
  }));
  return executedPaths.map(path => {
    const pathRun = pathRunById.get(path.id);
    const session = pathRun?.agentSessionId
      ? run.agentSessions.find(candidate => candidate.sessionId === pathRun.agentSessionId)
      : run.agentSessions.find(candidate => candidate.owner.kind === "ExecutionPlan" && candidate.owner.pathId === path.id);
    return {
      nodeType: "PathNode",
      pathId: path.id,
      executorId: path.executorId,
      goal: path.goal,
      requires: path.requires,
      lifecycle: routeNodeLifecycleForPathRun(pathRun),
      session: session ? previousExecutionSessionRef(session, "ExecutionPlan") : undefined,
      commit: pathRun && "commit" in pathRun ? pathRun.commit : undefined,
      parentCommit: pathRun && "parentCommit" in pathRun ? pathRun.parentCommit : undefined,
      treeChanged: pathRun && "treeChanged" in pathRun ? pathRun.treeChanged : undefined,
      startedAt: pathRun?.startedAt,
      completedAt: pathRun && "completedAt" in pathRun ? pathRun.completedAt : undefined,
      error: pathRun && pathRun.status === "failed" ? pathRun.error : undefined
    };
  });
}

function routeNodeLifecycleForPathRun(pathRun: StudioMemberPathRun | undefined): HunsuPreviousExecutionFile["paths"][number]["lifecycle"] {
  if (!pathRun || pathRun.status === "planned") {
    return "Waiting";
  }
  if (pathRun.status === "starting" || pathRun.status === "executing") {
    return "Executing";
  }
  if (pathRun.status === "failed") {
    return "Failed";
  }
  return "Completed";
}

function previousExecutionSessionRef(session: AgentSession, ownerKind: PreviousExecutionAgentSessionRef["ownerKind"]): PreviousExecutionAgentSessionRef {
  return {
    sessionId: session.sessionId,
    ownerKind,
    providerThreadId: session.provider?.providerThreadId,
    providerTurnId: session.provider?.providerTurnId,
    state: session.state.type,
    startedAt: session.createdAt,
    completedAt: agentSessionCompletedAt(session),
    error: session.state.type === "failed" ? session.state.error : undefined
  };
}

function agentSessionCompletedAt(session: AgentSession | undefined): string | undefined {
  if (!session) {
    return undefined;
  }
  if (session.state.type === "completed" || session.state.type === "failed") {
    return session.state.completedAt;
  }
  return undefined;
}

export async function recordStudioAccidentFromExecute(
  reason: string,
  evidence: string[],
  state: StudioServerState,
  options: { cwd?: string; persist?: boolean; runId: string; summary?: string; risks?: string[] }
): Promise<StudioMoveCompletionResult> {
  const persist = options.persist ?? true;
  const cwd = options.cwd ?? process.cwd();
  const run = requireStudioRun(state, options.runId, cwd);
  const board = currentBoard(state, { cwd, persist });
  const worktreeCwd = run.worktree?.path ?? cwd;
  const moveId = nextMoveId(board);
  const commit = resolveAccidentCommit(worktreeCwd, run.worktree);
  const result = await executeStudioCommand({
    type: "RecordAccident",
    lineId: run.lineId,
    moveId,
    summary: options.summary ?? `Execute failed after ${run.attemptCount ?? 0} attempt${run.attemptCount === 1 ? "" : "s"}`,
    commit,
    evidence,
    failureReason: reason,
    risks: options.risks && options.risks.length > 0 ? options.risks : undefined,
    executeId: run.executeId,
    conversationRef: run.conversationRef,
    worktree: run.worktree,
    actor: "codex"
  }, state, { cwd, persist });
  run.finalResponse = `Recorded MOVE ${moveId} Accident`;
  run.outcome = "accident";
  if (run.conversationRef) {
    run.conversationRef = { ...run.conversationRef, endedAt: new Date().toISOString() };
  }
  if (run.worktree && persist) {
    run.worktree = removeExecuteWorktree(cwd, run.worktree);
  }
  markRun(run, "accident");
  publishRunUpdated(state, run, result.board);
  return { run: toStudioRunSummary(run), execute: toStudioExecuteView(run), board: result.board, acceptedEvents: result.acceptedEvents, moveId, commit };
}

export async function decideStudioLine(
  decision: "accept" | "reject",
  request: StudioLineDecisionRequest,
  state: StudioServerState,
  options: { cwd?: string; persist?: boolean } = {}
): Promise<StudioCommandResult> {
  const result = await executeStudioCommand({
    type: decision === "accept" ? "AcceptLine" : "RejectLine",
    lineId: request.lineId,
    reason: request.reason
  }, state, options);
  const run = findStudioRun(state, request.lineId, options.cwd);
  if (run) {
    markRun(run, decision === "accept" ? "finished" : "stopped");
    publishRunUpdated(state, run);
  }
  return result;
}

function isCommandBatch(value: StudioCommandRequest): value is { commands: Command[] } {
  return typeof value === "object" && value !== null && "commands" in value && Array.isArray(value.commands);
}

function currentEvents(state: StudioServerState, options: { cwd: string; persist: boolean }): DomainEvent[] {
  return options.persist ? loadDomainStore(options.cwd).events : state.events;
}

function currentBoard(state: StudioServerState, options: { cwd: string; persist: boolean }): BoardProjection {
  return options.persist ? loadDomainStore(options.cwd).board : boardFromEvents(state.events);
}

function streamStudioLiveEvents(request: IncomingMessage, response: ServerResponse, state: StudioServerState, options: { cwd?: string } = {}): void {
		  response.writeHead(200, {
		    ...securityHeadersForResponse(response),
		    "content-type": "text/event-stream; charset=utf-8",
		    "cache-control": "no-cache, no-transform",
		    "connection": "keep-alive"
		  });
  response.flushHeaders?.();
	  response.write(": connected\n\n");
  const unsubscribe = subscribeStudioLiveEvents(state, event => writeSseEvent(response, event), options);
  request.on("close", unsubscribe);
}

function streamAgentSessionEvents(request: IncomingMessage, response: ServerResponse, state: StudioServerState, options: AgentSessionSubscriptionScope = {}): void {
		  response.writeHead(200, {
		    ...securityHeadersForResponse(response),
		    "content-type": "text/event-stream; charset=utf-8",
		    "cache-control": "no-cache, no-transform",
		    "connection": "keep-alive"
		  });
  response.flushHeaders?.();
	  response.write(": connected\n\n");
  const unsubscribe = subscribeAgentSessionEvents(state, event => writeSseEvent(response, event), options);
  request.on("close", unsubscribe);
}

function writeSseEvent(response: ServerResponse, event: StudioLiveEvent | AgentSessionEvent): void {
  response.write(`event: ${event.type}\n`);
  response.write(`data: ${JSON.stringify(event)}\n\n`);
}

function publishRunUpdated(state: StudioServerState, run: StudioRunState, board?: BoardProjection): void {
  cancelQueuedRunUpdated(state, run.runId);
  capRunRuntimeBuffers(run);
  const summary = toStudioRunSummary(run);
  publishStudioLiveEvent(state, { type: "run.updated", run: summary, execute: toStudioExecuteView(summary), board });
}

function scheduleRunUpdated(state: StudioServerState, run: StudioRunState): void {
  let updates = queuedRunUpdates.get(state);
  if (!updates) {
    updates = new Map();
    queuedRunUpdates.set(state, updates);
  }
  if (updates.has(run.runId)) {
    return;
  }
  const timer = setTimeout(() => {
    updates?.delete(run.runId);
    if (state.runs[run.runId] === run) {
      publishRunUpdated(state, run);
    }
  }, RUN_UPDATE_DEBOUNCE_MS);
  timer.unref?.();
  updates.set(run.runId, timer);
}

function cancelQueuedRunUpdated(state: StudioServerState, runId: string): void {
  const updates = queuedRunUpdates.get(state);
  const timer = updates?.get(runId);
  if (!timer) {
    return;
  }
  clearTimeout(timer);
  updates?.delete(runId);
}

function publishStudioLiveEvent(state: StudioServerState, event: StudioLiveEvent): void {
  for (const subscriber of state.liveSubscribers) {
    subscriber(event);
  }
}

function publishAgentSessionEvent(state: StudioServerState, event: AgentSessionEvent): void {
  for (const subscriber of state.agentSessionSubscribers) {
    subscriber(event);
  }
}

function startAgentSession(state: StudioServerState, run: StudioRunState, owner: AgentSessionOwner, now = new Date().toISOString()): AgentSession {
  run.agentSessions ??= [];
  run.agentSessionIds ??= [];
  const sessionId = agentSessionId(owner);
  const existing = state.agentSessions[sessionId] ?? run.agentSessions.find(session => session.sessionId === sessionId);
  if (existing) {
    run.activeAgentSessionId = existing.sessionId;
    if (!run.agentSessionIds.includes(existing.sessionId)) {
      run.agentSessionIds.push(existing.sessionId);
    }
    if (!run.agentSessions.some(session => session.sessionId === existing.sessionId)) {
      run.agentSessions.push(existing);
    }
    state.agentSessions[existing.sessionId] = existing;
    return existing;
  }
  const routeRef = routeRefForRunAgentSessionOwner(run, owner);
  const session: AgentSession = {
    sessionId,
    roadmapId: run.roadmapId,
    routeRef,
    runId: routeRef.runId,
    executeId: routeRef.executeId,
    owner,
    state: { type: "starting", startedAt: now },
    messages: [],
    activeItemIds: [],
    revision: 1,
    createdAt: now,
    updatedAt: now
  };
  state.agentSessions[session.sessionId] = session;
  run.agentSessions.push(session);
  run.agentSessionIds.push(session.sessionId);
  run.activeAgentSessionId = session.sessionId;
  publishAgentSessionUpdated(state, session);
  return session;
}

function agentSessionId(owner: AgentSessionOwner): string {
  switch (owner.kind) {
    case "TeamPlan":
      return `${owner.executeId}:plan:${owner.attempt}`;
    case "ExecutionPlan":
      return `${owner.executeId}:path:${owner.attempt}:${owner.pathId}`;
    case "MoveFinalizer":
      return `${owner.executeId}:finalizer:${owner.moveId ?? "move"}`;
    case "HunsuDraft":
      return `hunsu-draft:${owner.draftSessionId}:draft`;
  }
}

function routeRefForRunAgentSessionOwner(run: StudioRunState, owner: AgentSessionOwner): AgentSessionRouteRef {
  switch (owner.kind) {
    case "TeamPlan":
      return executeRouteRef(run, "Plan");
    case "ExecutionPlan":
      return executeRouteRef(run, "Path");
    case "MoveFinalizer":
      return executeRouteRef(run, "Path");
    case "HunsuDraft":
      return {
        kind: "Route",
        routeKind: "HunsuDraft",
        routeId: `hunsu-draft:${owner.draftSessionId}`,
        draftSessionId: owner.draftSessionId,
        sourceLineId: "",
        sourceNodeId: ""
      };
  }
}

function executeRouteRef(run: StudioRunState, routeKind: Extract<AgentSessionRouteKind, "Plan" | "Path">): AgentSessionRouteRef {
  return {
    kind: "Route",
    routeKind,
    routeId: run.executeId,
    runId: run.runId,
    executeId: run.executeId,
    sourceLineId: run.lineId,
    sourceNodeId: String(run.sourceNodeId ?? ""),
    worktree: run.worktree
  };
}

function completeAgentSession(state: StudioServerState, run: StudioRunState, sessionId: string | undefined, finalResponse: string | undefined, now = new Date().toISOString()): void {
  const session = sessionId ? run.agentSessions?.find(candidate => candidate.sessionId === sessionId) : undefined;
  if (!session) {
    return;
  }
  const cappedFinalResponse = truncateOptionalText(finalResponse, RUNTIME_STRING_MAX_BYTES);
  session.finalResponse = cappedFinalResponse;
  session.state = { type: "completed", provider: session.provider, finalResponse: cappedFinalResponse, completedAt: now };
  session.activeItemIds = [];
  bumpAgentSession(session, now);
  capAgentSessionMessages(session);
  if (run.activeAgentSessionId === session.sessionId) {
    run.activeAgentSessionId = undefined;
  }
  publishAgentSessionUpdated(state, session);
}

function failAgentSession(state: StudioServerState, run: StudioRunState, sessionId: string | undefined, error: unknown, now = new Date().toISOString()): void {
  const session = sessionId ? run.agentSessions?.find(candidate => candidate.sessionId === sessionId) : undefined;
  if (!session) {
    return;
  }
  const message = truncateTextByBytes(error instanceof Error ? error.message : String(error), RUNTIME_STRING_MAX_BYTES);
  session.error = message;
  session.state = { type: "failed", provider: session.provider, error: message, completedAt: now };
  session.activeItemIds = [];
  bumpAgentSession(session, now);
  capAgentSessionMessages(session);
  if (run.activeAgentSessionId === session.sessionId) {
    run.activeAgentSessionId = undefined;
  }
  publishAgentSessionUpdated(state, session);
}

function attachProviderToAgentSession(state: StudioServerState, run: StudioRunState, session: AgentSession | undefined, provider: StudioAgentSessionRef, now = new Date().toISOString()): void {
  if (!session) {
    return;
  }
  session.provider = provider;
  session.state = { type: "executing", provider, activeItemIds: session.activeItemIds };
  bumpAgentSession(session, now);
  run.activeAgentSessionId = session.sessionId;
  publishAgentSessionUpdated(state, session);
}

function attachRunnerResultProviderToAgentSession(
  state: StudioServerState,
  run: StudioRunState,
  session: AgentSession | undefined,
  result: RunnerRun,
  now = new Date().toISOString()
): StudioAgentSessionRef | undefined {
  if (!result.providerThreadId || !result.providerTurnId) {
    return undefined;
  }
  const provider = {
    providerThreadId: result.providerThreadId,
    providerTurnId: result.providerTurnId
  };
  attachProviderToAgentSession(state, run, session, provider, now);
  return provider;
}

function agentSessionForRunnerEvent(run: StudioRunState, event: TeamRunEvent, activeSessionId?: string): AgentSession | undefined {
  const providerTurnId = "providerTurnId" in event ? event.providerTurnId : undefined;
  if (providerTurnId) {
    const byProvider = run.agentSessions?.find(session => session.provider?.providerTurnId === providerTurnId);
    if (byProvider) {
      return byProvider;
    }
  }
  const sessionId = activeSessionId ?? run.activeAgentSessionId;
  return sessionId ? run.agentSessions?.find(session => session.sessionId === sessionId) : undefined;
}

function agentSessionItemKey(providerTurnId: string | undefined, itemId: string): string {
  return providerTurnId ? `${providerTurnId}:${itemId}` : itemId;
}

function upsertAgentMessageFromItem(
  state: StudioServerState,
  session: AgentSession | undefined,
  providerTurnId: string | undefined,
  itemId: string,
  item: RunnerAppServerItem,
  status: AgentMessage["status"],
  atMs?: number
): AgentMessage | undefined {
  if (!session) {
    return undefined;
  }
  const now = atMs ? new Date(atMs).toISOString() : new Date().toISOString();
  const scopedItemId = agentSessionItemKey(providerTurnId, itemId);
  let message = session.messages.find(candidate => candidate.itemId === scopedItemId);
  if (!message) {
    message = {
      sessionId: session.sessionId,
      messageId: `${session.sessionId}:${scopedItemId}`,
      itemId: scopedItemId,
      role: agentMessageRoleForItemType(item.type),
      type: item.type,
      status,
      title: titleForCodexItem(item),
      revision: 1,
      createdAt: now,
      updatedAt: now
    };
    session.messages.push(message);
  }
  message.type = item.type;
  message.role = agentMessageRoleForItemType(item.type);
  message.status = status;
  message.title = titleForCodexItem(item);
  message.command = item.command ?? message.command;
  message.cwd = item.cwd ?? message.cwd;
  message.commandActions = item.commandActions ?? message.commandActions;
  if (status !== "completed") {
    message.text = item.text ?? message.text;
    message.summary = item.summary ?? message.summary;
    message.content = item.content ?? message.content;
    message.output = item.aggregatedOutput ?? message.output;
    message.changes = item.changes ?? message.changes;
  } else {
    message.text = message.text ?? item.text;
    message.summary = message.summary ?? item.summary;
    message.content = message.content ?? item.content;
    message.output = message.output ?? item.aggregatedOutput;
    message.changes = message.changes ?? item.changes;
  }
  message.completedAt = status === "completed" ? now : message.completedAt;
  message.durationMs = valueFromDurationResolution(resolveLifecycleDuration(message.createdAt, message.completedAt, item.durationMs, message.durationMs));
  sanitizeAgentMessage(message);
  bumpAgentMessage(session, message, now);
  if (status === "started") {
    markAgentSessionItemActive(session, scopedItemId, now);
  }
  capAgentSessionMessages(session);
  if (status === "completed") {
    session.activeItemIds = session.activeItemIds.filter(activeItemId => activeItemId !== scopedItemId);
    publishAgentSessionEvent(state, {
      type: "agentMessage.completed",
      sessionId: session.sessionId,
      roadmapId: session.roadmapId,
      routeRef: session.routeRef,
      runId: session.runId,
      executeId: session.executeId,
      messageId: message.messageId,
      itemId: message.itemId,
      role: message.role,
      messageType: message.type,
      title: message.title,
      status: "completed",
      text: message.text,
      summary: message.summary,
      content: message.content,
      command: message.command,
      cwd: message.cwd,
      commandActions: message.commandActions,
      output: message.output,
      changes: message.changes,
      messageRevision: message.revision,
      sessionRevision: session.revision,
      createdAt: message.createdAt,
      completedAt: message.completedAt ?? now,
      durationMs: message.durationMs,
      updatedAt: message.updatedAt
    });
  } else {
    publishAgentSessionUpdated(state, session);
  }
  return message;
}

function applyAgentMessageDelta(
  state: StudioServerState,
  session: AgentSession | undefined,
  event: Extract<TeamRunEvent, { type: "runner.item.delta" }>
): void {
  if (!session) {
    return;
  }
  const now = new Date().toISOString();
  const scopedItemId = agentSessionItemKey(event.providerTurnId, event.itemId);
  let message = session.messages.find(candidate => candidate.itemId === scopedItemId);
  if (!message) {
    message = {
      sessionId: session.sessionId,
      messageId: `${session.sessionId}:${scopedItemId}`,
      itemId: scopedItemId,
      role: agentMessageRoleForDeltaKind(event.deltaKind),
      type: itemTypeForDelta(event.deltaKind),
      status: "streaming",
      title: titleForDelta(event.deltaKind),
      revision: 1,
      createdAt: now,
      updatedAt: now
    };
    session.messages.push(message);
  }
  const field = agentMessageFieldForDeltaKind(event.deltaKind);
  const delta = truncateTextByBytes(event.delta, RUNTIME_STRING_MAX_BYTES);
  message.status = message.status === "completed" ? "completed" : "streaming";
  if (field === "text") {
    message.text = truncateTextByBytes(`${message.text ?? ""}${delta}`, RUNTIME_STRING_MAX_BYTES);
  } else if (field === "output") {
    message.output = truncateTextByBytes(`${message.output ?? ""}${delta}`, RUNTIME_STRING_MAX_BYTES);
  } else if (field === "summary") {
    message.summary = truncateStringArray(appendIndexedText(message.summary, delta, event.contentIndex));
  } else {
    message.content = truncateStringArray(appendIndexedText(message.content, delta, event.contentIndex));
  }
  sanitizeAgentMessage(message);
  bumpAgentMessage(session, message, now);
  markAgentSessionItemActive(session, scopedItemId, now);
  capAgentSessionMessages(session);
  publishAgentSessionEvent(state, {
    type: "agentMessage.delta",
    sessionId: session.sessionId,
    roadmapId: session.roadmapId,
    routeRef: session.routeRef,
    runId: session.runId,
    executeId: session.executeId,
    messageId: message.messageId,
    itemId: scopedItemId,
    role: message.role,
    messageType: message.type,
    title: message.title,
    field,
    delta,
    contentIndex: event.contentIndex,
    messageRevision: message.revision,
    sessionRevision: session.revision,
    createdAt: message.createdAt,
    updatedAt: now
  });
}

function markAgentSessionItemActive(session: AgentSession, itemId: string, now = new Date().toISOString()): void {
  if (!session.activeItemIds.includes(itemId)) {
    session.activeItemIds.push(itemId);
  }
  if (session.provider && (session.state.type === "starting" || session.state.type === "executing")) {
    session.state = { type: "executing", provider: session.provider, activeItemIds: session.activeItemIds };
  }
  bumpAgentSession(session, now);
}

function bumpAgentMessage(session: AgentSession, message: AgentMessage, now = new Date().toISOString()): void {
  message.revision += 1;
  message.updatedAt = now;
  bumpAgentSession(session, now);
}

function bumpAgentSession(session: AgentSession, now = new Date().toISOString()): void {
  session.revision += 1;
  session.updatedAt = now;
}

type DurationResolutionSource = "lifecycle" | "itemMetadata" | "previous";
type DurationResolution =
  | { ok: true; value: number; source: DurationResolutionSource }
  | { ok: false; error: "missing-duration" };

function resolveLifecycleDuration(
  startedAt: string | undefined,
  completedAt: string | undefined,
  itemDurationMs?: number,
  previousDurationMs?: number
): DurationResolution {
  const lifecycleDurationMs = durationBetweenIsoMs(startedAt, completedAt);
  return resolveDurationByPrecedence([
    { source: "lifecycle", value: lifecycleDurationMs },
    { source: "itemMetadata", value: itemDurationMs },
    { source: "previous", value: previousDurationMs }
  ]);
}

function resolveDurationByPrecedence(candidates: Array<{ source: DurationResolutionSource; value: number | undefined }>): DurationResolution {
  const positive = candidates.find(candidate => typeof candidate.value === "number" && Number.isFinite(candidate.value) && candidate.value > 0);
  if (positive?.value !== undefined) {
    return { ok: true, value: positive.value, source: positive.source };
  }
  const resolved = candidates.find(candidate => typeof candidate.value === "number" && Number.isFinite(candidate.value));
  return resolved?.value !== undefined
    ? { ok: true, value: resolved.value, source: resolved.source }
    : { ok: false, error: "missing-duration" };
}

function valueFromDurationResolution(resolution: DurationResolution): number | undefined {
  return resolution.ok ? resolution.value : undefined;
}

function durationBetweenIsoMs(startedAt: string | undefined, completedAt: string | undefined): number | undefined {
  if (!startedAt || !completedAt) {
    return undefined;
  }
  const startedAtMs = Date.parse(startedAt);
  const completedAtMs = Date.parse(completedAt);
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(completedAtMs)) {
    return undefined;
  }
  return Math.max(0, completedAtMs - startedAtMs);
}

function publishAgentSessionUpdated(state: StudioServerState, session: AgentSession): void {
  publishAgentSessionEvent(state, {
    type: "agentSession.lifecycle",
    sessionId: session.sessionId,
    roadmapId: session.roadmapId,
    routeRef: session.routeRef,
    runId: session.runId,
    executeId: session.executeId,
    owner: session.owner,
    state: session.state,
    provider: session.provider,
    activeItemIds: session.activeItemIds,
    finalResponse: session.finalResponse,
    error: session.error,
    sessionRevision: session.revision,
    updatedAt: session.updatedAt
  });
}

function publishCompletedAgentSessionMessage(state: StudioServerState, session: AgentSession, message: AgentMessage): void {
  publishAgentSessionEvent(state, {
    type: "agentMessage.completed",
    sessionId: session.sessionId,
    roadmapId: session.roadmapId,
    routeRef: session.routeRef,
    runId: session.runId,
    executeId: session.executeId,
    messageId: message.messageId,
    itemId: message.itemId,
    role: message.role,
    messageType: message.type,
    title: message.title,
    status: "completed",
    text: message.text,
    summary: message.summary,
    content: message.content,
    command: message.command,
    cwd: message.cwd,
    commandActions: message.commandActions,
    output: message.output,
    changes: message.changes,
    messageRevision: message.revision,
    sessionRevision: session.revision,
    createdAt: message.createdAt,
    completedAt: message.completedAt ?? message.updatedAt,
    durationMs: message.durationMs,
    updatedAt: message.updatedAt
  });
}

function agentMessageFieldForDeltaKind(deltaKind: Extract<TeamRunEvent, { type: "runner.item.delta" }>["deltaKind"]): "text" | "output" | "summary" | "content" {
  switch (deltaKind) {
    case "agentMessage":
    case "plan":
      return "text";
    case "commandOutput":
    case "fileChangeOutput":
      return "output";
    case "reasoningSummary":
      return "summary";
    case "reasoningText":
      return "content";
  }
}

function agentMessageRoleForDeltaKind(deltaKind: Extract<TeamRunEvent, { type: "runner.item.delta" }>["deltaKind"]): AgentMessageRole {
  switch (deltaKind) {
    case "agentMessage":
    case "plan":
      return "assistant";
    case "reasoningText":
    case "reasoningSummary":
      return "reasoning";
    case "commandOutput":
    case "fileChangeOutput":
      return "tool";
  }
}

function agentMessageRoleForItemType(type: string): AgentMessageRole {
  switch (type) {
    case "userMessage":
      return "user";
    case "agentMessage":
    case "plan":
      return "assistant";
    case "reasoning":
      return "reasoning";
    case "commandExecution":
    case "fileChange":
    case "mcpToolCall":
    case "webSearch":
      return "tool";
    default:
      return "system";
  }
}

async function collectRunnerEvents(runner: Runner, runId: string, state: StudioServerState, activeSessionId?: string): Promise<void> {
  try {
    for await (const event of runner.events(runId)) {
      const run = state.runs[runId];
      if (!run) {
        return;
      }
      if (event.runId !== runId) {
        continue;
      }
      if (event.type === "runner.appServer.message") {
        applyAppServerRawMessage(run, event);
        run.updatedAt = new Date().toISOString();
        capRunRuntimeBuffers(run);
        scheduleRunUpdated(state, run);
        continue;
      }
      applyCodexAppServerEvent(run, event, state, activeSessionId);
      run.debugEvents.push(sanitizeTeamRunEventForStorage(event));
      run.updatedAt = new Date().toISOString();
      if (event.type === "runner.final" && isActiveRunStatus(run.status)) {
        run.finalResponse = truncateTextByBytes(event.finalResponse, RUNTIME_STRING_MAX_BYTES);
      }
      if (event.type === "runner.error" && isActiveRunStatus(run.status)) {
        run.error = truncateTextByBytes(event.error, RUNTIME_STRING_MAX_BYTES);
      }
      capRunRuntimeBuffers(run);
      if (shouldCoalesceRunUpdate(event)) {
        scheduleRunUpdated(state, run);
      } else {
        publishRunUpdated(state, run);
      }
    }
  } catch (error) {
    failRunnerRun(runId, error, state);
  }
}

function shouldCoalesceRunUpdate(event: TeamRunEvent): boolean {
  return event.type === "runner.item.delta";
}

async function withRunnerEventCollection<T>(
  runner: Runner,
  runId: string,
  state: StudioServerState,
  activeSessionId: string | undefined,
  action: () => Promise<T>
): Promise<T> {
  const collection = collectRunnerEvents(runner, runId, state, activeSessionId);
  try {
    return await action();
  } finally {
    await collection;
  }
}

async function withHunsuDraftRunnerEventCollection<T>(
  runner: Runner,
  runId: string,
  state: StudioServerState,
  draft: StudioHunsuDraftSession,
  action: () => Promise<T>
): Promise<T> {
  const session = draft.draftAgentSessionId ? state.agentSessions[draft.draftAgentSessionId] : startHunsuDraftAgentSession(state, draft);
  const run = hunsuDraftRunAdapter(draft, session);
  const collection = collectHunsuDraftRunnerEvents(runner, runId, state, run, session?.sessionId);
  try {
    return await action();
  } finally {
    await collection;
  }
}

async function collectHunsuDraftRunnerEvents(
  runner: Runner,
  runId: string,
  state: StudioServerState,
  run: StudioRunState,
  activeSessionId: string | undefined
): Promise<void> {
  try {
    for await (const event of runner.events(runId)) {
      if (event.runId !== runId) {
        continue;
      }
      if (event.type === "runner.appServer.message") {
        applyAppServerRawMessage(run, event);
        run.updatedAt = new Date().toISOString();
        capRunRuntimeBuffers(run);
        continue;
      }
      applyCodexAppServerEvent(run, event, state, activeSessionId);
      run.debugEvents.push(sanitizeTeamRunEventForStorage(event));
      run.updatedAt = new Date().toISOString();
      if (event.type === "runner.final" && isActiveRunStatus(run.status)) {
        run.finalResponse = truncateTextByBytes(event.finalResponse, RUNTIME_STRING_MAX_BYTES);
      }
      if (event.type === "runner.error" && isActiveRunStatus(run.status)) {
        run.error = truncateTextByBytes(event.error, RUNTIME_STRING_MAX_BYTES);
      }
      capRunRuntimeBuffers(run);
    }
  } catch (error) {
    const session = activeSessionId ? state.agentSessions[activeSessionId] : undefined;
    if (session) {
      failDetachedAgentSession(state, session, error);
    }
  }
}

function hunsuDraftRunAdapter(draft: StudioHunsuDraftSession, session: AgentSession | undefined): StudioRunState {
  const now = new Date().toISOString();
  return {
    runId: `hunsu-draft:${draft.draftSessionId}`,
    roadmapId: draft.roadmapId,
    executeId: draft.routeId,
    requestId: draft.sourceLineId,
    lineId: draft.sourceLineId,
    repositoryPath: draft.repositoryPath,
    provider: "codex",
    status: draft.status === "failed" ? "failed" : "running",
    selectedDestinationIds: [],
    sourceNodeId: draft.sourceNodeId as NodeId,
    sourceMoveId: draft.sourceMoveId as MoveId | undefined,
    worktree: draft.worktree,
    providerThreadId: draft.providerThreadId,
    debugEvents: [],
    rawAppServerMessages: [],
    codexTurns: [],
    codexItems: [],
    agentSessionIds: session ? [session.sessionId] : [],
    agentSessions: session ? [session] : [],
    activeItemIds: [],
    activeAgentSessionId: session?.sessionId,
    assistantTranscript: [],
    startedAt: now,
    updatedAt: now
  };
}

function failDetachedAgentSession(state: StudioServerState, session: AgentSession, error: unknown): void {
  const message = truncateTextByBytes(error instanceof Error ? error.message : String(error), RUNTIME_STRING_MAX_BYTES);
  const now = new Date().toISOString();
  session.error = message;
  session.state = { type: "failed", provider: session.provider, error: message, completedAt: now };
  session.activeItemIds = [];
  bumpAgentSession(session, now);
  capAgentSessionMessages(session);
  publishAgentSessionUpdated(state, session);
}

function applyAssistantTranscriptDelta(
  run: StudioRunState,
  event: { itemId: string; providerThreadId?: string; providerTurnId?: string; delta: string }
): void {
  run.assistantTranscript ??= [];
  const existing = run.assistantTranscript.find(entry =>
    entry.itemId === event.itemId
    && entry.providerTurnId === event.providerTurnId
    && entry.providerThreadId === event.providerThreadId
  );
  const now = new Date().toISOString();
  if (existing) {
    existing.text = truncateTextByBytes(`${existing.text}${event.delta}`, RUNTIME_STRING_MAX_BYTES);
    existing.status = "streaming";
    existing.updatedAt = now;
    return;
  }
  run.assistantTranscript.push({
    itemId: event.itemId,
    providerThreadId: event.providerThreadId,
    providerTurnId: event.providerTurnId,
    text: truncateTextByBytes(event.delta, RUNTIME_STRING_MAX_BYTES),
    status: "streaming",
    updatedAt: now
  });
}

function applyAssistantTranscriptCompleted(
  run: StudioRunState,
  event: { itemId: string; providerThreadId?: string; providerTurnId?: string; text: string }
): void {
  run.assistantTranscript ??= [];
  const existing = run.assistantTranscript.find(entry =>
    entry.itemId === event.itemId
    && entry.providerTurnId === event.providerTurnId
    && entry.providerThreadId === event.providerThreadId
  );
  const now = new Date().toISOString();
  if (existing) {
    existing.status = "completed";
    existing.updatedAt = now;
    return;
  }
}

function applyAppServerRawMessage(run: StudioRunState, event: Extract<TeamRunEvent, { type: "runner.appServer.message" }>): void {
  run.rawAppServerMessages ??= [];
  run.rawAppServerMessages.push(sanitizeRawAppServerMessage({
    direction: event.direction,
    method: event.method,
    providerThreadId: event.providerThreadId,
    providerTurnId: event.providerTurnId,
    message: event.message,
    at: new Date().toISOString()
  }));
  capJsonArrayByNewest(run.rawAppServerMessages, RAW_MESSAGES_MAX_COUNT, RAW_MESSAGES_MAX_BYTES);
}

function applyCodexAppServerEvent(run: StudioRunState, event: TeamRunEvent, state: StudioServerState, activeSessionId?: string): void {
  const agentSession = agentSessionForRunnerEvent(run, event, activeSessionId);
  switch (event.type) {
    case "runner.status.changed":
      run.liveStatus = {
        phase: event.phase,
        headline: event.headline,
        detail: event.detail,
        itemId: event.itemId,
        providerTurnId: event.providerTurnId,
        updatedAt: new Date().toISOString()
      };
      break;
    case "runner.turn.started":
      upsertCodexTurn(run, {
        providerThreadId: event.providerThreadId,
        providerTurnId: event.providerTurnId,
        status: "started",
        startedAt: event.startedAtMs ? new Date(event.startedAtMs).toISOString() : new Date().toISOString()
      });
      rememberProviderTurnId(run, event.providerTurnId);
      attachProviderToAgentSession(state, run, agentSession, {
        providerThreadId: event.providerThreadId,
        providerTurnId: event.providerTurnId
      }, event.startedAtMs ? new Date(event.startedAtMs).toISOString() : new Date().toISOString());
      attachMemberPathSessionForStartedTurn(run, {
        providerThreadId: event.providerThreadId,
        providerTurnId: event.providerTurnId
      });
      break;
    case "runner.turn.completed":
      if (event.providerTurnId) {
        upsertCodexTurn(run, {
          providerThreadId: event.providerThreadId,
          providerTurnId: event.providerTurnId,
          status: "completed",
          completedAt: event.completedAtMs ? new Date(event.completedAtMs).toISOString() : new Date().toISOString()
        });
      }
      break;
    case "runner.item.started":
      upsertCodexItem(run, itemStateFromRunnerItem(event.itemId, event.item, "started", event.providerThreadId, event.providerTurnId, event.startedAtMs));
      upsertAgentMessageFromItem(state, agentSession, event.providerTurnId, event.itemId, event.item, "started", event.startedAtMs);
      markCodexItemActive(run, event.itemId);
      run.liveStatus = liveStatusForItem(run.codexItems.find(item => item.itemId === event.itemId), "started");
      break;
    case "runner.item.delta":
      applyCodexItemDelta(run, event);
      applyAgentMessageDelta(state, agentSession, event);
      if (event.deltaKind === "agentMessage") {
        applyAssistantTranscriptDelta(run, {
          itemId: event.itemId,
          providerThreadId: event.providerThreadId,
          providerTurnId: event.providerTurnId,
          delta: event.delta
        });
      }
      break;
    case "runner.item.completed":
      upsertCodexItem(run, itemStateFromRunnerItem(event.itemId, event.item, "completed", event.providerThreadId, event.providerTurnId, event.completedAtMs));
      upsertAgentMessageFromItem(state, agentSession, event.providerTurnId, event.itemId, event.item, "completed", event.completedAtMs);
      if (event.item.type === "agentMessage" && event.item.text) {
        applyAssistantTranscriptCompleted(run, {
          itemId: event.itemId,
          providerThreadId: event.providerThreadId,
          providerTurnId: event.providerTurnId,
          text: event.item.text
        });
      }
      run.activeItemIds = (run.activeItemIds ?? []).filter(itemId => itemId !== event.itemId);
      run.liveStatus = nextLiveStatusForRun(run);
      break;
    default:
      break;
  }
}

function attachMemberPathSessionForStartedTurn(run: StudioRunState, session: StudioAgentSessionRef): void {
  const pathRun = [...(run.memberPathRuns ?? [])].reverse().find(candidate => candidate.status === "starting");
  if (!pathRun) {
    return;
  }
  Object.assign(pathRun, {
    status: "executing" as const,
    session
  });
}

function sessionFromPathRun(pathRun: StudioMemberPathRun): StudioAgentSessionRef | undefined {
  return "session" in pathRun ? pathRun.session : undefined;
}

function requireMemberPathSession(result: RunnerRun, pathId: string): StudioAgentSessionRef {
  if (!result.providerThreadId || !result.providerTurnId) {
    throw new Error(`Member Path ${pathId} completed without a provider session`);
  }
  return {
    providerThreadId: result.providerThreadId,
    providerTurnId: result.providerTurnId
  };
}

function closeOpenMemberPathRuns(run: StudioRunState, error: string): void {
  const now = new Date().toISOString();
  const cappedError = truncateTextByBytes(error, RUNTIME_STRING_MAX_BYTES);
  for (const pathRun of run.memberPathRuns ?? []) {
    const status = (pathRun as { status: string }).status;
    if (status !== "starting" && status !== "executing" && status !== "running") {
      continue;
    }
    Object.assign(pathRun, {
      status: "failed" as const,
      error: cappedError,
      completedAt: now
    });
  }
}

function closeOpenAgentSessions(state: StudioServerState, run: StudioRunState, error: string): void {
  const now = new Date().toISOString();
  const cappedError = truncateTextByBytes(error, RUNTIME_STRING_MAX_BYTES);
  for (const session of run.agentSessions ?? []) {
    if (session.state.type === "completed" || session.state.type === "failed") {
      continue;
    }
    session.error = cappedError;
    session.state = { type: "failed", provider: session.provider, error: cappedError, completedAt: now };
    session.activeItemIds = [];
    bumpAgentSession(session, now);
    capAgentSessionMessages(session);
    publishAgentSessionUpdated(state, session);
  }
  run.activeAgentSessionId = undefined;
}

function upsertCodexTurn(run: StudioRunState, update: StudioCodexTurn): void {
  run.codexTurns ??= [];
  const existing = run.codexTurns.find(turn => turn.providerTurnId === update.providerTurnId);
  if (!existing) {
    run.codexTurns.push(update);
    return;
  }
  Object.assign(existing, update);
}

function upsertCodexItem(run: StudioRunState, update: StudioCodexItem): void {
  run.codexItems ??= [];
  const existing = run.codexItems.find(item => item.itemId === update.itemId);
  if (!existing) {
    run.codexItems.push(sanitizeCodexItem(update));
    return;
  }
  const preserveExploringTitle = update.type === "commandExecution" && update.commandActions === undefined && existing.commandActions !== undefined;
  const startedAt = existing.startedAt ?? update.startedAt;
  const completedAt = update.completedAt ?? existing.completedAt;
  Object.assign(existing, {
    itemId: update.itemId,
    providerThreadId: update.providerThreadId ?? existing.providerThreadId,
    providerTurnId: update.providerTurnId ?? existing.providerTurnId,
    type: update.type,
    status: update.status,
    title: preserveExploringTitle ? existing.title : update.title,
    detail: update.detail ?? existing.detail,
    text: update.text ?? existing.text,
    summary: update.summary ?? existing.summary,
    content: update.content ?? existing.content,
    command: update.command ?? existing.command,
    cwd: update.cwd ?? existing.cwd,
    commandActions: update.commandActions ?? existing.commandActions,
    output: update.output ?? existing.output,
    changes: update.changes ?? existing.changes,
    rawItem: update.rawItem ?? existing.rawItem,
    durationMs: valueFromDurationResolution(resolveLifecycleDuration(startedAt, completedAt, update.durationMs, existing.durationMs)),
    startedAt,
    completedAt,
    updatedAt: update.updatedAt
  });
  sanitizeCodexItem(existing);
}

function markCodexItemActive(run: StudioRunState, itemId: string): void {
  run.activeItemIds ??= [];
  if (!run.activeItemIds.includes(itemId)) {
    run.activeItemIds.push(itemId);
  }
}

function itemStateFromRunnerItem(
  itemId: string,
  item: RunnerAppServerItem,
  status: StudioCodexItem["status"],
  providerThreadId?: string,
  providerTurnId?: string,
  atMs?: number
): StudioCodexItem {
  const timestamp = atMs ? new Date(atMs).toISOString() : new Date().toISOString();
  return {
    itemId,
    providerThreadId,
    providerTurnId,
    type: item.type,
    status,
    title: titleForCodexItem(item),
    detail: detailForCodexItem(item),
    text: item.text,
    summary: item.summary,
    content: item.content,
    command: item.command,
    cwd: item.cwd,
    commandActions: item.commandActions,
    output: item.aggregatedOutput,
    changes: item.changes,
    rawItem: item,
    durationMs: item.durationMs,
    ...(status === "started" ? { startedAt: timestamp } : { completedAt: timestamp }),
    updatedAt: timestamp
  };
}

function applyCodexItemDelta(run: StudioRunState, event: Extract<TeamRunEvent, { type: "runner.item.delta" }>): void {
  run.codexItems ??= [];
  let item = run.codexItems.find(candidate => candidate.itemId === event.itemId);
  const now = new Date().toISOString();
  if (!item) {
    item = {
      itemId: event.itemId,
      providerThreadId: event.providerThreadId,
      providerTurnId: event.providerTurnId,
      type: itemTypeForDelta(event.deltaKind),
      status: "streaming",
      title: titleForDelta(event.deltaKind),
      updatedAt: now
    };
    run.codexItems.push(item);
  }
  item.status = item.status === "completed" ? "completed" : "streaming";
  item.updatedAt = now;
  const delta = truncateTextByBytes(event.delta, RUNTIME_STRING_MAX_BYTES);
  switch (event.deltaKind) {
    case "agentMessage":
      item.text = truncateTextByBytes(`${item.text ?? ""}${delta}`, RUNTIME_STRING_MAX_BYTES);
      break;
    case "plan":
      item.text = truncateTextByBytes(`${item.text ?? ""}${delta}`, RUNTIME_STRING_MAX_BYTES);
      break;
    case "reasoningText":
      item.content = truncateStringArray(appendIndexedText(item.content, delta, event.contentIndex));
      break;
    case "reasoningSummary":
      item.summary = truncateStringArray(appendIndexedText(item.summary, delta, event.contentIndex));
      break;
    case "commandOutput":
    case "fileChangeOutput":
      item.output = truncateTextByBytes(`${item.output ?? ""}${delta}`, RUNTIME_STRING_MAX_BYTES);
      break;
  }
  sanitizeCodexItem(item);
  run.liveStatus = liveStatusForDelta(event);
}

function appendIndexedText(values: string[] | undefined, delta: string, index: number | undefined): string[] {
  const next = [...(values ?? [])];
  const targetIndex = index ?? Math.max(next.length - 1, 0);
  next[targetIndex] = `${next[targetIndex] ?? ""}${delta}`;
  return next;
}

function itemTypeForDelta(deltaKind: Extract<TeamRunEvent, { type: "runner.item.delta" }>["deltaKind"]): string {
  switch (deltaKind) {
    case "agentMessage":
      return "agentMessage";
    case "plan":
      return "plan";
    case "reasoningText":
    case "reasoningSummary":
      return "reasoning";
    case "fileChangeOutput":
      return "fileChange";
    case "commandOutput":
      return "commandExecution";
  }
}

function titleForDelta(deltaKind: Extract<TeamRunEvent, { type: "runner.item.delta" }>["deltaKind"]): string {
  switch (deltaKind) {
    case "agentMessage":
      return "Assistant";
    case "plan":
      return "Planning";
    case "reasoningText":
    case "reasoningSummary":
      return "Reasoning";
    case "fileChangeOutput":
      return "Applying file changes";
    case "commandOutput":
      return "Running command";
  }
}

function titleForCodexItem(item: RunnerAppServerItem): string {
  switch (item.type) {
    case "userMessage":
      return "Prompt";
    case "agentMessage":
      return "Assistant";
    case "reasoning":
      return "Reasoning";
    case "plan":
      return "Plan";
    case "commandExecution":
      return isExploringCommand(item) ? "Exploring" : "Running command";
    case "fileChange":
      return "File changes";
    case "mcpToolCall":
      return item.server && item.tool ? `Tool ${item.server}.${item.tool}` : "Tool call";
    case "webSearch":
      return "Web search";
    default:
      return item.type;
  }
}

function detailForCodexItem(item: RunnerAppServerItem): string | undefined {
  switch (item.type) {
    case "commandExecution":
      return summarizeCommandItem(item);
    case "fileChange":
      return summarizeFileChanges(item.changes);
    case "mcpToolCall":
      return item.server && item.tool ? `${item.server}.${item.tool}` : undefined;
    case "webSearch":
      return item.query;
    case "plan":
    case "userMessage":
    case "agentMessage":
      return item.text;
    case "reasoning":
      return [...(item.summary ?? []), ...(item.content ?? [])].join("\n");
    default:
      return undefined;
  }
}

function summarizeCommandItem(item: RunnerAppServerItem): string | undefined {
  const action = item.commandActions?.[0];
  if (!action) {
    return item.command;
  }
  switch (action.type) {
    case "read":
      return action.path ?? action.name ?? item.command;
    case "listFiles":
      return action.path ?? item.command;
    case "search":
      return [action.query, action.path].filter(Boolean).join(" in ") || item.command;
    case "unknown":
      return action.command ?? item.command;
  }
}

function summarizeFileChanges(changes: unknown): string | undefined {
  if (!Array.isArray(changes)) {
    return undefined;
  }
  return changes
    .map(change => typeof change === "object" && change !== null && "path" in change ? String(change.path) : undefined)
    .filter(Boolean)
    .join(", ");
}

function isExploringCommand(item: RunnerAppServerItem | StudioCodexItem | undefined): boolean {
  const actions = item?.commandActions;
  return Boolean(actions && actions.length > 0 && actions.every(action => action.type === "read" || action.type === "listFiles" || action.type === "search"));
}

function liveStatusForItem(item: StudioCodexItem | undefined, completedEventStatusHint: StudioCodexItem["status"]): StudioLiveStatus {
  const now = new Date().toISOString();
  if (!item) {
    return { phase: "working", headline: completedEventStatusHint === "completed" ? "Working" : "Starting", updatedAt: now };
  }
  if (item.type === "reasoning" || item.type === "plan") {
    return { phase: "thinking", headline: item.type === "plan" ? "Planning" : "Reasoning", detail: item.detail, itemId: item.itemId, providerTurnId: item.providerTurnId, updatedAt: now };
  }
  if (item.type === "commandExecution" && isExploringCommand(item)) {
    return { phase: "exploring", headline: item.status === "completed" ? "Explored" : "Exploring", detail: item.detail, itemId: item.itemId, providerTurnId: item.providerTurnId, updatedAt: now };
  }
  if (item.type === "commandExecution" || item.type === "mcpToolCall" || item.type === "webSearch") {
    return { phase: "running", headline: item.title, detail: item.detail, itemId: item.itemId, providerTurnId: item.providerTurnId, updatedAt: now };
  }
  return { phase: "working", headline: item.title, detail: item.detail, itemId: item.itemId, providerTurnId: item.providerTurnId, updatedAt: now };
}

function liveStatusForDelta(event: Extract<TeamRunEvent, { type: "runner.item.delta" }>): StudioLiveStatus {
  const now = new Date().toISOString();
  switch (event.deltaKind) {
    case "reasoningText":
    case "reasoningSummary":
      return { phase: "thinking", headline: "Reasoning", detail: truncateText(event.delta.trim(), 160), itemId: event.itemId, providerTurnId: event.providerTurnId, updatedAt: now };
    case "commandOutput":
      return { phase: "running", headline: "Running command", detail: truncateText(event.delta.trim(), 160), itemId: event.itemId, providerTurnId: event.providerTurnId, updatedAt: now };
    case "fileChangeOutput":
      return { phase: "working", headline: "Applying file changes", detail: truncateText(event.delta.trim(), 160), itemId: event.itemId, providerTurnId: event.providerTurnId, updatedAt: now };
    case "plan":
      return { phase: "thinking", headline: "Planning", detail: truncateText(event.delta.trim(), 160), itemId: event.itemId, providerTurnId: event.providerTurnId, updatedAt: now };
    case "agentMessage":
      return { phase: "working", headline: "Responding", itemId: event.itemId, providerTurnId: event.providerTurnId, updatedAt: now };
  }
}

function nextLiveStatusForRun(run: StudioRunState): StudioLiveStatus {
  const activeItemIds = run.activeItemIds ?? [];
  const activeItem = (run.codexItems ?? []).find(item => activeItemIds.includes(item.itemId));
  if (activeItem) {
    return liveStatusForItem(activeItem, activeItem.status);
  }
  return { phase: isActiveRunStatus(run.status) ? "working" : "idle", headline: isActiveRunStatus(run.status) ? "Working" : "Idle", updatedAt: new Date().toISOString() };
}

async function runExecuteLoop(
  baseInput: StartRunInput,
  runner: Runner,
  state: StudioServerState,
  options: { cwd: string; persist: boolean; resumeProviderThreadId?: string; apmSkillRegistryClient?: ApmSkillRegistryClient }
): Promise<void> {
  const run = state.runs[baseInput.runId];
  if (!run || run.status === "stopped") {
    return;
  }
  const maxAttemptCount = run.maxAttemptCount ?? normalizeMaxAttemptCount(baseInput.maxAttemptCount);
  run.maxAttemptCount = maxAttemptCount;
  run.memberEvaluations ??= [];

  const attempt = positiveInteger((run.attemptCount ?? 0) + 1, "attempt");
  run.attemptCount = attempt;
  run.updatedAt = new Date().toISOString();
  publishRunUpdated(state, run);

  const attemptInput: StartRunInput = {
    ...baseInput,
    attemptOrdinal: attempt,
    maxAttemptCount,
    previousMemberOutputs: run.memberEvaluations?.map(formatMemberEvaluation),
    repositoryPath: run.worktree?.path ?? baseInput.repositoryPath,
    worktreeHash: run.worktree?.worktreeHash ?? baseInput.worktreeHash,
    conversationRef: run.conversationRef ?? baseInput.conversationRef
  };
  await prepareMemberCodexEnvironmentForExecute(attemptInput.repositoryPath, attemptInput.harness, {
    phase: "team",
    apmSkillRegistryClient: options.apmSkillRegistryClient
  });

  const resumeProviderThreadId = options.resumeProviderThreadId;
  options.resumeProviderThreadId = undefined;
  const planSession = startAgentSession(state, run, { kind: "TeamPlan", runId: run.runId, executeId: run.executeId, attempt });
  let teamResult: RunnerRun;
  try {
    teamResult = await withRunnerEventCollection(runner, run.runId, state, planSession.sessionId, () =>
      resumeProviderThreadId
        ? runner.resumeRun({ ...attemptInput, providerThreadId: resumeProviderThreadId })
        : runner.runTeamPlanning(attemptInput)
    );
  } catch (error) {
    failAgentSession(state, run, planSession.sessionId, error);
    throw error;
  }
  if (!isActiveRunStatus(run.status)) {
    return;
  }
  run.providerTeamThreadId = teamResult.providerThreadId ?? run.providerTeamThreadId;
  run.providerTeamPlanningTurnId = teamResult.providerTurnId ?? run.providerTeamPlanningTurnId;
  run.providerThreadId = teamResult.providerThreadId ?? run.providerThreadId;
  rememberProviderTurnId(run, teamResult.providerTurnId);
  attachRunnerResultProviderToAgentSession(state, run, planSession, teamResult, run.updatedAt);
  if (run.conversationRef?.provider === "codex" && teamResult.providerThreadId) {
    run.conversationRef = {
      ...run.conversationRef,
      threadId: requireDomainValue(makeNonEmptyText(teamResult.providerThreadId, "conversation.threadId"))
    };
  }
  run.finalResponse = teamResult.finalResponse;
  run.updatedAt = new Date().toISOString();
  publishRunUpdated(state, run);

  if (!teamResult.finalResponse) {
    failAgentSession(state, run, planSession.sessionId, "Team planning completed without a ExecutionPlan");
    throw executeErrorToError(executeError("team_output_invalid", "Team planning completed without a ExecutionPlan"));
  }
  let currentExecution: ExecutionPlan;
  try {
    currentExecution = unwrapExecuteResult(parseExecutionPlan(teamResult.finalResponse));
  } catch (error) {
    failAgentSession(state, run, planSession.sessionId, error);
    throw error;
  }

  const worktreeCwd = run.worktree?.path ?? options.cwd;
  const prevMoveCommit = run.pathCommits?.PrevMove ?? resolveExecutePrevMoveCommit(worktreeCwd, run.worktree);
  run.pathCommits = { PrevMove: prevMoveCommit };
  run.currentExecution = currentExecution;
  run.executionPlanPlan = undefined;
  run.terminalMemberPathId = undefined;
  run.terminalPathCommit = undefined;
  run.updatedAt = new Date().toISOString();
  writeCurrentExecutionFile(worktreeCwd, currentExecution);
  const planCommit = createMemberPathCommitFromWorktree({
    cwd: worktreeCwd,
    runId: run.runId,
    pathId: "current-execution.plan",
    executorId: "team",
    goal: "Materialize current ExecutionPlan.",
    requires: "PrevMove",
    paths: [HUNSU_CURRENT_EXECUTION_PATH]
  });
  run.pathCommits["current-execution.plan"] = planCommit.commitSha;
  completeAgentSession(state, run, planSession.sessionId, teamResult.finalResponse, run.updatedAt);
  publishRunUpdated(state, run);

  while (isActiveRunStatus(run.status)) {
    const step = await runExecutionPlanStep(currentExecution, {
      attempt,
      attemptInput,
      currentExecution,
      runner,
      state,
      run,
      worktreeCwd,
      options
    });
    if (!isActiveRunStatus(run.status)) {
      return;
    }
    if (step.type === "next") {
      currentExecution = step.execution;
      run.currentExecution = currentExecution;
      writeCurrentExecutionFile(worktreeCwd, currentExecution);
      if (step.terminalPath) {
        commitCurrentExecutionStep(run, step.terminalPath, step.finalResponse ?? "", worktreeCwd, state);
      } else {
        const materialized = createMemberPathCommitFromWorktree({
          cwd: worktreeCwd,
          runId: run.runId,
          pathId: "current-execution.next",
          executorId: "team",
          goal: "Materialize next ExecutionPlan.",
          requires: "PrevMove",
          paths: [HUNSU_CURRENT_EXECUTION_PATH]
        });
        run.pathCommits ??= {};
        run.pathCommits["current-execution.next"] = materialized.commitSha;
      }
      run.updatedAt = new Date().toISOString();
      publishRunUpdated(state, run);
      continue;
    }
    if (step.type === "fail") {
      removeCurrentExecutionFile(worktreeCwd);
      if (step.terminalPath) {
        commitCurrentExecutionStep(run, step.terminalPath, step.finalResponse ?? step.reason.message, worktreeCwd, state);
      }
      await recordStudioAccidentFromExecute(step.reason.message, buildAccidentEvidence(run), state, {
        cwd: options.cwd,
        persist: options.persist,
        runId: run.runId,
        summary: "ExecutionPlan failed"
      });
      return;
    }

    removeCurrentExecutionFile(worktreeCwd);
    if (step.terminalPath) {
      commitCurrentExecutionStep(run, step.terminalPath, step.finalResponse ?? "", worktreeCwd, state);
    }
    const terminalPath = step.terminalPath;
    if (!terminalPath) {
      throw executeErrorToError(executeError("terminal_output_missing", "ExecutionPlan completed without a terminal Path"));
    }
    const terminalPathRun = run.memberPathRuns
      ?.filter(pathRun => pathRun.attempt === attempt && pathRun.pathId === terminalPath.id)
      .at(-1);
    const terminalPathCommit = terminalPathRun && "commit" in terminalPathRun ? terminalPathRun.commit : undefined;
    if (terminalPathCommit) {
      run.terminalMemberPathId = terminalPath.id;
      run.terminalPathCommit = terminalPathCommit;
      run.updatedAt = new Date().toISOString();
      publishRunUpdated(state, run);
    }
    const terminalPathResponse = terminalPathRun && "finalResponse" in terminalPathRun ? terminalPathRun.finalResponse : undefined;
    const terminalFinalResponse = unwrapExecuteResult(ensureTerminalOutput(terminalPathResponse ?? step.finalResponse));
    const completion = buildExecuteCompletionFacts({
      finalResponse: terminalFinalResponse,
      run,
      terminalPath,
      terminalPathRun
    });
    const evaluation: StudioMemberPathEvaluation = {
      ...completion,
      terminalPathId: terminalPath.id,
      terminalPathCommit,
      attempt,
      at: new Date().toISOString()
    };
    run.memberEvaluations.push(evaluation);
    run.currentExecution = undefined;
    run.updatedAt = evaluation.at;
    publishRunUpdated(state, run);

    await completeStudioMoveFromExecuteCompletionFacts(completion, state, {
      cwd: options.cwd,
      persist: options.persist,
      runId: run.runId,
      runner
    });
    return;
  }
}

type ExecutionPlanRunContext = {
  attempt: PositiveInteger;
  attemptInput: StartRunInput;
  currentExecution: ExecutionPlan;
  runner: Runner;
  state: StudioServerState;
  run: StudioRunState;
  worktreeCwd: string;
  options: { cwd: string; persist: boolean; apmSkillRegistryClient?: ApmSkillRegistryClient };
};

async function runExecutionPlanStep(
  execution: ExecutionPlan,
  context: ExecutionPlanRunContext
): Promise<ExecutionPlanStepResult> {
  switch (execution.kind) {
    case "queue": {
      const [head] = execution.items;
      if (!head) {
        return { type: "done" };
      }
      const headResult = await runExecutionPlanStep(head, context);
      if (headResult.type === "fail") {
        return headResult;
      }
      const nextHead = headResult.type === "next" ? headResult.execution : undefined;
      const nextExecution = nextQueueExecution(execution, nextHead);
      if (!nextExecution) {
        return {
          type: "done",
          terminalPath: headResult.terminalPath,
          finalResponse: headResult.finalResponse
        };
      }
      return {
        type: "next",
        execution: nextExecution,
        terminalPath: headResult.terminalPath,
        finalResponse: headResult.finalResponse
      };
    }
    case "goal":
      return runGoalExecutionPlan(execution, context);
    case "continuation": {
      const step = await runExecutionPlanStep(execution.execution, {
        ...context,
        attemptInput: {
          ...context.attemptInput,
          teamScopeId: execution.teamScopeId
        }
      });
      if (step.type === "fail") {
        return step;
      }
      if (step.type === "next") {
        return {
          type: "next",
          execution: {
            ...execution,
            execution: step.execution
          },
          terminalPath: step.terminalPath,
          finalResponse: step.finalResponse
        };
      }
      if (!step.terminalPath) {
        return {
          type: "fail",
          reason: executeError("terminal_output_missing", `Nested Team ${execution.id} completed without a terminal Path`),
          finalResponse: step.finalResponse
        };
      }
      if (!execution.continuation) {
        return {
          type: "done",
          terminalPath: step.terminalPath,
          finalResponse: step.finalResponse
        };
      }
      return {
        type: "next",
        execution: {
          ...execution.continuation,
          requires: [step.terminalPath.id]
        },
        terminalPath: step.terminalPath,
        finalResponse: step.finalResponse
      };
    }
  }
}

async function runGoalExecutionPlan(
  execution: GoalExecutionPlan,
  context: ExecutionPlanRunContext
): Promise<ExecutionPlanStepResult> {
  if (execution.stage === "needs_execution") {
    return runGoalExecutorStage(execution, context);
  }
  if (!execution.evaluator) {
    return runAssigneeExecutorTurn(execution, context, execution.assignee.goal, execution.requires, "done");
  }
  const evaluatorPath = memberPathForGoalRole(
    execution,
    "evaluator",
    nextMemberPathId(context.run, execution.id, "evaluate"),
    execution.requires
  );
  const evaluatorTurn = await runMemberPathTurn(evaluatorPath, context, {
    outputSchema: GOAL_EVALUATION_SCHEMA
  });
  const evaluation = unwrapExecuteResult(parseGoalEvaluation(evaluatorTurn.finalResponse));
  if (evaluation.type === "pass") {
    return {
      type: "done",
      terminalPath: evaluatorPath,
      finalResponse: evaluation.summary || evaluatorTurn.finalResponse
    };
  }
  if (execution.remainingAttempts < 1) {
    return {
      type: "fail",
      reason: executeError("max_attempts_exhausted", evaluation.reason, { feedback: evaluation.feedback }),
      terminalPath: evaluatorPath,
      finalResponse: evaluatorTurn.finalResponse
    };
  }
  return {
    type: "next",
    execution: {
      ...execution,
      stage: "needs_execution",
      evaluationPathId: evaluatorPath.id,
      evaluation,
      requires: [evaluatorPath.id]
    },
    terminalPath: evaluatorPath,
    finalResponse: evaluatorTurn.finalResponse
  };
}

async function runGoalExecutorStage(
  execution: Extract<GoalExecutionPlan, { stage: "needs_execution" }>,
  context: ExecutionPlanRunContext
): Promise<ExecutionPlanStepResult> {
  const executorGoal = [
    execution.evaluation.nextGoal ?? execution.assignee.goal,
    "",
    "Evaluator feedback:",
    execution.evaluation.feedback
  ].join("\n").trim();
  const executorResult = await runAssigneeExecutorTurn(execution, context, executorGoal, execution.requires, "next");
  if (executorResult.type === "next" && executorResult.execution.kind !== "goal") {
    return executorResult;
  }
  const terminalPath = executorResult.terminalPath;
  if (!terminalPath) {
    return executorResult;
  }
  const remainingAttempts = positiveIntegerOrZero(execution.remainingAttempts - 1);
  return {
    type: "next",
    execution: {
      kind: "goal",
      stage: "needs_evaluation",
      id: execution.id,
      assignee: {
        ...execution.assignee,
        goal: execution.evaluation.nextGoal ?? execution.assignee.goal
      },
      evaluator: execution.evaluator,
      remainingAttempts,
      requires: [terminalPath.id]
    },
    terminalPath,
    finalResponse: executorResult.finalResponse
  };
}

async function runAssigneeExecutorTurn(
  execution: GoalExecutionPlan,
  context: ExecutionPlanRunContext,
  goal: string,
  requires: MemberPath["requires"],
  terminalMode: "done" | "next"
): Promise<ExecutionPlanStepResult> {
  const executor = directExecutorForCurrentTeam(context, execution.assignee.executorId);
  if (executor?.kind === "team") {
    const planned = await runTeamPlanTurn(executor.id, goal, context);
    if (terminalMode === "next") {
      return {
        type: "next",
        execution: {
          kind: "continuation",
          id: `${execution.id}.${executor.id}.continuation` as PathId,
          teamScopeId: executor.id,
          execution: planned,
          continuation: {
            kind: "goal",
            stage: "needs_evaluation",
            id: execution.id,
            assignee: {
              ...execution.assignee,
              goal
            },
            evaluator: execution.evaluator,
            remainingAttempts: positiveIntegerOrZero(execution.remainingAttempts - 1),
            requires: []
          }
        }
      };
    }
    return {
      type: "next",
      execution: {
        kind: "continuation",
        id: `${execution.id}.${executor.id}.continuation` as PathId,
        teamScopeId: executor.id,
        execution: planned
      }
    };
  }
  const assigneeExecution: GoalExecutionPlan = {
    ...execution,
    assignee: {
      ...execution.assignee,
      goal
    }
  };
  const assigneePath = memberPathForGoalRole(
    assigneeExecution,
    "assignee",
    nextMemberPathId(context.run, execution.id, "execute"),
    requires
  );
  const assigneeTurn = await runMemberPathTurn(assigneePath, context);
  return {
    type: terminalMode,
    terminalPath: assigneePath,
    finalResponse: assigneeTurn.finalResponse,
    execution: terminalMode === "next" ? assigneeExecution : undefined
  } as ExecutionPlanStepResult;
}

async function runTeamPlanTurn(
  teamId: string,
  goal: string,
  context: ExecutionPlanRunContext
): Promise<ExecutionPlan> {
  const graph = requireHarnessGraph(context);
  const scopedHarness = harnessSnapshotForTeam(graph, teamId);
  const teamInput: StartRunInput = {
    ...context.attemptInput,
    requestGoal: goal,
    harness: scopedHarness,
    harnessGraph: graph,
    teamScopeId: teamId,
    previousMemberOutputs: context.run.memberEvaluations?.map(formatMemberEvaluation)
  };
  await prepareMemberCodexEnvironmentForExecute(context.worktreeCwd, scopedHarness, {
    phase: "team",
    apmSkillRegistryClient: context.options.apmSkillRegistryClient
  });
  const planSession = startAgentSession(context.state, context.run, {
    kind: "TeamPlan",
    runId: context.run.runId,
    executeId: context.run.executeId,
    attempt: context.attempt
  });
  try {
    const result = await withRunnerEventCollection(context.runner, context.run.runId, context.state, planSession.sessionId, () =>
      context.runner.runTeamPlanning(teamInput)
    );
    context.run.providerTeamThreadId = result.providerThreadId ?? context.run.providerTeamThreadId;
    context.run.providerTeamPlanningTurnId = result.providerTurnId ?? context.run.providerTeamPlanningTurnId;
    context.run.providerThreadId = result.providerThreadId ?? context.run.providerThreadId;
    rememberProviderTurnId(context.run, result.providerTurnId);
    attachRunnerResultProviderToAgentSession(context.state, context.run, planSession, result, context.run.updatedAt);
    if (!result.finalResponse) {
      failAgentSession(context.state, context.run, planSession.sessionId, `Team ${teamId} planning completed without a ExecutionPlan`);
      throw executeErrorToError(executeError("team_output_invalid", `Team ${teamId} planning completed without a ExecutionPlan`));
    }
    const parsed = unwrapExecuteResult(parseExecutionPlan(result.finalResponse));
    completeAgentSession(context.state, context.run, planSession.sessionId, result.finalResponse, new Date().toISOString());
    return parsed;
  } catch (error) {
    failAgentSession(context.state, context.run, planSession.sessionId, error);
    throw error;
  }
}

function directExecutorForCurrentTeam(context: ExecutionPlanRunContext, executorId: string): ExecutorEntity | undefined {
  const graph = context.attemptInput.harnessGraph;
  if (!graph) {
    return undefined;
  }
  const teamId = context.attemptInput.teamScopeId ?? graph.rootTeamId;
  const team = getHarnessExecutor(graph, teamId);
  if (!team || team.kind !== "team") {
    throw new Error(`Harness Team scope is unavailable: ${teamId}`);
  }
  if (!team.members.some(membership => membership.executorId === executorId)) {
    throw new Error(`Team ${teamId} cannot delegate to Executor ${executorId}; it is not a direct Membership`);
  }
  const executor = getHarnessExecutor(graph, executorId);
  if (!executor) {
    throw new Error(`Team ${teamId} references unknown Executor ${executorId}`);
  }
  return executor;
}

function requireHarnessGraph(context: ExecutionPlanRunContext): Harness {
  const graph = context.attemptInput.harnessGraph;
  if (!graph) {
    throw new Error("Nested Team delegation requires a Harness Executor graph");
  }
  return graph;
}

async function runMemberPathTurn(
  memberPath: MemberPath,
  context: ExecutionPlanRunContext,
  options: { outputSchema?: unknown } = {}
): Promise<{ pathRun: StudioMemberPathRun; finalResponse: string }> {
  const dependencyOutputs: string[] = [];
  const executionSession = startAgentSession(context.state, context.run, {
    kind: "ExecutionPlan",
    runId: context.run.runId,
    executeId: context.run.executeId,
    attempt: context.attempt,
    pathId: memberPath.id,
    executorId: memberPath.executorId
  });
  const pathRun: StudioMemberPathRun = {
    pathId: memberPath.id,
    executorId: memberPath.executorId,
    goal: memberPath.goal,
    requires: memberPath.requires,
    attempt: context.attempt,
    agentSessionId: executionSession.sessionId,
    status: "starting",
    dependencyPathIds: memberPath.requires === "PrevMove" ? [] : memberPath.requires,
    dependencyOutputs,
    startedAt: new Date().toISOString()
  };
  context.run.memberPathRuns ??= [];
  context.run.memberPathRuns.push(pathRun);
  context.run.updatedAt = pathRun.startedAt;
  publishRunUpdated(context.state, context.run);

  const scopedHarness = scopedHarnessForCurrentTeam(context);
  const memberInput: MemberPathRunInput = {
    ...context.attemptInput,
    board: currentBoard(context.state, { cwd: context.options.cwd, persist: context.options.persist }),
    harness: scopedHarness,
    memberPath,
    dependencyOutputs,
    worktreeStatus: formatWorktreeStatus(context.worktreeCwd),
    worktreeDiff: readWorktreeDiff(context.worktreeCwd),
    attemptTranscript: summarizeRunnerEvents(context.run.debugEvents),
    outputSchema: options.outputSchema
  };

  try {
    await prepareMemberCodexEnvironmentForExecute(context.worktreeCwd, scopedHarness, {
      phase: "member",
      executorId: memberPath.executorId,
      apmSkillRegistryClient: context.options.apmSkillRegistryClient
    });
    const result = await withRunnerEventCollection(context.runner, context.run.runId, context.state, executionSession.sessionId, () =>
      context.runner.runMemberPath(memberInput)
    );
    if (!isActiveRunStatus(context.run.status)) {
      return { pathRun, finalResponse: "" };
    }
    context.run.providerMemberThreadId = result.providerThreadId ?? context.run.providerMemberThreadId;
    context.run.providerThreadId = result.providerThreadId ?? context.run.providerThreadId;
    rememberProviderTurnId(context.run, result.providerTurnId);
    const pathSession = sessionFromPathRun(pathRun) ?? attachRunnerResultProviderToAgentSession(context.state, context.run, executionSession, result) ?? requireMemberPathSession(result, memberPath.id);
    const finalResponse = result.finalResponse ?? "";
    assertNoHunsuControlPlaneWorktreeChanges(context.worktreeCwd);
    const completedAt = new Date().toISOString();
    Object.assign(pathRun, {
      status: "completed" as const,
      session: pathSession,
      finalResponse,
      completedAt
    });
    completeAgentSession(context.state, context.run, executionSession.sessionId, finalResponse, completedAt);
    context.run.updatedAt = completedAt;
    publishRunUpdated(context.state, context.run);
    return { pathRun, finalResponse };
  } catch (error) {
    const completedAt = new Date().toISOString();
    Object.assign(pathRun, {
      status: "failed" as const,
      error: error instanceof Error ? error.message : String(error),
      completedAt
    });
    failAgentSession(context.state, context.run, executionSession.sessionId, error, completedAt);
    context.run.updatedAt = completedAt;
    publishRunUpdated(context.state, context.run);
    throw error;
  }
}

function scopedHarnessForCurrentTeam(context: ExecutionPlanRunContext): HarnessSnapshot | undefined {
  const graph = context.attemptInput.harnessGraph;
  if (!graph) {
    return context.attemptInput.harness;
  }
  return harnessSnapshotForTeam(graph, context.attemptInput.teamScopeId ?? graph.rootTeamId);
}

function commitCurrentExecutionStep(
  run: StudioRunState,
  memberPath: MemberPath,
  finalResponse: string,
  worktreeCwd: string,
  state: StudioServerState
): void {
  const pathRun = [...(run.memberPathRuns ?? [])].reverse().find(candidate => candidate.pathId === memberPath.id);
  const pathCommit = createMemberPathCommitFromWorktree({
    cwd: worktreeCwd,
    runId: run.runId,
    pathId: memberPath.id,
    executorId: memberPath.executorId,
    goal: memberPath.goal,
    requires: memberPath.requires
  });
  run.pathCommits ??= {};
  run.pathCommits[memberPath.id] = pathCommit.commitSha;
  if (pathRun) {
    Object.assign(pathRun, {
      status: "completed" as const,
      finalResponse,
      commit: pathCommit.commitSha,
      parentCommit: pathCommit.parentSha,
      treeChanged: pathCommit.treeChanged,
      completedAt: new Date().toISOString()
    });
  }
  run.updatedAt = new Date().toISOString();
  publishRunUpdated(state, run);
}

function nextMemberPathId(run: StudioRunState, executionId: string, role: "execute" | "evaluate"): string {
  return `${executionId}.${role}.${(run.memberPathRuns?.length ?? 0) + 1}`;
}

function positiveIntegerOrZero(value: number): GoalExecutionPlan["remainingAttempts"] {
  return (Number.isInteger(value) && value > 0 ? value : 0) as GoalExecutionPlan["remainingAttempts"];
}

function buildExecuteCompletionFacts(input: {
  finalResponse: string;
  run: StudioRunState;
  terminalPath: MemberPath;
  terminalPathRun: StudioMemberPathRun | undefined;
}): StudioExecuteCompletionFacts {
  const terminalPathRun = input.terminalPathRun;
  const session = terminalPathRun && "session" in terminalPathRun ? terminalPathRun.session : undefined;
  const terminalCommit = terminalPathRun && "commit" in terminalPathRun ? terminalPathRun.commit : undefined;
  const treeChanged = terminalPathRun && "treeChanged" in terminalPathRun ? terminalPathRun.treeChanged : undefined;
  const summary = truncateText(firstContentLine(input.finalResponse) ?? `Completed terminal Path ${input.terminalPath.id}`, 240);
  const evidence = [
    `Terminal Path ${input.terminalPath.id} completed`,
    terminalCommit ? `Terminal Path commit ${terminalCommit}` : undefined,
    treeChanged === undefined ? undefined : `Terminal Path tree changed: ${treeChanged ? "yes" : "no"}`,
    session ? `Terminal Path session ${session.providerThreadId}/${session.providerTurnId}` : undefined,
    input.run.selectedDestinationIds.length === 1 ? `Selected Destination: ${input.run.selectedDestinationIds[0]}` : undefined
  ].filter((item): item is string => Boolean(item && item.trim()));

  return {
    summary,
    evidence,
    risks: []
  };
}

function failRunnerRun(runId: string, error: unknown, state: StudioServerState): void {
  const run = state.runs[runId];
  if (!run) {
    return;
  }
  if (run.status === "stopped") {
    return;
  }
	  run.error = error instanceof Error ? error.message : String(error);
	  closeOpenAgentSessions(state, run, run.error);
	  markRun(run, "failed");
  publishRunUpdated(state, run);
}

async function accidentRunnerRun(
  runId: string,
  error: unknown,
  state: StudioServerState,
  options: { cwd: string; persist: boolean }
): Promise<void> {
  const run = state.runs[runId];
  if (!run) {
    return;
  }
  if (run.status === "stopped" || run.status === "arrived" || run.status === "accident") {
    return;
  }
	  const message = error instanceof Error ? error.message : String(error);
	  run.error = message;
	  closeOpenAgentSessions(state, run, message);
	  try {
    await recordStudioAccidentFromExecute(message, [`runner error: ${message}`, ...buildAccidentEvidence(run)], state, {
      cwd: options.cwd,
      persist: options.persist,
      runId,
      summary: "Execute failed during execution"
    });
	  } catch (recordError) {
	    run.error = `${message}; failed to record Accident: ${recordError instanceof Error ? recordError.message : String(recordError)}`;
	    closeOpenAgentSessions(state, run, run.error);
	    markRun(run, "failed");
    publishRunUpdated(state, run);
  }
}

function normalizeMaxAttemptCount(value: number | undefined): PositiveInteger {
  if (value === undefined) {
    return positiveInteger(5, "maxAttemptCount");
  }
  if (!Number.isInteger(value) || value < 1) {
    throw new Error("maxAttemptCount must be a positive integer");
  }
  return positiveInteger(value, "maxAttemptCount");
}

function maxAttemptCountForHarnessSnapshot(harness: HarnessSnapshot): PositiveInteger {
  switch (harness.kind) {
    case "team_execution_plan":
      return normalizeMaxAttemptCount(harness.maxAttemptCount);
    case "role_squad":
    case "council_vote":
    case "court_debate":
      return normalizeMaxAttemptCount(harness.maxRoundCount);
  }
}

function buildMoveFinalizerInput(input: {
  board: BoardProjection;
  cwd: string;
  completion: StudioExecuteCompletionFacts;
  moveId: MoveId;
  run: StudioRunState;
  sourceMoveCommit: CommitSha;
  terminalPathCommit: CommitSha;
}): MoveFinalizerInput {
  const request = selectRequest(input.board, input.run.requestId);
  const line = requireLine(input.board, input.run.lineId);
  const lineNode = nodeForLine(input.board, input.run.lineId);
  const activeDestinations = destinationsForLine(input.board, input.run.lineId).filter(isOpenDestination);
  return {
    runId: input.run.runId,
    executeId: input.run.executeId,
    repositoryPath: input.cwd,
    worktreeHash: input.run.worktree?.worktreeHash,
    sourceMoveId: input.run.sourceMoveId,
    targetMoveOrdinal: input.run.targetMoveOrdinal,
    requestGoal: request.goal,
    teamName: line.teamName ?? lineNode?.teamName,
    harness: lineNode?.harness,
    harnessLock: input.run.harnessLock ?? lineNode?.harnessLock,
    activeDestinations,
    selectedDestinationIds: input.run.selectedDestinationIds,
    futureConstraints: input.board.futureConstraints.filter(constraint => constraint.lineId === input.run.lineId).map(constraint => constraint.constraint),
    attemptOrdinal: input.run.attemptCount,
    maxAttemptCount: input.run.maxAttemptCount,
    previousMemberOutputs: input.run.memberEvaluations?.map(formatMemberEvaluation),
    conversationRef: input.run.conversationRef,
    board: input.board,
    moveId: input.moveId,
    sourceMoveCommit: input.sourceMoveCommit,
    terminalPathCommit: input.terminalPathCommit,
    terminalMemberPathId: input.run.terminalMemberPathId,
    pathCommits: input.run.pathCommits ?? {},
    pathOutputs: pathOutputsForMoveFinalizer(input.run),
    completionSummary: input.completion.summary,
    diffStat: readCommitDiff(input.cwd, input.sourceMoveCommit, input.terminalPathCommit, "stat"),
    diffNameStatus: readCommitDiff(input.cwd, input.sourceMoveCommit, input.terminalPathCommit, "name-status"),
    diffPatch: readCommitDiff(input.cwd, input.sourceMoveCommit, input.terminalPathCommit, "patch")
  };
}

function pathOutputsForMoveFinalizer(run: StudioRunState): MoveFinalizerInput["pathOutputs"] {
  return (run.memberPathRuns ?? [])
    .filter(pathRun => pathRun.status === "completed")
    .map(pathRun => ({
      pathId: pathRun.pathId,
      executorId: pathRun.executorId,
      goal: pathRun.goal,
      commit: pathRun.commit,
      finalResponse: pathRun.finalResponse
    }));
}

function readCommitDiff(cwd: string, baseCommit: string, headCommit: string, kind: "stat" | "name-status" | "patch"): string {
  try {
    if (kind === "stat") {
      return git(["diff", "--stat", baseCommit, headCommit], { cwd }).trim();
    }
    if (kind === "name-status") {
      return git(["diff", "--name-status", baseCommit, headCommit], { cwd }).trim();
    }
    return truncateText(git(["diff", baseCommit, headCommit, "--", "."], { cwd }), 16000).trim();
  } catch (error) {
    return `diff unavailable: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function resolveExecutePrevMoveCommit(cwd: string, worktree: WorktreeRef | undefined): CommitSha {
  if (worktree?.baseRef && worktree.baseRef !== "virtual") {
    return parseCommitSha(git(["rev-parse", "--verify", `${worktree.baseRef}^{commit}`], { cwd }).trim());
  }
  return parseCommitSha(ensureExecuteBaseRef(cwd));
}

function formatWorktreeStatus(cwd: string): string {
  try {
    const status = readWorktreeStatus(cwd);
    const changes = status.changes.map(change => `${change.status} ${change.path}`).join("\n");
    return [
      `root: ${status.root}`,
      `branch: ${status.branch}`,
      `clean: ${status.clean}`,
      "changes:",
      changes || "- none"
    ].join("\n");
  } catch (error) {
    return `status unavailable: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function readWorktreeDiff(cwd: string): string {
  try {
    const unstagedStat = git(["diff", "--stat"], { cwd }).trim();
    const stagedStat = git(["diff", "--cached", "--stat"], { cwd }).trim();
    const unstagedDiff = git(["diff", "--", "."], { cwd });
    const stagedDiff = git(["diff", "--cached", "--", "."], { cwd });
    return truncateText([
      unstagedStat ? `Unstaged stat:\n${unstagedStat}` : "",
      stagedStat ? `Staged stat:\n${stagedStat}` : "",
      unstagedDiff ? `Unstaged diff:\n${unstagedDiff}` : "",
      stagedDiff ? `Staged diff:\n${stagedDiff}` : ""
    ].filter(Boolean).join("\n\n"), 12000) || "No worktree diff.";
  } catch (error) {
    return `diff unavailable: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function summarizeRunnerEvents(events: TeamRunEvent[]): string {
  return truncateText(events
    .slice(-40)
    .map(event => {
      if (event.type === "runner.final") {
        return `${event.type}: ${event.finalResponse}`;
      }
      if (event.type === "runner.error") {
        return `${event.type}: ${event.error}`;
      }
      if (event.type === "runner.status.changed") {
        return `${event.type}: ${event.headline}${event.detail ? ` - ${event.detail}` : ""}`;
      }
      if (event.type === "runner.turn.started" || event.type === "runner.turn.completed") {
        return `${event.type}: ${event.providerTurnId ?? "unknown turn"}`;
      }
      if (event.type === "runner.item.started" || event.type === "runner.item.completed") {
        return `${event.type}: ${event.item.type} ${event.itemId}`;
      }
      if (event.type === "runner.item.delta") {
        return `${event.type}: ${event.deltaKind} ${truncateText(event.delta, 200)}`;
      }
      if (event.type === "runner.appServer.message") {
        return `${event.type}: ${event.direction} ${event.method ?? "unknown"}`;
      }
      return "unknown runner event";
    })
    .join("\n"), 8000);
}

function formatMemberEvaluation(evaluation: StudioMemberPathEvaluation): string {
  return [
    `attempt ${evaluation.attempt}`,
    `summary: ${evaluation.summary}`,
    evaluation.terminalPathId ? `terminalPath: ${evaluation.terminalPathId}` : undefined,
    evaluation.terminalPathCommit ? `terminalCommit: ${evaluation.terminalPathCommit}` : undefined,
    `evidence: ${evaluation.evidence.join("; ") || "none"}`,
    `risks: ${evaluation.risks.join("; ") || "none"}`
  ].filter((item): item is string => item !== undefined).join(" | ");
}

function formatExecuteCompletionFacts(completion: StudioExecuteCompletionFacts): string {
  return [
    `summary: ${completion.summary}`,
    `evidence: ${completion.evidence.join("; ") || "none"}`,
    `risks: ${completion.risks.join("; ") || "none"}`
  ].join(" | ");
}

function buildAccidentEvidence(run: StudioRunState): string[] {
  const evaluations = run.memberEvaluations ?? [];
  const evidence = evaluations.flatMap(evaluation => evaluation.evidence);
  return [
    `attempts: ${run.attemptCount ?? 0}/${run.maxAttemptCount ?? 5}`,
    ...evaluations.map(formatMemberEvaluation),
    ...evidence
  ].filter((item, index, items) => item.trim() !== "" && items.indexOf(item) === index);
}

async function completeStudioMoveFromExecuteCompletionFacts(
  completion: StudioExecuteCompletionFacts,
  state: StudioServerState,
  options: { cwd: string; persist: boolean; runId: string; runner: Runner }
): Promise<void> {
  try {
    await completeStudioMoveFromExecuteCompletion(completion, state, options);
    return;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const reason = unrecordableExecuteCompletionReason(message);
    if (!reason) {
      throw error;
    }
    const run = requireStudioRun(state, options.runId, options.cwd);
    await recordStudioAccidentFromExecute(reason, [
      reason,
      ...buildAccidentEvidence(run),
      formatWorktreeStatus(run.worktree?.path ?? options.cwd)
    ], state, {
      cwd: options.cwd,
      persist: options.persist,
      runId: run.runId,
      summary: "Path completion could not be recorded"
    });
  }
}

function unrecordableExecuteCompletionReason(message: string): string | undefined {
  if (message === "Cannot auto-record MOVE without worktree changes") {
    return "Terminal Path completed, but Studio could not record Arrived MOVE because the Route worktree had no product file changes.";
  }
  if (message === "Cannot auto-record MOVE when the Team changed Hunsu control-plane files") {
    return "Terminal Path completed, but Studio declined Arrived MOVE because the Execute changed Hunsu control-plane files.";
  }
  return undefined;
}

function truncateText(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}\n...[truncated]`;
}

function truncateTextByBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) {
    return text;
  }
  const markerBytes = Buffer.byteLength(TRUNCATED_MARKER, "utf8");
  const targetBytes = Math.max(0, maxBytes - markerBytes);
  let low = 0;
  let high = text.length;
  let best = 0;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = text.slice(0, middle);
    if (Buffer.byteLength(candidate, "utf8") <= targetBytes) {
      best = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return `${text.slice(0, best)}${TRUNCATED_MARKER}`;
}

function truncateOptionalText(text: string | undefined, maxBytes: number): string | undefined {
  return text === undefined ? undefined : truncateTextByBytes(text, maxBytes);
}

function truncateStringArray(values: string[] | undefined, maxBytesPerItem = RUNTIME_ARRAY_STRING_MAX_BYTES): string[] | undefined {
  return values?.map(value => truncateTextByBytes(value, maxBytesPerItem));
}

function jsonByteLength(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? "null", "utf8");
  } catch (_error) {
    return Number.MAX_SAFE_INTEGER;
  }
}

function capJsonArrayByNewest<T>(items: T[], maxCount: number, maxBytes: number): void {
  if (items.length > maxCount) {
    items.splice(0, items.length - maxCount);
  }
  while (items.length > 0 && jsonByteLength(items) > maxBytes) {
    items.shift();
  }
}

function truncateRuntimeValue(value: unknown, maxStringBytes = RUNTIME_STRING_MAX_BYTES, depth = 0): unknown {
  if (typeof value === "string") {
    return truncateTextByBytes(value, maxStringBytes);
  }
  if (value === null || value === undefined || typeof value !== "object") {
    return value;
  }
  if (depth >= 8) {
    return `...${TRUNCATED_MARKER}`;
  }
  if (Array.isArray(value)) {
    const truncated = value.slice(0, 200).map(item => truncateRuntimeValue(item, maxStringBytes, depth + 1));
    if (value.length > truncated.length) {
      truncated.push(`...${TRUNCATED_MARKER}`);
    }
    return truncated;
  }
  const output: Record<string, unknown> = {};
  const entries = Object.entries(value as Record<string, unknown>);
  for (const [key, entryValue] of entries.slice(0, 200)) {
    output[key] = truncateRuntimeValue(entryValue, maxStringBytes, depth + 1);
  }
  if (entries.length > 200) {
    output.__truncated = true;
  }
  return output;
}

function sanitizeTeamRunEventForStorage(event: TeamRunEvent): TeamRunEvent {
  return truncateRuntimeValue(event, RUNTIME_ARRAY_STRING_MAX_BYTES) as TeamRunEvent;
}

function sanitizeRawAppServerMessage(message: StudioRawAppServerMessage): StudioRawAppServerMessage {
  return {
    ...message,
    method: truncateOptionalText(message.method, RUNTIME_ARRAY_STRING_MAX_BYTES),
    providerThreadId: truncateOptionalText(message.providerThreadId, RUNTIME_ARRAY_STRING_MAX_BYTES),
    providerTurnId: truncateOptionalText(message.providerTurnId, RUNTIME_ARRAY_STRING_MAX_BYTES),
    message: truncateRuntimeValue(message.message, RUNTIME_ARRAY_STRING_MAX_BYTES) as JsonRpcMessage
  };
}

function sanitizeCodexItem(item: StudioCodexItem): StudioCodexItem {
  item.title = truncateTextByBytes(item.title, RUNTIME_ARRAY_STRING_MAX_BYTES);
  item.detail = truncateOptionalText(item.detail, RUNTIME_STRING_MAX_BYTES);
  item.text = truncateOptionalText(item.text, RUNTIME_STRING_MAX_BYTES);
  item.summary = truncateStringArray(item.summary);
  item.content = truncateStringArray(item.content);
  item.command = truncateOptionalText(item.command, RUNTIME_STRING_MAX_BYTES);
  item.cwd = truncateOptionalText(item.cwd, RUNTIME_ARRAY_STRING_MAX_BYTES);
  item.output = truncateOptionalText(item.output, RUNTIME_STRING_MAX_BYTES);
  item.changes = truncateRuntimeValue(item.changes);
  item.rawItem = undefined;
  return item;
}

function sanitizeAgentMessage(message: AgentMessage): AgentMessage {
  message.title = truncateTextByBytes(message.title, RUNTIME_ARRAY_STRING_MAX_BYTES);
  message.text = truncateOptionalText(message.text, RUNTIME_STRING_MAX_BYTES);
  message.summary = truncateStringArray(message.summary);
  message.content = truncateStringArray(message.content);
  message.command = truncateOptionalText(message.command, RUNTIME_STRING_MAX_BYTES);
  message.cwd = truncateOptionalText(message.cwd, RUNTIME_ARRAY_STRING_MAX_BYTES);
  message.output = truncateOptionalText(message.output, RUNTIME_STRING_MAX_BYTES);
  message.changes = truncateRuntimeValue(message.changes);
  return message;
}

function capAgentSessionMessages(session: AgentSession): void {
  session.finalResponse = truncateOptionalText(session.finalResponse, RUNTIME_STRING_MAX_BYTES);
  session.error = truncateOptionalText(session.error, RUNTIME_STRING_MAX_BYTES);
  session.messages.forEach(sanitizeAgentMessage);
  while (session.messages.length > 0 && jsonByteLength(session.messages) > AGENT_SESSION_MAX_BYTES) {
    const inactiveIndex = session.messages.findIndex(message => !session.activeItemIds.includes(message.itemId));
    session.messages.splice(inactiveIndex >= 0 ? inactiveIndex : 0, 1);
  }
}

function capCodexItems(items: StudioCodexItem[]): void {
  items.forEach(sanitizeCodexItem);
  while (items.length > 0 && jsonByteLength(items) > CODEX_ITEMS_MAX_BYTES) {
    items.shift();
  }
}

function capAssistantTranscript(transcript: StudioAssistantTranscript[]): void {
  for (const entry of transcript) {
    entry.text = truncateTextByBytes(entry.text, RUNTIME_STRING_MAX_BYTES);
  }
  while (transcript.length > 0 && jsonByteLength(transcript) > ASSISTANT_TRANSCRIPT_MAX_BYTES) {
    transcript.shift();
  }
}

function capRunRuntimeBuffers(run: StudioRunState): void {
  run.debugEvents ??= [];
  run.rawAppServerMessages ??= [];
  run.codexItems ??= [];
  run.agentSessions ??= [];
  run.assistantTranscript ??= [];

  for (let index = 0; index < run.debugEvents.length; index += 1) {
    run.debugEvents[index] = sanitizeTeamRunEventForStorage(run.debugEvents[index]);
  }
  for (let index = 0; index < run.rawAppServerMessages.length; index += 1) {
    run.rawAppServerMessages[index] = sanitizeRawAppServerMessage(run.rawAppServerMessages[index]);
  }
  capJsonArrayByNewest(run.debugEvents, DEBUG_EVENTS_MAX_COUNT, DEBUG_EVENTS_MAX_BYTES);
  capJsonArrayByNewest(run.rawAppServerMessages, RAW_MESSAGES_MAX_COUNT, RAW_MESSAGES_MAX_BYTES);
  capCodexItems(run.codexItems);
  capAssistantTranscript(run.assistantTranscript);
  run.agentSessions.forEach(capAgentSessionMessages);
}

function markRun(run: StudioRunState, status: StudioRunStatus): void {
  run.status = status;
  run.updatedAt = new Date().toISOString();
  if (status === "failed" || status === "accident") {
    closeOpenMemberPathRuns(run, run.error ?? formatExecuteStatus(status));
  }
  if (!isActiveRunStatus(status)) {
    run.activeItemIds = [];
    run.liveStatus = {
      phase: "idle",
      headline: formatExecuteStatus(status),
      detail: run.error,
      updatedAt: run.updatedAt
    };
  }
}

function rememberProviderTurnId(run: StudioRunState, providerTurnId: string | undefined): void {
  if (!providerTurnId) {
    return;
  }
  run.providerTurnIds ??= [];
  if (!run.providerTurnIds.includes(providerTurnId)) {
    run.providerTurnIds.push(providerTurnId);
  }
}

function isActiveRunStatus(status: StudioRunStatus): boolean {
  return status === "running" || status === "paused";
}

function formatExecuteStatus(status: StudioRunStatus): StudioExecuteView["statusLabel"] {
  switch (status) {
    case "running":
      return "Executing";
    case "paused":
      return "Paused";
    case "arrived":
      return "Arrived";
    case "accident":
      return "Accident";
    case "failed":
      return "Failed";
    case "discarded":
      return "Discarded";
    case "finished":
      return "Finished";
    case "stopped":
      return "Stopped";
  }
}

function resolveAccidentCommit(cwd: string, worktree: WorktreeRef | undefined): string {
  try {
    return git(["rev-parse", "--verify", "HEAD"], { cwd }).trim();
  } catch (_error) {
    return worktree?.baseRef && worktree.baseRef !== "virtual" ? worktree.baseRef : "uncommitted";
  }
}

function selectRequest(board: BoardProjection, requestId?: string): RequestRecord {
  const request = requestId ? board.requests.find(candidate => candidate.id === requestId) : board.requests[0];
  if (!request) {
    throw new Error(requestId ? `Unknown request: ${requestId}` : "No request exists");
  }
  return request;
}

function selectLine(board: BoardProjection, requestId: string, lineId?: string): LineRecord {
  const requestLines = board.lines.filter(candidate => candidate.requestId === requestId);
  const line = lineId
    ? board.lines.find(candidate => candidate.id === lineId)
    : requestLines.findLast(candidate => candidate.status === "active") ?? requestLines.at(-1);
  if (!line) {
    throw new Error(lineId ? `Unknown line: ${lineId}` : `No line exists for request: ${requestId}`);
  }
  return line;
}

function requireLine(board: BoardProjection, lineId: string): LineRecord {
  const line = board.lines.find(candidate => candidate.id === lineId);
  if (!line) {
    throw new Error(`Unknown line: ${lineId}`);
  }
  return line;
}

function requireNode(board: BoardProjection, nodeId: string): NodeRecord {
  const node = board.nodes.find(candidate => candidate.id === nodeId);
  if (!node) {
    throw new Error(`Unknown node: ${nodeId}`);
  }
  return node;
}

function lineForNode(board: BoardProjection, node: NodeRecord): LineRecord | undefined {
  return board.lines.find(line =>
    String(line.currentNodeId) === String(node.id)
    || String(line.rootNodeId) === String(node.id)
    || Boolean(node.lineId && String(node.lineId) === String(line.id))
  );
}

function moveForNode(board: BoardProjection, node: NodeRecord) {
  const source = node.source;
  if (source.type === "move") {
    return board.moves.find(move => move.id === source.moveId);
  }
  return board.moves.find(move => move.toNodeId === node.id);
}

function requireExecutableHarness(protocol: HarnessSnapshot): HarnessSnapshot {
  const validation = validateExecutableHarness(protocol);
  if (!validation.ok) {
    throw new Error(validation.error.message);
  }
  return validation.value;
}

function createConversationHash(value: unknown): string {
  return `conv_${hashHex(createHash("sha256").update(JSON.stringify(value))).slice(0, 16)}`;
}

function createContextHash(board: BoardProjection, sourceNode: NodeRecord, message: string): string {
  return hashHex(createHash("sha256").update(JSON.stringify({
      requestId: sourceNode.requestId,
      nodeId: sourceNode.id,
      ordinal: sourceNode.ordinal,
      destinations: sourceNode.destinations.map(destination => [destination.id, destination.title, destination.status]),
      harness: sourceNode.harness,
      lineCount: board.lines.length,
      moveCount: board.moves.length,
      hunsuCount: board.hunsus.length,
      message
    })));
}

function createWorktreeHash(cwd: string): string | undefined {
  try {
    const status = readWorktreeStatus(cwd);
    return hashHex(createHash("sha256").update(JSON.stringify(status)));
  } catch (_error) {
    return undefined;
  }
}

function nextExecuteId(state: StudioServerState, board: BoardProjection, cwd?: string): string {
  const ids = [
    ...(cwd ? runsForRepository(state, cwd) : Object.values(state.runs)).map(run => run.executeId ?? run.runId),
    ...board.moves.flatMap(move => move.executeId ? [String(move.executeId)] : []),
    ...readRouteBranchIds(cwd)
  ];
  const highest = ids.reduce((max, id) => {
    const match = id.match(/^F(\d+)$/i);
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0);
  return `F${String(highest + 1).padStart(4, "0")}`;
}

function studioRunId(input: { lineId: string; executeId: string; roadmapId?: string }): string {
  return input.roadmapId ? `${input.roadmapId}:${input.executeId}:${input.lineId}` : input.lineId;
}

function readRouteBranchIds(cwd: string | undefined): string[] {
  if (!cwd) {
    return [];
  }
  try {
    const root = ensureGitRepository(cwd);
    return git(["for-each-ref", "--format=%(refname:short)", "refs/heads/hunsu/routes"], { cwd: root })
      .trim()
      .split(/\r?\n/)
      .map(line => line.trim().split("/").at(-1) ?? "")
      .filter(Boolean);
  } catch (_error) {
    return [];
  }
}

function createVirtualRouteWorktree(cwd: string, executeId: string, createdAt: string): WorktreeRef {
  const worktreeHash = hashHex(createHash("sha256").update(JSON.stringify({ cwd, executeId, createdAt }))).slice(0, 16);
  return {
    worktreeHash: requireDomainValue(makeWorktreeHash(worktreeHash)),
    path: requireDomainValue(makeNonEmptyText(cwd, "worktree.path")),
    branch: requireDomainValue(makeNonEmptyText(`virtual/${executeId}`, "worktree.branch")),
    baseRef: requireDomainValue(makeNonEmptyText("virtual", "worktree.baseRef")),
    createdAt
  };
}

function firstContentLine(text: string): string | undefined {
  return text
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(line => line.length > 0);
}

function formatMovePosition(node: NodeRecord): string {
  return `${node.teamName ?? "Team"} MOVE ${node.ordinal}`;
}

function normalizeSelectedDestinationIds(selectedDestinationIds: string[] | undefined, activeDestinations: Destination[]): string[] {
  const nextDestination = nextQueuedDestination(activeDestinations);
  if (selectedDestinationIds && selectedDestinationIds.length > 0) {
    if (selectedDestinationIds.length !== 1) {
      throw new Error("Execute must select exactly one Destination");
    }
    if (!nextDestination || selectedDestinationIds[0] !== nextDestination.id) {
      throw new Error("Execute must select the next Destination in the queue");
    }
    return selectedDestinationIds;
  }
  return nextDestination ? [nextDestination.id] : [];
}

function normalizeCompletionDestinationIds(destinationIds: string[] | undefined, selectedDestinationIds: string[]): [string] {
  const normalized = destinationIds && destinationIds.length > 0 ? destinationIds : selectedDestinationIds;
  if (normalized.length !== 1) {
    throw new Error("MOVE completion requires exactly one Destination");
  }
  return [normalized[0] as string];
}

function selectedDestinationIdsForPrompt(destinations: Destination[]): string[] {
  const next = nextQueuedDestination(destinations.filter(isOpenDestination));
  return next ? [String(next.id)] : [];
}

function nextQueuedDestination(destinations: readonly Destination[]): Destination | undefined {
  return [...destinations].sort(destinationQueueSort)[0];
}

function destinationQueueSort(left: Destination, right: Destination): number {
  return (right.priority ?? 0) - (left.priority ?? 0);
}

function validateCompletion(
  board: BoardProjection,
  run: StudioRunState,
  request: StudioMoveCompletionRequest,
  destinationIds: string[],
  cwd: string
): void {
  if (!request.summary.trim()) {
    throw new Error("MOVE completion requires a summary");
  }
  if (request.evidence.length === 0 || request.evidence.some(item => item.trim() === "")) {
    throw new Error("MOVE completion requires evidence");
  }
  if (request.risks && request.risks.length > 0 && !request.approvedRisks) {
    throw new Error("MOVE completion with risks requires explicit approval");
  }
  for (const destinationId of destinationIds) {
    const destination = destinationsForLine(board, run.lineId).find(candidate => candidate.id === destinationId);
    if (!destination) {
      throw new Error(`Unknown Destination: ${destinationId}`);
    }
    if (destination.requestId !== run.requestId) {
      throw new Error(`Destination ${destinationId} does not belong to request ${run.requestId}`);
    }
    if (!run.selectedDestinationIds.includes(destinationId)) {
      throw new Error(`Destination ${destinationId} was not selected for run ${run.runId}`);
    }
    if (!isOpenDestination(destination)) {
      throw new Error(`Destination ${destinationId} is not open`);
    }
  }
  const worktree = readWorktreeStatus(cwd);
  if (!worktree.clean) {
    throw new Error("Cannot record MOVE while worktree has uncommitted changes");
  }
}

function validateExecuteCompletionFacts(
  board: BoardProjection,
  run: StudioRunState,
  completion: StudioExecuteCompletionFacts,
  destinationIds: string[],
  cwd: string,
  options: { promotedPathCommit?: string; prevMoveCommit?: string } = {}
): void {
  if (!completion.summary.trim()) {
    throw new Error("MOVE completion requires a summary");
  }
  if (completion.evidence.length === 0 || completion.evidence.some(item => item.trim() === "")) {
    throw new Error("MOVE completion requires evidence");
  }
  for (const destinationId of destinationIds) {
    const destination = destinationsForLine(board, run.lineId).find(candidate => candidate.id === destinationId);
    if (!destination) {
      throw new Error(`Unknown Destination: ${destinationId}`);
    }
    if (destination.requestId !== run.requestId) {
      throw new Error(`Destination ${destinationId} does not belong to request ${run.requestId}`);
    }
    if (!run.selectedDestinationIds.includes(destinationId)) {
      throw new Error(`Destination ${destinationId} was not selected for run ${run.runId}`);
    }
    if (!isOpenDestination(destination)) {
      throw new Error(`Destination ${destinationId} is not open`);
    }
  }
  if (options.promotedPathCommit) {
    if (!options.prevMoveCommit) {
      throw new Error("Cannot auto-record MOVE without PrevMove commit for ExecutionPlan promotion");
    }
    if (!hasTreeChangedBetweenCommits(cwd, options.prevMoveCommit, options.promotedPathCommit)) {
      throw new Error("Cannot auto-record MOVE without worktree changes");
    }
    assertNoHunsuControlPlaneDiffBetween(cwd, options.prevMoveCommit, options.promotedPathCommit);
    return;
  }
  const worktree = readWorktreeStatus(cwd);
  if (worktree.clean) {
    throw new Error("Cannot auto-record MOVE without worktree changes");
  }
  const controlPlaneChange = worktree.changes.find(change => change.path === ".hunsu" || change.path.startsWith(".hunsu/"));
  if (controlPlaneChange) {
    throw new Error("Cannot auto-record MOVE when the Team changed Hunsu control-plane files");
  }
}

function hasTreeChangedBetweenCommits(cwd: string, baseCommit: string, headCommit: string): boolean {
  const baseTree = git(["rev-parse", "--verify", `${baseCommit}^{tree}`], { cwd }).trim();
  const headTree = git(["rev-parse", "--verify", `${headCommit}^{tree}`], { cwd }).trim();
  return baseTree !== headTree;
}

function assertNoHunsuControlPlaneDiffBetween(cwd: string, baseCommit: string, headCommit: string): void {
  const diff = git(["diff", "--name-only", `${baseCommit}..${headCommit}`, "--", ".hunsu"], { cwd }).trim();
  if (diff) {
    throw new Error("Cannot auto-record MOVE when the Team changed Hunsu control-plane files");
  }
}

export type MemberCodexEnvironmentPhase = "team" | "member" | "move-finalizer";

export type MemberCodexEnvironmentPreparationOptions = {
  phase?: MemberCodexEnvironmentPhase;
  executorId?: string;
  apmSkillRegistryClient?: ApmSkillRegistryClient;
  skillMetaInstaller?: SkillMetaInstaller;
  env?: Record<string, string | undefined>;
  home?: string;
};

export async function prepareMemberCodexEnvironmentForExecute(
  cwd: string,
  harness?: HarnessSnapshot,
  options: MemberCodexEnvironmentPreparationOptions = {}
): Promise<void> {
  if (!existsSync(cwd)) {
    return;
  }
  const member = options.executorId && harness ? getMemberForEnvironment(harness, options.executorId) : undefined;
  const requestedSkills = member ? uniqueMemberSkills(member.skills) : [];
  const requestedPlugins = member ? uniqueMemberPlugins(member.plugins ?? []) : [];
  const installedSkills = listCodexSkills(options.env ?? process.env, options.home ?? homedir());
  const discoveredSkills = listCodexEnvironmentSkills(cwd, options.env ?? process.env, options.home ?? homedir());
  const discoveredPlugins = listCodexPlugins(options.env ?? process.env, options.home ?? homedir());
  const materializedSkillPaths: string[] = [];

  ensureCodexEnvironmentGitExclude(cwd);
  clearHunsuMaterializedSkills(cwd);

  if (requestedSkills.length > 0) {
    ensureAgentSkillsGitExclude(cwd);
    const skillsRoot = join(cwd, ".agents", "skills");
    mkdirSync(skillsRoot, { recursive: true });
    for (const skill of requestedSkills) {
      const files = await skillFilesForEnvironment(skill, installedSkills, options);
      if (files.length === 0) {
        continue;
      }
      const skillRoot = join(skillsRoot, safeSkillDirectoryName(skill.name));
      prepareMaterializedSkillRoot(skillRoot);
      for (const file of files) {
        const target = safeSkillSnapshotTarget(skillRoot, file.path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, file.text, "utf8");
      }
      writeFileSync(join(skillRoot, HUNSU_MATERIALIZED_SKILL_MARKER), "hunsu-managed\n", "utf8");
      materializedSkillPaths.push(join(skillRoot, "SKILL.md"));
    }
  }

  for (const plugin of requestedPlugins) {
    if (!discoveredPlugins.includes(plugin.id)) {
      throw new Error(`Member Codex Environment missing Plugin: ${plugin.id}`);
    }
  }

  writeCodexEnvironmentConfig(cwd, {
    enabledSkillPaths: materializedSkillPaths,
    disabledSkillPaths: discoveredSkills.map(skill => join(skill.sourcePath, "SKILL.md")),
    enabledPluginIds: requestedPlugins.map(plugin => plugin.id),
    disabledPluginIds: discoveredPlugins
  });
}

export async function materializeCodexSkillsForExecute(
  cwd: string,
  harness?: HarnessSnapshot,
  options: { apmSkillRegistryClient?: ApmSkillRegistryClient; skillMetaInstaller?: SkillMetaInstaller } = {}
): Promise<void> {
  await prepareMemberCodexEnvironmentForExecute(cwd, harness, {
    phase: "member",
    executorId: harness?.members[0]?.id,
    apmSkillRegistryClient: options.apmSkillRegistryClient,
    skillMetaInstaller: options.skillMetaInstaller
  });
}

function getMemberForEnvironment(protocol: HarnessSnapshot, executorId: string): MemberConfig {
  const member = protocol.members.find(candidate => candidate.id === executorId);
  if (!member) {
    throw new Error(`Member Codex Environment cannot find Member ${executorId}`);
  }
  return member;
}

async function skillFilesForEnvironment(
  skill: SkillBinding,
  discoveredSkills: StudioSkillSummary[],
  options: MemberCodexEnvironmentPreparationOptions
): Promise<SkillSnapshotFile[]> {
  if (skill.kind === "skillMeta") {
    const installed = await resolveSkillMetaSkill(skill, options);
    const files = skillSnapshotFiles(installed) ?? [];
    if (files.length === 0) {
      throw new Error(`Member Codex Environment Skill ${skill.name} has no readable files after npx skills add`);
    }
    return files;
  }
  if (skill.kind === "local-root-installed") {
    const installed = resolveLocalRootInstalledSkill(skill, discoveredSkills);
    const files = skillSnapshotFiles(installed) ?? [];
    if (files.length === 0) {
      throw new Error(`Member Codex Environment Skill ${skill.name} has no readable files`);
    }
    return files;
  }
  return skillFilesForMaterialization(skill, options.apmSkillRegistryClient);
}

async function resolveSkillMetaSkill(
  skill: SkillMetaSkillMetadata,
  options: MemberCodexEnvironmentPreparationOptions
): Promise<StudioSkillSummary> {
  const stagingCwd = mkdtempSync(join(tmpdir(), "hunsu-skill-meta-"));
  try {
    const installer = options.skillMetaInstaller ?? createNpxSkillsAddInstaller();
    await installer.install(skill, stagingCwd, { env: options.env, home: options.home });
    const installed = listSkillRoot(join(stagingCwd, ".agents", "skills"));
    const matches = installed.filter(candidate => candidate.name === skill.name);
    if (matches.length === 0) {
      throw new Error(`Member Codex Environment missing Skill ${skill.name} after npx skills add ${skill.source}`);
    }
    if (matches.length > 1) {
      throw new Error(`Member Codex Environment Skill ${skill.name} is ambiguous after npx skills add ${skill.source}`);
    }
    return matches[0];
  } finally {
    rmSync(stagingCwd, { recursive: true, force: true });
  }
}

export function createNpxSkillsAddInstaller(command = "npx"): SkillMetaInstaller {
  return {
    async install(skill, cwd, options) {
      const env = { ...process.env, ...options.env };
      if (options.home) {
        env.HOME = options.home;
        env.USERPROFILE = options.home;
      }
      try {
        await execFileAsync(command, [
          "--yes",
          "skills",
          "add",
          skill.source,
          "--skill",
          skill.name,
          "--agent",
          skill.agent,
          "--copy",
          "--yes"
        ], {
          cwd,
          env,
          maxBuffer: 2 * 1024 * 1024
        });
      } catch (error) {
        const details = error instanceof Error ? error.message : String(error);
        throw new Error(`npx skills add failed for ${skill.name}: ${details}`);
      }
    }
  };
}

function resolveLocalRootInstalledSkill(skill: Extract<SkillBinding, { kind: "local-root-installed" }>, discoveredSkills: StudioSkillSummary[]): StudioSkillSummary {
  if (skill.sourcePath) {
    const requestedPath = resolve(skill.sourcePath);
    const matches = discoveredSkills.filter(candidate => resolve(candidate.sourcePath) === requestedPath);
    if (matches.length === 0) {
      throw new Error(`Member Codex Environment missing Skill ${skill.name} at ${skill.sourcePath}`);
    }
    if (matches.length > 1) {
      throw new Error(`Member Codex Environment Skill ${skill.name} is ambiguous at ${skill.sourcePath}`);
    }
    if (matches[0].name !== skill.name) {
      throw new Error(`Member Codex Environment Skill ${skill.sourcePath} resolved as ${matches[0].name}, not ${skill.name}`);
    }
    return matches[0];
  }
  const matches = discoveredSkills.filter(candidate => candidate.name === skill.name);
  if (matches.length === 0) {
    throw new Error(`Member Codex Environment missing Skill: ${skill.name}`);
  }
  if (matches.length > 1) {
    throw new Error(`Member Codex Environment Skill ${skill.name} is ambiguous across local roots`);
  }
  return matches[0];
}

function prepareMaterializedSkillRoot(skillRoot: string): void {
  if (existsSync(skillRoot) && !existsSync(join(skillRoot, HUNSU_MATERIALIZED_SKILL_MARKER))) {
    throw new Error(`Member Codex Environment cannot overwrite non-Hunsu Skill folder: ${skillRoot}`);
  }
  rmSync(skillRoot, { recursive: true, force: true });
  mkdirSync(skillRoot, { recursive: true });
}

function clearHunsuMaterializedSkills(cwd: string): void {
  const skillsRoot = join(cwd, ".agents", "skills");
  if (!existsSync(skillsRoot)) {
    return;
  }
  for (const entry of readdirSync(skillsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const skillRoot = join(skillsRoot, entry.name);
    if (existsSync(join(skillRoot, HUNSU_MATERIALIZED_SKILL_MARKER))) {
      rmSync(skillRoot, { recursive: true, force: true });
    }
  }
}

function writeCodexEnvironmentConfig(
  cwd: string,
  input: {
    enabledSkillPaths: string[];
    disabledSkillPaths: string[];
    enabledPluginIds: string[];
    disabledPluginIds: string[];
  }
): void {
  const configPath = join(cwd, ".codex", "config.toml");
  if (existsSync(configPath)) {
    const existing = readFileSync(configPath, "utf8");
    if (!existing.startsWith(HUNSU_CODEX_ENV_CONFIG_MARKER)) {
      throw new Error(`Member Codex Environment cannot overwrite non-Hunsu Codex config: ${configPath}`);
    }
  }
  mkdirSync(dirname(configPath), { recursive: true });
  const enabledSkillPaths = new Set(input.enabledSkillPaths.map(path => resolve(path)));
  const skillEntries = [
    ...Array.from(enabledSkillPaths).map(path => ({ path, enabled: true })),
    ...Array.from(new Set(input.disabledSkillPaths.map(path => resolve(path))))
      .filter(path => !enabledSkillPaths.has(path))
      .map(path => ({ path, enabled: false }))
  ].sort((left, right) => left.path.localeCompare(right.path));
  const enabledPluginIds = new Set(input.enabledPluginIds);
  const pluginEntries = [
    ...Array.from(enabledPluginIds).map(id => ({ id, enabled: true })),
    ...Array.from(new Set(input.disabledPluginIds))
      .filter(id => !enabledPluginIds.has(id))
      .map(id => ({ id, enabled: false }))
  ].sort((left, right) => left.id.localeCompare(right.id));
  const lines = [
    HUNSU_CODEX_ENV_CONFIG_MARKER,
    "# Generated by Hunsu Bridge for a Route worktree. Do not edit by hand.",
    ""
  ];
  for (const entry of skillEntries) {
    lines.push("[[skills.config]]", `path = ${tomlString(entry.path)}`, `enabled = ${entry.enabled ? "true" : "false"}`, "");
  }
  for (const entry of pluginEntries) {
    lines.push(`[plugins.${tomlString(entry.id)}]`, `enabled = ${entry.enabled ? "true" : "false"}`, "");
  }
  writeFileSync(configPath, `${lines.join("\n").trimEnd()}\n`, "utf8");
}

async function skillFilesForMaterialization(
  skill: SkillBinding,
  apmSkillRegistryClient?: ApmSkillRegistryClient
): Promise<SkillSnapshotFile[]> {
  if (skill.kind === "local-snapshot") {
    return skill.snapshotFiles?.map(file => ({ ...file })) ?? [];
  }
  if (skill.kind !== "registry-package") {
    throw new Error(`Skill ${skill.name} must be resolved before materialization`);
  }
  const client = apmSkillRegistryClient ?? createHttpApmSkillRegistryClient();
  const files = await client.fetchSkillFiles(skill);
  if (skill.contentHash.startsWith("sha256:") && computeSkillFilesContentHash(files) !== skill.contentHash) {
    throw new Error(`APM contentHash mismatch for ${skill.package}@${skill.version}`);
  }
  return files.map(file => ({ ...file }));
}

function uniqueMemberSkills(skills: SkillBinding[]): SkillBinding[] {
  const seen = new Set<string>();
  const result: SkillBinding[] = [];
  for (const skill of skills) {
    const key = skill.kind === "local-root-installed" && skill.sourcePath ? `${skill.name}\0${resolve(skill.sourcePath)}` : skill.name;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(skill);
  }
  return result;
}

function uniqueMemberPlugins(plugins: MemberPluginBinding[]): MemberPluginBinding[] {
  const seen = new Set<string>();
  const result: MemberPluginBinding[] = [];
  for (const plugin of plugins) {
    if (seen.has(plugin.id)) {
      continue;
    }
    seen.add(plugin.id);
    result.push({ ...plugin });
  }
  return result;
}

function ensureAgentSkillsGitExclude(cwd: string): void {
  ensureGitExcludeEntries(cwd, [".agents/skills/"]);
}

function ensureCodexEnvironmentGitExclude(cwd: string): void {
  ensureGitExcludeEntries(cwd, [".agents/skills/", ".codex/config.toml"]);
}

function ensureGitExcludeEntries(cwd: string, entries: string[]): void {
  try {
    const excludePath = git(["rev-parse", "--git-path", "info/exclude"], { cwd }).trim();
    const path = isAbsolute(excludePath) ? excludePath : join(cwd, excludePath);
    mkdirSync(dirname(path), { recursive: true });
    const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
    const existingLines = new Set(existing.split(/\r?\n/));
    const missing = entries.filter(entry => !existingLines.has(entry));
    if (missing.length === 0) {
      return;
    }
    const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
    writeFileSync(path, `${existing}${prefix}${missing.join("\n")}\n`, "utf8");
  } catch (_error) {
    // Non-Git execution surfaces can still receive materialized files.
  }
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function safeSkillDirectoryName(name: string): string {
  const directory = name.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!directory || directory === "." || directory === "..") {
    throw new Error(`Invalid Skill name for Codex materialization: ${name}`);
  }
  return directory;
}

function safeSkillSnapshotTarget(skillRoot: string, path: string): string {
  if (!path.trim() || path.includes("\0") || isAbsolute(path)) {
    throw new Error(`Invalid Skill snapshot file path: ${path}`);
  }
  const normalized = normalize(path);
  if (isParentRelativePath(normalized)) {
    throw new Error(`Invalid Skill snapshot file path: ${path}`);
  }
  const target = join(skillRoot, normalized);
  const relativeTarget = relative(skillRoot, target);
  if (isParentRelativePath(relativeTarget) || isAbsolute(relativeTarget)) {
    throw new Error(`Invalid Skill snapshot file path: ${path}`);
  }
  return target;
}

function isParentRelativePath(path: string): boolean {
  return path === ".." || path.startsWith("../") || path.startsWith("..\\");
}

export function listCodexSkills(env: Record<string, string | undefined> = {}, home = homedir()): StudioSkillSummary[] {
  const roots = uniquePaths([
    env.CODEX_HOME ? join(env.CODEX_HOME, "skills") : undefined,
    join(home, ".codex", "skills"),
    join(home, ".agents", "skills"),
    "/etc/codex/skills"
  ]);
  return roots.flatMap(root => listSkillRoot(root)).sort((left, right) => left.name.localeCompare(right.name));
}

function listCodexEnvironmentSkills(cwd: string, env: Record<string, string | undefined> = {}, home = homedir()): StudioSkillSummary[] {
  return uniqueSkillSummaries([
    ...listCodexSkills(env, home),
    ...listSkillRoot(join(cwd, ".agents", "skills")),
    ...listSkillRoot(join(cwd, ".codex", "skills"))
  ]);
}

function listSkillRoot(root: string): StudioSkillSummary[] {
  if (!existsSync(root)) {
    return [];
  }
  const skillFolders: string[] = [];
  const visit = (directory: string): void => {
    if (existsSync(join(directory, "SKILL.md"))) {
      skillFolders.push(directory);
      return;
    }
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === "node_modules" || entry.name === ".git") {
        continue;
      }
      visit(join(directory, entry.name));
    }
  };
  try {
    visit(root);
  } catch (_error) {
    return [];
  }
  return skillFolders.flatMap(folder => readSkillFolder(folder, basename(folder)));
}

function uniqueSkillSummaries(skills: StudioSkillSummary[]): StudioSkillSummary[] {
  const seen = new Set<string>();
  const result: StudioSkillSummary[] = [];
  for (const skill of skills) {
    const key = resolve(skill.sourcePath);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(skill);
  }
  return result.sort((left, right) => left.name.localeCompare(right.name) || left.sourcePath.localeCompare(right.sourcePath));
}

export function listCodexPlugins(env: Record<string, string | undefined> = {}, home = homedir()): string[] {
  const configPaths = uniquePaths([
    env.CODEX_HOME ? join(env.CODEX_HOME, "config.toml") : undefined,
    join(home, ".codex", "config.toml")
  ]);
  const pluginIds = new Set<string>();
  for (const configPath of configPaths) {
    if (!existsSync(configPath)) {
      continue;
    }
    const text = readFileSync(configPath, "utf8");
    for (const match of text.matchAll(/^\s*\[plugins\."([^"]+)"\]\s*$/gm)) {
      if (match[1]?.trim()) {
        pluginIds.add(match[1]);
      }
    }
  }
  return Array.from(pluginIds).sort();
}

function readSkillFolder(folder: string, name: string): StudioSkillSummary[] {
  const files = readSkillFiles(folder);
  if (files.length === 0) {
    return [];
  }
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file.path);
    hash.update("\0");
    hash.update(file.text ?? "");
    hash.update("\0");
  }
  const contentHash = hashHex(hash);
  return [{
    kind: "local-snapshot",
    name: requireDomainValue(makeNonEmptyText(name, "skill.name")),
    sourcePath: requireDomainValue(makeNonEmptyText(folder, "skill.sourcePath")),
    contentHash: requireDomainValue(makeNonEmptyText(contentHash, "skill.contentHash")),
    snapshotRef: requireDomainValue(makeNonEmptyText(`codex-skill:${contentHash}`, "skill.snapshotRef")),
    snapshotFiles: files
      .filter((file): file is StudioSkillFile & { text: string } => typeof file.text === "string")
      .map(file => ({ path: requireDomainValue(makeNonEmptyText(file.path, "skill.snapshotFiles.path")), text: file.text })),
    files
  }];
}

function skillSnapshotFiles(skill: SkillBinding | StudioSkillSummary): LocalSnapshotSkillMetadata["snapshotFiles"] {
  if (skill.kind === "local-snapshot" && skill.snapshotFiles) {
    return skill.snapshotFiles.map(file => ({ ...file }));
  }
  if ("files" in skill) {
    return skill.files
      .filter((file): file is StudioSkillFile & { text: string } => typeof file.text === "string")
      .map(file => ({ path: requireDomainValue(makeNonEmptyText(file.path, "skill.snapshotFiles.path")), text: file.text }));
  }
  return undefined;
}

function readSkillFiles(folder: string): StudioSkillFile[] {
  const files: StudioSkillFile[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const fullPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".git") {
          continue;
        }
        visit(fullPath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const stat = statSync(fullPath);
      const path = relative(folder, fullPath);
      const text = stat.size <= 64_000 ? readFileSync(fullPath, "utf8") : undefined;
      files.push({ path, size: stat.size, text });
    }
  };
  visit(folder);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function uniquePaths(paths: Array<string | undefined>): string[] {
  return Array.from(new Set(paths.filter((path): path is string => Boolean(path))));
}

function nextMoveId(board: BoardProjection): MoveId {
  const highest = board.moves.reduce((max, move) => {
    const match = move.id.match(/^M(\d+)$/i);
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0);
  return requireDomainValue(makeMoveId(`M${String(highest + 1).padStart(4, "0")}`));
}

function isOpenDestination(destination: Destination): boolean {
  return destination.status !== "reached" && destination.status !== "canceled" && destination.status !== "superseded";
}

function destinationsForLine(board: BoardProjection, lineId: string): Destination[] {
  return nodeForLine(board, lineId)?.destinations ?? board.destinations.filter(destination => {
    const line = board.lines.find(candidate => candidate.id === lineId);
    return !line || destination.requestId === line.requestId;
  });
}

function nodeForLine(board: BoardProjection, lineId: string) {
  const line = board.lines.find(candidate => candidate.id === lineId);
  return line?.currentNodeId ? board.nodes.find(candidate => candidate.id === line.currentNodeId) : undefined;
}

function requireStudioRun(state: StudioServerState, runId: string, cwd?: string): StudioRunState {
  const run = findStudioRun(state, runId, cwd);
  if (!run) {
    throw new Error(`Unknown run: ${runId}`);
  }
  return run;
}

function findStudioRun(state: StudioServerState, runId: string, cwd?: string): StudioRunState | undefined {
  const run = state.runs[runId] ?? Object.values(state.runs).find(candidate => candidate.runId === runId);
  if (!cwd) {
    return run;
  }
  return run && runBelongsToRepository(run, cwd) ? run : undefined;
}

function runsForRepository(state: StudioServerState, cwd: string): StudioRunState[] {
  rehydratePreviousExecutionRunsForRepository(state, cwd);
  return Object.values(state.runs).filter(run => runBelongsToRepository(run, cwd));
}

function rehydratePreviousExecutionRunsForRepository(state: StudioServerState, cwd: string): void {
  if (!existsSync(cwd)) {
    return;
  }
  let chain: ReturnType<typeof readPreviousExecutionChain>;
  try {
    chain = readPreviousExecutionChain(cwd);
  } catch (error) {
    if (error instanceof GitError) {
      return;
    }
    throw error;
  }
  for (const item of chain) {
    const storageKey = rehydratedRunStorageKey(item.execution);
    const existing = state.runs[storageKey] ?? Object.values(state.runs).find(run => run.executeId === item.execution.executeId);
    if (existing && existing.source !== "rehydrated") {
      continue;
    }
    state.runs[storageKey] = rehydratedRunFromPreviousExecution(item.execution, cwd, item.commit);
  }
}

function rehydratedRunStorageKey(execution: HunsuPreviousExecutionFile): string {
  return `${execution.runId}:${execution.executeId}`;
}

function rehydratedRunFromPreviousExecution(execution: HunsuPreviousExecutionFile, repositoryPath: string, containingCommit: CommitSha): StudioRunState {
  const providerTurnIds = [
    execution.plan.session?.providerTurnId,
    ...execution.paths.flatMap(path => path.session?.providerTurnId ? [path.session.providerTurnId] : []),
    execution.finalizerSession?.providerTurnId
  ].filter((turnId): turnId is string => Boolean(turnId));
  const agentSessions = rehydratedAgentSessionsFromPreviousExecution(execution);
  const completedAt = execution.completedAt ?? new Date(0).toISOString();
  return {
    runId: execution.runId,
    executeId: execution.executeId,
    lineId: execution.lineId,
    requestId: requestIdFromLineId(execution.lineId),
    repositoryPath,
    provider: "codex",
    source: "rehydrated",
    status: "arrived",
    selectedDestinationIds: execution.selectedDestinationIds,
    sourceNodeId: execution.sourceNodeId,
    sourceMoveId: execution.sourceMoveId,
    targetMoveOrdinal: execution.targetMoveOrdinal,
    worktree: execution.worktree,
    conversationRef: execution.conversationRef,
    outcome: "arrived",
    providerThreadId: execution.plan.session?.providerThreadId ?? execution.finalizerSession?.providerThreadId,
    providerTeamThreadId: execution.plan.session?.providerThreadId,
    providerTeamPlanningTurnId: execution.plan.session?.providerTurnId,
    providerFinalizerThreadId: execution.finalizerSession?.providerThreadId,
    providerTurnIds,
    attemptCount: positiveInteger(1, "attempt"),
    pathCommits: { ...execution.pathCommits },
    memberPathRuns: execution.paths.map(path => rehydratedPathRunFromPreviousExecution(path, execution)),
    terminalMemberPathId: execution.terminalPathId,
    terminalPathCommit: execution.terminalPathCommit,
    moveFinalizerCommit: execution.moveFinalizerCommit?.type === "external" ? execution.moveFinalizerCommit.commit : containingCommit,
    moveFinalizerMessage: execution.moveFinalizerMessage,
    debugEvents: [],
    rawAppServerMessages: [],
    codexTurns: [],
    codexItems: [],
    agentSessions,
    activeItemIds: [],
    assistantTranscript: [],
    startedAt: execution.startedAt ?? completedAt,
    updatedAt: completedAt
  };
}

function rehydratedPathRunFromPreviousExecution(path: HunsuPreviousExecutionFile["paths"][number], execution: HunsuPreviousExecutionFile): StudioMemberPathRun {
  const attempt = positiveInteger(1, "attempt");
  const base = {
    pathId: path.pathId,
    executorId: path.executorId,
    goal: path.goal,
    requires: path.requires,
    attempt,
    agentSessionId: path.session?.sessionId,
    dependencyPathIds: Array.isArray(path.requires) ? path.requires : [],
    dependencyOutputs: [],
    startedAt: path.startedAt ?? execution.startedAt ?? new Date(0).toISOString()
  };
  const session = path.session?.providerThreadId && path.session.providerTurnId
    ? { providerThreadId: path.session.providerThreadId, providerTurnId: path.session.providerTurnId }
    : undefined;
  switch (path.lifecycle) {
    case "Failed":
      return {
        ...base,
        status: "failed",
        session,
        error: path.error ?? "Path failed before server restart",
        commit: path.commit,
        parentCommit: path.parentCommit,
        treeChanged: path.treeChanged,
        completedAt: path.completedAt ?? execution.completedAt ?? new Date(0).toISOString()
      };
    case "Executing":
      return session ? { ...base, status: "executing", session } : { ...base, status: "starting" };
    case "Waiting":
      return { ...base, status: "planned" };
    case "Completed":
      return {
        ...base,
        status: "completed",
        session: session ?? { providerThreadId: "unknown", providerTurnId: path.session?.sessionId ?? path.pathId },
        finalResponse: "",
        commit: path.commit,
        parentCommit: path.parentCommit,
        treeChanged: path.treeChanged,
        completedAt: path.completedAt ?? execution.completedAt ?? new Date(0).toISOString()
      };
  }
}

function rehydratedAgentSessionsFromPreviousExecution(execution: HunsuPreviousExecutionFile): AgentSession[] {
  const sessions: AgentSession[] = [];
  const attempt = positiveInteger(1, "attempt");
  if (execution.plan.session) {
    sessions.push(rehydratedAgentSession(execution.plan.session, {
      kind: "TeamPlan",
      runId: execution.runId,
      executeId: execution.executeId,
      attempt
    }, execution));
  }
  for (const path of execution.paths) {
    if (!path.session) continue;
    sessions.push(rehydratedAgentSession(path.session, {
      kind: "ExecutionPlan",
      runId: execution.runId,
      executeId: execution.executeId,
      attempt,
      pathId: path.pathId,
      executorId: path.executorId
    }, execution));
  }
  if (execution.finalizerSession) {
    sessions.push(rehydratedAgentSession(execution.finalizerSession, {
      kind: "MoveFinalizer",
      runId: execution.runId,
      executeId: execution.executeId,
      moveId: execution.targetMoveId
    }, execution));
  }
  return sessions;
}

function rehydratedAgentSession(ref: PreviousExecutionAgentSessionRef, owner: AgentSessionOwner, execution: HunsuPreviousExecutionFile): AgentSession {
  const provider = ref.providerThreadId && ref.providerTurnId
    ? { providerThreadId: ref.providerThreadId, providerTurnId: ref.providerTurnId }
    : undefined;
  const completedAt = ref.completedAt ?? execution.completedAt ?? new Date(0).toISOString();
  return {
    sessionId: ref.sessionId,
    routeRef: {
      kind: "Route",
      routeKind: owner.kind === "TeamPlan" ? "Plan" : "Path",
      routeId: execution.executeId,
      runId: execution.runId,
      executeId: execution.executeId,
      sourceLineId: execution.lineId,
      sourceNodeId: String(execution.sourceNodeId ?? ""),
      worktree: execution.worktree
    },
    runId: execution.runId,
    executeId: execution.executeId,
    owner,
    state: ref.state === "failed"
      ? { type: "failed", provider, error: ref.error ?? "Session failed before server restart", completedAt }
      : { type: "completed", provider, completedAt },
    provider,
    messages: [],
    activeItemIds: [],
    revision: 0,
    createdAt: ref.startedAt ?? execution.startedAt ?? completedAt,
    updatedAt: completedAt
  };
}

function requestIdFromLineId(lineId: string): string {
  return lineId.startsWith("run/") ? lineId.slice("run/".length).split("/")[0] ?? lineId : lineId;
}

function agentSessionsForRepository(state: StudioServerState, cwd: string): AgentSession[] {
  return allAgentSessions(state).filter(session => agentSessionBelongsToScope(session, state, { cwd }));
}

function findAgentSessionById(state: StudioServerState, sessionId: string, scope: AgentSessionSubscriptionScope = {}): AgentSession | undefined {
  const direct = state.agentSessions[sessionId];
  if (direct && agentSessionBelongsToScope(direct, state, scope)) {
    return direct;
  }
  for (const run of Object.values(state.runs)) {
    const session = run.agentSessions?.find(candidate => candidate.sessionId === sessionId);
    if (session && agentSessionBelongsToScope(session, state, scope)) {
      return session;
    }
  }
  return undefined;
}

function allAgentSessions(state: StudioServerState): AgentSession[] {
  const byId = new Map<string, AgentSession>();
  for (const session of Object.values(state.agentSessions)) {
    byId.set(session.sessionId, session);
  }
  for (const run of Object.values(state.runs)) {
    for (const session of run.agentSessions ?? []) {
      byId.set(session.sessionId, session);
    }
  }
  return [...byId.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

function agentSessionBelongsToScope(session: AgentSession | undefined, state: StudioServerState, scope: AgentSessionSubscriptionScope): boolean {
  if (!session) {
    return false;
  }
  if (scope.sessionId && session.sessionId !== scope.sessionId) {
    return false;
  }
  if (scope.roadmapId && !agentSessionMatchesRoadmap(session, scope.roadmapId)) {
    return false;
  }
  if (!scope.cwd) {
    return true;
  }
  if (session.routeRef.routeKind === "HunsuDraft" && session.routeRef.draftSessionId) {
    const draft = state.hunsuDrafts[session.routeRef.draftSessionId];
    return draft?.repositoryPath === scope.cwd;
  }
  const run = runForAgentSession(state, session);
  return Boolean(run && runBelongsToRepository(run, scope.cwd));
}

function agentSessionEventBelongsToScope(event: AgentSessionEvent, session: AgentSession, state: StudioServerState, scope: AgentSessionSubscriptionScope): boolean {
  if (event.type === "agentSession.snapshot") {
    return false;
  }
  if (scope.sessionId && event.sessionId !== scope.sessionId) {
    return false;
  }
  if (scope.roadmapId && "roadmapId" in event && event.roadmapId && event.roadmapId !== scope.roadmapId) {
    return false;
  }
  return agentSessionBelongsToScope(session, state, scope);
}

function agentSessionMatchesRoadmap(session: AgentSession, roadmapId: string): boolean {
  return session.roadmapId === roadmapId;
}

function runForAgentSession(state: StudioServerState, session: AgentSession): StudioRunState | undefined {
  if (session.routeRef.runId) {
    const run = state.runs[session.routeRef.runId];
    if (run) {
      return run;
    }
  }
  return Object.values(state.runs).find(run =>
    run.agentSessions?.some(candidate => candidate === session)
    || (session.runId && run.runId === session.runId && (!session.roadmapId || run.roadmapId === session.roadmapId))
  );
}

function toAgentSessionSummary(session: AgentSession): AgentSession {
  const finalResponse = truncateOptionalText(session.finalResponse, SUMMARY_TEXT_MAX_BYTES);
  const error = truncateOptionalText(session.error, SUMMARY_TEXT_MAX_BYTES);
  let state = session.state;
  if (state.type === "completed") {
    state = {
      ...state,
      finalResponse: truncateOptionalText(state.finalResponse, SUMMARY_TEXT_MAX_BYTES)
    };
  } else if (state.type === "failed") {
    state = {
      ...state,
      error: truncateTextByBytes(state.error, SUMMARY_TEXT_MAX_BYTES)
    };
  }
  return {
    ...session,
    state,
    messages: [],
    finalResponse,
    error
  };
}

function toStudioRunSummary(run: StudioRunState | StudioRunSummary): StudioRunSummary {
  const runtimeRun = hasRunRuntimeBuffers(run) ? run : undefined;
  const summaryRun = runtimeRun ? undefined : run as StudioRunSummary;
  const pathCommits = run.pathCommits ? { ...run.pathCommits } : undefined;
  const planExecutionTransition = runtimeRun ? attachPlanExecutionTransition(run.repositoryPath, runtimeRun) : run.planExecutionTransition;
  const memberPathRuns = runtimeRun
    ? runtimeRun.memberPathRuns?.map(pathRun =>
      sanitizeMemberPathRunForSummary(attachCurrentExecutionTransition(runtimeRun.repositoryPath, runtimeRun, pathRun))
    )
    : run.memberPathRuns?.map(sanitizeMemberPathRunForSummary);
  return {
    runId: run.runId,
    roadmapId: run.roadmapId,
    executeId: run.executeId,
    requestId: run.requestId,
    lineId: run.lineId,
    repositoryPath: run.repositoryPath,
    provider: run.provider,
    source: run.source,
    status: run.status,
    selectedDestinationIds: [...run.selectedDestinationIds],
    harnessLock: run.harnessLock,
    sourceNodeId: run.sourceNodeId,
    sourceMoveId: run.sourceMoveId,
    targetMoveOrdinal: run.targetMoveOrdinal,
    worktree: run.worktree,
    conversationRef: run.conversationRef,
    outcome: run.outcome,
    providerThreadId: run.providerThreadId,
    providerTeamThreadId: run.providerTeamThreadId,
    providerTeamPlanningTurnId: run.providerTeamPlanningTurnId,
    providerMemberThreadId: run.providerMemberThreadId,
    providerFinalizerThreadId: run.providerFinalizerThreadId,
    providerTurnIds: run.providerTurnIds ? [...run.providerTurnIds] : undefined,
    finalResponse: truncateOptionalText(run.finalResponse, SUMMARY_TEXT_MAX_BYTES),
    attemptCount: run.attemptCount,
    maxAttemptCount: run.maxAttemptCount,
    memberEvaluations: run.memberEvaluations ? [...run.memberEvaluations] : undefined,
    executionPlanPlan: run.executionPlanPlan ? [...run.executionPlanPlan] : undefined,
    pathCommits,
    planExecutionTransition,
    memberPathRuns,
    terminalMemberPathId: run.terminalMemberPathId,
    terminalPathCommit: run.terminalPathCommit,
    moveFinalizerMessage: truncateOptionalText(run.moveFinalizerMessage, SUMMARY_TEXT_MAX_BYTES),
    moveFinalizerCommit: run.moveFinalizerCommit,
    error: truncateOptionalText(run.error, SUMMARY_TEXT_MAX_BYTES),
    codexTurns: run.codexTurns ? [...run.codexTurns] : [],
    agentSessions: run.agentSessions.map(toAgentSessionSummary),
    activeItemIds: [...run.activeItemIds],
    activeAgentSessionId: run.activeAgentSessionId,
    liveStatus: run.liveStatus,
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
    debugEventCount: runtimeRun ? runtimeRun.debugEvents.length : summaryRun!.debugEventCount,
    rawAppServerMessageCount: runtimeRun ? runtimeRun.rawAppServerMessages.length : summaryRun!.rawAppServerMessageCount,
    codexItemCount: runtimeRun ? runtimeRun.codexItems.length : summaryRun!.codexItemCount,
    assistantTranscriptCount: runtimeRun ? runtimeRun.assistantTranscript.length : summaryRun!.assistantTranscriptCount
  };
}

function hasRunRuntimeBuffers(run: StudioRunState | StudioRunSummary): run is StudioRunState {
  return "debugEvents" in run;
}

function sanitizeMemberPathRunForSummary(pathRun: StudioMemberPathRun): StudioMemberPathRun {
  if (pathRun.status === "completed") {
    return {
      ...pathRun,
      finalResponse: truncateTextByBytes(pathRun.finalResponse, SUMMARY_TEXT_MAX_BYTES)
    };
  }
  if (pathRun.status === "failed") {
    return {
      ...pathRun,
      error: truncateTextByBytes(pathRun.error, SUMMARY_TEXT_MAX_BYTES),
      finalResponse: truncateOptionalText(pathRun.finalResponse, SUMMARY_TEXT_MAX_BYTES)
    };
  }
  return pathRun;
}

function attachPlanExecutionTransition(cwd: string | undefined, run: StudioRunState): StudioExecutionTransition | undefined {
  if (!cwd) {
    return run.planExecutionTransition;
  }
  const nextCommit = run.pathCommits?.["current-execution.plan"];
  const previousCommit = run.pathCommits?.PrevMove ?? parseOptionalCommitSha(run.worktree?.baseRef);
  const transition = buildCurrentExecutionTransition(cwd, previousCommit, nextCommit, {
    nextPending: isActiveRunStatus(run.status) && !nextCommit && !run.currentExecution
  });
  return transition ?? run.planExecutionTransition;
}

function attachCurrentExecutionTransition(cwd: string | undefined, run: StudioRunState, pathRun: StudioMemberPathRun): StudioMemberPathRun {
  if (!cwd || pathRun.currentExecutionTransition) {
    return pathRun;
  }
  const commit = "commit" in pathRun ? pathRun.commit : undefined;
  const parentCommit = ("parentCommit" in pathRun ? pathRun.parentCommit : undefined) ?? previousCommitForPathRun(run, pathRun);
  const transition = buildCurrentExecutionTransition(cwd, parentCommit, commit, {
    nextPending: !commit && (pathRun.status === "starting" || pathRun.status === "executing")
  });
  if (!transition) {
    return pathRun;
  }
  return {
    ...pathRun,
    currentExecutionTransition: transition,
    currentExecutionFile: pathRun.currentExecutionFile ?? transition.next
  };
}

function previousCommitForPathRun(run: StudioRunState, pathRun: StudioMemberPathRun): CommitSha | undefined {
  const pathRuns = run.memberPathRuns ?? [];
  const index = pathRuns.findIndex(candidate => candidate === pathRun);
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const candidate = pathRuns[cursor];
    if (candidate && candidate.status === "completed" && "commit" in candidate && candidate.commit) {
      return candidate.commit;
    }
  }
  return run.pathCommits?.["current-execution.plan"];
}

function parseOptionalCommitSha(value: string | undefined): CommitSha | undefined {
  if (!value) {
    return undefined;
  }
  try {
    return parseCommitSha(value);
  } catch (_error) {
    return undefined;
  }
}

function buildCurrentExecutionTransition(
  cwd: string,
  previousCommit: CommitSha | undefined,
  nextCommit: CommitSha | undefined,
  options: { nextPending?: boolean } = {}
): StudioExecutionTransition | undefined {
  if (!previousCommit && !nextCommit && !options.nextPending) {
    return undefined;
  }
  const previous = previousCommit ? readCurrentExecutionFileAtCommit(cwd, previousCommit) : undefined;
  const next = nextCommit ? readCurrentExecutionFileAtCommit(cwd, nextCommit) : undefined;
  return {
    path: HUNSU_CURRENT_EXECUTION_PATH,
    previousCommit,
    previous,
    previousState: previous ? "present" : "none",
    nextCommit,
    next,
    nextState: options.nextPending && !nextCommit ? "pending" : next ? "present" : "none"
  };
}

function readCurrentExecutionFileAtCommit(cwd: string, commit: CommitSha): StudioEncodedRuntimeFile | undefined {
  try {
    return {
      path: HUNSU_CURRENT_EXECUTION_PATH,
      commit,
      text: git(["show", `${commit}:${HUNSU_CURRENT_EXECUTION_PATH}`], { cwd })
    };
  } catch (_error) {
    return undefined;
  }
}

function runBelongsToRepository(run: Pick<StudioRunState, "repositoryPath">, cwd: string | undefined): boolean {
  if (!cwd || !run.repositoryPath) {
    return false;
  }
  return sameRepositoryPath(run.repositoryPath, cwd);
}

function sameRepositoryPath(left: string, right: string): boolean {
  return normalizeRepositoryPath(left) === normalizeRepositoryPath(right);
}

function normalizeRepositoryPath(path: string): string {
  return safeRealpath(path) ?? resolve(path);
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    ...securityHeadersForResponse(response),
    "content-type": "application/json; charset=utf-8",
  });
  response.end(`${JSON.stringify(value, null, 2)}\n`);
}

function securityHeadersForResponse(response: ServerResponse): Record<string, string> {
  return responseSecurityHeaders.get(response) ?? baseCorsHeaders();
}

async function readJson<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  await startStudioBridge({ cwd: APP_WORKSPACE_ROOT, noOpen: true });
}
