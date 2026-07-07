import { teamToneMap, teamToneForName } from "@/shared/design/teamTone";
import type { FigmaTeamTone, HunsuMoveProgress } from "@/shared/design/figmaContracts";
import type { MoveCardView } from "@/shared/domain/roadmapViewModel";

export type StoryStage =
  | "RoadmapCreated"
  | "InitialMoveSelected"
  | "ExecuteQueued"
  | "ExecuteOverlayAppears"
  | "TeamMaterializingExecutionPlan"
  | "ExecutionPlanReady"
  | "FirstPathAvailable"
  | "FirstPathRunning"
  | "FirstPathCommitted"
  | "DependentPathsAvailable"
  | "DependentPathRunning"
  | "DependentPathCommitted"
  | "TerminalPathAvailable"
  | "TerminalPathRunning"
  | "TerminalPathPassed"
  | "TerminalCommitPromoted"
  | "ArrivedMoveInspectable";

export type ScenarioConnectionKind =
  | "Move"
  | "ExecuteExecution"
  | "PathDependency"
  | "PathCommit"
  | "TerminalPromotion"
  | "HunsuFork"
  | "ExecuteButton"
  | "Accident";

export type ScenarioPathState = "Waiting" | "Available" | "Running" | "Committed" | "TerminalPass" | "TerminalFail";
export type ScenarioExecutePhase =
  | "Queued"
  | "Materializing ExecutionPlan"
  | "ExecutionPlan ready"
  | "Running Path"
  | "Recording Path commit"
  | "Promoting terminal commit"
  | "Arrived"
  | "Accident";

export type ScenarioDestination = {
  id: string;
  title: string;
  state: "reached" | "left" | "focus" | "failed";
};

export type ScenarioPathNode = {
  id: string;
  member: "Planner" | "Builder" | "Verifier";
  tone: FigmaTeamTone;
  goal: string;
  requires: "PrevMove" | string[];
  state: ScenarioPathState;
  commit?: string;
};

export type ScenarioMoveNode = {
  kind: "move";
  id: string;
  x: number;
  y: number;
  team: FigmaTeamTone;
  ordinal: number;
  progress: HunsuMoveProgress;
  snapshotKind: "InitialMove" | "RecordedMove" | "HunsuCreatedSamePosition";
  summary: string;
  sourceCommit?: string;
  terminalPathCommit?: string;
  pathCommitCount: number;
  destinations: ScenarioDestination[];
  selected?: boolean;
  hunsuForked?: boolean;
};

export type ScenarioExecuteOverlayNode = {
  kind: "executeOverlay";
  id: string;
  x: number;
  y: number;
  team: FigmaTeamTone;
  title: string;
  phase: ScenarioExecutePhase;
  sourceMove: string;
  targetMove: string;
  attempt: string;
  budget: string;
  worktreeHash?: string;
  conversationHash?: string;
  selectedDestination: string;
  paths: ScenarioPathNode[];
  terminalPathId?: string;
};

export type ScenarioExecuteButtonNode = {
  kind: "executeButton";
  id: string;
  x: number;
  y: number;
  team: FigmaTeamTone;
  target: string;
  destination: string;
};

export type ScenarioHunsuNode = {
  kind: "hunsu";
  id: string;
  x: number;
  y: number;
  team: FigmaTeamTone;
  state: "Draft" | "Arrived";
  sourceMove: string;
  destinations: ScenarioDestination[];
};

export type ScenarioAccidentNode = {
  kind: "accident";
  id: string;
  x: number;
  y: number;
  team: FigmaTeamTone;
  severity: "Notice" | "Warning" | "Critical";
  summary: string;
  destinations: ScenarioDestination[];
};

export type ScenarioNode =
  | ScenarioMoveNode
  | ScenarioExecuteOverlayNode
  | ScenarioExecuteButtonNode
  | ScenarioHunsuNode
  | ScenarioAccidentNode;

export type ScenarioConnection = {
  id: string;
  fromId: string;
  toId: string;
  kind: ScenarioConnectionKind;
  label?: string;
};

export type StudioScenario = {
  number: number;
  stage: StoryStage;
  title: string;
  description: string;
  pacing: "SlowStepThroughMoveExecution" | "NormalRouteEditing";
  nodes: ScenarioNode[];
  connections: ScenarioConnection[];
  focusNodeId: string;
  focusedExecutePhase?: ScenarioExecutePhase;
  focusedPath?: string;
  detailState: "Move" | "Executing" | "HunsuDraft" | "Path";
  roster: Array<{ team: FigmaTeamTone; state: "Ready" | "Accident" | "Executing" | "Arrived"; autopilot: "AutoOff" | "AutoOn" }>;
};

