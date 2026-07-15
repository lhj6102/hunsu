import type { GraphEdge, GraphNodeSummary } from "../../shared/api/types.ts";

export type GraphTopologyResult =
  | { ok: true }
  | { ok: false; code: "duplicate_node" | "missing_root" | "dangling_edge" | "self_edge" | "multiple_parents" | "missing_parent" | "cycle"; message: string };

export function validateGraphTopology(
  nodes: readonly GraphNodeSummary[],
  edges: readonly GraphEdge[],
  rootNodeSha: string
): GraphTopologyResult {
  const nodeIds = new Set<string>();
  for (const node of nodes) {
    if (nodeIds.has(node.sha)) return invalid("duplicate_node", `Node ${node.sha} is registered more than once.`);
    nodeIds.add(node.sha);
  }
  if (!nodeIds.has(rootNodeSha)) return invalid("missing_root", `Root Node ${rootNodeSha} is not present in the graph window.`);

  const incoming = new Map<string, number>();
  const outgoing = new Map<string, string[]>();
  for (const edge of edges) {
    if (!nodeIds.has(edge.sourceSha) || !nodeIds.has(edge.targetSha)) {
      return invalid("dangling_edge", `Edge ${edge.id} does not connect two registered Nodes.`);
    }
    if (edge.sourceSha === edge.targetSha) return invalid("self_edge", `Edge ${edge.id} connects a Node to itself.`);
    const nextIncoming = (incoming.get(edge.targetSha) ?? 0) + 1;
    if (nextIncoming > 1) return invalid("multiple_parents", `Node ${edge.targetSha} has more than one structural parent.`);
    incoming.set(edge.targetSha, nextIncoming);
    outgoing.set(edge.sourceSha, [...(outgoing.get(edge.sourceSha) ?? []), edge.targetSha]);
  }

  if ((incoming.get(rootNodeSha) ?? 0) !== 0) return invalid("multiple_parents", "The root Node cannot have a structural parent.");
  for (const node of nodes) {
    if (node.sha !== rootNodeSha && (incoming.get(node.sha) ?? 0) !== 1) {
      return invalid("missing_parent", `Node ${node.sha} does not have exactly one structural parent.`);
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  function visit(nodeSha: string): boolean {
    if (visiting.has(nodeSha)) return false;
    if (visited.has(nodeSha)) return true;
    visiting.add(nodeSha);
    for (const targetSha of outgoing.get(nodeSha) ?? []) {
      if (!visit(targetSha)) return false;
    }
    visiting.delete(nodeSha);
    visited.add(nodeSha);
    return true;
  }
  if (!visit(rootNodeSha) || visited.size !== nodes.length) return invalid("cycle", "The Node graph contains a cycle or disconnected lineage.");
  return { ok: true };
}

export function graphEdgeLabel(edge: GraphEdge): string {
  return edge.kind === "run" ? edge.goal.title : "Coaching";
}

function invalid(code: Extract<GraphTopologyResult, { ok: false }>["code"], message: string): GraphTopologyResult {
  return { ok: false, code, message };
}
