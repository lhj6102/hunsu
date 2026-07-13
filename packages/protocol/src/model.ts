import type {
  AcceptanceCriterion,
  CheckpointId,
  CoachId,
  CoachProposalId,
  CoachReviewId,
  CommandFingerprint,
  ComparisonId,
  DecisionId,
  DesiredOutcome,
  DivergenceId,
  EventId,
  EvidenceId,
  EvidenceSummary,
  GitBranchName,
  GitCommitSha,
  GitRef,
  GoalConstraint,
  GoalId,
  GoalTitle,
  IdempotencyKey,
  IsoTimestamp,
  NonEmptyArray,
  NonEmptyText,
  NonNegativeInteger,
  PositiveInteger,
  ProjectId,
  ProjectObjective,
  ProjectTitle,
  PromptTemplate,
  Reason,
  RepositoryName,
  RepositoryOwner,
  ResourceName,
  RunId,
  RunnerId,
  WorkspaceId
} from "./primitives.ts";

export type GitHubRepositoryRef = {
  readonly owner: RepositoryOwner;
  readonly name: RepositoryName;
};

export type Project = {
  readonly id: ProjectId;
  readonly workspaceId: WorkspaceId;
  readonly repository: GitHubRepositoryRef;
  readonly baseRef: GitRef;
  readonly title: ProjectTitle;
  readonly objective: ProjectObjective;
  readonly coachId: CoachId;
  readonly goalIds: readonly GoalId[];
  readonly runnerIds: readonly RunnerId[];
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
};

export type ProjectPatch = {
  readonly title?: ProjectTitle;
  readonly objective?: ProjectObjective;
  readonly baseRef?: GitRef;
};

export type GoalBase = {
  readonly id: GoalId;
  readonly projectId: ProjectId;
  readonly title: GoalTitle;
  readonly desiredOutcome: DesiredOutcome;
  readonly acceptanceCriteria: NonEmptyArray<AcceptanceCriterion>;
  readonly constraints: readonly GoalConstraint[];
  readonly priority: NonNegativeInteger;
  readonly assignment:
    | { readonly type: "unassigned" }
    | { readonly type: "assigned"; readonly runnerId: RunnerId };
  readonly relation:
    | { readonly type: "root" }
    | { readonly type: "child"; readonly parentGoalId: GoalId }
    | { readonly type: "related"; readonly goalIds: NonEmptyArray<GoalId> };
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
};

export type ActiveGoal = GoalBase & {
  readonly status: "active";
  readonly pausedAt?: never;
  readonly pauseReason?: never;
  readonly completedAt?: never;
  readonly selectedRunId?: never;
};

export type PausedGoal = GoalBase & {
  readonly status: "paused";
  readonly pausedAt: IsoTimestamp;
  readonly pauseReason: Reason;
  readonly completedAt?: never;
  readonly selectedRunId?: never;
};

export type CompletedGoal = GoalBase & {
  readonly status: "completed";
  readonly completedAt: IsoTimestamp;
  readonly selectedRunId: RunId;
  readonly pausedAt?: never;
  readonly pauseReason?: never;
};

export type Goal = ActiveGoal | PausedGoal | CompletedGoal;
export type GoalStatus = Goal["status"];

export type GoalPatch = {
  readonly title?: GoalTitle;
  readonly desiredOutcome?: DesiredOutcome;
  readonly acceptanceCriteria?: NonEmptyArray<AcceptanceCriterion>;
  readonly constraints?: readonly GoalConstraint[];
  readonly priority?: NonNegativeInteger;
  readonly assignment?: GoalBase["assignment"];
  readonly relation?: GoalBase["relation"];
};

export type SkillResource = {
  readonly type: "skill";
  readonly name: ResourceName;
  readonly source: NonEmptyText;
};

export type PluginRequirement = {
  readonly type: "plugin";
  readonly name: ResourceName;
  readonly version: NonEmptyText;
};

export type ResourceBinding = SkillResource | PluginRequirement;

