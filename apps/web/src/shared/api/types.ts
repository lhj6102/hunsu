export type GitHubRepositoryRef = {
  owner: string;
  name: string;
  url: string;
  defaultBranch: string;
};

export type SessionResponse = {
  authenticated: boolean;
  user?: {
    id: string;
    login: string;
    name?: string;
    avatarUrl?: string;
  };
  workspace?: {
    id: string;
    accountLogin: string;
    accountType: "organization" | "user";
  };
  github: {
    connected: boolean;
    installationId?: number;
    connectUrl: string;
  };
};

export type ApiProblem = {
  code: string;
  message: string;
  retryable?: boolean;
  retryAfterSeconds?: number;
  requestId?: string;
  expectedStateSha?: string;
  actualStateSha?: string;
  fieldErrors?: Record<string, string>;
};

export type ProjectIntegrity =
  | { status: "valid" }
  | { status: "invalid"; code: string; message: string };

export type ProjectListItem = {
  id: string;
  title: string;
  repository: GitHubRepositoryRef;
  rootNodeSha: string;
  nodeCount: number;
  activeRunCount: number;
  unresolvedDivergenceCount: number;
  integrity: ProjectIntegrity;
  synchronizedAt: string;
};

export type ProjectListResponse = {
  schema: "hunsu.web.project-list.v2";
  projects: readonly ProjectListItem[];
};

export type ProjectGraphSummary = {
  id: string;
  title: string;
  repository: GitHubRepositoryRef;
  rootNodeSha: string;
};

export type RunnerSummary = {
  name: string;
  typeKey: string;
  schemaVersion: string;
  digest: string;
};

export type GraphNodeStatus = "available" | "current" | "selected" | "rejected";

export type GraphNodeSummary = {
  sha: string;
  title: string;
  status: GraphNodeStatus;
  runner: RunnerSummary;
  nextGoalCount: number;
  integrity: "valid";
};

export type RunGraphEdge = {
  kind: "run";
  id: string;
  sourceSha: string;
  targetSha: string;
  runId: string;
  goal: {
    digest: string;
    title: string;
  };
  completedAt: string;
};

export type CoachingGraphEdge = {
  kind: "coaching";
  id: string;
  sourceSha: string;
  targetSha: string;
  proposalId: string;
  summary: string;
  confirmedAt: string;
};

export type GraphEdge = RunGraphEdge | CoachingGraphEdge;

export type ActiveRunSummary = {
  id: string;
  sourceNodeSha: string;
  goalDigest: string;
  goalTitle: string;
  runnerName: string;
  startedAt: string;
};

export type ProjectGraphResponse = {
  schema: "hunsu.web.project-graph.v2";
  project: ProjectGraphSummary;
  stateHeadSha: string;
  integrity: ProjectIntegrity;
  nodes: readonly GraphNodeSummary[];
  edges: readonly GraphEdge[];
  activeRuns: readonly ActiveRunSummary[];
  window:
    | { limit: number; hasMore: false; continuationCursor: null }
    | { limit: number; hasMore: true; continuationCursor: string };
};

export type GoalValue = {
  digest: string;
  key: string;
  title: string;
  desiredOutcome: string;
  acceptanceCriteria: readonly string[];
  constraints: readonly string[];
  priority: number;
};

export type CanonicalJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalJsonValue[]
  | { readonly [key: string]: CanonicalJsonValue };

export type RunnerValueSummary = RunnerSummary & {
  schema: "hunsu.runner-value.v1";
  type: {
    origin: string;
    key: string;
    schemaVersion: string;
    integrity: string;
  };
  value: CanonicalJsonValue;
};

export type NodeLineage =
  | { kind: "root" }
  | { kind: "run_child"; parentSha: string; runId: string; goalDigest: string }
  | { kind: "coaching_child"; parentSha: string; proposalId: string };

export type EvidenceSummary = {
  id: string;
  kind: "commit" | "check" | "report" | "artifact" | "link";
  title: string;
  summary: string;
  criterion: { kind: "unlinked" } | { kind: "linked"; goalDigest: string; criterion: string };
  location: { kind: "none" } | { kind: "url"; url: string };
  createdAt: string;
};

export type ComparisonDecisionSummary = {
  id: string;
  type: "selection" | "rejection";
  comparisonId: string;
  nodeShas: readonly string[];
  rationale: string;
  decidedAt: string;
};

