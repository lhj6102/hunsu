export const figmaComponentNames = {
  moveCard: "RoadmapV3/MoveCard",
  accidentCard: "RoadmapV3/AccidentCard",
  executeOverlay: "RoadmapV3/ExecuteOverlay",
  executingCard: "RoadmapV3/ExecutingCard",
  executeButton: "RoadmapV3/ExecuteButton",
  hunsuCard: "RoadmapV3/HunsuCard",
  inlinePlanScope: "RoadmapV3/InlinePlanScope",
  inlinePathPoint: "RoadmapV3/InlinePathPoint",
  inlinePathEdge: "RoadmapV3/InlinePathEdge",
  foldedMoveConnector: "RoadmapV3/FoldedMoveConnector",
  executeCueConnector: "RoadmapV3/ExecuteCueConnector",
  hunsuForkConnector: "RoadmapV3/HunsuForkConnector",
  pathPointTooltip: "RoadmapV3/PathPointTooltip",
  nodeDetailPanel: "HunsuStudio/NodeDetailPanel",
  agentChat: "HunsuStudio/AgentChat",
  teamLegendFooter: "HunsuStudio/TeamLegendFooter",
  storyCheckpointDock: "HunsuStudio/StoryCheckpointDock",
  executionPlanPlan: "HunsuStudio/ExecutionPlanPlan",
  pathCommitMapProgress: "HunsuStudio/PathCommitMapProgress"
} as const;

export type FigmaTeamTone = "T1" | "Gen.G" | "Hanwha Life Esports" | "G2 Esports";
export type HunsuMoveProgress = "Waiting" | "Executing" | "Arrived" | "Accident";
export type HunsuPathPointProgress = "Waiting" | "Running" | "Done" | "Failed";
export type FigmaInlinePathPointProgress = "Waiting" | "Running" | "Done";
export type FigmaInlinePathEdgeState = "Pending" | "Complete";
export type FigmaInlinePathEdgeDirection = "Level" | "Up" | "Down";
export type NodeDetailPanelState = "Move" | "Executing" | "HunsuDraft" | "Path";

export const hunsuMoveProgressOptions = ["Waiting", "Executing", "Arrived", "Accident"] as const satisfies readonly HunsuMoveProgress[];
export const hunsuPathPointProgressOptions = ["Waiting", "Running", "Done", "Failed"] as const satisfies readonly HunsuPathPointProgress[];
export const inlinePathPointProgressOptions = ["Waiting", "Running", "Done"] as const satisfies readonly FigmaInlinePathPointProgress[];
export const inlinePathEdgeStateOptions = ["Pending", "Complete"] as const satisfies readonly FigmaInlinePathEdgeState[];
export const inlinePathEdgeDirectionOptions = ["Level", "Up", "Down"] as const satisfies readonly FigmaInlinePathEdgeDirection[];
export const nodeDetailPanelStateOptions = ["Move", "Executing", "HunsuDraft", "Path"] as const satisfies readonly NodeDetailPanelState[];
