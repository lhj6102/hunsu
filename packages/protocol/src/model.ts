import type {
  Brand,
  DestinationAcceptanceCriterion,
  DestinationConstraint,
  DestinationNotes,
  DestinationTitle,
  TeamName,
  EvidenceText,
  FailureReason,
  MoveCommit,
  NonEmptyArray,
  NonEmptyText,
  NonNegativeInteger,
  PositiveInteger,
  RequestGoal,
  RequestTitle,
  RiskText,
  SingleItemArray,
  Summary
} from "./primitives.ts";
import type { PromptTemplate } from "./prompt-template.ts";
import type { Result } from "./result.ts";

export type { TeamName } from "./primitives.ts";

export type Raw<T> =
  T extends (string & { readonly __brand: string }) ? string :
  T extends (number & { readonly __brand: string }) ? number :
  T extends readonly [infer First, ...infer Rest] ? [Raw<First>, ...{ [K in keyof Rest]: Raw<Rest[K]> }] :
  T extends readonly (infer Item)[] ? Raw<Item>[] :
  T extends object ? { [K in keyof T]: Raw<T[K]> } :
  T;

export type DomainRole = "TEAM" | "DIRECTOR" | "SYSTEM";
export type SerializedIsoTimestamp = string;

export type RequestId = Brand<string, "RequestId">;
export type DestinationId = Brand<string, "DestinationId">;
export type MoveId = Brand<string, "MoveId">;
export type HunsuId = Brand<string, "HunsuId">;
export type HunsuDraftId = Brand<string, "HunsuDraftId">;
export type LineId = Brand<string, "LineId">;
export type NodeId = Brand<string, "NodeId">;
export type ArtifactId = Brand<string, "ArtifactId">;
export type ArtifactActionId = Brand<string, "ArtifactActionId">;
export type TeamId = Brand<string, "TeamId">;
export type SkillDraftId = Brand<string, "SkillDraftId">;
export type AgentConversationHash = Brand<string, "AgentConversationHash">;
export type ExecuteId = Brand<string, "ExecuteId">;
export type RouteId = Brand<string, "RouteId">;
export type WorktreeHash = Brand<string, "WorktreeHash">;
export type AgentContextHash = NonEmptyText;
export type AgentThreadId = NonEmptyText;
export type ExecutorId = NonEmptyText;
export type ManagerId = NonEmptyText;
export type ResourceId = Brand<string, "ResourceId">;
export type PathId = NonEmptyText;
export type MemberModelName = NonEmptyText;
export type MemberSkillName = NonEmptyText;
export type FutureConstraintText = NonEmptyText;

export type DestinationStatus =
  | "pending"
  | "claimed"
  | "in_progress"
  | "reached"
  | "blocked"
  | "superseded"
  | "canceled";

export type DestinationSeed = {
  id: DestinationId;
  title: DestinationTitle;
  acceptanceCriteria?: DestinationAcceptanceCriterion[];
  constraints?: DestinationConstraint[];
  priority?: number;
  notes?: DestinationNotes;
};

export type DestinationSeedInput = Raw<DestinationSeed>;

export type DestinationSource = "initial-execute-team" | "initial-request" | "hunsu";

export type DestinationBase = DestinationSeed & {
  requestId: RequestId;
  source: DestinationSource;
  createdBy: DomainRole;
  updatedBy: DomainRole;
  createdAt?: SerializedIsoTimestamp;
  updatedAt?: SerializedIsoTimestamp;
};

export type PendingDestination = DestinationBase & {
  status: "pending";
  claimedBy?: never;
  reachedByMoveId?: never;
  blockedReason?: never;
  canceledReason?: never;
  supersededByDestinationId?: never;
};

export type ClaimedDestination = DestinationBase & {
  status: "claimed";
  claimedBy: string;
  reachedByMoveId?: never;
  blockedReason?: never;
  canceledReason?: never;
  supersededByDestinationId?: never;
};

export type InProgressDestination = DestinationBase & {
  status: "in_progress";
  claimedBy: string;
  reachedByMoveId?: never;
  blockedReason?: never;
  canceledReason?: never;
  supersededByDestinationId?: never;
};

export type ReachedDestination = DestinationBase & {
  status: "reached";
  reachedByMoveId: MoveId;
  claimedBy?: string;
  blockedReason?: never;
  canceledReason?: never;
  supersededByDestinationId?: never;
};

export type BlockedDestination = DestinationBase & {
  status: "blocked";
  blockedReason: string;
  claimedBy?: string;
  reachedByMoveId?: never;
  canceledReason?: never;
  supersededByDestinationId?: never;
};

export type SupersededDestination = DestinationBase & {
  status: "superseded";
  supersededByDestinationId: DestinationId;
  claimedBy?: string;
  reachedByMoveId?: never;
  blockedReason?: never;
  canceledReason?: never;
};

export type CanceledDestination = DestinationBase & {
  status: "canceled";
  canceledReason: string;
  claimedBy?: string;
  reachedByMoveId?: never;
  blockedReason?: never;
  supersededByDestinationId?: never;
};

