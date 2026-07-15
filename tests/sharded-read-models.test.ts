import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { gzipSync } from "node:zlib";
import {
  EVENT_INDEX_SHARD_SIZE,
  GRAPH_MANIFEST_SCHEMA,
  GRAPH_NODE_SCHEMA,
  GRAPH_PAGE_SCHEMA,
  GRAPH_PAGE_SIZE,
  MAX_EVENT_SHARDS_PER_PAGE,
  NODE_ACTIVITY_INDEX_SCHEMA,
  NODE_ACTIVITY_PAGE_SCHEMA,
  NODE_ACTIVITY_RECORD_SCHEMA,
  RUN_ACTIVITY_SCHEMA,
  SHARDED_READ_MODEL_CODEC,
  SHARDED_READ_MODEL_ENVELOPE_SCHEMA,
  computeGraphPageNodeIdentityRoot,
  computeGraphTopologyDigest,
  createGraphNodeIdentityProof,
  createNodeActivityCategoryCommitment,
  decodeGraphManifest,
  decodeGraphNodeShard,
  decodeGraphPage,
  decodeNodeActivityIndex,
  decodeNodeActivityPage,
  decodeNodeActivityRecord,
  decodeRunActivityShard,
  graphPagePath,
  scanReverseEventShards,
  validateGraphNodeTopology,
  validateGraphPageNodeLocators,
  validateGraphPageTopology,
  validateNodeActivityPageCommitment,
  validateNodeActivityRecordMembership,
  type GraphPageDescriptor,
  type NodeActivityPageReadModel,
  type OrdinalGraphNode,
  type ProjectEventShardReadModel,
  type ProjectGraphManifestReadModel,
  type ProjectGraphNodeReadModel,
  type ProjectGraphPageReadModel,
  type ShardedReadModelKind
} from "../apps/api/src/sharded-read-models.ts";
import type {
  EventIndexEntryReadModel,
  EventLogCheckpoint,
  ProjectGraphEdge,
  ReviewActivityReadModel
} from "../apps/api/src/project-read-models.ts";
import { resolveStateFileSelections } from "../packages/github-store/src/state-files.ts";

const checkpoint: EventLogCheckpoint = {
  schema: "hunsu.event-log-checkpoint.v2",
  eventCount: 1_280,
  lastSequence: 1_280,
  lastStoredEventId: "f".repeat(32),
  lastDomainEventId: "event-1280",
  chainDigest: `hunsu-event-chain-v2:sha256:${"a".repeat(64)}`
};

function entry(sequence: number): EventIndexEntryReadModel {
  const storedEventId = sequence.toString(16).padStart(32, "0");
  return {
    sequence,
    storedEventId,
    domainEventId: `event-${sequence}`,
    eventType: "RunCheckpointed",
    summary: `Recorded checkpoint ${sequence}`,
    actor: { id: "qa-user", label: "User" },
    occurredAt: "2026-07-15T00:00:00.000Z",
    path: `.hunsu/v2/projects/project-one/events/2026/07/${storedEventId}.json`,
    reference: {
      kind: "run",
      runId: "run-one",
      sourceNodeSha: "a".repeat(40),
      target: { kind: "pending" }
    }
  };
}

function shard(index: number): ProjectEventShardReadModel {
  const sequenceStart = index * EVENT_INDEX_SHARD_SIZE + 1;
  return {
    schema: "hunsu.project-event-index-shard.v2",
    checkpoint,
    projectId: "project-one",
    index,
    sequenceStart,
    sequenceEnd: sequenceStart + EVENT_INDEX_SHARD_SIZE - 1,
    entries: Array.from({ length: EVENT_INDEX_SHARD_SIZE }, (_, offset) => entry(sequenceStart + offset))
  };
}

test("filtered Event scans are bounded and advance even when no Event matches", () => {
  const newestWindow = [shard(4), shard(3), shard(2), shard(1)];
  assert.equal(newestWindow.length, MAX_EVENT_SHARDS_PER_PAGE);
  const first = scanReverseEventShards(newestWindow, 1_281, 50, () => false);
  assert.equal(first.entries.length, 0);
  assert.equal(first.inspectedCount, EVENT_INDEX_SHARD_SIZE * MAX_EVENT_SHARDS_PER_PAGE);
  assert.equal(first.lastInspectedSequence, 257);
  assert.equal(first.hasOlder, true);

  const second = scanReverseEventShards([shard(0)], first.lastInspectedSequence!, 50, () => false);
  assert.equal(second.inspectedCount, 256);
  assert.equal(second.lastInspectedSequence, 1);
  assert.equal(second.hasOlder, false);
});

test("targeted state reads admit exactly one full page of keyed Graph Node locators", () => {
  const locators = Array.from({ length: GRAPH_PAGE_SIZE }, (_, index) => ({
    kind: "graph_node" as const,
    projectId: PROJECT_ID,
    nodeSha: graphSha(index + 1)
  }));
  const bounded = resolveStateFileSelections(locators);
  assert.equal(bounded.ok, true);
  if (bounded.ok) assert.equal(bounded.value.length, GRAPH_PAGE_SIZE);
  assert.equal(resolveStateFileSelections([...locators, {
    kind: "graph_node",
    projectId: PROJECT_ID,
    nodeSha: graphSha(GRAPH_PAGE_SIZE + 1)
  }]).ok, false);
});

