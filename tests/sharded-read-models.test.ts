import assert from "node:assert/strict";
import test from "node:test";
import {
  EVENT_INDEX_SHARD_SIZE,
  MAX_EVENT_SHARDS_PER_PAGE,
  scanReverseEventShards,
  type ProjectEventShardReadModel
} from "../apps/api/src/sharded-read-models.ts";
import type { EventIndexEntryReadModel, EventLogCheckpoint } from "../apps/api/src/project-read-models.ts";

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
