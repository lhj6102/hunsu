import type { BoardEdge, BoardProjection, Destination, HarnessSnapshot, HunsuRecord, LineRecord, MoveRecord, NodeRecord, NonEmptyText, PositiveInteger } from "@hunsu/protocol";
import type { AgentSession, StudioActionRun, StudioArtifactAction, StudioEncodedRuntimeFile, StudioExecutionTransition, StudioHunsuDraftSession, StudioRunState, StudioSkillSummary, WorktreeStatus } from "@/shared/api/bridgeTypes";
import { teamColorForName, teamToneForName, teamToneMap } from "@/shared/design/teamTone";
import type { FigmaTeamTone, HunsuMoveProgress, NodeDetailPanelState } from "@/shared/design/figmaContracts";

const moveCardSize = {
  width: 151.2,
  height: 104.4
} as const;

const graphLayout = {
  x: 56,
  y: 96,
  column: 260,
  row: 190,
  minWidth: 1180,
  minHeight: 696
} as const;

const expandedLaneLayout = {
  planGap: 44,
  planNodeSize: 34,
  planToPathGap: 38,
  pathGap: 118,
  targetAfterPathGap: 126,
  targetNodeGap: 150
} as const;

const hunsuDraftRouteSize = {
  width: expandedLaneLayout.planNodeSize,
  height: expandedLaneLayout.planNodeSize
} as const;

const hunsuDraftRouteLayout = {
  sourceGap: 18,
  targetGap: 34,
  sideOffset: 68
} as const;

type HunsuDraftVirtualTarget = {
  anchor: { x: number; y: number };
  sideOffset: number;
};

export type RoadmapDetailPanel = "move" | "execute" | "path" | "actions" | "hunsu";

export type RoadmapSelection =
  | { kind: "none" }
  | { kind: "move"; nodeId?: string; moveId?: string; teamName?: string; moveOrdinal?: number }
  | { kind: "execute"; executeId: string }
  | { kind: "pathPoint"; executeId: string; pointId: string }
  | { kind: "hunsuDraftRoute"; draftSessionId: string };

export type DestinationViewState = "reached" | "next" | "open" | "blocked";

export type MoveCardDestinationView = {
  id: string;
  title: string;
  state: DestinationViewState;
};

export type MoveCardView = {
  id: string;
  nodeId: string;
  moveId?: string;
  ordinal: number;
  title: string;
  teamName: string;
  teamTone: FigmaTeamTone;
  teamColor: string;
  statusLabel: string;
  summary: string;
  progress: HunsuMoveProgress;
  destinations: MoveCardDestinationView[];
  harnessLabel: string;
  memberLabel: string;
  skillCountLabel: string;
  modelLabel: string;
  remainingDestinationCount: number;
  commit?: string;
  terminalPathCommit?: string;
  pathCommitCount?: number;
  reachedWindowLabel?: string;
  leftWindowLabel?: string;
  snapshotKind?: "InitialMove" | "RecordedMove" | "HunsuCreatedSamePosition";
  hunsuForked: boolean;
};

export type MoveSnapshotDestinationView = {
  id: string;
  title: string;
  status: Destination["status"];
  displayState: DestinationViewState | "closed";
  priority?: number;
  acceptanceCriteria: string[];
  constraints: string[];
  notes?: string;
  queueHead: boolean;
  reachedByThisMove: boolean;
};

export type MoveTeamRuntimeView = {
  harnessLabel: string;
  harnessKind: string;
  budgetLabel: string;
  guardrailLabel: string;
  prompt: string;
};

export type MoveMemberRuntimeView = {
  id: string;
  prompt: string;
  modelLabel: string;
  executionLabel: string;
  approvalLabel: string;
  skills: string[];
};

export type MoveArtifactActionView = {
  id: string;
  title: string;
  kind: StudioArtifactAction["kind"];
  sourceScope: StudioArtifactAction["sourceScope"];
  runnerLabel: string;
  aliases: Array<{ alias: string; url?: string; service?: string; target?: string }>;
  latestRun?: {
    runId: string;
    status: StudioActionRun["status"];
    commit?: string;
    exitCode?: number;
    updatedAt: string;
    error?: string;
  };
};

export type GraphNodeView = {
  id: string;
  x: number;
  y: number;
  card: MoveCardView;
  node: NodeRecord;
  move?: MoveRecord;
  active: boolean;
  executing: boolean;
  playable: boolean;
  hasNextMove: boolean;
};

export type GraphEdgeView = {
  id: string;
  type: BoardEdge["type"];
  fromNodeId: string;
  toNodeId: string;
  from: { x: number; y: number };
  to: { x: number; y: number };
  color: string;
};

export type ConnectDisplayType = "Fold" | "Expand" | "Executing";

type RoadmapConnectionDisplayBase = {
  displayId: string;
  sourceNodeId: string;
  targetNodeId?: string;
  executeId?: string;
  laneWidth: number;
};

export type RoadmapConnectionDisplay =
  | (RoadmapConnectionDisplayBase & {
      connectDisplayType: "Fold";
      canToggle: boolean;
      toggleIcon: "expand";
    })
  | (RoadmapConnectionDisplayBase & {
      connectDisplayType: "Expand";
      canToggle: boolean;
      toggleIcon: "fold";
    })
  | (RoadmapConnectionDisplayBase & {
      connectDisplayType: "Executing";
      executeId: string;
      canToggle: false;
      toggleIcon?: undefined;
    });

export type RoadmapConnectionView = {
  id: string;
  edgeId: string;
  fromNodeId: string;
  toNodeId?: string;
  from: { x: number; y: number };
  to?: { x: number; y: number };
  color: string;
  display: RoadmapConnectionDisplay;
  togglePosition?: { x: number; y: number };
};

export type InlinePathCssState = "waiting" | "running" | "done" | "failed";
export type InlinePathEdgeProgress = "Waiting" | "Running" | "Done" | "Failed";

export type InlinePathSource = {
  id: string;
  x: number;
  y: number;
};

export type InlinePathRunPath = {
  id: string;
  executorId: string;
  goal: string;
  requires: string[] | "PrevMove";
};

export type InlinePathRunPathState = Omit<InlinePathRunPath, "id"> & {
  id?: string;
  pathId?: string;
  attempt?: number;
  status: "planned" | "starting" | "executing" | "completed" | "failed";
  agentSessionId?: string;
  session?: { providerThreadId: string; providerTurnId: string };
  dependencyPathIds?: string[];
  dependencyOutputs?: string[];
  commit?: string;
  finalResponse?: string;
  error?: string;
  currentExecutionFile?: StudioEncodedRuntimeFile;
  currentExecutionTransition?: StudioExecutionTransition;
};

export type InlinePathRun = {
  runId?: string;
  executeId: string;
  status: StudioRunState["status"];
  targetMoveOrdinal?: number;
  executionPlanPlan?: InlinePathRunPath[];
  memberPathRuns?: InlinePathRunPathState[];
  pathCommits?: Record<string, string>;
  planExecutionTransition?: StudioExecutionTransition;
  agentSessions?: AgentSession[];
  providerTeamThreadId?: string;
  providerTeamPlanningTurnId?: string;
  finalResponse?: string;
  liveStatus?: StudioRunState["liveStatus"];
  codexItems?: StudioRunState["codexItems"];
  assistantTranscript?: StudioRunState["assistantTranscript"];
};

export type InlinePathPoint = {
  id: string;
  kind: "path" | "target";
  pathId?: string;
  executorId?: string;
  goal: string;
  progress: HunsuMoveProgress;
  figmaProgress: "Waiting" | "Running" | "Done";
  cssState: InlinePathCssState;
  commit?: string;
  sessionId?: string;
  x: number;
  y: number;
};

export type InlinePlanScopeView = {
  id: string;
  executeId: string;
  label: "Plan";
  status: "planning" | "planned" | "failed";
  figmaProgress: "Waiting" | "Running" | "Done";
  cssState: InlinePathCssState;
  sessionId?: string;
  planSession?: AgentSessionView;
  isStreaming: boolean;
  x: number;
  y: number;
  width: number;
};

export type InlinePathEdge = {
  id: string;
  fromId: string;
  toId: string;
  from: { x: number; y: number };
  to: { x: number; y: number };
  kind: "path" | "target";
  progress: InlinePathEdgeProgress;
  figmaState: "Pending" | "Complete";
  direction: "Level" | "Up" | "Down";
  cssState: InlinePathCssState;
};

export type InlinePathOverlay = {
  runId: string;
  width: number;
  height: number;
  planScope: InlinePlanScopeView;
  points: InlinePathPoint[];
  edges: InlinePathEdge[];
};

export type InlineExecuteView = {
  id: string;
  run: StudioRunState;
  sourceNodeId: string;
  sourceNode: GraphNodeView;
  teamColor: string;
  display: RoadmapConnectionDisplay;
  overlay: InlinePathOverlay;
};

export type RoadmapActionModel = {
  sourceNodeId?: string;
  canStartExecute: boolean;
  disabledReason?: string;
  requestId?: string;
  lineId?: string;
  destinationIds: string[];
  destinationLabels: string[];
  nextDestination?: Destination;
  teamColor: string;
};

export type PlayableMoveView = {
  id: string;
  nodeId: string;
  node: GraphNodeView;
  x: number;
  y: number;
  teamColor: string;
  action: RoadmapActionModel;
};

export type RouteNodeView =
  | {
      id: string;
      kind: "plan";
      executeId: string;
      sourceNodeId: string;
      x: number;
      y: number;
      width: number;
      height: number;
      label: string;
      status: "waiting" | "running" | "done" | "failed";
      teamColor: string;
      sessionId?: string;
      execute: InlineExecuteView;
      planScope: InlinePlanScopeView;
    }
  | {
      id: string;
      kind: "path";
      executeId: string;
      sourceNodeId: string;
      x: number;
      y: number;
      width: number;
      height: number;
      label: string;
      status: "waiting" | "running" | "done" | "failed";
      teamColor: string;
      sessionId?: string;
      execute: InlineExecuteView;
      point: InlinePathPoint;
    }
  | {
      id: string;
      kind: "hunsuDraft";
      draftSessionId: string;
      sourceNodeId: string;
      x: number;
      y: number;
      width: number;
      height: number;
      label: string;
      status: StudioHunsuDraftSession["status"];
      teamColor: string;
      sessionId?: string;
      draft: StudioHunsuDraftSession;
      sourceNode: GraphNodeView;
      sourceAnchor: { x: number; y: number };
      targetNode?: GraphNodeView;
      targetAnchor?: { x: number; y: number };
    };

export type RoadmapGraphModel = {
  nodes: GraphNodeView[];
  edges: GraphEdgeView[];
  connections: RoadmapConnectionView[];
  inlineExecutes: InlineExecuteView[];
  routeNodes: RouteNodeView[];
  playableMoves: PlayableMoveView[];
  width: number;
  height: number;
  selectedNodeId?: string;
  selectedExecuteId?: string;
  selectedPathPointId?: string;
  selectedPlanScopeId?: string;
  selectedRouteNodeId?: string;
  detailPosition?: { x: number; y: number };
};

export type RoadmapSelectionModel = {
  selection: RoadmapSelection;
  node?: GraphNodeView;
  move?: MoveRecord;
  hunsu?: HunsuRecord;
  execute?: InlineExecuteView;
  planScope?: InlinePlanScopeView;
  point?: InlinePathPoint;
  routeNode?: RouteNodeView;
  hunsuDraft?: StudioHunsuDraftSession;
};

export type AgentSessionView = {
  kind: "teamPlan" | "executionPlan" | "moveFinalizer" | "hunsuDraft";
  label: string;
  sessionId: string;
  session: AgentSession;
  canonical: boolean;
  providerThreadId?: string;
  providerTurnId?: string;
  status: "waiting" | "running" | "done" | "failed";
};

export type ActiveInspectorAgentSession =
  | { kind: "TeamPlan"; sessionId: string; mode: "snapshot" | "stream" }
  | { kind: "ExecutionPlan"; sessionId: string; mode: "snapshot" | "stream" }
  | { kind: "HunsuDraft"; sessionId: string; mode: "snapshot" | "stream" };