test("filtered Event scans stop at 50 matches and resume without duplicates", () => {
  const newestWindow = [shard(4), shard(3), shard(2), shard(1)];
  const first = scanReverseEventShards(newestWindow, 1_281, 50, item => item.sequence % 2 === 0);
  assert.equal(first.entries.length, 50);
  assert.equal(first.entries[0]?.sequence, 1_280);
  assert.equal(first.entries.at(-1)?.sequence, 1_182);
  assert.equal(first.lastInspectedSequence, 1_182);
  assert.equal(first.inspectedCount, 99);

  const resumed = scanReverseEventShards(newestWindow, first.lastInspectedSequence!, 50, item => item.sequence % 2 === 0);
  assert.equal(resumed.entries[0]?.sequence, 1_180);
  assert.equal(new Set([...first.entries, ...resumed.entries].map(item => item.sequence)).size, 100);
});

test("Node activity indexes/pages/records are exact and Run evidence remains authoritative", () => {
  const nodeSha = "a".repeat(40);
  const run = {
    id: "run-one",
    sourceNodeSha: nodeSha,
    goalDigest: `hunsu-goal-v1:sha256:${"b".repeat(64)}`,
    goalTitle: "Verify evidence",
    runnerName: "QA Runner",
    runnerDigest: `hunsu-runner-v1:sha256:${"c".repeat(64)}`,
    branch: "hunsu/run/project-one/run-one",
    checkpoints: [],
    evidenceIds: ["evidence-one"],
    startedAt: "2026-07-15T00:00:00.000Z",
    outcome: { type: "running" as const }
  };
  const evidence = {
    id: "evidence-one",
    runId: "run-one",
    goalDigest: run.goalDigest,
    kind: "check" as const,
    summary: "The check passed.",
    target: { type: "run" as const },
    location: { type: "text" as const, text: "ok" },
    recordedAt: "2026-07-15T00:00:01.000Z"
  };
  const runCommitment = createNodeActivityCategoryCommitment(checkpoint, "project-one", nodeSha, "runs", [[run]]);
  const evidenceCommitment = createNodeActivityCategoryCommitment(checkpoint, "project-one", nodeSha, "evidence", [[evidence]]);
  const runPage = {
    schema: NODE_ACTIVITY_PAGE_SCHEMA,
    checkpoint,
    projectId: "project-one",
    nodeSha,
    kind: "runs",
    index: 0,
    offset: 0,
    entries: [run],
    membershipProof: runCommitment.proofs[0]
  };
  const evidencePage = {
    ...runPage,
    kind: "evidence",
    entries: [evidence],
    membershipProof: evidenceCommitment.proofs[0]
  };
  assert.equal(decodeNodeActivityPage(readModelEnvelope("nodeActivityPage", runPage)).ok, true);
  assert.equal(decodeNodeActivityPage(readModelEnvelope("nodeActivityPage", evidencePage)).ok, true);

  const emptyCategory = (kind: "comparisons" | "decisions" | "coaching" | "reviews") => ({
    count: 0,
    pageCount: 0,
    pageCommitmentRoot: createNodeActivityCategoryCommitment(checkpoint, "project-one", nodeSha, kind, []).root
  });
  const index = {
    schema: NODE_ACTIVITY_INDEX_SCHEMA,
    checkpoint,
    projectId: "project-one",
    nodeSha,
    categories: {
      runs: {
        count: 1,
        pageCount: 1,
        pageCommitmentRoot: runCommitment.root
      },
      evidence: {
        count: 1,
        pageCount: 1,
        pageCommitmentRoot: evidenceCommitment.root
      },
      comparisons: emptyCategory("comparisons"),
      decisions: emptyCategory("decisions"),
      coaching: emptyCategory("coaching"),
      reviews: emptyCategory("reviews")
    }
  };
  const decodedIndex = decodeNodeActivityIndex(readModelEnvelope("nodeActivityIndex", index));
  const decodedRunPage = decodeNodeActivityPage(readModelEnvelope("nodeActivityPage", runPage));
  const decodedEvidencePage = decodeNodeActivityPage(readModelEnvelope("nodeActivityPage", evidencePage));
  assert.equal(decodedIndex.ok, true);
  if (decodedIndex.ok && decodedRunPage.ok && decodedEvidencePage.ok) {
    assert.deepEqual(validateNodeActivityPageCommitment(decodedIndex.value, decodedRunPage.value), { ok: true, value: true });
    assert.deepEqual(validateNodeActivityPageCommitment(decodedIndex.value, decodedEvidencePage.value), { ok: true, value: true });
  }

  const redistributed = structuredClone(index) as any;
  redistributed.categories.runs.count = 51;
  assert.equal(decodeNodeActivityIndex(readModelEnvelope("nodeActivityIndex", redistributed)).ok, false);

  const tamperedRunPage = structuredClone(runPage) as any;
  tamperedRunPage.entries[0].goalTitle = "Injected title";
  const decodedTamperedRunPage = decodeNodeActivityPage(readModelEnvelope("nodeActivityPage", tamperedRunPage));
  assert.equal(decodedTamperedRunPage.ok, true);
  if (decodedIndex.ok && decodedTamperedRunPage.ok) {
    assert.equal(validateNodeActivityPageCommitment(decodedIndex.value, decodedTamperedRunPage.value).ok, false);
  }

  const review = {
    id: "review-one",
    eventId: "event-review-one",
    targetType: "node",
    targetId: nodeSha,
    assessment: "Ready.",
    recommendations: ["Continue."],
    recordedAt: "2026-07-15T00:00:02.000Z"
  };
  const reviewRecord = {
    schema: NODE_ACTIVITY_RECORD_SCHEMA,
    checkpoint,
    projectId: "project-one",
    nodeSha,
    kind: "reviews",
    id: review.id,
    pageIndex: 0,
    entryIndex: 0,
    value: review
  };
  assert.equal(decodeNodeActivityRecord(readModelEnvelope("nodeActivityRecord", reviewRecord)).ok, true);
  const unrelatedReview = structuredClone(reviewRecord) as any;
  unrelatedReview.value.targetId = "b".repeat(40);
  assert.equal(decodeNodeActivityRecord(readModelEnvelope("nodeActivityRecord", unrelatedReview)).ok, false);

  assert.equal(decodeRunActivityShard(readModelEnvelope("runActivity", {
    schema: RUN_ACTIVITY_SCHEMA,
    checkpoint,
    projectId: "project-one",
    run,
    evidence: [evidence],
    reviews: []
  })).ok, true);

  const injectedRunEvidence = {
    schema: RUN_ACTIVITY_SCHEMA,
    checkpoint,
    projectId: "project-one",
    run,
    evidence: [{ ...evidence, id: "evidence-injected" }],
    reviews: []
  };
  assert.equal(decodeRunActivityShard(readModelEnvelope("runActivity", injectedRunEvidence)).ok, false);

  const duplicateCheckpointRun = structuredClone(run) as any;
  duplicateCheckpointRun.checkpoints = [
    {
      id: "checkpoint-one",
      summary: "First observation.",
      location: { type: "observation" },
      recordedAt: "2026-07-15T00:00:02.000Z"
    },
    {
      id: "checkpoint-one",
      summary: "Duplicate id.",
      location: { type: "observation" },
      recordedAt: "2026-07-15T00:00:03.000Z"
    }
  ];
  assert.equal(decodeRunActivityShard(readModelEnvelope("runActivity", {
    schema: RUN_ACTIVITY_SCHEMA,
    checkpoint,
    projectId: "project-one",
    run: duplicateCheckpointRun,
    evidence: [evidence],
    reviews: []
  })).ok, false);
});

