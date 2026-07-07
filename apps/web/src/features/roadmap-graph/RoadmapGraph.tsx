import type { CSSProperties } from "react";
import { Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/shared/ui/button";
import type { RoadmapActionModel, RoadmapGraphModel, RoadmapSelection, RouteNodeView } from "@/shared/domain/roadmapViewModel";
import { ExecuteCueConnector } from "@/features/roadmap-graph/Connectors";
import { FoldedMoveConnector } from "@/features/roadmap-graph/FoldedMoveConnector";
import { InlinePathEdge } from "@/features/roadmap-graph/InlinePathEdge";
import { InlinePlanScope } from "@/features/roadmap-graph/InlinePlanScope";
import { InlinePathPoint } from "@/features/roadmap-graph/InlinePathPoint";
import { MoveCard } from "@/features/roadmap-graph/MoveCard";

export function RoadmapGraph({
  model,
  selection,
  onSelect,
  onToggleConnection,
  onStartExecute,
  detailPanel
}: {
  model: RoadmapGraphModel;
  selection: RoadmapSelection;
  onSelect: (selection: RoadmapSelection) => void;
  onToggleConnection: (displayId: string) => void;
  onStartExecute: (action: RoadmapActionModel) => void;
  detailPanel?: React.ReactNode;
}) {
  const planRoutes = model.routeNodes.filter((route): route is Extract<RouteNodeView, { kind: "plan" }> => route.kind === "plan");
  const pathRoutes = model.routeNodes.filter((route): route is Extract<RouteNodeView, { kind: "path" }> => route.kind === "path");
  const hunsuDraftRoutes = model.routeNodes.filter((route): route is Extract<RouteNodeView, { kind: "hunsuDraft" }> => route.kind === "hunsuDraft");
  return (
    <section
      data-figma-component="StudioV2/DashboardShell"
      className="relative h-full min-h-0 w-full min-w-0 overflow-hidden bg-[color:var(--studio-canvas-tint)]"
    >
      <div className="studio-canvas-grid studio-scrollbar absolute inset-0 overflow-auto bg-[color:var(--studio-canvas-tint)] pt-24">
        <div
          className="relative min-h-full min-w-full"
          style={{ width: model.width, height: model.height }}
          onClick={event => {
            const target = event.target;
            if (target instanceof Element && target.closest("button, a, [role='button'], [data-inspector-panel]")) {
              return;
            }
            onSelect({ kind: "none" });
          }}
        >
          <svg className="absolute inset-0" width={model.width} height={model.height} viewBox={`0 0 ${model.width} ${model.height}`} aria-hidden="true">
            {model.connections.map(connection => (
              connection.to && connection.display.connectDisplayType === "Fold" ? (
                <path
                  key={connection.id}
                  d={`M ${connection.from.x} ${connection.from.y} C ${(connection.from.x + connection.to.x) / 2} ${connection.from.y}, ${(connection.from.x + connection.to.x) / 2} ${connection.to.y}, ${connection.to.x} ${connection.to.y}`}
                  fill="none"
                  stroke={connection.color}
                  strokeWidth={2}
                  strokeLinecap="round"
                />
              ) : null
            ))}
            {hunsuDraftRoutes.map(route => {
              const routeTop = { x: route.x + route.width / 2, y: route.y };
              const routeBottom = { x: route.x + route.width / 2, y: route.y + route.height };
              return (
                <g key={`hunsu-draft-edge-${route.draftSessionId}`}>
                  <path
                    d={`M ${route.sourceAnchor.x} ${route.sourceAnchor.y} C ${route.sourceAnchor.x} ${route.sourceAnchor.y + 36}, ${routeTop.x} ${routeTop.y - 36}, ${routeTop.x} ${routeTop.y}`}
                    fill="none"
                    stroke="var(--studio-galio)"
                    strokeWidth="2"
                    strokeDasharray="4 7"
                    strokeLinecap="round"
                  />
                  {route.targetAnchor ? (
                    <path
                      d={`M ${routeBottom.x} ${routeBottom.y} C ${routeBottom.x} ${routeBottom.y + 36}, ${route.targetAnchor.x} ${route.targetAnchor.y - 36}, ${route.targetAnchor.x} ${route.targetAnchor.y}`}
                      fill="none"
                      stroke={route.teamColor}
                      strokeWidth="2"
                      strokeDasharray="4 7"
                      strokeLinecap="round"
                    />
                  ) : null}
                </g>
              );
            })}
            {model.edges.map(edge => (
              <path
                key={edge.id}
                d={edge.type === "hunsu"
                  ? `M ${edge.from.x} ${edge.from.y} C ${edge.from.x} ${edge.from.y + 64}, ${edge.to.x} ${edge.to.y - 64}, ${edge.to.x} ${edge.to.y}`
                  : `M ${edge.from.x} ${edge.from.y} C ${(edge.from.x + edge.to.x) / 2} ${edge.from.y}, ${(edge.from.x + edge.to.x) / 2} ${edge.to.y}, ${edge.to.x} ${edge.to.y}`}
                fill="none"
                stroke={edge.type === "hunsu" ? "var(--studio-galio)" : edge.color}
                strokeWidth="2"
                strokeDasharray={edge.type === "hunsu" ? "6 6" : undefined}
                strokeLinecap="round"
              />
            ))}
            {model.inlineExecutes.flatMap(execute => execute.overlay.edges.map(edge => (
              <InlinePathEdge key={edge.id} edge={edge} color={execute.teamColor} />
            )))}
          </svg>

          {model.connections.map(connection => (
            <FoldedMoveConnector
              key={`${connection.id}:toggle`}
              connection={connection}
              onToggle={() => onToggleConnection(connection.display.displayId)}
            />
          ))}

          {model.nodes.map(node => (
            <div key={node.id} className="absolute" style={{ left: node.x, top: node.y }}>
              <MoveCard
                card={node.card}
                selected={model.selectedNodeId === node.id && selection.kind !== "none"}
                active={node.active}
                executing={node.executing}
                playable={node.playable}
                onSelect={() => onSelect({ kind: "move", nodeId: node.id, moveId: node.card.moveId, teamName: node.card.teamName, moveOrdinal: node.card.ordinal })}
              />
            </div>
          ))}

          {hunsuDraftRoutes.map(route => (
            <HunsuDraftNode
              key={route.id}
              route={route}
              selected={model.selectedRouteNodeId === route.id}
              onSelect={() => onSelect({ kind: "hunsuDraftRoute", draftSessionId: route.draftSessionId })}
            />
          ))}

          {model.playableMoves.map(item => (
            <div
              key={item.id}
              className="absolute flex items-center gap-2"
              style={{ left: item.x, top: item.y, "--team-color": item.teamColor } as CSSProperties}
            >
              <ExecuteCueConnector />
              <Button
                type="button"
                data-figma-component="RoadmapV3/ExecuteButton"
                className="h-[38px] w-[176px] justify-start rounded-full border border-[color-mix(in_oklab,var(--team-color),white_44%)] bg-[color:var(--team-color)] px-3 text-left text-white shadow-none hover:brightness-95"
                aria-label={`Start Execute for ${item.action.destinationLabels[0] ?? item.node.card.title}`}
                onClick={() => onStartExecute(item.action)}
              >
                <span className="truncate text-xs font-semibold">Execute: {item.action.destinationLabels[0] ?? item.node.card.title}</span>
              </Button>
            </div>
          ))}

          {planRoutes.map(route => (
            <InlinePlanScope
              key={route.id}
              scope={route.planScope}
              teamColor={route.teamColor}
              selected={model.selectedPlanScopeId === route.planScope.id}
              onSelect={() => onSelect({ kind: "execute", executeId: route.executeId })}
            />
          ))}

          {pathRoutes.map(route => (
            <InlinePathPoint
              key={route.id}
              point={route.point}
              teamColor={route.teamColor}
              selected={model.selectedPathPointId === route.point.id}
              onSelect={() => onSelect({ kind: "pathPoint", executeId: route.executeId, pointId: route.point.pathId ?? route.point.id })}
            />
          ))}

          {model.inlineExecutes.flatMap(execute => execute.overlay.points.filter(point => point.kind !== "path").map(point => (
            <InlinePathPoint
              key={point.id}
              point={point}
              teamColor={execute.teamColor}
              selected={model.selectedPathPointId === point.id}
              onSelect={() => onSelect({ kind: "none" })}
            />
          )))}

        </div>
      </div>
      {detailPanel ? (
        <div
          data-inspector-panel
          role="dialog"
          aria-modal="true"
          aria-label="Roadmap details"
          className="absolute inset-0 z-50 flex items-center justify-center bg-[rgba(245,245,247,0.34)] p-4 backdrop-blur-[20px] backdrop-saturate-150"
          onClick={() => onSelect({ kind: "none" })}
        >
          <div
            className="h-full max-h-[760px] min-h-0 max-w-[760px]"
            style={{
              width: "min(760px, calc(100vw - 42px))",
              height: "min(760px, calc(100vh - 104px))"
            }}
            onClick={event => event.stopPropagation()}
          >
            {detailPanel}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function HunsuDraftNode({ route, selected, onSelect }: { route: Extract<RouteNodeView, { kind: "hunsuDraft" }>; selected: boolean; onSelect: () => void }) {
  const diffState = route.draft.latestDiffArtifactId ? "DiffArtifact ready" : "Draft conversation in progress";
  const status = hunsuDraftRouteStatus(route.status);
  return (
    <button
      type="button"
      data-route-kind="hunsuDraft"
      data-state={route.status}
      className={cn(
        "group absolute z-10 flex size-[38px] items-center justify-center rounded-[16px] border shadow-[0_12px_30px_rgba(29,29,31,0.08)] backdrop-blur-xl transition-all hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/24",
        status.className,
        status.pulse && "animate-pulse",
        selected && "ring-[3px] ring-[color-mix(in_oklab,var(--team-color),transparent_55%)]"
      )}
      style={{ left: route.x, top: route.y, "--team-color": route.teamColor } as CSSProperties}
      aria-label={`HUNSU Draft ${route.label}`}
      onClick={onSelect}
    >
      <Sparkles className="size-4" />
      <span role="tooltip" className="pointer-events-none absolute left-0 top-11 z-10 hidden w-64 rounded-[14px] border bg-popover/92 p-3 text-xs text-popover-foreground shadow-[0_18px_44px_rgba(29,29,31,0.12)] backdrop-blur-xl group-hover:block">
        <strong className="block truncate">HUNSU Draft · {status.label}</strong>
        <span className="mt-1 block leading-4 text-muted-foreground">{diffState}</span>
        {route.targetNode ? <span className="mt-1 block font-mono">to {route.targetNode.card.teamName} M{String(route.targetNode.card.ordinal).padStart(4, "0")}</span> : null}
      </span>
    </button>
  );
}

function hunsuDraftRouteStatus(status: Extract<RouteNodeView, { kind: "hunsuDraft" }>["status"]): { label: string; className: string; pulse?: boolean } {
  if (status === "confirmed") {
    return { label: "Confirmed", className: "border-[color-mix(in_oklab,var(--team-color),transparent_35%)] bg-white/78 text-[color:var(--team-color)]" };
  }
  if (status === "ready") {
    return { label: "Approval ready", className: "border-[color:var(--team-color)] bg-[color-mix(in_oklab,var(--team-color),white_90%)] text-[color:var(--team-color)] shadow-[0_0_0_4px_color-mix(in_oklab,var(--team-color),transparent_82%)]" };
  }
  if (status === "failed" || status === "discarded") {
    return { label: status === "failed" ? "Failed" : "Discarded", className: "border-[color:var(--studio-danger)] bg-[#fff1ef] text-[color:var(--studio-danger)]" };
  }
  return { label: "Chat", className: "border-border bg-white/76 text-muted-foreground" };
}