export type InspectorModel =
  | {
      kind: "move";
      state: Extract<NodeDetailPanelState, "Move">;
      panel: RoadmapDetailPanel;
      node: GraphNodeView;
      move?: MoveRecord;
      title: string;
      subtitle: string;
      summary: string;
      destinations: MoveCardDestinationView[];
      reachedDestinations: MoveCardDestinationView[];
      remainingDestinations: MoveCardDestinationView[];
      snapshotDestinations: MoveSnapshotDestinationView[];
      achievedSnapshotDestinations: MoveSnapshotDestinationView[];
      remainingSnapshotDestinations: MoveSnapshotDestinationView[];
      teamRuntime: MoveTeamRuntimeView;
      memberRuntime: MoveMemberRuntimeView[];
      artifactActions: MoveArtifactActionView[];
      action: RoadmapActionModel;
    }
  | {
      kind: "execute";
      state: Extract<NodeDetailPanelState, "Executing">;
      run: StudioRunState;
      sourceNode: GraphNodeView;
      targetPoint?: InlinePathPoint;
      pathPoints: InlinePathPoint[];
      planSession?: AgentSessionView;
      planExecutionTransition?: StudioExecutionTransition;
      activeAgentSession?: ActiveInspectorAgentSession;
      action: RoadmapActionModel;
    }
  | {
      kind: "pathPoint";
      state: Extract<NodeDetailPanelState, "Path">;
      run: StudioRunState;
      sourceNode: GraphNodeView;
      point: InlinePathPoint;
      pathRun?: InlinePathRunPathState;
      dependencies: string[];
      planSession?: AgentSessionView;
      executionSession?: AgentSessionView;
      activeAgentSession?: ActiveInspectorAgentSession;
      action: RoadmapActionModel;
    }
  | {
      kind: "hunsuDraftRoute";
      state: Extract<NodeDetailPanelState, "HunsuDraft">;
      route: Extract<RouteNodeView, { kind: "hunsuDraft" }>;
      sourceNode: GraphNodeView;
      draft: StudioHunsuDraftSession;
      draftSession?: AgentSessionView;
      activeAgentSession?: ActiveInspectorAgentSession;
      action: RoadmapActionModel;
    }
  | {
      kind: "hunsu";
      state: Extract<NodeDetailPanelState, "HunsuDraft">;
      node: GraphNodeView;
      hunsu?: HunsuRecord;
      move?: MoveRecord;
      title: string;
      summary: string;
      action: RoadmapActionModel;
    };

export type RoadmapViewModel = {
  roadmapId: string;
  title: string;
  goal: string;
  repositoryPath?: string;
  currentTeam: string;
  currentMoveLabel: string;
  activeRun?: StudioRunState;
  selectedNode?: GraphNodeView;
  selection: RoadmapSelectionModel;
  graph: RoadmapGraphModel;
  inspector?: InspectorModel;
  actions: RoadmapActionModel;
  nodes: GraphNodeView[];
  edges: GraphEdgeView[];
  hunsuCount: number;
  destinationCount: number;
  reachedDestinationCount: number;
  skills: StudioSkillSummary[];
  worktree?: WorktreeStatus;
  artifactActions: StudioArtifactAction[];
  actionRuns: StudioActionRun[];
  hunsuDrafts: StudioHunsuDraftSession[];
};

type GraphNodeLayout = {
  node: NodeRecord;
  x: number;
  y: number;
};

type ConnectionPlan = {
  edgeId: string;
  fromNodeId: string;
  toNodeId?: string;
  display: RoadmapConnectionDisplay;
};

export function buildRoadmapViewModel(input: {
  roadmapId: string;
  board: BoardProjection;
  runs: StudioRunState[];
  agentSessions?: AgentSession[];
  skills: StudioSkillSummary[];
  worktree?: WorktreeStatus;
  artifactActions: StudioArtifactAction[];
  actionRuns: StudioActionRun[];
  hunsuDrafts?: StudioHunsuDraftSession[];
  selectedNodeId?: string;
  selection?: RoadmapSelection;
  panel?: RoadmapDetailPanel;
  expandedConnectionIds?: string[];
}): RoadmapViewModel {
  const request = input.board.requests[0];
  const requestId = request ? String(request.id) : undefined;
  const requestNodes = input.board.nodes.filter(node => !requestId || String(node.requestId) === requestId);
  const nodeIds = new Set(requestNodes.map(node => String(node.id)));
  const boardEdges = input.board.edges.filter(edge => nodeIds.has(String(edge.fromNodeId)) && nodeIds.has(String(edge.toNodeId)));
  const nodesWithNextMove = new Set(boardEdges.filter(edge => edge.type === "move").map(edge => String(edge.fromNodeId)));
  const allAgentSessions = input.agentSessions ?? input.runs.flatMap(run => run.agentSessions ?? []);
  const runs = input.runs.map(run => ({
    ...run,
    agentSessions: agentSessionsForRun(allAgentSessions, run)
  }));
  const liveRuns = [...runs]
    .filter(run => isActiveRunStatus(run.status))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const graphRuns = uniqueGraphRuns([...runs]
    .filter(run => run.sourceNodeId && nodeIds.has(String(run.sourceNodeId)) && hasInlinePathSurface(run))
    .sort(compareGraphRuns));
  const activeRun = liveRuns[0] ?? graphRuns[0] ?? runs[0];
  const activeExecuteSourceNodeIds = new Set(liveRuns.flatMap(run => run.sourceNodeId ? [String(run.sourceNodeId)] : []));
  const activeLine = activeLineForRequest(input.board, requestId);
  const activeNodeId = activeLine ? String(activeLine.currentNodeId) : undefined;
  const moveByToNodeId = new Map(input.board.moves.map(move => [String(move.toNodeId), move]));
  const requestedSelection = input.selection ?? (input.selectedNodeId ? { kind: "move", nodeId: input.selectedNodeId } : undefined);
  const connectionPlans = buildConnectionPlans({
    edges: boardEdges,
    runs: graphRuns,
    selection: requestedSelection,
    expandedConnectionIds: input.expandedConnectionIds ?? []
  });
  const layout = layoutGraphNodes(requestNodes, boardEdges, connectionPlans);

  const graphNodes = layout.map((item): GraphNodeView => {
    const move = moveByToNodeId.get(String(item.node.id));
    const hasNextMove = nodesWithNextMove.has(String(item.node.id));
    const executing = activeExecuteSourceNodeIds.has(String(item.node.id));
    const action = buildActionModel(input.board, runs, item.node, nodesWithNextMove, activeExecuteSourceNodeIds);
    const active = activeNodeId === String(item.node.id);
    return {
      id: String(item.node.id),
      x: item.x,
      y: item.y,
      node: item.node,
      move,
      active,
      executing,
      playable: action.canStartExecute,
      hasNextMove,
      card: buildMoveCard(input.board, item.node, move, activeRun, input.skills, {
        executing,
        playable: action.canStartExecute,
        hasNextMove
      })
    };
  });
  const graphNodeById = new Map(graphNodes.map(node => [node.id, node]));

  const draftSessions = input.hunsuDrafts ?? [];
  const confirmedDraftHunsuIds = new Set(draftSessions.flatMap(draft => draft.confirmedHunsuId ? [draft.confirmedHunsuId] : []));
  const confirmedDraftEdgeKeys = new Set(draftSessions.flatMap(draft =>
    draft.confirmedNodeId ? [`${draft.sourceNodeId}->${draft.confirmedNodeId}`] : []
  ));
  const graphEdges = boardEdges.flatMap(edge => {
    if (edge.type === "move") return [];
    if (edge.type === "hunsu" && (confirmedDraftHunsuIds.has(String(edge.id)) || confirmedDraftEdgeKeys.has(`${String(edge.fromNodeId)}->${String(edge.toNodeId)}`))) return [];
    const from = graphNodeById.get(String(edge.fromNodeId));
    const to = graphNodeById.get(String(edge.toNodeId));
    if (!from || !to) return [];
    return [{
      id: String(edge.id),
      type: edge.type,
      fromNodeId: String(edge.fromNodeId),
      toNodeId: String(edge.toNodeId),
      from: edge.type === "hunsu"
        ? { x: from.x + moveCardSize.width / 2, y: from.y + moveCardSize.height }
        : { x: from.x + moveCardSize.width, y: from.y + moveCardSize.height / 2 },
      to: edge.type === "hunsu"
        ? { x: to.x + moveCardSize.width / 2, y: to.y }
        : { x: to.x, y: to.y + moveCardSize.height / 2 },
      color: to.card.teamColor
    }];
  });

  const connections = boardEdges.flatMap((edge): RoadmapConnectionView[] => {
    if (edge.type !== "move") return [];
    const from = graphNodeById.get(String(edge.fromNodeId));
    const to = graphNodeById.get(String(edge.toNodeId));
    if (!from) return [];
    const plan = connectionPlans.get(String(edge.id)) ?? defaultConnectionPlan(edge);
    return [{
      id: plan.display.displayId,
      edgeId: String(edge.id),
      fromNodeId: from.id,
      toNodeId: to?.id,
      from: { x: from.x + moveCardSize.width, y: from.y + moveCardSize.height / 2 },
      to: to ? { x: to.x, y: to.y + moveCardSize.height / 2 } : undefined,
      color: to?.card.teamColor ?? from.card.teamColor,
      display: {
        ...plan.display,
        sourceNodeId: from.id,
        targetNodeId: to?.id
      },
      togglePosition: to && plan.display.canToggle
        ? togglePositionForConnection(plan.display, from, to)
        : undefined
    }];
  });

  const connectionByExecuteId = new Map(connections.flatMap(connection => connection.display.executeId ? [[connection.display.executeId, connection]] : []));

  const inlineExecutes = graphRuns.flatMap((run): InlineExecuteView[] => {
    const sourceNode = run.sourceNodeId ? graphNodeById.get(String(run.sourceNodeId)) : undefined;
    if (!sourceNode) return [];
    const connection = connectionByExecuteId.get(run.executeId);
    const display = connection?.display ?? executingDisplayForRun(run, sourceNode.id);
    if (display.connectDisplayType === "Fold") return [];
    const targetNode = display.targetNodeId ? graphNodeById.get(display.targetNodeId) : undefined;
    return [{
      id: run.executeId,
      run,
      sourceNodeId: sourceNode.id,
      sourceNode,
      teamColor: sourceNode.card.teamColor,
      display,
      overlay: buildInlinePathOverlay(run, { id: sourceNode.id, x: sourceNode.x, y: sourceNode.y }, {
        sourceWidth: moveCardSize.width,
        sourceCenterY: moveCardSize.height / 2,
        targetNode: targetNode ? { id: targetNode.id, x: targetNode.x, y: targetNode.y } : undefined
      })
    }];
  });
  const routeNodes = [
    ...inlineExecutes.flatMap(execute => routeNodesForInlineExecute(execute)),
    ...hunsuDraftRouteNodes(draftSessions, graphNodeById, graphNodes)
  ];

  const selection = resolveSelection({
    requested: requestedSelection,
    graphNodes,
    inlineExecutes,
    routeNodes,
    board: input.board,
    activeNodeId
  });
  const selectedNode = selection.node ?? graphNodeById.get(activeNodeId ?? "") ?? graphNodes.at(-1) ?? graphNodes[0];
  const selectedAction = buildActionModel(input.board, runs, selectedNode?.node, nodesWithNextMove, activeExecuteSourceNodeIds);
  const inspector = buildInspector(input.board, selection, selectedAction, input.panel ?? panelForSelection(selection.selection), allAgentSessions, input.actionRuns);
  const detailPosition = inspector ? detailPanelPosition(selection) : undefined;
  const playableMoves = graphNodes.flatMap(node => {
    const action = buildActionModel(input.board, runs, node.node, nodesWithNextMove, activeExecuteSourceNodeIds);
    return action.canStartExecute ? [{
      id: `execute-launch-${node.id}`,
      nodeId: node.id,
      node,
      x: node.x + moveCardSize.width + 18,
      y: node.y + moveCardSize.height / 2 - 19,
      teamColor: node.card.teamColor,
      action
    }] : [];
  });
  const graphWidth = Math.max(
    graphLayout.minWidth,
    ...graphNodes.map(node => node.x + moveCardSize.width + 120),
    ...connections.flatMap(connection => connection.to ? [connection.to.x + 120] : []),
    ...playableMoves.map(item => item.x + 230),
    ...routeNodes.map(item => item.x + item.width + 120),
    ...inlineExecutes.map(item => item.overlay.width + 64),
    detailPosition ? detailPosition.x + 560 : 0
  );
  const graphHeight = Math.max(
    graphLayout.minHeight,
    ...graphNodes.map(node => node.y + moveCardSize.height + 140),
    ...playableMoves.map(item => item.y + 72),
    ...routeNodes.map(item => item.y + item.height + 120),
    ...routeNodes.flatMap(item => item.kind === "hunsuDraft" && item.targetAnchor ? [item.targetAnchor.y + 120] : []),
    ...inlineExecutes.map(item => item.overlay.height + 120),
    detailPosition ? detailPosition.y + 620 : 0
  );
  const currentTeam = selectedNode?.card.teamName ?? "No Team";

  return {
    roadmapId: input.roadmapId,
    title: String(request?.title ?? "Untitled Roadmap"),
    goal: String(request?.goal ?? "No goal has been recorded yet."),
    repositoryPath: input.worktree?.root,
    currentTeam: activeLine?.teamName ? String(activeLine.teamName) : currentTeam,
    currentMoveLabel: selectedNode ? `MOVE ${selectedNode.card.ordinal}` : "No MOVE",
    activeRun,
    selectedNode,
    selection,
    graph: {
      nodes: graphNodes,
      edges: graphEdges,
      connections,
      inlineExecutes,
      routeNodes,
      playableMoves,
      width: graphWidth,
      height: graphHeight,
      selectedNodeId: selection.node?.id,
      selectedExecuteId: selection.execute?.id,
      selectedPathPointId: selection.selection.kind === "pathPoint" ? selection.point?.id : undefined,
      selectedPlanScopeId: selection.selection.kind === "execute" ? selection.execute?.overlay.planScope.id : undefined,
      selectedRouteNodeId: selection.routeNode?.id,
      detailPosition
    },
    inspector,
    actions: selectedAction,
    nodes: graphNodes,
    edges: graphEdges,
    hunsuCount: input.board.hunsus.length,
    destinationCount: input.board.destinations.length,
    reachedDestinationCount: input.board.destinations.filter(destination => destination.status === "reached").length,
    skills: input.skills,
    worktree: input.worktree,
    artifactActions: input.artifactActions,
    actionRuns: input.actionRuns,
    hunsuDrafts: input.hunsuDrafts ?? []
  };
}