export type RuntimePolicy = {
  readonly fileAccess: "read_only" | "project_write";
  readonly network: "denied" | "allowed";
  readonly approval: "user" | "automatic";
};

export type Player = {
  readonly kind: "player";
  readonly id: RunnerId;
  readonly projectId: ProjectId;
  readonly promptTemplate: PromptTemplate;
  readonly resources: readonly ResourceBinding[];
  readonly runtimePolicy: RuntimePolicy;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
};

export type TeamPlayer = {
  readonly playerId: RunnerId;
  readonly role: NonEmptyText;
  readonly order: PositiveInteger;
};

export type TeamStrategy = {
  readonly mode: "sequence" | "parallel" | "coordinated";
  readonly promptTemplate: PromptTemplate;
  readonly maxRounds: PositiveInteger;
};

export type Team = {
  readonly kind: "team";
  readonly id: RunnerId;
  readonly projectId: ProjectId;
  readonly strategy: TeamStrategy;
  readonly players: NonEmptyArray<TeamPlayer>;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
};

export type Runner = Team | Player;

export type CoachPolicy = {
  readonly goalChanges: "propose_only";
  readonly runnerChanges: "propose_only";
  readonly hunsu: "propose_only";
  readonly selection: "user_only";
};

export type Coach = {
  readonly id: CoachId;
  readonly projectId: ProjectId;
  readonly promptTemplate: PromptTemplate;
  readonly resources: readonly ResourceBinding[];
  readonly policy: CoachPolicy;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
};

export type GoalSnapshot = {
  readonly id: GoalId;
  readonly projectId: ProjectId;
  readonly title: GoalTitle;
  readonly desiredOutcome: DesiredOutcome;
  readonly acceptanceCriteria: NonEmptyArray<AcceptanceCriterion>;
  readonly constraints: readonly GoalConstraint[];
  readonly priority: NonNegativeInteger;
  readonly assignment: GoalBase["assignment"];
  readonly relation: GoalBase["relation"];
  readonly capturedAt: IsoTimestamp;
};

export type PlayerSnapshot = Omit<Player, "createdAt" | "updatedAt"> & {
  readonly capturedAt: IsoTimestamp;
};

export type TeamPlayerSnapshot = {
  readonly slot: TeamPlayer;
  readonly player: PlayerSnapshot;
};

export type TeamSnapshot = Omit<Team, "players" | "createdAt" | "updatedAt"> & {
  readonly players: NonEmptyArray<TeamPlayerSnapshot>;
  readonly capturedAt: IsoTimestamp;
};

export type RunnerSnapshot = PlayerSnapshot | TeamSnapshot;

export type RunOrigin =
  | { readonly type: "primary" }
  | {
      readonly type: "hunsu_alternative";
      readonly divergenceId: DivergenceId;
      readonly sourceRunId: RunId;
    };

export type RunCheckpoint = {
  readonly id: CheckpointId;
  readonly runId: RunId;
  readonly summary: EvidenceSummary;
  readonly commitSha?: GitCommitSha;
  readonly recordedAt: IsoTimestamp;
};

export type GitEvidenceLocation = {
  readonly type: "git";
  readonly commitSha: GitCommitSha;
  readonly path: NonEmptyText;
};

export type UrlEvidenceLocation = {
  readonly type: "url";
  readonly url: NonEmptyText;
};

export type TextEvidenceLocation = {
  readonly type: "text";
  readonly text: NonEmptyText;
};

export type EvidenceRef = {
  readonly id: EvidenceId;
  readonly projectId: ProjectId;
  readonly runId: RunId;
  readonly criterion?: AcceptanceCriterion;
  readonly kind: "diff" | "check" | "screenshot" | "report" | "note";
  readonly summary: EvidenceSummary;
  readonly location: GitEvidenceLocation | UrlEvidenceLocation | TextEvidenceLocation;
  readonly recordedAt: IsoTimestamp;
};

