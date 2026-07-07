import {
  err,
  makeNonEmptyText,
  makeNonNegativeInteger,
  ok,
  type GoalEvaluation,
  type GoalExecutionPlan,
  type ExecutionContinuation,
  type PathId,
  type ExecutionPlan,
  type ExecutorId,
  type MemberPath,
  type QueueExecutionPlan
} from "@hunsu/protocol";
import { executeError, type ExecuteStepResult } from "./execute-model.ts";

export function parseExecutionPlan(finalResponse: string): ExecuteStepResult<ExecutionPlan> {
  const parsed = parseJsonObject(finalResponse, "Team planning final response must be a JSON ExecutionPlan object");
  if (!parsed.ok) {
    return parsed;
  }
  return decodeExecutionPlan(parsed.value, "execution");
}

export function parseGoalEvaluation(finalResponse: string): ExecuteStepResult<GoalEvaluation> {
  const parsed = parseJsonObject(finalResponse, "Goal evaluator final response must be a JSON object");
  if (!parsed.ok) {
    return parsed;
  }
  const record = parsed.value;
  if (record.type === "pass") {
    if (typeof record.summary !== "string" || record.summary.trim() === "") {
      return err(executeError("goal_evaluation_invalid", "pass evaluation must include a non-empty summary"));
    }
    const evidence = decodeOptionalStringArray(record.evidence, "evidence");
    if (!evidence.ok) {
      return evidence;
    }
    return ok({
      type: "pass",
      summary: record.summary,
      evidence: evidence.value
    });
  }
  if (record.type === "fail") {
    if (typeof record.reason !== "string" || record.reason.trim() === "") {
      return err(executeError("goal_evaluation_invalid", "fail evaluation must include a non-empty reason"));
    }
    if (typeof record.feedback !== "string" || record.feedback.trim() === "") {
      return err(executeError("goal_evaluation_invalid", "fail evaluation must include non-empty feedback"));
    }
    if (record.nextGoal !== undefined && typeof record.nextGoal !== "string") {
      return err(executeError("goal_evaluation_invalid", "fail evaluation nextGoal must be a string when present"));
    }
    const evidence = decodeOptionalStringArray(record.evidence, "evidence");
    if (!evidence.ok) {
      return evidence;
    }
    return ok({
      type: "fail",
      reason: record.reason,
      feedback: record.feedback,
      nextGoal: typeof record.nextGoal === "string" && record.nextGoal.trim() !== "" ? record.nextGoal : undefined,
      evidence: evidence.value
    });
  }
  return err(executeError("goal_evaluation_invalid", "Goal evaluator response type must be pass or fail"));
}

export function memberPathForGoalRole(
  execution: GoalExecutionPlan,
  role: "assignee" | "evaluator",
  pathId: string,
  requires: MemberPath["requires"]
): MemberPath {
  if (role === "assignee") {
    return {
      id: pathId,
      executorId: execution.assignee.executorId,
      goal: execution.assignee.goal,
      requires
    } as MemberPath;
  }
  const roleConfig = execution.evaluator;
  if (!roleConfig) {
    throw new Error(`Goal ${execution.id} does not define an evaluator`);
  }
  return {
    id: pathId,
    executorId: roleConfig.executorId,
    goal: roleConfig.prompt,
    requires
  } as MemberPath;
}

export function nextQueueExecution(queue: QueueExecutionPlan, headResult: ExecutionPlan | undefined): ExecutionPlan | undefined {
  const [, ...tail] = queue.items;
  if (headResult) {
    return { ...queue, items: [headResult, ...tail] };
  }
  if (tail.length === 0) {
    return undefined;
  }
  return { ...queue, items: tail };
}

function decodeExecutionPlan(value: unknown, path: string): ExecuteStepResult<ExecutionPlan> {
  if (!isRecord(value)) {
    return err(executeError("execution_plan_invalid", `${path} must be an object`));
  }
  if (value.kind === "queue") {
    return decodeQueueExecutionPlan(value, path);
  }
  if (value.kind === "goal") {
    return decodeGoalExecutionPlan(value, path);
  }
  if (value.kind === "continuation") {
    return decodeExecutionContinuation(value, path);
  }
  return err(executeError("execution_plan_invalid", `${path}.kind must be queue, goal, or continuation`));
}

function decodeQueueExecutionPlan(record: Record<string, unknown>, path: string): ExecuteStepResult<QueueExecutionPlan> {
  const id = decodeNonEmptyString(record.id, `${path}.id`);
  if (!id.ok) {
    return id;
  }
  if (!Array.isArray(record.items)) {
    return err(executeError("execution_plan_invalid", `${path}.items must be an array`));
  }
  const items: ExecutionPlan[] = [];
  for (const [index, item] of record.items.entries()) {
    const decoded = decodeExecutionPlan(item, `${path}.items[${index}]`);
    if (!decoded.ok) {
      return decoded;
    }
    items.push(decoded.value);
  }
  return ok({ kind: "queue", id: id.value, items } as QueueExecutionPlan);
}