export function buildInlinePathOverlay(run: InlinePathRun, source: InlinePathSource, options: { sourceWidth?: number; sourceCenterY?: number; targetNode?: { id: string; x: number; y: number }; targetNodeX?: number } = {}): InlinePathOverlay {
  const sourceWidth = options.sourceWidth ?? moveCardSize.width;
  const sourceCenterY = options.sourceCenterY ?? moveCardSize.height / 2;
  const paths = pathsForRun(run);
  const points: InlinePathPoint[] = [];
  const startY = source.y + sourceCenterY;
  const planSession = teamPlanSessionForRun(run);
  const planStatus = planNodeStatusForRun(run, planSession);
  const targetNode = options.targetNode;
  const targetNodeX = targetNode?.x ?? options.targetNodeX;
  const connectsToRecordedMove = Boolean(targetNode && !isActiveRunStatus(run.status));
  const compactCompletedPlan = connectsToRecordedMove && planStatus === "done";
  const planScopeX = source.x + sourceWidth + expandedLaneLayout.planGap;
  const startX = planScopeX + expandedLaneLayout.planNodeSize + expandedLaneLayout.planToPathGap;

  paths.forEach((path, index) => {
    const executionSession = executionPlanSessionForRun(run, path);
    const cssState = cssStateForPath(path.status, executionSession);
    points.push({
      id: `${run.executeId}:${pathKey(path)}`,
      kind: "path",
      pathId: pathKey(path),
      executorId: path.executorId,
      goal: path.goal,
      progress: pathProgressForState(cssState),
      figmaProgress: figmaProgressForState(cssState),
	      cssState,
	      commit: path.commit ?? (path.pathId ? run.pathCommits?.[path.pathId] : undefined),
	      sessionId: path.agentSessionId ?? executionSession?.sessionId,
	      x: startX + index * 118,
      y: startY + pathLaneOffset(index, compactCompletedPlan)
    });
  });

  const terminal = points.at(-1);
  const pathTargetX = terminal ? terminal.x + expandedLaneLayout.targetAfterPathGap : startX + 220;
  const targetX = targetNodeX ? Math.max(pathTargetX, targetNodeX - expandedLaneLayout.targetNodeGap) : pathTargetX;
  if (!connectsToRecordedMove) {
    points.push({
      id: `${run.executeId}:target`,
      kind: "target",
      goal: `MOVE ${run.targetMoveOrdinal ?? "next"}`,
      progress: run.status === "accident" || run.status === "failed" ? "Accident" : "Waiting",
      figmaProgress: "Waiting",
      cssState: run.status === "accident" || run.status === "failed" ? "failed" : "waiting",
      x: targetX,
      y: startY + 6
    });
  }

  const planScopeY = startY - expandedLaneLayout.planNodeSize / 2;
  const targetEndpointX = connectsToRecordedMove && targetNode ? targetNode.x : targetX + 72;
  const planScope: InlinePlanScopeView = {
    id: `${run.executeId}:plan-scope`,
    executeId: run.executeId,
    label: "Plan",
	    status: planStatus === "failed" ? "failed" : planStatus === "done" ? "planned" : "planning",
	    figmaProgress: planStatus === "running" ? "Running" : planStatus === "done" ? "Done" : "Waiting",
	    cssState: cssStateForPlanStatus(planStatus),
	    sessionId: planSession?.sessionId,
    planSession,
    isStreaming: planStatus === "running",
    x: planScopeX,
    y: planScopeY,
    width: expandedLaneLayout.planNodeSize
  };

  const edges: InlinePathEdge[] = [];
  const sourceCenter = { x: source.x + sourceWidth, y: source.y + sourceCenterY };
  edges.push(edgeFromSourceToPlan(run.executeId, source.id, planScope, sourceCenter));
  const first = points[0];
  if (first) {
    edges.push(edgeFromPlanToPoint(run.executeId, planScope, first));
  }
  for (let index = 0; index < points.length - 1; index += 1) {
    edges.push(edgeBetweenPoints(run.executeId, points[index], points[index + 1], points[index + 1].kind));
  }
  if (connectsToRecordedMove && targetNode) {
    const targetCenter = { x: targetNode.x, y: targetNode.y + sourceCenterY };
    const previous = points.at(-1);
    edges.push(previous
      ? edgeFromPointToMove(run.executeId, previous, targetNode.id, targetCenter)
      : edgeFromSourceToMove(run.executeId, source.id, targetNode.id, { x: source.x + sourceWidth, y: source.y + sourceCenterY }, targetCenter)
    );
  }

  return {
    runId: run.executeId,
    width: Math.max(720, planScope.x + planScope.width + 96, targetEndpointX + 80, (points.at(-1)?.x ?? 0) + 80),
    height: Math.max(260, planScope.y + 96, ...points.map(point => point.y + 80)),
    planScope,
    points,
    edges
  };
}

export function formatShortRef(value: string | undefined): string {
  if (!value) return "none";
  return value.length > 10 ? value.slice(0, 10) : value;
}

function routeNodesForInlineExecute(execute: InlineExecuteView): RouteNodeView[] {
  const plan: RouteNodeView = {
    id: `route:plan:${execute.id}`,
    kind: "plan",
    executeId: execute.id,
    sourceNodeId: execute.sourceNodeId,
    x: execute.overlay.planScope.x,
    y: execute.overlay.planScope.y,
    width: execute.overlay.planScope.width,
    height: expandedLaneLayout.planNodeSize,
    label: "Plan",
    status: routeStatusFromCssState(execute.overlay.planScope.cssState),
    teamColor: execute.teamColor,
    sessionId: execute.overlay.planScope.sessionId,
    execute,
    planScope: execute.overlay.planScope
  };
  const paths = execute.overlay.points
    .filter((point): point is InlinePathPoint & { kind: "path" } => point.kind === "path")
    .map((point): RouteNodeView => ({
      id: `route:path:${execute.id}:${point.pathId ?? point.id}`,
      kind: "path",
      executeId: execute.id,
      sourceNodeId: execute.sourceNodeId,
      x: point.x,
      y: point.y,
      width: 48,
      height: 48,
      label: point.pathId ?? point.goal,
      status: routeStatusFromCssState(point.cssState),
      teamColor: execute.teamColor,
      sessionId: point.sessionId,
      execute,
      point
    }));
  return [plan, ...paths];
}

function hunsuDraftRouteNodes(
  draftSessions: StudioHunsuDraftSession[],
  graphNodeById: Map<string, GraphNodeView>,
  graphNodes: GraphNodeView[]
): RouteNodeView[] {
  const usedRowsByColumn = graphNodeRowsByColumn(graphNodes);
  return draftSessions
    .flatMap((draft, index) => {
      const sourceNode = graphNodeById.get(draft.sourceNodeId);
      if (!sourceNode) return [];
      const targetNode = draft.confirmedNodeId ? graphNodeById.get(draft.confirmedNodeId) : undefined;
      return [{ draft, sourceNode, targetNode, index }];
    })
    .sort((left, right) =>
      graphNodeColumnKey(left.sourceNode).localeCompare(graphNodeColumnKey(right.sourceNode))
      || graphNodeRow(left.sourceNode) - graphNodeRow(right.sourceNode)
      || String(left.draft.createdAt).localeCompare(String(right.draft.createdAt))
      || String(left.draft.draftSessionId).localeCompare(String(right.draft.draftSessionId))
      || left.index - right.index
    )
    .map(({ draft, sourceNode, targetNode }) => {
      const virtualTarget = targetNode ? undefined : reserveHunsuDraftVirtualTarget(sourceNode, usedRowsByColumn);
      return hunsuDraftRouteNode(draft, sourceNode, targetNode, virtualTarget);
    });
}

function hunsuDraftRouteNode(
  draft: StudioHunsuDraftSession,
  sourceNode: GraphNodeView,
  targetNode?: GraphNodeView,
  virtualTarget?: HunsuDraftVirtualTarget
): RouteNodeView {
  const sourceAnchor = {
    x: sourceNode.x + moveCardSize.width / 2,
    y: sourceNode.y + moveCardSize.height
  };
  const targetAnchor = targetNode
    ? {
        x: targetNode.x + moveCardSize.width / 2,
        y: targetNode.y
      }
    : virtualTarget?.anchor;
  const position = hunsuDraftRoutePosition(sourceAnchor, targetAnchor, virtualTarget?.sideOffset);
  return {
    id: draft.routeId || `hunsu-draft:${draft.draftSessionId}`,
    kind: "hunsuDraft",
    draftSessionId: draft.draftSessionId,
    sourceNodeId: sourceNode.id,
    x: position.x,
    y: position.y,
    width: hunsuDraftRouteSize.width,
    height: hunsuDraftRouteSize.height,
    label: "HUNSU Draft",
    status: draft.status,
    teamColor: "var(--studio-galio)",
    sessionId: draft.draftAgentSessionId ?? draft.activeAgentSessionId,
    draft,
    sourceNode,
    sourceAnchor,
    targetNode,
    targetAnchor
  };
}

function hunsuDraftRoutePosition(
  sourceAnchor: { x: number; y: number },
  targetAnchor: { x: number; y: number } | undefined,
  sideOffset?: number
): { x: number; y: number } {
  const fallbackTarget = {
    x: sourceAnchor.x,
    y: sourceAnchor.y + graphLayout.row - moveCardSize.height
  };
  const target = targetAnchor ?? fallbackTarget;
  if (Math.abs(sourceAnchor.x - target.x) < 1 && target.y > sourceAnchor.y) {
    const horizontalOffset = sideOffset ?? hunsuDraftRouteLayout.sideOffset;
    const leftLaneCenter = Math.max(hunsuDraftRouteSize.width / 2 + 16, sourceAnchor.x - horizontalOffset);
    return {
      x: leftLaneCenter - hunsuDraftRouteSize.width / 2,
      y: Math.max(sourceAnchor.y + hunsuDraftRouteLayout.sourceGap, target.y - hunsuDraftRouteSize.height - hunsuDraftRouteLayout.targetGap)
    };
  }
  return {
    x: (sourceAnchor.x + target.x) / 2 - hunsuDraftRouteSize.width / 2,
    y: (sourceAnchor.y + target.y) / 2 - hunsuDraftRouteSize.height / 2
  };
}

function graphNodeRowsByColumn(graphNodes: GraphNodeView[]): Map<string, Set<number>> {
  const rowsByColumn = new Map<string, Set<number>>();
  for (const node of graphNodes) {
    const key = graphNodeColumnKey(node);
    const rows = rowsByColumn.get(key) ?? new Set<number>();
    rows.add(graphNodeRow(node));
    rowsByColumn.set(key, rows);
  }
  return rowsByColumn;
}

function reserveHunsuDraftVirtualTarget(sourceNode: GraphNodeView, usedRowsByColumn: Map<string, Set<number>>): HunsuDraftVirtualTarget {
  const key = graphNodeColumnKey(sourceNode);
  const rows = usedRowsByColumn.get(key) ?? new Set<number>();
  const sourceRow = graphNodeRow(sourceNode);
  let row = sourceRow + 1;
  while (rows.has(row)) {
    row += 1;
  }
  rows.add(row);
  usedRowsByColumn.set(key, rows);
  return {
    anchor: {
      x: sourceNode.x + moveCardSize.width / 2,
      y: graphLayout.y + row * graphLayout.row
    },
    sideOffset: hunsuDraftRouteLayout.sideOffset
  };
}