test("Node activity indexes stay constant-size beyond fifty physical pages", () => {
  const nodeSha = "a".repeat(40);
  const reviews: ReviewActivityReadModel[] = Array.from({ length: 2_501 }, (_, index) => ({
    id: `review-${String(index).padStart(4, "0")}`,
    eventId: `event-review-${String(index).padStart(4, "0")}`,
    targetType: "node",
    targetId: nodeSha,
    assessment: `Assessment ${index}`,
    recommendations: [`Recommendation ${index}`],
    recordedAt: new Date(Date.UTC(2026, 6, 15, 0, 0, index)).toISOString()
  }));
  const pages = Array.from(
    { length: Math.ceil(reviews.length / 50) },
    (_, index) => reviews.slice(index * 50, (index + 1) * 50)
  );
  const commitment = createNodeActivityCategoryCommitment(checkpoint, PROJECT_ID, nodeSha, "reviews", pages);
  assert.equal(pages.length, 51);
  assert.equal(Math.max(...commitment.proofs.map(proof => proof.siblings.length)), 6);
  const empty = (kind: "runs" | "evidence" | "comparisons" | "decisions" | "coaching") => ({
    count: 0,
    pageCount: 0,
    pageCommitmentRoot: createNodeActivityCategoryCommitment(checkpoint, PROJECT_ID, nodeSha, kind, []).root
  });
  const index = {
    schema: NODE_ACTIVITY_INDEX_SCHEMA,
    checkpoint,
    projectId: PROJECT_ID,
    nodeSha,
    categories: {
      runs: empty("runs"),
      evidence: empty("evidence"),
      comparisons: empty("comparisons"),
      decisions: empty("decisions"),
      coaching: empty("coaching"),
      reviews: { count: reviews.length, pageCount: pages.length, pageCommitmentRoot: commitment.root }
    }
  };
  assert.deepEqual(Object.keys(index.categories.reviews).sort(), ["count", "pageCommitmentRoot", "pageCount"]);
  const decodedIndex = decodeNodeActivityIndex(readModelEnvelope("nodeActivityIndex", index));
  assert.equal(decodedIndex.ok, true);
  if (!decodedIndex.ok) return;
  for (const pageIndex of [49, 50]) {
    const page = {
      schema: NODE_ACTIVITY_PAGE_SCHEMA,
      checkpoint,
      projectId: PROJECT_ID,
      nodeSha,
      kind: "reviews",
      index: pageIndex,
      offset: pageIndex * 50,
      entries: pages[pageIndex],
      membershipProof: commitment.proofs[pageIndex]
    };
    const decodedPage = decodeNodeActivityPage(readModelEnvelope("nodeActivityPage", page));
    assert.equal(decodedPage.ok, true);
    if (decodedPage.ok) {
      assert.deepEqual(validateNodeActivityPageCommitment(decodedIndex.value, decodedPage.value), { ok: true, value: true });
    }
  }
});

