import { createHash } from "node:crypto";
import { unresolvedDivergenceCount } from "@hunsu/core";
import type {
  KeyedNodeActivityKind,
  NodeActivityKind,
  StoredProjectEvent,
  VerifiedStoredProjectEvent,
  StoreResult
} from "@hunsu/github-store";
import { eventListProjection, type EventReferenceProjection } from "@hunsu/projections";
import {
  computeRunnerDigest,
  type AlternativeDecision,
  type DomainEvent,
  type Node,
  type ProjectState,
  type Run
} from "@hunsu/protocol";
import { gunzipSync, gzipSync } from "fflate";
import { verifiedOpaqueDomainEventDigest } from "./opaque-domain-event.ts";
import type {
  ActiveRunReadModel,
  CoachingActivityReadModel,
  ComparisonActivityReadModel,
  DecisionActivityReadModel,
  EventIndexEntryReadModel,
  EventLogCheckpoint,
  EvidenceActivityReadModel,
  GraphNodeIdentityProof,
  GraphNodeIdentityProofStep,
  GraphNodeTopologyIdentity,
  ProjectGraphEdge,
  ProjectGraphNode,
  ReviewActivityReadModel,
  RunActivityReadModel
} from "./project-read-models.ts";

export const GRAPH_PAGE_SIZE = 300;
export const EVENT_INDEX_SHARD_SIZE = 256;
export const MAX_EVENT_SHARDS_PER_PAGE = 4;
export const SHARDED_READ_MODEL_ENVELOPE_SCHEMA = "hunsu.project-read-model-envelope.v2" as const;
export const SHARDED_READ_MODEL_CODEC = "canonical-json+deterministic-gzip+base64" as const;
export const SHARDED_PROJECT_SCHEMA = "hunsu.project-catalog.v2" as const;
export const GRAPH_MANIFEST_SCHEMA = "hunsu.project-graph-manifest.v2" as const;
export const GRAPH_PAGE_SCHEMA = "hunsu.project-graph-page.v2" as const;
export const GRAPH_NODE_SCHEMA = "hunsu.project-graph-node.v2" as const;
export const ACTIVITY_MANIFEST_SCHEMA = "hunsu.project-snapshot-manifest.v3" as const;
export const NODE_ACTIVITY_PAGE_SIZE = 50;
export const NODE_ACTIVITY_INDEX_SCHEMA = "hunsu.node-activity-index.v2" as const;
export const NODE_ACTIVITY_PAGE_SCHEMA = "hunsu.node-activity-page.v2" as const;
export const NODE_ACTIVITY_RECORD_SCHEMA = "hunsu.node-activity-record.v2" as const;
export const RUN_ACTIVITY_SCHEMA = "hunsu.run-activity.v3" as const;
export const EVENT_MANIFEST_SCHEMA = "hunsu.project-event-index-manifest.v2" as const;
export const EVENT_SHARD_SCHEMA = "hunsu.project-event-index-shard.v2" as const;
export const EVENT_LOCATOR_SCHEMA = "hunsu.project-event-locator.v2" as const;

const GRAPH_NODE_IDENTITY_LEAF_SCHEMA = "hunsu.graph-node-identity-leaf.v2" as const;
const GRAPH_NODE_IDENTITY_BRANCH_SCHEMA = "hunsu.graph-node-identity-branch.v2" as const;
const GRAPH_NODE_IDENTITY_DIGEST_PREFIX = "hunsu-graph-node-identity-v2:sha256:" as const;
const MAX_GRAPH_IDENTITY_PROOF_STEPS = 9;
const NODE_ACTIVITY_PAGE_LEAF_SCHEMA = "hunsu.node-activity-page-leaf.v2" as const;
const NODE_ACTIVITY_PAGE_BRANCH_SCHEMA = "hunsu.node-activity-page-branch.v2" as const;
const NODE_ACTIVITY_EMPTY_ROOT_SCHEMA = "hunsu.node-activity-empty-root.v2" as const;
const NODE_ACTIVITY_PAGE_COMMITMENT_PREFIX = "hunsu-node-activity-page-v2:sha256:" as const;
const MAX_NODE_ACTIVITY_PROOF_STEPS = 48;

const MAX_DECODED_BYTES = 8 * 1_048_576;
const MAX_ENCODED_BYTES = 12 * 1_048_576;
const DOMAIN_EVENT_TYPES: readonly DomainEvent["type"][] = [
  "ProjectCreated", "ProjectMaterializationsRebuilt", "RootNodeRegistered", "RunStarted", "RunCheckpointed", "RunEvidenceAttached",
  "RunCompleted", "RunChildNodeRegistered", "RunFailed", "RunCanceled", "CoachReviewRecorded",
  "CoachingProposalRecorded", "CoachingProposalConfirmed", "CoachingChildNodeRegistered",
  "CoachingProposalRejected", "AlternativesCompared", "AlternativeSelected", "AlternativesRejected"
];
export const NODE_ACTIVITY_KINDS = ["runs", "evidence", "comparisons", "decisions", "coaching", "reviews"] as const satisfies readonly NodeActivityKind[];
const KEYED_NODE_ACTIVITY_KINDS = ["comparisons", "coaching", "reviews"] as const satisfies readonly KeyedNodeActivityKind[];

export const SHARDED_READ_MODEL_PATHS = {
  project: "project.json",
  graphManifest: "graph/latest.json",
  activityManifest: "snapshots/latest.json",
  eventManifest: "indexes/events/latest.json"
} as const;

export type ShardedReadModelKind =
  | "catalog"
  | "graphManifest"
  | "graphPage"
  | "graphNode"
  | "activityManifest"
  | "nodeActivityIndex"
  | "nodeActivityPage"
  | "nodeActivityRecord"
  | "runActivity"
  | "eventManifest"
  | "eventShard"
  | "eventLocator";

export type ShardedReadModelEnvelope = {
  readonly schema: typeof SHARDED_READ_MODEL_ENVELOPE_SCHEMA;
  readonly kind: ShardedReadModelKind;
  readonly codec: typeof SHARDED_READ_MODEL_CODEC;
  readonly checkpoint: EventLogCheckpoint;
  readonly decodedSize: number;
  readonly encodedSize: number;
  readonly digest: string;
  readonly data: string;
};

export type ShardedProjectCatalogReadModel = {
  readonly schema: typeof SHARDED_PROJECT_SCHEMA;
  readonly checkpoint: EventLogCheckpoint;
  readonly project: {
    readonly id: string;
    readonly workspaceId: string;
    readonly title: string;
    readonly repository: { readonly owner: string; readonly name: string };
    readonly baseRef: string;
    readonly rootNodeSha: string;
    readonly createdAt: string;
  };
  readonly counts: {
    readonly nodes: number;
    readonly activeRuns: number;
    readonly unresolvedDivergences: number;
    readonly events: number;
  };
  readonly rootAnchor: {
    readonly managedRef: string;
    readonly nodeSha: string;
    readonly treeSha: string;
    readonly commitTitle: string;
  };
};

export type OrdinalGraphNode = ProjectGraphNode & {
  readonly ordinal: number;
  readonly parentOrdinal: number | null;
};

export type GraphPageDescriptor = {
  readonly index: number;
  readonly path: string;
  readonly ordinalStart: number;
  readonly ordinalEnd: number;
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly digest: string;
  readonly nodeIdentityRoot: string;
};

export type ProjectGraphManifestReadModel = {
  readonly schema: typeof GRAPH_MANIFEST_SCHEMA;
  readonly checkpoint: EventLogCheckpoint;
  readonly projectId: string;
  readonly rootNodeSha: string;
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly pageSize: typeof GRAPH_PAGE_SIZE;
  readonly pages: readonly GraphPageDescriptor[];
  readonly topologyDigest: string;
};

export type ProjectGraphPageReadModel = {
  readonly schema: typeof GRAPH_PAGE_SCHEMA;
  readonly checkpoint: EventLogCheckpoint;
  readonly projectId: string;
  readonly index: number;
  readonly ordinalStart: number;
  readonly nodes: readonly OrdinalGraphNode[];
  /** Exact membership proofs for parents stored on earlier Graph pages. */
  readonly externalParents: readonly GraphNodeIdentityProof[];
  /** An edge is stored with its target page, even when its source is in an earlier page. */
  readonly edges: readonly ProjectGraphEdge[];
  readonly activeRuns: readonly ActiveRunReadModel[];
};

export type ProjectGraphNodeReadModel = {
  readonly schema: typeof GRAPH_NODE_SCHEMA;
  readonly checkpoint: EventLogCheckpoint;
  readonly projectId: string;
  readonly node: OrdinalGraphNode;
  readonly nodeProof: GraphNodeIdentityProof;
  readonly parentProof: GraphNodeIdentityProof | null;
  readonly outgoingEdges: readonly ProjectGraphEdge[];
  readonly outgoingTargetProofs: readonly GraphNodeIdentityProof[];
  readonly activeRuns: readonly ActiveRunReadModel[];
};

export type ProjectActivityManifestReadModel = {
  readonly schema: typeof ACTIVITY_MANIFEST_SCHEMA;
  readonly checkpoint: EventLogCheckpoint;
  readonly projectId: string;
  readonly counts: {
    readonly nodes: number;
    readonly runs: number;
    readonly evidence: number;
    readonly comparisons: number;
    readonly decisions: number;
    readonly coaching: number;
    readonly reviews: number;
  };
};

export type NodeActivityCategoryIndex = {
  readonly count: number;
  readonly pageCount: number;
  readonly pageCommitmentRoot: string;
};

export type NodeActivityIndexReadModel = {
  readonly schema: typeof NODE_ACTIVITY_INDEX_SCHEMA;
  readonly checkpoint: EventLogCheckpoint;
  readonly projectId: string;
  readonly nodeSha: string;
  readonly categories: Readonly<Record<NodeActivityKind, NodeActivityCategoryIndex>>;
};

export type NodeActivityEntriesByKind = {
  readonly runs: readonly RunActivityReadModel[];
  readonly evidence: readonly EvidenceActivityReadModel[];
  readonly comparisons: readonly ComparisonActivityReadModel[];
  readonly decisions: readonly DecisionActivityReadModel[];
  readonly coaching: readonly CoachingActivityReadModel[];
  readonly reviews: readonly ReviewActivityReadModel[];
};

export type NodeActivityPageProofStep = {
  readonly side: "left" | "right";
  readonly digest: string;
};

export type NodeActivityPageMembershipProof = {
  readonly siblings: readonly NodeActivityPageProofStep[];
};

export type NodeActivityPageReadModel<K extends NodeActivityKind = NodeActivityKind> = {
  readonly schema: typeof NODE_ACTIVITY_PAGE_SCHEMA;
  readonly checkpoint: EventLogCheckpoint;
  readonly projectId: string;
  readonly nodeSha: string;
  readonly kind: K;
  readonly index: number;
  readonly offset: number;
  readonly entries: NodeActivityEntriesByKind[K];
  readonly membershipProof: NodeActivityPageMembershipProof;
};

type NodeActivityRecordValueByKind = {
  readonly comparisons: ComparisonActivityReadModel;
  readonly coaching: CoachingActivityReadModel;
  readonly reviews: ReviewActivityReadModel;
};

export type NodeActivityRecordReadModel<K extends KeyedNodeActivityKind = KeyedNodeActivityKind> = {
  readonly schema: typeof NODE_ACTIVITY_RECORD_SCHEMA;
  readonly checkpoint: EventLogCheckpoint;
  readonly projectId: string;
  readonly nodeSha: string;
  readonly kind: K;
  readonly id: string;
  readonly pageIndex: number;
  readonly entryIndex: number;
  readonly value: NodeActivityRecordValueByKind[K];
};

/** Bounded Node-inspector snapshot assembled from at most one page per kind. */
export type NodeActivitySummaryReadModel = NodeActivityEntriesByKind;

export type RunActivityShardReadModel = {
  readonly schema: typeof RUN_ACTIVITY_SCHEMA;
  readonly checkpoint: EventLogCheckpoint;
  readonly projectId: string;
  readonly run: RunActivityReadModel;
  readonly evidence: readonly EvidenceActivityReadModel[];
  readonly reviews: readonly ReviewActivityReadModel[];
};

export type EventShardDescriptor = {
  readonly index: number;
  readonly path: string;
  readonly sequenceStart: number;
  readonly sequenceEnd: number;
  readonly count: number;
  readonly firstStoredEventId: string;
  readonly lastStoredEventId: string;
  readonly firstDomainEventId: string;
  readonly lastDomainEventId: string;
  readonly digest: string;
};

export type ProjectEventManifestReadModel = {
  readonly schema: typeof EVENT_MANIFEST_SCHEMA;
  readonly checkpoint: EventLogCheckpoint;
  readonly projectId: string;
  readonly shardSize: typeof EVENT_INDEX_SHARD_SIZE;
  readonly shards: readonly EventShardDescriptor[];
  readonly locatorCount: number;
};

export type ProjectEventShardReadModel = {
  readonly schema: typeof EVENT_SHARD_SCHEMA;
  readonly checkpoint: EventLogCheckpoint;
  readonly projectId: string;
  readonly index: number;
  readonly sequenceStart: number;
  readonly sequenceEnd: number;
  readonly entries: readonly EventIndexEntryReadModel[];
};

export type ProjectEventLocatorReadModel = {
  readonly schema: typeof EVENT_LOCATOR_SCHEMA;
  readonly checkpoint: EventLogCheckpoint;
  readonly projectId: string;
  readonly eventId: string;
  readonly entry: EventIndexEntryReadModel;
};

export type ReverseEventScanResult = {
  readonly entries: readonly EventIndexEntryReadModel[];
  readonly lastInspectedSequence: number | null;
  readonly hasOlder: boolean;
  readonly inspectedCount: number;
};

/**
 * Scan already-decoded newest-to-oldest shards without crossing the caller's
 * bounded fetch window. A sparse filter still advances by the last inspected
 * sequence so the next request cannot loop or skip an uninspected Event.
 */
export function scanReverseEventShards(
  shards: readonly ProjectEventShardReadModel[],
  cursor: number,
  limit: number,
  matches: (entry: EventIndexEntryReadModel) => boolean
): ReverseEventScanResult {
  const candidates = shards.flatMap(shard => [...shard.entries].reverse()).sort((left, right) => right.sequence - left.sequence);
  const entries: EventIndexEntryReadModel[] = [];
  let lastInspectedSequence: number | null = null;
  let inspectedCount = 0;
  for (const entry of candidates) {
    if (entry.sequence >= cursor) continue;
    lastInspectedSequence = entry.sequence;
    inspectedCount += 1;
    if (matches(entry)) entries.push(entry);
    if (entries.length === limit) break;
  }
  return {
    entries,
    lastInspectedSequence,
    hasOlder: lastInspectedSequence !== null && lastInspectedSequence > 1,
    inspectedCount
  };
}

export function graphPagePath(index: number): string {
  return `graph/pages/${String(index).padStart(7, "0")}.json`;
}

export function graphNodePath(nodeSha: string): string {
  return `graph/nodes/${nodeSha}.json`;
}

export function nodeActivityIndexPath(nodeSha: string): string {
  return `snapshots/nodes/${nodeSha}/latest.json`;
}

export function nodeActivityPagePath(nodeSha: string, kind: NodeActivityKind, index: number): string {
  return `snapshots/nodes/${nodeSha}/${kind}/pages/${String(index).padStart(7, "0")}.json`;
}

export function nodeActivityRecordPath(nodeSha: string, kind: KeyedNodeActivityKind, id: string): string {
  return `snapshots/nodes/${nodeSha}/${kind}/by-id/${id}.json`;
}

export function runActivityPath(runId: string): string {
  return `snapshots/runs/${runId}.json`;
}

export function eventShardPath(index: number): string {
  return `indexes/events/shards/${String(index).padStart(7, "0")}.json`;
}

export function eventLocatorPath(eventId: string): string {
  return `indexes/events/by-domain/${eventId}.json`;
}

type GraphTopologyDigestInput = Pick<
  ProjectGraphManifestReadModel,
  "schema" | "projectId" | "rootNodeSha" | "nodeCount" | "edgeCount" | "pageSize" | "pages"
>;

type GraphIdentityPageCommitment = {
  readonly root: string;
  readonly proofs: readonly GraphNodeIdentityProof[];
};

type NodeActivityCategoryCommitment = {
  readonly root: string;
  readonly proofs: readonly NodeActivityPageMembershipProof[];
};

