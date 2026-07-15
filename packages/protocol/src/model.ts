import type {
  AcceptanceCriterion,
  AtLeastTwo,
  Base64Payload,
  CheckpointId,
  CoachReviewId,
  CoachingProposalId,
  CommandFingerprint,
  ComparisonId,
  DecisionId,
  DesiredOutcome,
  EventId,
  EvidenceId,
  EvidenceSummary,
  GitBranchName,
  GitCommitSha,
  GitRef,
  GitTreePath,
  GitTreeSha,
  GoalConstraint,
  GoalDigest,
  GoalKey,
  GoalTitle,
  IdempotencyKey,
  IsoTimestamp,
  NodePayloadDigest,
  NodePlanDigest,
  NonEmptyArray,
  NonEmptyText,
  NonNegativeInteger,
  ProjectId,
  ProjectTitle,
  Reason,
  RepositoryName,
  RepositoryOwner,
  RunId,
  RunnerDigest,
  RunnerSchemaVersion,
  RunnerTypeIntegrity,
  RunnerTypeKey,
  RunnerTypeOrigin,
  WorkspaceId
} from "./primitives.ts";
import type { Result } from "./result.ts";

export const RUNNER_VALUE_SCHEMA = "hunsu.runner-value.v1" as const;
export const NODE_PLAN_SCHEMA = "hunsu.node-plan.v1" as const;
export const NODE_PAYLOAD_SCHEMA = "hunsu.node-payload.v1" as const;
export const NODE_PAYLOAD_ENVELOPE_SCHEMA = "hunsu.node-payload-envelope.v1" as const;
export const NODE_PAYLOAD_CODEC = "canonical-json+deterministic-gzip+base64" as const;
export const MAX_NODE_PAYLOAD_DECODED_BYTES = 1_048_576;
export const MAX_NODE_PAYLOAD_ENCODED_BYTES = 1_572_864;

export type CanonicalJsonValue =
  | null
  | boolean
  | string
  | number
  | readonly CanonicalJsonValue[]
  | { readonly [key: string]: CanonicalJsonValue };

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
  readonly rootNodeSha: GitCommitSha;
  readonly createdAt: IsoTimestamp;
};

export type GoalValue = {
  readonly key: GoalKey;
  readonly title: GoalTitle;
  readonly desiredOutcome: DesiredOutcome;
  readonly acceptanceCriteria: NonEmptyArray<AcceptanceCriterion>;
  readonly constraints: readonly GoalConstraint[];
  readonly priority: NonNegativeInteger;
};

export type RunnerTypeLock = {
  readonly origin: RunnerTypeOrigin;
  readonly key: RunnerTypeKey;
  readonly schemaVersion: RunnerSchemaVersion;
  readonly integrity: RunnerTypeIntegrity;
};

export type RunnerValue = {
  readonly schema: typeof RUNNER_VALUE_SCHEMA;
  readonly type: RunnerTypeLock;
  readonly name: NonEmptyText;
  readonly value: CanonicalJsonValue;
};

export type RunnerValueDecodeError = {
  readonly type: "RunnerValueDecodeError";
  readonly path: string;
  readonly message: string;
};

export type RunnerValueTypeDecoder = {
  readonly type: RunnerTypeLock;
  readonly decode: (
    value: CanonicalJsonValue,
    path: string
  ) => Result<CanonicalJsonValue, RunnerValueDecodeError>;
};

export type RunnerValueTypeRegistry = readonly RunnerValueTypeDecoder[];

export type NodePlan = {
  readonly schema: typeof NODE_PLAN_SCHEMA;
  readonly nextGoals: readonly GoalValue[];
  readonly how: RunnerValue;
};

export type NodePayload = {
  readonly schema: typeof NODE_PAYLOAD_SCHEMA;
  readonly projectId: ProjectId;
  readonly commitSha: GitCommitSha;
  readonly treeSha: GitTreeSha;
  readonly plan: NodePlan;
};

export type NodePayloadEnvelope = {
  readonly schema: typeof NODE_PAYLOAD_ENVELOPE_SCHEMA;
  readonly codec: typeof NODE_PAYLOAD_CODEC;
  readonly decodedSize: NonNegativeInteger;
  readonly encodedSize: NonNegativeInteger;
  readonly digest: NodePayloadDigest;
  readonly data: Base64Payload;
};

type NodeBase = {
  readonly projectId: ProjectId;
  readonly commitSha: GitCommitSha;
  readonly treeSha: GitTreeSha;
  readonly managedRef: GitRef;
  readonly commitTitle: NonEmptyText;
  readonly plan: NodePlan;
  readonly planDigest: NodePlanDigest;
  readonly payloadDigest: NodePayloadDigest;
  readonly registeredAt: IsoTimestamp;
};