function graphNodeColumnKey(node: GraphNodeView): string {
  return String(Math.round(node.x));
}

function graphNodeRow(node: GraphNodeView): number {
  return Math.round((node.y - graphLayout.y) / graphLayout.row);
}

function routeStatusFromCssState(state: InlinePathCssState): Extract<RouteNodeView, { kind: "plan" }>["status"] {
  if (state === "running") return "running";
  if (state === "done") return "done";
  if (state === "failed") return "failed";
  return "waiting";
}

export function harnessLabel(harness: HarnessSnapshot | undefined): string {
  if (!harness) return "Team ExecutionPlan";
  if (harness.kind === "team_execution_plan") return "Team + ExecutionPlan";
  if (harness.kind === "role_squad") return "Role Squad";
  if (harness.kind === "council_vote") return "Council Vote";
  return "Court Debate";
}

function resolveSelection(input: {
  requested?: RoadmapSelection;
  graphNodes: GraphNodeView[];
  inlineExecutes: InlineExecuteView[];
  routeNodes: RouteNodeView[];
  board: BoardProjection;
  activeNodeId?: string;
}): RoadmapSelectionModel {
  const requested = input.requested;
  if (requested?.kind === "none") {
    return { selection: requested };
  }
  if (requested?.kind === "execute") {
    const executeId = requested.executeId;
    const execute = input.inlineExecutes.find(item => item.id === executeId || item.run.runId === executeId);
    if (execute) {
      return {
        selection: { kind: "execute", executeId: execute.id },
        node: execute.sourceNode,
        move: execute.sourceNode.move,
        execute,
        planScope: execute.overlay.planScope
      };
    }
  }
  if (requested?.kind === "pathPoint") {
    const executeId = requested.executeId;
    const pointId = requested.pointId;
    const execute = input.inlineExecutes.find(item => item.id === executeId || item.run.runId === executeId);
    const point = execute?.overlay.points.find(item => item.kind === "path" && (item.id === pointId || item.pathId === pointId));
    if (execute && point) {
      return {
        selection: { kind: "pathPoint", executeId: execute.id, pointId: point.pathId ?? point.id },
        node: execute.sourceNode,
        move: execute.sourceNode.move,
        execute,
        planScope: execute.overlay.planScope,
        point
      };
    }
  }
  if (requested?.kind === "hunsuDraftRoute") {
    const routeNode = input.routeNodes.find(item => item.kind === "hunsuDraft" && item.draftSessionId === requested.draftSessionId);
    if (routeNode?.kind === "hunsuDraft") {
      return {
        selection: { kind: "hunsuDraftRoute", draftSessionId: routeNode.draftSessionId },
        node: routeNode.sourceNode,
        routeNode,
        hunsuDraft: routeNode.draft
      };
    }
  }
  if (requested?.kind === "move") {
    const node = input.graphNodes.find(item => {
      if (requested.nodeId && item.id === requested.nodeId) return true;
      if (requested.nodeId && item.card.moveId === requested.nodeId) return true;
      if (requested.moveId && item.card.moveId === requested.moveId) return true;
      return requested.teamName !== undefined
        && requested.moveOrdinal !== undefined
        && item.card.teamName === requested.teamName
        && item.card.ordinal === requested.moveOrdinal;
    });
    if (node) {
      const source = node.node.source;
      const hunsu = source.type === "hunsu"
        ? input.board.hunsus.find(candidate => String(candidate.id) === String(source.hunsuId))
        : undefined;
      return {
        selection: {
          kind: "move",
          nodeId: node.id,
          moveId: node.move ? String(node.move.id) : requested.moveId,
          teamName: node.card.teamName,
          moveOrdinal: node.card.ordinal
        },
        node,
        move: node.move,
        hunsu
      };
    }
  }
  const fallback = input.graphNodes.find(node => node.id === input.activeNodeId) ?? input.graphNodes.at(-1) ?? input.graphNodes[0];
  if (!fallback) {
    return { selection: { kind: "none" } };
  }
  const fallbackSource = fallback.node.source;
  const hunsu = fallbackSource.type === "hunsu"
    ? input.board.hunsus.find(candidate => String(candidate.id) === String(fallbackSource.hunsuId))
    : undefined;
  return {
    selection: {
      kind: "move",
      nodeId: fallback.id,
      moveId: fallback.move ? String(fallback.move.id) : undefined,
      teamName: fallback.card.teamName,
      moveOrdinal: fallback.card.ordinal
    },
    node: fallback,
    move: fallback.move,
    hunsu
  };
}

function buildInspector(board: BoardProjection, selection: RoadmapSelectionModel, action: RoadmapActionModel, panel: RoadmapDetailPanel, agentSessions: AgentSession[], actionRuns: StudioActionRun[]): InspectorModel | undefined {
  if (selection.routeNode?.kind === "hunsuDraft" && selection.hunsuDraft) {
    const draftSession = hunsuDraftAgentSessionView(selection.hunsuDraft, agentSessions);
    return {
      kind: "hunsuDraftRoute",
      state: "HunsuDraft",
      route: selection.routeNode,
      sourceNode: selection.routeNode.sourceNode,
      draft: selection.hunsuDraft,
      draftSession,
      activeAgentSession: activeAgentSessionForView("HunsuDraft", draftSession)
        ?? activeHunsuDraftAgentSessionRef(selection.hunsuDraft),
      action
    };
  }
  if (selection.execute && selection.point && selection.selection.kind === "pathPoint") {
    const pathRun = selection.execute.run.memberPathRuns?.find(item => pathKey(item) === selection.point?.pathId);
    const planSession = teamPlanSessionForRun(selection.execute.run);
    const executionSession = executionPlanSessionForRun(selection.execute.run, pathRun);
    return {
      kind: "pathPoint",
      state: "Path",
      run: selection.execute.run,
      sourceNode: selection.execute.sourceNode,
      point: selection.point,
      pathRun,
      dependencies: dependencyLabelsForPathPoint(selection.execute.run, selection.point, pathRun),
      planSession,
      executionSession,
      activeAgentSession: activeAgentSessionForView("ExecutionPlan", executionSession),
      action
    };
  }
  if (selection.execute && selection.selection.kind === "execute") {
    const planSession = teamPlanSessionForRun(selection.execute.run);
    return {
      kind: "execute",
      state: "Executing",
      run: selection.execute.run,
      sourceNode: selection.execute.sourceNode,
      targetPoint: selection.execute.overlay.points.find(point => point.kind === "target"),
      pathPoints: selection.execute.overlay.points.filter(point => point.kind === "path"),
      planSession,
      planExecutionTransition: selection.execute.run.planExecutionTransition,
      activeAgentSession: activeAgentSessionForView("TeamPlan", planSession),
      action
    };
  }
  if (!selection.node) {
    return undefined;
  }
  if (panel === "hunsu" && (selection.node.node.source.type === "hunsu" || selection.hunsu)) {
    return {
      kind: "hunsu",
      state: "HunsuDraft",
      node: selection.node,
      hunsu: selection.hunsu,
      move: selection.move,
      title: selection.hunsu?.summary ? String(selection.hunsu.summary) : selection.node.card.title,
      summary: selection.hunsu ? hunsuDeltaSummary(selection.hunsu, board) : selection.node.card.summary,
      action
    };
  }
  const snapshotDestinations = moveSnapshotDestinations(selection.node.node, selection.move);
  const remainingSnapshotDestinations = snapshotDestinations.filter(destination =>
    destination.status === "pending"
      || destination.status === "claimed"
      || destination.status === "in_progress"
      || destination.status === "blocked"
  );
  return {
    kind: "move",
    state: "Move",
    panel,
    node: selection.node,
    move: selection.move,
    title: selection.node.card.title,
    subtitle: `${selection.node.card.teamName} M${String(selection.node.card.ordinal).padStart(4, "0")}`,
    summary: selection.node.card.summary,
    destinations: selection.node.card.destinations,
    reachedDestinations: selection.node.card.destinations.filter(destination => destination.state === "reached"),
    remainingDestinations: selection.node.card.destinations.filter(destination => destination.state !== "reached"),
    snapshotDestinations,
    achievedSnapshotDestinations: snapshotDestinations.filter(destination => destination.status === "reached"),
    remainingSnapshotDestinations,
    teamRuntime: moveTeamRuntime(selection.node.node),
    memberRuntime: moveMemberRuntime(selection.node.node),
    artifactActions: moveArtifactActionViews(selection.node.node, selection.move, actionRuns),
    action
  };
}

function moveArtifactActionViews(node: NodeRecord, move: MoveRecord | undefined, actionRuns: StudioActionRun[]): MoveArtifactActionView[] {
  return (node.artifactActions ?? [])
    .slice()
    .sort((left, right) => left.displayOrder - right.displayOrder || String(left.id).localeCompare(String(right.id)))
    .map(action => {
      const latestRun = actionRuns
        .filter(run => run.actionId === String(action.id))
        .filter(run => !move || run.source?.moveId === String(move.id))
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .at(0);
      return {
        id: String(action.id),
        title: String(action.title),
        kind: action.kind,
        sourceScope: action.sourceScope,
        runnerLabel: artifactActionRunnerLabel(action),
        aliases: artifactActionAliasViews(action, latestRun),
        latestRun: latestRun ? {
          runId: latestRun.runId,
          status: latestRun.status,
          commit: latestRun.source?.commit,
          exitCode: latestRun.exitCode,
          updatedAt: latestRun.updatedAt,
          error: latestRun.error
        } : undefined
      };
    });
}

function artifactActionRunnerLabel(action: StudioArtifactAction): string {
  if (action.runner.type === "docker_compose") {
    return `docker compose · ${action.runner.file}`;
  }
  return action.runner.command;
}

function artifactActionAliasViews(action: StudioArtifactAction, latestRun: StudioActionRun | undefined): MoveArtifactActionView["aliases"] {
  const aliases = new Set([
    ...Object.keys(action.aliases ?? {}),
    ...Object.keys(latestRun?.aliases ?? {})
  ]);
  return [...aliases].map(alias => {
    const configured = action.aliases?.[alias];
    const runAlias = latestRun?.aliases?.[alias];
    return {
      alias,
      url: runAlias?.directUrl ?? runAlias?.externalPath,
      service: runAlias?.service ?? configured?.service,
      target: runAlias?.target ?? configured?.target
    };
  });
}

function hunsuDraftAgentSessionView(draft: StudioHunsuDraftSession, sessions: AgentSession[]): AgentSessionView | undefined {
  const session = sessions.find(candidate => candidate.sessionId === draft.draftAgentSessionId)
    ?? sessions.find(candidate => candidate.owner.kind === "HunsuDraft" && candidate.owner.draftSessionId === draft.draftSessionId);
  return session ? agentSessionView(session, "hunsuDraft", "HUNSU Draft") : undefined;
}

function activeHunsuDraftAgentSessionRef(draft: StudioHunsuDraftSession): ActiveInspectorAgentSession | undefined {
  const sessionId = draft.draftAgentSessionId ?? draft.activeAgentSessionId;
  return sessionId ? { kind: "HunsuDraft", sessionId, mode: "snapshot" } : undefined;
}

function moveSnapshotDestinations(node: NodeRecord, move: MoveRecord | undefined): MoveSnapshotDestinationView[] {
  const queue = [...node.destinations].filter(isOpenDestination).sort(destinationPrioritySort);
  const queueHeadId = queue[0] ? String(queue[0].id) : undefined;
  const reachedByMove = new Set(move?.outcome === "arrived" ? move.reachedDestinationIds.map(String) : []);
  return [...node.destinations]
    .sort((left, right) =>
      destinationSnapshotRank(left) - destinationSnapshotRank(right)
      || destinationPrioritySort(left, right)
      || String(left.id).localeCompare(String(right.id))
    )
    .map(destination => ({
      id: String(destination.id),
      title: String(destination.title),
      status: destination.status,
      displayState: destination.status === "reached"
        ? "reached"
        : destination.status === "blocked"
          ? "blocked"
          : destination.status === "pending" || destination.status === "claimed" || destination.status === "in_progress"
            ? (String(destination.id) === queueHeadId ? "next" : "open")
            : "closed",
      priority: destination.priority,
      acceptanceCriteria: destination.acceptanceCriteria?.map(String) ?? [],
      constraints: destination.constraints?.map(String) ?? [],
      notes: destination.notes ? String(destination.notes) : undefined,
      queueHead: String(destination.id) === queueHeadId,
      reachedByThisMove: reachedByMove.has(String(destination.id))
    }));
}

function destinationSnapshotRank(destination: Destination): number {
  if (destination.status === "pending" || destination.status === "claimed" || destination.status === "in_progress") return 0;
  if (destination.status === "blocked") return 1;
  if (destination.status === "reached") return 2;
  return 3;
}

