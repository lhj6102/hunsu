import type {
  CanonicalJsonValue,
  DomainActor,
  DomainEvent,
  GoalValue,
  ProjectState,
  RunnerValue
} from "@hunsu/protocol";

export type ProjectIntegrityProjection =
  | { readonly status: "valid" }
  | { readonly status: "invalid"; readonly code: string; readonly message: string };

export type ProjectionContext = {
  readonly defaultBranch: string;
  readonly stateHeadSha: string;
  readonly synchronizedAt: string;
  readonly digestGoal: (goal: GoalValue) => string;
  readonly digestRunner: (runner: RunnerValue) => string;
};

export type RepositoryProjection = {
  readonly owner: string;
  readonly name: string;
  readonly url: string;
  readonly defaultBranch: string;
};

export type ProjectSummaryProjection = {
  readonly id: string;
  readonly title: string;
  readonly repository: RepositoryProjection;
  readonly rootNodeSha: string;
};

export type ProjectListItemProjection = ProjectSummaryProjection & {
  readonly nodeCount: number;
  readonly activeRunCount: number;
  readonly unresolvedDivergenceCount: number;
  readonly integrity: ProjectIntegrityProjection;
  readonly synchronizedAt: string;
};

export type RunnerSummaryProjection = {
  readonly name: string;
  readonly typeKey: string;
  readonly schemaVersion: string;
  readonly digest: string;
};

export type GraphNodeStatusProjection = "available" | "current" | "selected" | "rejected";

export type GraphNodeSummaryProjection = {
  readonly sha: string;
  readonly title: string;
  readonly status: GraphNodeStatusProjection;
  readonly runner: RunnerSummaryProjection;
  readonly nextGoalCount: number;
  readonly integrity: "valid";
};

export type RunGraphEdgeProjection = {
  readonly kind: "run";
  readonly id: string;
  readonly sourceSha: string;
  readonly targetSha: string;
  readonly runId: string;
  readonly goal: { readonly digest: string; readonly title: string };
  readonly completedAt: string;
};

export type CoachingGraphEdgeProjection = {
  readonly kind: "coaching";
  readonly id: string;
  readonly sourceSha: string;
  readonly targetSha: string;
  readonly proposalId: string;
  readonly summary: string;
  readonly confirmedAt: string;
};

export type GraphEdgeProjection = RunGraphEdgeProjection | CoachingGraphEdgeProjection;

export type ActiveRunSummaryProjection = {
  readonly id: string;
  readonly sourceNodeSha: string;
  readonly goalDigest: string;
  readonly goalTitle: string;
  readonly runnerName: string;
  readonly startedAt: string;
};

export type ProjectGraphProjection = {
  readonly project: ProjectSummaryProjection;
  readonly stateHeadSha: string;
  readonly integrity: ProjectIntegrityProjection;
  readonly nodes: readonly GraphNodeSummaryProjection[];
  readonly edges: readonly GraphEdgeProjection[];
  readonly activeRuns: readonly ActiveRunSummaryProjection[];
  readonly window: {
    readonly limit: number;
    readonly hasMore: boolean;
    readonly continuationCursor: string | null;
  };
};

export type GoalValueProjection = {
  readonly digest: string;
  readonly key: string;
  readonly title: string;
  readonly desiredOutcome: string;
  readonly acceptanceCriteria: readonly string[];
  readonly constraints: readonly string[];
  readonly priority: number;
};

export type RunnerValueProjection = RunnerSummaryProjection & {
  readonly schema: "hunsu.runner-value.v1";
  readonly type: {
    readonly origin: string;
    readonly key: string;
    readonly schemaVersion: string;
    readonly integrity: string;
  };
  readonly value: CanonicalJsonValue;
};

export type NodeLineageProjection =
  | { readonly kind: "root" }
  | { readonly kind: "run_child"; readonly parentSha: string; readonly runId: string; readonly goalDigest: string }
  | { readonly kind: "coaching_child"; readonly parentSha: string; readonly proposalId: string };

export type EvidenceSummaryProjection = {
  readonly id: string;
  readonly kind: "commit" | "check" | "report" | "artifact" | "link";
  readonly title: string;
  readonly summary: string;
  readonly criterion:
    | { readonly kind: "unlinked" }
    | { readonly kind: "linked"; readonly goalDigest: string; readonly criterion: string };
  readonly location: { readonly kind: "none" } | { readonly kind: "url"; readonly url: string };
  readonly createdAt: string;
};

export type ComparisonSummaryProjection = {
  readonly id: string;
  readonly summary: string;
  readonly siblingNodeShas: readonly string[];
  readonly recordedAt: string;
};

export type DecisionSummaryProjection =
  | { readonly kind: "selected"; readonly id: string; readonly nodeSha: string; readonly reason: string; readonly recordedAt: string }
  | { readonly kind: "rejected"; readonly id: string; readonly nodeSha: string; readonly reason: string; readonly recordedAt: string };

export type NodeDetailProjection = {
  readonly sha: string;
  readonly title: string;
  readonly commitUrl: string;
  readonly treeSha: string;
  readonly managedRef: string;
  readonly integrity: ProjectIntegrityProjection;
  readonly status: GraphNodeStatusProjection;
  readonly lineage: NodeLineageProjection;
  readonly plan: {
    readonly schema: "hunsu.node-plan.v1";
    readonly nextGoals: readonly GoalValueProjection[];
    readonly how: RunnerValueProjection;
  };
  readonly outgoingEdges: readonly GraphEdgeProjection[];
  readonly activeRuns: readonly ActiveRunSummaryProjection[];
  readonly evidence: readonly EvidenceSummaryProjection[];
  readonly comparisons: readonly ComparisonSummaryProjection[];
  readonly decisions: readonly DecisionSummaryProjection[];
};

export type RunDetailProjection = {
  readonly run: ProjectState["runs"][number];
  readonly evidence: readonly ProjectState["evidence"][number][];
  readonly sourceNodeTitle: string;
};

export type SequencedDomainEvent = {
  readonly sequence: number;
  readonly event: DomainEvent;
  readonly actor: DomainActor;
};

export type EventReferenceProjection =
  | { readonly kind: "project" }
  | { readonly kind: "node"; readonly nodeSha: string }
  | {
      readonly kind: "run";
      readonly runId: string;
      readonly sourceNodeSha: string;
      readonly target: { readonly kind: "pending" } | { readonly kind: "registered"; readonly nodeSha: string };
    };

export type DomainEventListItemProjection = {
  readonly sequence: number;
  readonly id: string;
  readonly type: DomainEvent["type"];
  readonly summary: string;
  readonly actor: { readonly id: string; readonly label: string };
  readonly occurredAt: string;
  readonly reference: EventReferenceProjection;
};
