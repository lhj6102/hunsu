import type { ArtifactActionDefinition, BoardProjection, HubPackageLock, ExecutionPlan, ManagerConfig, SkillBinding } from "@hunsu/protocol";

export type ConnectionState = "connecting" | "live" | "empty" | "offline" | "saving";
export type CommandResult = { acceptedEvents: unknown[]; board: BoardProjection };
export type MoveOutcome = "arrived" | "accident";

export type WorktreeRef = {
  worktreeHash: string;
  path: string;
  branch: string;
  baseRef: string;
  createdAt: string;
  removedAt?: string;
};

export type AgentConversationRef = {
  provider: "codex" | "local";
  conversationHash: string;
  threadId?: string;
  contextHash: string;
  worktreeHash?: string;
  startedAt: string;
  endedAt?: string;
};

export type StudioRunStatus =
  | "running"
  | "paused"
  | "arrived"
  | "accident"
  | "failed"
  | "discarded"
  | "finished"
  | "stopped";

export type MemberPath = {
  id: string;
  executorId: string;
  goal: string;
  requires: string[] | "PrevMove";
};

export type StudioAgentSessionRef = {
  providerThreadId: string;
  providerTurnId: string;
};

export type StudioEncodedRuntimeFile = {
  path: string;
  commit: string;
  text: string;
};

export type StudioExecutionFileState = "present" | "none";
export type StudioExecutionNextState = StudioExecutionFileState | "pending";

export type StudioExecutionTransition = {
  path: string;
  previousCommit?: string;
  previous?: StudioEncodedRuntimeFile;
  previousState?: StudioExecutionFileState;
  nextCommit?: string;
  next?: StudioEncodedRuntimeFile;
  nextState?: StudioExecutionNextState;
};

type StudioMemberPathRunBase = {
  pathId: string;
  executorId: string;
  goal: string;
  requires: string[] | "PrevMove";
  attempt: number;
  agentSessionId?: string;
  dependencyPathIds: string[];
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
      commit?: string;
      parentCommit?: string;
      treeChanged?: boolean;
      completedAt: string;
    })
  | (StudioMemberPathRunBase & {
      status: "failed";
      session?: StudioAgentSessionRef;
      error: string;
      finalResponse?: string;
      commit?: string;
      parentCommit?: string;
      treeChanged?: boolean;
      completedAt: string;
    });

export type StudioMemberPathEvaluation = {
  summary: string;
  evidence: string[];
  risks: string[];
  terminalPathId?: string;
  terminalPathCommit?: string;
  attempt: number;
  at: string;
};

export type StudioCodexCommandAction =
  | { type: "read"; command?: string; name?: string; path?: string }
  | { type: "listFiles"; command?: string; path?: string }
  | { type: "search"; command?: string; query?: string; path?: string }
  | { type: "unknown"; command?: string };

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
  commandActions?: StudioCodexCommandAction[];
  output?: string;
  changes?: unknown;
  rawItem?: unknown;
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
  | { kind: "TeamPlan"; runId: string; executeId: string; attempt: number }
  | { kind: "ExecutionPlan"; runId: string; executeId: string; attempt: number; pathId: string; executorId: string }
  | { kind: "MoveFinalizer"; runId: string; executeId: string; moveId?: string }
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
  commandActions?: StudioCodexCommandAction[];
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