export type Destination =
  | PendingDestination
  | ClaimedDestination
  | InProgressDestination
  | ReachedDestination
  | BlockedDestination
  | SupersededDestination
  | CanceledDestination;

export type RequestRecord = {
  id: RequestId;
  title: RequestTitle;
  goal: RequestGoal;
  createdBy: DomainRole;
  createdAt?: SerializedIsoTimestamp;
};

export type SkillSnapshotFile = {
  path: NonEmptyText;
  text: string;
};

export type LocalSnapshotSkillMetadata = {
  kind: "local-snapshot";
  name: NonEmptyText;
  sourcePath: NonEmptyText;
  contentHash: NonEmptyText;
  snapshotRef: NonEmptyText;
  snapshotFiles?: SkillSnapshotFile[];
};

export type LocalRootInstalledSkillMetadata = {
  kind: "local-root-installed";
  name: NonEmptyText;
  sourcePath?: NonEmptyText;
};

export type RegistryPackageSkillMetadata = {
  kind: "registry-package";
  registryKind: "apm";
  name: NonEmptyText;
  registry: NonEmptyText;
  package: NonEmptyText;
  version: NonEmptyText;
  integrity: NonEmptyText;
  contentHash: NonEmptyText;
};

export type SkillMetaSkillMetadata = {
  kind: "skillMeta";
  name: NonEmptyText;
  source: NonEmptyText;
  agent: "codex";
};

export type MemberSkillMetadata =
  | LocalSnapshotSkillMetadata
  | LocalRootInstalledSkillMetadata
  | RegistryPackageSkillMetadata
  | SkillMetaSkillMetadata;

export type SkillBinding = MemberSkillMetadata;

export type LocalRootInstalledPluginBinding = {
  kind: "local-root-installed";
  id: string;
};

export type MemberPluginBinding =
  | LocalRootInstalledPluginBinding;

export type HubPackageKind = "team" | "member" | "manager" | "skill";

export type HubPackageLock = {
  origin: NonEmptyText;
  kind: HubPackageKind;
  key: NonEmptyText;
  version: NonEmptyText;
  integrity: NonEmptyText;
};

export type ExecutorPackageBinding = {
  executorId: ExecutorId;
  lock: HubPackageLock;
};

export type ResourcePackageBinding = {
  name: MemberSkillName;
  lock: HubPackageLock;
};

export type HunsuOriginTransport = "http" | "ssh";

export type HunsuOrigin = {
  name: NonEmptyText;
  url: NonEmptyText;
  transport: HunsuOriginTransport;
  identity?: NonEmptyText;
};

export type ReasoningEffort = "default" | "minimal" | "low" | "medium" | "high" | "xhigh";
export type ServiceTier = "default" | "fast";
export type RuntimeProviderId = "codex" | "claude_code" | "gemini_cli" | "openhands" | "custom";
export type MemberExecutionNetwork = "disabled" | "enabled";
export type MemberExecutionConstraint =
  | { kind: "read_only"; network: MemberExecutionNetwork }
  | { kind: "worktree_write"; network: MemberExecutionNetwork }
  | { kind: "unrestricted"; network: MemberExecutionNetwork };
export type MemberApprovalsReviewer = "user" | "auto_review";
export type MemberApprovalConstraint =
  | { policy: "never" }
  | { policy: "on_request"; reviewer: MemberApprovalsReviewer };
export type GuardrailScope = "input" | "output" | "context" | "artifact" | "final_evidence";
export type GuardrailSeverity = "warn" | "block";

export type GuardrailConfig = {
  name: NonEmptyText;
  scope: GuardrailScope;
  rule: NonEmptyText;
  severity: GuardrailSeverity;
};

export type ResourceBinding =
  | { kind: "skill"; skill: SkillBinding }
  | { kind: "plugin"; plugin: MemberPluginBinding }
  | { kind: "package"; lock: HubPackageLock };

export type CodexModelSelection =
  | {
      providerId: "codex";
      model: "gpt-5.5-thinking";
      reasoningEffort: Extract<ReasoningEffort, "high" | "xhigh">;
      serviceTier?: ServiceTier;
      experimental?: false;
    }
  | {
      providerId: "codex";
      model: "gpt-5.5";
      reasoningEffort?: Exclude<ReasoningEffort, "minimal" | "xhigh">;
      serviceTier?: ServiceTier;
      experimental?: false;
    }
  | {
      providerId: "codex";
      model: MemberModelName;
      reasoningEffort?: ReasoningEffort;
      serviceTier?: ServiceTier;
      experimental: true;
    };

export type DirectProviderModelSelection =
  | CodexModelSelection
  | {
      providerId: Exclude<RuntimeProviderId, "codex">;
      model: MemberModelName;
      reasoningEffort?: ReasoningEffort;
      serviceTier?: ServiceTier;
      experimental?: boolean;
    };

export type DirectModelSelection = {
  kind: "direct";
  provider: DirectProviderModelSelection;
};

export type AliasModelSelection = {
  kind: "alias";
  aliasId: NonEmptyText;
};

export type ModelSelection = DirectModelSelection | AliasModelSelection;

