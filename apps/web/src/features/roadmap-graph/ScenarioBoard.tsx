import type { CSSProperties, ReactNode } from "react";
import { GitBranch, Play, Route, Sparkles, TriangleAlert, Wand2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/shared/ui/badge";
import { figmaComponentNames } from "@/shared/design/figmaContracts";
import { teamToneMap } from "@/shared/design/teamTone";
import type { StudioRunState } from "@/shared/api/bridgeTypes";
import { buildRoadmapViewModel, fallbackBoard, fallbackSkills, fallbackWorktree, type RoadmapViewModel } from "@/shared/domain/roadmapViewModel";
import {
  componentMatrixNodes,
  moveCardViewFromScenario,
  type ScenarioConnection,
  type ScenarioExecuteOverlayNode,
  type ScenarioNode,
  type ScenarioPathNode,
  type StudioScenario
} from "@/shared/design/studioScenarios";
import { AgentChat, type AgentChatMessage } from "@/features/inspector/AgentChat";
import { NodeDetailPanel } from "@/features/inspector/NodeDetailPanel";
import { MoveCard } from "@/features/roadmap-graph/MoveCard";

type ScenarioMemberPathRun = NonNullable<StudioRunState["memberPathRuns"]>[number];

export function StoryCheckpointDock({ scenario, className }: { scenario: StudioScenario; className?: string }) {
  return (
    <section
      data-figma-component={figmaComponentNames.storyCheckpointDock}
      className={cn("rounded-2xl border border-[color:var(--studio-border-subtle)] bg-white/92 p-3 shadow-sm backdrop-blur", className)}
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-normal text-muted-foreground">Scenario {String(scenario.number).padStart(2, "0")} / 17</p>
          <h2 className="mt-1 truncate text-lg font-semibold">{scenario.title}</h2>
        </div>
        <Badge variant="outline" className="w-fit border-[color:var(--studio-execute-phase)] text-[color:var(--studio-execute-phase)]">
          {scenario.stage}
        </Badge>
      </div>
      <p className="mt-2 text-sm leading-5 text-muted-foreground">{scenario.description}</p>
    </section>
  );
}

export function TeamLegendFooter({ scenario, className }: { scenario: StudioScenario; className?: string }) {
  return (
    <footer
      data-figma-component={figmaComponentNames.teamLegendFooter}
      className={cn("flex flex-wrap items-center gap-2 rounded-2xl border border-[color:var(--studio-border-subtle)] bg-white/92 p-2 shadow-sm", className)}
    >
      {scenario.roster.map(item => {
        const tone = teamToneMap[item.team];
        return (
          <div key={item.team} className="flex min-w-40 items-center justify-between gap-3 rounded-xl border bg-background px-3 py-2 text-sm" style={{ "--team-color": tone.color } as CSSProperties}>
            <div className="flex min-w-0 items-center gap-2">
              <span className="size-2.5 rounded-full bg-[color:var(--team-color)]" />
              <span className="truncate font-medium">{item.team}</span>
            </div>
            <div className="flex items-center gap-1.5">
              <Badge variant={item.state === "Executing" ? "secondary" : item.state === "Arrived" ? "success" : item.state === "Accident" ? "destructive" : "outline"}>{item.state}</Badge>
              <span className="rounded-md bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{item.autopilot}</span>
            </div>
          </div>
        );
      })}
    </footer>
  );
}

export function ScenarioBoard({
  scenario,
  showComponentMatrix = false,
  showInspector = false,
  compactBranches = false,
  className
}: {
  scenario: StudioScenario;
  showComponentMatrix?: boolean;
  showInspector?: boolean;
  compactBranches?: boolean;
  className?: string;
}) {
  const nodes = compactBranches ? compactBranchNodes(showComponentMatrix ? componentMatrixNodes : scenario.nodes) : showComponentMatrix ? componentMatrixNodes : scenario.nodes;
  const connections = showComponentMatrix ? componentMatrixConnections : scenario.connections;
  const width = Math.max(1180, ...nodes.map(node => node.x + nodeWidth(node.kind) + 72));
  const height = Math.max(showComponentMatrix ? 560 : 440, ...nodes.map(node => node.y + nodeHeight(node.kind) + 72));
  const inspector = showInspector ? buildScenarioInspectorFixture(scenario) : undefined;
  const fallbackInspector = inspector
    ? buildRoadmapViewModel({
      roadmapId: "scenario-roadmap",
      board: fallbackBoard,
      runs: [],
      skills: fallbackSkills,
      worktree: fallbackWorktree,
      artifactActions: [],
      actionRuns: []
    }).inspector
    : undefined;

  return (
    <section className={cn("grid gap-3", className)}>
      <StoryCheckpointDock scenario={scenario} />
      <div className={cn("grid min-w-0 gap-3", inspector && "2xl:grid-cols-[minmax(0,1fr)_380px]")}>
        <div className="studio-canvas-grid studio-scrollbar relative min-w-0 overflow-auto rounded-2xl border border-[color:var(--studio-border-subtle)] bg-[color:var(--studio-canvas-tint)]">
          <div className="relative" style={{ width, height }}>
            <svg className="absolute inset-0" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
              {connections.map(connection => (
                <ScenarioConnector key={connection.id} connection={connection} nodes={nodes} />
              ))}
            </svg>
            {nodes.map(node => (
              <ScenarioNodeView key={node.id} node={node} selected={node.id === scenario.focusNodeId} />
            ))}
          </div>
        </div>
        {inspector ? (
          <aside className="grid min-w-0 gap-3 2xl:sticky 2xl:top-3 2xl:self-start">
            <div className="h-[620px] min-w-0 overflow-hidden rounded-2xl border border-[color:var(--studio-border-subtle)] bg-background shadow-sm">
              <NodeDetailPanel
                key={`scenario-inspector-${scenario.number}`}
                inspector={inspector.model.inspector ?? fallbackInspector!}
                className="border-l-0"
              />
            </div>
            <AgentChat messages={inspector.messages} />
          </aside>
        ) : null}
      </div>
      <TeamLegendFooter scenario={scenario} />
    </section>
  );
}

function ScenarioNodeView({ node, selected }: { node: ScenarioNode; selected: boolean }) {
  if (node.kind === "move") {
    return (
      <div className="absolute" style={{ left: node.x, top: node.y }}>
        <MoveCard card={moveCardViewFromScenario(node)} selected={selected || node.selected} />
      </div>
    );
  }
  if (node.kind === "executeOverlay") return <ExecuteOverlayNode node={node} selected={selected} />;
  if (node.kind === "executeButton") return <ExecuteButtonNode node={node} selected={selected} />;
  if (node.kind === "hunsu") return <HunsuCardNode node={node} selected={selected} />;
  return <AccidentCardNode node={node} selected={selected} />;
}

function ExecuteButtonNode({ node, selected }: { node: Extract<ScenarioNode, { kind: "executeButton" }>; selected: boolean }) {
  const tone = teamToneMap[node.team];
  return (
    <button
      type="button"
      data-figma-component={figmaComponentNames.executeButton}
      className={cn(
        "absolute flex w-[190px] items-center justify-between gap-3 rounded-2xl border bg-[color:var(--team-color)] px-4 py-3 text-left text-white shadow-md",
        selected && "ring-[3px] ring-[color-mix(in_oklab,var(--team-color),transparent_48%)]"
      )}
      style={{ left: node.x, top: node.y, "--team-color": tone.color } as CSSProperties}
    >
      <div className="min-w-0">
        <p className="text-xs text-white/72">Execute</p>
        <p className="truncate text-sm font-semibold">{node.target}</p>
        <p className="mt-1 truncate text-xs text-white/74">{node.destination}</p>
      </div>
      <Play className="size-5 shrink-0" />
    </button>
  );
}

function ExecuteOverlayNode({ node, selected }: { node: ScenarioExecuteOverlayNode; selected: boolean }) {
  const tone = teamToneMap[node.team];
  return (
    <article
      data-figma-component={figmaComponentNames.executeOverlay}
      data-phase={node.phase}
      className={cn(
        "absolute w-[386px] rounded-2xl border bg-[color-mix(in_oklab,var(--team-color),white_91%)] p-3 shadow-lg",
        selected && "ring-[3px] ring-[color-mix(in_oklab,var(--team-color),transparent_58%)]"
      )}
      style={{ left: node.x, top: node.y, "--team-color": tone.color } as CSSProperties}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase text-muted-foreground">Execute Overlay / {node.team}</p>
          <h3 className="mt-1 truncate text-lg font-semibold">{node.title}</h3>
        </div>
        <Badge variant="outline" className="border-[color:var(--studio-execute-phase)] text-[color:var(--studio-execute-phase)]">{node.phase}</Badge>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
        <InfoTile icon={<Route />} label="Source" value={node.sourceMove} />
        <InfoTile icon={<Play />} label="Target" value={node.targetMove} />
        <InfoTile icon={<GitBranch />} label="Worktree" value={node.worktreeHash ?? "pending"} />
        <InfoTile icon={<Wand2 />} label="Attempt" value={`${node.attempt} / ${node.budget}`} />
      </div>

      <div className="mt-3 rounded-xl border bg-white/72 p-2">
        <p className="text-xs font-semibold text-muted-foreground">Selected Destination</p>
        <p className="mt-1 text-sm font-medium">{node.selectedDestination}</p>
      </div>

      <ExecutionPlanPlan paths={node.paths} terminalPathId={node.terminalPathId} />
      <PathCommitMap paths={node.paths} sourceCommit="root" />
    </article>
  );
}

function ExecutionPlanPlan({ paths, terminalPathId }: { paths: ScenarioPathNode[]; terminalPathId?: string }) {
  return (
    <div data-figma-component={figmaComponentNames.executionPlanPlan} className="mt-3 rounded-xl border bg-white/78 p-2">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold text-muted-foreground">ExecutionPlan Plan</p>
        <Badge variant="muted">{paths.filter(path => path.state === "Committed" || path.state === "TerminalPass").length} / {paths.length}</Badge>
      </div>
      <div className="mt-2 grid gap-2">
        {paths.map(path => (
          <div key={path.id} className="flex items-center justify-between gap-2 rounded-lg border bg-background px-2 py-1.5 text-xs">
            <div className="flex min-w-0 items-center gap-2">
              <span className={cn("size-2 rounded-full", path.state === "Running" ? "bg-[color:var(--studio-execute-phase)]" : path.state === "Committed" || path.state === "TerminalPass" ? "bg-[color:var(--studio-commit)]" : "bg-muted-foreground/40")} />
              <span className="min-w-0 truncate font-medium">{path.member} {path.id}</span>
            </div>
            <span className="shrink-0 text-muted-foreground">{terminalPathId === path.id ? "terminal" : path.state}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function PathCommitMap({ paths, sourceCommit }: { paths: ScenarioPathNode[]; sourceCommit: string }) {
  return (
    <div data-figma-component={figmaComponentNames.pathCommitMapProgress} className="mt-3 rounded-xl border bg-white/78 p-2">
      <p className="text-xs font-semibold text-muted-foreground">Path Commit Map</p>
      <div className="mt-2 grid gap-1.5 text-xs">
        <CommitRow label="PrevMove" value={sourceCommit} state="Committed" />
        {paths.map(path => <CommitRow key={path.id} label={path.id} value={path.commit ?? "pending"} state={path.state} />)}
      </div>
    </div>
  );
}

function CommitRow({ label, value, state }: { label: string; value: string; state: string }) {
  return (
    <div className="grid grid-cols-[88px_minmax(0,1fr)_76px] items-center gap-2 rounded-md bg-muted/45 px-2 py-1">
      <span className="font-medium">{label}</span>
      <span className="truncate font-mono text-[11px] text-muted-foreground">{value}</span>
      <span className="truncate text-right text-muted-foreground">{state}</span>
    </div>
  );
}

function HunsuCardNode({ node, selected }: { node: Extract<ScenarioNode, { kind: "hunsu" }>; selected: boolean }) {
  return (
    <article
      data-figma-component={figmaComponentNames.hunsuCard}
      className={cn("absolute w-[214px] rounded-2xl border border-dashed border-[color:var(--studio-galio)] bg-white p-3 shadow-md", selected && "ring-[3px] ring-purple-300/70")}
      style={{ left: node.x, top: node.y }}
    >
      <div className="flex items-center gap-2">
        <Sparkles className="size-4 text-[color:var(--studio-galio)]" />
        <p className="text-sm font-semibold">HUNSU</p>
        <Badge variant="outline" className="ml-auto">{node.state}</Badge>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">From {node.sourceMove}</p>
      <div className="mt-3 grid gap-1.5">
        {node.destinations.map(destination => (
          <div key={destination.id} className="rounded-md border bg-muted/40 px-2 py-1 text-xs">{destination.title}</div>
        ))}
      </div>
    </article>
  );
}

function AccidentCardNode({ node, selected }: { node: Extract<ScenarioNode, { kind: "accident" }>; selected: boolean }) {
  return (
    <article
      data-figma-component={figmaComponentNames.accidentCard}
      className={cn("absolute w-[214px] rounded-2xl border border-[color:var(--studio-danger)] bg-[color:var(--studio-destination-failed)] p-3 text-white shadow-md", selected && "ring-[3px] ring-red-300/70")}
      style={{ left: node.x, top: node.y }}
    >
      <div className="flex items-center gap-2">
        <TriangleAlert className="size-4" />
        <p className="text-sm font-semibold">ACCIDENT</p>
        <Badge variant="destructive" className="ml-auto">{node.severity}</Badge>
      </div>
      <p className="mt-2 text-sm leading-5 text-white/80">{node.summary}</p>
      <div className="mt-3 grid gap-1.5">
        {node.destinations.map(destination => (
          <div key={destination.id} className="rounded-md border border-white/10 bg-white/10 px-2 py-1 text-xs">{destination.title}</div>
        ))}
      </div>
    </article>
  );
}

function ScenarioConnector({ connection, nodes }: { connection: ScenarioConnection; nodes: ScenarioNode[] }) {
  const from = nodes.find(node => node.id === connection.fromId);
  const to = nodes.find(node => node.id === connection.toId);
  if (!from || !to) return null;
  const fromPoint = { x: from.x + nodeWidth(from.kind), y: from.y + nodeHeight(from.kind) / 2 };
  const toPoint = { x: to.x, y: to.y + nodeHeight(to.kind) / 2 };
  const color = connection.kind === "HunsuFork" ? "var(--studio-galio)" : connection.kind === "Accident" ? "var(--studio-danger)" : "var(--team-color)";
  const dashed = connection.kind !== "Move" && connection.kind !== "TerminalPromotion";
  return (
    <g style={{ "--team-color": "var(--studio-faker)" } as CSSProperties}>
      <path
        d={`M ${fromPoint.x} ${fromPoint.y} C ${(fromPoint.x + toPoint.x) / 2} ${fromPoint.y}, ${(fromPoint.x + toPoint.x) / 2} ${toPoint.y}, ${toPoint.x} ${toPoint.y}`}
        fill="none"
        stroke={color}
        strokeWidth="2"
        strokeDasharray={dashed ? "6 6" : undefined}
        strokeLinecap="round"
      />
      {connection.label ? (
        <text x={(fromPoint.x + toPoint.x) / 2 - 34} y={(fromPoint.y + toPoint.y) / 2 - 8} className="fill-muted-foreground text-[11px]">
          {connection.label}
        </text>
      ) : null}
    </g>
  );
}

function InfoTile({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-lg border bg-white/72 p-2">
      <div className="flex items-center gap-1.5 text-muted-foreground [&_svg]:size-3.5">
        {icon}
        <span>{label}</span>
      </div>
      <p className="mt-1 truncate font-medium">{value}</p>
    </div>
  );
}

function buildScenarioInspectorFixture(scenario: StudioScenario): { model: RoadmapViewModel; messages: AgentChatMessage[] } {
  const messages = buildScenarioMessages(scenario);
  const activeRun = buildScenarioRun(scenario);
  const runs = activeRun ? [{ ...activeRun, sourceNodeId: "node_003", sourceMoveId: "move_003" }] : [];
  const panel = scenario.detailState === "Executing" ? "execute" : scenario.detailState === "HunsuDraft" ? "hunsu" : "move";

  return {
    messages,
    model: buildRoadmapViewModel({
      roadmapId: "scenario-roadmap",
      board: fallbackBoard,
      runs,
      skills: fallbackSkills,
      worktree: fallbackWorktree,
      artifactActions: [],
      actionRuns: [],
      selection: panel === "execute" && activeRun ? { kind: "execute", executeId: activeRun.executeId } : { kind: "move", nodeId: "node_003" },
      panel
    })
  };
}

function buildScenarioRun(scenario: StudioScenario): StudioRunState | undefined {
  const overlay = scenario.nodes.find((node): node is ScenarioExecuteOverlayNode => node.kind === "executeOverlay");
  if (!overlay) return undefined;
  const now = new Date(0).toISOString();
  const status: StudioRunState["status"] = scenario.stage === "ArrivedMoveInspectable" ? "arrived" : overlay.phase === "Accident" ? "accident" : "running";

  return {
    runId: `scenario-run-${scenario.number}`,
    executeId: overlay.id,
    requestId: "scenario-request",
    lineId: "scenario-line",
    provider: "codex",
    status,
    selectedDestinationIds: ["scenario-destination"],
    sourceNodeId: "move-0",
    sourceMoveId: "move-0",
    targetMoveOrdinal: 1,
    attemptCount: Number(overlay.attempt),
    maxAttemptCount: Number(overlay.budget),
    executionPlanPlan: overlay.paths.map(path => ({
      id: path.id,
      executorId: path.member.toLowerCase(),
      goal: path.goal,
      requires: path.requires
    })),
    memberPathRuns: overlay.paths.map(path => scenarioPathRun(path, scenario.number, now)),
    terminalMemberPathId: overlay.terminalPathId,
    terminalPathCommit: overlay.paths.find(path => path.id === overlay.terminalPathId)?.commit,
    pathCommits: Object.fromEntries(overlay.paths.flatMap(path => path.commit ? [[path.id, path.commit]] : [])),
    liveStatus: {
      phase: status === "arrived" ? "idle" : "working",
      headline: overlay.phase,
      detail: scenario.description,
      updatedAt: now
    },
    codexItems: [
      {
        itemId: `scenario-${scenario.number}-phase`,
        type: "message",
        status: status === "arrived" ? "completed" : "streaming",
        title: overlay.phase,
        detail: scenario.description,
        updatedAt: now
      },
      {
        itemId: `scenario-${scenario.number}-path`,
        type: "tool",
        status: "completed",
        title: scenario.focusedPath ? `Path ${scenario.focusedPath}` : "ExecutionPlan",
        detail: overlay.selectedDestination,
        updatedAt: now
      }
    ],
    startedAt: now,
    updatedAt: now
  };
}

function scenarioPathRun(path: ScenarioPathNode, scenarioNumber: number, now: string): ScenarioMemberPathRun {
  const base = {
    pathId: path.id,
    executorId: path.member.toLowerCase(),
    goal: path.goal,
    requires: path.requires,
    attempt: 1,
    dependencyPathIds: Array.isArray(path.requires) ? path.requires : [],
    dependencyOutputs: [],
    startedAt: now
  };
  const session = {
    providerThreadId: `scenario-thread-${scenarioNumber}-${path.id}`,
    providerTurnId: `scenario-turn-${scenarioNumber}-${path.id}`
  };
  if (path.state === "Running") {
    return { ...base, status: "executing", session };
  }
  if (path.state === "Committed" || path.state === "TerminalPass") {
    return { ...base, status: "completed", session, finalResponse: `${path.id} complete`, commit: path.commit, completedAt: now };
  }
  if (path.state === "TerminalFail") {
    return { ...base, status: "failed", session, error: "Scenario terminal failure", commit: path.commit, completedAt: now };
  }
  return { ...base, status: "planned" };
}

function buildScenarioMessages(scenario: StudioScenario): AgentChatMessage[] {
  return [
    {
      id: `scenario-${scenario.number}-team`,
      speaker: "Team",
      title: scenario.title,
      text: scenario.description,
      status: scenario.detailState === "Executing" ? "Running" : "Done",
      meta: scenario.stage
    },
    {
      id: `scenario-${scenario.number}-manager`,
      speaker: "Manager",
      title: scenario.focusedPath ? `Focused Path ${scenario.focusedPath}` : "Route context",
      text: scenario.focusedExecutePhase ?? "MOVE snapshot is ready for inspection.",
      status: scenario.focusedPath ? "Running" : "Waiting",
      meta: scenario.detailState
    }
  ];
}

function compactBranchNodes(nodes: ScenarioNode[]): ScenarioNode[] {
  return nodes.map(node => {
    if (node.kind === "accident" && node.x > 820) {
      return { ...node, x: 760, y: node.y + 202 };
    }
    return node;
  });
}

const componentMatrixConnections: ScenarioConnection[] = [
  { id: "matrix-execute", fromId: "move-0", toId: "execute-button", kind: "ExecuteButton" },
  { id: "matrix-overlay", fromId: "execute-button", toId: "execute-overlay", kind: "ExecuteExecution", label: "Execute" },
  { id: "matrix-hunsu", fromId: "execute-overlay", toId: "hunsu-draft", kind: "HunsuFork" },
  { id: "matrix-accident", fromId: "execute-overlay", toId: "accident", kind: "Accident" }
];

function nodeWidth(kind: ScenarioNode["kind"]): number {
  if (kind === "executeOverlay") return 386;
  if (kind === "executeButton") return 190;
  return kind === "move" ? 210 : 214;
}

function nodeHeight(kind: ScenarioNode["kind"]): number {
  if (kind === "executeOverlay") return 620;
  if (kind === "executeButton") return 82;
  if (kind === "move") return 404;
  return 190;
}