export type RootNode = NodeBase & {
  readonly type: "root";
};

export type RunChildNode = NodeBase & {
  readonly type: "run_child";
  readonly parentSha: GitCommitSha;
  readonly runId: RunId;
  readonly consumedGoalDigest: GoalDigest;
};

export type CoachingChildNode = NodeBase & {
  readonly type: "coaching_child";
  readonly parentSha: GitCommitSha;
  readonly proposalId: CoachingProposalId;
};

export type Node = RootNode | RunChildNode | CoachingChildNode;

export type RunCheckpoint = {
  readonly id: CheckpointId;
  readonly runId: RunId;
  readonly summary: EvidenceSummary;
  readonly location:
    | { readonly type: "observation" }
    | { readonly type: "commit"; readonly commitSha: GitCommitSha };
  readonly recordedAt: IsoTimestamp;
};

export type GitEvidenceLocation = {
  readonly type: "git";
  readonly commitSha: GitCommitSha;
  readonly path: GitTreePath;
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
  readonly target:
    | { readonly type: "run" }
    | { readonly type: "criterion"; readonly criterion: AcceptanceCriterion };
  readonly kind: "diff" | "check" | "screenshot" | "report" | "note";
  readonly summary: EvidenceSummary;
  readonly location: GitEvidenceLocation | UrlEvidenceLocation | TextEvidenceLocation;
  readonly recordedAt: IsoTimestamp;
};

type RunBase = {
  readonly id: RunId;
  readonly projectId: ProjectId;
  readonly sourceNodeSha: GitCommitSha;
  readonly goal: GoalValue;
  readonly goalDigest: GoalDigest;
  readonly runner: RunnerValue;
  readonly runnerDigest: RunnerDigest;
  readonly branch: GitBranchName;
  readonly checkpoints: readonly RunCheckpoint[];
  readonly evidenceIds: readonly EvidenceId[];
  readonly startedAt: IsoTimestamp;
};

export type RunningRun = RunBase & {
  readonly status: "running";
};

export type CompletedRun = RunBase & {
  readonly status: "completed";
  readonly resultNodeSha: GitCommitSha;
  readonly verifiedAt: IsoTimestamp;
  readonly completedAt: IsoTimestamp;
};

export type FailedRun = RunBase & {
  readonly status: "failed";
  readonly failedAt: IsoTimestamp;
  readonly failureReason: Reason;
};