export type ModelAliasScope =
  | { kind: "user" }
  | { kind: "workspace"; workspaceId: NonEmptyText }
  | { kind: "team"; teamId: NonEmptyText }
  | { kind: "local" };

export type ModelAlias = {
  aliasId: NonEmptyText;
  displayName: NonEmptyText;
  description?: NonEmptyText;
  selection: DirectModelSelection;
  scope: ModelAliasScope;
  createdAt: SerializedIsoTimestamp;
  updatedAt: SerializedIsoTimestamp;
};

export type ModelAliasOverride = {
  aliasId: NonEmptyText;
  backendId: NonEmptyText;
  selection: DirectModelSelection;
  reason?: NonEmptyText;
  updatedAt: SerializedIsoTimestamp;
};

export type ProviderModelDescriptor = {
  model: MemberModelName;
  label: NonEmptyText;
  capabilities: {
    reasoningEfforts?: ReasoningEffort[];
    serviceTiers?: ServiceTier[];
    supportsReasoning?: boolean;
    supportsFastTier?: boolean;
  };
  defaultConfig?: DirectProviderModelSelection;
  experimental?: boolean;
};

export type ProviderInventoryProvider = {
  providerId: RuntimeProviderId;
  label: NonEmptyText;
  ready: boolean;
  authState?: "authenticated" | "not_authenticated" | "expired" | "invalid" | "unknown" | "error";
  models: ProviderModelDescriptor[];
};

export type ProviderModelInventory = ProviderInventoryProvider;

export type ProviderInventory = {
  backendId: NonEmptyText;
  providers: ProviderInventoryProvider[];
};

export type ProviderInventoryError =
  | {
      code: "BACKEND_UNAVAILABLE";
      backendId: NonEmptyText;
      message: string;
    }
  | {
      code: "PROVIDER_INVENTORY_UNAVAILABLE";
      backendId: NonEmptyText;
      providerId: string;
      message: string;
    };

export type ProviderInventoryResult = Result<ProviderInventory, ProviderInventoryError>;

export type RuntimePolicy = {
  modelSelection?: ModelSelection;
  model?: MemberModelName;
  reasoningEffort?: ReasoningEffort;
  serviceTier?: ServiceTier;
  execution: MemberExecutionConstraint;
  approval: MemberApprovalConstraint;
};

export type TeamPlanner = {
  promptTemplate: PromptTemplate;
  maxAttemptCount?: PositiveInteger;
  guardrails?: GuardrailConfig[];
};

export type ExecutorVisibleProfile = {
  kind: "team" | "member";
  label?: NonEmptyText;
  summary?: NonEmptyText;
  capabilities?: NonEmptyText[];
};

export type Membership = {
  executorId: ExecutorId;
  visibleProfile: ExecutorVisibleProfile;
};

export type Team = {
  kind: "team";
  id: ExecutorId;
  planner: TeamPlanner;
  members: Membership[];
};

export type Member = {
  kind: "member";
  id: ExecutorId;
  promptTemplate: PromptTemplate;
  resources: ResourceBinding[];
  runtimePolicy: RuntimePolicy;
};

export type Executor = Team | Member;

export type ExecutorEntity = Executor & {
  packageLock?: HubPackageLock;
};

export type ResourceEntity = {
  id: ResourceId;
  binding: ResourceBinding;
  packageLock?: HubPackageLock;
};

export type Harness = {
  rootTeamId: ExecutorId;
  executors: ExecutorEntity[];
  resources: ResourceEntity[];
  guardrails: GuardrailConfig[];
  artifactActions: ArtifactActionDefinition[];
};

export type MemberConfig = {
  id: ExecutorId;
  promptTemplate: PromptTemplate;
  skills: MemberSkillMetadata[];
  plugins: MemberPluginBinding[];
  modelSelection?: ModelSelection;
  model: MemberModelName;
  reasoningEffort: ReasoningEffort;
  serviceTier?: ServiceTier;
  execution: MemberExecutionConstraint;
  approval: MemberApprovalConstraint;
};

export type ManagerConfig = {
  id: ManagerId;
  promptTemplate: PromptTemplate;
  skills: SkillBinding[];
  plugins: MemberPluginBinding[];
  modelSelection?: ModelSelection;
};

export type MemberPath = {
  id: PathId;
  executorId: ExecutorId;
  goal: string;
  requires: PathId[] | "PrevMove";
};

export type QueueExecutionPlan = {
  kind: "queue";
  id: PathId;
  items: ExecutionPlan[];
};

export type ExecutionContinuation = {
  kind: "continuation";
  id: PathId;
  teamScopeId: ExecutorId;
  execution: ExecutionPlan;
  continuation?: GoalExecutionPlan;
};

export type GoalPathEvaluationStage = {
  kind: "goal";
  stage: "needs_evaluation";
  id: PathId;
  assignee: {
    executorId: ExecutorId;
    goal: string;
  };
  evaluator?: {
    executorId: ExecutorId;
    prompt: string;
  };
  remainingAttempts: NonNegativeInteger;
  requires: MemberPath["requires"];
};

