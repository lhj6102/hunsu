export type ProjectionHealth = {
  repositoryAccess: "healthy" | "read_only" | "revoked" | "unavailable";
  stateRef: "healthy" | "missing" | "conflicted" | "unavailable";
  stateRefName: "hunsu/state";
  stateHeadSha?: string;
  projection: "current" | "rebuilding" | "stale" | "failed";
  synchronizedAt: string;
  message?: string;
};

export type ProjectionContext = {
  health: ProjectionHealth;
};

export type RepositoryProjection = {
  owner: string;
  name: string;
  url: string;
  defaultBranch: string;
};

export type RunnerReferenceProjection = {
  id: string;
  kind: "player" | "team";
  name: string;
};

export type EvidenceProjection = {
  id: string;
  kind: "commit" | "check" | "report" | "artifact" | "link";
  title: string;
  criterion?: string;
  summary?: string;
  url?: string;
  commitSha?: string;
  createdAt: string;
};

export type RunSummaryProjection = {
  id: string;
  goalId: string;
  goalTitle: string;
  runner: RunnerReferenceProjection;
  baseSha: string;
  branch: string;
  status: "running" | "completed" | "failed" | "canceled";
  resultSha?: string;
  resultUrl?: string;
  evidenceCount: number;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
};

export type CompletedRunSummaryProjection = RunSummaryProjection & {
  status: "completed";
  resultSha: string;
  resultUrl: string;
  completedAt: string;
};

export type GoalSummaryProjection = {
  id: string;
  title: string;
  desiredOutcome: string;
  status: "active" | "paused" | "completed";
  priority: "low" | "normal" | "high" | "urgent";
  runner?: RunnerReferenceProjection;
  runCount: number;
  activeRunCount: number;
  alternativeCount: number;
  updatedAt: string;
};

export type ProjectListItemProjection = {
  id: string;
  title: string;
  objective: string;
  repository: RepositoryProjection;
  activeGoalCount: number;
  activeRunCount: number;
  latestResult?: {
    runId: string;
    goalTitle: string;
    status: RunSummaryProjection["status"];
    resultSha?: string;
    updatedAt: string;
  };
  coachReviewStatus: "not_requested" | "ready" | "changes_recommended";
  unresolvedAlternativeCount: number;
  synchronizedAt: string;
};

export type AlternativeGroupProjection = {
  id: string;
  goalId: string;
  goalTitle: string;
  baseSha: string;
  runIds: string[];
  status: "open" | "selected" | "rejected";
};

export type DecisionProjection = {
  id: string;
  goalId: string;
  title: string;
  status: "confirmed" | "rejected";
  recommendedRunId?: string;
  reason: string;
  createdAt: string;
};

export type ProjectOverviewProjection = {
  id: string;
  title: string;
  objective: string;
  baseRef: string;
  repository: RepositoryProjection;
  goals: GoalSummaryProjection[];
  runs: RunSummaryProjection[];
  recentEvidence: EvidenceProjection[];
  alternatives: AlternativeGroupProjection[];
  decisions: DecisionProjection[];
  health: ProjectionHealth;
  createdAt: string;
  updatedAt: string;
};

export type RunnerProjection =
  | {
      kind: "player";
      id: string;
      name: string;
      promptTemplate: string;
      resources: Array<{ id: string; kind: "skill" | "plugin"; name: string; version?: string }>;
      runtimePolicy: { network: "disabled" | "enabled"; approvals: "never" | "on_request" };
      goalCount: number;
      recentResults: RunSummaryProjection[];
    }
  | {
      kind: "team";
      id: string;
      name: string;
      strategy: {
        mode: "sequence" | "parallel" | "coordinated";
        promptTemplate: string;
        maxRounds: number;
      };
      players: Array<{ playerId: string; playerName: string; role: string; order: number }>;
      goalCount: number;
      recentResults: RunSummaryProjection[];
    };

export type GoalAlternativeProjection = {
  run: RunSummaryProjection;
  label: string;
  summary: string;
  strengths: string[];
  tradeoffs: string[];
  evidence: EvidenceProjection[];
  selected: boolean;
  rejected: boolean;
};

