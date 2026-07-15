import { useEffect, useMemo, useRef, useState } from "react";
import { useInfiniteQuery, type InfiniteData } from "@tanstack/react-query";
import {
  Background,
  BackgroundVariant,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  Handle,
  MiniMap,
  MarkerType,
  Position,
  ReactFlow,
  getBezierPath,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
  type ReactFlowInstance
} from "@xyflow/react";
import { AlertTriangle, CheckCircle2, Expand, List, Loader2, Network, Search } from "lucide-react";
import { projectGraphPath, projectNodePath, pushAppPath } from "@/app/routes";
import { graphEdgeLabel, validateGraphTopology, type GraphTopologyResult } from "@/features/node-graph/graphModel";
import {
  GRAPH_EDGE_LABEL_MAX_WIDTH,
  GRAPH_NODE_HEIGHT,
  GRAPH_NODE_WIDTH
} from "@/features/node-graph/layoutMetrics";
import { fallbackGraphLayout } from "@/features/node-graph/fallbackGraphLayout";
import { startGraphLayout } from "@/features/node-graph/graphLayout";
import type { GraphLayoutRequest, PositionedGraphNode } from "@/features/node-graph/layoutTypes";
import { NodeInspector } from "@/features/node-graph/NodeInspector";
import { cn } from "@/lib/utils";
import { apiErrorMessage } from "@/shared/api/client";
import { pollingQueryOptions } from "@/shared/api/polling";
import { fetchProjectGraph } from "@/shared/api/projectApi";
import type { GraphEdge, GraphNodeSummary, ProjectGraphResponse, ProjectIntegrity } from "@/shared/api/types";
import { repositoryLabel, shortSha } from "@/shared/format";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { PageError, PageLoading, PageRefreshWarning } from "@/shared/ui/page-state";
import "@xyflow/react/dist/style.css";

type GraphView = "canvas" | "outline";
type HunsuNodeData = Record<string, unknown> & { summary: GraphNodeSummary };
type HunsuFlowNode = Node<HunsuNodeData, "hunsuNode">;
type HunsuEdgeData = Record<string, unknown> & { kind: GraphEdge["kind"]; label: string };
type HunsuFlowEdge = Edge<HunsuEdgeData, "hunsuEdge">;

const nodeTypes = { hunsuNode: HunsuNodeCard };
const edgeTypes = { hunsuEdge: HunsuGraphEdge };
const DESKTOP_INSPECTOR_FIT_PADDING = "430px";