test("Run- and comparison-targeted review records cannot be copied to an unrelated Node", () => {
  const sourceNodeSha = "a".repeat(40);
  const unrelatedNodeSha = "b".repeat(40);
  const targets = [
    { targetType: "run" as const, targetId: "run-reviewed" },
    { targetType: "comparison" as const, targetId: "comparison-reviewed" }
  ];
  for (const [targetIndex, target] of targets.entries()) {
    const review: ReviewActivityReadModel = {
      id: `review-scope-${target.targetType}`,
      eventId: `event-review-scope-${target.targetType}`,
      ...target,
      assessment: "Scoped review.",
      recommendations: ["Keep the exact Node relation."],
      recordedAt: new Date(Date.UTC(2026, 6, 15, 1, 0, targetIndex)).toISOString()
    };
    const committed = createNodeActivityCategoryCommitment(checkpoint, PROJECT_ID, sourceNodeSha, "reviews", [[review]]);
    const page = {
      schema: NODE_ACTIVITY_PAGE_SCHEMA,
      checkpoint,
      projectId: PROJECT_ID,
      nodeSha: sourceNodeSha,
      kind: "reviews" as const,
      index: 0,
      offset: 0,
      entries: [review],
      membershipProof: committed.proofs[0]
    };
    const index = nodeActivityIndexFixture(sourceNodeSha, {
      count: 1,
      pageCount: 1,
      pageCommitmentRoot: committed.root
    });
    const record = {
      schema: NODE_ACTIVITY_RECORD_SCHEMA,
      checkpoint,
      projectId: PROJECT_ID,
      nodeSha: sourceNodeSha,
      kind: "reviews" as const,
      id: review.id,
      pageIndex: 0,
      entryIndex: 0,
      value: review
    };
    const decodedIndex = decodeNodeActivityIndex(readModelEnvelope("nodeActivityIndex", index));
    const decodedPage = decodeNodeActivityPage(readModelEnvelope("nodeActivityPage", page));
    const decodedRecord = decodeNodeActivityRecord(readModelEnvelope("nodeActivityRecord", record));
    assert.equal(decodedIndex.ok && decodedPage.ok && decodedRecord.ok, true);
    if (!decodedIndex.ok || !decodedPage.ok || !decodedRecord.ok || decodedRecord.value.kind !== "reviews"
      || decodedPage.value.kind !== "reviews") continue;
    assert.deepEqual(
      validateNodeActivityRecordMembership(
        decodedIndex.value,
        decodedPage.value as NodeActivityPageReadModel<"reviews">,
        decodedRecord.value
      ),
      { ok: true, value: true }
    );

    const unrelatedReview: ReviewActivityReadModel = {
      id: `review-unrelated-${target.targetType}`,
      eventId: `event-review-unrelated-${target.targetType}`,
      targetType: "node",
      targetId: unrelatedNodeSha,
      assessment: "Another Node review.",
      recommendations: [],
      recordedAt: review.recordedAt
    };
    const unrelatedCommitment = createNodeActivityCategoryCommitment(
      checkpoint,
      PROJECT_ID,
      unrelatedNodeSha,
      "reviews",
      [[unrelatedReview]]
    );
    const unrelatedIndex = decodeNodeActivityIndex(readModelEnvelope("nodeActivityIndex", nodeActivityIndexFixture(
      unrelatedNodeSha,
      { count: 1, pageCount: 1, pageCommitmentRoot: unrelatedCommitment.root }
    )));
    const unrelatedPage = decodeNodeActivityPage(readModelEnvelope("nodeActivityPage", {
      ...page,
      nodeSha: unrelatedNodeSha,
      entries: [unrelatedReview],
      membershipProof: unrelatedCommitment.proofs[0]
    }));
    const copiedRecord = decodeNodeActivityRecord(readModelEnvelope("nodeActivityRecord", {
      ...record,
      nodeSha: unrelatedNodeSha
    }));
    assert.equal(unrelatedIndex.ok && unrelatedPage.ok && copiedRecord.ok, true);
    if (unrelatedIndex.ok && unrelatedPage.ok && copiedRecord.ok && copiedRecord.value.kind === "reviews"
      && unrelatedPage.value.kind === "reviews") {
      assert.equal(
        validateNodeActivityRecordMembership(
          unrelatedIndex.value,
          unrelatedPage.value as NodeActivityPageReadModel<"reviews">,
          copiedRecord.value
        ).ok,
        false
      );
    }
  }
});