function moveTeamRuntime(node: NodeRecord): MoveTeamRuntimeView {
  const harness = node.harness;
  return {
    harnessLabel: harnessLabel(harness),
    harnessKind: harness.kind,
    budgetLabel: harnessBudgetLabel(harness),
    guardrailLabel: `${harness.guardrails?.length ?? 0} guardrails`,
    prompt: harness.team.promptTemplate.template
  };
}

function moveMemberRuntime(node: NodeRecord): MoveMemberRuntimeView[] {
  return node.harness.members.map(member => ({
    id: String(member.id),
    prompt: member.promptTemplate.template,
    modelLabel: [
      memberModelLabel(String(member.model)),
      reasoningEffortLabel(String(member.reasoningEffort)),
      serviceTierLabel(member.serviceTier ? String(member.serviceTier) : undefined)
    ].filter(Boolean).join(" · "),
    executionLabel: memberExecutionLabel(member.execution.kind, member.execution.network),
    approvalLabel: memberApprovalLabel(member.approval),
    skills: member.skills.map(skill => String(skill.name))
  }));
}

function memberModelLabel(model: string): string {
  return model === "codex-default" ? "Codex default model" : model;
}

function reasoningEffortLabel(reasoningEffort: string): string {
  if (reasoningEffort === "default") return "Standard reasoning";
  return `${capitalizeWords(reasoningEffort)} reasoning`;
}

function serviceTierLabel(serviceTier: string | undefined): string {
  if (!serviceTier || serviceTier === "default") return "Default service tier";
  return `${capitalizeWords(serviceTier)} service tier`;
}

function memberExecutionLabel(kind: string, network: string): string {
  const access = kind === "worktree_write"
    ? "Can edit the Route worktree"
    : kind === "read_only"
      ? "Read-only"
      : kind === "unrestricted"
        ? "Unrestricted execution"
        : capitalizeWords(kind);
  return network === "enabled" ? `${access}; network enabled` : `${access}; no network`;
}

function memberApprovalLabel(approval: { policy: string; reviewer?: string }): string {
  if (approval.policy === "never") return "No approval prompts";
  if (approval.policy === "on_request") {
    return approval.reviewer === "auto_review" ? "Auto-review requested actions" : "Ask user before requested actions";
  }
  return capitalizeWords(approval.policy);
}

function capitalizeWords(value: string): string {
  return value.replace(/[_-]/g, " ").replace(/\b\w/g, letter => letter.toUpperCase());
}

function harnessBudgetLabel(harness: HarnessSnapshot): string {
  if ("maxAttemptCount" in harness) return `${harness.maxAttemptCount} attempts`;
  if ("maxRoundCount" in harness) return `${harness.maxRoundCount} rounds`;
  return "default budget";
}

function teamPlanSessionForRun(run: InlinePathRun): AgentSessionView | undefined {
  const planningTurnId = !run.executionPlanPlan?.length && !run.memberPathRuns?.length ? run.liveStatus?.providerTurnId : undefined;
  const providerTurnId = run.providerTeamPlanningTurnId ?? planningTurnId;
  const session = [...(run.agentSessions ?? [])]
    .filter(candidate => candidate.owner.kind === "TeamPlan")
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
  if (session) {
    const view = agentSessionView(agentSessionWithRunMessages(session, run, session.provider?.providerTurnId ?? providerTurnId), "teamPlan", "Team Plan");
    return { ...view, status: planNodeStatusForRun(run, view) };
  }
  const providerThreadId = run.providerTeamThreadId ?? threadIdForTurn(run, providerTurnId);
  if (!providerTurnId && !providerThreadId) {
    return undefined;
  }
  const fallbackSessionId = `${run.executeId}:plan:fallback`;
  const owner: AgentSession["owner"] = { kind: "TeamPlan", runId: "runId" in run && typeof run.runId === "string" ? run.runId : run.executeId, executeId: run.executeId, attempt: 1 };
  const fallbackStatus: AgentSessionView["status"] = planNodeStatusForRun(run);
  return {
    kind: "teamPlan",
    label: "Team Plan",
    sessionId: fallbackSessionId,
    session: fallbackAgentSession({
      sessionId: fallbackSessionId,
      runId: "runId" in run && typeof run.runId === "string" ? run.runId : run.executeId,
      executeId: run.executeId,
      owner,
      providerThreadId,
      providerTurnId,
      status: fallbackStatus === "running" ? "executing" : fallbackStatus === "failed" ? "failed" : "completed",
      messages: fallbackAgentMessagesForTurn({ sessionId: fallbackSessionId, owner, run, providerTurnId })
    }),
    canonical: false,
    providerThreadId,
    providerTurnId,
    status: fallbackStatus
  };
}

function executionPlanSessionForRun(run: InlinePathRun, pathRun: InlinePathRunPathState | undefined): AgentSessionView | undefined {
  if (!pathRun) {
    return undefined;
  }
  const label = pathRun.pathId ?? pathRun.id ?? pathRun.executorId ?? "Member Path";
  const session = (run.agentSessions ?? []).find(candidate =>
    candidate.sessionId === pathRun.agentSessionId
    || (candidate.owner.kind === "ExecutionPlan" && candidate.owner.pathId === (pathRun.pathId ?? pathRun.id))
  );
  const providerTurnId = session?.provider?.providerTurnId ?? pathRun.session?.providerTurnId;
  const providerThreadId = session?.provider?.providerThreadId ?? pathRun.session?.providerThreadId;
  if (session) {
    return agentSessionView(agentSessionWithRunMessages(session, run, providerTurnId), "executionPlan", label);
  }
  const fallbackSessionId = pathRun.agentSessionId ?? `${run.executeId}:path:${pathRun.pathId ?? pathRun.id ?? "fallback"}`;
  const owner: AgentSession["owner"] = { kind: "ExecutionPlan", runId: run.runId ?? run.executeId, executeId: run.executeId, attempt: pathRun.attempt ?? 1, pathId: pathRun.pathId ?? pathRun.id ?? "path", executorId: pathRun.executorId ?? "agent" };
  return {
    kind: "executionPlan",
    label,
    sessionId: fallbackSessionId,
    session: fallbackAgentSession({
      sessionId: fallbackSessionId,
      runId: run.runId ?? run.executeId,
      executeId: run.executeId,
      owner,
      providerThreadId,
      providerTurnId,
      status: pathRun.status === "starting" || pathRun.status === "executing" ? "executing" : pathRun.status === "failed" ? "failed" : pathRun.status === "completed" ? "completed" : "waiting",
      messages: fallbackAgentMessagesForTurn({ sessionId: fallbackSessionId, owner, run, providerTurnId })
    }),
    canonical: false,
    providerThreadId,
    providerTurnId,
    status: pathRun.status === "starting" || pathRun.status === "executing" ? "running" : pathRun.status === "failed" ? "failed" : pathRun.status === "completed" ? "done" : "waiting"
  };
}

function agentSessionView(session: AgentSession, kind: AgentSessionView["kind"], label: string): AgentSessionView {
  return {
    kind,
    label,
    sessionId: session.sessionId,
    session,
    canonical: true,
    providerThreadId: session.provider?.providerThreadId,
    providerTurnId: session.provider?.providerTurnId,
    status: agentSessionStatusForView(session)
  };
}

function activeAgentSessionForView(kind: ActiveInspectorAgentSession["kind"], session: AgentSessionView | undefined): ActiveInspectorAgentSession | undefined {
  if (!session?.canonical) {
    return undefined;
  }
  return {
    kind,
    sessionId: session.sessionId,
    mode: session.status === "running" ? "stream" : "snapshot"
  };
}

function agentSessionWithRunMessages(session: AgentSession, run: InlinePathRun, providerTurnId: string | undefined): AgentSession {
  if (session.messages.some(hasAgentMessageContent)) {
    return session;
  }
  const messages = fallbackAgentMessagesForTurn({ sessionId: session.sessionId, owner: session.owner, run, providerTurnId });
  if (messages.length === 0) {
    return session;
  }
  return {
    ...session,
    messages,
    activeItemIds: session.activeItemIds.length > 0 ? session.activeItemIds : messages.filter(message => message.status !== "completed").map(message => message.itemId),
    updatedAt: maxTimestamp(session.updatedAt, messages.at(-1)?.updatedAt ?? session.updatedAt)
  };
}

function fallbackAgentMessagesForTurn(input: {
  sessionId: string;
  owner: AgentSession["owner"];
  run: InlinePathRun;
  providerTurnId: string | undefined;
}): AgentSession["messages"] {
  void input;
  return [];
}

function hasAgentMessageContent(message: AgentSession["messages"][number]): boolean {
  return Boolean(
    message.text
    || message.output
    || message.summary?.length
    || message.content?.length
    || message.command
    || message.commandActions?.length
    || message.changes
  );
}

function maxTimestamp(left: string, right: string): string {
  return right.localeCompare(left) > 0 ? right : left;
}

function agentSessionStatusForView(session: AgentSession): AgentSessionView["status"] {
  if (session.state.type === "completed") {
    return "done";
  }
  if (session.state.type === "failed") {
    return "failed";
  }
  if (session.state.type === "waiting") {
    return "waiting";
  }
  return "running";
}

function planNodeStatusForRun(run: InlinePathRun, session?: AgentSessionView): AgentSessionView["status"] {
  const hasPlannedExecutionPlan = (run.executionPlanPlan?.length ?? 0) > 0 || (run.memberPathRuns?.length ?? 0) > 0;
  if (hasPlannedExecutionPlan || session?.status === "done") {
    return "done";
  }
  if (session?.status === "failed" || run.status === "failed" || run.status === "accident") {
    return "failed";
  }
  if (session?.status === "running" || isActiveRunStatus(run.status)) {
    return "running";
  }
  return session?.status ?? "waiting";
}

function cssStateForPlanStatus(status: AgentSessionView["status"]): InlinePathCssState {
  if (status === "done") return "done";
  if (status === "failed") return "failed";
  if (status === "running") return "running";
  return "waiting";
}

function fallbackAgentSession(input: {
  sessionId: string;
  runId: string;
  executeId: string;
  owner: AgentSession["owner"];
  providerThreadId?: string;
  providerTurnId?: string;
  status: "waiting" | "executing" | "completed" | "failed";
  messages?: AgentSession["messages"];
}): AgentSession {
  const now = new Date().toISOString();
  const provider = input.providerThreadId && input.providerTurnId
    ? { providerThreadId: input.providerThreadId, providerTurnId: input.providerTurnId }
    : undefined;
  return {
    sessionId: input.sessionId,
    routeRef: {
      kind: "Route",
      routeKind: input.owner.kind === "TeamPlan" ? "Plan" : "Path",
      routeId: input.executeId,
      runId: input.runId,
      executeId: input.executeId,
      sourceLineId: "",
      sourceNodeId: ""
    },
    runId: input.runId,
    executeId: input.executeId,
    owner: input.owner,
    provider,
    state: input.status === "completed"
      ? { type: "completed", provider, completedAt: now }
      : input.status === "failed"
        ? { type: "failed", provider, error: "Session failed.", completedAt: now }
        : input.status === "waiting"
          ? { type: "waiting" }
          : provider
            ? { type: "executing", provider, activeItemIds: [] }
            : { type: "starting", startedAt: now },
    messages: input.messages ?? [],
    activeItemIds: input.messages?.filter(message => message.status !== "completed").map(message => message.itemId) ?? [],
    revision: 0,
    createdAt: now,
    updatedAt: now
  };
}

function threadIdForTurn(run: InlinePathRun, providerTurnId: string | undefined): string | undefined {
  void run;
  void providerTurnId;
  return undefined;
}

function panelForSelection(selection: RoadmapSelection): RoadmapDetailPanel {
  if (selection.kind === "execute") return "execute";
  if (selection.kind === "pathPoint") return "path";
  if (selection.kind === "hunsuDraftRoute") return "hunsu";
  return "move";
}

function detailPanelPosition(selection: RoadmapSelectionModel): { x: number; y: number } | undefined {
  if (selection.routeNode?.kind === "hunsuDraft") {
    return {
      x: selection.routeNode.x + selection.routeNode.width + 32,
      y: Math.max(32, selection.routeNode.y - 32)
    };
  }
  if (selection.point) {
    const overlayBottom = selection.execute?.overlay.points.reduce((bottom, point) => Math.max(bottom, point.y + 48), selection.point.y + 48) ?? selection.point.y + 48;
    return {
      x: Math.max(32, selection.point.x - 80),
      y: overlayBottom + 32
    };
  }
  if (selection.planScope) {
    const overlayBottom = selection.execute?.overlay.points.reduce(
      (bottom, point) => Math.max(bottom, point.y + 48),
      selection.planScope.y + 48
    ) ?? selection.planScope.y + 48;
    return {
      x: Math.max(32, selection.planScope.x - 32),
      y: overlayBottom + 32
    };
  }
  if (selection.node) {
    return {
      x: selection.node.x,
      y: selection.node.y + moveCardSize.height + 48
    };
  }
  return undefined;
}