export function NodeGraphScreen({ projectId, selectedNodeSha }: { projectId: string; selectedNodeSha: string | null }) {
  const [view, setView] = useState<GraphView>("canvas");
  const [search, setSearch] = useState("");
  const fullscreenRef = useRef<HTMLElement>(null);
  const inspectorFocusReturnRef = useRef<HTMLElement | null>(null);
  const query = useInfiniteQuery({
    queryKey: ["projects", projectId, "graph", "v2"],
    queryFn: ({ pageParam, signal }) => fetchProjectGraph(projectId, pageParam, signal),
    initialPageParam: null as string | null,
    getNextPageParam: page => page.window.continuationCursor ?? undefined,
    ...pollingQueryOptions<InfiniteData<ProjectGraphResponse>>({
      activeIntervalMs: 10_000,
      stableIntervalMs: 60_000,
      isActive: data => data.pages.some(page => page.activeRuns.length > 0)
    })
  });
  const graph = useMemo(() => mergeGraphPages(query.data?.pages ?? []), [query.data?.pages]);

  if (query.isLoading) return <PageLoading label="Reconstructing Node graph…" />;
  if (!graph) return <PageError message={apiErrorMessage(query.error, "The Node graph is unavailable.")} onRetry={() => void query.refetch()} />;

  const localTopology = validateGraphTopology(graph.nodes, graph.edges, graph.project.rootNodeSha);
  const integrity = effectiveIntegrity(graph.integrity, localTopology, graph.stateHeadsAgree, graph.projectSummariesAgree);
  const matchingNode = findNode(graph.nodes, search);

  function submitSearch(event: React.FormEvent) {
    event.preventDefault();
    if (matchingNode) openNode(matchingNode.sha);
  }

  function openNode(sha: string) {
    const activeElement = document.activeElement;
    inspectorFocusReturnRef.current = activeElement instanceof HTMLElement ? activeElement : null;
    pushAppPath(projectNodePath(projectId, sha));
  }

  function closeInspector() {
    const focusReturn = inspectorFocusReturnRef.current;
    inspectorFocusReturnRef.current = null;
    pushAppPath(projectGraphPath(projectId));
    window.requestAnimationFrame(() => focusReturn?.focus());
  }

  return (
    <main ref={fullscreenRef} className="relative h-[calc(100vh-3.5rem)] min-h-[560px] overflow-hidden bg-white lg:h-screen" aria-label={`${graph.project.title} Node graph`}>
      <header className="relative z-10 flex min-h-[72px] flex-wrap items-center gap-3 border-b bg-white/88 px-4 py-3 backdrop-blur-xl sm:px-6">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2 text-[15px]">
            <button type="button" className="truncate font-semibold hover:text-[color:var(--apple-blue)]" onClick={() => pushAppPath(projectGraphPath(projectId))}>{graph.project.title}</button>
            <span className="text-muted-foreground">/</span>
            <span className="shrink-0 text-muted-foreground">Node graph</span>
          </div>
          <p className="mt-1 truncate text-[10px] text-muted-foreground">{repositoryLabel(graph.project.repository.owner, graph.project.repository.name)}</p>
        </div>

        <div className="hidden items-center gap-2 sm:flex">
          <span className={cn("size-2 rounded-full", integrity.status === "valid" ? "bg-[color:var(--apple-green)]" : "bg-[color:var(--apple-red)]")} />
          <span className="text-[11px] text-muted-foreground">{integrity.status === "valid" ? "State current" : "Integrity error"}</span>
          {graph.activeRuns.length > 0 ? <Badge variant="outline">{graph.activeRuns.length} active</Badge> : null}
        </div>

        <form className="relative order-last w-full sm:order-none sm:w-[220px]" role="search" onSubmit={submitSearch}>
          <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            className="h-9 w-full rounded-full border bg-white/72 pl-9 pr-3 text-[12px] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/24"
            value={search}
            onChange={event => setSearch(event.target.value)}
            placeholder="Find a Node"
            aria-label="Find a Node"
          />
        </form>

        <div className="flex items-center rounded-full border bg-white/62 p-0.5" aria-label="Graph representation">
          <ViewButton active={view === "canvas"} label="Canvas" icon={<Network />} onClick={() => setView("canvas")} />
          <ViewButton active={view === "outline"} label="Outline" icon={<List />} onClick={() => setView("outline")} />
        </div>
        <Button type="button" variant="ghost" size="icon" className="size-9" aria-label="Enter fullscreen" onClick={() => void fullscreenRef.current?.requestFullscreen()}><Expand /></Button>
      </header>

      {query.isError ? (
        <div className="absolute left-4 right-4 top-[76px] z-30 sm:left-6 sm:right-6">
          <PageRefreshWarning message={apiErrorMessage(query.error, "The graph could not be refreshed.")} retrying={query.isFetching} onRetry={() => void query.refetch()} />
        </div>
      ) : null}

      {integrity.status === "invalid" ? (
        <div role="alert" className="absolute left-1/2 top-[104px] z-20 w-[min(92%,620px)] -translate-x-1/2 rounded-[16px] border border-red-200 bg-red-50/96 p-4 text-red-950 shadow-lg">
          <div className="flex gap-3"><AlertTriangle className="mt-0.5 size-4 shrink-0" /><div><p className="text-[12px] font-semibold">{integrity.code}</p><p className="mt-1 text-[11px] leading-5">{integrity.message}</p><p className="mt-1 text-[10px] opacity-70">Hunsu will not repair or merge this topology in the browser.</p></div></div>
        </div>
      ) : null}

      <section className="relative h-[calc(100%-72px)]" aria-label={view === "canvas" ? "Node graph canvas" : "Node graph outline"}>
        {integrity.status === "valid" ? (
          <>
            {view === "canvas" ? (
              <GraphCanvas nodes={graph.nodes} edges={graph.edges} selectedNodeSha={selectedNodeSha} onSelectNode={openNode} />
            ) : (
              <GraphOutline nodes={graph.nodes} edges={graph.edges} rootNodeSha={graph.project.rootNodeSha} selectedNodeSha={selectedNodeSha} onSelectNode={openNode} />
            )}

            {query.hasNextPage ? (
              <Button
                type="button"
                variant="outline"
                className="absolute bottom-5 left-1/2 z-10 -translate-x-1/2 bg-white/92 shadow-sm"
                disabled={query.isFetchingNextPage}
                onClick={() => void query.fetchNextPage()}
              >
                {query.isFetchingNextPage ? <Loader2 className="animate-spin" /> : <Network />}
                {query.isFetchingNextPage ? "Loading branches…" : "Load more branches"}
              </Button>
            ) : null}

            {selectedNodeSha ? <NodeInspector projectId={projectId} nodeSha={selectedNodeSha} onClose={closeInspector} /> : null}
          </>
        ) : null}
      </section>
    </main>
  );
}

