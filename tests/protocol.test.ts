import test from "node:test";
import assert from "node:assert/strict";
import {
  createDefaultHarness,
  projectBoard,
  tryApplyCommand,
  validateCommand,
  validateDomainEvent
} from "../packages/protocol/src/index.ts";
import type { Command, DomainEvent, NodeRecord } from "../packages/protocol/src/index.ts";

function applyCommandOrThrow(events: DomainEvent[], command: Command): DomainEvent[] {
  const result = tryApplyCommand(events, command);
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.value;
}

function baseEvents(): DomainEvent[] {
  return applyCommandOrThrow([], {
    type: "CreateInitialTeam",
    requestId: "req_001",
    lineId: "line_main",
    title: "Build Studio MVP",
    goal: "Create the first Studio control plane",
    destinations: [{ id: "destination_001", title: "Define protocol command/event unions", priority: 30 }],
    at: "2026-05-11T00:00:00.000Z"
  });
}

test("protocol folds Destinations and TEAM MOVEs into board projection", () => {
  let events = baseEvents();
  events = applyCommandOrThrow(events, {
    type: "ClaimDestination",
    destinationId: "destination_001",
    actor: "codex"
  });
  events = applyCommandOrThrow(events, {
    type: "RecordMove",
    lineId: "line_main",
    moveId: "M0001",
    summary: "Protocol model recorded",
    commit: "abc123",
    reachedDestinationIds: ["destination_001"],
    evidence: ["protocol.test.ts"],
    actor: "codex"
  });

  const board = projectBoard(events);

  assert.equal(board.requests.length, 1);
  assert.equal(board.lines[0].moveIds[0], "M0001");
  assert.equal(board.nodes.find(node => node.source.type === "move")?.destinations.find(destination => destination.id === "destination_001")?.status, "reached");
  assert.equal(board.destinations.find(destination => destination.id === "destination_001")?.status, "reached");
});

test("Team naming starts with T1 and skips used team names", () => {
  const firstBoard = projectBoard(baseEvents());

  assert.equal(firstBoard.lines[0].teamName, "T1");

  const events = applyCommandOrThrow(baseEvents(), {
    type: "StartLine",
    requestId: "req_001",
    lineId: "line_secondary"
  });
  const board = projectBoard(events);

  assert.equal(board.lines.find(line => line.id === "line_secondary")?.teamName, "Gen.G");
});

test("unsupported command payloads are not accepted as domain commands", () => {
  const command = validateCommand({
    type: "CreateInitialAgent",
    requestId: "req_legacy",
    lineId: "line_legacy",
    title: "Legacy roadmap",
    goal: "Load old command data",
    destinations: [{ id: "destination_legacy", title: "Load unsupported command payloads" }],
    teamName: "Legacy Team"
  });

  assert.equal(command.ok, false);
  if (!command.ok) {
    assert.match(command.error.message, /Unsupported command type: CreateInitialAgent/);
  }
});

test("InitialTeamCreated event payloads decode into Team domain fields", () => {
  const legacyProtocol = {
    ...createDefaultHarness(),
    kind: "team_execution_plan"
  };

  const event = validateDomainEvent({
    type: "InitialTeamCreated",
    request: {
      id: "req_legacy",
      title: "Legacy roadmap",
      goal: "Load old event data",
      createdBy: "SYSTEM"
    },
    line: {
      id: "line_legacy",
      requestId: "req_legacy",
      teamName: "Legacy Team",
      status: "active",
      moveIds: [],
      rootNodeId: "req_legacy:root",
      currentNodeId: "req_legacy:root",
      nodeIds: ["req_legacy:root"]
    },
    destinations: [{ id: "destination_legacy", title: "Load Team payloads" }],
    harness: legacyProtocol
  });

  assert.equal(event.ok, true);
  if (event.ok) {
    assert.equal(event.value.type, "InitialTeamCreated");
    assert.equal(event.value.line.teamName, "Legacy Team");
    assert.equal(event.value.harness?.kind, "team_execution_plan");
  }

  const forkEvent = validateDomainEvent({
    type: "LineForkedByHunsu",
    hunsuId: "h001",
    fromLineId: "line_legacy",
    newLineId: "line_legacy/fork-h001",
    newTeamName: "Legacy Fork",
    requestId: "req_legacy"
  });

  assert.equal(forkEvent.ok, true);
  if (forkEvent.ok) {
    assert.equal(forkEvent.value.type, "LineForkedByHunsu");
    assert.equal(forkEvent.value.newTeamName, "Legacy Fork");
  }
});