function buildMoveCard(
  board: BoardProjection,
  node: NodeRecord,
  move: MoveRecord | undefined,
  activeRun: StudioRunState | undefined,
  skills: StudioSkillSummary[],
  state: { executing: boolean; playable: boolean; hasNextMove: boolean }
): MoveCardView {
  const teamName = teamNameForNode(board, node, move);
  const teamTone = teamToneForName(teamName);
  const protocol = node.harness ?? move?.snapshot?.harness;
  const members = "members" in protocol ? protocol.members : [];
  const remainingDestinationCount = node.destinations.filter(isOpenDestination).length;
  const progress = move?.outcome === "accident"
    ? "Accident"
    : state.executing
      ? "Executing"
      : remainingDestinationCount > 0 || state.playable
        ? "Waiting"
        : "Arrived";
  const outcomeLabel = move?.outcome === "accident" ? "ACCIDENT" : move?.outcome === "arrived" ? "ARRIVED" : undefined;
  const statusLabel = outcomeLabel
    ?? (state.executing ? "DRIVING" : state.playable ? "EXECUTE READY" : state.hasNextMove ? "Continued" : remainingDestinationCount > 0 ? "Open Destinations" : "Complete");

  return {
    id: String(move?.id ?? node.id),
    nodeId: String(node.id),
    moveId: move ? String(move.id) : undefined,
    ordinal: move?.ordinal ?? node.ordinal,
    title: `MOVE ${move?.ordinal ?? node.ordinal}`,
    teamName,
    teamTone,
    teamColor: teamColorForName(teamName),
    statusLabel,
    summary: String(move?.summary ?? "Initial immutable Team Snapshot"),
    progress,
    destinations: moveCardDestinations(board, node, move),
    harnessLabel: harnessLabel(protocol),
    memberLabel: members.length > 0 ? members.map(member => String(member.id)).slice(0, 3).join(", ") : "Team",
    skillCountLabel: `${skills.length} Skills`,
    modelLabel: members[0]?.model ? `${members[0].model} / ${members[0].reasoningEffort}` : "codex-default",
    remainingDestinationCount,
    commit: move?.commit,
    terminalPathCommit: activeRun?.terminalPathCommit,
    pathCommitCount: Object.keys(activeRun?.pathCommits ?? {}).length,
    reachedWindowLabel: `${node.destinations.filter(destination => destination.status === "reached").length} reached`,
    leftWindowLabel: `${remainingDestinationCount} left`,
    snapshotKind: move ? "RecordedMove" : "InitialMove",
    hunsuForked: node.source.type === "hunsu" || Boolean(move?.sourceHunsuId)
  };
}

function moveCardDestinations(board: BoardProjection, node: NodeRecord, move: MoveRecord | undefined): MoveCardDestinationView[] {
  const source = node.source;
  const fromNode = source.type === "move" || source.type === "hunsu"
    ? board.nodes.find(candidate => String(candidate.id) === String(source.fromNodeId))
    : undefined;
  const completedDestinations = move
    ? move.reachedDestinationIds
      .map(destinationId => node.destinations.find(destination => String(destination.id) === String(destinationId)) ?? fromNode?.destinations.find(destination => String(destination.id) === String(destinationId)))
      .filter((destination): destination is Destination => Boolean(destination))
    : [];
  const openDestinations = [...node.destinations].filter(isOpenDestination).sort(destinationPrioritySort);
  const visibleOpenDestinations = openDestinations.slice(0, 2);
  const visibleCompletedDestinations = completedDestinations.slice(0, Math.max(0, 4 - visibleOpenDestinations.length));
  return [
    ...visibleOpenDestinations.map((destination, index) => destinationView(destination, index === 0 ? "next" : undefined)),
    ...visibleCompletedDestinations.map(destination => destinationView(destination, "reached"))
  ];
}

function destinationView(destination: Destination, forcedState?: DestinationViewState): MoveCardDestinationView {
  return {
    id: String(destination.id),
    title: String(destination.title),
    state: forcedState ?? (destination.status === "reached" ? "reached" : destination.status === "blocked" ? "blocked" : destination.status === "claimed" || destination.status === "in_progress" ? "next" : "open")
  };
}

function buildActionModel(
  board: BoardProjection,
  runs: StudioRunState[],
  node: NodeRecord | undefined,
  nodesWithNextMove: Set<string>,
  activeExecuteSourceNodeIds: Set<string>
): RoadmapActionModel {
  const teamColor = node ? teamColorForName(teamNameForNode(board, node)) : "var(--studio-faker)";
  if (!node) {
    return { canStartExecute: false, disabledReason: "No MOVE is selected.", destinationIds: [], destinationLabels: [], teamColor };
  }
  const line = lineForNode(board, node);
  const move = anchorMoveForNode(board, node);
  const openDestinations = openExecuteDestinationsForNode(board, node);
  const actionDestinations = openDestinations.slice(0, 1);
  const destinationIds = actionDestinations.map(destination => String(destination.id));
  const destinationLabels = actionDestinations.map(destination => String(destination.title));
  const base = {
    sourceNodeId: String(node.id),
    requestId: String(node.requestId),
    lineId: line ? String(line.id) : undefined,
    destinationIds,
    destinationLabels,
    nextDestination: actionDestinations[0],
    teamColor
  };
  if (!line) {
    return { ...base, canStartExecute: false, disabledReason: "Selected MOVE is missing route context." };
  }
  if (line.status !== "active") {
    return { ...base, canStartExecute: false, disabledReason: `Cannot start a Execute from a ${line.status} route.` };
  }
  if (String(line.currentNodeId) !== String(node.id)) {
    return { ...base, canStartExecute: false, disabledReason: "Execute can only start from the current MOVE on this route." };
  }
  if (nodesWithNextMove.has(String(node.id))) {
    return { ...base, canStartExecute: false, disabledReason: "This MOVE already has a next MOVE." };
  }
  const existingExecuteFromNode = runs.find(run => String(run.sourceNodeId) === String(node.id) && run.status !== "discarded" && run.status !== "stopped");
  if (activeExecuteSourceNodeIds.has(String(node.id)) || existingExecuteFromNode) {
    return {
      ...base,
      canStartExecute: false,
      disabledReason: existingExecuteFromNode && !isActiveRunStatus(existingExecuteFromNode.status)
        ? "A Execute result already exists for this MOVE."
        : "A Execute is already running from this MOVE."
    };
  }
  if (move?.outcome === "accident") {
    return { ...base, canStartExecute: false, disabledReason: "Accident MOVEs must be recovered through HUNSU before Executing." };
  }
  if (destinationIds.length === 0) {
    return { ...base, canStartExecute: false, disabledReason: "All Destinations on this MOVE are complete or superseded." };
  }
  return { ...base, canStartExecute: true };
}

function openExecuteDestinationsForNode(board: BoardProjection, node: NodeRecord): Destination[] {
  const line = lineForNode(board, node);
  const destinations = node.destinations.length > 0 ? node.destinations : line ? destinationsForLine(board, String(line.id)) : [];
  return destinations.filter(isOpenDestination).sort(destinationPrioritySort);
}

function togglePositionForConnection(display: RoadmapConnectionDisplay, from: GraphNodeView, to: GraphNodeView): { x: number; y: number } {
  const centerY = from.y + moveCardSize.height / 2;
  if (display.connectDisplayType === "Expand") {
    return {
      x: from.x + moveCardSize.width + 44,
      y: centerY + 26
    };
  }
  return {
    x: Math.min(to.x - 48, from.x + moveCardSize.width + 72),
    y: centerY - 17
  };
}

function buildConnectionPlans(input: {
  edges: BoardEdge[];
  runs: StudioRunState[];
  selection?: RoadmapSelection;
  expandedConnectionIds: string[];
}): Map<string, ConnectionPlan> {
  const expandedIds = new Set(input.expandedConnectionIds);
  const selectedExecuteId = input.selection?.kind === "execute" || input.selection?.kind === "pathPoint"
    ? input.selection.executeId
    : undefined;
  const runsBySourceNodeId = new Map<string, StudioRunState>();
  for (const run of [...input.runs].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))) {
    if (run.sourceNodeId && !runsBySourceNodeId.has(String(run.sourceNodeId))) {
      runsBySourceNodeId.set(String(run.sourceNodeId), run);
    }
  }

  const plans = new Map<string, ConnectionPlan>();
  for (const edge of input.edges) {
    if (edge.type !== "move") continue;
    const run = runsBySourceNodeId.get(String(edge.fromNodeId));
    const display = run
      ? displayForRunConnection(run, {
          sourceNodeId: String(edge.fromNodeId),
          targetNodeId: String(edge.toNodeId),
          selected: selectedExecuteId === run.executeId || selectedExecuteId === run.runId,
          expanded: expandedIds.has(run.executeId) || expandedIds.has(run.runId)
        })
      : {
          connectDisplayType: "Fold" as const,
          displayId: `connection:${String(edge.id)}`,
          sourceNodeId: String(edge.fromNodeId),
          targetNodeId: String(edge.toNodeId),
          laneWidth: graphLayout.column,
          canToggle: false,
          toggleIcon: "expand" as const
        };
    plans.set(String(edge.id), {
      edgeId: String(edge.id),
      fromNodeId: String(edge.fromNodeId),
      toNodeId: String(edge.toNodeId),
      display
    });
  }
  return plans;
}

function displayForRunConnection(run: StudioRunState, input: { sourceNodeId: string; targetNodeId?: string; selected: boolean; expanded: boolean }): RoadmapConnectionDisplay {
  const laneWidth = expandedLaneWidthForRun(run);
  if (isActiveRunStatus(run.status)) {
    return {
      connectDisplayType: "Executing",
      displayId: run.executeId,
      sourceNodeId: input.sourceNodeId,
      targetNodeId: input.targetNodeId,
      executeId: run.executeId,
      laneWidth,
      canToggle: false
    };
  }
  if (input.selected || input.expanded) {
    return {
      connectDisplayType: "Expand",
      displayId: run.executeId,
      sourceNodeId: input.sourceNodeId,
      targetNodeId: input.targetNodeId,
      executeId: run.executeId,
      laneWidth,
      canToggle: true,
      toggleIcon: "fold"
    };
  }
  return {
    connectDisplayType: "Fold",
    displayId: run.executeId,
    sourceNodeId: input.sourceNodeId,
    targetNodeId: input.targetNodeId,
    executeId: run.executeId,
    laneWidth: graphLayout.column,
    canToggle: true,
    toggleIcon: "expand"
  };
}

function executingDisplayForRun(run: StudioRunState, sourceNodeId: string): RoadmapConnectionDisplay {
  return {
    connectDisplayType: "Executing",
    displayId: run.executeId,
    sourceNodeId,
    executeId: run.executeId,
    laneWidth: expandedLaneWidthForRun(run),
    canToggle: false
  };
}

function defaultConnectionPlan(edge: BoardEdge): ConnectionPlan {
  return {
    edgeId: String(edge.id),
    fromNodeId: String(edge.fromNodeId),
    toNodeId: String(edge.toNodeId),
    display: {
      connectDisplayType: "Fold",
      displayId: `connection:${String(edge.id)}`,
      sourceNodeId: String(edge.fromNodeId),
      targetNodeId: String(edge.toNodeId),
      laneWidth: graphLayout.column,
      canToggle: false,
      toggleIcon: "expand"
    }
  };
}

function expandedLaneWidthForRun(run: InlinePathRun): number {
  const pathCount = pathsForRun(run).length;
  const targetRelativeX = pathCount > 0
    ? moveCardSize.width + expandedLaneLayout.planGap + expandedLaneLayout.planNodeSize + expandedLaneLayout.planToPathGap + (pathCount - 1) * expandedLaneLayout.pathGap + expandedLaneLayout.targetAfterPathGap
    : moveCardSize.width + expandedLaneLayout.planGap + expandedLaneLayout.planNodeSize + expandedLaneLayout.planToPathGap + 220;
  return Math.max(graphLayout.column, targetRelativeX + expandedLaneLayout.targetNodeGap);
}

function pathLaneOffset(index: number, compact: boolean): number {
  if (compact) {
    return index % 2 === 0 ? -22 : 34;
  }
  return index % 2 === 0 ? -30 : 42;
}

