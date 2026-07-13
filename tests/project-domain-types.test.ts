import type {
  AcceptanceCriterion,
  ActiveGoal,
  CompletedRun,
  DesiredOutcome,
  GitBranchName,
  GitCommitSha,
  Goal,
  GoalId,
  GoalTitle,
  IsoTimestamp,
  NonNegativeInteger,
  PlayerSnapshot,
  ProjectId,
  Run,
  RunId,
  Runner,
  RunnerId,
  RunningRun
} from "../packages/protocol/src/index.ts";

const projectId = "project_alpha" as ProjectId;
const goalId = "goal_alpha" as GoalId;
const runId = "run_alpha" as RunId;
const playerId = "player_alpha" as RunnerId;
const at = "2026-07-13T00:00:00.000Z" as IsoTimestamp;
const baseSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as GitCommitSha;
const branch = "hunsu/run/project_alpha/goal_alpha/run_alpha" as GitBranchName;

// @ts-expect-error Project identifiers must be smart-constructed or explicitly decoded.
const rawProjectId: ProjectId = "project_alpha";

const activeGoal: ActiveGoal = {
  id: goalId,
  projectId,
  title: "Ship the vertical slice" as GoalTitle,
  desiredOutcome: "A verified result is visible." as DesiredOutcome,
  acceptanceCriteria: ["The result commit is verified." as AcceptanceCriterion],
  constraints: [],
  priority: 1 as NonNegativeInteger,
  assignment: { type: "assigned", runnerId: playerId },
  relation: { type: "root" },
  status: "active",
  createdAt: at,
  updatedAt: at
};

// @ts-expect-error Completed Goals always identify the selected Run.
const completedGoalWithoutSelection: Goal = {
  ...activeGoal,
  status: "completed",
  completedAt: at
};

const playerSnapshot: PlayerSnapshot = {
  kind: "player",
  id: playerId,
  projectId,
  promptTemplate: "Perform the work." as PlayerSnapshot["promptTemplate"],
  resources: [],
  runtimePolicy: { fileAccess: "project_write", network: "denied", approval: "user" },
  capturedAt: at
};

const runBase = {
  id: runId,
  projectId,
  goalId,
  runnerId: playerId,
  baseSha,
  branch,
  origin: { type: "primary" as const },
  goalSnapshot: {
    id: goalId,
    projectId,
    title: activeGoal.title,
    desiredOutcome: activeGoal.desiredOutcome,
    acceptanceCriteria: activeGoal.acceptanceCriteria,
    constraints: activeGoal.constraints,
    priority: activeGoal.priority,
    assignment: activeGoal.assignment,
    relation: activeGoal.relation,
    capturedAt: at
  },
  runnerSnapshot: playerSnapshot,
  checkpoints: [],
  evidenceIds: [],
  startedAt: at
};

const runningRun: RunningRun = { ...runBase, status: "running" };

// @ts-expect-error Running Runs cannot expose a result SHA.
const runningRunWithResult: Run = { ...runningRun, resultSha: baseSha };

// @ts-expect-error Completed Runs require a verified result and terminal timestamps.
const completedRunWithoutResult: CompletedRun = { ...runBase, status: "completed" };

const unsupportedRunner: Runner = {
  // @ts-expect-error Runner is exactly Team or Player.
  kind: "service",
  id: playerId,
  projectId
};

void rawProjectId;
void completedGoalWithoutSelection;
void runningRunWithResult;
void completedRunWithoutResult;
void unsupportedRunner;
