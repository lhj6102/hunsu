import ELK from "elkjs/lib/elk-api.js";
import type { ELK as ElkInstance, ELKConstructorArguments, ElkNode } from "elkjs/lib/elk-api.js";
import ElkWorker from "elkjs/lib/elk-worker.min.js?worker";
import {
  GRAPH_COACHING_GAP,
  GRAPH_NODE_HEIGHT,
  GRAPH_NODE_WIDTH,
  GRAPH_RUN_GAP
} from "@/features/node-graph/layoutMetrics";
import type { GraphLayoutRequest, PositionedGraphNode } from "@/features/node-graph/layoutTypes";

export type PendingGraphLayout = {
  readonly result: Promise<readonly PositionedGraphNode[]>;
  terminate(): void;
};

export function startGraphLayout(input: GraphLayoutRequest): PendingGraphLayout {
  const worker = new ElkWorker();
  const ElkConstructor = ELK as unknown as new (args?: ELKConstructorArguments) => ElkInstance;
  const elk = new ElkConstructor({
    algorithms: ["layered"],
    workerFactory: () => worker
  });
  return {
    result: layoutGraph(elk, input),
    terminate: () => elk.terminateWorker()
  };
}

async function layoutGraph(elk: ElkInstance, input: GraphLayoutRequest): Promise<readonly PositionedGraphNode[]> {
  const graph: ElkNode = {
    id: "hunsu-node-graph",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.spacing.nodeNode": "72",
      "elk.layered.spacing.nodeNodeBetweenLayers": "96",
      "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
      "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
      "elk.edgeRouting": "SPLINES",
      "elk.padding": "[top=64,left=64,bottom=64,right=64]"
    },
    children: input.nodes.map(node => ({
      id: node.sha,
      width: GRAPH_NODE_WIDTH,
      height: GRAPH_NODE_HEIGHT,
      layoutOptions: { "elk.portConstraints": "FIXED_SIDE" },
      ports: [
        port(node.sha, "run-in", "WEST"),
        port(node.sha, "run-out", "EAST"),
        port(node.sha, "coaching-in", "NORTH"),
        port(node.sha, "coaching-out", "SOUTH")
      ]
    })),
    edges: input.edges.map(edge => ({
      id: edge.id,
      sources: [`${edge.sourceSha}:${edge.kind === "run" ? "run-out" : "coaching-out"}`],
      targets: [`${edge.targetSha}:${edge.kind === "run" ? "run-in" : "coaching-in"}`]
    }))
  };

  const result = await elk.layout(graph);
  const positions = new Map<string, PositionedGraphNode>();
  for (const child of result.children ?? []) {
    positions.set(child.id, { sha: child.id, x: child.x ?? 0, y: child.y ?? 0 });
  }

  enforceSemanticAxes(input, positions);
  return input.nodes.map(node => positions.get(node.sha) ?? { sha: node.sha, x: 0, y: 0 });
}

function enforceSemanticAxes(
  input: GraphLayoutRequest,
  positions: Map<string, PositionedGraphNode>
): void {
  const incoming = new Map<string, number>();
  const outgoing = new Map<string, GraphLayoutRequest["edges"]>();
  for (const edge of input.edges) {
    incoming.set(edge.targetSha, (incoming.get(edge.targetSha) ?? 0) + 1);
    outgoing.set(edge.sourceSha, [...(outgoing.get(edge.sourceSha) ?? []), edge]);
  }
  const queue = input.nodes.filter(node => (incoming.get(node.sha) ?? 0) === 0).map(node => node.sha);
  while (queue.length > 0) {
    const sourceSha = queue.shift();
    if (!sourceSha) continue;
    const source = positions.get(sourceSha);
    if (!source) continue;
    for (const edge of outgoing.get(sourceSha) ?? []) {
      const target = positions.get(edge.targetSha);
      if (target) {
        if (edge.kind === "run") target.x = Math.max(target.x, source.x + GRAPH_RUN_GAP);
        else target.y = Math.max(target.y, source.y + GRAPH_COACHING_GAP);
      }
      incoming.set(edge.targetSha, (incoming.get(edge.targetSha) ?? 1) - 1);
      if ((incoming.get(edge.targetSha) ?? 0) === 0) queue.push(edge.targetSha);
    }
  }
}

function port(nodeSha: string, id: string, side: "NORTH" | "EAST" | "SOUTH" | "WEST") {
  return {
    id: `${nodeSha}:${id}`,
    width: 1,
    height: 1,
    layoutOptions: { "elk.port.side": side }
  };
}