test("same-page Graph topology binds the structural parent and rejects unused proofs", () => {
  const root = graphNode(0, null);
  const child = graphNode(1, root);
  const edge = graphEdge(child);
  const page = graphPage(0, [root, child], [edge]);
  const manifest = graphManifest([graphDescriptor(page)]);
  const decodedPage = decodeGraphPage(readModelEnvelope("graphPage", page));
  const decodedManifest = decodeGraphManifest(readModelEnvelope("graphManifest", manifest));
  assert.equal(decodedPage.ok, true);
  assert.equal(decodedManifest.ok, true);
  if (!decodedPage.ok || !decodedManifest.ok) return;
  assert.deepEqual(validateGraphPageTopology(decodedManifest.value, decodedPage.value), { ok: true, value: true });

  const mismatchedParent = structuredClone(page) as any;
  mismatchedParent.nodes[1].lineage.parentSha = "f".repeat(40);
  mismatchedParent.edges[0].sourceSha = "f".repeat(40);
  assert.equal(decodeGraphPage(readModelEnvelope("graphPage", mismatchedParent)).ok, false);

  const unusedProof = structuredClone(page) as any;
  unusedProof.externalParents.push(createGraphNodeIdentityProof(PROJECT_ID, [root, child], 0, 0));
  assert.equal(decodeGraphPage(readModelEnvelope("graphPage", unusedProof)).ok, false);

  const wrongProjectRef = structuredClone(page) as any;
  wrongProjectRef.nodes[0].managedRef = `refs/tags/hunsu/node/project-other/${root.sha}`;
  assert.equal(decodeGraphPage(readModelEnvelope("graphPage", wrongProjectRef)).ok, false);
});

test("cross-page Graph topology requires one exact bounded parent membership proof", () => {
  const firstPageNodes: OrdinalGraphNode[] = [];
  for (let ordinal = 0; ordinal < GRAPH_PAGE_SIZE; ordinal += 1) {
    firstPageNodes.push(graphNode(ordinal, ordinal === 0 ? null : firstPageNodes[ordinal - 1]!));
  }
  const firstPage = graphPage(0, firstPageNodes, firstPageNodes.slice(1).map(graphEdge));
  const child = graphNode(GRAPH_PAGE_SIZE, firstPageNodes[0]!);
  const parentProof = createGraphNodeIdentityProof(PROJECT_ID, firstPageNodes, 0, 0);
  const secondPage = graphPage(1, [child], [graphEdge(child)], [parentProof]);
  const manifest = graphManifest([graphDescriptor(firstPage), graphDescriptor(secondPage)]);
  const decodedPage = decodeGraphPage(readModelEnvelope("graphPage", secondPage));
  const decodedManifest = decodeGraphManifest(readModelEnvelope("graphManifest", manifest));
  assert.equal(decodedPage.ok, true);
  assert.equal(decodedManifest.ok, true);
  if (!decodedPage.ok || !decodedManifest.ok) return;
  assert.deepEqual(validateGraphPageTopology(decodedManifest.value, decodedPage.value), { ok: true, value: true });
  assert.equal(parentProof.siblings.length <= 9, true);

  const missing = structuredClone(secondPage) as any;
  missing.externalParents = [];
  assert.equal(decodeGraphPage(readModelEnvelope("graphPage", missing)).ok, false);

  const duplicate = structuredClone(secondPage) as any;
  duplicate.externalParents.push(structuredClone(parentProof));
  assert.equal(decodeGraphPage(readModelEnvelope("graphPage", duplicate)).ok, false);

  const oversized = structuredClone(secondPage) as any;
  oversized.externalParents[0].siblings.push({
    side: "right",
    digest: `hunsu-graph-node-identity-v2:sha256:${"e".repeat(64)}`
  });
  assert.equal(decodeGraphPage(readModelEnvelope("graphPage", oversized)).ok, false);

  const tampered = structuredClone(secondPage) as any;
  tampered.externalParents[0].siblings[0].digest = `hunsu-graph-node-identity-v2:sha256:${"f".repeat(64)}`;
  const decodedTampered = decodeGraphPage(readModelEnvelope("graphPage", tampered));
  assert.equal(decodedTampered.ok, true);
  if (decodedTampered.ok) assert.equal(validateGraphPageTopology(decodedManifest.value, decodedTampered.value).ok, false);

  const foreign = structuredClone(secondPage) as any;
  foreign.externalParents[0].identity.managedRef = `refs/tags/hunsu/node/project-other/${firstPageNodes[0]!.sha}`;
  assert.equal(decodeGraphPage(readModelEnvelope("graphPage", foreign)).ok, false);
});