/** Recomputable manifest commitment over every bounded Graph page descriptor. */
export function computeGraphTopologyDigest(input: GraphTopologyDigestInput): string {
  return `hunsu-graph-topology-v2:sha256:${sha256(canonicalJson({
    schema: input.schema,
    projectId: input.projectId,
    rootNodeSha: input.rootNodeSha,
    nodeCount: input.nodeCount,
    edgeCount: input.edgeCount,
    pageSize: input.pageSize,
    pages: input.pages.map(page => ({
      index: page.index,
      path: page.path,
      ordinalStart: page.ordinalStart,
      ordinalEnd: page.ordinalEnd,
      nodeCount: page.nodeCount,
      edgeCount: page.edgeCount,
      digest: page.digest,
      nodeIdentityRoot: page.nodeIdentityRoot
    }))
  }))}`;
}

/** Deterministic identity root for one canonical Graph page (at most 300 Nodes). */
export function computeGraphPageNodeIdentityRoot(projectId: string, nodes: readonly OrdinalGraphNode[]): string {
  if (nodes.length === 0) invalid("Graph identity page cannot be empty.");
  const pageIndex = Math.floor(nodes[0]!.ordinal / GRAPH_PAGE_SIZE);
  return buildGraphIdentityPageCommitment(projectId, nodes, pageIndex).root;
}

/** Deterministic membership proof used by page and single-Node shards. */
export function createGraphNodeIdentityProof(
  projectId: string,
  nodes: readonly OrdinalGraphNode[],
  pageIndex: number,
  leafIndex: number
): GraphNodeIdentityProof {
  const proof = buildGraphIdentityPageCommitment(projectId, nodes, pageIndex).proofs[leafIndex];
  return proof ?? invalid("Graph identity proof leaf index is outside its page.");
}

/**
 * Commits an arbitrarily long activity category behind one constant-size root.
 * Each caller-visible page receives a logarithmic proof with a fixed safe-depth
 * bound, so the Node index never grows with lifetime activity.
 */
export function createNodeActivityCategoryCommitment<K extends NodeActivityKind>(
  checkpoint: EventLogCheckpoint,
  projectId: string,
  nodeSha: string,
  kind: K,
  pages: readonly NodeActivityEntriesByKind[K][]
): NodeActivityCategoryCommitment {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(projectId) || projectId.includes("..")
    || !/^[0-9a-f]{40}$/u.test(nodeSha) || !NODE_ACTIVITY_KINDS.includes(kind)) {
    invalid("Node activity commitment identity is invalid.");
  }
  if (pages.length === 0) {
    return { root: nodeActivityEmptyRoot(checkpoint, projectId, nodeSha, kind), proofs: [] };
  }
  if (!Number.isSafeInteger(pages.length)
    || pages.some((entries, index) => entries.length === 0 || entries.length > NODE_ACTIVITY_PAGE_SIZE
      || index < pages.length - 1 && entries.length !== NODE_ACTIVITY_PAGE_SIZE)) {
    invalid("Node activity commitment pages are not canonically partitioned.");
  }
  const levels: string[][] = [pages.map((entries, index) => nodeActivityPageLeafDigest({
    checkpoint,
    projectId,
    nodeSha,
    kind,
    index,
    offset: index * NODE_ACTIVITY_PAGE_SIZE,
    entries
  }))];
  while (levels.at(-1)!.length > 1) {
    const previous = levels.at(-1)!;
    const next: string[] = [];
    for (let index = 0; index < previous.length; index += 2) {
      next.push(nodeActivityPageBranchDigest(previous[index]!, previous[index + 1] ?? previous[index]!));
    }
    levels.push(next);
  }
  if (levels.length - 1 > MAX_NODE_ACTIVITY_PROOF_STEPS) {
    invalid("Node activity membership proof depth exceeds its bound.");
  }
  const proofs = pages.map((_entries, leafIndex): NodeActivityPageMembershipProof => {
    const siblings: NodeActivityPageProofStep[] = [];
    let currentIndex = leafIndex;
    for (const level of levels.slice(0, -1)) {
      const isRight = currentIndex % 2 === 1;
      const siblingIndex = isRight ? currentIndex - 1 : Math.min(currentIndex + 1, level.length - 1);
      siblings.push({ side: isRight ? "left" : "right", digest: level[siblingIndex]! });
      currentIndex = Math.floor(currentIndex / 2);
    }
    return { siblings };
  });
  return { root: levels.at(-1)![0]!, proofs };
}

type NodeActivityPageLeafInput<K extends NodeActivityKind = NodeActivityKind> = {
  readonly checkpoint: EventLogCheckpoint;
  readonly projectId: string;
  readonly nodeSha: string;
  readonly kind: K;
  readonly index: number;
  readonly offset: number;
  readonly entries: NodeActivityEntriesByKind[K];
};

function nodeActivityPageLeafDigest(input: NodeActivityPageLeafInput): string {
  return `${NODE_ACTIVITY_PAGE_COMMITMENT_PREFIX}${sha256(canonicalJson({
    schema: NODE_ACTIVITY_PAGE_LEAF_SCHEMA,
    checkpoint: input.checkpoint,
    projectId: input.projectId,
    nodeSha: input.nodeSha,
    kind: input.kind,
    index: input.index,
    offset: input.offset,
    entries: input.entries
  }))}`;
}

function nodeActivityPageBranchDigest(left: string, right: string): string {
  return `${NODE_ACTIVITY_PAGE_COMMITMENT_PREFIX}${sha256(canonicalJson({
    schema: NODE_ACTIVITY_PAGE_BRANCH_SCHEMA,
    left,
    right
  }))}`;
}

function nodeActivityEmptyRoot(
  checkpoint: EventLogCheckpoint,
  projectId: string,
  nodeSha: string,
  kind: NodeActivityKind
): string {
  return `${NODE_ACTIVITY_PAGE_COMMITMENT_PREFIX}${sha256(canonicalJson({
    schema: NODE_ACTIVITY_EMPTY_ROOT_SCHEMA,
    checkpoint,
    projectId,
    nodeSha,
    kind
  }))}`;
}

function buildGraphIdentityPageCommitment(
  projectId: string,
  nodes: readonly OrdinalGraphNode[],
  pageIndex: number
): GraphIdentityPageCommitment {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(projectId) || projectId.includes("..")) {
    invalid("Graph identity Project id is invalid.");
  }
  if (!Number.isSafeInteger(pageIndex) || pageIndex < 0 || nodes.length === 0 || nodes.length > GRAPH_PAGE_SIZE) {
    invalid("Graph identity page bounds are invalid.");
  }
  const ordinalStart = pageIndex * GRAPH_PAGE_SIZE;
  if (!Number.isSafeInteger(ordinalStart) || nodes.some((node, position) => node.ordinal !== ordinalStart + position)) {
    invalid("Graph identity page Node ordinals are not contiguous.");
  }
  const identities = nodes.map(graphNodeTopologyIdentity);
  identities.forEach(identity => validateGraphTopologyIdentity(identity, projectId));
  const levels: string[][] = [identities.map(identity => graphIdentityLeafDigest(projectId, identity))];
  while (levels.at(-1)!.length > 1) {
    const previous = levels.at(-1)!;
    const next: string[] = [];
    for (let index = 0; index < previous.length; index += 2) {
      next.push(graphIdentityBranchDigest(previous[index]!, previous[index + 1] ?? previous[index]!));
    }
    levels.push(next);
  }
  if (levels.length - 1 > MAX_GRAPH_IDENTITY_PROOF_STEPS) invalid("Graph identity page proof depth exceeds its bound.");
  const proofs = identities.map((identity, leafIndex): GraphNodeIdentityProof => {
    const siblings: GraphNodeIdentityProofStep[] = [];
    let currentIndex = leafIndex;
    for (const level of levels.slice(0, -1)) {
      const isRight = currentIndex % 2 === 1;
      const siblingIndex = isRight ? currentIndex - 1 : Math.min(currentIndex + 1, level.length - 1);
      siblings.push({ side: isRight ? "left" : "right", digest: level[siblingIndex]! });
      currentIndex = Math.floor(currentIndex / 2);
    }
    return { pageIndex, leafIndex, identity, siblings };
  });
  return { root: levels.at(-1)![0]!, proofs };
}

function graphNodeTopologyIdentity(node: OrdinalGraphNode): GraphNodeTopologyIdentity {
  return {
    type: node.type,
    sha: node.sha,
    managedRef: node.managedRef,
    ordinal: node.ordinal,
    parentOrdinal: node.parentOrdinal,
    lineage: node.lineage
  };
}

function graphIdentityLeafDigest(projectId: string, identity: GraphNodeTopologyIdentity): string {
  return `${GRAPH_NODE_IDENTITY_DIGEST_PREFIX}${sha256(canonicalJson({
    schema: GRAPH_NODE_IDENTITY_LEAF_SCHEMA,
    projectId,
    identity
  }))}`;
}

function graphIdentityBranchDigest(left: string, right: string): string {
  return `${GRAPH_NODE_IDENTITY_DIGEST_PREFIX}${sha256(canonicalJson({
    schema: GRAPH_NODE_IDENTITY_BRANCH_SCHEMA,
    left,
    right
  }))}`;
}

export function buildShardedProjectReadModels(
  state: ProjectState,
  events: readonly VerifiedStoredProjectEvent<DomainEvent>[]
): StoreResult<Readonly<Record<string, ShardedReadModelEnvelope>>> {
  const project = state.projects[0];
  if (!project || state.projects.length !== 1) return failure("Read models require exactly one Project stream.");
  const checkpointResult = buildCheckpoint(events);
  if (!checkpointResult.ok) return checkpointResult;
  const checkpoint = checkpointResult.value;
  const root = state.nodes.find(node => node.projectId === project.id && node.type === "root");
  if (!root) return failure("Project read models require exactly one registered root Node.");

  const output: Record<string, ShardedReadModelEnvelope> = {};
  const catalog: ShardedProjectCatalogReadModel = {
    schema: SHARDED_PROJECT_SCHEMA,
    checkpoint,
    project: {
      id: String(project.id), workspaceId: String(project.workspaceId), title: String(project.title),
      repository: { owner: String(project.repository.owner), name: String(project.repository.name) },
      baseRef: String(project.baseRef), rootNodeSha: String(project.rootNodeSha), createdAt: String(project.createdAt)
    },
    counts: {
      nodes: state.nodes.length,
      activeRuns: state.runs.filter(run => run.projectId === project.id && run.status === "running").length,
      unresolvedDivergences: unresolvedDivergenceCount(state, project.id),
      events: checkpoint.eventCount
    },
    rootAnchor: {
      managedRef: String(root.managedRef), nodeSha: String(root.commitSha), treeSha: String(root.treeSha), commitTitle: String(root.commitTitle)
    }
  };
  const catalogEnvelope = encodeReadModel("catalog", catalog);
  if (!catalogEnvelope.ok) return catalogEnvelope;
  output[SHARDED_READ_MODEL_PATHS.project] = catalogEnvelope.value;

  const graphResult = materializeGraph(state, checkpoint);
  if (!graphResult.ok) return graphResult;
  Object.assign(output, graphResult.value);

  const activityResult = materializeActivity(state, events, checkpoint);
  if (!activityResult.ok) return activityResult;
  Object.assign(output, activityResult.value);

  const eventResult = materializeEvents(state, events, checkpoint);
  if (!eventResult.ok) return eventResult;
  Object.assign(output, eventResult.value);
  return ok(output);
}

function materializeGraph(
  state: ProjectState,
  checkpoint: EventLogCheckpoint
): StoreResult<Readonly<Record<string, ShardedReadModelEnvelope>>> {
  const project = state.projects[0]!;
  const projectNodes = state.nodes.filter(node => node.projectId === project.id);
  const projectNodeShas = projectNodes.map(node => String(node.commitSha));
  if (new Set(projectNodeShas).size !== projectNodeShas.length) {
    return failure("Graph materialization contains a duplicate full Node SHA.");
  }
  const ordinalBySha = new Map(projectNodes.map((node, ordinal) => [String(node.commitSha), ordinal]));
  const nodes: OrdinalGraphNode[] = [];
  for (const [ordinal, node] of projectNodes.entries()) {
    const parentSha = node.type === "root" ? undefined : String(node.parentSha);
    const parentOrdinal = parentSha === undefined ? null : ordinalBySha.get(parentSha);
    if (parentSha !== undefined && (parentOrdinal === undefined || (parentOrdinal !== null && parentOrdinal >= ordinal))) {
      return failure("Graph materialization is not in structural parent-before-child order.");
    }
    nodes.push({ ...graphNode(state, node), ordinal, parentOrdinal: parentOrdinal ?? null });
  }
  const allEdges = graphEdges(state, String(project.id));
  const edgeByTarget = new Map(allEdges.map(edge => [edge.targetSha, edge]));
  if (edgeByTarget.size !== allEdges.length) return failure("Graph contains duplicate incoming structural edges.");
  const activeRuns = state.runs.flatMap(run => run.projectId === project.id && run.status === "running" ? [activeRun(run)] : []);
  const output: Record<string, ShardedReadModelEnvelope> = {};
  const descriptors: GraphPageDescriptor[] = [];
  const pageCommitments = new Map<number, GraphIdentityPageCommitment>();
  const proofByOrdinal = new Map<number, GraphNodeIdentityProof>();

  for (let offset = 0, index = 0; offset < nodes.length; offset += GRAPH_PAGE_SIZE, index += 1) {
    const commitment = buildGraphIdentityPageCommitment(String(project.id), nodes.slice(offset, offset + GRAPH_PAGE_SIZE), index);
    pageCommitments.set(index, commitment);
    commitment.proofs.forEach(proof => proofByOrdinal.set(proof.identity.ordinal, proof));
  }

  for (let offset = 0, index = 0; offset < nodes.length; offset += GRAPH_PAGE_SIZE, index += 1) {
    const pageNodes = nodes.slice(offset, offset + GRAPH_PAGE_SIZE);
    const targetShas = new Set(pageNodes.map(node => node.sha));
    const externalParentOrdinals = [...new Set(pageNodes.flatMap(node =>
      node.parentOrdinal !== null && node.parentOrdinal < offset ? [node.parentOrdinal] : []
    ))].sort((left, right) => left - right);
    const externalParents = externalParentOrdinals.map(ordinal => proofByOrdinal.get(ordinal));
    if (externalParents.some(proof => proof === undefined)) return failure("Graph materialization is missing an external parent proof.");
    const page: ProjectGraphPageReadModel = {
      schema: GRAPH_PAGE_SCHEMA,
      checkpoint,
      projectId: String(project.id),
      index,
      ordinalStart: offset,
      nodes: pageNodes,
      externalParents: externalParents.filter((proof): proof is GraphNodeIdentityProof => proof !== undefined),
      edges: allEdges.filter(edge => targetShas.has(edge.targetSha)),
      activeRuns: activeRuns.filter(run => targetShas.has(run.sourceNodeSha))
    };
    const encoded = encodeReadModel("graphPage", page);
    if (!encoded.ok) return encoded;
    const path = graphPagePath(index);
    output[path] = encoded.value;
    const commitment = pageCommitments.get(index);
    if (!commitment) return failure("Graph materialization is missing a page identity commitment.");
    descriptors.push({
      index, path, ordinalStart: offset, ordinalEnd: offset + pageNodes.length - 1,
      nodeCount: pageNodes.length, edgeCount: page.edges.length, digest: encoded.value.digest,
      nodeIdentityRoot: commitment.root
    });
  }

  const nodeBySha = new Map(nodes.map(node => [node.sha, node]));
  for (const node of nodes) {
    const nodeProof = proofByOrdinal.get(node.ordinal);
    const parentProof = node.parentOrdinal === null ? null : proofByOrdinal.get(node.parentOrdinal);
    const outgoingEdges = allEdges.filter(edge => edge.sourceSha === node.sha);
    const outgoingTargetProofs = outgoingEdges.map(edge => {
      const target = nodeBySha.get(edge.targetSha);
      return target ? proofByOrdinal.get(target.ordinal) : undefined;
    });
    if (!nodeProof || parentProof === undefined || outgoingTargetProofs.some(proof => proof === undefined)) {
      return failure("Graph Node materialization is missing an identity membership proof.");
    }
    const nodeModel: ProjectGraphNodeReadModel = {
      schema: GRAPH_NODE_SCHEMA,
      checkpoint,
      projectId: String(project.id),
      node,
      nodeProof,
      parentProof,
      outgoingEdges,
      outgoingTargetProofs: outgoingTargetProofs.filter((proof): proof is GraphNodeIdentityProof => proof !== undefined),
      activeRuns: activeRuns.filter(run => run.sourceNodeSha === node.sha)
    };
    const encoded = encodeReadModel("graphNode", nodeModel);
    if (!encoded.ok) return encoded;
    output[graphNodePath(node.sha)] = encoded.value;
  }

  const manifestWithoutDigest: Omit<ProjectGraphManifestReadModel, "topologyDigest"> = {
    schema: GRAPH_MANIFEST_SCHEMA,
    checkpoint,
    projectId: String(project.id),
    rootNodeSha: String(project.rootNodeSha),
    nodeCount: nodes.length,
    edgeCount: allEdges.length,
    pageSize: GRAPH_PAGE_SIZE,
    pages: descriptors
  };
  const manifest: ProjectGraphManifestReadModel = {
    ...manifestWithoutDigest,
    topologyDigest: computeGraphTopologyDigest(manifestWithoutDigest)
  };
  const encodedManifest = encodeReadModel("graphManifest", manifest);
  if (!encodedManifest.ok) return encodedManifest;
  output[SHARDED_READ_MODEL_PATHS.graphManifest] = encodedManifest.value;
  return ok(output);
}