export type CanceledRun = RunBase & {
  readonly status: "canceled";
  readonly canceledAt: IsoTimestamp;
  readonly cancellationReason: Reason;
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
  | { readonly type: "node"; readonly nodeSha: GitCommitSha }
  | { readonly type: "run"; readonly runId: RunId }
  | { readonly type: "comparison"; readonly comparisonId: ComparisonId };

export type CoachReview = {
  readonly id: CoachReviewId;
  readonly projectId: ProjectId;
  readonly target: CoachReviewTarget;
  readonly assessment: NonEmptyText;
  readonly recommendations: readonly NonEmptyText[];
  readonly recordedAt: IsoTimestamp;
};

export type CoachingProposal = {
  readonly id: CoachingProposalId;
  readonly projectId: ProjectId;
  readonly sourceNodeSha: GitCommitSha;
  readonly sourcePayloadDigest: NodePayloadDigest;
  readonly sourcePlanDigest: NodePlanDigest;
  readonly proposedPlan: NodePlan;
  readonly proposedPlanDigest: NodePlanDigest;
  readonly expectedStateSha: GitCommitSha;
  readonly summary: EvidenceSummary;
  readonly rationale: Reason;
  readonly proposedAt: IsoTimestamp;
};

export type ConfirmedCoachingProposalDecision = {
  readonly status: "confirmed";
  readonly id: DecisionId;
  readonly proposalId: CoachingProposalId;
  readonly childNodeSha: GitCommitSha;
  readonly reason: Reason;
  readonly decidedAt: IsoTimestamp;
};

export type RejectedCoachingProposalDecision = {
  readonly status: "rejected";
  readonly id: DecisionId;
  readonly proposalId: CoachingProposalId;
  readonly reason: Reason;
  readonly decidedAt: IsoTimestamp;
};

export type CoachingProposalDecision =
  | ConfirmedCoachingProposalDecision
  | RejectedCoachingProposalDecision;

export type ComparisonFinding = {
  readonly subject: NonEmptyText;
  readonly summaries: NonEmptyArray<{
    readonly nodeSha: GitCommitSha;
    readonly summary: EvidenceSummary;
  }>;
};

type AlternativeComparisonBase = {
  readonly id: ComparisonId;
  readonly projectId: ProjectId;
  readonly nodeShas: AtLeastTwo<GitCommitSha>;
  readonly findings: readonly ComparisonFinding[];
  readonly summary: EvidenceSummary;
  readonly recordedAt: IsoTimestamp;
};

export type SiblingRunsComparison = AlternativeComparisonBase & {
  readonly type: "sibling_runs";
  readonly parentNodeSha: GitCommitSha;
};

export type CoachedHowExperimentComparison = AlternativeComparisonBase & {
  readonly type: "coached_how_experiment";
  readonly anchorNodeSha: GitCommitSha;
  readonly goalDigest: GoalDigest;
};

export type AlternativeComparison =
  | SiblingRunsComparison
  | CoachedHowExperimentComparison;

export type SelectionDecision = {
  readonly type: "selection";
  readonly id: DecisionId;
  readonly projectId: ProjectId;
  readonly comparisonId: ComparisonId;
  readonly selectedNodeSha: GitCommitSha;
  readonly rationale: Reason;
  readonly decidedAt: IsoTimestamp;
};

export type RejectionDecision = {
  readonly type: "rejection";
  readonly id: DecisionId;
  readonly projectId: ProjectId;
  readonly comparisonId: ComparisonId;
  readonly rejectedNodeShas: NonEmptyArray<GitCommitSha>;
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
  readonly id: NonEmptyText;
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
  readonly expectedStateSha: GitCommitSha;
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

type CompareAlternativesCommandBase = {
  readonly type: "CompareAlternatives";
  readonly meta: CommandMetadata;
  readonly comparisonId: ComparisonId;
  readonly projectId: ProjectId;
  readonly nodeShas: AtLeastTwo<GitCommitSha>;
  readonly findings: readonly ComparisonFinding[];
  readonly summary: EvidenceSummary;
};

export type CompareAlternativesCommand =
  | (CompareAlternativesCommandBase & {
      readonly comparisonType: "sibling_runs";
    })
  | (CompareAlternativesCommandBase & {
      readonly comparisonType: "coached_how_experiment";
      readonly anchorNodeSha: GitCommitSha;
    });

export type ProjectCommand =
  | {
      readonly type: "CreateProject";
      readonly meta: CommandMetadata;
      readonly rootNodeEventId: EventId;
      readonly project: Project;
      readonly rootNode: RootNode;
      readonly payload: NodePayloadEnvelope;
    }
  | {
      readonly type: "RebuildProjectMaterializations";
      readonly meta: CommandMetadata;
      readonly projectId: ProjectId;
    }
  | {
      readonly type: "StartRun";
      readonly meta: CommandMetadata;
      readonly runId: RunId;
      readonly projectId: ProjectId;
      readonly sourceNodeSha: GitCommitSha;
      readonly goalDigest: GoalDigest;
      readonly branch: GitBranchName;
    }
  | { readonly type: "CheckpointRun"; readonly meta: CommandMetadata; readonly checkpoint: RunCheckpoint }
  | { readonly type: "AttachRunEvidence"; readonly meta: CommandMetadata; readonly evidence: EvidenceRef }
  | {
      readonly type: "CompleteRun";
      readonly meta: CommandMetadata;
      readonly nodeEventId: EventId;
      readonly result: VerifiedRunResult;
      readonly node: RunChildNode;
      readonly payload: NodePayloadEnvelope;
    }
  | { readonly type: "FailRun"; readonly meta: CommandMetadata; readonly runId: RunId; readonly reason: Reason }
  | { readonly type: "CancelRun"; readonly meta: CommandMetadata; readonly runId: RunId; readonly reason: Reason }
  | { readonly type: "RecordCoachReview"; readonly meta: CommandMetadata; readonly review: CoachReview }
  | {
      readonly type: "RecordCoachingProposal";
      readonly meta: CommandMetadata;
      readonly proposal: CoachingProposal;
    }
  | {
      readonly type: "ConfirmCoachingProposal";
      readonly meta: CommandMetadata;
      readonly nodeEventId: EventId;
      readonly decisionId: DecisionId;
      readonly proposalId: CoachingProposalId;
      readonly reason: Reason;
      readonly node: CoachingChildNode;
      readonly payload: NodePayloadEnvelope;
    }
  | {
      readonly type: "RejectCoachingProposal";
      readonly meta: CommandMetadata;
      readonly decisionId: DecisionId;
      readonly proposalId: CoachingProposalId;
      readonly reason: Reason;
    }
  | CompareAlternativesCommand
  | {
      readonly type: "SelectAlternative";
      readonly meta: CommandMetadata;
      readonly decisionId: DecisionId;
      readonly projectId: ProjectId;
      readonly comparisonId: ComparisonId;
      readonly selectedNodeSha: GitCommitSha;
      readonly rationale: Reason;
    }
  | {
      readonly type: "RejectAlternatives";
      readonly meta: CommandMetadata;
      readonly decisionId: DecisionId;
      readonly projectId: ProjectId;
      readonly comparisonId: ComparisonId;
      readonly rejectedNodeShas: NonEmptyArray<GitCommitSha>;
      readonly rationale: Reason;
    };

export type DomainEvent =
  | { readonly type: "ProjectCreated"; readonly meta: EventMetadata; readonly project: Project }
  | { readonly type: "ProjectMaterializationsRebuilt"; readonly meta: EventMetadata; readonly projectId: ProjectId }
  | {
      readonly type: "RootNodeRegistered";
      readonly meta: EventMetadata;
      readonly node: RootNode;
      readonly payload: NodePayloadEnvelope;
    }
  | { readonly type: "RunStarted"; readonly meta: EventMetadata; readonly run: RunningRun }
  | { readonly type: "RunCheckpointed"; readonly meta: EventMetadata; readonly checkpoint: RunCheckpoint }
  | { readonly type: "RunEvidenceAttached"; readonly meta: EventMetadata; readonly evidence: EvidenceRef }
  | { readonly type: "RunCompleted"; readonly meta: EventMetadata; readonly result: VerifiedRunResult }
  | {
      readonly type: "RunChildNodeRegistered";
      readonly meta: EventMetadata;
      readonly node: RunChildNode;
      readonly payload: NodePayloadEnvelope;
    }
  | { readonly type: "RunFailed"; readonly meta: EventMetadata; readonly runId: RunId; readonly reason: Reason }
  | { readonly type: "RunCanceled"; readonly meta: EventMetadata; readonly runId: RunId; readonly reason: Reason }
  | { readonly type: "CoachReviewRecorded"; readonly meta: EventMetadata; readonly review: CoachReview }
  | {
      readonly type: "CoachingProposalRecorded";
      readonly meta: EventMetadata;
      readonly proposal: CoachingProposal;
    }
  | {
      readonly type: "CoachingProposalConfirmed";
      readonly meta: EventMetadata;
      readonly decision: ConfirmedCoachingProposalDecision;
    }
  | {
      readonly type: "CoachingChildNodeRegistered";
      readonly meta: EventMetadata;
      readonly node: CoachingChildNode;
      readonly payload: NodePayloadEnvelope;
    }
  | {
      readonly type: "CoachingProposalRejected";
      readonly meta: EventMetadata;
      readonly decision: RejectedCoachingProposalDecision;
    }
  | { readonly type: "AlternativesCompared"; readonly meta: EventMetadata; readonly comparison: AlternativeComparison }
  | { readonly type: "AlternativeSelected"; readonly meta: EventMetadata; readonly decision: SelectionDecision }
  | { readonly type: "AlternativesRejected"; readonly meta: EventMetadata; readonly decision: RejectionDecision };

export type ProcessedCommand = {
  readonly idempotencyKey: IdempotencyKey;
  readonly fingerprint: CommandFingerprint;
  readonly eventIds: NonEmptyArray<EventId>;
};

export type ProjectState = {
  readonly projects: readonly Project[];
  readonly nodes: readonly Node[];
  readonly runs: readonly Run[];
  readonly evidence: readonly EvidenceRef[];
  readonly coachReviews: readonly CoachReview[];
  readonly coachingProposals: readonly CoachingProposal[];
  readonly coachingProposalDecisions: readonly CoachingProposalDecision[];
  readonly comparisons: readonly AlternativeComparison[];
  readonly decisions: readonly AlternativeDecision[];
  readonly processedCommands: readonly ProcessedCommand[];
};

export function runBranchName(projectId: ProjectId, sourceNodeSha: GitCommitSha, runId: RunId): GitBranchName {
  return (`hunsu/run/${projectId}/${sourceNodeSha}/${runId}`) as GitBranchName;
}

export function managedNodeRef(projectId: ProjectId, commitSha: GitCommitSha): GitRef {
  return (`refs/tags/hunsu/node/${projectId}/${commitSha}`) as GitRef;
}