export type GoalExecutionPlanStage = {
  kind: "goal";
  stage: "needs_execution";
  id: PathId;
  assignee: {
    executorId: ExecutorId;
    goal: string;
  };
  evaluator?: {
    executorId: ExecutorId;
    prompt: string;
  };
  remainingAttempts: NonNegativeInteger;
  evaluationPathId: PathId;
  evaluation: Extract<GoalEvaluation, { type: "fail" }>;
  requires: PathId[];
};

export type GoalExecutionPlan = GoalPathEvaluationStage | GoalExecutionPlanStage;

export type ExecutionPlan = QueueExecutionPlan | GoalExecutionPlan | ExecutionContinuation;

export type GoalEvaluation =
  | {
      type: "pass";
      summary: string;
      evidence?: string[];
    }
  | {
      type: "fail";
      reason: string;
      feedback: string;
      nextGoal?: string;
      evidence?: string[];
    };

export type TeamExecutionPlanHarnessSnapshot = {
  kind: "team_execution_plan";
  maxAttemptCount: PositiveInteger;
  guardrails?: GuardrailConfig[];
  team: {
    promptTemplate: PromptTemplate;
  };
  members: MemberConfig[];
};

export type TeamExecutionPlanHarnessPlannerSnapshot = Omit<TeamExecutionPlanHarnessSnapshot, "members"> & {
  members?: never;
};

export type RoleSquadHarnessSnapshot = {
  kind: "role_squad";
  maxRoundCount: PositiveInteger;
  guardrails?: GuardrailConfig[];
  team: {
    promptTemplate: PromptTemplate;
  };
  members: MemberConfig[];
};

export type RoleSquadHarnessPlannerSnapshot = Omit<RoleSquadHarnessSnapshot, "members"> & {
  members?: never;
};

export type CouncilVoteHarnessSnapshot = {
  kind: "council_vote";
  maxRoundCount: PositiveInteger;
  voteRule: "majority" | "unanimous" | "weighted" | "coordinator_decides";
  guardrails?: GuardrailConfig[];
  team: {
    promptTemplate: PromptTemplate;
  };
  members: MemberConfig[];
};

export type CouncilVoteHarnessPlannerSnapshot = Omit<CouncilVoteHarnessSnapshot, "members"> & {
  members?: never;
};

export type CourtDebateHarnessSnapshot = {
  kind: "court_debate";
  preset?: "security_review";
  maxRoundCount: PositiveInteger;
  guardrails?: GuardrailConfig[];
  team: {
    promptTemplate: PromptTemplate;
  };
  members: MemberConfig[];
};

export type CourtDebateHarnessPlannerSnapshot = Omit<CourtDebateHarnessSnapshot, "members"> & {
  members?: never;
};

export type HarnessSnapshot =
  | TeamExecutionPlanHarnessSnapshot
  | RoleSquadHarnessSnapshot
  | CouncilVoteHarnessSnapshot
  | CourtDebateHarnessSnapshot;

export type HarnessPlannerSnapshot =
  | TeamExecutionPlanHarnessPlannerSnapshot
  | RoleSquadHarnessPlannerSnapshot
  | CouncilVoteHarnessPlannerSnapshot
  | CourtDebateHarnessPlannerSnapshot;

export type HarnessSnapshotInput = Raw<HarnessSnapshot>;

export type SkillDraftBase = {
  id: SkillDraftId;
  name: NonEmptyText;
  sourcePath?: NonEmptyText;
  draftPath: NonEmptyText;
  createdFromNodeId?: NodeId;
  createdAt?: SerializedIsoTimestamp;
};

export type DraftSkillDraft = SkillDraftBase & {
  status: "draft";
  acceptedSnapshot?: never;
};

export type AcceptedSkillDraft = SkillDraftBase & {
  status: "accepted";
  acceptedSnapshot: SkillBinding;
};

export type DiscardedSkillDraft = SkillDraftBase & {
  status: "discarded";
  acceptedSnapshot?: never;
};

export type SkillDraftRecord = DraftSkillDraft | AcceptedSkillDraft | DiscardedSkillDraft;

export type AgentConversationRefBase = {
  conversationHash: AgentConversationHash;
  contextHash: AgentContextHash;
  worktreeHash?: WorktreeHash;
  startedAt: SerializedIsoTimestamp;
};

export type ActiveCodexAgentConversationRef = AgentConversationRefBase & {
  provider: "codex";
  threadId?: AgentThreadId;
  endedAt?: never;
};

export type EndedCodexAgentConversationRef = AgentConversationRefBase & {
  provider: "codex";
  threadId?: AgentThreadId;
  endedAt: SerializedIsoTimestamp;
};

export type ActiveLocalAgentConversationRef = AgentConversationRefBase & {
  provider: "local";
  threadId?: never;
  endedAt?: never;
};

export type EndedLocalAgentConversationRef = AgentConversationRefBase & {
  provider: "local";
  threadId?: never;
  endedAt: SerializedIsoTimestamp;
};

export type AgentConversationRef =
  | ActiveCodexAgentConversationRef
  | EndedCodexAgentConversationRef
  | ActiveLocalAgentConversationRef
  | EndedLocalAgentConversationRef;

