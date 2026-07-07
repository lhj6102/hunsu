import type {
  AgentConversationHash,
  AgentConversationRef,
  ArtifactActionDefinition,
  ArtifactRecord,
  Destination,
  DestinationId,
  DestinationTitle,
  TeamSnapshot,
  TeamName,
  EvidenceText,
  Command,
  Executor,
  ExecutorId,
  FutureConstraint,
  FutureConstraintText,
  GuardrailConfig,
  HubPackageLock,
  Harness,
  HunsuDraftId,
  HunsuDraftRecord,
  HunsuId,
  HunsuOrigin,
  LineId,
  LineRecord,
  MoveCommit,
  MoveId,
  MoveRecord,
  NodeId,
  NonEmptyText,
  Member,
  MemberConfig,
  ReadyHunsuDraft,
  RequestId,
  ResourceBinding,
  ResourceId,
  RouteId,
  RouteRecord,
  RuntimePolicy,
  SkillBinding,
  SkillDraftId,
  SkillDraftRecord,
  Summary,
  Team,
  ValidatedCommand,
  WorktreeRef
} from "../packages/protocol/src/index.ts";

const requestId = "req_001" as RequestId;
const destinationId = "destination_001" as DestinationId;
const replacementDestinationId = "destination_002" as DestinationId;
const moveId = "M0001" as MoveId;
const hunsuDraftId = "hd001" as HunsuDraftId;
const hunsuId = "h001" as HunsuId;
const routeId = "route_001" as RouteId;
const lineId = "run/studio-mvp" as LineId;
const fromNodeId = "req_001:root" as NodeId;
const toNodeId = "N0001" as NodeId;
const skillDraftId = "draft_001" as SkillDraftId;
const conversationHash = "conv_001" as AgentConversationHash;
const teamName = "Ruler" as TeamName;
const destinationTitle = "Define protocol command/event unions" as DestinationTitle;
const moveSummary = "Protocol model recorded" as Summary;
const accidentSummary = "Could not complete protocol model" as Summary;
const moveCommit = "abc123" as MoveCommit;
const protocolEvidence = "protocol.test.ts" as EvidenceText;
const testCommandEvidence = "node --test tests/protocol.test.ts" as EvidenceText;
const actionTitle = "Run typecheck" as NonEmptyText;
const actionCommand = "pnpm run typecheck" as NonEmptyText;
const originName = "motorhome" as NonEmptyText;
const originUrl = "https://hub.example.test" as NonEmptyText;
const lockKey = "codex.execution-plan.webapp" as NonEmptyText;
const lockVersion = "1.0.0" as NonEmptyText;
const lockIntegrity = "hunsu-json-c14n-v1+sha256:abc123" as NonEmptyText;
const worktreePath = "/tmp/hunsu-routes/route_001" as NonEmptyText;
const worktreeBranch = "hunsu/routes/route_001" as NonEmptyText;
const worktreeBaseRef = "abc123" as NonEmptyText;
const conversationContextHash = "ctx_001" as NonEmptyText;
const conversationThreadId = "thread_001" as NonEmptyText;
const skillDraftName = "openai-docs" as NonEmptyText;
const skillDraftPath = ".hunsu/drafts/skills/draft_001" as NonEmptyText;
const skillSourcePath = "origin:test/openai-docs" as NonEmptyText;
const skillContentHash = "hash-openai-docs" as NonEmptyText;
const skillSnapshotRef = "codex-skill:hash-openai-docs" as NonEmptyText;
const rootExecutorId = "root_team" as ExecutorId;
const buildExecutorId = "build_member" as ExecutorId;
const resourceId = "resource_skill_docs" as ResourceId;
const memberModel = "codex-default" as NonEmptyText;
const guardrailName = "No secrets" as NonEmptyText;
const guardrailRule = "Do not reveal credentials." as NonEmptyText;
const futureConstraintText = "Keep the GUI local-first." as FutureConstraintText;
const worktree: WorktreeRef = {
  worktreeHash: "worktree_001" as WorktreeRef["worktreeHash"],
  path: worktreePath,
  branch: worktreeBranch,
  baseRef: worktreeBaseRef,
  createdAt: "2026-05-12T00:00:00.000Z"
};