export type RunBase = {
  readonly id: RunId;
  readonly projectId: ProjectId;
  readonly goalId: GoalId;
  readonly runnerId: RunnerId;
  readonly baseSha: GitCommitSha;
  readonly branch: GitBranchName;
  readonly origin: RunOrigin;
  readonly goalSnapshot: GoalSnapshot;
  readonly runnerSnapshot: RunnerSnapshot;
  readonly checkpoints: readonly RunCheckpoint[];
  readonly evidenceIds: readonly EvidenceId[];
  readonly startedAt: IsoTimestamp;
};

export type RunningRun = RunBase & {
  readonly status: "running";
  readonly resultSha?: never;
  readonly verifiedAt?: never;
  readonly completedAt?: never;
  readonly failedAt?: never;
  readonly failureReason?: never;
  readonly canceledAt?: never;
  readonly cancellationReason?: never;
};

export type CompletedRun = RunBase & {
  readonly status: "completed";
  readonly resultSha: GitCommitSha;
  readonly verifiedAt: IsoTimestamp;
  readonly completedAt: IsoTimestamp;
  readonly failedAt?: never;
  readonly failureReason?: never;
  readonly canceledAt?: never;
  readonly cancellationReason?: never;
};

export type FailedRun = RunBase & {
  readonly status: "failed";
  readonly failedAt: IsoTimestamp;
  readonly failureReason: Reason;
  readonly resultSha?: never;
  readonly verifiedAt?: never;
  readonly completedAt?: never;
  readonly canceledAt?: never;
  readonly cancellationReason?: never;
};

export type CanceledRun = RunBase & {
  readonly status: "canceled";
  readonly canceledAt: IsoTimestamp;
  readonly cancellationReason: Reason;
  readonly resultSha?: never;
  readonly verifiedAt?: never;
  readonly completedAt?: never;
  readonly failedAt?: never;
  readonly failureReason?: never;
};

export type Run = RunningRun | CompletedRun | FailedRun | CanceledRun;
export type TerminalRun = CompletedRun | FailedRun | CanceledRun;

export type VerifiedRunResult = {
  readonly runId: RunId;
  readonly branch: GitBranchName;
  readonly resultSha: GitCommitSha;
  readonly verifiedAt: IsoTimestamp;
};

export type CoachReviewTarget =
  | { readonly type: "project"; readonly projectId: ProjectId }
  | { readonly type: "goal"; readonly goalId: GoalId }
  | { readonly type: "run"; readonly runId: RunId }
  | { readonly type: "comparison"; readonly comparisonId: ComparisonId };

export type CoachReview = {
  readonly id: CoachReviewId;
  readonly projectId: ProjectId;
  readonly coachId: CoachId;
  readonly target: CoachReviewTarget;
  readonly assessment: NonEmptyText;
  readonly recommendations: readonly NonEmptyText[];
  readonly recordedAt: IsoTimestamp;
};

export type CoachProposalBase = {
  readonly id: CoachProposalId;
  readonly projectId: ProjectId;
  readonly coachId: CoachId;
  readonly reason: Reason;
  readonly proposedAt: IsoTimestamp;
};

export type GoalChangeProposal = CoachProposalBase & {
  readonly type: "goal_change";
  readonly goalId: GoalId;
  readonly change: GoalPatch;
};

export type RunnerChangeProposal = CoachProposalBase & {
  readonly type: "runner_change";
  readonly goalId: GoalId;
  readonly runnerId: RunnerId;
};

export type HunsuProposal = CoachProposalBase & {
  readonly type: "hunsu";
  readonly goalId: GoalId;
  readonly sourceRunId: RunId;
  readonly alternative:
    | { readonly type: "goal_change"; readonly change: GoalPatch }
    | { readonly type: "runner_change"; readonly runnerId: RunnerId };
};

export type CoachProposal = GoalChangeProposal | RunnerChangeProposal | HunsuProposal;

export type AcceptedCoachProposalDecision = {
  readonly status: "accepted";
  readonly id: EventId;
  readonly proposalId: CoachProposalId;
  readonly reason: Reason;
  readonly decidedAt: IsoTimestamp;
  readonly application:
    | { readonly type: "goal_change"; readonly goal: ActiveGoal | PausedGoal }
    | { readonly type: "runner_change"; readonly goal: ActiveGoal | PausedGoal }
    | {
        readonly type: "hunsu";
        readonly divergence: HunsuDivergence;
        readonly goal: ActiveGoal | PausedGoal;
      };
};