export type AgentConversationRefInput = Raw<AgentConversationRef>;

export type AgentConversationAccessMode = "READ" | "CONVERSE" | "TRANSACT";

export type WorktreeRefBase = {
  worktreeHash: WorktreeHash;
  path: NonEmptyText;
  branch: NonEmptyText;
  baseRef: NonEmptyText;
  createdAt: SerializedIsoTimestamp;
};

export type ActiveWorktreeRef = WorktreeRefBase & {
  removedAt?: never;
};

export type RemovedWorktreeRef = WorktreeRefBase & {
  removedAt: SerializedIsoTimestamp;
};

export type WorktreeRef = ActiveWorktreeRef | RemovedWorktreeRef;

export type RouteRecordBase = {
  routeId: RouteId;
  sourceLineId: LineId;
  sourceNodeId: NodeId;
  targetNodeId?: NodeId;
  worktree: WorktreeRef;
  agentSessionId?: string;
};

export type PlanRoute = RouteRecordBase & {
  kind: "Plan";
  access: "READ";
  currentExecutionPath: ".hunsu/current-execution.hunsu";
  chat?: never;
  readyDraft?: never;
};

export type PathRoute = RouteRecordBase & {
  kind: "Path";
  access: "READ";
  pathId: PathId;
  executorId: ExecutorId;
  chat?: never;
  readyDraft?: never;
};

export type DraftHunsuDraftRoute = RouteRecordBase & {
  kind: "HunsuDraft";
  access: "CONVERSE";
  status: "draft";
  readyDraft?: never;
  confirmedHunsuId?: never;
  confirmedNodeId?: never;
};

export type ReadyHunsuDraftRoute = RouteRecordBase & {
  kind: "HunsuDraft";
  access: "CONVERSE";
  status: "ready";
  readyDraft: ReadyHunsuDraft;
  confirmedHunsuId?: never;
  confirmedNodeId?: never;
};

export type ConfirmedHunsuDraftRoute = RouteRecordBase & {
  kind: "HunsuDraft";
  access: "CONVERSE";
  status: "confirmed";
  readyDraft: ReadyHunsuDraft;
  confirmedHunsuId: HunsuId;
  confirmedNodeId: NodeId;
};

export type DiscardedHunsuDraftRoute = RouteRecordBase & {
  kind: "HunsuDraft";
  access: "CONVERSE";
  status: "discarded";
  readyDraft?: never;
  confirmedHunsuId?: never;
  confirmedNodeId?: never;
};

export type FailedHunsuDraftRoute = RouteRecordBase & {
  kind: "HunsuDraft";
  access: "CONVERSE";
  status: "failed";
  error: FailureReason;
  readyDraft?: never;
  confirmedHunsuId?: never;
  confirmedNodeId?: never;
};

export type HunsuDraftRoute =
  | DraftHunsuDraftRoute
  | ReadyHunsuDraftRoute
  | ConfirmedHunsuDraftRoute
  | DiscardedHunsuDraftRoute
  | FailedHunsuDraftRoute;

export type RouteRecord = PlanRoute | PathRoute | HunsuDraftRoute;

export type WorktreeRefInput = Raw<WorktreeRef>;

export type ArtifactActionKind = "host" | "check";
export type ArtifactActionSourceScope = "move" | "commit" | "move-or-commit";
export type ArtifactActionScalar = string | number | boolean;

export type ArtifactActionEnvValue =
  | { default: ArtifactActionScalar }
  | { value: ArtifactActionScalar }
  | { required: true; secret?: boolean }
  | { alias: NonEmptyText }
  | { fromAliasUrl: NonEmptyText };

export type ArtifactActionServiceAlias = {
  service: NonEmptyText;
  containerPort: PositiveInteger;
  healthPath?: NonEmptyText;
  target?: never;
};

export type ArtifactActionTargetAlias = {
  target: NonEmptyText;
  service?: never;
  containerPort?: never;
  healthPath?: never;
};

export type ArtifactActionAlias = ArtifactActionServiceAlias | ArtifactActionTargetAlias;

export type ArtifactActionEvidenceSettings = {
  attach?: boolean;
  paths?: NonEmptyText[];
};

export type ArtifactActionDockerComposeRunner = {
  type: "docker_compose";
  file: NonEmptyText;
  projectName?: NonEmptyText;
};

export type ArtifactActionCommandRunner = {
  type: "command";
  command: NonEmptyText;
  stopCommand?: NonEmptyText;
};

export type ArtifactActionRunner = ArtifactActionDockerComposeRunner | ArtifactActionCommandRunner;

export type ArtifactActionDefinition = {
  id: ArtifactActionId;
  title: NonEmptyText;
  kind: ArtifactActionKind;
  sourceScope: ArtifactActionSourceScope;
  env?: Record<string, ArtifactActionEnvValue>;
  runner: ArtifactActionRunner;
  aliases?: Record<string, ArtifactActionAlias>;
  evidence?: ArtifactActionEvidenceSettings;
  displayOrder: number;
};