// @ts-expect-error plain strings must not satisfy branded DestinationId.
const unsafeDestinationId: DestinationId = "destination_001";

// @ts-expect-error plain strings must not satisfy TeamName.
const unsafeTeamName: TeamName = "Ruler";

const worktreeWithPlainPath: WorktreeRef = {
  worktreeHash: "worktree_002" as WorktreeRef["worktreeHash"],
  // @ts-expect-error Worktree paths require decoded non-empty text.
  path: "/tmp/hunsu-routes/route_002",
  branch: worktreeBranch,
  baseRef: worktreeBaseRef,
  createdAt: "2026-05-12T00:00:00.000Z"
};

const destinationBase = {
  id: destinationId,
  requestId,
  title: destinationTitle,
  source: "initial-execute-team",
  createdBy: "SYSTEM",
  updatedBy: "SYSTEM"
} as const;

// @ts-expect-error a reached Destination must carry the MOVE that reached it.
const reachedWithoutMoveId: Destination = {
  ...destinationBase,
  status: "reached"
};

const reachedWithMoveId: Destination = {
  ...destinationBase,
  status: "reached",
  reachedByMoveId: moveId
};

// @ts-expect-error blocked Destinations must carry a block reason.
const blockedWithoutReason: Destination = {
  ...destinationBase,
  status: "blocked"
};

const blockedWithReason: Destination = {
  ...destinationBase,
  status: "blocked",
  blockedReason: "Needs product decision"
};

const supersededWithReplacement: Destination = {
  ...destinationBase,
  status: "superseded",
  supersededByDestinationId: replacementDestinationId
};

const pendingDestination: Destination = {
  ...destinationBase,
  status: "pending"
};

const teamSnapshot: TeamSnapshot = {
  teamName,
  moveOrdinal: 1,
  destinations: [pendingDestination],
  harness: {
    kind: "team_execution_plan",
    maxAttemptCount: 1,
    team: { promptTemplate: "Execute toward the request." },
    members: []
  } as unknown as TeamSnapshot["harness"],
  harnessGraph: {
    rootTeamId: "root-team" as ExecutorId,
    executors: [{
      kind: "team",
      id: "root-team" as ExecutorId,
      planner: { promptTemplate: "Execute toward the request." },
      members: []
    }],
    resources: [],
    guardrails: [],
    artifactActions: []
  } as unknown as Harness,
  artifactActions: []
};

// @ts-expect-error active Lines must carry a current node route.
const activeLineWithoutRoute: LineRecord = {
  id: lineId,
  requestId,
  status: "active",
  moveIds: []
};

const activeLineWithRoute: LineRecord = {
  id: lineId,
  requestId,
  status: "active",
  moveIds: [],
  rootNodeId: fromNodeId,
  currentNodeId: fromNodeId,
  nodeIds: [fromNodeId]
};

// @ts-expect-error fork metadata is invalid without parentLineId.
const lineWithForkMoveButNoParent: LineRecord = {
  id: lineId,
  requestId,
  status: "active",
  moveIds: [moveId],
  rootNodeId: fromNodeId,
  currentNodeId: toNodeId,
  nodeIds: [fromNodeId, toNodeId],
  forkedFromMoveId: moveId
};

const forkedLineWithParent: LineRecord = {
  id: lineId,
  requestId,
  status: "active",
  moveIds: [moveId],
  rootNodeId: fromNodeId,
  currentNodeId: toNodeId,
  nodeIds: [fromNodeId, toNodeId],
  parentLineId: lineId,
  forkedFromMoveId: moveId
};

// @ts-expect-error Artifacts must carry path, text, or both.
const artifactWithoutPayload: ArtifactRecord = {
  id: "artifact_001" as ArtifactRecord["id"],
  owner: { type: "move", id: moveId },
  kind: "note"
};

const textArtifact: ArtifactRecord = {
  id: "artifact_002" as ArtifactRecord["id"],
  owner: { type: "move", id: moveId },
  kind: "note",
  text: "Reviewed the command output."
};

const pathAndTextArtifact: ArtifactRecord = {
  id: "artifact_003" as ArtifactRecord["id"],
  owner: { type: "line", id: lineId },
  kind: "diff-summary",
  path: "artifacts/diff.md",
  text: "Summarized the diff."
};