function materializeActivity(
  state: ProjectState,
  events: readonly StoredProjectEvent<DomainEvent>[],
  checkpoint: EventLogCheckpoint
): StoreResult<Readonly<Record<string, ShardedReadModelEnvelope>>> {
  const project = state.projects[0]!;
  const activityEventIds = activityEventIdMaps(events);
  if (!activityEventIds.ok) return activityEventIds;
  const runs = state.runs.filter(run => run.projectId === project.id).map(runActivity);
  const runsById = new Map(runs.map(run => [run.id, run]));
  const evidenceRows = state.evidence.filter(item => item.projectId === project.id).map(item => {
    const run = runsById.get(String(item.runId));
    return run ? evidenceActivity(item, run.goalDigest) : undefined;
  });
  if (evidenceRows.some(item => item === undefined)) return failure("Evidence activity is missing its owning Run.");
  const evidence = evidenceRows.filter((item): item is EvidenceActivityReadModel => item !== undefined);
  const decisionRows = projectDecisions(state, project.id).map(decision => {
    const eventId = activityEventIds.value.alternativeDecisions.get(String(decision.id));
    return eventId ? decisionActivity(decision, eventId) : undefined;
  });
  if (decisionRows.some(item => item === undefined)) {
    return failure("Alternative decision activity is missing its authoritative selection or rejection Event.");
  }
  const decisions = decisionRows.filter((item): item is DecisionActivityReadModel => item !== undefined);
  const comparisons = state.comparisons.filter(item => item.projectId === project.id).map(item => {
    const eventId = activityEventIds.value.comparisons.get(String(item.id));
    if (!eventId) return undefined;
    const comparisonDecisions = decisions.filter(decision => decision.comparisonId === String(item.id));
    const base = {
      id: String(item.id),
      eventId,
      nodeShas: item.nodeShas.map(String),
      summary: String(item.summary),
      recordedAt: String(item.recordedAt),
      disposition: comparisonDecisions.length === 0
        ? { type: "undecided" as const }
        : { type: "decisions_recorded" as const, decisions: comparisonDecisions }
    };
    return item.type === "sibling_runs"
      ? { ...base, type: "sibling_runs" as const, parentNodeSha: String(item.parentNodeSha) }
      : {
          ...base,
          type: "coached_how_experiment" as const,
          anchorNodeSha: String(item.anchorNodeSha),
          goalDigest: String(item.goalDigest)
        };
  });
  if (comparisons.some(item => item === undefined)) return failure("Comparison activity is missing its authoritative AlternativesCompared Event.");
  const typedComparisons = comparisons.filter((item): item is NonNullable<typeof item> => item !== undefined);
  const coaching = state.coachingProposals.filter(item => item.projectId === project.id).map(proposal => {
    const eventId = activityEventIds.value.proposals.get(String(proposal.id));
    if (!eventId) return undefined;
    const disposition = state.coachingProposalDecisions.find(item => item.proposalId === proposal.id);
    const decisionEventId = disposition
      ? activityEventIds.value.proposalDecisions.get(String(disposition.id))
      : undefined;
    const childRegistrationEventId = disposition?.status === "confirmed"
      ? activityEventIds.value.coachingChildren.get(String(proposal.id))
      : undefined;
    if (disposition && !decisionEventId || disposition?.status === "confirmed" && !childRegistrationEventId) return undefined;
    return {
      id: String(proposal.id), eventId, sourceNodeSha: String(proposal.sourceNodeSha),
      sourcePayloadDigest: String(proposal.sourcePayloadDigest), sourcePlanDigest: String(proposal.sourcePlanDigest),
      proposedPlanDigest: String(proposal.proposedPlanDigest), expectedStateSha: String(proposal.expectedStateSha),
      summary: String(proposal.summary), rationale: String(proposal.rationale), proposedAt: String(proposal.proposedAt),
      disposition: !disposition
        ? { type: "pending" as const }
        : disposition.status === "confirmed"
          ? {
              type: "confirmed" as const, decisionId: String(disposition.id), decisionEventId: decisionEventId!,
              childRegistrationEventId: childRegistrationEventId!, childNodeSha: String(disposition.childNodeSha),
              reason: String(disposition.reason), decidedAt: String(disposition.decidedAt)
            }
          : {
              type: "rejected" as const, decisionId: String(disposition.id), decisionEventId: decisionEventId!,
              reason: String(disposition.reason),
              decidedAt: String(disposition.decidedAt)
            }
    };
  });
  if (coaching.some(item => item === undefined)) {
    return failure("Coaching activity is missing an authoritative proposal, decision, or child-registration Event.");
  }
  const typedCoaching = coaching.filter((item): item is NonNullable<typeof item> => item !== undefined);
  const reviews = state.coachReviews.filter(item => item.projectId === project.id).map(review => {
    const eventId = activityEventIds.value.reviews.get(String(review.id));
    return eventId ? ({
    id: String(review.id), eventId, targetType: review.target.type,
    targetId: review.target.type === "node" ? String(review.target.nodeSha) : review.target.type === "run" ? String(review.target.runId) : String(review.target.comparisonId),
    assessment: String(review.assessment), recommendations: review.recommendations.map(String), recordedAt: String(review.recordedAt)
    }) : undefined;
  });
  if (reviews.some(item => item === undefined)) return failure("Coach review activity is missing its authoritative CoachReviewRecorded Event.");
  const typedReviews = reviews.filter((item): item is NonNullable<typeof item> => item !== undefined);
  const output: Record<string, ShardedReadModelEnvelope> = {};

  const manifest: ProjectActivityManifestReadModel = {
    schema: ACTIVITY_MANIFEST_SCHEMA,
    checkpoint,
    projectId: String(project.id),
    counts: {
      nodes: state.nodes.filter(node => node.projectId === project.id).length,
      runs: runs.length,
      evidence: evidence.length,
      comparisons: typedComparisons.length,
      decisions: decisions.length,
      coaching: typedCoaching.length,
      reviews: typedReviews.length
    }
  };
  const manifestEnvelope = encodeReadModel("activityManifest", manifest);
  if (!manifestEnvelope.ok) return manifestEnvelope;
  output[SHARDED_READ_MODEL_PATHS.activityManifest] = manifestEnvelope.value;

  for (const node of state.nodes.filter(node => node.projectId === project.id)) {
    const nodeSha = String(node.commitSha);
    const nodeRuns = runs.filter(run => run.sourceNodeSha === nodeSha
      || run.outcome.type === "completed" && run.outcome.nodeSha === nodeSha);
    const runIds = new Set(nodeRuns.map(run => run.id));
    const nodeComparisons = typedComparisons.filter(item => comparisonRelatesToNode(item, nodeSha));
    const comparisonIds = new Set(nodeComparisons.map(item => item.id));
    const entries: NodeActivityEntriesByKind = {
      runs: [...nodeRuns].sort(compareRunActivity),
      evidence: evidence.filter(item => runIds.has(item.runId)).sort(compareRecordedActivity),
      comparisons: [...nodeComparisons].sort(compareRecordedActivity),
      decisions: decisions.filter(item => item.nodeShas.includes(nodeSha) || comparisonIds.has(item.comparisonId)).sort(compareDecisionActivity),
      coaching: typedCoaching.filter(item => item.sourceNodeSha === nodeSha).sort(compareCoachingActivity),
      reviews: typedReviews.filter(item => item.targetType === "node" && item.targetId === nodeSha
        || item.targetType === "run" && runIds.has(item.targetId)
        || item.targetType === "comparison" && comparisonIds.has(item.targetId)).sort(compareRecordedActivity)
    };
    const categories = {} as Record<NodeActivityKind, NodeActivityCategoryIndex>;
    for (const kind of NODE_ACTIVITY_KINDS) {
      const materialized = materializeNodeActivityPages(checkpoint, String(project.id), nodeSha, kind, entries[kind]);
      if (!materialized.ok) return materialized;
      Object.assign(output, materialized.value.files);
      categories[kind] = materialized.value.index;
    }
    const index: NodeActivityIndexReadModel = {
      schema: NODE_ACTIVITY_INDEX_SCHEMA,
      checkpoint,
      projectId: String(project.id),
      nodeSha,
      categories
    };
    const encodedIndex = encodeReadModel("nodeActivityIndex", index);
    if (!encodedIndex.ok) return encodedIndex;
    output[nodeActivityIndexPath(nodeSha)] = encodedIndex.value;

    for (const kind of KEYED_NODE_ACTIVITY_KINDS) {
      for (const [entryOffset, value] of entries[kind].entries()) {
        const record: NodeActivityRecordReadModel = {
          schema: NODE_ACTIVITY_RECORD_SCHEMA,
          checkpoint,
          projectId: String(project.id),
          nodeSha,
          kind,
          id: value.id,
          pageIndex: Math.floor(entryOffset / NODE_ACTIVITY_PAGE_SIZE),
          entryIndex: entryOffset % NODE_ACTIVITY_PAGE_SIZE,
          value
        } as NodeActivityRecordReadModel;
        const encodedRecord = encodeReadModel("nodeActivityRecord", record);
        if (!encodedRecord.ok) return encodedRecord;
        output[nodeActivityRecordPath(nodeSha, kind, value.id)] = encodedRecord.value;
      }
    }
  }

  for (const run of runs) {
    const shard: RunActivityShardReadModel = {
      schema: RUN_ACTIVITY_SCHEMA,
      checkpoint,
      projectId: String(project.id),
      run,
      evidence: evidence.filter(item => item.runId === run.id),
      reviews: typedReviews.filter(item => item.targetType === "run" && item.targetId === run.id)
    };
    const encoded = encodeReadModel("runActivity", shard);
    if (!encoded.ok) return encoded;
    output[runActivityPath(run.id)] = encoded.value;
  }
  return ok(output);
}

function materializeNodeActivityPages(
  checkpoint: EventLogCheckpoint,
  projectId: string,
  nodeSha: string,
  kind: NodeActivityKind,
  entries: NodeActivityEntriesByKind[NodeActivityKind]
): StoreResult<{
  readonly index: NodeActivityCategoryIndex;
  readonly files: Readonly<Record<string, ShardedReadModelEnvelope>>;
}> {
  const files: Record<string, ShardedReadModelEnvelope> = {};
  const pageEntries = Array.from(
    { length: Math.ceil(entries.length / NODE_ACTIVITY_PAGE_SIZE) },
    (_, index) => entries.slice(index * NODE_ACTIVITY_PAGE_SIZE, (index + 1) * NODE_ACTIVITY_PAGE_SIZE)
  ) as readonly NodeActivityEntriesByKind[NodeActivityKind][];
  const commitment = createNodeActivityCategoryCommitment(checkpoint, projectId, nodeSha, kind, pageEntries);
  for (const [index, entriesForPage] of pageEntries.entries()) {
    const offset = index * NODE_ACTIVITY_PAGE_SIZE;
    const page: NodeActivityPageReadModel = {
      schema: NODE_ACTIVITY_PAGE_SCHEMA,
      checkpoint,
      projectId,
      nodeSha,
      kind,
      index,
      offset,
      entries: entriesForPage,
      membershipProof: commitment.proofs[index]!
    } as NodeActivityPageReadModel;
    const encoded = encodeReadModel("nodeActivityPage", page);
    if (!encoded.ok) return encoded;
    const path = nodeActivityPagePath(nodeSha, kind, index);
    files[path] = encoded.value;
  }
  return ok({
    index: {
      count: entries.length,
      pageCount: pageEntries.length,
      pageCommitmentRoot: commitment.root
    },
    files
  });
}

function activityEventIdMaps(events: readonly StoredProjectEvent<DomainEvent>[]): StoreResult<{
  readonly reviews: ReadonlyMap<string, string>;
  readonly proposals: ReadonlyMap<string, string>;
  readonly proposalDecisions: ReadonlyMap<string, string>;
  readonly coachingChildren: ReadonlyMap<string, string>;
  readonly comparisons: ReadonlyMap<string, string>;
  readonly alternativeDecisions: ReadonlyMap<string, string>;
}> {
  const reviews = new Map<string, string>();
  const proposals = new Map<string, string>();
  const proposalDecisions = new Map<string, string>();
  const coachingChildren = new Map<string, string>();
  const comparisons = new Map<string, string>();
  const alternativeDecisions = new Map<string, string>();
  for (const stored of events) {
    let target: Map<string, string> | undefined;
    let id: string | undefined;
    switch (stored.event.type) {
      case "CoachReviewRecorded":
        target = reviews;
        id = String(stored.event.review.id);
        break;
      case "CoachingProposalRecorded":
        target = proposals;
        id = String(stored.event.proposal.id);
        break;
      case "CoachingProposalConfirmed":
      case "CoachingProposalRejected":
        target = proposalDecisions;
        id = String(stored.event.decision.id);
        break;
      case "CoachingChildNodeRegistered":
        target = coachingChildren;
        id = String(stored.event.node.proposalId);
        break;
      case "AlternativesCompared":
        target = comparisons;
        id = String(stored.event.comparison.id);
        break;
      case "AlternativeSelected":
      case "AlternativesRejected":
        target = alternativeDecisions;
        id = String(stored.event.decision.id);
        break;
      default:
        continue;
    }
    if (target.has(id)) return failure(`Activity ${id} has more than one authoritative recording Event.`);
    target.set(id, String(stored.event.meta.eventId));
  }
  return ok({ reviews, proposals, proposalDecisions, coachingChildren, comparisons, alternativeDecisions });
}

function comparisonRelatesToNode(item: ComparisonActivityReadModel, nodeSha: string): boolean {
  return item.nodeShas.includes(nodeSha)
    || item.type === "sibling_runs" && item.parentNodeSha === nodeSha
    || item.type === "coached_how_experiment" && item.anchorNodeSha === nodeSha;
}

function materializeEvents(
  state: ProjectState,
  events: readonly StoredProjectEvent<DomainEvent>[],
  checkpoint: EventLogCheckpoint
): StoreResult<Readonly<Record<string, ShardedReadModelEnvelope>>> {
  const project = state.projects[0]!;
  const ordered = [...events].sort((left, right) => left.sequence - right.sequence);
  const projected = eventListProjection(state, ordered.map(entry => ({ sequence: entry.sequence, event: entry.event, actor: entry.event.meta.actor })));
  const entries: EventIndexEntryReadModel[] = projected.map((item, index) => {
    const stored = ordered[index]!;
    return {
      sequence: item.sequence,
      storedEventId: stored.eventId,
      domainEventId: item.id,
      eventType: item.type,
      summary: item.summary,
      actor: item.actor,
      occurredAt: item.occurredAt,
      path: authoritativeEventPath(String(stored.projectId), stored.occurredAt, stored.eventId),
      reference: item.reference
    };
  });
  const output: Record<string, ShardedReadModelEnvelope> = {};
  const descriptors: EventShardDescriptor[] = [];
  for (let offset = 0, index = 0; offset < entries.length; offset += EVENT_INDEX_SHARD_SIZE, index += 1) {
    const shardEntries = entries.slice(offset, offset + EVENT_INDEX_SHARD_SIZE);
    const shard: ProjectEventShardReadModel = {
      schema: EVENT_SHARD_SCHEMA,
      checkpoint,
      projectId: String(project.id),
      index,
      sequenceStart: shardEntries[0]!.sequence,
      sequenceEnd: shardEntries.at(-1)!.sequence,
      entries: shardEntries
    };
    const encoded = encodeReadModel("eventShard", shard);
    if (!encoded.ok) return encoded;
    const path = eventShardPath(index);
    output[path] = encoded.value;
    descriptors.push({
      index, path, sequenceStart: shard.sequenceStart, sequenceEnd: shard.sequenceEnd, count: shardEntries.length,
      firstStoredEventId: shardEntries[0]!.storedEventId, lastStoredEventId: shardEntries.at(-1)!.storedEventId,
      firstDomainEventId: shardEntries[0]!.domainEventId, lastDomainEventId: shardEntries.at(-1)!.domainEventId,
      digest: encoded.value.digest
    });
  }
  for (const entry of entries) {
    const locator: ProjectEventLocatorReadModel = {
      schema: EVENT_LOCATOR_SCHEMA,
      checkpoint,
      projectId: String(project.id),
      eventId: entry.domainEventId,
      entry
    };
    const encoded = encodeReadModel("eventLocator", locator);
    if (!encoded.ok) return encoded;
    output[eventLocatorPath(entry.domainEventId)] = encoded.value;
  }
  const manifest: ProjectEventManifestReadModel = {
    schema: EVENT_MANIFEST_SCHEMA,
    checkpoint,
    projectId: String(project.id),
    shardSize: EVENT_INDEX_SHARD_SIZE,
    shards: descriptors,
    locatorCount: entries.length
  };
  const encodedManifest = encodeReadModel("eventManifest", manifest);
  if (!encodedManifest.ok) return encodedManifest;
  output[SHARDED_READ_MODEL_PATHS.eventManifest] = encodedManifest.value;
  return ok(output);
}