export type ArtifactActionDefinitionInput = Raw<ArtifactActionDefinition>;
export type ArtifactActionPatch = Partial<Omit<ArtifactActionDefinition, "id">>;

export type TeamSnapshot = {
  teamName: TeamName;
  moveOrdinal: number;
  destinations: Destination[];
  harness: HarnessSnapshot;
  harnessGraph: Harness;
  harnessLock?: HubPackageLock;
  executorPackageBindings?: ExecutorPackageBinding[];
  resourcePackageBindings?: ResourcePackageBinding[];
  artifactActions: ArtifactActionDefinition[];
};

export type MoveOutcome = "arrived" | "accident";

export type MoveRecordBase = {
  id: MoveId;
  lineId: LineId;
  fromNodeId: NodeId;
  toNodeId: NodeId;
  teamName?: TeamName;
  ordinal?: number;
  snapshot?: TeamSnapshot;
  sourceHunsuId?: HunsuId;
  executeId?: ExecuteId;
  conversationRef?: AgentConversationRef;
  worktree?: WorktreeRef;
  summary: Summary;
  commit: MoveCommit;
  evidence: EvidenceText[];
  risks?: RiskText[];
  recordedBy: "SYSTEM";
  recordedAt?: SerializedIsoTimestamp;
};

export type ArrivedMoveRecord = MoveRecordBase & {
  outcome: "arrived";
  reachedDestinationIds: SingleItemArray<DestinationId>;
  failureReason?: never;
};

export type AccidentMoveRecord = MoveRecordBase & {
  outcome: "accident";
  reachedDestinationIds: [];
  failureReason: FailureReason;
};

export type MoveRecord = ArrivedMoveRecord | AccidentMoveRecord;

export type HunsuChangedFileKind = "added" | "updated" | "removed";

export type HunsuChangedFile = {
  path: NonEmptyText;
  kind: HunsuChangedFileKind;
  summary: Summary;
};

export type HunsuChangedFileInput = Raw<HunsuChangedFile>;

export type HunsuDraftStatus = "draft" | "ready" | "confirmed" | "discarded";

export type HunsuDraftBase = {
  id: HunsuDraftId;
  sourceLineId: LineId;
  sourceNodeId: NodeId;
  sourceMoveId?: MoveId;
  target: HunsuTarget;
  newTeamName: TeamName;
  summary: Summary;
  teamSnapshot: TeamSnapshot;
  changedFiles: HunsuChangedFile[];
  createdAt?: SerializedIsoTimestamp;
  updatedAt?: SerializedIsoTimestamp;
};

export type DraftHunsuDraft = HunsuDraftBase & {
  status: "draft";
  hunsuId?: never;
  newLineId?: never;
  conversationRef?: never;
};

export type ReadyHunsuDraft = HunsuDraftBase & {
  status: "ready";
  hunsuId: HunsuId;
  newLineId: LineId;
  conversationRef: AgentConversationRef;
};

export type ConfirmedHunsuDraft = HunsuDraftBase & {
  status: "confirmed";
  hunsuId: HunsuId;
  newLineId: LineId;
  conversationRef: AgentConversationRef;
};

export type DiscardedHunsuDraft = HunsuDraftBase & {
  status: "discarded";
  hunsuId?: never;
  newLineId?: never;
  conversationRef?: AgentConversationRef;
};

export type HunsuDraftRecord = DraftHunsuDraft | ReadyHunsuDraft | ConfirmedHunsuDraft | DiscardedHunsuDraft;

export type DestinationPatch = {
  title?: DestinationTitle;
  acceptanceCriteria?: DestinationAcceptanceCriterion[];
  constraints?: DestinationConstraint[];
  priority?: number;
  notes?: DestinationNotes;
};

export type DestinationPatchInput = Raw<DestinationPatch>;

export type HunsuTarget =
  | { type: "destination"; id: DestinationId }
  | { type: "move"; id: MoveId }
  | { type: "line"; id: LineId }
  | { type: "node"; id: NodeId };

export type HunsuTargetInput = Raw<HunsuTarget>;

export type HunsuRecord = {
  id: HunsuId;
  hunsuDraftId?: HunsuDraftId;
  conversationRef?: AgentConversationRef;
  lineId: LineId;
  fromNodeId: NodeId;
  toNodeId: NodeId;
  target: HunsuTarget;
  summary: Summary;
  newLineId?: LineId;
  sourceMoveId?: MoveId;
  newTeamName?: TeamName;
  teamSnapshot: TeamSnapshot;
  changedFiles: HunsuChangedFile[];
  recordedBy: "DIRECTOR";
  recordedAt?: SerializedIsoTimestamp;
};

export type LineStatus = "active" | "paused" | "complete" | "failed" | "abandoned";

export type LineRoute = {
  moveIds: MoveId[];
  rootNodeId: NodeId;
  currentNodeId: NodeId;
  nodeIds: NonEmptyArray<NodeId>;
};

export type RootLineRecordBase = LineRoute & {
  id: LineId;
  requestId: RequestId;
  teamName?: TeamName;
  parentLineId?: never;
  forkedFromMoveId?: never;
};