test("ConfirmHunsuDraft records runtime changed files and creates the fork node from the request snapshot", () => {
  const sourceEvents = baseEvents();
  const sourceBoard = projectBoard(sourceEvents);
  const sourceNode = sourceBoard.nodes[0] as NodeRecord;
  const harness = createDefaultHarness();
  const requestDestinations = [
    ...sourceNode.destinations.map(destination => ({ ...destination })),
    {
      id: "destination_002",
      requestId: "req_001",
      title: "Show Korea time on the main screen",
      status: "pending" as const,
      source: "hunsu" as const,
      createdBy: "DIRECTOR" as const,
      updatedBy: "DIRECTOR" as const,
      priority: 20
    }
  ];

  const events = applyCommandOrThrow(sourceEvents, {
    type: "ConfirmHunsuDraft",
    actor: "DIRECTOR",
    at: "2026-05-11T00:05:00.000Z",
    draft: {
      id: "hd001",
      status: "ready",
      sourceLineId: "line_main",
      sourceNodeId: sourceNode.id,
      target: { type: "node", id: sourceNode.id },
      newTeamName: sourceNode.teamName ?? "Team",
      summary: "Add Korean time todo",
      teamSnapshot: {
        teamName: sourceNode.teamName ?? "Team",
        moveOrdinal: sourceNode.ordinal,
        destinations: requestDestinations,
        harness,
        harnessGraph: sourceNode.harnessGraph,
        artifactActions: []
      },
      changedFiles: [{
        path: ".hunsu-request/destinations.json",
        kind: "updated",
        summary: "Destinations 1 added."
      }],
      hunsuId: "h001",
      newLineId: "line_main/fork-h001",
      conversationRef: {
        provider: "local",
        conversationHash: "conversation_hash",
        contextHash: "context_hash",
        startedAt: "2026-05-11T00:04:00.000Z",
        endedAt: "2026-05-11T00:05:00.000Z"
      },
      createdAt: "2026-05-11T00:04:00.000Z",
      updatedAt: "2026-05-11T00:05:00.000Z"
    }
  });

  const board = projectBoard(events);
  const hunsu = board.hunsus[0];
  const forkLine = board.lines.find(line => line.id === "line_main/fork-h001");
  const hunsuNode = board.nodes.find(node => node.id === hunsu.toNodeId);

  assert.equal(hunsu.changedFiles[0].path, ".hunsu-request/destinations.json");
  assert.equal(forkLine?.currentNodeId, hunsu.toNodeId);
  assert.equal(hunsuNode?.destinations.some(destination => destination.id === "destination_002"), true);
  assert.equal(hunsuNode?.source.type, "hunsu");
});

test("deprecated direct Hunsu mutation commands are rejected by the decoder", () => {
  const result = validateCommand({
    type: "AddDestination",
    hunsuId: "h001",
    lineId: "line_main",
    target: { type: "line", id: "line_main" },
    summary: "Add a todo",
    destination: { id: "destination_002", title: "Show Korea time" },
    actor: "human"
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error.message, /Unsupported command type/);
  }
});

test("RecordMove risks must be non-empty text", () => {
  const result = validateCommand({
    type: "RecordMove",
    lineId: "line_main",
    moveId: "M0001",
    summary: "Protocol model recorded",
    commit: "abc123",
    reachedDestinationIds: ["destination_001"],
    evidence: ["protocol.test.ts"],
    risks: [""],
    actor: "codex"
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error.message, /risks\[0\] must be a non-empty string/);
  }
});

test("RecordMove commit must be non-empty text", () => {
  const result = validateCommand({
    type: "RecordMove",
    lineId: "line_main",
    moveId: "M0001",
    summary: "Protocol model recorded",
    commit: "",
    reachedDestinationIds: ["destination_001"],
    evidence: ["protocol.test.ts"],
    actor: "codex"
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error.message, /commit must be a non-empty string/);
  }
});

test("CreateInitialTeam destination details must be non-empty text", () => {
  const result = validateCommand({
    type: "CreateInitialTeam",
    requestId: "req_001",
    lineId: "line_main",
    title: "Build Studio MVP",
    goal: "Create the first Studio control plane",
    destinations: [{
      id: "destination_001",
      title: "Define protocol command/event unions",
      acceptanceCriteria: [""]
    }]
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error.message, /destinations\[0\]\.acceptanceCriteria\[0\] must be a non-empty string/);
  }
});

test("CreateInitialTeam destination notes must be non-empty when present", () => {
  const result = validateCommand({
    type: "CreateInitialTeam",
    requestId: "req_001",
    lineId: "line_main",
    title: "Build Studio MVP",
    goal: "Create the first Studio control plane",
    destinations: [{
      id: "destination_001",
      title: "Define protocol command/event unions",
      notes: ""
    }]
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error.message, /destinations\[0\]\.notes must be a non-empty string/);
  }
});

test("CreateInitialTeam teamName must be non-empty when present", () => {
  const result = validateCommand({
    type: "CreateInitialTeam",
    requestId: "req_001",
    lineId: "line_main",
    title: "Build Studio MVP",
    goal: "Create the first Studio control plane",
    destinations: [{ id: "destination_001", title: "Define protocol command/event unions" }],
    teamName: ""
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error.message, /teamName must be a non-empty string/);
  }
});
