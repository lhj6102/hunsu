import type {
  AcceptanceCriterion,
  CompletedRun,
  DesiredOutcome,
  GitBranchName,
  GitCommitSha,
  GoalDigest,
  GoalKey,
  GoalTitle,
  IsoTimestamp,
  Node,
  NodePlan,
  NonEmptyText,
  NonNegativeInteger,
  ProjectCommand,
  ProjectId,
  Run,
  RunId,
  RunnerDigest,
  RunnerSchemaVersion,
  RunnerTypeIntegrity,
  RunnerTypeKey,
  RunnerTypeOrigin,
  RunnerValue,
  RunningRun
} from "../packages/protocol/src/index.ts";

const projectId = "project_alpha" as ProjectId;
const runId = "run_alpha" as RunId;
const at = "2026-07-14T00:00:00.000Z" as IsoTimestamp;
const sourceSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as GitCommitSha;
const resultSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as GitCommitSha;
const branch = "hunsu/run/project_alpha/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/run_alpha" as GitBranchName;
const goalDigest = `hunsu-goal-v1:sha256:${"1".repeat(64)}` as GoalDigest;
const runnerDigest = `hunsu-runner-v1:sha256:${"2".repeat(64)}` as RunnerDigest;

// @ts-expect-error Project identifiers must be smart-constructed or explicitly decoded.
const rawProjectId: ProjectId = "project_alpha";

const runner: RunnerValue = {
  schema: "hunsu.runner-value.v1",
  type: {
    origin: "hunsu" as RunnerTypeOrigin,
    key: "custom/qa-swarm" as RunnerTypeKey,
    schemaVersion: "1.0.0" as RunnerSchemaVersion,
    integrity: `hunsu-runner-type-v1:sha256:${"3".repeat(64)}` as RunnerTypeIntegrity
  },
  name: "QA swarm" as NonEmptyText,
  value: { workers: 3, mode: "coordinated" }
};

const plan: NodePlan = {
  schema: "hunsu.node-plan.v1",
  nextGoals: [{
    key: "goal_alpha" as GoalKey,
    title: "Ship the vertical slice" as GoalTitle,
    desiredOutcome: "A verified result is visible." as DesiredOutcome,
    acceptanceCriteria: ["The result commit is verified." as AcceptanceCriterion],
    constraints: [],
    priority: 1 as NonNegativeInteger
  }],
  how: runner
};

const runBase = {
  id: runId,
  projectId,
  sourceNodeSha: sourceSha,
  goal: plan.nextGoals[0]!,
  goalDigest,
  runner,
  runnerDigest,
  branch,
  checkpoints: [],
  evidenceIds: [],
  startedAt: at
};

const runningRun: RunningRun = { ...runBase, status: "running" };

// @ts-expect-error Running Runs cannot expose a result Node SHA.
const runningRunWithResult: Run = { ...runningRun, resultNodeSha: resultSha };

// @ts-expect-error Completed Runs require all verified terminal fields.
const completedRunWithoutResult: CompletedRun = { ...runBase, status: "completed" };

// @ts-expect-error Root Nodes cannot have a structural parent.
const rootWithParent: Node = { type: "root", parentSha: sourceSha };

const runWithRunnerOverride: ProjectCommand = {
  type: "StartRun",
  meta: null as unknown as ProjectCommand["meta"],
  runId,
  projectId,
  sourceNodeSha: sourceSha,
  goalDigest,
  branch,
  // @ts-expect-error StartRun cannot override its source Node Runner.
  runner,
};

void rawProjectId;
void runningRunWithResult;
void completedRunWithoutResult;
void rootWithParent;
void runWithRunnerOverride;