const stages: StoryStage[] = [
  "RoadmapCreated",
  "InitialMoveSelected",
  "ExecuteQueued",
  "ExecuteOverlayAppears",
  "TeamMaterializingExecutionPlan",
  "ExecutionPlanReady",
  "FirstPathAvailable",
  "FirstPathRunning",
  "FirstPathCommitted",
  "DependentPathsAvailable",
  "DependentPathRunning",
  "DependentPathCommitted",
  "TerminalPathAvailable",
  "TerminalPathRunning",
  "TerminalPathPassed",
  "TerminalCommitPromoted",
  "ArrivedMoveInspectable"
];

const destinationCopy = {
  setup: "Map Studio launcher and folder health",
  graph: "Render Roadmap graph with Figma contracts",
  execute: "Project active Execute ExecutionPlan",
  preview: "Expose Artifact Action evidence"
};

const pathBlueprints: Array<Omit<ScenarioPathNode, "state" | "commit">> = [
  { id: "plan", member: "Planner", tone: "Gen.G", goal: "Plan the smallest dashboard progression surface.", requires: "PrevMove" },
  { id: "build", member: "Builder", tone: "T1", goal: "Implement the graph node and shell components.", requires: ["plan"] },
  { id: "verify", member: "Verifier", tone: "Hanwha Life Esports", goal: "Check visual parity and runtime evidence.", requires: ["plan", "build"] }
];

const stageTitles: Record<StoryStage, string> = {
  RoadmapCreated: "Roadmap is created",
  InitialMoveSelected: "Initial MOVE is selected",
  ExecuteQueued: "Execute button appears",
  ExecuteOverlayAppears: "Execute overlay is visible",
  TeamMaterializingExecutionPlan: "Team materializes ExecutionPlan",
  ExecutionPlanReady: "ExecutionPlan is ready",
  FirstPathAvailable: "First Path is available",
  FirstPathRunning: "First Path is running",
  FirstPathCommitted: "First Path commits",
  DependentPathsAvailable: "Dependent Paths are available",
  DependentPathRunning: "Dependent Path is running",
  DependentPathCommitted: "Dependent Path commits",
  TerminalPathAvailable: "Terminal Path is available",
  TerminalPathRunning: "Terminal Path is running",
  TerminalPathPassed: "Terminal Path passes",
  TerminalCommitPromoted: "Terminal commit is promoted",
  ArrivedMoveInspectable: "Arrived MOVE is inspectable"
};

export const studioScenarios: StudioScenario[] = stages.map((stage, index) => makeScenario(index + 1, stage));

export const componentMatrixNodes: ScenarioNode[] = [
  moveNode(0, { x: 28, y: 36, selected: true }),
  moveNode(1, { x: 272, y: 36, progress: "Arrived", sourceCommit: "a11ce000", pathCommitCount: 2 }),
  moveNode(2, { x: 516, y: 36, progress: "Accident", summary: "Artifact Action evidence missed alias health.", sourceCommit: "badc0de", pathCommitCount: 1 }),
  executeButtonNode({ x: 28, y: 318 }),
  executeOverlayNode({
    x: 272,
    y: 258,
    phase: "Running Path",
    paths: pathStates(11)
  }),
  hunsuNode({ x: 760, y: 258 }),
  accidentNode({ x: 1004, y: 258 })
];

export function scenarioByNumber(value: number | undefined): StudioScenario {
  if (!value) return studioScenarios[0];
  return studioScenarios[Math.min(Math.max(value, 1), studioScenarios.length) - 1];
}

export function moveCardViewFromScenario(node: ScenarioMoveNode): MoveCardView {
  const tone = teamToneForName(node.team);
  const reached = node.destinations.filter(destination => destination.state === "reached").length;
  const left = node.destinations.filter(destination => destination.state !== "reached").length;
  return {
    id: node.id,
    nodeId: node.id,
    moveId: node.ordinal > 0 ? `move_${String(node.ordinal).padStart(4, "0")}` : undefined,
    ordinal: node.ordinal,
    title: `${node.team} M${String(node.ordinal).padStart(4, "0")}`,
    teamName: node.team,
    teamTone: node.team,
    teamColor: teamToneMap[tone].color,
    statusLabel: node.progress === "Waiting" ? "READY" : node.progress.toUpperCase(),
    summary: node.summary,
    progress: node.progress,
    destinations: node.destinations.map(destination => ({
      id: destination.id,
      title: destination.title,
      state: destination.state === "reached" ? "reached" : destination.state === "failed" ? "blocked" : destination.state === "focus" ? "next" : "open"
    })),
    harnessLabel: "Team + ExecutionPlan",
    memberLabel: "planner, builder, verifier",
    skillCountLabel: "3 Paths",
    modelLabel: "codex / high",
    remainingDestinationCount: left,
    commit: node.sourceCommit,
    terminalPathCommit: node.terminalPathCommit,
    pathCommitCount: node.pathCommitCount,
    reachedWindowLabel: `${reached} reached`,
    leftWindowLabel: `${left} left`,
    snapshotKind: node.snapshotKind,
    hunsuForked: Boolean(node.hunsuForked)
  };
}