function graphNode(state: ProjectState, node: Node): ProjectGraphNode {
  return {
    type: node.type,
    sha: String(node.commitSha), treeSha: String(node.treeSha), managedRef: String(node.managedRef),
    commitTitle: String(node.commitTitle), registeredAt: String(node.registeredAt),
    planDigest: String(node.planDigest), payloadDigest: String(node.payloadDigest),
    runner: {
      name: String(node.plan.how.name), origin: String(node.plan.how.type.origin), typeKey: String(node.plan.how.type.key),
      schemaVersion: String(node.plan.how.type.schemaVersion), digest: String(computeRunnerDigest(node.plan.how))
    },
    nextGoalCount: node.plan.nextGoals.length,
    status: nodeStatus(state, node),
    lineage: node.type === "root"
      ? { type: "root" }
      : node.type === "run_child"
        ? { type: "run", parentSha: String(node.parentSha), runId: String(node.runId), consumedGoalDigest: String(node.consumedGoalDigest) }
        : { type: "coaching", parentSha: String(node.parentSha), proposalId: String(node.proposalId) }
  };
}

function graphEdges(state: ProjectState, projectId: string): ProjectGraphEdge[] {
  const edges: ProjectGraphEdge[] = [];
  for (const node of state.nodes) {
    if (String(node.projectId) !== projectId || node.type === "root") continue;
    if (node.type === "run_child") {
      const run = state.runs.find(candidate => candidate.projectId === node.projectId && candidate.id === node.runId && candidate.status === "completed");
      if (!run || run.status !== "completed") continue;
      edges.push({
        type: "run", sourceSha: String(node.parentSha), targetSha: String(node.commitSha), runId: String(run.id),
        goalDigest: String(run.goalDigest), goalTitle: String(run.goal.title), completedAt: String(run.completedAt)
      });
    } else {
      const proposal = state.coachingProposals.find(candidate => candidate.projectId === node.projectId && candidate.id === node.proposalId);
      const decision = state.coachingProposalDecisions.find(candidate => candidate.proposalId === node.proposalId && candidate.status === "confirmed");
      if (!proposal || !decision || decision.status !== "confirmed") continue;
      edges.push({
        type: "coaching", sourceSha: String(node.parentSha), targetSha: String(node.commitSha), proposalId: String(node.proposalId),
        summary: String(proposal.summary), confirmedAt: String(decision.decidedAt)
      });
    }
  }
  return edges;
}

function activeRun(run: Run): ActiveRunReadModel {
  return {
    id: String(run.id), sourceNodeSha: String(run.sourceNodeSha), goalDigest: String(run.goalDigest),
    goalTitle: String(run.goal.title), runnerName: String(run.runner.name), startedAt: String(run.startedAt)
  };
}

function runActivity(run: Run): RunActivityReadModel {
  return {
    ...activeRun(run),
    runnerDigest: String(run.runnerDigest),
    branch: String(run.branch),
    checkpoints: run.checkpoints.map(checkpoint => ({
      id: String(checkpoint.id), summary: String(checkpoint.summary), recordedAt: String(checkpoint.recordedAt),
      location: checkpoint.location.type === "observation"
        ? { type: "observation" as const }
        : { type: "commit" as const, commitSha: String(checkpoint.location.commitSha) }
    })),
    evidenceIds: run.evidenceIds.map(String),
    outcome: run.status === "running"
      ? { type: "running" as const }
      : run.status === "completed"
        ? { type: "completed" as const, nodeSha: String(run.resultNodeSha), verifiedAt: String(run.verifiedAt), completedAt: String(run.completedAt) }
        : run.status === "failed"
          ? { type: "failed" as const, failedAt: String(run.failedAt), reason: String(run.failureReason) }
          : { type: "canceled" as const, canceledAt: String(run.canceledAt), reason: String(run.cancellationReason) }
  };
}

function evidenceActivity(item: ProjectState["evidence"][number], goalDigest: string): EvidenceActivityReadModel {
  return {
    id: String(item.id), runId: String(item.runId), goalDigest, kind: item.kind, summary: String(item.summary),
    target: item.target.type === "run" ? { type: "run" } : { type: "criterion", criterion: String(item.target.criterion) },
    location: item.location.type === "git"
      ? { type: "git", commitSha: String(item.location.commitSha), path: String(item.location.path) }
      : item.location.type === "url" ? { type: "url", url: String(item.location.url) } : { type: "text", text: String(item.location.text) },
    recordedAt: String(item.recordedAt)
  };
}

function compareRunActivity(left: RunActivityReadModel, right: RunActivityReadModel): number {
  return left.startedAt.localeCompare(right.startedAt) || left.id.localeCompare(right.id);
}

function compareRecordedActivity(
  left: EvidenceActivityReadModel | ComparisonActivityReadModel | ReviewActivityReadModel,
  right: EvidenceActivityReadModel | ComparisonActivityReadModel | ReviewActivityReadModel
): number {
  return left.recordedAt.localeCompare(right.recordedAt) || left.id.localeCompare(right.id);
}

function compareDecisionActivity(left: DecisionActivityReadModel, right: DecisionActivityReadModel): number {
  return left.decidedAt.localeCompare(right.decidedAt) || left.id.localeCompare(right.id);
}

function compareCoachingActivity(left: CoachingActivityReadModel, right: CoachingActivityReadModel): number {
  return left.proposedAt.localeCompare(right.proposedAt) || left.id.localeCompare(right.id);
}

function decisionActivity(decision: AlternativeDecision, eventId: string): DecisionActivityReadModel {
  return {
    id: String(decision.id), eventId, type: decision.type, comparisonId: String(decision.comparisonId),
    nodeShas: decision.type === "selection" ? [String(decision.selectedNodeSha)] : decision.rejectedNodeShas.map(String),
    rationale: String(decision.rationale), decidedAt: String(decision.decidedAt)
  };
}

function projectDecisions(state: ProjectState, projectId: ProjectState["projects"][number]["id"]): readonly AlternativeDecision[] {
  const comparisons = new Set(state.comparisons.filter(item => item.projectId === projectId).map(item => item.id));
  return state.decisions.filter(item => item.projectId === projectId && comparisons.has(item.comparisonId));
}

function nodeStatus(state: ProjectState, node: Node): ProjectGraphNode["status"] {
  const decisions = projectDecisions(state, node.projectId);
  if (decisions.some(item => item.type === "rejection" && item.rejectedNodeShas.includes(node.commitSha))) return "rejected";
  if (decisions.some(item => item.type === "selection" && item.selectedNodeSha === node.commitSha)) return "selected";
  if (node.type === "root" && state.nodes.filter(item => item.projectId === node.projectId).length === 1) return "current";
  return "available";
}

export function decodeShardedProjectCatalog(input: unknown): StoreResult<ShardedProjectCatalogReadModel> {
  return decodeReadModel(input, "catalog", value => {
    const root = exactRecord(value, ["schema", "checkpoint", "project", "counts", "rootAnchor"]);
    if (root.schema !== SHARDED_PROJECT_SCHEMA) invalid("Project catalog schema is unsupported.");
    const project = exactRecord(root.project, ["id", "workspaceId", "title", "repository", "baseRef", "rootNodeSha", "createdAt"]);
    const repository = exactRecord(project.repository, ["owner", "name"]);
    const counts = exactRecord(root.counts, ["nodes", "activeRuns", "unresolvedDivergences", "events"]);
    const anchor = exactRecord(root.rootAnchor, ["managedRef", "nodeSha", "treeSha", "commitTitle"]);
    const decoded: ShardedProjectCatalogReadModel = {
      schema: SHARDED_PROJECT_SCHEMA,
      checkpoint: decodeCheckpoint(root.checkpoint),
      project: {
        id: safeId(project.id, "project.id"), workspaceId: safeId(project.workspaceId, "project.workspaceId"),
        title: text(project.title, "project.title"),
        repository: { owner: text(repository.owner, "repository.owner"), name: text(repository.name, "repository.name") },
        baseRef: text(project.baseRef, "project.baseRef"), rootNodeSha: sha(project.rootNodeSha, "project.rootNodeSha"),
        createdAt: timestamp(project.createdAt, "project.createdAt")
      },
      counts: {
        nodes: positive(counts.nodes, "counts.nodes"), activeRuns: nonNegative(counts.activeRuns, "counts.activeRuns"),
        unresolvedDivergences: nonNegative(counts.unresolvedDivergences, "counts.unresolvedDivergences"),
        events: positive(counts.events, "counts.events")
      },
      rootAnchor: {
        managedRef: text(anchor.managedRef, "rootAnchor.managedRef"), nodeSha: sha(anchor.nodeSha, "rootAnchor.nodeSha"),
        treeSha: sha(anchor.treeSha, "rootAnchor.treeSha"), commitTitle: text(anchor.commitTitle, "rootAnchor.commitTitle")
      }
    };
    if (decoded.project.rootNodeSha !== decoded.rootAnchor.nodeSha
      || decoded.rootAnchor.managedRef !== `refs/tags/hunsu/node/${decoded.project.id}/${decoded.rootAnchor.nodeSha}`
      || decoded.counts.events !== decoded.checkpoint.eventCount
    ) invalid("Project catalog root anchor or counts do not match its checkpoint.");
    return decoded;
  });
}

export function decodeGraphManifest(input: unknown): StoreResult<ProjectGraphManifestReadModel> {
  return decodeReadModel(input, "graphManifest", value => {
    const root = exactRecord(value, ["schema", "checkpoint", "projectId", "rootNodeSha", "nodeCount", "edgeCount", "pageSize", "pages", "topologyDigest"]);
    if (root.schema !== GRAPH_MANIFEST_SCHEMA || root.pageSize !== GRAPH_PAGE_SIZE) invalid("Graph manifest schema or page size is unsupported.");
    const pages = array(root.pages, "pages").map((item, index): GraphPageDescriptor => {
      const page = exactRecord(item, ["index", "path", "ordinalStart", "ordinalEnd", "nodeCount", "edgeCount", "digest", "nodeIdentityRoot"]);
      const decoded = {
        index: nonNegative(page.index, "page.index"), path: text(page.path, "page.path"),
        ordinalStart: nonNegative(page.ordinalStart, "page.ordinalStart"), ordinalEnd: nonNegative(page.ordinalEnd, "page.ordinalEnd"),
        nodeCount: positive(page.nodeCount, "page.nodeCount"), edgeCount: nonNegative(page.edgeCount, "page.edgeCount"),
        digest: digest(page.digest, "graphPage"), nodeIdentityRoot: graphNodeIdentityDigest(page.nodeIdentityRoot)
      };
      if (decoded.index !== index || decoded.path !== graphPagePath(index) || decoded.nodeCount > GRAPH_PAGE_SIZE
        || decoded.ordinalStart !== index * GRAPH_PAGE_SIZE
        || decoded.ordinalEnd !== decoded.ordinalStart + decoded.nodeCount - 1
      ) invalid("Graph page descriptors are not contiguous or canonical.");
      return decoded;
    });
    const decoded: ProjectGraphManifestReadModel = {
      schema: GRAPH_MANIFEST_SCHEMA, checkpoint: decodeCheckpoint(root.checkpoint),
      projectId: safeId(root.projectId, "projectId"), rootNodeSha: sha(root.rootNodeSha, "rootNodeSha"),
      nodeCount: positive(root.nodeCount, "nodeCount"), edgeCount: nonNegative(root.edgeCount, "edgeCount"),
      pageSize: GRAPH_PAGE_SIZE, pages, topologyDigest: topologyDigest(root.topologyDigest)
    };
    if (pages.length !== Math.ceil(decoded.nodeCount / GRAPH_PAGE_SIZE)
      || pages.some((page, index) => index < pages.length - 1
        ? page.nodeCount !== GRAPH_PAGE_SIZE
        : page.nodeCount !== decoded.nodeCount - page.ordinalStart
          || page.ordinalEnd !== decoded.nodeCount - 1)
      || pages.reduce((sum, page) => sum + page.nodeCount, 0) !== decoded.nodeCount
      || pages.reduce((sum, page) => sum + page.edgeCount, 0) !== decoded.edgeCount
      || decoded.edgeCount !== decoded.nodeCount - 1
    ) invalid("Graph manifest counts do not describe a single-root structural tree.");
    if (decoded.topologyDigest !== computeGraphTopologyDigest(decoded)) {
      invalid("Graph manifest topology digest does not match its page commitments.");
    }
    return decoded;
  });
}

export function decodeGraphPage(input: unknown): StoreResult<ProjectGraphPageReadModel> {
  return decodeReadModel(input, "graphPage", value => {
    const root = exactRecord(value, ["schema", "checkpoint", "projectId", "index", "ordinalStart", "nodes", "externalParents", "edges", "activeRuns"]);
    if (root.schema !== GRAPH_PAGE_SCHEMA) invalid("Graph page schema is unsupported.");
    const index = nonNegative(root.index, "index");
    const ordinalStart = nonNegative(root.ordinalStart, "ordinalStart");
    const nodes = array(root.nodes, "nodes").map(decodeOrdinalGraphNode);
    const externalParents = array(root.externalParents, "externalParents").map(decodeGraphNodeIdentityProof);
    const edges = array(root.edges, "edges").map(decodeGraphEdge);
    const activeRuns = array(root.activeRuns, "activeRuns").map(decodeActiveRun);
    const decoded: ProjectGraphPageReadModel = {
      schema: GRAPH_PAGE_SCHEMA, checkpoint: decodeCheckpoint(root.checkpoint), projectId: safeId(root.projectId, "projectId"),
      index, ordinalStart, nodes, externalParents, edges, activeRuns
    };
    validateGraphPage(decoded);
    return decoded;
  });
}

export function decodeGraphNodeShard(input: unknown): StoreResult<ProjectGraphNodeReadModel> {
  return decodeReadModel(input, "graphNode", value => {
    const root = exactRecord(value, [
      "schema", "checkpoint", "projectId", "node", "nodeProof", "parentProof",
      "outgoingEdges", "outgoingTargetProofs", "activeRuns"
    ]);
    if (root.schema !== GRAPH_NODE_SCHEMA) invalid("Graph Node shard schema is unsupported.");
    const decoded: ProjectGraphNodeReadModel = {
      schema: GRAPH_NODE_SCHEMA, checkpoint: decodeCheckpoint(root.checkpoint), projectId: safeId(root.projectId, "projectId"),
      node: decodeOrdinalGraphNode(root.node), nodeProof: decodeGraphNodeIdentityProof(root.nodeProof),
      parentProof: root.parentProof === null ? null : decodeGraphNodeIdentityProof(root.parentProof),
      outgoingEdges: array(root.outgoingEdges, "outgoingEdges").map(decodeGraphEdge),
      outgoingTargetProofs: array(root.outgoingTargetProofs, "outgoingTargetProofs").map(decodeGraphNodeIdentityProof),
      activeRuns: array(root.activeRuns, "activeRuns").map(decodeActiveRun)
    };
    validateGraphNodeShardShape(decoded);
    return decoded;
  });
}

/**
 * Binds a decoded page to the exact manifest page roots. Call this after the
 * selected page envelope digest and checkpoint have been matched by the store.
 */