test("a keyed Graph Node locator rejects one full SHA reused on another Graph page", () => {
  const firstPageNodes: OrdinalGraphNode[] = [];
  for (let ordinal = 0; ordinal < GRAPH_PAGE_SIZE; ordinal += 1) {
    firstPageNodes.push(graphNode(ordinal, ordinal === 0 ? null : firstPageNodes[ordinal - 1]!));
  }
  const firstPage = graphPage(0, firstPageNodes, firstPageNodes.slice(1).map(graphEdge));
  const firstOccurrence = firstPageNodes[1]!;
  const duplicateChild = {
    ...graphNode(GRAPH_PAGE_SIZE, firstPageNodes[0]!),
    sha: firstOccurrence.sha,
    managedRef: firstOccurrence.managedRef
  } satisfies OrdinalGraphNode;
  const secondPage = graphPage(
    1,
    [duplicateChild],
    [graphEdge(duplicateChild)],
    [createGraphNodeIdentityProof(PROJECT_ID, firstPageNodes, 0, 0)]
  );
  const manifest = graphManifest([graphDescriptor(firstPage), graphDescriptor(secondPage)]);
  const decodedManifest = decodeGraphManifest(readModelEnvelope("graphManifest", manifest));
  const decodedSecondPage = decodeGraphPage(readModelEnvelope("graphPage", secondPage));
  assert.equal(decodedManifest.ok, true);
  assert.equal(decodedSecondPage.ok, true);
  if (!decodedManifest.ok || !decodedSecondPage.ok) return;
  // Page-local and cross-page-parent proofs alone cannot see the duplicated SHA.
  assert.deepEqual(validateGraphPageTopology(decodedManifest.value, decodedSecondPage.value), { ok: true, value: true });

  const firstLocator: ProjectGraphNodeReadModel = {
    schema: GRAPH_NODE_SCHEMA,
    checkpoint,
    projectId: PROJECT_ID,
    node: firstOccurrence,
    nodeProof: createGraphNodeIdentityProof(PROJECT_ID, firstPageNodes, 0, 1),
    parentProof: createGraphNodeIdentityProof(PROJECT_ID, firstPageNodes, 0, 0),
    outgoingEdges: [graphEdge(firstPageNodes[2]!)],
    outgoingTargetProofs: [createGraphNodeIdentityProof(PROJECT_ID, firstPageNodes, 0, 2)],
    activeRuns: []
  };
  const decodedLocator = decodeGraphNodeShard(readModelEnvelope("graphNode", firstLocator));
  assert.equal(decodedLocator.ok, true);
  if (!decodedLocator.ok) return;
  assert.deepEqual(validateGraphNodeTopology(decodedManifest.value, decodedLocator.value), { ok: true, value: true });
  assert.equal(
    validateGraphPageNodeLocators(decodedManifest.value, decodedSecondPage.value, [decodedLocator.value]).ok,
    false
  );
});

test("Graph Node shards prove their Node, parent, and every outgoing target", () => {
  const root = graphNode(0, null);
  const child = graphNode(1, root);
  const edge = graphEdge(child);
  const nodes = [root, child];
  const page = graphPage(0, nodes, [edge]);
  const manifest = graphManifest([graphDescriptor(page)]);
  const decodedManifest = decodeGraphManifest(readModelEnvelope("graphManifest", manifest));
  assert.equal(decodedManifest.ok, true);
  if (!decodedManifest.ok) return;
  const shard: ProjectGraphNodeReadModel = {
    schema: GRAPH_NODE_SCHEMA,
    checkpoint,
    projectId: PROJECT_ID,
    node: root,
    nodeProof: createGraphNodeIdentityProof(PROJECT_ID, nodes, 0, 0),
    parentProof: null,
    outgoingEdges: [edge],
    outgoingTargetProofs: [createGraphNodeIdentityProof(PROJECT_ID, nodes, 0, 1)],
    activeRuns: []
  };
  const decodedShard = decodeGraphNodeShard(readModelEnvelope("graphNode", shard));
  assert.equal(decodedShard.ok, true);
  if (!decodedShard.ok) return;
  assert.deepEqual(validateGraphNodeTopology(decodedManifest.value, decodedShard.value), { ok: true, value: true });

  const missingTarget = structuredClone(shard) as any;
  missingTarget.outgoingTargetProofs = [];
  assert.equal(decodeGraphNodeShard(readModelEnvelope("graphNode", missingTarget)).ok, false);

  const duplicateTarget = structuredClone(shard) as any;
  duplicateTarget.outgoingTargetProofs.push(structuredClone(duplicateTarget.outgoingTargetProofs[0]));
  assert.equal(decodeGraphNodeShard(readModelEnvelope("graphNode", duplicateTarget)).ok, false);

  const wrongTargetParentSha = structuredClone(shard) as any;
  wrongTargetParentSha.outgoingTargetProofs[0].identity.lineage.parentSha = "f".repeat(40);
  assert.equal(decodeGraphNodeShard(readModelEnvelope("graphNode", wrongTargetParentSha)).ok, false);

  const wrongTargetOrdinal = structuredClone(shard) as any;
  wrongTargetOrdinal.outgoingTargetProofs[0].identity.ordinal = 2;
  wrongTargetOrdinal.outgoingTargetProofs[0].leafIndex = 2;
  const decodedWrongOrdinal = decodeGraphNodeShard(readModelEnvelope("graphNode", wrongTargetOrdinal));
  assert.equal(decodedWrongOrdinal.ok, true);
  if (decodedWrongOrdinal.ok) assert.equal(validateGraphNodeTopology(decodedManifest.value, decodedWrongOrdinal.value).ok, false);

  const wrongTargetParentOrdinal = structuredClone(wrongTargetOrdinal) as any;
  wrongTargetParentOrdinal.outgoingTargetProofs[0].identity.parentOrdinal = 1;
  assert.equal(decodeGraphNodeShard(readModelEnvelope("graphNode", wrongTargetParentOrdinal)).ok, false);

  const wrongTargetRef = structuredClone(shard) as any;
  wrongTargetRef.outgoingTargetProofs[0].identity.managedRef = `refs/tags/hunsu/node/project-other/${child.sha}`;
  assert.equal(decodeGraphNodeShard(readModelEnvelope("graphNode", wrongTargetRef)).ok, false);

  const grandchild = graphNode(2, child);
  const unusedTarget = structuredClone(shard) as any;
  unusedTarget.outgoingTargetProofs.push(createGraphNodeIdentityProof(PROJECT_ID, [root, child, grandchild], 0, 2));
  assert.equal(decodeGraphNodeShard(readModelEnvelope("graphNode", unusedTarget)).ok, false);

  const childShard: ProjectGraphNodeReadModel = {
    schema: GRAPH_NODE_SCHEMA,
    checkpoint,
    projectId: PROJECT_ID,
    node: child,
    nodeProof: createGraphNodeIdentityProof(PROJECT_ID, nodes, 0, 1),
    parentProof: createGraphNodeIdentityProof(PROJECT_ID, nodes, 0, 0),
    outgoingEdges: [],
    outgoingTargetProofs: [],
    activeRuns: []
  };
  assert.equal(decodeGraphNodeShard(readModelEnvelope("graphNode", childShard)).ok, true);
  const missingParent = structuredClone(childShard) as any;
  missingParent.parentProof = null;
  assert.equal(decodeGraphNodeShard(readModelEnvelope("graphNode", missingParent)).ok, false);
});

