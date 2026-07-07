import { figmaComponentNames } from "@/shared/design/figmaContracts";
import type { InlinePathEdge as InlinePathEdgeView } from "@/shared/domain/roadmapViewModel";

export function InlinePathEdge({ edge, color }: { edge: InlinePathEdgeView; color: string }) {
  const path = `M ${edge.from.x} ${edge.from.y} C ${(edge.from.x + edge.to.x) / 2} ${edge.from.y}, ${(edge.from.x + edge.to.x) / 2} ${edge.to.y}, ${edge.to.x} ${edge.to.y}`;
  return (
    <path
      data-figma-component={figmaComponentNames.inlinePathEdge}
      data-state={edge.figmaState}
      data-direction={edge.direction}
      d={path}
      fill="none"
      stroke={edge.cssState === "failed" ? "var(--studio-danger)" : color}
      strokeWidth={edge.cssState === "running" ? 2.5 : 1.75}
      strokeDasharray={edge.kind === "target" || edge.cssState === "waiting" ? "5 5" : undefined}
      strokeLinecap="round"
    />
  );
}