export function validateGraphPageTopology(
  manifest: ProjectGraphManifestReadModel,
  page: ProjectGraphPageReadModel
): StoreResult<true> {
  try {
    if (manifest.topologyDigest !== computeGraphTopologyDigest(manifest)) {
      invalid("Graph manifest topology digest does not match its page commitments.");
    }
    if (page.projectId !== manifest.projectId || canonicalJson(page.checkpoint) !== canonicalJson(manifest.checkpoint)) {
      invalid("Graph page Project or checkpoint does not match its manifest.");
    }
    validateGraphPage(page);
    const descriptor = manifest.pages[page.index];
    if (!descriptor || descriptor.index !== page.index || descriptor.ordinalStart !== page.ordinalStart
      || descriptor.nodeCount !== page.nodes.length || descriptor.edgeCount !== page.edges.length) {
      invalid("Graph page does not match its manifest descriptor.");
    }
    if (computeGraphPageNodeIdentityRoot(page.projectId, page.nodes) !== descriptor.nodeIdentityRoot) {
      invalid("Graph page Node identities do not match their manifest root.");
    }
    page.externalParents.forEach(proof => verifyGraphNodeIdentityProof(manifest, proof));
    const rootNode = page.index === 0 ? page.nodes[0] : undefined;
    if (rootNode && rootNode.sha !== manifest.rootNodeSha) invalid("Graph manifest root Node does not match page zero.");
    return ok(true);
  } catch (error) {
    return failure(error instanceof Error ? error.message : "Graph page topology validation failed.");
  }
}

/**
 * Binds a single-Node shard, its structural parent, and every outgoing target
 * to the page roots committed by the manifest.
 */
export function validateGraphNodeTopology(
  manifest: ProjectGraphManifestReadModel,
  shard: ProjectGraphNodeReadModel
): StoreResult<true> {
  try {
    if (manifest.topologyDigest !== computeGraphTopologyDigest(manifest)) {
      invalid("Graph manifest topology digest does not match its page commitments.");
    }
    if (shard.projectId !== manifest.projectId || canonicalJson(shard.checkpoint) !== canonicalJson(manifest.checkpoint)) {
      invalid("Graph Node shard Project or checkpoint does not match its manifest.");
    }
    validateGraphNodeShardShape(shard);
    verifyGraphNodeIdentityProof(manifest, shard.nodeProof);
    if (shard.parentProof) verifyGraphNodeIdentityProof(manifest, shard.parentProof);
    shard.outgoingTargetProofs.forEach(proof => verifyGraphNodeIdentityProof(manifest, proof));
    if (shard.node.ordinal === 0 && shard.node.sha !== manifest.rootNodeSha) {
      invalid("Graph Node shard root does not match its manifest.");
    }
    return ok(true);
  } catch (error) {
    return failure(error instanceof Error ? error.message : "Graph Node topology validation failed.");
  }
}

/**
 * Treats the unique `graph/nodes/<full-sha>.json` shard as the authoritative
 * SHA-to-ordinal locator for every card on a Graph page. The same SHA cannot
 * validate at two ordinals because both cards resolve to one physical path.
 */
export function validateGraphPageNodeLocators(
  manifest: ProjectGraphManifestReadModel,
  page: ProjectGraphPageReadModel,
  locators: readonly ProjectGraphNodeReadModel[]
): StoreResult<true> {
  try {
    const pageTopology = validateGraphPageTopology(manifest, page);
    if (!pageTopology.ok) invalid(pageTopology.error.message);
    const locatorBySha = new Map(locators.map(locator => [locator.node.sha, locator]));
    if (locators.length !== page.nodes.length || locatorBySha.size !== locators.length) {
      invalid("Graph page SHA locators are missing or duplicated.");
    }
    for (const node of page.nodes) {
      const locator = locatorBySha.get(node.sha);
      if (!locator || canonicalJson(locator.node) !== canonicalJson(node)) {
        invalid(`Graph Node SHA locator ${node.sha} does not resolve the page's exact ordinal and card.`);
      }
      const locatorTopology = validateGraphNodeTopology(manifest, locator);
      if (!locatorTopology.ok) invalid(locatorTopology.error.message);
    }
    return ok(true);
  } catch (error) {
    return failure(error instanceof Error ? error.message : "Graph page SHA locator validation failed.");
  }
}

/** Bind one deterministic activity page to its constant-size category root. */
export function validateNodeActivityPageCommitment<K extends NodeActivityKind>(
  index: NodeActivityIndexReadModel,
  page: NodeActivityPageReadModel<K>
): StoreResult<true> {
  try {
    const category = index.categories[page.kind];
    if (page.projectId !== index.projectId || page.nodeSha !== index.nodeSha
      || canonicalJson(page.checkpoint) !== canonicalJson(index.checkpoint)
      || page.index >= category.pageCount || page.offset !== page.index * NODE_ACTIVITY_PAGE_SIZE) {
      invalid(`Node activity ${page.kind} page does not match its exact-head index.`);
    }
    const expectedCount = page.index < category.pageCount - 1
      ? NODE_ACTIVITY_PAGE_SIZE
      : category.count - page.offset;
    if (page.entries.length !== expectedCount || expectedCount <= 0 || expectedCount > NODE_ACTIVITY_PAGE_SIZE) {
      invalid(`Node activity ${page.kind} page does not exactly cover its indexed range.`);
    }
    let width = category.pageCount;
    let currentIndex = page.index;
    let currentDigest = nodeActivityPageLeafDigest(page);
    let expectedDepth = 0;
    for (let levelWidth = width; levelWidth > 1; levelWidth = Math.ceil(levelWidth / 2)) expectedDepth += 1;
    if (page.membershipProof.siblings.length !== expectedDepth || expectedDepth > MAX_NODE_ACTIVITY_PROOF_STEPS) {
      invalid(`Node activity ${page.kind} page membership proof has the wrong depth.`);
    }
    for (const step of page.membershipProof.siblings) {
      const isRight = currentIndex % 2 === 1;
      const expectedSide = isRight ? "left" : "right";
      if (step.side !== expectedSide) invalid(`Node activity ${page.kind} page membership proof direction is invalid.`);
      if (!isRight && currentIndex + 1 >= width && step.digest !== currentDigest) {
        invalid(`Node activity ${page.kind} page membership proof has a non-canonical duplicate leaf.`);
      }
      currentDigest = isRight
        ? nodeActivityPageBranchDigest(step.digest, currentDigest)
        : nodeActivityPageBranchDigest(currentDigest, step.digest);
      currentIndex = Math.floor(currentIndex / 2);
      width = Math.ceil(width / 2);
    }
    if (currentDigest !== category.pageCommitmentRoot) {
      invalid(`Node activity ${page.kind} page does not match its category commitment root.`);
    }
    return ok(true);
  } catch (error) {
    return failure(error instanceof Error ? error.message : "Node activity page commitment validation failed.");
  }
}

/**
 * Binds one keyed activity record to the exact committed slot in its Node and
 * category page. A by-id file cannot be copied or rewritten independently of
 * the Merkle-committed activity sequence.
 */
export function validateNodeActivityRecordMembership<K extends KeyedNodeActivityKind>(
  index: NodeActivityIndexReadModel,
  page: NodeActivityPageReadModel<K>,
  record: NodeActivityRecordReadModel<K>
): StoreResult<true> {
  try {
    const pageCommitment = validateNodeActivityPageCommitment(index, page);
    if (!pageCommitment.ok) invalid(pageCommitment.error.message);
    if (record.projectId !== index.projectId || record.nodeSha !== index.nodeSha
      || record.kind !== page.kind || record.pageIndex !== page.index
      || canonicalJson(record.checkpoint) !== canonicalJson(index.checkpoint)) {
      invalid(`Node activity ${record.kind} record ${record.id} locator does not match its exact-head index and page.`);
    }
    const committed = page.entries[record.entryIndex];
    if (!committed || committed.id !== record.id || canonicalJson(committed) !== canonicalJson(record.value)) {
      invalid(`Node activity ${record.kind} record ${record.id} does not match its committed page slot.`);
    }
    return ok(true);
  } catch (error) {
    return failure(error instanceof Error ? error.message : "Node activity record membership validation failed.");
  }
}

export function decodeActivityManifest(input: unknown): StoreResult<ProjectActivityManifestReadModel> {
  return decodeReadModel(input, "activityManifest", value => {
    const root = exactRecord(value, ["schema", "checkpoint", "projectId", "counts"]);
    if (root.schema !== ACTIVITY_MANIFEST_SCHEMA) invalid("Snapshot manifest schema is unsupported.");
    const counts = exactRecord(root.counts, ["nodes", "runs", "evidence", "comparisons", "decisions", "coaching", "reviews"]);
    return {
      schema: ACTIVITY_MANIFEST_SCHEMA, checkpoint: decodeCheckpoint(root.checkpoint), projectId: safeId(root.projectId, "projectId"),
      counts: {
        nodes: positive(counts.nodes, "counts.nodes"), runs: nonNegative(counts.runs, "counts.runs"),
        evidence: nonNegative(counts.evidence, "counts.evidence"), comparisons: nonNegative(counts.comparisons, "counts.comparisons"),
        decisions: nonNegative(counts.decisions, "counts.decisions"), coaching: nonNegative(counts.coaching, "counts.coaching"),
        reviews: nonNegative(counts.reviews, "counts.reviews")
      }
    };
  });
}

export function decodeNodeActivityIndex(input: unknown): StoreResult<NodeActivityIndexReadModel> {
  return decodeReadModel(input, "nodeActivityIndex", value => {
    const root = exactRecord(value, ["schema", "checkpoint", "projectId", "nodeSha", "categories"]);
    if (root.schema !== NODE_ACTIVITY_INDEX_SCHEMA) invalid("Node activity index schema is unsupported.");
    const categoriesValue = exactRecord(root.categories, NODE_ACTIVITY_KINDS);
    const nodeSha = sha(root.nodeSha, "nodeSha");
    const categories = {} as Record<NodeActivityKind, NodeActivityCategoryIndex>;
    for (const kind of NODE_ACTIVITY_KINDS) {
      const category = exactRecord(categoriesValue[kind], ["count", "pageCount", "pageCommitmentRoot"]);
      const count = nonNegative(category.count, `categories.${kind}.count`);
      const pageCount = nonNegative(category.pageCount, `categories.${kind}.pageCount`);
      const pageCommitmentRoot = nodeActivityPageCommitmentDigest(
        category.pageCommitmentRoot,
        `categories.${kind}.pageCommitmentRoot`
      );
      const expectedPages = count === 0 ? 0 : Math.ceil(count / NODE_ACTIVITY_PAGE_SIZE);
      if (pageCount !== expectedPages) {
        invalid(`Node activity ${kind} page count does not exactly cover its entry count.`);
      }
      categories[kind] = { count, pageCount, pageCommitmentRoot };
    }
    const decoded = {
      schema: NODE_ACTIVITY_INDEX_SCHEMA,
      checkpoint: decodeCheckpoint(root.checkpoint),
      projectId: safeId(root.projectId, "projectId"),
      nodeSha,
      categories
    };
    for (const kind of NODE_ACTIVITY_KINDS) {
      const category = decoded.categories[kind];
      if (category.pageCount === 0
        && category.pageCommitmentRoot !== nodeActivityEmptyRoot(decoded.checkpoint, decoded.projectId, decoded.nodeSha, kind)) {
        invalid(`Empty Node activity ${kind} commitment root is not canonical.`);
      }
    }
    return decoded;
  });
}

export function decodeNodeActivityPage(input: unknown): StoreResult<NodeActivityPageReadModel> {
  return decodeReadModel(input, "nodeActivityPage", value => {
    const root = exactRecord(value, [
      "schema", "checkpoint", "projectId", "nodeSha", "kind", "index", "offset", "entries", "membershipProof"
    ]);
    if (root.schema !== NODE_ACTIVITY_PAGE_SCHEMA) invalid("Node activity page schema is unsupported.");
    const kind = oneOf(root.kind, NODE_ACTIVITY_KINDS, "kind");
    const nodeSha = sha(root.nodeSha, "nodeSha");
    const index = nonNegative(root.index, "index");
    const offset = nonNegative(root.offset, "offset");
    const entries = decodeNodeActivityEntries(kind, root.entries);
    const proof = exactRecord(root.membershipProof, ["siblings"]);
    const siblings = array(proof.siblings, "membershipProof.siblings").map((item): NodeActivityPageProofStep => {
      const step = exactRecord(item, ["side", "digest"]);
      return {
        side: oneOf(step.side, ["left", "right"] as const, "membershipProof.side"),
        digest: nodeActivityPageCommitmentDigest(step.digest, "membershipProof.digest")
      };
    });
    if (offset !== index * NODE_ACTIVITY_PAGE_SIZE || entries.length === 0 || entries.length > NODE_ACTIVITY_PAGE_SIZE) {
      invalid("Node activity page bounds are not canonical.");
    }
    if (siblings.length > MAX_NODE_ACTIVITY_PROOF_STEPS) invalid("Node activity membership proof exceeds its depth bound.");
    validateNodeActivityEntries(kind, entries, nodeSha);
    return {
      schema: NODE_ACTIVITY_PAGE_SCHEMA,
      checkpoint: decodeCheckpoint(root.checkpoint),
      projectId: safeId(root.projectId, "projectId"),
      nodeSha,
      kind,
      index,
      offset,
      entries,
      membershipProof: { siblings }
    } as NodeActivityPageReadModel;
  });
}

export function decodeNodeActivityRecord(input: unknown): StoreResult<NodeActivityRecordReadModel> {
  return decodeReadModel(input, "nodeActivityRecord", value => {
    const root = exactRecord(value, [
      "schema", "checkpoint", "projectId", "nodeSha", "kind", "id", "pageIndex", "entryIndex", "value"
    ]);
    if (root.schema !== NODE_ACTIVITY_RECORD_SCHEMA) invalid("Node activity record schema is unsupported.");
    const kind = oneOf(root.kind, KEYED_NODE_ACTIVITY_KINDS, "kind");
    const nodeSha = sha(root.nodeSha, "nodeSha");
    const id = safeId(root.id, "id");
    const pageIndex = nonNegative(root.pageIndex, "pageIndex");
    const entryIndex = safeInteger(root.entryIndex, 0, NODE_ACTIVITY_PAGE_SIZE - 1, "entryIndex");
    if (!Number.isSafeInteger(pageIndex * NODE_ACTIVITY_PAGE_SIZE + entryIndex)) {
      invalid("Node activity record locator exceeds the safe entry range.");
    }
    const decodedValue = kind === "comparisons"
      ? decodeComparison(root.value)
      : kind === "coaching"
        ? decodeCoaching(root.value)
        : decodeReview(root.value);
    if (decodedValue.id !== id) invalid("Node activity record id does not match its value.");
    validateNodeActivityEntries(kind, [decodedValue] as unknown as NodeActivityEntriesByKind[NodeActivityKind], nodeSha);
    return {
      schema: NODE_ACTIVITY_RECORD_SCHEMA,
      checkpoint: decodeCheckpoint(root.checkpoint),
      projectId: safeId(root.projectId, "projectId"),
      nodeSha,
      kind,
      id,
      pageIndex,
      entryIndex,
      value: decodedValue
    } as NodeActivityRecordReadModel;
  });
}

export function decodeRunActivityShard(input: unknown): StoreResult<RunActivityShardReadModel> {
  return decodeReadModel(input, "runActivity", value => {
    const root = exactRecord(value, ["schema", "checkpoint", "projectId", "run", "evidence", "reviews"]);
    if (root.schema !== RUN_ACTIVITY_SCHEMA) invalid("Run activity shard schema is unsupported.");
    const decoded: RunActivityShardReadModel = {
      schema: RUN_ACTIVITY_SCHEMA, checkpoint: decodeCheckpoint(root.checkpoint), projectId: safeId(root.projectId, "projectId"),
      run: decodeRunActivity(root.run), evidence: array(root.evidence, "evidence").map(decodeEvidence), reviews: array(root.reviews, "reviews").map(decodeReview)
    };
    const evidenceIds = decoded.evidence.map(item => item.id);
    if (new Set(evidenceIds).size !== evidenceIds.length
      || new Set(decoded.reviews.map(item => item.id)).size !== decoded.reviews.length
      || evidenceIds.length !== decoded.run.evidenceIds.length
      || evidenceIds.some(id => !decoded.run.evidenceIds.includes(id))
      || decoded.evidence.some(item => item.runId !== decoded.run.id || item.goalDigest !== decoded.run.goalDigest)
      || decoded.reviews.some(item => item.targetType !== "run" || item.targetId !== decoded.run.id)
    ) invalid("Run activity shard contains activity unrelated to its Run.");
    return decoded;
  });
}

