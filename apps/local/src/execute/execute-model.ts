import type { CommitSha } from "@hunsu/core";
import type { ExecutionPlan, PathId, PositiveInteger, Result, MemberPath } from "@hunsu/protocol";

export type ExecuteOrchestrationErrorCode =
  | "invalid_start_state"
  | "active_execute_exists"
  | "team_output_invalid"
  | "execution_plan_invalid"
  | "goal_evaluation_invalid"
  | "path_dependency_unmet"
  | "terminal_output_missing"
  | "max_attempts_exhausted"
  | "side_effect_failed";

export type ExecuteOrchestrationError = {
  code: ExecuteOrchestrationErrorCode;
  message: string;
  details?: unknown;
};

export type ExecuteStepResult<T> = Result<T, ExecuteOrchestrationError>;

export type ExecutionPlanStepResult =
  | { type: "done"; terminalPath?: MemberPath; finalResponse?: string }
  | { type: "next"; execution: ExecutionPlan; terminalPath?: MemberPath; finalResponse?: string }
  | { type: "fail"; reason: ExecuteOrchestrationError; terminalPath?: MemberPath; finalResponse?: string };

export type ExecuteRunStatus = "running" | "paused" | "arrived" | "accident" | "failed" | "discarded" | "finished" | "stopped";

export type PathRunPlan = {
  path: MemberPath;
  dependencyPathIds: PathId[];
  dependencyOutputs: string[];
  isTerminal: boolean;
};

export type PathRunOutcome = {
  pathId: PathId;
  finalResponse: string;
  commit: CommitSha;
  parentCommit?: CommitSha;
  treeChanged: boolean;
};

export type ExecuteLoopDecision =
  | { type: "run_team_planning" }
  | { type: "run_member_path"; path: PathRunPlan }
  | { type: "record_accident"; reason: ExecuteOrchestrationError };

export function executeError(
  code: ExecuteOrchestrationErrorCode,
  message: string,
  details?: unknown
): ExecuteOrchestrationError {
  return details === undefined ? { code, message } : { code, message, details };
}

export function executeErrorToError(error: ExecuteOrchestrationError): Error {
  const wrapped = new Error(error.message);
  wrapped.name = `ExecuteOrchestrationError:${error.code}`;
  if (error.details !== undefined) {
    (wrapped as Error & { details?: unknown }).details = error.details;
  }
  return wrapped;
}

export function unwrapExecuteResult<T>(result: ExecuteStepResult<T>): T {
  if (result.ok) {
    return result.value;
  }
  throw executeErrorToError(result.error);
}