export type ForkedLineRecordBase = LineRoute & {
  id: LineId;
  requestId: RequestId;
  teamName?: TeamName;
  parentLineId: LineId;
  forkedFromMoveId?: MoveId;
};

export type LineRecordBase =
  | RootLineRecordBase
  | ForkedLineRecordBase;

export type ActiveLine = LineRecordBase & { status: "active" };
export type PausedLine = LineRecordBase & { status: "paused" };
export type CompleteLine = LineRecordBase & { status: "complete" };
export type FailedLine = LineRecordBase & { status: "failed" };
export type AbandonedLine = LineRecordBase & { status: "abandoned" };
export type LineRecord = ActiveLine | PausedLine | CompleteLine | FailedLine | AbandonedLine;
export type PlayableLine = ActiveLine;

export type NodeRecord = {
  id: NodeId;
  requestId: RequestId;
  lineId?: LineId;
  teamName?: TeamName;
  ordinal: number;
  destinations: Destination[];
  harness: HarnessSnapshot;
  harnessGraph: Harness;
  harnessLock?: HubPackageLock;
  executorPackageBindings?: ExecutorPackageBinding[];
  resourcePackageBindings?: ResourcePackageBinding[];
  artifactActions: ArtifactActionDefinition[];
  source:
    | { type: "initial-execute-team"; requestId: RequestId }
    | { type: "request"; requestId: RequestId }
    | { type: "move"; moveId: MoveId; fromNodeId: NodeId }
    | { type: "hunsu"; hunsuId: HunsuId; fromNodeId: NodeId };
  createdAt?: SerializedIsoTimestamp;
};

export type BoardEdge =
  | {
      id: MoveId;
      type: "move";
      lineId: LineId;
      fromNodeId: NodeId;
      toNodeId: NodeId;
      moveId: MoveId;
    }
  | {
      id: HunsuId;
      type: "hunsu";
      lineId: LineId;
      fromNodeId: NodeId;
      toNodeId: NodeId;
      hunsuId: HunsuId;
    };

export type ArtifactOwner =
  | { type: "move"; id: MoveId }
  | { type: "hunsu"; id: HunsuId }
  | { type: "line"; id: LineId };

export type ArtifactKind = "transcript" | "command-output" | "test-log" | "screenshot" | "diff-summary" | "note";

export type ArtifactRecordBase = {
  id: ArtifactId;
  owner: ArtifactOwner;
  kind: ArtifactKind;
};

export type PathArtifact = ArtifactRecordBase & { path: string; text?: never };
export type TextArtifact = ArtifactRecordBase & { path?: never; text: string };
export type PathAndTextArtifact = ArtifactRecordBase & { path: string; text: string };
export type ArtifactRecord = PathArtifact | TextArtifact | PathAndTextArtifact;

export type ArtifactRecordInput = Raw<ArtifactRecord>;

export type ValidatedTeamCommand =
  | {
      type: "ClaimDestination";
      destinationId: DestinationId;
      actor: string;
      at?: SerializedIsoTimestamp;
    }
  | {
      type: "StartDestinationWork";
      destinationId: DestinationId;
      actor: string;
      at?: SerializedIsoTimestamp;
    }
  | {
      type: "ReportDestinationBlocked";
      destinationId: DestinationId;
      reason: FailureReason;
      actor: string;
      at?: SerializedIsoTimestamp;
    }
  | {
      type: "RecordMove";
      lineId: LineId;
      moveId: MoveId;
      summary: Summary;
      commit: MoveCommit;
      reachedDestinationIds: SingleItemArray<DestinationId>;
      evidence: EvidenceText[];
      risks?: RiskText[];
      executeId?: ExecuteId;
      conversationRef?: AgentConversationRef;
      worktree?: WorktreeRef;
      actor: string;
      at?: SerializedIsoTimestamp;
    }
  | {
      type: "RecordAccident";
      lineId: LineId;
      moveId: MoveId;
      summary: Summary;
      commit: MoveCommit;
      evidence: EvidenceText[];
      failureReason: FailureReason;
      risks?: RiskText[];
      executeId?: ExecuteId;
      conversationRef?: AgentConversationRef;
      worktree?: WorktreeRef;
      actor: string;
      at?: SerializedIsoTimestamp;
    }
  | {
      type: "AttachMoveEvidence";
      moveId: MoveId;
      artifact: ArtifactRecord;
      actor: string;
      at?: SerializedIsoTimestamp;
    };

export type ValidatedDirectorCommand =
  {
      type: "ConfirmHunsuDraft";
      draft: ReadyHunsuDraft;
      actor: string;
      at?: SerializedIsoTimestamp;
    }
  | {
      type: "CreateSkillDraft";
      draftId: SkillDraftId;
      lineId: LineId;
      name: NonEmptyText;
      draftPath: NonEmptyText;
      sourcePath?: NonEmptyText;
      actor: string;
      at?: SerializedIsoTimestamp;
    }
  | {
      type: "DiscardSkillDraft";
      draftId: SkillDraftId;
      actor: string;
      at?: SerializedIsoTimestamp;
    };