export type GoalDetailProjection = {
  id: string;
  projectId: string;
  title: string;
  desiredOutcome: string;
  acceptanceCriteria: string[];
  constraints: string[];
  status: "active" | "paused" | "completed";
  priority: "low" | "normal" | "high" | "urgent";
  parentGoalId?: string;
  relatedGoalIds: string[];
  runner?: RunnerReferenceProjection;
  runs: RunSummaryProjection[];
  evidence: EvidenceProjection[];
  alternatives: GoalAlternativeProjection[];
  comparisons: AlternativeComparisonProjection[];
  coachReview?: {
    id: string;
    status: "ready" | "changes_recommended";
    summary: string;
    strengths: string[];
    concerns: string[];
    recommendation?: string;
    createdAt: string;
  };
  decision?: DecisionProjection;
  createdAt: string;
  updatedAt: string;
};

export type RunDetailProjection = RunSummaryProjection & {
  projectId: string;
  goalSnapshot: {
    title: string;
    desiredOutcome: string;
    acceptanceCriteria: string[];
    constraints: string[];
  };
  runnerSnapshot: RunnerProjection;
  instructions: string;
  checkpoints: Array<{ id: string; summary: string; commitSha?: string; createdAt: string }>;
  evidence: EvidenceProjection[];
  failure?: { code: string; message: string; retryable: boolean };
};

export type AssignedRunnerProjection = { type: "assigned"; runnerId: string; runner: RunnerReferenceProjection };

export type GoalAssignmentProjection =
  | { type: "unassigned" }
  | AssignedRunnerProjection;

export type GoalPatchProjection = {
  title?: string;
  desiredOutcome?: string;
  acceptanceCriteria?: string[];
  constraints?: string[];
  priority?: number;
  assignment?: GoalAssignmentProjection;
  relation?:
    | { type: "root" }
    | { type: "child"; parentGoalId: string }
    | { type: "related"; goalIds: string[] };
};

export type RunnerAssignmentChangeProjection = {
  from: GoalAssignmentProjection;
  to: AssignedRunnerProjection;
};

type CoachProposalProjectionBase = {
  id: string;
  title: string;
  rationale: string;
  summary: string;
  consequential: true;
  status: "proposed" | "confirmed" | "rejected";
  createdAt: string;
};

export type CoachProposalProjection =
  | (CoachProposalProjectionBase & {
      kind: "goal_change";
      goalId: string;
      change: GoalPatchProjection;
    })
  | (CoachProposalProjectionBase & {
      kind: "runner_change";
      goalId: string;
      change: RunnerAssignmentChangeProjection;
    })
  | (CoachProposalProjectionBase & {
      kind: "hunsu";
      goalId: string;
      sourceRun: CompletedRunSummaryProjection;
      alternative:
        | { type: "goal_change"; change: GoalPatchProjection }
        | { type: "runner_change"; change: RunnerAssignmentChangeProjection };
    });

export type CoachComparisonRecommendationProjection = {
  id: string;
  divergenceId: string;
  goalId: string;
  goalTitle: string;
  baseSha: string;
  runIds: string[];
  completedRunCount: number;
  status: "gather_evidence" | "ready_to_compare" | "comparison_recorded";
  recommendation: string;
  comparisonId?: string;
};

export type CoachSelectionRecommendationProjection = {
  id: string;
  comparisonId: string;
  goalId: string;
  goalTitle: string;
  runIds: string[];
  status: "awaiting_user" | "decision_recorded";
  action: "review_selection" | "select" | "another_experiment";
  recommendation: string;
  basis: "coach_review" | "comparison_evidence" | "recorded_decision";
  recommendedRunId?: string;
  requiresUserConfirmation: true;
};

export type CoachProjection = {
  id: string;
  name: string;
  promptTemplate: string;
  resources: Array<{ id: string; kind: "skill" | "plugin"; name: string; version?: string }>;
  assessment: { summary: string; updatedAt: string };
  weakGoals: GoalSummaryProjection[];
  stalledRuns: RunSummaryProjection[];
  proposals: CoachProposalProjection[];
  comparisonRecommendations: CoachComparisonRecommendationProjection[];
  selectionRecommendations: CoachSelectionRecommendationProjection[];
};

export type AlternativeComparisonProjection = {
  id: string;
  projectId: string;
  goalId: string;
  divergenceId: string;
  baseSha: string;
  runIds: string[];
  summary: string;
  findings: Array<{
    criterion: string;
    summaries: Array<{ runId: string; summary: string }>;
  }>;
  alternatives: GoalAlternativeProjection[];
  recordedAt: string;
};