test("Graph commitments are deterministic and manifest topology tampering is rejected", () => {
  const root = graphNode(0, null);
  const child = graphNode(1, root);
  const nodes = [root, child];
  const page = graphPage(0, nodes, [graphEdge(child)]);
  const descriptor = graphDescriptor(page);
  const manifest = graphManifest([descriptor]);
  assert.equal(
    computeGraphPageNodeIdentityRoot(PROJECT_ID, nodes),
    computeGraphPageNodeIdentityRoot(PROJECT_ID, structuredClone(nodes))
  );
  assert.deepEqual(
    createGraphNodeIdentityProof(PROJECT_ID, nodes, 0, 1),
    createGraphNodeIdentityProof(PROJECT_ID, structuredClone(nodes), 0, 1)
  );
  assert.equal(computeGraphTopologyDigest(manifest), computeGraphTopologyDigest(structuredClone(manifest)));

  const tampered = structuredClone(manifest) as any;
  tampered.pages[0].nodeIdentityRoot = `hunsu-graph-node-identity-v2:sha256:${"f".repeat(64)}`;
  assert.equal(decodeGraphManifest(readModelEnvelope("graphManifest", tampered)).ok, false);
});

test("Graph manifests require full non-final pages and the exact final ordinal range", () => {
  const firstPageNodes: OrdinalGraphNode[] = [];
  for (let ordinal = 0; ordinal < GRAPH_PAGE_SIZE; ordinal += 1) {
    firstPageNodes.push(graphNode(ordinal, ordinal === 0 ? null : firstPageNodes[ordinal - 1]!));
  }
  const firstPage = graphPage(0, firstPageNodes, firstPageNodes.slice(1).map(graphEdge));
  const finalNode = graphNode(GRAPH_PAGE_SIZE, firstPageNodes[0]!);
  const finalPage = graphPage(1, [finalNode], [graphEdge(finalNode)]);
  const manifest = graphManifest([graphDescriptor(firstPage), graphDescriptor(finalPage)]);
  assert.equal(decodeGraphManifest(readModelEnvelope("graphManifest", manifest)).ok, true);

  // This preserves the total Node count and used to admit a gap at ordinal 299
  // plus a final descriptor extending beyond the authoritative Node range.
  const redistributed = structuredClone(manifest) as any;
  redistributed.pages[0].nodeCount = GRAPH_PAGE_SIZE - 1;
  redistributed.pages[0].ordinalEnd = GRAPH_PAGE_SIZE - 2;
  redistributed.pages[1].nodeCount = 2;
  redistributed.pages[1].ordinalEnd = GRAPH_PAGE_SIZE + 1;
  redistributed.topologyDigest = computeGraphTopologyDigest(redistributed);
  assert.equal(decodeGraphManifest(readModelEnvelope("graphManifest", redistributed)).ok, false);

  const wrongFinalEnd = structuredClone(manifest) as any;
  wrongFinalEnd.pages[1].ordinalEnd = manifest.nodeCount;
  wrongFinalEnd.topologyDigest = computeGraphTopologyDigest(wrongFinalEnd);
  assert.equal(decodeGraphManifest(readModelEnvelope("graphManifest", wrongFinalEnd)).ok, false);
});

const PROJECT_ID = "project-one";