const commandArtifactAction: ArtifactActionDefinition = {
  id: "action_001" as ArtifactActionDefinition["id"],
  title: actionTitle,
  kind: "check",
  sourceScope: "move",
  runner: { type: "command", command: actionCommand },
  displayOrder: 1
};

const artifactActionWithPlainCommand: ArtifactActionDefinition = {
  id: "action_002" as ArtifactActionDefinition["id"],
  title: actionTitle,
  kind: "check",
  sourceScope: "move",
  runner: {
    type: "command",
    // @ts-expect-error Artifact Action command runners require validated non-empty text.
    command: "pnpm run typecheck"
  },
  displayOrder: 2
};

const hunsuOrigin: HunsuOrigin = {
  name: originName,
  url: originUrl,
  transport: "http"
};

const hunsuOriginWithPlainName: HunsuOrigin = {
  // @ts-expect-error Hunsu Origins require decoded non-empty names.
  name: "motorhome",
  url: originUrl,
  transport: "http"
};

const hubPackageLock: HubPackageLock = {
  origin: originName,
  kind: "team",
  key: lockKey,
  version: lockVersion,
  integrity: lockIntegrity
};

const hubPackageLockWithPlainKey: HubPackageLock = {
  origin: originName,
  kind: "team",
  // @ts-expect-error Hub package locks require decoded non-empty keys.
  key: "codex.execution-plan.webapp",
  version: lockVersion,
  integrity: lockIntegrity
};

const memberConfig: MemberConfig = {
  id: originName,
  promptTemplate: { engine: "hunsu-template-v1", template: "Act on {{ goal }}." } as MemberConfig["promptTemplate"],
  skills: [],
  plugins: [],
  model: memberModel,
  reasoningEffort: "default",
  serviceTier: "default",
  execution: { kind: "read_only", network: "disabled" },
  approval: { policy: "never" }
};

const memberConfigWithPlainModel: MemberConfig = {
  ...memberConfig,
  // @ts-expect-error Member models require decoded non-empty text.
  model: "codex-default"
};

const guardrailConfig: GuardrailConfig = {
  name: guardrailName,
  scope: "output",
  rule: guardrailRule,
  severity: "block"
};

const guardrailConfigWithPlainRule: GuardrailConfig = {
  name: guardrailName,
  scope: "output",
  // @ts-expect-error Guardrail rules require decoded non-empty text.
  rule: "Do not reveal credentials.",
  severity: "block"
};

const futureConstraint: FutureConstraint = {
  hunsuId,
  lineId,
  constraint: futureConstraintText
};

const futureConstraintWithPlainConstraint: FutureConstraint = {
  hunsuId,
  lineId,
  // @ts-expect-error Future constraints require decoded non-empty text.
  constraint: "Keep the GUI local-first."
};

const conversationRef: AgentConversationRef = {
  provider: "local",
  conversationHash,
  contextHash: conversationContextHash,
  startedAt: "2026-05-12T00:00:00.000Z"
};

const endedCodexConversationRef: AgentConversationRef = {
  provider: "codex",
  conversationHash,
  threadId: conversationThreadId,
  contextHash: conversationContextHash,
  startedAt: "2026-05-12T00:00:00.000Z",
  endedAt: "2026-05-12T01:00:00.000Z"
};

const conversationWithPlainContext: AgentConversationRef = {
  provider: "local",
  conversationHash,
  // @ts-expect-error Agent conversation context hashes require decoded non-empty text.
  contextHash: "ctx_001",
  startedAt: "2026-05-12T00:00:00.000Z"
};

// @ts-expect-error local conversations must not carry codex thread ids.
const localConversationWithThread: AgentConversationRef = {
  provider: "local",
  conversationHash,
  threadId: conversationThreadId,
  contextHash: conversationContextHash,
  startedAt: "2026-05-12T00:00:00.000Z"
};

const draftHunsuDraft: HunsuDraftRecord = {
  id: hunsuDraftId,
  sourceLineId: lineId,
  sourceNodeId: fromNodeId,
  target: { type: "node", id: fromNodeId },
  newTeamName: teamName,
  summary: moveSummary,
  teamSnapshot,
  changedFiles: [{
    path: ".hunsu-request/destinations.json" as HunsuDraftRecord["changedFiles"][number]["path"],
    kind: "updated",
    summary: "Destinations 1 added." as Summary
  }],
  status: "draft"
};