function layoutGraphNodes(nodes: NodeRecord[], edges: BoardEdge[], connectionPlans: Map<string, ConnectionPlan>): GraphNodeLayout[] {
  const sorted = [...nodes].sort((left, right) =>
    left.ordinal - right.ordinal
    || nodeSourceRank(left) - nodeSourceRank(right)
    || String(left.id).localeCompare(String(right.id))
  );
  const positions = new Map<string, { column: number; row: number }>();
  let nextRootRow = 0;
  for (const node of sorted) {
    if (node.source.type === "initial-execute-team" || node.source.type === "request") {
      positions.set(String(node.id), { column: 0, row: nextRootRow });
      nextRootRow += 1;
    }
  }
  const incoming = new Map(edges.map(edge => [String(edge.toNodeId), edge]));
  for (const node of sorted) {
    if (positions.has(String(node.id))) continue;
    const edge = incoming.get(String(node.id));
    const from = edge ? positions.get(String(edge.fromNodeId)) : undefined;
    if (!edge || !from) {
      positions.set(String(node.id), { column: positions.size, row: 0 });
      continue;
    }
    positions.set(String(node.id), {
      column: edge.type === "hunsu" ? from.column : from.column + 1,
      row: edge.type === "hunsu" ? nextBranchRow(positions, from.row) : from.row
    });
  }
  const laneWidths = new Map<number, number>();
  for (const edge of edges) {
    if (edge.type !== "move") continue;
    const from = positions.get(String(edge.fromNodeId));
    const to = positions.get(String(edge.toNodeId));
    if (!from || !to || to.column <= from.column) continue;
    const laneWidth = connectionPlans.get(String(edge.id))?.display.laneWidth ?? graphLayout.column;
    for (let column = from.column; column < to.column; column += 1) {
      laneWidths.set(column, Math.max(laneWidths.get(column) ?? graphLayout.column, laneWidth));
    }
  }
  const maxColumn = Math.max(0, ...Array.from(positions.values()).map(position => position.column));
  const columnX = new Map<number, number>([[0, graphLayout.x]]);
  for (let column = 1; column <= maxColumn; column += 1) {
    const previousX = columnX.get(column - 1) ?? graphLayout.x;
    columnX.set(column, previousX + (laneWidths.get(column - 1) ?? graphLayout.column));
  }
  return sorted.map(node => {
    const position = positions.get(String(node.id)) ?? { column: 0, row: 0 };
    return { node, x: columnX.get(position.column) ?? graphLayout.x, y: graphLayout.y + position.row * graphLayout.row };
  });
}

function nextBranchRow(positions: Map<string, { column: number; row: number }>, sourceRow: number): number {
  const usedRows = new Set(Array.from(positions.values()).map(position => position.row));
  let row = sourceRow + 1;
  while (usedRows.has(row)) {
    row += 1;
  }
  return row;
}

function nodeSourceRank(node: NodeRecord): number {
  if (node.source.type === "initial-execute-team" || node.source.type === "request") return 0;
  if (node.source.type === "move") return 1;
  return 2;
}

function activeLineForRequest(board: BoardProjection, requestId: string | undefined): LineRecord | undefined {
  const lines = requestId ? board.lines.filter(line => String(line.requestId) === requestId) : board.lines;
  return lines.findLast(line => line.status === "active") ?? lines.at(-1);
}

function lineForNode(board: BoardProjection, node: NodeRecord): LineRecord | undefined {
  return board.lines.find(line => String(line.currentNodeId) === String(node.id))
    ?? board.lines.find(line => line.nodeIds.map(String).includes(String(node.id)))
    ?? (node.lineId ? board.lines.find(line => String(line.id) === String(node.lineId)) : undefined);
}

function destinationsForLine(board: BoardProjection, lineId: string): Destination[] {
  const line = board.lines.find(candidate => String(candidate.id) === lineId);
  const node = line?.currentNodeId ? board.nodes.find(candidate => String(candidate.id) === String(line.currentNodeId)) : undefined;
  return node?.destinations ?? board.destinations.filter(destination => !line || String(destination.requestId) === String(line.requestId));
}

function anchorMoveForNode(board: BoardProjection, node: NodeRecord): MoveRecord | undefined {
  const source = node.source;
  if (source.type === "move") {
    return board.moves.find(move => String(move.id) === String(source.moveId));
  }
  if (source.type === "initial-execute-team" || source.type === "request") {
    return undefined;
  }
  const hunsu = board.hunsus.find(candidate => String(candidate.id) === String(source.hunsuId));
  if (hunsu?.target.type === "move") {
    return board.moves.find(move => String(move.id) === String(hunsu.target.id));
  }
  const fromNode = board.nodes.find(candidate => String(candidate.id) === String(source.fromNodeId));
  return fromNode ? anchorMoveForNode(board, fromNode) : undefined;
}

function teamNameForNode(board: BoardProjection, node: NodeRecord, move?: MoveRecord): string {
  const line = lineForNode(board, node);
  return String(node.teamName ?? line?.teamName ?? move?.teamName ?? move?.snapshot?.teamName ?? "T1");
}

function isActiveRunStatus(status: StudioRunState["status"] | undefined): boolean {
  return status === "running" || status === "paused";
}

function agentSessionsForRun(sessions: AgentSession[], run: StudioRunState): AgentSession[] {
  return sessions.filter(session =>
    (session.routeRef.runId === run.runId || session.routeRef.executeId === run.executeId)
    || session.runId === run.runId
    || session.executeId === run.executeId
  );
}

function hasInlinePathSurface(run: StudioRunState): boolean {
  return isActiveRunStatus(run.status) || (run.executionPlanPlan?.length ?? 0) > 0 || (run.memberPathRuns?.length ?? 0) > 0;
}

function compareGraphRuns(left: StudioRunState, right: StudioRunState): number {
  const leftPriority = graphRunPriority(left);
  const rightPriority = graphRunPriority(right);
  if (leftPriority !== rightPriority) {
    return rightPriority - leftPriority;
  }
  return right.updatedAt.localeCompare(left.updatedAt);
}

function graphRunPriority(run: StudioRunState): number {
  if (isActiveRunStatus(run.status)) return 3;
  if (run.source === "live") return 2;
  if (run.source === "rehydrated") return 1;
  return 0;
}

function uniqueGraphRuns(runs: StudioRunState[]): StudioRunState[] {
  const seenExecuteIds = new Set<string>();
  return runs.filter(run => {
    if (seenExecuteIds.has(run.executeId)) {
      return false;
    }
    seenExecuteIds.add(run.executeId);
    return true;
  });
}

function isOpenDestination(destination: Destination): boolean {
  return destination.status === "pending" || destination.status === "claimed" || destination.status === "in_progress" || destination.status === "blocked";
}

function destinationPrioritySort(left: Destination, right: Destination): number {
  return (right.priority ?? 0) - (left.priority ?? 0);
}

function hunsuDeltaSummary(hunsu: HunsuRecord, board: BoardProjection): string {
  if (hunsu.changedFiles.length === 0) return "No runtime changes were recorded.";
  return hunsu.changedFiles.map(file => `${String(file.path)} (${String(file.kind)})`).join(" · ") || `${board.hunsus.length} HUNSU runtime changes`;
}

function pathsForRun(run: InlinePathRun): InlinePathRunPathState[] {
  if (run.executionPlanPlan && run.executionPlanPlan.length > 0) {
    return run.executionPlanPlan.map(path => {
      const pathRun = run.memberPathRuns?.find(item => pathKey(item) === path.id);
      return {
        ...path,
        ...pathRun,
        id: path.id,
        pathId: pathRun?.pathId ?? path.id,
        executorId: pathRun?.executorId ?? path.executorId,
        goal: pathRun?.goal ?? path.goal,
        requires: pathRun?.requires ?? path.requires,
        status: pathRun?.status ?? "planned"
      };
    });
  }
  if (run.memberPathRuns && run.memberPathRuns.length > 0) {
    return run.memberPathRuns;
  }
  return [];
}

function pathKey(path: InlinePathRunPathState): string {
  return path.pathId ?? path.id ?? "path";
}

function dependencyLabelsForPathPoint(
  run: InlinePathRun,
  point: InlinePathPoint,
  pathRun: InlinePathRunPathState | undefined
): string[] {
  const dependencyPathIds = pathRun?.dependencyPathIds?.filter(Boolean) ?? [];
  if (dependencyPathIds.length > 0) {
    return dependencyPathIds.map(pathId => dependencyLabel(pathId, run.pathCommits?.[pathId]));
  }
  const plannedRequires = run.executionPlanPlan?.find(item => item.id === point.pathId)?.requires;
  const requires = pathRun?.requires ?? plannedRequires;
  if (Array.isArray(requires)) {
    return requires.map(pathId => dependencyLabel(pathId, run.pathCommits?.[pathId]));
  }
  if (requires === "PrevMove" || !requires) {
    return [dependencyLabel("PrevMove", run.pathCommits?.PrevMove)];
  }
  return [requires];
}

function dependencyLabel(pathId: string, commit: string | undefined): string {
  return commit ? `${pathId} (${formatShortRef(commit)})` : pathId;
}

function pathProgressForRunStatus(status: InlinePathRunPathState["status"]): HunsuMoveProgress {
  if (status === "completed") return "Arrived";
  if (status === "starting" || status === "executing") return "Executing";
  if (status === "failed") return "Accident";
  return "Waiting";
}

function pathProgressForState(state: InlinePathCssState): HunsuMoveProgress {
  if (state === "done") return "Arrived";
  if (state === "running") return "Executing";
  if (state === "failed") return "Accident";
  return "Waiting";
}

function figmaProgressForRunStatus(status: InlinePathRunPathState["status"]): "Waiting" | "Running" | "Done" {
  if (status === "completed") return "Done";
  if (status === "starting" || status === "executing") return "Running";
  return "Waiting";
}

function figmaProgressForState(state: InlinePathCssState): "Waiting" | "Running" | "Done" {
  if (state === "done") return "Done";
  if (state === "running") return "Running";
  return "Waiting";
}

function cssStateForRunStatus(status: InlinePathRunPathState["status"]): InlinePathCssState {
  if (status === "completed") return "done";
  if (status === "starting" || status === "executing") return "running";
  if (status === "failed") return "failed";
  return "waiting";
}

function cssStateForPath(status: InlinePathRunPathState["status"], session: AgentSessionView | undefined): InlinePathCssState {
  if (session?.status === "done") return "done";
  if (session?.status === "failed") return "failed";
  if (session?.status === "running") return "running";
  return cssStateForRunStatus(status);
}

function edgeFromSourceToPlan(runId: string, sourceId: string, plan: InlinePlanScopeView, sourceCenter: { x: number; y: number }): InlinePathEdge {
  return {
    id: `${runId}:${sourceId}:${plan.id}`,
    fromId: sourceId,
    toId: plan.id,
    from: sourceCenter,
    to: { x: plan.x, y: plan.y + plan.width / 2 },
    kind: "path",
    progress: edgeProgressForCssState(plan.cssState),
    figmaState: plan.cssState === "done" ? "Complete" : "Pending",
    direction: edgeDirection(sourceCenter.y, plan.y + plan.width / 2),
    cssState: plan.cssState
  };
}

function edgeFromPlanToPoint(runId: string, plan: InlinePlanScopeView, to: InlinePathPoint): InlinePathEdge {
  return {
    id: `${runId}:${plan.id}:${to.id}`,
    fromId: plan.id,
    toId: to.id,
    from: { x: plan.x + plan.width, y: plan.y + plan.width / 2 },
    to: { x: to.x, y: to.y + 18 },
    kind: to.kind,
    progress: edgeProgressForPoint(to),
    figmaState: to.cssState === "done" ? "Complete" : "Pending",
    direction: edgeDirection(plan.y + plan.width / 2, to.y + 18),
    cssState: to.cssState
  };
}

function edgeBetweenPoints(runId: string, from: InlinePathPoint, to: InlinePathPoint, kind: InlinePathEdge["kind"]): InlinePathEdge {
  return {
    id: `${runId}:${from.id}:${to.id}`,
    fromId: from.id,
    toId: to.id,
    from: { x: from.x + 36, y: from.y + 18 },
    to: { x: to.x, y: to.y + 18 },
    kind,
    progress: edgeProgressForPoint(to),
    figmaState: to.cssState === "done" ? "Complete" : "Pending",
    direction: edgeDirection(from.y, to.y),
    cssState: to.cssState
  };
}

function edgeFromPointToMove(runId: string, from: InlinePathPoint, targetNodeId: string, targetCenter: { x: number; y: number }): InlinePathEdge {
  return {
    id: `${runId}:${from.id}:${targetNodeId}`,
    fromId: from.id,
    toId: targetNodeId,
    from: { x: from.x + 36, y: from.y + 18 },
    to: targetCenter,
    kind: "path",
    progress: "Done",
    figmaState: "Complete",
    direction: edgeDirection(from.y + 18, targetCenter.y),
    cssState: from.cssState === "failed" ? "failed" : "done"
  };
}