type ComparisonSummaryBase = {
  id: string;
  summary: string;
  nodeShas: readonly string[];
  disposition:
    | { type: "undecided" }
    | { type: "decisions_recorded"; decisions: readonly ComparisonDecisionSummary[] };
  recordedAt: string;
};

export type ComparisonSummary =
  | (ComparisonSummaryBase & { type: "sibling_runs"; parentNodeSha: string })
  | (ComparisonSummaryBase & {
      type: "coached_how_experiment";
      anchorNodeSha: string;
      goalDigest: string;
    });

export type CoachingProposalSummary = {
  id: string;
  sourceNodeSha: string;
  sourcePayloadDigest: string;
  sourcePlanDigest: string;
  proposedPlanDigest: string;
  expectedStateSha: string;
  summary: string;
  rationale: string;
  proposedAt: string;
  disposition:
    | { type: "pending" }
    | { type: "confirmed"; decisionId: string; childNodeSha: string; reason: string; decidedAt: string }
    | { type: "rejected"; decisionId: string; reason: string; decidedAt: string };
};

export type CoachReviewSummary = {
  id: string;
  target:
    | { type: "node"; nodeSha: string }
    | { type: "run"; runId: string }
    | { type: "comparison"; comparisonId: string };
  assessment: string;
  recommendations: readonly string[];
  recordedAt: string;
};

export type DecisionSummary =
  | { kind: "selected"; id: string; nodeSha: string; reason: string; recordedAt: string }
  | { kind: "rejected"; id: string; nodeSha: string; reason: string; recordedAt: string };

export type NodeDetail = {
  sha: string;
  payloadDigest: string;
  planDigest: string;
  title: string;
  commitUrl: string;
  treeSha: string;
  managedRef: string;
  integrity: ProjectIntegrity;
  status: GraphNodeStatus;
  lineage: NodeLineage;
  plan: {
    schema: "hunsu.node-plan.v1";
    nextGoals: readonly GoalValue[];
    how: RunnerValueSummary;
  };
  outgoingEdges: readonly GraphEdge[];
  activeRuns: readonly ActiveRunSummary[];
  evidence: readonly EvidenceSummary[];
  comparisons: readonly ComparisonSummary[];
  decisions: readonly DecisionSummary[];
  coachingProposals: readonly CoachingProposalSummary[];
  coachReviews: readonly CoachReviewSummary[];
};

export type NodeDetailResponse = {
  schema: "hunsu.web.node-detail.v2";
  stateHeadSha: string;
  node: NodeDetail;
};

export type StartRunResponse = {
  schema: "hunsu.web.run-started.v2";
  runId: string;
  stateHeadSha: string;
  synchronizedAt: string;
};

export const DOMAIN_EVENT_TYPES = [
  "ProjectCreated",
  "ProjectMaterializationsRebuilt",
  "RootNodeRegistered",
  "RunStarted",
  "RunCheckpointed",
  "RunEvidenceAttached",
  "RunCompleted",
  "RunChildNodeRegistered",
  "RunFailed",
  "RunCanceled",
  "CoachReviewRecorded",
  "CoachingProposalRecorded",
  "CoachingProposalConfirmed",
  "CoachingChildNodeRegistered",
  "CoachingProposalRejected",
  "AlternativesCompared",
  "AlternativeSelected",
  "AlternativesRejected"
] as const;

export type DomainEventType = (typeof DOMAIN_EVENT_TYPES)[number];

export type EventReference =
  | { kind: "project" }
  | { kind: "node"; nodeSha: string }
  | { kind: "run"; runId: string; sourceNodeSha: string; target: { kind: "pending" } | { kind: "registered"; nodeSha: string } };

export type DomainEventListItem = {
  sequence: number;
  id: string;
  type: DomainEventType;
  summary: string;
  actor: {
    id: string;
    label: string;
  };
  occurredAt: string;
  reference: EventReference;
};

export type EventsResponse = {
  schema: "hunsu.web.events.v2";
  project: ProjectGraphSummary;
  stateHeadSha: string;
  events: readonly DomainEventListItem[];
  nextCursor: string | null;
};

export type EventDetailResponse = {
  schema: "hunsu.web.event-detail.v2";
  project: ProjectGraphSummary;
  stateHeadSha: string;
  event: DomainEventListItem;
};