function GraphCanvas({
  nodes,
  edges,
  selectedNodeSha,
  onSelectNode
}: {
  nodes: readonly GraphNodeSummary[];
  edges: readonly GraphEdge[];
  selectedNodeSha: string | null;
  onSelectNode: (sha: string) => void;
}) {
  const layoutInput = useMemo<GraphLayoutRequest>(() => ({ nodes, edges }), [nodes, edges]);
  const positions = useGraphLayout(layoutInput);
  const [instance, setInstance] = useState<ReactFlowInstance<HunsuFlowNode, HunsuFlowEdge> | null>(null);
  const [viewportRevision, setViewportRevision] = useState(0);
  const canvasRef = useRef<HTMLDivElement>(null);
  const flowNodes = useMemo<readonly HunsuFlowNode[]>(() => {
    if (!positions) return [];
    const bySha = new Map(positions.map(position => [position.sha, position]));
    return nodes.map(node => ({
      id: node.sha,
      type: "hunsuNode",
      position: bySha.get(node.sha) ?? { x: 0, y: 0 },
      data: { summary: node },
      selected: node.sha === selectedNodeSha,
      draggable: false,
      connectable: false
    }));
  }, [nodes, positions, selectedNodeSha]);
  const flowEdges = useMemo<readonly HunsuFlowEdge[]>(() => edges.map(edge => ({
    id: edge.id,
    type: "hunsuEdge",
    source: edge.sourceSha,
    target: edge.targetSha,
    sourceHandle: edge.kind === "run" ? "run-out" : "coaching-out",
    targetHandle: edge.kind === "run" ? "run-in" : "coaching-in",
    data: { kind: edge.kind, label: graphEdgeLabel(edge) },
    markerEnd: { type: MarkerType.ArrowClosed, color: edge.kind === "run" ? "#0071e3" : "#15956a", width: 14, height: 14 },
    focusable: true,
    ariaLabel: edge.kind === "run" ? `Run: ${edge.goal.title}` : `Coaching: ${edge.summary}`
  })), [edges]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!instance || !canvas || !selectedNodeSha) return;
    let resizeTimer: number | undefined;
    const observer = new ResizeObserver(() => {
      if (resizeTimer !== undefined) window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => setViewportRevision(revision => revision + 1), 80);
    });
    observer.observe(canvas);
    return () => {
      observer.disconnect();
      if (resizeTimer !== undefined) window.clearTimeout(resizeTimer);
    };
  }, [instance, selectedNodeSha]);

  useEffect(() => {
    if (!instance) return;
    const frame = window.requestAnimationFrame(() => {
      const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      const desktop = window.matchMedia("(min-width: 768px)").matches;
      void instance.fitView(selectedNodeSha ? {
        nodes: [{ id: selectedNodeSha }],
        padding: desktop
          ? { top: "64px", right: DESKTOP_INSPECTOR_FIT_PADDING, bottom: "64px", left: "48px" }
          : 0.4,
        maxZoom: 1.15,
        duration: reducedMotion ? 0 : 180
      } : {
        padding: 0.22,
        maxZoom: 1.15,
        duration: reducedMotion ? 0 : 180
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [instance, selectedNodeSha, viewportRevision]);

  if (!positions) {
    return <div className="flex size-full items-center justify-center gap-2 bg-white/60 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />Laying out Nodes…</div>;
  }
  return (
    <div ref={canvasRef} className="relative size-full bg-[radial-gradient(circle_at_center,rgba(245,245,247,0)_0,rgba(245,245,247,.22)_100%)]">
      <ReactFlow
        nodes={[...flowNodes]}
        edges={[...flowEdges]}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView
        fitViewOptions={{ padding: 0.22, maxZoom: 1.15 }}
        minZoom={0.18}
        maxZoom={1.8}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable
        onInit={setInstance}
        onNodeClick={(_, node) => onSelectNode(node.id)}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="#d2d2d7" />
        <Controls showInteractive={false} position="bottom-left" />
        <MiniMap pannable zoomable position="bottom-right" nodeColor={node => node.id === selectedNodeSha ? "#0066cc" : "#d2d2d7"} maskColor="rgba(245,245,247,.72)" />
      </ReactFlow>
    </div>
  );
}

function HunsuNodeCard({ data, selected }: NodeProps<HunsuFlowNode>) {
  const node = data.summary;
  return (
    <article className={cn(
      "rounded-[13px] border bg-white/96 p-3.5 text-left shadow-[0_8px_24px_rgba(29,29,31,.07)] transition-shadow",
      selected ? "border-[color:var(--apple-blue)] ring-2 ring-[color:var(--apple-blue)]/16" : "border-[color:var(--apple-hairline)]",
      node.status === "rejected" && "opacity-55"
    )} style={{ height: GRAPH_NODE_HEIGHT, width: GRAPH_NODE_WIDTH }}>
      <Handle id="run-in" type="target" position={Position.Left} className="!size-1.5 !border-0 !bg-transparent" />
      <Handle id="run-out" type="source" position={Position.Right} className="!size-1.5 !border-0 !bg-[color:var(--apple-blue)]" />
      <Handle id="coaching-in" type="target" position={Position.Top} className="!size-1.5 !border-0 !bg-transparent" />
      <Handle id="coaching-out" type="source" position={Position.Bottom} className="!size-1.5 !border-0 !bg-emerald-500" />
      <div className="flex items-center justify-between gap-2">
        <p className="font-mono text-[13px] font-semibold">{shortSha(node.sha)}</p>
        <span className={cn("size-2 rounded-full", node.status === "rejected" ? "bg-[color:var(--apple-faint)]" : "bg-[color:var(--apple-green)]")} />
        <span className="sr-only">{node.status}</span>
      </div>
      <p className="mt-2 truncate text-[11px] text-muted-foreground">{node.title}</p>
      <div className="mt-3 flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
        <span className="truncate">{node.runner.name}</span>
        <span className="shrink-0">{node.nextGoalCount} Goal{node.nextGoalCount === 1 ? "" : "s"}</span>
      </div>
    </article>
  );
}

function HunsuGraphEdge(props: EdgeProps<HunsuFlowEdge>) {
  const [path, labelX, labelY] = getBezierPath({
    sourceX: props.sourceX,
    sourceY: props.sourceY,
    targetX: props.targetX,
    targetY: props.targetY,
    sourcePosition: props.sourcePosition,
    targetPosition: props.targetPosition,
    curvature: 0.24
  });
  const coaching = props.data?.kind === "coaching";
  return (
    <>
      <BaseEdge
        id={props.id}
        path={path}
        markerEnd={props.markerEnd}
        style={{ stroke: coaching ? "#15956a" : "#0071e3", strokeWidth: 1.7, strokeDasharray: coaching ? "6 6" : undefined }}
      />
      <EdgeLabelRenderer>
        <div
          data-graph-edge-label={props.id}
          className={cn("pointer-events-none absolute truncate rounded-full bg-white/92 px-2 py-1 text-[9px] font-medium shadow-sm", coaching ? "text-emerald-700" : "text-[color:var(--apple-blue)]")}
          style={{
            maxWidth: GRAPH_EDGE_LABEL_MAX_WIDTH,
            transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`
          }}
        >
          {coaching ? "↓ " : "→ "}{props.data?.label}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

function GraphOutline({
  nodes,
  edges,
  rootNodeSha,
  selectedNodeSha,
  onSelectNode
}: {
  nodes: readonly GraphNodeSummary[];
  edges: readonly GraphEdge[];
  rootNodeSha: string;
  selectedNodeSha: string | null;
  onSelectNode: (sha: string) => void;
}) {
  const incoming = new Map(edges.map(edge => [edge.targetSha, edge]));
  const ordered = breadthFirstNodes(nodes, edges, rootNodeSha);
  return (
    <div className="h-full overflow-y-auto bg-[color:var(--apple-canvas-alt)] px-4 py-6 sm:px-8">
      <div className="mx-auto max-w-3xl">
        <div className="mb-4 flex items-start gap-3 rounded-[14px] border bg-white/64 p-4 text-[11px] leading-5 text-muted-foreground">
          <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-[color:var(--apple-green)]" />
          Outline exposes the same Nodes and structural edges as the canvas. Use Tab and Enter to inspect a Node.
        </div>
        <ol className="grid gap-2" aria-label="Node lineage outline">
          {ordered.map(node => {
            const parent = incoming.get(node.sha);
            return (
              <li key={node.sha}>
                <button
                  type="button"
                  className={cn("flex w-full items-center gap-4 rounded-[14px] border bg-white/74 px-4 py-3 text-left focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/24", node.sha === selectedNodeSha && "border-[color:var(--apple-blue)]")}
                  onClick={() => onSelectNode(node.sha)}
                >
                  <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-full text-white", parent?.kind === "coaching" ? "bg-emerald-600" : "bg-[color:var(--apple-blue)]")}>
                    {parent?.kind === "coaching" ? "↓" : parent ? "→" : "●"}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2"><span className="font-mono text-[12px] font-semibold">{shortSha(node.sha)}</span><span className="truncate text-[12px] text-muted-foreground">{node.title}</span></span>
                    <span className="mt-1 block truncate text-[10px] text-muted-foreground">{parent ? `${parent.kind === "run" ? `Run · ${parent.goal.title}` : "Coaching"} from ${shortSha(parent.sourceSha)}` : "Root Node"}</span>
                  </span>
                  <span className="shrink-0 text-[10px] text-muted-foreground">{node.runner.name}</span>
                </button>
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}

function ViewButton({ active, label, icon, onClick }: { active: boolean; label: string; icon: React.ReactNode; onClick: () => void }) {
  return (
    <button type="button" className={cn("flex size-8 items-center justify-center rounded-full [&_svg]:size-3.5", active ? "bg-[color:var(--apple-ink)] text-white" : "text-muted-foreground")} aria-label={`Show ${label}`} aria-pressed={active} onClick={onClick}>{icon}</button>
  );
}

function useGraphLayout(input: GraphLayoutRequest): readonly PositionedGraphNode[] | null {
  const [positions, setPositions] = useState<readonly PositionedGraphNode[] | null>(null);
  useEffect(() => {
    setPositions(null);
    let active = true;
    const layout = startGraphLayout(input);
    void layout.result.then(
      nodes => { if (active) setPositions(nodes); },
      () => { if (active) setPositions(fallbackGraphLayout(input)); }
    );
    return () => {
      active = false;
      layout.terminate();
    };
  }, [input]);
  return positions;
}

type MergedGraph = Omit<ProjectGraphResponse, "window"> & {
  stateHeadsAgree: boolean;
  projectSummariesAgree: boolean;
};

function mergeGraphPages(pages: readonly ProjectGraphResponse[]): MergedGraph | null {
  const first = pages[0];
  if (!first) return null;
  const mergedNodes = mergePageItems(pages.flatMap(page => page.nodes), node => node.sha);
  const mergedEdges = mergePageItems(pages.flatMap(page => page.edges), edge => edge.id);
  const mergedActiveRuns = mergePageItems(pages.flatMap(page => page.activeRuns), run => run.id);
  const invalidPage = pages.find(page => page.integrity.status === "invalid");
  const conflictingPageItems = mergedNodes.conflictingKey ?? mergedEdges.conflictingKey ?? mergedActiveRuns.conflictingKey;
  const integrity: ProjectIntegrity = invalidPage?.integrity ?? (conflictingPageItems
    ? {
        status: "invalid",
        code: "conflicting_graph_pages",
        message: `Graph continuation pages disagree about ${conflictingPageItems}.`
      }
    : first.integrity);
  return {
    schema: first.schema,
    project: first.project,
    stateHeadSha: first.stateHeadSha,
    integrity,
    nodes: mergedNodes.items,
    edges: mergedEdges.items,
    activeRuns: mergedActiveRuns.items,
    stateHeadsAgree: pages.every(page => page.stateHeadSha === first.stateHeadSha),
    projectSummariesAgree: pages.every(page => sameProjectSummary(page.project, first.project))
  };
}

function effectiveIntegrity(
  server: ProjectIntegrity,
  topology: GraphTopologyResult,
  stateHeadsAgree: boolean,
  projectSummariesAgree: boolean
): ProjectIntegrity {
  if (server.status === "invalid") return server;
  if (!stateHeadsAgree) return { status: "invalid", code: "mixed_state_heads", message: "Loaded graph windows were reconstructed from different state heads." };
  if (!projectSummariesAgree) return { status: "invalid", code: "mixed_project_summaries", message: "Loaded graph windows describe different Project boundaries." };
  return topology.ok ? { status: "valid" } : { status: "invalid", code: topology.code, message: topology.message };
}

function findNode(nodes: readonly GraphNodeSummary[], search: string): GraphNodeSummary | undefined {
  const normalized = search.trim().toLocaleLowerCase();
  if (!normalized) return undefined;
  return nodes.find(node => node.sha.startsWith(normalized) || node.title.toLocaleLowerCase().includes(normalized) || node.runner.name.toLocaleLowerCase().includes(normalized));
}

function breadthFirstNodes(nodes: readonly GraphNodeSummary[], edges: readonly GraphEdge[], rootSha: string): readonly GraphNodeSummary[] {
  const bySha = new Map(nodes.map(node => [node.sha, node]));
  const outgoing = new Map<string, GraphEdge[]>();
  for (const edge of edges) outgoing.set(edge.sourceSha, [...(outgoing.get(edge.sourceSha) ?? []), edge]);
  const ordered: GraphNodeSummary[] = [];
  const visited = new Set<string>();
  const queue = [rootSha];
  while (queue.length > 0) {
    const sha = queue.shift();
    if (!sha || visited.has(sha)) continue;
    visited.add(sha);
    const node = bySha.get(sha);
    if (node) ordered.push(node);
    const childEdges = [...(outgoing.get(sha) ?? [])].sort((a, b) => a.kind.localeCompare(b.kind) || a.targetSha.localeCompare(b.targetSha));
    queue.push(...childEdges.map(edge => edge.targetSha));
  }
  return ordered;
}

function sameProjectSummary(left: ProjectGraphResponse["project"], right: ProjectGraphResponse["project"]): boolean {
  return left.id === right.id
    && left.title === right.title
    && left.rootNodeSha === right.rootNodeSha
    && left.repository.owner === right.repository.owner
    && left.repository.name === right.repository.name
    && left.repository.url === right.repository.url
    && left.repository.defaultBranch === right.repository.defaultBranch;
}

function mergePageItems<T>(items: readonly T[], key: (item: T) => string): { readonly items: readonly T[]; readonly conflictingKey: string | null } {
  const byKey = new Map<string, { readonly item: T; readonly canonical: string }>();
  let conflictingKey: string | null = null;
  for (const item of items) {
    const itemKey = key(item);
    const canonical = JSON.stringify(item);
    const existing = byKey.get(itemKey);
    if (!existing) {
      byKey.set(itemKey, { item, canonical });
    } else if (existing.canonical !== canonical && conflictingKey === null) {
      conflictingKey = itemKey;
    }
  }
  return { items: [...byKey.values()].map(entry => entry.item), conflictingKey };
}
