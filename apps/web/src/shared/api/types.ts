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

export type RepositorySummary = GitHubRepositoryRef & {
  installationId: number;
  private: boolean;
  granted: boolean;
  stateHeadSha: string;
  updatedAt: string;
};

export type RepositoryListResponse = {
  repositories: RepositorySummary[];
};

export type GoalStatus = "active" | "paused" | "completed";
export type RunStatus = "running" | "completed" | "failed" | "canceled";
export type ReviewStatus = "not_requested" | "ready" | "changes_recommended";

export type RunnerReference = {
  id: string;
  kind: "player" | "team";
  name: string;
};

export type EvidenceRef = {
  id: string;
  kind: "commit" | "check" | "report" | "artifact" | "link";
  title: string;
  criterion?: string;
  summary?: string;
  url?: string;
  commitSha?: string;
  createdAt: string;
};

export type RunSummary = {
  id: string;
  goalId: string;
  goalTitle: string;
  runner: RunnerReference;
  baseSha: string;
  branch: string;
  status: RunStatus;
  resultSha?: string;
  resultUrl?: string;
  evidenceCount: number;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
};

export type CompletedRunSummary = RunSummary & {
  status: "completed";
  resultSha: string;
  resultUrl: string;
  completedAt: string;
};

export type GoalSummary = {
  id: string;
  title: string;
  desiredOutcome: string;
  status: GoalStatus;
  priority?: "low" | "normal" | "high" | "urgent";
  runner?: RunnerReference;
  runCount: number;
  activeRunCount: number;
  alternativeCount: number;
  updatedAt: string;
};

export type ProjectListItem = {
  id: string;
  title: string;
  objective: string;
  repository: GitHubRepositoryRef;
  activeGoalCount: number;
  activeRunCount: number;
  latestResult?: {
    runId: string;
    goalTitle: string;
    status: RunStatus;
    resultSha?: string;
    updatedAt: string;
  };
  coachReviewStatus: ReviewStatus;
  unresolvedAlternativeCount: number;
  synchronizedAt: string;
};

export type ProjectListResponse = {
  projects: ProjectListItem[];
};

export type RepositoryHealth = {
  repositoryAccess: "healthy" | "read_only" | "revoked" | "unavailable";
  stateRef: "healthy" | "missing" | "conflicted" | "unavailable";
  stateRefName: string;
  stateHeadSha?: string;
  projection: "current" | "rebuilding" | "stale" | "failed";
  synchronizedAt?: string;
  message?: string;
};

export type AlternativeGroupSummary = {
  id: string;
  goalId: string;
  goalTitle: string;
  baseSha: string;
  runIds: string[];
  status: "open" | "selected" | "rejected";
};

export type DecisionSummary = {
  id: string;
  goalId: string;
  title: string;
  status: "awaiting_confirmation" | "confirmed" | "rejected";
  recommendedRunId?: string;
  reason?: string;
  createdAt: string;
};

export type ProjectOverview = {
  id: string;
  title: string;
  objective: string;
  baseRef: string;
  repository: GitHubRepositoryRef;
  goals: GoalSummary[];
  runs: RunSummary[];
  recentEvidence: EvidenceRef[];
  alternatives: AlternativeGroupSummary[];
  decisions: DecisionSummary[];
  health: RepositoryHealth;
  createdAt: string;
  updatedAt: string;
};

export type ProjectResponse = {
  project: ProjectOverview;
  stateHeadSha: string;
};

export type CoachReview = {
  id: string;
  status: ReviewStatus;
  summary: string;
  strengths: string[];
  concerns: string[];
  recommendation?: string;
  createdAt: string;
};

export type GoalAlternative = {
  run: RunSummary;
  label: string;
  summary: string;
  strengths: string[];
  tradeoffs: string[];
  evidence: EvidenceRef[];
  selected: boolean;
  rejected: boolean;
};

export type AlternativeComparison = {
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
  alternatives: GoalAlternative[];
  recordedAt: string;
};

export type GoalDetail = {
  id: string;
  projectId: string;
  title: string;
  desiredOutcome: string;
  acceptanceCriteria: string[];
  constraints: string[];
  status: GoalStatus;
  priority?: "low" | "normal" | "high" | "urgent";
  parentGoalId?: string;
  relatedGoalIds: string[];
  runner?: RunnerReference;
  runs: RunSummary[];
  evidence: EvidenceRef[];
  alternatives: GoalAlternative[];
  comparisons: AlternativeComparison[];
  coachReview?: CoachReview;
  decision?: DecisionSummary;
  createdAt: string;
  updatedAt: string;
};