// @ts-expect-error draft HUNSU Drafts must not reserve a durable HUNSU id.
const draftHunsuDraftWithHunsuId: HunsuDraftRecord = {
  ...draftHunsuDraft,
  hunsuId
};

const readyHunsuDraft: HunsuDraftRecord = {
  ...draftHunsuDraft,
  status: "ready",
  hunsuId,
  newLineId: lineId,
  conversationRef
};

const routeReadyHunsuDraft: ReadyHunsuDraft = {
  ...draftHunsuDraft,
  status: "ready",
  hunsuId,
  newLineId: lineId,
  conversationRef
};

const planRoute: RouteRecord = {
  kind: "Plan",
  access: "READ",
  routeId,
  sourceLineId: lineId,
  sourceNodeId: fromNodeId,
  worktree,
  currentExecutionPath: ".hunsu/current-execution.hunsu"
};

const planRouteWithChat: RouteRecord = {
  ...planRoute,
  // @ts-expect-error Plan Routes are read-only and must not expose interactive chat state.
  chat: true
};

// @ts-expect-error active Routes must carry the worktree they execute against.
const routeWithoutWorktree: RouteRecord = {
  kind: "Plan",
  access: "READ",
  routeId,
  sourceLineId: lineId,
  sourceNodeId: fromNodeId,
  currentExecutionPath: ".hunsu/current-execution.hunsu"
};

// @ts-expect-error ready HunsuDraft Routes must carry the checked ready draft.
const readyDraftRouteWithoutReadyDraft: RouteRecord = {
  kind: "HunsuDraft",
  access: "CONVERSE",
  status: "ready",
  routeId,
  sourceLineId: lineId,
  sourceNodeId: fromNodeId,
  worktree
};

const readyDraftRoute: RouteRecord = {
  kind: "HunsuDraft",
  access: "CONVERSE",
  status: "ready",
  routeId,
  sourceLineId: lineId,
  sourceNodeId: fromNodeId,
  worktree,
  readyDraft: routeReadyHunsuDraft
};

// @ts-expect-error confirmed HunsuDraft Routes must point to the confirmed Hunsu and target node.
const confirmedDraftRouteWithoutResult: RouteRecord = {
  kind: "HunsuDraft",
  access: "CONVERSE",
  status: "confirmed",
  routeId,
  sourceLineId: lineId,
  sourceNodeId: fromNodeId,
  worktree,
  readyDraft: routeReadyHunsuDraft
};

// @ts-expect-error ready HUNSU Drafts must carry the conversation they came from.
const readyHunsuDraftWithoutConversation: HunsuDraftRecord = {
  ...draftHunsuDraft,
  status: "ready",
  hunsuId,
  newLineId: lineId
};

// @ts-expect-error discarded HUNSU Drafts must not retain a reserved fork line.
const discardedHunsuDraftWithLineAllocation: HunsuDraftRecord = {
  ...draftHunsuDraft,
  status: "discarded",
  newLineId: lineId
};

const rawCommand: Command = {
  type: "PauseLine",
  lineId: "run/studio-mvp"
};

const unsafeValidatedCommand: ValidatedCommand = {
  type: "PauseLine",
  // @ts-expect-error validated Commands require branded IDs after validation.
  lineId: "run/studio-mvp"
};

// @ts-expect-error accepted Skill Drafts must carry the accepted Skill Snapshot.
const acceptedDraftWithoutSnapshot: SkillDraftRecord = {
  id: skillDraftId,
  name: skillDraftName,
  draftPath: skillDraftPath,
  status: "accepted"
};

const draftWithPlainName: SkillDraftRecord = {
  id: skillDraftId,
  // @ts-expect-error Skill Draft names require decoded non-empty text.
  name: "openai-docs",
  draftPath: skillDraftPath,
  status: "draft"
};

const localSnapshotSkill: SkillBinding = {
  kind: "local-snapshot",
  name: skillDraftName,
  sourcePath: skillSourcePath,
  contentHash: skillContentHash,
  snapshotRef: skillSnapshotRef,
  snapshotFiles: [{ path: skillDraftPath, text: "# OpenAI Docs\n" }]
};

