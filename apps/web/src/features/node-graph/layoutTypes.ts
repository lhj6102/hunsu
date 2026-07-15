import type { GraphEdge, GraphNodeSummary } from "@/shared/api/types";

export type GraphLayoutRequest = {
  nodes: readonly GraphNodeSummary[];
  edges: readonly GraphEdge[];
};

export type PositionedGraphNode = {
  sha: string;
  x: number;
  y: number;
};