export type RejectedCoachProposalDecision = {
  readonly status: "rejected";
  readonly id: EventId;
  readonly proposalId: CoachProposalId;
  readonly reason: Reason;
  readonly decidedAt: IsoTimestamp;
};

export type CoachProposalDecision = AcceptedCoachProposalDecision | RejectedCoachProposalDecision;

export type HunsuBasis =
  | { readonly type: "user"; readonly reason: Reason }
  | { readonly type: "coach_proposal"; readonly proposalId: CoachProposalId };

export type HunsuDivergence = {
  readonly id: DivergenceId;
  readonly projectId: ProjectId;
  readonly goalId: GoalId;
  readonly sourceRunId: RunId;
  readonly baseSha: GitCommitSha;
  readonly basis: HunsuBasis;
  readonly alternativeRunIds: readonly RunId[];
  readonly confirmedAt: IsoTimestamp;
};

export type ComparisonFinding = {
  readonly criterion: AcceptanceCriterion;
  readonly summaries: NonEmptyArray<{
    readonly runId: RunId;
    readonly summary: EvidenceSummary;
  }>;
};

export type AtLeastTwo<T> = readonly [T, T, ...T[]];

export type AlternativeComparison = {
  readonly id: ComparisonId;
  readonly projectId: ProjectId;
  readonly goalId: GoalId;
  readonly divergenceId: DivergenceId;
  readonly baseSha: GitCommitSha;
  readonly runIds: AtLeastTwo<RunId>;
  readonly findings: readonly ComparisonFinding[];
  readonly summary: EvidenceSummary;
  readonly recordedAt: IsoTimestamp;
};

export type SelectionDecision = {
  readonly type: "selection";
  readonly id: DecisionId;
  readonly comparisonId: ComparisonId;
  readonly selectedRunId: RunId;
  readonly rejectedRunIds: readonly RunId[];
  readonly rationale: Reason;
  readonly decidedAt: IsoTimestamp;
};

export type RejectionDecision = {
  readonly type: "rejection";
  readonly id: DecisionId;
  readonly comparisonId: ComparisonId;
  readonly rejectedRunIds: NonEmptyArray<RunId>;
  readonly rationale: Reason;
  readonly decidedAt: IsoTimestamp;
};

export type AlternativeDecision = SelectionDecision | RejectionDecision;

export type UserActor = {
  readonly type: "user";
  readonly id: NonEmptyText;
};

export type CoachActor = {
  readonly type: "coach";
  readonly coachId: CoachId;
};

export type PluginActor = {
  readonly type: "plugin";
  readonly id: NonEmptyText;
};

export type SystemActor = {
  readonly type: "system";
};

export type DomainActor = UserActor | CoachActor | PluginActor | SystemActor;

export type CommandMetadata = {
  readonly eventId: EventId;
  readonly idempotencyKey: IdempotencyKey;
  readonly fingerprint: CommandFingerprint;
  readonly actor: DomainActor;
  readonly requestedAt: IsoTimestamp;
};

export type EventMetadata = {
  readonly eventId: EventId;
  readonly idempotencyKey: IdempotencyKey;
  readonly fingerprint: CommandFingerprint;
  readonly actor: DomainActor;
  readonly recordedAt: IsoTimestamp;
};