export type ValidatedSystemCommand =
  | {
      type: "RegisterHunsuOrigin";
      origin: HunsuOrigin;
      actor?: string;
      at?: SerializedIsoTimestamp;
    }
  | {
      type: "CreateInitialTeam";
      requestId: RequestId;
      lineId: LineId;
      title: RequestTitle;
      goal: RequestGoal;
      destinations: DestinationSeed[];
      harness?: HarnessSnapshot;
      harnessLock?: HubPackageLock;
      teamName?: TeamName;
      actor?: string;
      at?: SerializedIsoTimestamp;
    }
  | {
      type: "StartLine";
      lineId: LineId;
      requestId: RequestId;
      teamName?: TeamName;
      at?: SerializedIsoTimestamp;
    }
  | {
      type: "PauseLine" | "ResumeLine";
      lineId: LineId;
      at?: SerializedIsoTimestamp;
    }
  | {
      type: "AcceptLine" | "RejectLine";
      lineId: LineId;
      reason?: string;
      at?: SerializedIsoTimestamp;
    }
  | {
      type: "RecordArtifact";
      artifact: ArtifactRecord;
      at?: SerializedIsoTimestamp;
    };

export type ValidatedCommand = ValidatedTeamCommand | ValidatedDirectorCommand | ValidatedSystemCommand;
export type TeamCommand = Raw<ValidatedTeamCommand>;
export type DirectorCommand = Raw<ValidatedDirectorCommand>;
export type SystemCommand = Raw<ValidatedSystemCommand>;
export type Command = Raw<ValidatedCommand>;

export type DomainEvent =
  | {
      type: "HunsuOriginRegistered";
      origin: HunsuOrigin;
      at?: SerializedIsoTimestamp;
    }
  | {
      type: "InitialTeamCreated";
      request: RequestRecord;
      line: LineRecord;
      destinations: DestinationSeed[];
      harness?: HarnessSnapshot;
      harnessLock?: HubPackageLock;
      at?: SerializedIsoTimestamp;
    }
  | {
      type: "RequestCreated";
      request: RequestRecord;
    }
  | {
      type: "DestinationDeclared";
      requestId: RequestId;
      destination: DestinationSeed;
      at?: SerializedIsoTimestamp;
    }
  | {
      type: "HarnessSeeded";
      requestId: RequestId;
      harness: HarnessSnapshot;
      at?: SerializedIsoTimestamp;
    }
  | {
      type: "LineStarted";
      line: LineRecord;
    }
  | {
      type: "SkillDraftCreated";
      draft: SkillDraftRecord;
    }
  | {
      type: "SkillDraftAccepted";
      draftId: SkillDraftId;
      skill: SkillBinding;
      at?: SerializedIsoTimestamp;
    }
  | {
      type: "SkillDraftDiscarded";
      draftId: SkillDraftId;
      at?: SerializedIsoTimestamp;
    }
  | {
      type: "NodeCreated";
      node: NodeRecord;
    }
  | {
      type: "LinePaused" | "LineResumed";
      lineId: LineId;
      at?: SerializedIsoTimestamp;
    }
  | {
      type: "LineAccepted" | "LineRejected";
      lineId: LineId;
      reason?: string;
      at?: SerializedIsoTimestamp;
    }
  | {
      type: "DestinationClaimed" | "DestinationWorkStarted";
      destinationId: DestinationId;
      actor: string;
      at?: SerializedIsoTimestamp;
    }
  | {
      type: "DestinationBlocked";
      destinationId: DestinationId;
      reason: string;
      actor: string;
      at?: SerializedIsoTimestamp;
    }
  | {
      type: "MoveRecorded";
      move: MoveRecord;
    }
  | {
      type: "DestinationReached";
      destinationId: DestinationId;
      moveId: MoveId;
      at?: SerializedIsoTimestamp;
    }
  | {
      type: "HunsuRecorded";
      hunsu: HunsuRecord;
    }
  | {
      type: "LineForkedByHunsu";
      hunsuId: HunsuId;
      fromLineId: LineId;
      newLineId: LineId;
      newTeamName?: TeamName;
      fromMoveId?: MoveId;
      requestId: RequestId;
      at?: SerializedIsoTimestamp;
    }
  | {
      type: "ArtifactRecorded";
      artifact: ArtifactRecord;
      at?: SerializedIsoTimestamp;
    };

export type DomainEventInput = Raw<DomainEvent>;

export type FutureConstraint = {
  hunsuId: HunsuId;
  lineId: LineId;
  constraint: FutureConstraintText;
  at?: SerializedIsoTimestamp;
};

export type BoardProjection = {
  origins: HunsuOrigin[];
  requests: RequestRecord[];
  destinations: Destination[];
  nodes: NodeRecord[];
  edges: BoardEdge[];
  lines: LineRecord[];
  moves: MoveRecord[];
  hunsus: HunsuRecord[];
  skillDrafts: SkillDraftRecord[];
  artifacts: ArtifactRecord[];
  artifactActions: ArtifactActionDefinition[];
  futureConstraints: FutureConstraint[];
};