export type GoalResponse = {
  goal: GoalDetail;
  stateHeadSha: string;
};

export type ResourceBinding =
  | { id: string; kind: "skill"; name: string; reference: string }
  | { id: string; kind: "plugin"; name: string; reference: string };

export type RuntimePolicy = {
  filesystem: "read_only" | "worktree_write";
  network: "disabled" | "enabled";
  approvals: "never" | "on_request";
};

export type Player = {
  kind: "player";
  id: string;
  name: string;
  description?: string;
  promptTemplate: string;
  resources: ResourceBinding[];
  runtimePolicy: RuntimePolicy;
  goalCount: number;
  recentResults: RunSummary[];
};

export type TeamPlayerLink = {
  playerId: string;
  playerName: string;
  role: string;
  order: number;
};

export type Team = {
  kind: "team";
  id: string;
  name: string;
  description?: string;
  strategy: {
    mode: "sequence" | "parallel" | "coordinated";
    promptTemplate: string;
    maxRounds: number;
  };
  players: TeamPlayerLink[];
  goalCount: number;
  recentResults: RunSummary[];
};

export type Runner = Player | Team;

export type RunnerListResponse = {
  runners: Runner[];
};

export type RunCheckpoint = {
  id: string;
  summary: string;
  commitSha?: string;
  createdAt: string;
};

export type RunDetail = RunSummary & {
  projectId: string;
  goalSnapshot: {
    title: string;
    desiredOutcome: string;
    acceptanceCriteria: string[];
    constraints: string[];
  };
  runnerSnapshot: Runner;
  instructions: string;
  checkpoints: RunCheckpoint[];
  evidence: EvidenceRef[];
  failure?: {
    code: string;
    message: string;
    retryable: boolean;
  };
};

export type RunResponse = {
  run: RunDetail;
};

export type AssignedRunnerChange = { type: "assigned"; runnerId: string; runner: RunnerReference };

export type GoalAssignmentChange =
  | { type: "unassigned" }
  | AssignedRunnerChange;

export type GoalPatchChange = {
  title?: string;
  desiredOutcome?: string;
  acceptanceCriteria?: string[];
  constraints?: string[];
  priority?: number;
  assignment?: GoalAssignmentChange;
  relation?:
    | { type: "root" }
    | { type: "child"; parentGoalId: string }
    | { type: "related"; goalIds: string[] };
};

export type RunnerAssignmentChange = {
  from: GoalAssignmentChange;
  to: AssignedRunnerChange;
};

type CoachProposalBase = {
  id: string;
  title: string;
  rationale: string;
  summary: string;
  consequential: true;
  status: "proposed" | "confirmed" | "rejected";
  createdAt: string;
};

export type CoachProposal =
  | (CoachProposalBase & {
      kind: "goal_change";
      goalId: string;
      change: GoalPatchChange;
    })
  | (CoachProposalBase & {
      kind: "runner_change";
      goalId: string;
      change: RunnerAssignmentChange;
    })
  | (CoachProposalBase & {
      kind: "hunsu";
      goalId: string;
      sourceRun: CompletedRunSummary;
      alternative:
        | { type: "goal_change"; change: GoalPatchChange }
        | { type: "runner_change"; change: RunnerAssignmentChange };
    });

export type CoachComparisonRecommendation = {
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

export type CoachSelectionRecommendation = {
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

export type CoachView = {
  id: string;
  name: string;
  promptTemplate: string;
  resources: ResourceBinding[];
  assessment: {
    summary: string;
    updatedAt: string;
  };
  weakGoals: GoalSummary[];
  stalledRuns: RunSummary[];
  proposals: CoachProposal[];
  comparisonRecommendations: CoachComparisonRecommendation[];
  selectionRecommendations: CoachSelectionRecommendation[];
};

export type CoachResponse = {
  coach: CoachView;
  stateHeadSha: string;
};

export type MutationResponse<T> = {
  value: T;
  stateHeadSha: string;
  synchronizedAt: string;
};

export type ApiProblem = {
  code: string;
  message: string;
  retryable?: boolean;
  expectedStateSha?: string;
  actualStateSha?: string;
  fieldErrors?: Record<string, string>;
};