export function decodeEventManifest(input: unknown): StoreResult<ProjectEventManifestReadModel> {
  return decodeReadModel(input, "eventManifest", value => {
    const root = exactRecord(value, ["schema", "checkpoint", "projectId", "shardSize", "shards", "locatorCount"]);
    if (root.schema !== EVENT_MANIFEST_SCHEMA || root.shardSize !== EVENT_INDEX_SHARD_SIZE) invalid("Event manifest schema or shard size is unsupported.");
    const checkpoint = decodeCheckpoint(root.checkpoint);
    const shards = array(root.shards, "shards").map((item, index): EventShardDescriptor => {
      const shard = exactRecord(item, ["index", "path", "sequenceStart", "sequenceEnd", "count", "firstStoredEventId", "lastStoredEventId", "firstDomainEventId", "lastDomainEventId", "digest"]);
      const decoded = {
        index: nonNegative(shard.index, "shard.index"), path: text(shard.path, "shard.path"),
        sequenceStart: positive(shard.sequenceStart, "shard.sequenceStart"), sequenceEnd: positive(shard.sequenceEnd, "shard.sequenceEnd"),
        count: positive(shard.count, "shard.count"), firstStoredEventId: storedEventId(shard.firstStoredEventId),
        lastStoredEventId: storedEventId(shard.lastStoredEventId), firstDomainEventId: safeId(shard.firstDomainEventId, "firstDomainEventId"),
        lastDomainEventId: safeId(shard.lastDomainEventId, "lastDomainEventId"), digest: digest(shard.digest, "eventShard")
      };
      if (decoded.index !== index || decoded.path !== eventShardPath(index) || decoded.count > EVENT_INDEX_SHARD_SIZE
        || decoded.sequenceStart !== index * EVENT_INDEX_SHARD_SIZE + 1
        || decoded.sequenceEnd !== decoded.sequenceStart + decoded.count - 1
      ) invalid("Event shard descriptors are not contiguous or canonical.");
      return decoded;
    });
    const decoded: ProjectEventManifestReadModel = {
      schema: EVENT_MANIFEST_SCHEMA, checkpoint, projectId: safeId(root.projectId, "projectId"), shardSize: EVENT_INDEX_SHARD_SIZE,
      shards, locatorCount: nonNegative(root.locatorCount, "locatorCount")
    };
    const last = shards.at(-1);
    if (shards.length !== Math.ceil(checkpoint.eventCount / EVENT_INDEX_SHARD_SIZE)
      || shards.reduce((sum, shard) => sum + shard.count, 0) !== checkpoint.eventCount
      || decoded.locatorCount !== checkpoint.eventCount
      || last?.sequenceEnd !== checkpoint.lastSequence
      || last?.lastStoredEventId !== checkpoint.lastStoredEventId
      || last?.lastDomainEventId !== checkpoint.lastDomainEventId
    ) invalid("Event manifest does not match its authoritative checkpoint.");
    return decoded;
  });
}

export function decodeEventShard(input: unknown): StoreResult<ProjectEventShardReadModel> {
  return decodeReadModel(input, "eventShard", value => {
    const root = exactRecord(value, ["schema", "checkpoint", "projectId", "index", "sequenceStart", "sequenceEnd", "entries"]);
    if (root.schema !== EVENT_SHARD_SCHEMA) invalid("Event shard schema is unsupported.");
    const decoded: ProjectEventShardReadModel = {
      schema: EVENT_SHARD_SCHEMA, checkpoint: decodeCheckpoint(root.checkpoint), projectId: safeId(root.projectId, "projectId"),
      index: nonNegative(root.index, "index"), sequenceStart: positive(root.sequenceStart, "sequenceStart"),
      sequenceEnd: positive(root.sequenceEnd, "sequenceEnd"), entries: array(root.entries, "entries").map(decodeEventEntry)
    };
    if (decoded.entries.length === 0 || decoded.entries.length > EVENT_INDEX_SHARD_SIZE
      || decoded.sequenceStart !== decoded.index * EVENT_INDEX_SHARD_SIZE + 1
      || decoded.sequenceEnd !== decoded.sequenceStart + decoded.entries.length - 1
      || decoded.entries.some((entry, position) => entry.sequence !== decoded.sequenceStart + position)
      || new Set(decoded.entries.map(entry => entry.storedEventId)).size !== decoded.entries.length
      || new Set(decoded.entries.map(entry => entry.domainEventId)).size !== decoded.entries.length
      || decoded.entries.some(entry => authoritativeEventPath(decoded.projectId, entry.occurredAt, entry.storedEventId) !== entry.path)
    ) invalid("Event shard entries are not contiguous, unique, or path-bound.");
    return decoded;
  });
}

export function decodeEventLocator(input: unknown): StoreResult<ProjectEventLocatorReadModel> {
  return decodeReadModel(input, "eventLocator", value => {
    const root = exactRecord(value, ["schema", "checkpoint", "projectId", "eventId", "entry"]);
    if (root.schema !== EVENT_LOCATOR_SCHEMA) invalid("Event locator schema is unsupported.");
    const decoded: ProjectEventLocatorReadModel = {
      schema: EVENT_LOCATOR_SCHEMA, checkpoint: decodeCheckpoint(root.checkpoint), projectId: safeId(root.projectId, "projectId"),
      eventId: safeId(root.eventId, "eventId"), entry: decodeEventEntry(root.entry)
    };
    if (decoded.eventId !== decoded.entry.domainEventId
      || authoritativeEventPath(decoded.projectId, decoded.entry.occurredAt, decoded.entry.storedEventId) !== decoded.entry.path
    ) invalid("Event locator does not match its indexed Event metadata.");
    return decoded;
  });
}

function encodeReadModel(kind: ShardedReadModelKind, payload: { readonly checkpoint: EventLogCheckpoint }): StoreResult<ShardedReadModelEnvelope> {
  try {
    const canonical = canonicalJson(payload);
    const decoded = new TextEncoder().encode(canonical);
    if (decoded.byteLength > MAX_DECODED_BYTES) return failure(`Project ${kind} shard exceeds its decoded size limit.`);
    const compressed = gzipSync(decoded, { level: 9, mtime: 0 });
    const data = Buffer.from(compressed).toString("base64");
    const encodedSize = Buffer.byteLength(data, "utf8");
    if (encodedSize > MAX_ENCODED_BYTES) return failure(`Project ${kind} shard exceeds its encoded size limit.`);
    return ok({
      schema: SHARDED_READ_MODEL_ENVELOPE_SCHEMA, kind, codec: SHARDED_READ_MODEL_CODEC, checkpoint: payload.checkpoint,
      decodedSize: decoded.byteLength, encodedSize, digest: readModelDigest(kind, canonical), data
    });
  } catch (error) {
    return failure(error instanceof Error ? error.message : `Project ${kind} shard could not be encoded.`);
  }
}

function decodeReadModel<T>(input: unknown, expectedKind: ShardedReadModelKind, decode: (value: unknown) => T): StoreResult<T> {
  try {
    const envelope = exactRecord(input, ["schema", "kind", "codec", "checkpoint", "decodedSize", "encodedSize", "digest", "data"]);
    if (envelope.schema !== SHARDED_READ_MODEL_ENVELOPE_SCHEMA || envelope.kind !== expectedKind || envelope.codec !== SHARDED_READ_MODEL_CODEC) {
      invalid("Project read model envelope schema, kind, or codec is unsupported.");
    }
    const checkpoint = decodeCheckpoint(envelope.checkpoint);
    const decodedSize = safeInteger(envelope.decodedSize, 1, MAX_DECODED_BYTES, "decodedSize");
    const encodedSize = safeInteger(envelope.encodedSize, 1, MAX_ENCODED_BYTES, "encodedSize");
    const data = text(envelope.data, "data");
    if (Buffer.byteLength(data, "utf8") !== encodedSize) invalid("Project read model encodedSize is invalid.");
    const compressed = Buffer.from(data, "base64");
    if (compressed.toString("base64") !== data || compressed.byteLength < 4 || gzipDecodedSize(compressed) !== decodedSize) {
      invalid("Project read model data is not canonical bounded gzip/base64.");
    }
    const bytes = gunzipSync(compressed, { out: new Uint8Array(decodedSize) });
    const canonical = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (text(envelope.digest, "digest") !== readModelDigest(expectedKind, canonical)) invalid("Project read model digest does not match its payload.");
    const parsed: unknown = JSON.parse(canonical);
    if (canonicalJson(parsed) !== canonical) invalid("Project read model payload is not canonical JSON.");
    const value = decode(parsed);
    if (canonicalJson((value as { checkpoint: EventLogCheckpoint }).checkpoint) !== canonicalJson(checkpoint)) {
      invalid("Project read model checkpoint does not match its envelope.");
    }
    return ok(value);
  } catch (error) {
    return failure(error instanceof DecodeFailure ? error.message : "Project read model could not be decoded.");
  }
}

function buildCheckpoint(events: readonly VerifiedStoredProjectEvent<DomainEvent>[]): StoreResult<EventLogCheckpoint> {
  if (events.length === 0) return failure("Read model checkpoint requires at least one authoritative event.");
  const ordered = [...events].sort((left, right) => left.sequence - right.sequence);
  const chain: unknown[] = [];
  for (let index = 0; index < ordered.length; index += 1) {
    const entry = ordered[index]!;
    if (entry.sequence !== index + 1) return failure("Read model checkpoint event sequence is not contiguous.");
    const eventDigest = verifiedOpaqueDomainEventDigest(entry.encodedEvent.value);
    if (!eventDigest.ok) return eventDigest;
    chain.push({
      sequence: entry.sequence, storedEventId: entry.eventId, idempotencyKeyHash: entry.idempotencyKeyHash,
      commandHash: entry.commandHash, previousStateSha: entry.previousStateSha, commandEventCount: entry.commandEventCount,
      occurredAt: entry.occurredAt, eventDigest: eventDigest.value
    });
  }
  const last = ordered.at(-1)!;
  return ok({
    schema: "hunsu.event-log-checkpoint.v2", eventCount: ordered.length, lastSequence: last.sequence,
    lastStoredEventId: last.eventId, lastDomainEventId: String(last.event.meta.eventId),
    chainDigest: `hunsu-event-chain-v2:sha256:${sha256(canonicalJson(chain))}`
  });
}

function decodeCheckpoint(value: unknown): EventLogCheckpoint {
  const root = exactRecord(value, ["schema", "eventCount", "lastSequence", "lastStoredEventId", "lastDomainEventId", "chainDigest"]);
  if (root.schema !== "hunsu.event-log-checkpoint.v2") invalid("Event checkpoint schema is unsupported.");
  const eventCount = positive(root.eventCount, "eventCount");
  const lastSequence = positive(root.lastSequence, "lastSequence");
  const chainDigest = text(root.chainDigest, "chainDigest");
  if (eventCount !== lastSequence || !/^hunsu-event-chain-v2:sha256:[0-9a-f]{64}$/u.test(chainDigest)) {
    invalid("Event checkpoint count, sequence, or digest is invalid.");
  }
  return {
    schema: "hunsu.event-log-checkpoint.v2", eventCount, lastSequence,
    lastStoredEventId: storedEventId(root.lastStoredEventId), lastDomainEventId: safeId(root.lastDomainEventId, "lastDomainEventId"), chainDigest
  };
}

function decodeOrdinalGraphNode(value: unknown): OrdinalGraphNode {
  const root = exactRecord(value, ["type", "sha", "treeSha", "managedRef", "commitTitle", "registeredAt", "planDigest", "payloadDigest", "runner", "nextGoalCount", "status", "lineage", "ordinal", "parentOrdinal"]);
  const type = oneOf(root.type, ["root", "run_child", "coaching_child"] as const, "node.type");
  const runner = exactRecord(root.runner, ["name", "origin", "typeKey", "schemaVersion", "digest"]);
  const lineageValue = exactRecord(root.lineage, type === "root" ? ["type"] : type === "run_child" ? ["type", "parentSha", "runId", "consumedGoalDigest"] : ["type", "parentSha", "proposalId"]);
  const lineage = type === "root"
    ? lineageValue.type === "root" ? { type: "root" as const } : invalid("Root lineage is invalid.")
    : type === "run_child"
      ? lineageValue.type === "run"
        ? { type: "run" as const, parentSha: sha(lineageValue.parentSha, "parentSha"), runId: safeId(lineageValue.runId, "runId"), consumedGoalDigest: text(lineageValue.consumedGoalDigest, "consumedGoalDigest") }
        : invalid("Run lineage is invalid.")
      : lineageValue.type === "coaching"
        ? { type: "coaching" as const, parentSha: sha(lineageValue.parentSha, "parentSha"), proposalId: safeId(lineageValue.proposalId, "proposalId") }
        : invalid("Coaching lineage is invalid.");
  const ordinal = nonNegative(root.ordinal, "ordinal");
  const parentOrdinal = root.parentOrdinal === null ? null : nonNegative(root.parentOrdinal, "parentOrdinal");
  const decoded: OrdinalGraphNode = {
    type, sha: sha(root.sha, "sha"), treeSha: sha(root.treeSha, "treeSha"), managedRef: text(root.managedRef, "managedRef"),
    commitTitle: text(root.commitTitle, "commitTitle"), registeredAt: timestamp(root.registeredAt, "registeredAt"),
    planDigest: text(root.planDigest, "planDigest"), payloadDigest: text(root.payloadDigest, "payloadDigest"),
    runner: {
      name: text(runner.name, "runner.name"), origin: text(runner.origin, "runner.origin"), typeKey: text(runner.typeKey, "runner.typeKey"),
      schemaVersion: text(runner.schemaVersion, "runner.schemaVersion"), digest: text(runner.digest, "runner.digest")
    },
    nextGoalCount: nonNegative(root.nextGoalCount, "nextGoalCount"),
    status: oneOf(root.status, ["available", "current", "selected", "rejected"] as const, "status"), lineage, ordinal, parentOrdinal
  };
  if ((type === "root") !== (parentOrdinal === null)
    || type === "root" && ordinal !== 0
    || parentOrdinal !== null && parentOrdinal >= ordinal
    || decoded.managedRef !== `refs/tags/hunsu/node/${safeProjectIdFromManagedRef(decoded.managedRef)}/${decoded.sha}`
  ) invalid("Graph Node ordinal, parent, or managed ref is invalid.");
  return decoded;
}

function decodeGraphNodeIdentityProof(value: unknown): GraphNodeIdentityProof {
  const root = exactRecord(value, ["pageIndex", "leafIndex", "identity", "siblings"]);
  const identity = decodeGraphNodeTopologyIdentity(root.identity);
  const siblings = array(root.siblings, "proof.siblings").map((item): GraphNodeIdentityProofStep => {
    const step = exactRecord(item, ["side", "digest"]);
    return {
      side: oneOf(step.side, ["left", "right"] as const, "proof.side"),
      digest: graphNodeIdentityDigest(step.digest)
    };
  });
  const pageIndex = nonNegative(root.pageIndex, "proof.pageIndex");
  const leafIndex = nonNegative(root.leafIndex, "proof.leafIndex");
  if (siblings.length > MAX_GRAPH_IDENTITY_PROOF_STEPS
    || pageIndex !== Math.floor(identity.ordinal / GRAPH_PAGE_SIZE)
    || leafIndex !== identity.ordinal - pageIndex * GRAPH_PAGE_SIZE
    || leafIndex >= GRAPH_PAGE_SIZE) {
    invalid("Graph Node identity proof position or depth is invalid.");
  }
  return { pageIndex, leafIndex, identity, siblings };
}

function decodeGraphNodeTopologyIdentity(value: unknown): GraphNodeTopologyIdentity {
  const root = exactRecord(value, ["type", "sha", "managedRef", "ordinal", "parentOrdinal", "lineage"]);
  const type = oneOf(root.type, ["root", "run_child", "coaching_child"] as const, "identity.type");
  const lineageValue = exactRecord(root.lineage, type === "root"
    ? ["type"]
    : type === "run_child"
      ? ["type", "parentSha", "runId", "consumedGoalDigest"]
      : ["type", "parentSha", "proposalId"]);
  const lineage: GraphNodeTopologyIdentity["lineage"] = type === "root"
    ? lineageValue.type === "root" ? { type: "root" } : invalid("Root identity lineage is invalid.")
    : type === "run_child"
      ? lineageValue.type === "run"
        ? {
            type: "run", parentSha: sha(lineageValue.parentSha, "identity.parentSha"),
            runId: safeId(lineageValue.runId, "identity.runId"),
            consumedGoalDigest: text(lineageValue.consumedGoalDigest, "identity.consumedGoalDigest")
          }
        : invalid("Run identity lineage is invalid.")
      : lineageValue.type === "coaching"
        ? {
            type: "coaching", parentSha: sha(lineageValue.parentSha, "identity.parentSha"),
            proposalId: safeId(lineageValue.proposalId, "identity.proposalId")
          }
        : invalid("Coaching identity lineage is invalid.");
  const identity: GraphNodeTopologyIdentity = {
    type,
    sha: sha(root.sha, "identity.sha"),
    managedRef: text(root.managedRef, "identity.managedRef"),
    ordinal: nonNegative(root.ordinal, "identity.ordinal"),
    parentOrdinal: root.parentOrdinal === null ? null : nonNegative(root.parentOrdinal, "identity.parentOrdinal"),
    lineage
  };
  validateGraphTopologyIdentity(identity);
  return identity;
}