export type ProjectCommand =
  | { readonly type: "CreateProject"; readonly meta: CommandMetadata; readonly project: Project; readonly coach: Coach }
  | { readonly type: "UpdateProject"; readonly meta: CommandMetadata; readonly projectId: ProjectId; readonly patch: ProjectPatch }
  | { readonly type: "CreateGoal"; readonly meta: CommandMetadata; readonly goal: ActiveGoal }
  | { readonly type: "UpdateGoal"; readonly meta: CommandMetadata; readonly goalId: GoalId; readonly patch: GoalPatch }
  | { readonly type: "PauseGoal"; readonly meta: CommandMetadata; readonly goalId: GoalId; readonly reason: Reason }
  | { readonly type: "ResumeGoal"; readonly meta: CommandMetadata; readonly goalId: GoalId }
  | { readonly type: "CompleteGoal"; readonly meta: CommandMetadata; readonly goalId: GoalId; readonly selectedRunId: RunId }
  | { readonly type: "CreatePlayer"; readonly meta: CommandMetadata; readonly player: Player }
  | { readonly type: "UpdatePlayer"; readonly meta: CommandMetadata; readonly player: Player }
  | { readonly type: "CreateTeam"; readonly meta: CommandMetadata; readonly team: Team }
  | { readonly type: "UpdateTeam"; readonly meta: CommandMetadata; readonly team: Team }
  | { readonly type: "UpdateCoach"; readonly meta: CommandMetadata; readonly coach: Coach }
  | {
      readonly type: "StartRun";
      readonly meta: CommandMetadata;
      readonly runId: RunId;
      readonly projectId: ProjectId;
      readonly goalId: GoalId;
      readonly runnerId: RunnerId;
      readonly baseSha: GitCommitSha;
      readonly branch: GitBranchName;
      readonly origin: RunOrigin;
    }
  | { readonly type: "CheckpointRun"; readonly meta: CommandMetadata; readonly checkpoint: RunCheckpoint }
  | { readonly type: "AttachRunEvidence"; readonly meta: CommandMetadata; readonly evidence: EvidenceRef }
  | { readonly type: "CompleteRun"; readonly meta: CommandMetadata; readonly result: VerifiedRunResult }
  | { readonly type: "FailRun"; readonly meta: CommandMetadata; readonly runId: RunId; readonly reason: Reason }
  | { readonly type: "CancelRun"; readonly meta: CommandMetadata; readonly runId: RunId; readonly reason: Reason }
  | { readonly type: "RecordCoachReview"; readonly meta: CommandMetadata; readonly review: CoachReview }
  | { readonly type: "RecordCoachProposal"; readonly meta: CommandMetadata; readonly proposal: CoachProposal }
  | {
      readonly type: "AcceptCoachProposal";
      readonly meta: CommandMetadata;
      readonly proposalId: CoachProposalId;
      readonly reason: Reason;
      readonly application:
        | { readonly type: "apply_change" }
        | { readonly type: "hunsu"; readonly divergenceId: DivergenceId };
    }
  | {
      readonly type: "RejectCoachProposal";
      readonly meta: CommandMetadata;
      readonly proposalId: CoachProposalId;
      readonly reason: Reason;
    }
  | {
      readonly type: "ConfirmHunsu";
      readonly meta: CommandMetadata;
      readonly divergenceId: DivergenceId;
      readonly projectId: ProjectId;
      readonly goalId: GoalId;
      readonly sourceRunId: RunId;
      readonly basis: HunsuBasis;
    }
  | {
      readonly type: "CompareAlternatives";
      readonly meta: CommandMetadata;
      readonly comparisonId: ComparisonId;
      readonly divergenceId: DivergenceId;
      readonly runIds: AtLeastTwo<RunId>;
      readonly findings: readonly ComparisonFinding[];
      readonly summary: EvidenceSummary;
    }
  | {
      readonly type: "SelectAlternative";
      readonly meta: CommandMetadata;
      readonly decisionId: DecisionId;
      readonly comparisonId: ComparisonId;
      readonly selectedRunId: RunId;
      readonly rationale: Reason;
    }
  | {
      readonly type: "RejectAlternatives";
      readonly meta: CommandMetadata;
      readonly decisionId: DecisionId;
      readonly comparisonId: ComparisonId;
      readonly rejectedRunIds: NonEmptyArray<RunId>;
      readonly rationale: Reason;
    };