const localSnapshotSkillWithPlainPath: SkillBinding = {
  kind: "local-snapshot",
  name: skillDraftName,
  sourcePath: skillSourcePath,
  contentHash: skillContentHash,
  snapshotRef: skillSnapshotRef,
  snapshotFiles: [
    // @ts-expect-error Skill snapshot paths require decoded non-empty text.
    { path: "SKILL.md", text: "# OpenAI Docs\n" }
  ]
};

const skillMetaSkill: SkillBinding = {
  kind: "skillMeta",
  name: skillDraftName,
  source: skillSourcePath,
  agent: "codex"
};

const memberResourceBinding: ResourceBinding = {
  kind: "skill",
  skill: skillMetaSkill
};

const memberRuntimePolicy: RuntimePolicy = {
  model: memberModel,
  reasoningEffort: "default",
  serviceTier: "default",
  execution: { kind: "read_only", network: "disabled" },
  approval: { policy: "never" }
};

const executorMember: Member = {
  kind: "member",
  id: buildExecutorId,
  promptTemplate: memberConfig.promptTemplate,
  resources: [memberResourceBinding],
  runtimePolicy: memberRuntimePolicy
};

const executorTeam: Team = {
  kind: "team",
  id: rootExecutorId,
  planner: {
    promptTemplate: memberConfig.promptTemplate,
    guardrails: [guardrailConfig]
  },
  members: [{
    executorId: buildExecutorId,
    visibleProfile: {
      kind: "member",
      label: actionTitle,
      summary: guardrailRule,
      capabilities: [skillDraftName]
    }
  }]
};

const executorUnion: Executor = executorMember;

const harnessEntityGraph: Harness = {
  rootTeamId: rootExecutorId,
  executors: [executorTeam, executorMember],
  resources: [{
    id: resourceId,
    binding: memberResourceBinding
  }],
  guardrails: [guardrailConfig],
  artifactActions: [commandArtifactAction]
};

const teamWithNestedVisibleMembers: Team = {
  ...executorTeam,
  members: [{
    executorId: rootExecutorId,
    visibleProfile: {
      kind: "team",
      label: actionTitle,
      // @ts-expect-error parent Team visibility profiles must not expose grandchildren.
      members: []
    }
  }]
};

const memberWithLegacySkillResources: Member = {
  ...executorMember,
  resources: [
    // @ts-expect-error Member entities bind resources through ResourceBinding objects.
    skillMetaSkill
  ]
};

const skillMetaSkillWithPlainSource: SkillBinding = {
  kind: "skillMeta",
  name: skillDraftName,
  // @ts-expect-error skillMeta sources require decoded non-empty text.
  source: "vercel-labs/agent-skills",
  agent: "codex"
};

// @ts-expect-error accident MOVEs must carry a failure reason.
const accidentWithoutFailureReason: MoveRecord = {
  id: moveId,
  lineId,
  fromNodeId,
  toNodeId,
  outcome: "accident",
  summary: accidentSummary,
  commit: moveCommit,
  reachedDestinationIds: [],
  evidence: [testCommandEvidence],
  recordedBy: "SYSTEM"
};

// @ts-expect-error arrived MOVEs must reach exactly one Destination.
const arrivedWithoutDestinations: MoveRecord = {
  id: moveId,
  lineId,
  fromNodeId,
  toNodeId,
  outcome: "arrived",
  summary: moveSummary,
  commit: moveCommit,
  reachedDestinationIds: [],
  evidence: [protocolEvidence],
  recordedBy: "SYSTEM"
};

void reachedWithMoveId;
void blockedWithReason;
void supersededWithReplacement;
void activeLineWithRoute;
void forkedLineWithParent;
void textArtifact;
void pathAndTextArtifact;
void commandArtifactAction;
void hunsuOrigin;
void hubPackageLock;
void memberConfig;
void guardrailConfig;
void futureConstraint;
void draftHunsuDraft;
void readyHunsuDraft;
void rawCommand;
void localSnapshotSkill;
void memberResourceBinding;
void memberRuntimePolicy;
void executorUnion;
void harnessEntityGraph;
void teamWithNestedVisibleMembers;
void memberWithLegacySkillResources;