function validateGraphTopologyIdentity(identity: GraphNodeTopologyIdentity, projectId?: string): void {
  const refProjectId = safeProjectIdFromManagedRef(identity.managedRef);
  if (identity.managedRef !== `refs/tags/hunsu/node/${refProjectId}/${identity.sha}`
    || projectId !== undefined && refProjectId !== projectId
    || (identity.type === "root") !== (identity.parentOrdinal === null)
    || identity.type === "root" && (identity.ordinal !== 0 || identity.lineage.type !== "root")
    || identity.type === "run_child" && identity.lineage.type !== "run"
    || identity.type === "coaching_child" && identity.lineage.type !== "coaching"
    || identity.parentOrdinal !== null && identity.parentOrdinal >= identity.ordinal) {
    invalid("Graph Node topology identity is invalid or belongs to another Project.");
  }
}

function sameGraphTopologyIdentity(left: GraphNodeTopologyIdentity, right: GraphNodeTopologyIdentity): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function verifyGraphNodeIdentityProof(
  manifest: ProjectGraphManifestReadModel,
  proof: GraphNodeIdentityProof
): void {
  validateGraphTopologyIdentity(proof.identity, manifest.projectId);
  const descriptor = manifest.pages[proof.pageIndex];
  if (!descriptor || descriptor.index !== proof.pageIndex
    || proof.leafIndex >= descriptor.nodeCount
    || proof.identity.ordinal !== descriptor.ordinalStart + proof.leafIndex) {
    invalid("Graph Node identity proof does not belong to a manifest page.");
  }
  const expectedDepth = graphIdentityProofDepth(descriptor.nodeCount);
  if (proof.siblings.length !== expectedDepth || expectedDepth > MAX_GRAPH_IDENTITY_PROOF_STEPS) {
    invalid("Graph Node identity proof has an invalid bounded depth.");
  }
  let current = graphIdentityLeafDigest(manifest.projectId, proof.identity);
  let index = proof.leafIndex;
  let count = descriptor.nodeCount;
  for (const step of proof.siblings) {
    const expectedSide = index % 2 === 1 ? "left" : "right";
    if (step.side !== expectedSide) invalid("Graph Node identity proof sibling position is invalid.");
    if (expectedSide === "right" && index + 1 >= count && step.digest !== current) {
      invalid("Graph Node identity proof has an invalid duplicated terminal sibling.");
    }
    current = expectedSide === "left"
      ? graphIdentityBranchDigest(step.digest, current)
      : graphIdentityBranchDigest(current, step.digest);
    index = Math.floor(index / 2);
    count = Math.ceil(count / 2);
  }
  if (current !== descriptor.nodeIdentityRoot) invalid("Graph Node identity proof does not match its manifest root.");
}

function graphIdentityProofDepth(nodeCount: number): number {
  let depth = 0;
  for (let count = nodeCount; count > 1; count = Math.ceil(count / 2)) depth += 1;
  return depth;
}

function decodeGraphEdge(value: unknown): ProjectGraphEdge {
  if (!isRecord(value) || (value.type !== "run" && value.type !== "coaching")) invalid("Graph edge type is invalid.");
  if (value.type === "run") {
    const edge = exactRecord(value, ["type", "sourceSha", "targetSha", "runId", "goalDigest", "goalTitle", "completedAt"]);
    return {
      type: "run", sourceSha: sha(edge.sourceSha, "sourceSha"), targetSha: sha(edge.targetSha, "targetSha"),
      runId: safeId(edge.runId, "runId"), goalDigest: text(edge.goalDigest, "goalDigest"), goalTitle: text(edge.goalTitle, "goalTitle"),
      completedAt: timestamp(edge.completedAt, "completedAt")
    };
  }
  const edge = exactRecord(value, ["type", "sourceSha", "targetSha", "proposalId", "summary", "confirmedAt"]);
  return {
    type: "coaching", sourceSha: sha(edge.sourceSha, "sourceSha"), targetSha: sha(edge.targetSha, "targetSha"),
    proposalId: safeId(edge.proposalId, "proposalId"), summary: text(edge.summary, "summary"), confirmedAt: timestamp(edge.confirmedAt, "confirmedAt")
  };
}

function decodeActiveRun(value: unknown): ActiveRunReadModel {
  const run = exactRecord(value, ["id", "sourceNodeSha", "goalDigest", "goalTitle", "runnerName", "startedAt"]);
  return {
    id: safeId(run.id, "run.id"), sourceNodeSha: sha(run.sourceNodeSha, "run.sourceNodeSha"),
    goalDigest: text(run.goalDigest, "run.goalDigest"), goalTitle: text(run.goalTitle, "run.goalTitle"),
    runnerName: text(run.runnerName, "run.runnerName"), startedAt: timestamp(run.startedAt, "run.startedAt")
  };
}

function validateGraphPage(page: ProjectGraphPageReadModel): void {
  if (page.nodes.length === 0 || page.nodes.length > GRAPH_PAGE_SIZE || page.ordinalStart !== page.index * GRAPH_PAGE_SIZE
    || page.nodes.some((node, position) => node.ordinal !== page.ordinalStart + position)
    || new Set(page.nodes.map(node => node.sha)).size !== page.nodes.length
  ) invalid("Graph page Node ordinals are not contiguous or unique.");
  page.nodes.forEach(node => validateGraphTopologyIdentity(graphNodeTopologyIdentity(node), page.projectId));
  page.externalParents.forEach(proof => validateGraphTopologyIdentity(proof.identity, page.projectId));
  const nodeBySha = new Map(page.nodes.map(node => [node.sha, node]));
  const nodeByOrdinal = new Map(page.nodes.map(node => [node.ordinal, node]));
  const edgeByTarget = new Map(page.edges.map(edge => [edge.targetSha, edge]));
  const externalParentByOrdinal = new Map(page.externalParents.map(proof => [proof.identity.ordinal, proof]));
  if (edgeByTarget.size !== page.edges.length || page.edges.some(edge => !nodeBySha.has(edge.targetSha) || edge.sourceSha === edge.targetSha)) {
    invalid("Graph page edges must be unique and stored with their target Node.");
  }
  if (externalParentByOrdinal.size !== page.externalParents.length) {
    invalid("Graph page contains duplicate external parent proofs.");
  }
  const requiredExternalParentOrdinals = new Set<number>();
  for (const node of page.nodes) {
    const edge = edgeByTarget.get(node.sha);
    if (node.type === "root") {
      if (edge || node.ordinal !== 0) invalid("Graph page root has an incoming edge or a non-zero ordinal.");
      continue;
    }
    if (node.lineage.type === "root" || node.parentOrdinal === null || !edge
      || edge.sourceSha !== node.lineage.parentSha || edge.type !== node.lineage.type) {
      invalid("Graph page edge does not match its target Node lineage.");
    }
    if (edge.type === "run" && node.lineage.type === "run" && edge.runId !== node.lineage.runId) invalid("Run edge does not match its Node Run id.");
    if (edge.type === "coaching" && node.lineage.type === "coaching" && edge.proposalId !== node.lineage.proposalId) invalid("Coaching edge does not match its Node proposal id.");
    const parent = nodeByOrdinal.get(node.parentOrdinal);
    if (parent) {
      if (parent.sha !== node.lineage.parentSha) invalid("Graph page same-page parent ordinal and SHA do not match.");
    } else {
      requiredExternalParentOrdinals.add(node.parentOrdinal);
      const proof = externalParentByOrdinal.get(node.parentOrdinal);
      if (!proof || proof.identity.sha !== node.lineage.parentSha) {
        invalid("Graph page is missing the exact external parent membership proof.");
      }
    }
  }
  if (requiredExternalParentOrdinals.size !== page.externalParents.length
    || page.externalParents.some(proof => !requiredExternalParentOrdinals.has(proof.identity.ordinal))) {
    invalid("Graph page contains an unused external parent proof.");
  }
  if (page.activeRuns.some(run => !nodeBySha.has(run.sourceNodeSha))) invalid("Graph page contains an active Run for another page.");
}

function validateGraphNodeShardShape(shard: ProjectGraphNodeReadModel): void {
  const nodeIdentity = graphNodeTopologyIdentity(shard.node);
  validateGraphTopologyIdentity(nodeIdentity, shard.projectId);
  validateGraphTopologyIdentity(shard.nodeProof.identity, shard.projectId);
  if (!sameGraphTopologyIdentity(nodeIdentity, shard.nodeProof.identity)) {
    invalid("Graph Node shard identity proof does not describe its Node.");
  }
  if (shard.node.type === "root") {
    if (shard.parentProof !== null) invalid("Graph root Node shard cannot contain a parent proof.");
  } else {
    if (!shard.parentProof || shard.node.parentOrdinal === null || shard.node.lineage.type === "root"
      || shard.parentProof.identity.ordinal !== shard.node.parentOrdinal
      || shard.parentProof.identity.sha !== shard.node.lineage.parentSha) {
      invalid("Graph Node shard is missing its exact structural parent proof.");
    }
    validateGraphTopologyIdentity(shard.parentProof.identity, shard.projectId);
  }
  const outgoingTargetBySha = new Map(shard.outgoingTargetProofs.map(proof => [proof.identity.sha, proof]));
  if (new Set(shard.outgoingEdges.map(edge => edge.targetSha)).size !== shard.outgoingEdges.length
    || outgoingTargetBySha.size !== shard.outgoingTargetProofs.length
    || shard.outgoingEdges.length !== shard.outgoingTargetProofs.length
    || shard.outgoingEdges.some(edge => edge.sourceSha !== shard.node.sha || edge.targetSha === shard.node.sha)
    || shard.activeRuns.some(run => run.sourceNodeSha !== shard.node.sha)) {
    invalid("Graph Node shard contains unrelated or duplicate activity or proofs.");
  }
  for (const edge of shard.outgoingEdges) {
    const proof = outgoingTargetBySha.get(edge.targetSha);
    if (!proof) invalid("Graph Node shard is missing an outgoing target membership proof.");
    validateGraphTopologyIdentity(proof.identity, shard.projectId);
    const target = proof.identity;
    if (target.parentOrdinal !== shard.node.ordinal || target.lineage.type === "root"
      || target.lineage.parentSha !== shard.node.sha || target.type === "root"
      || edge.type !== target.lineage.type
      || edge.type === "run" && target.lineage.type === "run" && edge.runId !== target.lineage.runId
      || edge.type === "coaching" && target.lineage.type === "coaching" && edge.proposalId !== target.lineage.proposalId) {
      invalid("Graph Node outgoing edge does not match its proven target lineage.");
    }
  }
}

function decodeNodeActivityEntries(
  kind: NodeActivityKind,
  value: unknown
): NodeActivityEntriesByKind[NodeActivityKind] {
  const values = array(value, "entries");
  switch (kind) {
    case "runs": return values.map(decodeRunActivity);
    case "evidence": return values.map(decodeEvidence);
    case "comparisons": return values.map(decodeComparison);
    case "decisions": return values.map(decodeDecision);
    case "coaching": return values.map(decodeCoaching);
    case "reviews": return values.map(decodeReview);
  }
}

function validateNodeActivityEntries(
  kind: NodeActivityKind,
  entries: NodeActivityEntriesByKind[NodeActivityKind],
  nodeSha: string
): void {
  const ids = entries.map(entry => entry.id);
  if (new Set(ids).size !== ids.length) invalid("Node activity page ids must be unique.");
  const orderingKeys = entries.map(entry => `${nodeActivityRecordedAt(kind, entry)}\u0000${entry.id}`);
  if (orderingKeys.some((key, index) => index > 0 && orderingKeys[index - 1]! >= key)) {
    invalid("Node activity page entries are not in canonical chronological order.");
  }
  if (kind === "runs" && (entries as readonly RunActivityReadModel[]).some(run => run.sourceNodeSha !== nodeSha
    && (run.outcome.type !== "completed" || run.outcome.nodeSha !== nodeSha))) {
    invalid("Node Run activity is unrelated to its Node.");
  }
  if (kind === "comparisons" && (entries as readonly ComparisonActivityReadModel[]).some(item => !comparisonRelatesToNode(item, nodeSha))) {
    invalid("Node comparison activity is unrelated to its Node.");
  }
  if (kind === "coaching" && (entries as readonly CoachingActivityReadModel[]).some(item => item.sourceNodeSha !== nodeSha)) {
    invalid("Node Coaching activity is unrelated to its Node.");
  }
  if (kind === "reviews" && (entries as readonly ReviewActivityReadModel[]).some(item =>
    item.targetType === "node" && item.targetId !== nodeSha)) {
    invalid("Node Coach review activity is unrelated to its Node.");
  }
}

function nodeActivityRecordedAt(kind: NodeActivityKind, entry: NodeActivityEntriesByKind[NodeActivityKind][number]): string {
  if (kind === "runs") return (entry as RunActivityReadModel).startedAt;
  if (kind === "decisions") return (entry as DecisionActivityReadModel).decidedAt;
  if (kind === "coaching") return (entry as CoachingActivityReadModel).proposedAt;
  return (entry as EvidenceActivityReadModel | ComparisonActivityReadModel | ReviewActivityReadModel).recordedAt;
}

function decodeRunActivity(value: unknown): RunActivityReadModel {
  const run = exactRecord(value, ["id", "sourceNodeSha", "goalDigest", "goalTitle", "runnerName", "runnerDigest", "branch", "checkpoints", "evidenceIds", "startedAt", "outcome"]);
  const active = decodeActiveRun({
    id: run.id, sourceNodeSha: run.sourceNodeSha, goalDigest: run.goalDigest,
    goalTitle: run.goalTitle, runnerName: run.runnerName, startedAt: run.startedAt
  });
  const checkpoints = array(run.checkpoints, "checkpoints").map(item => {
    const checkpoint = exactRecord(item, ["id", "summary", "location", "recordedAt"]);
    if (!isRecord(checkpoint.location)) invalid("Checkpoint location is invalid.");
    const location = checkpoint.location.type === "commit"
      ? exactRecord(checkpoint.location, ["type", "commitSha"])
      : exactRecord(checkpoint.location, ["type"]);
    return {
      id: safeId(checkpoint.id, "checkpoint.id"), summary: text(checkpoint.summary, "checkpoint.summary"),
      location: location.type === "commit"
        ? { type: "commit" as const, commitSha: sha(location.commitSha, "checkpoint.commitSha") }
        : location.type === "observation" ? { type: "observation" as const } : invalid("Checkpoint location is invalid."),
      recordedAt: timestamp(checkpoint.recordedAt, "checkpoint.recordedAt")
    };
  });
  if (new Set(checkpoints.map(checkpoint => checkpoint.id)).size !== checkpoints.length) {
    invalid("Run checkpoint ids must be unique.");
  }
  const evidenceIds = array(run.evidenceIds, "evidenceIds").map(item => safeId(item, "evidenceId"));
  if (new Set(evidenceIds).size !== evidenceIds.length) invalid("Run evidence ids must be unique.");
  return {
    ...active, runnerDigest: text(run.runnerDigest, "runnerDigest"), branch: text(run.branch, "branch"), checkpoints,
    evidenceIds, outcome: decodeRunOutcome(run.outcome)
  };
}

function decodeRunOutcome(value: unknown): RunActivityReadModel["outcome"] {
  if (!isRecord(value)) invalid("Run outcome must be an object.");
  if (value.type === "running") {
    exactRecord(value, ["type"]);
    return { type: "running" };
  }
  if (value.type === "completed") {
    const outcome = exactRecord(value, ["type", "nodeSha", "verifiedAt", "completedAt"]);
    return { type: "completed", nodeSha: sha(outcome.nodeSha, "outcome.nodeSha"), verifiedAt: timestamp(outcome.verifiedAt, "outcome.verifiedAt"), completedAt: timestamp(outcome.completedAt, "outcome.completedAt") };
  }
  if (value.type === "failed") {
    const outcome = exactRecord(value, ["type", "failedAt", "reason"]);
    return { type: "failed", failedAt: timestamp(outcome.failedAt, "outcome.failedAt"), reason: text(outcome.reason, "outcome.reason") };
  }
  if (value.type === "canceled") {
    const outcome = exactRecord(value, ["type", "canceledAt", "reason"]);
    return { type: "canceled", canceledAt: timestamp(outcome.canceledAt, "outcome.canceledAt"), reason: text(outcome.reason, "outcome.reason") };
  }
  return invalid("Run outcome type is invalid.");
}

