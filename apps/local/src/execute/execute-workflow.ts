import { err, makePositiveInteger, ok, type BoardProjection, type Destination, type LineRecord, type NodeRecord, type PositiveInteger } from "@hunsu/protocol";
import {
  executeError,
  type ExecuteRunStatus,
  type ExecuteLoopDecision,
  type ExecuteStepResult
} from "./execute-model.ts";

export type ExecuteStartExistingRun = {
  sourceNodeId?: string;
  status: ExecuteRunStatus;
};

export type ExecuteStartPlanInput = {
  board: BoardProjection;
  line: LineRecord;
  lineNode: NodeRecord | undefined;
  existingRuns: readonly ExecuteStartExistingRun[];
  activeDestinations: readonly Destination[];
  selectedDestinationIds?: readonly string[];
  formatMovePosition?: (node: NodeRecord) => string;
};

export type ExecuteStartPlan = {
  lineNode: NodeRecord;
  selectedDestinationIds: string[];
  targetMoveOrdinal: PositiveInteger;
};

export function planExecuteStart(input: ExecuteStartPlanInput): ExecuteStepResult<ExecuteStartPlan> {
  const { line, lineNode } = input;
  if (!lineNode) {
    return err(executeError("invalid_start_state", `No execute-ready MOVE found for Team route ${line.id}`));
  }
  if (line.status === "failed" || line.status === "complete" || line.status === "abandoned") {
    return err(executeError("invalid_start_state", `Cannot start Execute from ${line.id} because the route is ${line.status}`));
  }
  const nodesWithNextMove = new Set(input.board.edges.filter(edge => edge.type === "move").map(edge => edge.fromNodeId));
  if (nodesWithNextMove.has(lineNode.id)) {
    return err(executeError(
      "invalid_start_state",
      `Cannot start Execute from ${formatMovePosition(lineNode, input.formatMovePosition)} because Arrived or Accident already exists`
    ));
  }
  const activeRun = input.existingRuns.find(existing =>
    existing.sourceNodeId === lineNode.id && (existing.status === "running" || existing.status === "paused")
  );
  if (activeRun) {
    return err(executeError(
      "active_execute_exists",
      `A Execute is already active for ${formatMovePosition(lineNode, input.formatMovePosition)}`
    ));
  }
  const targetMoveOrdinal = makePositiveInteger(lineNode.ordinal + 1, "targetMoveOrdinal");
  if (!targetMoveOrdinal.ok) {
    return err(executeError("invalid_start_state", targetMoveOrdinal.error.message));
  }
  const selectedDestinationIds = normalizeSelectedDestinationIds(input.selectedDestinationIds, input.activeDestinations);
  if (!selectedDestinationIds.ok) {
    return selectedDestinationIds;
  }
  return ok({
    lineNode,
    selectedDestinationIds: selectedDestinationIds.value,
    targetMoveOrdinal: targetMoveOrdinal.value
  });
}

export function ensureTerminalOutput(finalResponse: string | undefined): ExecuteStepResult<string> {
  if (!finalResponse) {
    return err(executeError("terminal_output_missing", "ExecutionPlan completed without a terminal output"));
  }
  return ok(finalResponse);
}

export function planMaxAttemptsExceeded(input: {
  maxAttemptCount: PositiveInteger;
}): Extract<ExecuteLoopDecision, { type: "record_accident" }> {
  return {
    type: "record_accident",
    reason: executeError(
      "max_attempts_exhausted",
      `Execute exceeded max attempt count ${input.maxAttemptCount} without recording an Arrived MOVE`,
      { maxAttemptCount: input.maxAttemptCount }
    )
  };
}

function normalizeSelectedDestinationIds(
  selectedDestinationIds: readonly string[] | undefined,
  activeDestinations: readonly Destination[]
): ExecuteStepResult<string[]> {
  const nextDestination = nextQueuedDestination(activeDestinations);
  if (selectedDestinationIds && selectedDestinationIds.length > 0) {
    if (selectedDestinationIds.length !== 1) {
      return err(executeError("invalid_start_state", "Execute must select exactly one Destination"));
    }
    return nextDestination && selectedDestinationIds[0] === nextDestination.id
      ? ok([...selectedDestinationIds])
      : err(executeError("invalid_start_state", "Execute must select the next Destination in the queue"));
  }
  return ok(nextDestination ? [nextDestination.id] : []);
}

function nextQueuedDestination(activeDestinations: readonly Destination[]): Destination | undefined {
  return [...activeDestinations].sort(destinationQueueSort)[0];
}

function destinationQueueSort(left: Destination, right: Destination): number {
  return (right.priority ?? 0) - (left.priority ?? 0);
}

function formatMovePosition(node: NodeRecord, formatter: ((node: NodeRecord) => string) | undefined): string {
  return formatter ? formatter(node) : `${node.teamName ?? "Team"} MOVE ${node.ordinal}`;
}
