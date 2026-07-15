import { GRAPH_COACHING_GAP, GRAPH_RUN_GAP } from "./layoutMetrics.ts";
import type { GraphLayoutRequest, PositionedGraphNode } from "./layoutTypes.ts";

export function fallbackGraphLayout(input: GraphLayoutRequest): readonly PositionedGraphNode[] {
  const incoming = new Map(input.nodes.map(node => [node.sha, 0]));
  const outgoing = new Map<string, typeof input.edges>();
  for (const edge of input.edges) {
    incoming.set(edge.targetSha, (incoming.get(edge.targetSha) ?? 0) + 1);
    outgoing.set(edge.sourceSha, [...(outgoing.get(edge.sourceSha) ?? []), edge]);
  }

  const positions = new Map<string, PositionedGraphNode>();
  const occupied = new Set<string>();
  const roots = input.nodes.filter(node => (incoming.get(node.sha) ?? 0) === 0);
  const queue: string[] = [];
  roots.forEach((node, index) => {
    const position = { sha: node.sha, x: 0, y: index * GRAPH_COACHING_GAP * 2 };
    positions.set(node.sha, position);
    occupied.add(coordinate(position.x, position.y));
    queue.push(node.sha);
  });

  while (queue.length > 0) {
    const sourceSha = queue.shift();
    if (!sourceSha) continue;
    const source = positions.get(sourceSha);
    if (!source) continue;
    let runIndex = 0;
    let coachingIndex = 0;
    const edges = [...(outgoing.get(sourceSha) ?? [])].sort((left, right) => left.kind.localeCompare(right.kind) || left.targetSha.localeCompare(right.targetSha));
    for (const edge of edges) {
      if (positions.has(edge.targetSha)) continue;
      let x = source.x + (edge.kind === "run" ? GRAPH_RUN_GAP : coachingIndex * GRAPH_RUN_GAP);
      let y = source.y + (edge.kind === "coaching" ? GRAPH_COACHING_GAP : runIndex * GRAPH_COACHING_GAP);
      while (occupied.has(coordinate(x, y))) {
        if (edge.kind === "run") y += GRAPH_COACHING_GAP;
        else x += GRAPH_RUN_GAP;
      }
      const position = { sha: edge.targetSha, x, y };
      positions.set(edge.targetSha, position);
      occupied.add(coordinate(x, y));
      queue.push(edge.targetSha);
      if (edge.kind === "run") runIndex += 1;
      else coachingIndex += 1;
    }
  }

  for (const node of input.nodes) {
    if (positions.has(node.sha)) continue;
    const y = positions.size * GRAPH_COACHING_GAP;
    positions.set(node.sha, { sha: node.sha, x: 0, y });
  }
  return input.nodes.map(node => positions.get(node.sha)!);
}

function coordinate(x: number, y: number): string {
  return `${x}:${y}`;
}