function edgeFromSourceToMove(runId: string, sourceId: string, targetNodeId: string, sourceCenter: { x: number; y: number }, targetCenter: { x: number; y: number }): InlinePathEdge {
  return {
    id: `${runId}:${sourceId}:${targetNodeId}`,
    fromId: sourceId,
    toId: targetNodeId,
    from: sourceCenter,
    to: targetCenter,
    kind: "path",
    progress: "Done",
    figmaState: "Complete",
    direction: edgeDirection(sourceCenter.y, targetCenter.y),
    cssState: "done"
  };
}

function edgeProgressForPoint(point: InlinePathPoint): InlinePathEdgeProgress {
  if (point.cssState === "done") return "Done";
  if (point.cssState === "running") return "Running";
  if (point.cssState === "failed") return "Failed";
  return "Waiting";
}

function edgeProgressForCssState(state: InlinePathCssState): InlinePathEdgeProgress {
  if (state === "done") return "Done";
  if (state === "running") return "Running";
  if (state === "failed") return "Failed";
  return "Waiting";
}

function edgeDirection(fromY: number, toY: number): "Level" | "Up" | "Down" {
  if (Math.abs(fromY - toY) < 12) return "Level";
  return toY < fromY ? "Up" : "Down";
}

export function fallbackArtifactActions(roadmapId: string): StudioArtifactAction[] {
  return [{
    id: `${roadmapId}-host-web` as StudioArtifactAction["id"],
    title: "Host Web" as StudioArtifactAction["title"],
    kind: "host",
    sourceScope: "move-or-commit",
    runner: { type: "docker_compose", file: "docker-compose.yml" as NonEmptyText, projectName: "hunsu-action-web" as NonEmptyText },
    aliases: {
      web: { service: "web" as NonEmptyText, containerPort: 5173 as PositiveInteger },
      api: { service: "api" as NonEmptyText, containerPort: 4187 as PositiveInteger }
    },
    displayOrder: 1
  }];
}

export const fallbackRuns: StudioRunState[] = [{
  runId: "run_handoff",
  executeId: "execute_handoff",
  requestId: "request_001",
  lineId: "line_main",
  provider: "codex",
  status: "running",
  selectedDestinationIds: ["destination_003"],
  sourceNodeId: "node_003",
  sourceMoveId: "move_003",
  targetMoveOrdinal: 4,
  attemptCount: 1,
  maxAttemptCount: 4,
  executionPlanPlan: [
    { id: "design", executorId: "faker", goal: "Translate Figma dashboard structure into native shadcn components.", requires: "PrevMove" },
    { id: "model", executorId: "canyon", goal: "Keep protocol and Bridge API contracts explicit.", requires: "PrevMove" },
    { id: "compose", executorId: "ruler", goal: "Assemble the Roadmap workspace without legacy CSS.", requires: ["design", "model"] }
  ],
  memberPathRuns: [
    { pathId: "design", executorId: "faker", goal: "Translate Figma dashboard structure into native shadcn components.", requires: "PrevMove", attempt: 1, status: "completed", session: { providerThreadId: "thread-design", providerTurnId: "turn-design" }, dependencyPathIds: [], dependencyOutputs: [], finalResponse: "Design path completed.", commit: "a11ce0000", startedAt: new Date().toISOString(), completedAt: new Date().toISOString() },
    { pathId: "model", executorId: "canyon", goal: "Keep protocol and Bridge API contracts explicit.", requires: "PrevMove", attempt: 1, status: "completed", session: { providerThreadId: "thread-model", providerTurnId: "turn-model" }, dependencyPathIds: [], dependencyOutputs: [], finalResponse: "Model path completed.", commit: "b10c0000", startedAt: new Date().toISOString(), completedAt: new Date().toISOString() },
    { pathId: "compose", executorId: "ruler", goal: "Assemble the Roadmap workspace without legacy CSS.", requires: ["design", "model"], attempt: 1, status: "executing", session: { providerThreadId: "thread-compose", providerTurnId: "turn-compose" }, dependencyPathIds: ["design", "model"], dependencyOutputs: [], startedAt: new Date().toISOString() }
  ],
  pathCommits: { PrevMove: "f00dbabe", design: "a11ce0000", model: "b10c0000" },
  liveStatus: { phase: "working", headline: "Composing dashboard", detail: "ExecutionPlan is running through shadcn primitives.", updatedAt: new Date().toISOString() },
  codexItems: [
    { itemId: "item_read", type: "tool", status: "completed", title: "Read docs", detail: "studio-gui, architecture, artifact-actions", updatedAt: new Date().toISOString() },
    { itemId: "item_build", type: "message", status: "streaming", title: "Build workspace shell", detail: "Roadmap graph and inspector are being composed.", updatedAt: new Date().toISOString() }
  ],
  startedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString()
}];

export const fallbackSkills: StudioSkillSummary[] = [
  { kind: "local-snapshot", name: "playwright-cli", sourcePath: "/workspace/.codex/skills/playwright-cli", contentHash: "hash-playwright", snapshotRef: "codex-skill:playwright", files: [{ path: "SKILL.md", size: 2400 }] }
] as StudioSkillSummary[];

export const fallbackWorktree: WorktreeStatus = {
  root: "/workspace/hunsu-project",
  branch: "feat/frontend-product",
  clean: true,
  changes: []
};

export const fallbackBoard = {
  origins: [],
  requests: [{
    id: "request_001",
    title: "Rebuild Hunsu Studio frontend",
    goal: "Regenerate the Studio dashboard from docs and Figma contracts using React, Vite, Tailwind, shadcn/ui, and lucide.",
    createdBy: "DIRECTOR",
    createdAt: new Date().toISOString()
  }],
  destinations: [
    destination("destination_001", "Map Studio launcher and folder health", "reached"),
    destination("destination_002", "Render Roadmap graph with Figma contracts", "reached"),
    destination("destination_003", "Project active Execute ExecutionPlan", "in_progress"),
    destination("destination_004", "Expose Artifact Action evidence", "pending"),
    destination("destination_005", "Restore automated handoff coverage", "pending")
  ],
  nodes: [
    node("node_000", 0, ["destination_001", "destination_002", "destination_003"], "initial-execute-team"),
    node("node_001", 1, ["destination_001", "destination_002", "destination_003"], "move"),
    node("node_002", 2, ["destination_001", "destination_002", "destination_003", "destination_004"], "move"),
    node("node_003", 3, ["destination_001", "destination_002", "destination_003", "destination_004", "destination_005"], "hunsu")
  ],
  edges: [
    edge("move_001", "node_000", "node_001", "move"),
    edge("move_002", "node_001", "node_002", "move"),
    edge("hunsu_001", "node_001", "node_003", "hunsu")
  ],
  lines: [{
    id: "line_main",
    requestId: "request_001",
    teamName: "T1",
    status: "active",
    rootNodeId: "node_000",
    currentNodeId: "node_003",
    nodeIds: ["node_000", "node_001", "node_002", "node_003"],
    moveIds: ["move_001", "move_002", "move_003"]
  }],
  moves: [
    move("move_001", "node_000", "node_001", 1, "arrived", "Launcher contract is mapped and registry health is visible.", ["destination_001"]),
    move("move_002", "node_001", "node_002", 2, "arrived", "Roadmap graph component contracts are stable.", ["destination_002"]),
    move("move_003", "node_001", "node_003", 3, "accident", "Artifact Action evidence needs a clearer alias-first panel.", [])
  ],
  hunsus: [{
    id: "hunsu_001",
    lineId: "line_main",
    fromNodeId: "node_001",
	    toNodeId: "node_003",
	    target: { type: "move", id: "move_001" },
	    summary: "Fork route with a shadcn-only implementation constraint.",
	    teamSnapshot: {
	      teamName: "T1",
	      moveOrdinal: 3,
	      destinations: fallbackBoardDestinations(["destination_001", "destination_002", "destination_003", "destination_004", "destination_005"]),
	      harness: sampleHarness(),
	      artifactActions: fallbackArtifactActions("fallback-roadmap")
	    },
	    changedFiles: [{ path: ".hunsu-request/destinations.json", kind: "updated", summary: "Destinations 1 added." }],
	    recordedBy: "DIRECTOR",
    recordedAt: new Date().toISOString()
  }],
  skillDrafts: [],
  artifacts: [],
  artifactActions: fallbackArtifactActions("fallback-roadmap"),
  futureConstraints: []
} as unknown as BoardProjection;

function destination(id: string, title: string, status: Destination["status"]) {
  return {
    id,
    title,
    requestId: "request_001",
    source: "initial-execute-team",
    createdBy: "DIRECTOR",
    updatedBy: "SYSTEM",
    status,
    ...(status === "reached" ? { reachedByMoveId: "move_002" } : {}),
    ...(status === "blocked" ? { blockedReason: "Needs Hunsu" } : {}),
    ...(status === "claimed" || status === "in_progress" ? { claimedBy: "execute_handoff" } : {})
  };
}

function node(id: string, ordinal: number, destinationIds: string[], sourceType: "initial-execute-team" | "move" | "hunsu") {
  const destinations = fallbackBoardDestinations(destinationIds);
  return {
    id,
    requestId: "request_001",
    lineId: "line_main",
    teamName: ordinal % 3 === 0 ? "T1" : ordinal % 3 === 1 ? "Hanwha Life Esports" : "Gen.G",
    ordinal,
    destinations,
    harness: sampleHarness(),
    artifactActions: fallbackArtifactActions("fallback-roadmap"),
    source: fallbackNodeSource(sourceType, ordinal),
    createdAt: new Date().toISOString()
  };
}

function fallbackNodeSource(sourceType: "initial-execute-team" | "move" | "hunsu", ordinal: number) {
  if (sourceType === "initial-execute-team") {
    return { type: "initial-execute-team", requestId: "request_001" };
  }
  if (sourceType === "hunsu") {
    return { type: "hunsu", hunsuId: "hunsu_001", fromNodeId: "node_001" };
  }
  return { type: "move", moveId: `move_00${ordinal}`, fromNodeId: `node_00${Math.max(0, ordinal - 1)}` };
}

function edge(id: string, fromNodeId: string, toNodeId: string, type: "move" | "hunsu") {
  return type === "move"
    ? { id, type, lineId: "line_main", fromNodeId, toNodeId, moveId: id }
    : { id, type, lineId: "line_main", fromNodeId, toNodeId, hunsuId: id };
}

function move(id: string, fromNodeId: string, toNodeId: string, ordinal: number, outcome: "arrived" | "accident", summary: string, reachedDestinationIds: string[]) {
  return {
    id,
    lineId: "line_main",
    fromNodeId,
    toNodeId,
    teamName: ordinal % 2 === 0 ? "Gen.G" : "T1",
    ordinal,
    summary,
    commit: `${id.replace("_", "")}0000000000000000000000000000000000`,
    evidence: ["Figma contract checked", "Bridge API contract preserved"],
    risks: [],
    recordedBy: "SYSTEM",
    recordedAt: new Date().toISOString(),
    outcome,
    reachedDestinationIds,
    ...(outcome === "accident" ? { failureReason: "Artifact Action panel did not show alias-first evidence." } : {})
  };
}

function fallbackBoardDestinations(ids: string[]) {
  const all = [
    destination("destination_001", "Map Studio launcher and folder health", "reached"),
    destination("destination_002", "Render Roadmap graph with Figma contracts", "reached"),
    destination("destination_003", "Project active Execute ExecutionPlan", "in_progress"),
    destination("destination_004", "Expose Artifact Action evidence", "pending"),
    destination("destination_005", "Restore automated handoff coverage", "pending")
  ];
  return all.filter(item => ids.includes(String(item.id)));
}

function sampleHarness() {
  return {
    kind: "team_execution_plan",
    maxAttemptCount: 4,
    team: { promptTemplate: samplePromptTemplate("Plan the next concrete Studio improvement.") },
    members: [
      { id: "faker", promptTemplate: samplePromptTemplate("Map product intent into UI contracts."), skills: [], model: "gpt-5.3-codex", reasoningEffort: "high", serviceTier: "default", execution: { kind: "worktree_write", network: "disabled" }, approval: { policy: "on_request", reviewer: "user" } },
      { id: "ruler", promptTemplate: samplePromptTemplate("Keep implementation narrow and verifiable."), skills: [], model: "codex-default", reasoningEffort: "medium", serviceTier: "default", execution: { kind: "worktree_write", network: "disabled" }, approval: { policy: "on_request", reviewer: "user" } },
      { id: "canyon", promptTemplate: samplePromptTemplate("Verify behavior and evidence."), skills: [], model: "codex-default", reasoningEffort: "medium", serviceTier: "default", execution: { kind: "worktree_write", network: "disabled" }, approval: { policy: "on_request", reviewer: "user" } }
    ]
  };
}

function samplePromptTemplate(template: string) {
  return { engine: "hunsu-template-v1" as const, template };
}