function decodeGoalExecutionPlan(record: Record<string, unknown>, path: string): ExecuteStepResult<GoalExecutionPlan> {
  if (record.stage === "needs_evaluation") {
    return decodeGoalPathEvaluationStage(record, path);
  }
  if (record.stage === "needs_execution") {
    return decodeGoalExecutionPlanStage(record, path);
  }
  return err(executeError("execution_plan_invalid", `${path}.stage must be needs_evaluation or needs_execution`));
}

function decodeExecutionContinuation(record: Record<string, unknown>, path: string): ExecuteStepResult<ExecutionContinuation> {
  const id = decodePathId(record.id, `${path}.id`);
  if (!id.ok) {
    return id;
  }
  const teamScopeId = decodeMemberId(record.teamScopeId, `${path}.teamScopeId`);
  if (!teamScopeId.ok) {
    return teamScopeId;
  }
  const execution = decodeExecutionPlan(record.execution, `${path}.execution`);
  if (!execution.ok) {
    return execution;
  }
  const continuation = record.continuation === undefined
    ? ok(undefined)
    : isRecord(record.continuation)
      ? decodeGoalExecutionPlan(record.continuation, `${path}.continuation`)
      : err(executeError("execution_plan_invalid", `${path}.continuation must be an object`));
  if (!continuation.ok) {
    return continuation;
  }
  return ok({
    kind: "continuation",
    id: id.value,
    teamScopeId: teamScopeId.value,
    execution: execution.value,
    continuation: continuation.value
  });
}

function decodeGoalPathEvaluationStage(record: Record<string, unknown>, path: string): ExecuteStepResult<GoalExecutionPlan> {
  const id = decodePathId(record.id, `${path}.id`);
  if (!id.ok) {
    return id;
  }
  const assignee = decodeGoalRole(record.assignee, `${path}.assignee`, "goal");
  if (!assignee.ok) {
    return assignee;
  }
  const evaluator = record.evaluator === undefined || record.evaluator === null ? ok(undefined) : decodeGoalRole(record.evaluator, `${path}.evaluator`, "prompt");
  if (!evaluator.ok) {
    return evaluator;
  }
  const remainingAttempts = makeNonNegativeInteger(record.remainingAttempts, `${path}.remainingAttempts`);
  if (!remainingAttempts.ok) {
    return err(executeError("execution_plan_invalid", remainingAttempts.error.message));
  }
  const requires = decodePathRequires(record.requires, `${path}.requires`);
  if (!requires.ok) {
    return requires;
  }
  return ok({
    kind: "goal",
    stage: "needs_evaluation",
    id: id.value,
    assignee: {
      executorId: assignee.value.executorId,
      goal: assignee.value.text
    },
    evaluator: evaluator.value
      ? {
          executorId: evaluator.value.executorId,
          prompt: evaluator.value.text
        }
      : undefined,
    remainingAttempts: remainingAttempts.value,
    requires: requires.value
  } as GoalExecutionPlan);
}

function decodeGoalExecutionPlanStage(record: Record<string, unknown>, path: string): ExecuteStepResult<GoalExecutionPlan> {
  const decoded = decodeGoalPathEvaluationStage({ ...record, stage: "needs_evaluation" }, path);
  if (!decoded.ok) {
    return decoded;
  }
  const evaluationPathId = decodePathId(record.evaluationPathId, `${path}.evaluationPathId`);
  if (!evaluationPathId.ok) {
    return evaluationPathId;
  }
  const evaluation = decodeFailGoalEvaluation(record.evaluation, `${path}.evaluation`);
  if (!evaluation.ok) {
    return evaluation;
  }
  if (!Array.isArray(record.requires)) {
    return err(executeError("execution_plan_invalid", `${path}.requires must be an array for needs_execution`));
  }
  const requires = decodePathIdArray(record.requires, `${path}.requires`);
  if (!requires.ok) {
    return requires;
  }
  if (requires.value.length !== 1 || requires.value[0] !== evaluationPathId.value) {
    return err(executeError("execution_plan_invalid", `${path}.requires must contain only ${path}.evaluationPathId`));
  }
  return ok({
    ...decoded.value,
    stage: "needs_execution",
    evaluationPathId: evaluationPathId.value,
    evaluation: evaluation.value,
    requires: requires.value
  } as GoalExecutionPlan);
}