function makeScenario(number: number, stage: StoryStage): StudioScenario {
  const paths = pathStates(number);
  const nodes: ScenarioNode[] = [
    moveNode(0, { selected: number <= 3 || number === 17 })
  ];
  const connections: ScenarioConnection[] = [];

  if (number <= 3) {
    nodes.push(executeButtonNode({ active: number === 3 }));
    connections.push({ id: "m0-execute-button", fromId: "move-0", toId: "execute-button", kind: "ExecuteButton" });
  } else if (number < 16) {
    nodes.push(executeOverlayNode({ phase: executePhaseForScenario(number), paths }));
    connections.push({ id: "m0-execute", fromId: "move-0", toId: "execute-overlay", kind: "ExecuteExecution", label: executePhaseForScenario(number) });
  } else {
    nodes.push(executeOverlayNode({ phase: executePhaseForScenario(number), paths }));
    nodes.push(moveNode(1, {
      x: 760,
      y: 92,
      progress: number === 17 ? "Arrived" : "Waiting",
      selected: number === 17,
      sourceCommit: number === 17 ? "9f34d12" : undefined,
      terminalPathCommit: number >= 16 ? "9f34d12" : undefined,
      pathCommitCount: 3,
      summary: number === 17 ? "Dashboard progression can be inspected as MOVE result." : "Pending target MOVE"
    }));
    connections.push({ id: "m0-execute", fromId: "move-0", toId: "execute-overlay", kind: "ExecuteExecution", label: executePhaseForScenario(number) });
    connections.push({ id: "terminal-promotion", fromId: "execute-overlay", toId: "move-1", kind: "TerminalPromotion", label: "promote terminal commit" });
    if (number === 17) {
      nodes.push(hunsuNode({ id: "hunsu-alt", x: 760, y: 560, sourceMove: "Gen.G M0001" }));
      nodes.push(accidentNode({ id: "accident-alt", x: 904, y: 560 }));
      nodes.push(executeButtonNode({ id: "execute-button-alt", x: 520, y: 610, target: "Gen.G D0002", destination: "Fork or repair next route" }));
      connections.push({ id: "arrived-execute-button", fromId: "move-1", toId: "execute-button-alt", kind: "ExecuteButton" });
      connections.push({ id: "arrived-hunsu", fromId: "move-1", toId: "hunsu-alt", kind: "HunsuFork" });
      connections.push({ id: "arrived-accident", fromId: "move-1", toId: "accident-alt", kind: "Accident" });
    }
  }

  return {
    number,
    stage,
    title: stageTitles[stage],
    description: descriptionForScenario(number, stage),
    pacing: "SlowStepThroughMoveExecution",
    nodes,
    connections,
    focusNodeId: number === 17 ? "move-1" : number >= 4 ? "execute-overlay" : "move-0",
    focusedExecutePhase: number >= 3 ? executePhaseForScenario(number) : undefined,
    focusedPath: focusedPathForScenario(number),
    detailState: number >= 4 && number < 17 ? "Executing" : "Move",
    roster: [
      { team: "T1", state: number >= 4 && number < 17 ? "Executing" : number === 17 ? "Arrived" : "Ready", autopilot: "AutoOn" },
      { team: "Gen.G", state: "Ready", autopilot: "AutoOff" },
      { team: "Hanwha Life Esports", state: "Ready", autopilot: "AutoOff" }
    ]
  };
}

function moveNode(ordinal: number, overrides: Partial<ScenarioMoveNode> = {}): ScenarioMoveNode {
  const team = ordinal % 3 === 0 ? "T1" : ordinal % 3 === 1 ? "Gen.G" : "Hanwha Life Esports";
  return {
    kind: "move",
    id: `move-${ordinal}`,
    x: ordinal === 0 ? 72 : 760,
    y: 92,
    team,
    ordinal,
    progress: ordinal === 0 ? "Waiting" : "Arrived",
    snapshotKind: ordinal === 0 ? "InitialMove" : "RecordedMove",
    summary: ordinal === 0 ? "Initial immutable Team snapshot." : "Recorded route result.",
    sourceCommit: ordinal === 0 ? "root" : "a11ce000",
    terminalPathCommit: undefined,
    pathCommitCount: ordinal === 0 ? 0 : 3,
    destinations: [
      { id: "d1", title: destinationCopy.setup, state: ordinal > 0 ? "reached" : "focus" },
      { id: "d2", title: destinationCopy.graph, state: ordinal > 0 ? "reached" : "left" },
      { id: "d3", title: destinationCopy.execute, state: "left" }
    ],
    ...overrides
  };
}