export type DomainEvent =
  | { readonly type: "ProjectCreated"; readonly meta: EventMetadata; readonly project: Project; readonly coach: Coach }
  | { readonly type: "ProjectUpdated"; readonly meta: EventMetadata; readonly projectId: ProjectId; readonly patch: ProjectPatch }
  | { readonly type: "GoalCreated"; readonly meta: EventMetadata; readonly goal: ActiveGoal }
  | { readonly type: "GoalUpdated"; readonly meta: EventMetadata; readonly goalId: GoalId; readonly patch: GoalPatch }
  | { readonly type: "GoalPaused"; readonly meta: EventMetadata; readonly goalId: GoalId; readonly reason: Reason }
  | { readonly type: "GoalResumed"; readonly meta: EventMetadata; readonly goalId: GoalId }
  | { readonly type: "GoalCompleted"; readonly meta: EventMetadata; readonly goalId: GoalId; readonly selectedRunId: RunId }
  | { readonly type: "PlayerCreated"; readonly meta: EventMetadata; readonly player: Player }
  | { readonly type: "PlayerUpdated"; readonly meta: EventMetadata; readonly player: Player }
  | { readonly type: "TeamCreated"; readonly meta: EventMetadata; readonly team: Team }
  | { readonly type: "TeamUpdated"; readonly meta: EventMetadata; readonly team: Team }
  | { readonly type: "CoachUpdated"; readonly meta: EventMetadata; readonly coach: Coach }
  | { readonly type: "RunStarted"; readonly meta: EventMetadata; readonly run: RunningRun }
  | { readonly type: "RunCheckpointed"; readonly meta: EventMetadata; readonly checkpoint: RunCheckpoint }
  | { readonly type: "RunEvidenceAttached"; readonly meta: EventMetadata; readonly evidence: EvidenceRef }
  | { readonly type: "RunCompleted"; readonly meta: EventMetadata; readonly result: VerifiedRunResult }
  | { readonly type: "RunFailed"; readonly meta: EventMetadata; readonly runId: RunId; readonly reason: Reason }
  | { readonly type: "RunCanceled"; readonly meta: EventMetadata; readonly runId: RunId; readonly reason: Reason }
  | { readonly type: "CoachReviewRecorded"; readonly meta: EventMetadata; readonly review: CoachReview }
  | { readonly type: "CoachProposalRecorded"; readonly meta: EventMetadata; readonly proposal: CoachProposal }
  | { readonly type: "CoachProposalAccepted"; readonly meta: EventMetadata; readonly decision: AcceptedCoachProposalDecision }
  | { readonly type: "CoachProposalRejected"; readonly meta: EventMetadata; readonly decision: RejectedCoachProposalDecision }
  | { readonly type: "HunsuConfirmed"; readonly meta: EventMetadata; readonly divergence: HunsuDivergence }
  | { readonly type: "AlternativesCompared"; readonly meta: EventMetadata; readonly comparison: AlternativeComparison }
  | { readonly type: "AlternativeSelected"; readonly meta: EventMetadata; readonly decision: SelectionDecision }
  | { readonly type: "AlternativesRejected"; readonly meta: EventMetadata; readonly decision: RejectionDecision };

export type ProcessedCommand = {
  readonly idempotencyKey: IdempotencyKey;
  readonly fingerprint: CommandFingerprint;
  readonly eventId: EventId;
};

export type ProjectState = {
  readonly projects: readonly Project[];
  readonly goals: readonly Goal[];
  readonly runners: readonly Runner[];
  readonly coaches: readonly Coach[];
  readonly runs: readonly Run[];
  readonly evidence: readonly EvidenceRef[];
  readonly coachReviews: readonly CoachReview[];
  readonly coachProposals: readonly CoachProposal[];
  readonly coachProposalDecisions: readonly CoachProposalDecision[];
  readonly divergences: readonly HunsuDivergence[];
  readonly comparisons: readonly AlternativeComparison[];
  readonly decisions: readonly AlternativeDecision[];
  readonly processedCommands: readonly ProcessedCommand[];
};

export function runBranchName(projectId: ProjectId, goalId: GoalId, runId: RunId): GitBranchName {
  return ("hunsu/run/" + projectId + "/" + goalId + "/" + runId) as GitBranchName;
}