function decodeEvidence(value: unknown): EvidenceActivityReadModel {
  const evidence = exactRecord(value, ["id", "runId", "goalDigest", "kind", "summary", "target", "location", "recordedAt"]);
  if (!isRecord(evidence.target)) invalid("Evidence target is invalid.");
  const target = evidence.target.type === "criterion" ? exactRecord(evidence.target, ["type", "criterion"]) : exactRecord(evidence.target, ["type"]);
  return {
    id: safeId(evidence.id, "evidence.id"), runId: safeId(evidence.runId, "evidence.runId"),
    goalDigest: typedDigest(evidence.goalDigest, "evidence.goalDigest", /^hunsu-goal-v1:sha256:[0-9a-f]{64}$/u),
    kind: oneOf(evidence.kind, ["diff", "check", "screenshot", "report", "note"] as const, "evidence.kind"),
    summary: text(evidence.summary, "evidence.summary"),
    target: target.type === "criterion" ? { type: "criterion", criterion: text(target.criterion, "criterion") }
      : target.type === "run" ? { type: "run" } : invalid("Evidence target is invalid."),
    location: decodeEvidenceLocation(evidence.location), recordedAt: timestamp(evidence.recordedAt, "recordedAt")
  };
}

function decodeEvidenceLocation(value: unknown): EvidenceActivityReadModel["location"] {
  if (!isRecord(value)) invalid("Evidence location must be an object.");
  if (value.type === "git") {
    const location = exactRecord(value, ["type", "commitSha", "path"]);
    return { type: "git", commitSha: sha(location.commitSha, "location.commitSha"), path: text(location.path, "location.path") };
  }
  if (value.type === "url") {
    const location = exactRecord(value, ["type", "url"]);
    return { type: "url", url: text(location.url, "location.url") };
  }
  if (value.type === "text") {
    const location = exactRecord(value, ["type", "text"]);
    return { type: "text", text: text(location.text, "location.text") };
  }
  return invalid("Evidence location type is invalid.");
}

function decodeComparison(value: unknown): ComparisonActivityReadModel {
  if (!isRecord(value) || (value.type !== "sibling_runs" && value.type !== "coached_how_experiment")) {
    invalid("Comparison type is invalid.");
  }
  const item = exactRecord(value, value.type === "sibling_runs"
    ? ["type", "id", "eventId", "parentNodeSha", "nodeShas", "summary", "recordedAt", "disposition"]
    : ["type", "id", "eventId", "anchorNodeSha", "goalDigest", "nodeShas", "summary", "recordedAt", "disposition"]);
  const id = safeId(item.id, "comparison.id");
  const nodeShas = array(item.nodeShas, "nodeShas").map(value => sha(value, "nodeSha"));
  if (nodeShas.length < 2 || new Set(nodeShas).size !== nodeShas.length) invalid("Comparison must contain at least two unique Nodes.");
  if (!isRecord(item.disposition)) invalid("Comparison disposition is invalid.");
  const dispositionValue = item.disposition.type === "decisions_recorded"
    ? exactRecord(item.disposition, ["type", "decisions"])
    : exactRecord(item.disposition, ["type"]);
  const disposition = dispositionValue.type === "undecided"
    ? { type: "undecided" as const }
    : dispositionValue.type === "decisions_recorded"
      ? {
          type: "decisions_recorded" as const,
          decisions: array(dispositionValue.decisions, "disposition.decisions").map(decodeDecision)
        }
      : invalid("Comparison disposition is invalid.");
  const eventId = safeId(item.eventId, "comparison.eventId");
  if (disposition.type === "decisions_recorded" && (disposition.decisions.length === 0
    || new Set(disposition.decisions.map(decision => decision.id)).size !== disposition.decisions.length
    || new Set(disposition.decisions.map(decision => decision.eventId)).size !== disposition.decisions.length
    || disposition.decisions.some(decision => decision.eventId === eventId)
    || disposition.decisions.some(decision => decision.comparisonId !== id
      || decision.nodeShas.some(nodeSha => !nodeShas.includes(nodeSha))))) {
    invalid("Comparison disposition contains unrelated or duplicate decisions.");
  }
  const base = {
    id,
    eventId,
    nodeShas,
    summary: text(item.summary, "summary"),
    recordedAt: timestamp(item.recordedAt, "recordedAt"),
    disposition
  };
  return value.type === "sibling_runs"
    ? { ...base, type: "sibling_runs", parentNodeSha: sha(item.parentNodeSha, "parentNodeSha") }
    : {
        ...base,
        type: "coached_how_experiment",
        anchorNodeSha: sha(item.anchorNodeSha, "anchorNodeSha"),
        goalDigest: typedDigest(item.goalDigest, "goalDigest", /^hunsu-goal-v1:sha256:[0-9a-f]{64}$/u)
      };
}

function decodeDecision(value: unknown): DecisionActivityReadModel {
  const item = exactRecord(value, ["id", "eventId", "type", "comparisonId", "nodeShas", "rationale", "decidedAt"]);
  const type = oneOf(item.type, ["selection", "rejection"] as const, "decision.type");
  const nodeShas = array(item.nodeShas, "nodeShas").map(value => sha(value, "nodeSha"));
  if (nodeShas.length === 0 || type === "selection" && nodeShas.length !== 1 || new Set(nodeShas).size !== nodeShas.length) invalid("Decision Node set is invalid.");
  return {
    id: safeId(item.id, "decision.id"), eventId: safeId(item.eventId, "decision.eventId"), type,
    comparisonId: safeId(item.comparisonId, "comparisonId"), nodeShas,
    rationale: text(item.rationale, "rationale"), decidedAt: timestamp(item.decidedAt, "decidedAt")
  };
}

function decodeCoaching(value: unknown): CoachingActivityReadModel {
  const root = exactRecord(value, [
    "id", "eventId", "sourceNodeSha", "sourcePayloadDigest", "sourcePlanDigest", "proposedPlanDigest",
    "expectedStateSha", "summary", "rationale", "proposedAt", "disposition"
  ]);
  if (!isRecord(root.disposition)) invalid("Coaching disposition is invalid.");
  const disposition = root.disposition.type === "confirmed"
    ? exactRecord(root.disposition, [
        "type", "decisionId", "decisionEventId", "childRegistrationEventId", "childNodeSha", "reason", "decidedAt"
      ])
    : root.disposition.type === "rejected"
      ? exactRecord(root.disposition, ["type", "decisionId", "decisionEventId", "reason", "decidedAt"])
      : exactRecord(root.disposition, ["type"]);
  const eventId = safeId(root.eventId, "coaching.eventId");
  const decisionEventId = disposition.type === "confirmed" || disposition.type === "rejected"
    ? safeId(disposition.decisionEventId, "decisionEventId")
    : undefined;
  const childRegistrationEventId = disposition.type === "confirmed"
    ? safeId(disposition.childRegistrationEventId, "childRegistrationEventId")
    : undefined;
  if (decisionEventId === eventId || childRegistrationEventId === eventId
    || decisionEventId !== undefined && childRegistrationEventId === decisionEventId) {
    invalid("Coaching proposal lifecycle Event ids must be distinct.");
  }
  return {
    id: safeId(root.id, "coaching.id"), eventId,
    sourceNodeSha: sha(root.sourceNodeSha, "sourceNodeSha"),
    sourcePayloadDigest: typedDigest(root.sourcePayloadDigest, "sourcePayloadDigest", /^hunsu-node-payload-v1:sha256:[0-9a-f]{64}$/u),
    sourcePlanDigest: typedDigest(root.sourcePlanDigest, "sourcePlanDigest", /^hunsu-node-plan-v1:sha256:[0-9a-f]{64}$/u),
    proposedPlanDigest: typedDigest(root.proposedPlanDigest, "proposedPlanDigest", /^hunsu-node-plan-v1:sha256:[0-9a-f]{64}$/u),
    expectedStateSha: sha(root.expectedStateSha, "expectedStateSha"), summary: text(root.summary, "summary"),
    rationale: text(root.rationale, "rationale"), proposedAt: timestamp(root.proposedAt, "proposedAt"),
    disposition: disposition.type === "confirmed"
      ? {
          type: "confirmed", decisionId: safeId(disposition.decisionId, "decisionId"),
          decisionEventId: decisionEventId!,
          childRegistrationEventId: childRegistrationEventId!,
          childNodeSha: sha(disposition.childNodeSha, "childNodeSha"), reason: text(disposition.reason, "reason"),
          decidedAt: timestamp(disposition.decidedAt, "decidedAt")
        }
      : disposition.type === "rejected"
        ? {
            type: "rejected", decisionId: safeId(disposition.decisionId, "decisionId"),
            decisionEventId: decisionEventId!,
            reason: text(disposition.reason, "reason"), decidedAt: timestamp(disposition.decidedAt, "decidedAt")
          }
        : disposition.type === "pending" ? { type: "pending" } : invalid("Coaching disposition is invalid.")
  };
}

function decodeReview(value: unknown): ReviewActivityReadModel {
  const review = exactRecord(value, ["id", "eventId", "targetType", "targetId", "assessment", "recommendations", "recordedAt"]);
  return {
    id: safeId(review.id, "review.id"), eventId: safeId(review.eventId, "review.eventId"),
    targetType: oneOf(review.targetType, ["node", "run", "comparison"] as const, "targetType"),
    targetId: text(review.targetId, "targetId"), assessment: text(review.assessment, "assessment"),
    recommendations: array(review.recommendations, "recommendations").map(item => text(item, "recommendation")),
    recordedAt: timestamp(review.recordedAt, "recordedAt")
  };
}

function decodeEventEntry(value: unknown): EventIndexEntryReadModel {
  const entry = exactRecord(value, ["sequence", "storedEventId", "domainEventId", "eventType", "summary", "actor", "occurredAt", "path", "reference"]);
  const actor = exactRecord(entry.actor, ["id", "label"]);
  return {
    sequence: positive(entry.sequence, "sequence"), storedEventId: storedEventId(entry.storedEventId),
    domainEventId: safeId(entry.domainEventId, "domainEventId"), eventType: oneOf(entry.eventType, DOMAIN_EVENT_TYPES, "eventType"),
    summary: text(entry.summary, "summary"), actor: { id: text(actor.id, "actor.id"), label: text(actor.label, "actor.label") },
    occurredAt: timestamp(entry.occurredAt, "occurredAt"), path: authoritativeEventFilePath(entry.path), reference: decodeEventReference(entry.reference)
  };
}

function decodeEventReference(value: unknown): EventReferenceProjection {
  if (!isRecord(value)) invalid("Event reference must be an object.");
  if (value.kind === "project") {
    exactRecord(value, ["kind"]);
    return { kind: "project" };
  }
  if (value.kind === "node") {
    const reference = exactRecord(value, ["kind", "nodeSha"]);
    return { kind: "node", nodeSha: sha(reference.nodeSha, "reference.nodeSha") };
  }
  if (value.kind === "run") {
    const reference = exactRecord(value, ["kind", "runId", "sourceNodeSha", "target"]);
    if (!isRecord(reference.target)) invalid("Event Run target is invalid.");
    const target = reference.target.kind === "registered" ? exactRecord(reference.target, ["kind", "nodeSha"]) : exactRecord(reference.target, ["kind"]);
    return {
      kind: "run", runId: safeId(reference.runId, "reference.runId"), sourceNodeSha: sha(reference.sourceNodeSha, "reference.sourceNodeSha"),
      target: target.kind === "registered" ? { kind: "registered", nodeSha: sha(target.nodeSha, "reference.target.nodeSha") }
        : target.kind === "pending" ? { kind: "pending" } : invalid("Event Run target is invalid.")
    };
  }
  return invalid("Event reference kind is invalid.");
}

function authoritativeEventPath(projectId: string, occurredAt: string, eventId: string): string {
  const date = new Date(occurredAt);
  return `.hunsu/v2/projects/${projectId}/events/${String(date.getUTCFullYear()).padStart(4, "0")}/${String(date.getUTCMonth() + 1).padStart(2, "0")}/${eventId}.json`;
}

function authoritativeEventFilePath(value: unknown): string {
  const result = text(value, "event.path");
  if (!/^\.hunsu\/v2\/projects\/[A-Za-z0-9][A-Za-z0-9_-]{0,127}\/events\/\d{4}\/\d{2}\/[0-9a-f]{32}\.json$/u.test(result)) {
    invalid("Event path is invalid.");
  }
  return result;
}

function safeProjectIdFromManagedRef(value: string): string {
  const match = value.match(/^refs\/tags\/hunsu\/node\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})\/[0-9a-f]{40}$/u);
  return match?.[1] ?? invalid("Managed Node ref is invalid.");
}

function readModelDigest(kind: ShardedReadModelKind, canonical: string): string {
  return `hunsu-${kind}-read-model-v2:sha256:${sha256(canonical)}`;
}

function digest(value: unknown, kind: ShardedReadModelKind): string {
  const result = text(value, "digest");
  if (!new RegExp(`^hunsu-${kind}-read-model-v2:sha256:[0-9a-f]{64}$`, "u").test(result)) invalid("Read model shard digest is invalid.");
  return result;
}

function topologyDigest(value: unknown): string {
  const result = text(value, "topologyDigest");
  if (!/^hunsu-graph-topology-v2:sha256:[0-9a-f]{64}$/u.test(result)) invalid("Graph topology digest is invalid.");
  return result;
}

function graphNodeIdentityDigest(value: unknown): string {
  const result = text(value, "graphNodeIdentityDigest");
  if (!/^hunsu-graph-node-identity-v2:sha256:[0-9a-f]{64}$/u.test(result)) {
    invalid("Graph Node identity digest is invalid.");
  }
  return result;
}

function nodeActivityPageCommitmentDigest(value: unknown, field: string): string {
  const result = text(value, field);
  if (!/^hunsu-node-activity-page-v2:sha256:[0-9a-f]{64}$/u.test(result)) {
    invalid(`${field} is not a Node activity page commitment digest.`);
  }
  return result;
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!isRecord(value)) invalid("Read model value must be an object.");
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) invalid("Read model object contains missing or unsupported fields.");
  return value;
}

function array(value: unknown, field: string): readonly unknown[] {
  if (!Array.isArray(value)) invalid(`${field} must be an array.`);
  return value;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") invalid(`${field} must be non-empty text.`);
  return value;
}

function typedDigest(value: unknown, field: string, pattern: RegExp): string {
  const result = text(value, field);
  if (!pattern.test(result)) invalid(`${field} is invalid.`);
  return result;
}

function safeId(value: unknown, field: string): string {
  const result = text(value, field);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(result) || result.includes("..")) invalid(`${field} must be a branch-safe identifier.`);
  return result;
}

function sha(value: unknown, field: string): string {
  const result = text(value, field);
  if (!/^[0-9a-f]{40}$/u.test(result)) invalid(`${field} must be a full lowercase Git SHA.`);
  return result;
}

function storedEventId(value: unknown): string {
  const result = text(value, "storedEventId");
  if (!/^[0-9a-f]{32}$/u.test(result)) invalid("storedEventId is invalid.");
  return result;
}

function timestamp(value: unknown, field: string): string {
  const result = text(value, field);
  const parsed = new Date(result);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== result) invalid(`${field} must be a canonical UTC timestamp.`);
  return result;
}

function positive(value: unknown, field: string): number {
  return safeInteger(value, 1, Number.MAX_SAFE_INTEGER, field);
}

function nonNegative(value: unknown, field: string): number {
  return safeInteger(value, 0, Number.MAX_SAFE_INTEGER, field);
}

function safeInteger(value: unknown, minimum: number, maximum: number, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) invalid(`${field} must be a bounded safe integer.`);
  return Number(value);
}

function oneOf<const T extends readonly string[]>(value: unknown, values: T, field: string): T[number] {
  if (typeof value !== "string" || !values.includes(value)) invalid(`${field} has an unsupported value.`);
  return value as T[number];
}

function gzipDecodedSize(value: Uint8Array): number {
  const offset = value.byteLength - 4;
  return (value[offset]! | (value[offset + 1]! << 8) | (value[offset + 2]! << 16) | (value[offset + 3]! << 24)) >>> 0;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) invalid("Read model contains a non-canonical number.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!isRecord(value)) invalid("Read model contains a non-JSON value.");
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalid(message: string): never {
  throw new DecodeFailure(message);
}

function ok<T>(value: T): StoreResult<T> {
  return { ok: true, value };
}

function failure(message: string): StoreResult<never> {
  return { ok: false, error: { code: "integrity", message } };
}

class DecodeFailure extends Error {}
