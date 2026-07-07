import test from "node:test";
import assert from "node:assert/strict";
import { createBoardFromCommits, nextHunsuId, parseCommitSha, resolveMove } from "../packages/core/src/index.ts";
import type { CommitRecord } from "../packages/core/src/index.ts";

test("createBoardFromCommits reconstructs runs, moves, and hunsus", () => {
  const target = commit("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "move: checkout policy", `move: checkout policy

Goal: checkout-domain-policy
Evidence: unit:pass

Hunsu-Event: move
Hunsu-Run: run/checkout-policy
Hunsu-Move: 1
Hunsu-Goal: checkout-domain-policy
Hunsu-Role: team
Hunsu-Actor: agent:codex
Hunsu-Status: complete
`);
  const hunsu = commit("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "hunsu: domain layer", `hunsu: domain layer

Observation: UI guard is not enough.
Instruction: Move authority to backend.

Hunsu-Event: hunsu
Hunsu-ID: h001
Hunsu-Target: ${target.sha}
Hunsu-Source-Run: run/checkout-policy
Hunsu-New-Run: run/checkout-policy-h001
Hunsu-Role: director
Hunsu-Actor: human
`);

  const board = createBoardFromCommits([hunsu, target]);

  assert.equal(board.moves.length, 1);
  assert.equal(board.hunsus.length, 1);
  assert.equal(board.runs.length, 2);
  assert.deepEqual(
    board.runs.find(run => run.runId === "run/checkout-policy")?.events.map(event => event.type),
    ["move", "hunsu"]
  );
  assert.deepEqual(
    board.runs.find(run => run.runId === "run/checkout-policy-h001")?.events.map(event => event.type),
    ["hunsu"]
  );
  assert.equal(resolveMove(board, "M0001").goal, "checkout-domain-policy");
  assert.equal(resolveMove(board, target.sha.slice(0, 12)).moveId, "M0001");
  assert.equal(nextHunsuId(board), "h002");
});

test("createBoardFromCommits orders same-timestamp moves by move number", () => {
  const firstMove = commit("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "move: first", `move: first

Hunsu-Event: move
Hunsu-Run: run/tie
Hunsu-Move: 1
Hunsu-Goal: first-goal
Hunsu-Role: team
Hunsu-Actor: agent:codex
Hunsu-Status: complete
`);
  const secondMove = commit("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "move: second", `move: second

Hunsu-Event: move
Hunsu-Run: run/tie
Hunsu-Move: 2
Hunsu-Goal: second-goal
Hunsu-Role: team
Hunsu-Actor: agent:codex
Hunsu-Status: complete
`);

  const board = createBoardFromCommits([secondMove, firstMove]);

  assert.deepEqual(board.runs[0].moves.map(move => move.moveId), ["M0001", "M0002"]);
  assert.deepEqual(board.runs[0].events.map(event => event.type === "move" ? event.moveId : event.hunsuId), ["M0001", "M0002"]);
});

test("createBoardFromCommits rejects unsupported MOVE statuses", () => {
  const move = commit("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "move: invalid status", `move: invalid status

Hunsu-Event: move
Hunsu-Run: run/status
Hunsu-Move: 1
Hunsu-Goal: status-goal
Hunsu-Role: team
Hunsu-Actor: agent:codex
Hunsu-Status: mystery
`);

  assert.throws(() => createBoardFromCommits([move]), /unsupported Hunsu-Status mystery/);
});

test("createBoardFromCommits rejects non-numeric MOVE trailer values", () => {
  const move = commit("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "move: invalid number", `move: invalid number

Hunsu-Event: move
Hunsu-Run: run/status
Hunsu-Move: one
Hunsu-Goal: status-goal
Hunsu-Role: team
Hunsu-Actor: agent:codex
Hunsu-Status: complete
`);

  assert.throws(() => createBoardFromCommits([move]), /invalid Hunsu-Move: must be numeric/);
});

test("createBoardFromCommits rejects invalid MOVE goals", () => {
  const move = commit("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "move: invalid goal", `move: invalid goal

Hunsu-Event: move
Hunsu-Run: run/status
Hunsu-Move: 1
Hunsu-Goal: invalid\u0000goal
Hunsu-Role: team
Hunsu-Actor: agent:codex
Hunsu-Status: complete
`);

  assert.throws(() => createBoardFromCommits([move]), /invalid Hunsu-Goal: must be a non-empty Hunsu goal/);
});

test("createBoardFromCommits rejects unsupported HUNSU event types", () => {
  const event = commit("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "hunsu: invalid event", `hunsu: invalid event

Hunsu-Event: mystery
`);

  assert.throws(() => createBoardFromCommits([event]), /unsupported Hunsu-Event mystery/);
});

test("createBoardFromCommits rejects invalid HUNSU priority trailers", () => {
  const event = commit("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "hunsu: invalid priority", `hunsu: invalid priority

Hunsu-Event: hunsu
Hunsu-ID: h001
Hunsu-Target: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
Hunsu-Source-Run: run/source
Hunsu-New-Run: run/new
Hunsu-Role: director
Hunsu-Actor: human
Hunsu-Priority: 
`);

  assert.throws(() => createBoardFromCommits([event]), /invalid Hunsu-Priority: must be a non-empty Hunsu priority/);
});

function commit(sha: string, subject: string, body: string): CommitRecord {
  return {
    sha: parseCommitSha(sha),
    shortSha: sha.slice(0, 7),
    parents: [],
    refs: [],
    authorName: "Test",
    authoredAt: "2026-05-11T00:00:00.000Z",
    subject,
    body
  };
}