export type StudioRawAppServerMessage = {
  direction: "server-notification" | "server-request";
  method?: string;
  providerThreadId?: string;
  providerTurnId?: string;
  message: unknown;
  at: string;
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
  sourceNodeId?: string;
  sourceMoveId?: string;
  targetMoveOrdinal?: number;
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
  attemptCount?: number;
  maxAttemptCount?: number;
  currentExecution?: ExecutionPlan;
  memberEvaluations?: StudioMemberPathEvaluation[];
  executionPlanPlan?: MemberPath[];
  pathCommits?: Record<string, string>;
  planExecutionTransition?: StudioExecutionTransition;
  memberPathRuns?: StudioMemberPathRun[];
  terminalMemberPathId?: string;
  terminalPathCommit?: string;
  moveFinalizerMessage?: string;
  moveFinalizerCommit?: string;
  error?: string;
  debugEvents?: { type: string; error?: string; finalResponse?: string; headline?: string; detail?: string; deltaKind?: string; delta?: string; itemId?: string; item?: unknown }[];
  rawAppServerMessages?: StudioRawAppServerMessage[];
  codexTurns?: { providerThreadId: string; providerTurnId: string; status: "started" | "completed"; startedAt?: string; completedAt?: string }[];
  codexItems?: StudioCodexItem[];
  agentSessions?: AgentSession[];
  activeItemIds?: string[];
  activeAgentSessionId?: string;
  liveStatus?: StudioLiveStatus;
  assistantTranscript?: StudioAssistantTranscript[];
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

export type StudioExecuteView = StudioRunSummary & {
  teamRouteId: string;
  statusLabel: string;
  outcomeLabel?: "Arrived" | "Accident";
  memberEvaluations: StudioMemberPathEvaluation[];
};

export type RunListResult = { runs: StudioRunSummary[]; executes?: StudioExecuteView[] };
export type RunResult = { run: StudioRunSummary; board: BoardProjection };
export type MoveCompletionResult = RunResult & { moveId: string; commit: string; acceptedEvents: unknown[] };
export type AgentSessionListResult = { sessions: AgentSession[] };
export type AgentSessionResult = { session: AgentSession };

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

export type StudioHunsuDraftDiffArtifactRecord = Omit<StudioHunsuDraftDiffArtifact, "files"> & {
  summary: string;
  files: StudioHunsuDraftRuntimeFileChange[];
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
  readyDraft?: unknown;
  latestDiffArtifactId?: string;
  diffArtifacts?: Record<string, StudioHunsuDraftDiffArtifactRecord>;
  status: StudioHunsuDraftStatus;
  error?: string;
  createdAt: string;
  updatedAt: string;
};

export type HunsuDraftResult = {
  draft: StudioHunsuDraftSession;
  board: BoardProjection;
  diffArtifact?: StudioHunsuDraftDiffArtifact;
  acceptedEvents?: unknown[];
  hunsu?: {
    id: string;
    toNodeId: string;
    summary: string;
  };
};

export type HunsuDraftDiffArtifactResult = {
  diffArtifact: StudioHunsuDraftDiffArtifact;
};

export type HunsuDraftListResult = {
  drafts: StudioHunsuDraftSession[];
};

export type RoadmapRegistryEntry = {
  roadmapId: string;
  displayName: string;
  repositoryPath: string;
  lastOpenedAt: string;
  lastKnownBranch?: string;
  health: "ok" | "missing";
};

export type RoadmapListResult = { roadmaps: RoadmapRegistryEntry[] };
export type RoadmapOpenResult = { roadmap: RoadmapRegistryEntry; repository: WorktreeStatus; board: BoardProjection };

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

export type FilesystemGrantResult = {
  capability: FilesystemBrowseCapability;
};

export type MoveFileNode =
  | { kind: "directory"; name: string; path: string }
  | { kind: "textFile"; name: string; path: string; size: number }
  | { kind: "binaryFile"; name: string; path: string; size: number }
  | { kind: "tooLarge"; name: string; path: string; size: number }
  | { kind: "hiddenRuntime"; name: string; path: string };

export type MoveRuntimeCapsule = {
  hiddenRuntimeFileCount: number;
  runtimePaths: string[];
  summary: string;
};

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

export type MoveFileDiff = {
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

export type MoveFileTreeResult = { tree: MoveFileTree };
export type MoveFileBlobResult = { blob: MoveFileBlob };
export type MoveFileDiffResult = { diff: MoveFileDiff };

export type StudioSkillSummary = SkillBinding & { files: { path: string; size: number; text?: string }[] };
export type SkillListResult = { skills: StudioSkillSummary[] };

export type WorktreeStatus = {
  root: string;
  branch: string;
  clean: boolean;
  changes: { status: string; path: string }[];
};

export type StudioLiveEvent =
  | { type: "runs.snapshot"; runs: StudioRunSummary[] }
  | { type: "run.updated"; run: StudioRunSummary; board?: BoardProjection };

export type AgentSessionEvent =
  | { type: "agentSession.snapshot"; sessions: AgentSession[] }
  | {
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
    }
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
      commandActions?: StudioCodexCommandAction[];
      output?: string;
      changes?: unknown;
      messageRevision: number;
      sessionRevision: number;
      createdAt: string;
      completedAt: string;
      durationMs?: number;
      updatedAt: string;
    };

export type StudioArtifactAction = ArtifactActionDefinition;

export type ArtifactActionAlias = {
  alias: string;
  service?: string;
  containerPort?: number;
  healthPath?: string;
  target?: string;
  internalUrl?: string;
  externalPath: string;
  directUrl?: string;
};

export type StudioActionRun = {
  runId: string;
  actionId: string;
  roadmapId?: string;
  action: StudioArtifactAction;
  source?: { moveId?: string; commit?: string };
  status: "queued" | "running" | "succeeded" | "failed" | "stopped" | string;
  sourceWorktree?: { path: string; commit: string; createdAt: string; removedAt?: string };
  env?: Record<string, string>;
  aliases?: Record<string, ArtifactActionAlias>;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  createdAt: string;
  updatedAt: string;
  stoppedAt?: string;
  error?: string;
};

export type ArtifactActionListResult = { actions: StudioArtifactAction[] };
export type ActionRunListResult = { runs: StudioActionRun[] };
export type ActionRunResult = { run: StudioActionRun };