function executeButtonNode(overrides: Partial<ScenarioExecuteButtonNode> & { active?: boolean } = {}): ScenarioExecuteButtonNode {
  return {
    kind: "executeButton",
    id: "execute-button",
    x: 344,
    y: 142,
    team: "T1",
    target: "T1 D0001",
    destination: overrides.active ? destinationCopy.execute : "Create next Execute",
    ...overrides
  };
}

function executeOverlayNode(overrides: Partial<ScenarioExecuteOverlayNode> = {}): ScenarioExecuteOverlayNode {
  return {
    kind: "executeOverlay",
    id: "execute-overlay",
    x: 344,
    y: 52,
    team: "T1",
    title: "T1 D0001",
    phase: "Queued",
    sourceMove: "T1 M0000",
    targetMove: "T1 M0001",
    attempt: "1",
    budget: "4",
    worktreeHash: "wt-6af92",
    conversationHash: "conv-19ec",
    selectedDestination: destinationCopy.execute,
    paths: pathStates(4),
    ...overrides
  };
}

function hunsuNode(overrides: Partial<ScenarioHunsuNode> = {}): ScenarioHunsuNode {
  return {
    kind: "hunsu",
    id: "hunsu-draft",
    x: 760,
    y: 258,
    team: "G2 Esports",
    state: "Draft",
    sourceMove: "T1 M0001",
    destinations: [
      { id: "hd1", title: "Tighten preview evidence", state: "focus" },
      { id: "hd2", title: "Keep source MOVE immutable", state: "left" }
    ],
    ...overrides
  };
}

function accidentNode(overrides: Partial<ScenarioAccidentNode> = {}): ScenarioAccidentNode {
  return {
    kind: "accident",
    id: "accident",
    x: 1004,
    y: 258,
    team: "Gen.G",
    severity: "Warning",
    summary: "Artifact Action evidence did not expose alias-first health.",
    destinations: [
      { id: "ad1", title: destinationCopy.preview, state: "failed" },
      { id: "ad2", title: "Repair runtime contract", state: "focus" }
    ],
    ...overrides
  };
}

function pathStates(number: number): ScenarioPathNode[] {
  const plan = stateByThreshold(number, 7, 8, 9);
  const build = stateByThreshold(number, 10, 11, 12);
  const verify = number >= 15 ? "TerminalPass" : stateByThreshold(number, 13, 14, 15);
  return pathBlueprints.map(path => {
    const state = path.id === "plan" ? plan : path.id === "build" ? build : verify;
    return {
      ...path,
      state,
      commit: state === "Committed" || state === "TerminalPass" ? commitForPath(path.id) : undefined
    };
  });
}

function stateByThreshold(number: number, availableAt: number, runningAt: number, committedAt: number): ScenarioPathState {
  if (number >= committedAt) return "Committed";
  if (number >= runningAt) return "Running";
  if (number >= availableAt) return "Available";
  return "Waiting";
}

function executePhaseForScenario(number: number): ScenarioExecutePhase {
  if (number <= 3) return "Queued";
  if (number === 4) return "Queued";
  if (number === 5) return "Materializing ExecutionPlan";
  if (number === 6 || number === 7) return "ExecutionPlan ready";
  if (number === 8 || number === 11 || number === 14) return "Running Path";
  if (number === 9 || number === 12) return "Recording Path commit";
  if (number === 15) return "Promoting terminal commit";
  if (number >= 16) return "Arrived";
  return "Running Path";
}

function focusedPathForScenario(number: number): string | undefined {
  if (number >= 7 && number <= 9) return "plan";
  if (number >= 10 && number <= 12) return "build";
  if (number >= 13 && number <= 15) return "verify";
  return undefined;
}

function descriptionForScenario(number: number, stage: StoryStage): string {
  if (number === 1) return "The dashboard starts with the immutable initial MOVE and a compact context shell.";
  if (number === 3) return "Selecting the initial MOVE exposes the Execute affordance for the next MOVE.";
  if (number >= 4 && number < 16) return "The Execute overlay narrates ExecutionPlan planning, Member execution, and commit-map progress.";
  if (number === 16) return "The terminal Path commit is promoted into the target MOVE position.";
  if (number === 17) return "The arrived MOVE is inspectable with immutable evidence and route context.";
  return stageTitles[stage];
}

function commitForPath(pathId: string): string {
  if (pathId === "plan") return "a11ce000";
  if (pathId === "build") return "b10c000";
  return "9f34d12";
}