function decodeGoalRole(value: unknown, path: string, textField: "goal" | "prompt"): ExecuteStepResult<{ executorId: ExecutorId; text: string }> {
  if (!isRecord(value)) {
    return err(executeError("execution_plan_invalid", `${path} must be an object`));
  }
  const executorId = decodeMemberId(value.executorId, `${path}.executorId`);
  if (!executorId.ok) {
    return executorId;
  }
  const text = decodeNonEmptyString(value[textField], `${path}.${textField}`);
  if (!text.ok) {
    return text;
  }
  return ok({ executorId: executorId.value, text: text.value });
}

function decodeFailGoalEvaluation(value: unknown, path: string): ExecuteStepResult<Extract<GoalEvaluation, { type: "fail" }>> {
  if (!isRecord(value)) {
    return err(executeError("execution_plan_invalid", `${path} must be an object`));
  }
  if (value.type !== "fail") {
    return err(executeError("execution_plan_invalid", `${path}.type must be fail`));
  }
  if (typeof value.reason !== "string" || value.reason.trim() === "") {
    return err(executeError("execution_plan_invalid", `${path}.reason must be a non-empty string`));
  }
  if (typeof value.feedback !== "string" || value.feedback.trim() === "") {
    return err(executeError("execution_plan_invalid", `${path}.feedback must be a non-empty string`));
  }
  if (value.nextGoal !== undefined && typeof value.nextGoal !== "string") {
    return err(executeError("execution_plan_invalid", `${path}.nextGoal must be a string when present`));
  }
  const evidence = decodeOptionalStringArray(value.evidence, `${path}.evidence`);
  if (!evidence.ok) {
    return evidence;
  }
  return ok({
    type: "fail",
    reason: value.reason,
    feedback: value.feedback,
    nextGoal: typeof value.nextGoal === "string" && value.nextGoal.trim() !== "" ? value.nextGoal : undefined,
    evidence: evidence.value
  });
}

function decodeNonEmptyString(value: unknown, path: string): ExecuteStepResult<string> {
  if (typeof value !== "string" || value.trim() === "") {
    return err(executeError("execution_plan_invalid", `${path} must be a non-empty string`));
  }
  return ok(value);
}

function decodePathId(value: unknown, path: string): ExecuteStepResult<PathId> {
  const decoded = makeNonEmptyText(value, path);
  if (!decoded.ok) {
    return err(executeError("execution_plan_invalid", decoded.error.message));
  }
  return ok(decoded.value);
}

function decodeMemberId(value: unknown, path: string): ExecuteStepResult<ExecutorId> {
  const decoded = makeNonEmptyText(value, path);
  if (!decoded.ok) {
    return err(executeError("execution_plan_invalid", decoded.error.message));
  }
  return ok(decoded.value);
}

function decodePathRequires(value: unknown, path: string): ExecuteStepResult<MemberPath["requires"]> {
  if (value === "PrevMove") {
    return ok("PrevMove");
  }
  return decodePathIdArray(value, path);
}

function decodePathIdArray(value: unknown, path: string): ExecuteStepResult<PathId[]> {
  const decoded = decodeStringArray(value, path, "execution_plan_invalid");
  if (!decoded.ok) {
    return decoded;
  }
  const pathIds: PathId[] = [];
  for (const [index, item] of decoded.value.entries()) {
    const pathId = makeNonEmptyText(item, `${path}[${index}]`);
    if (!pathId.ok) {
      return err(executeError("execution_plan_invalid", pathId.error.message));
    }
    pathIds.push(pathId.value);
  }
  return ok(pathIds);
}

function decodeOptionalStringArray(value: unknown, path: string): ExecuteStepResult<string[] | undefined> {
  if (value === undefined) {
    return ok(undefined);
  }
  return decodeStringArray(value, path, "goal_evaluation_invalid");
}

function decodeStringArray(value: unknown, path: string, code: "goal_evaluation_invalid" | "execution_plan_invalid"): ExecuteStepResult<string[]> {
  if (!Array.isArray(value)) {
    return err(executeError(code, `${path} must be an array of strings`));
  }
  if (!value.every(item => typeof item === "string")) {
    return err(executeError(code, `${path} must be an array of strings`));
  }
  return ok([...value]);
}

function parseJsonObject(text: string, errorMessage: string): ExecuteStepResult<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!isRecord(parsed)) {
      return err(executeError("execution_plan_invalid", errorMessage));
    }
    return ok(parsed);
  } catch (error) {
    return err(executeError(
      "execution_plan_invalid",
      errorMessage,
      { cause: error instanceof Error ? error.message : String(error) }
    ));
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