function nodeActivityIndexFixture(
  nodeSha: string,
  reviews: { readonly count: number; readonly pageCount: number; readonly pageCommitmentRoot: string }
) {
  const empty = (kind: "runs" | "evidence" | "comparisons" | "decisions" | "coaching") => ({
    count: 0,
    pageCount: 0,
    pageCommitmentRoot: createNodeActivityCategoryCommitment(checkpoint, PROJECT_ID, nodeSha, kind, []).root
  });
  return {
    schema: NODE_ACTIVITY_INDEX_SCHEMA,
    checkpoint,
    projectId: PROJECT_ID,
    nodeSha,
    categories: {
      runs: empty("runs"),
      evidence: empty("evidence"),
      comparisons: empty("comparisons"),
      decisions: empty("decisions"),
      coaching: empty("coaching"),
      reviews
    }
  };
}

function graphNode(ordinal: number, parent: OrdinalGraphNode | null): OrdinalGraphNode {
  const sha = graphSha(ordinal + 1);
  const root = parent === null;
  return {
    type: root ? "root" : "run_child",
    sha,
    treeSha: graphSha(10_000 + ordinal),
    managedRef: `refs/tags/hunsu/node/${PROJECT_ID}/${sha}`,
    commitTitle: root ? "Root" : `Run child ${ordinal}`,
    registeredAt: "2026-07-15T00:00:00.000Z",
    planDigest: `hunsu-node-plan-v1:sha256:${"a".repeat(64)}`,
    payloadDigest: `hunsu-node-payload-v1:sha256:${"b".repeat(64)}`,
    runner: {
      name: "QA Runner",
      origin: "hunsu.bundled",
      typeKey: "player",
      schemaVersion: "1",
      digest: `hunsu-runner-v1:sha256:${"c".repeat(64)}`
    },
    nextGoalCount: 1,
    status: root ? "current" : "available",
    lineage: root
      ? { type: "root" }
      : {
          type: "run",
          parentSha: parent.sha,
          runId: `run-${ordinal}`,
          consumedGoalDigest: `hunsu-goal-v1:sha256:${"d".repeat(64)}`
        },
    ordinal,
    parentOrdinal: parent?.ordinal ?? null
  };
}

function graphEdge(node: OrdinalGraphNode): ProjectGraphEdge {
  if (node.lineage.type !== "run") throw new Error("A root Node has no incoming edge.");
  return {
    type: "run",
    sourceSha: node.lineage.parentSha,
    targetSha: node.sha,
    runId: node.lineage.runId,
    goalDigest: node.lineage.consumedGoalDigest,
    goalTitle: `Goal for ${node.ordinal}`,
    completedAt: "2026-07-15T00:00:01.000Z"
  };
}

function graphPage(
  index: number,
  nodes: readonly OrdinalGraphNode[],
  edges: readonly ProjectGraphEdge[],
  externalParents: ProjectGraphPageReadModel["externalParents"] = []
): ProjectGraphPageReadModel {
  return {
    schema: GRAPH_PAGE_SCHEMA,
    checkpoint,
    projectId: PROJECT_ID,
    index,
    ordinalStart: index * GRAPH_PAGE_SIZE,
    nodes,
    externalParents,
    edges,
    activeRuns: []
  };
}

function graphDescriptor(page: ProjectGraphPageReadModel): GraphPageDescriptor {
  return {
    index: page.index,
    path: graphPagePath(page.index),
    ordinalStart: page.ordinalStart,
    ordinalEnd: page.ordinalStart + page.nodes.length - 1,
    nodeCount: page.nodes.length,
    edgeCount: page.edges.length,
    digest: readModelEnvelope("graphPage", page).digest,
    nodeIdentityRoot: computeGraphPageNodeIdentityRoot(PROJECT_ID, page.nodes)
  };
}

function graphManifest(pages: readonly GraphPageDescriptor[]): ProjectGraphManifestReadModel {
  const withoutDigest: Omit<ProjectGraphManifestReadModel, "topologyDigest"> = {
    schema: GRAPH_MANIFEST_SCHEMA,
    checkpoint,
    projectId: PROJECT_ID,
    rootNodeSha: graphSha(1),
    nodeCount: pages.reduce((sum, page) => sum + page.nodeCount, 0),
    edgeCount: pages.reduce((sum, page) => sum + page.edgeCount, 0),
    pageSize: GRAPH_PAGE_SIZE,
    pages
  };
  return { ...withoutDigest, topologyDigest: computeGraphTopologyDigest(withoutDigest) };
}

function graphSha(value: number): string {
  return value.toString(16).padStart(40, "0");
}

function readModelEnvelope(kind: ShardedReadModelKind, payload: unknown) {
  const canonical = canonicalJson(payload);
  const decoded = new TextEncoder().encode(canonical);
  const data = gzipSync(decoded, { level: 9 }).toString("base64");
  return {
    schema: SHARDED_READ_MODEL_ENVELOPE_SCHEMA,
    kind,
    codec: SHARDED_READ_MODEL_CODEC,
    checkpoint,
    decodedSize: decoded.byteLength,
    encodedSize: Buffer.byteLength(data, "utf8"),
    digest: `hunsu-${kind}-read-model-v2:sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`,
    data
  };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}
