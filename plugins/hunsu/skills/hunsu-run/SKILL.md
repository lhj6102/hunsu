---
name: hunsu-run
description: Start, execute, recover, and finish a Node-scoped Hunsu Run for exactly one Goal using the source Node's immutable Runner Value. Use when Codex should perform repository work, record checkpoints or evidence, recover an interrupted Run, or report a verifiable result commit.
---

# Hunsu Run

1. Load the source with `hunsu.nodes.get`. Select exactly one entry from `nextGoals`; never combine Goals in one Run and never accept a caller-supplied Runner or base SHA.
2. Call `hunsu.runs.start` with `sourceNodeSha`, the selected `goalDigest`, a new `runId`, a logical idempotency key, and the exact state head. Treat the returned `hunsu.run-contract.v2` as immutable.
3. Verify the repository, source Node SHA, and returned Run branch before editing. Follow the contract's singular Goal, full Runner Value, resolved instructions, evidence requirements, and tool policy. Player and Team are bundled type examples, not the complete set of possible Runner types.
4. When recovering, call `hunsu.runs.get` and continue from its immutable contract, existing branch, checkpoints, and evidence.
5. Record meaningful recovery points with `hunsu.runs.checkpoint` using an explicit observation or commit location. Attach evidence with `hunsu.runs.attach_evidence` using one explicit run/criterion target and one immutable Git, URL, or text location.
6. Commit and push the result branch. Call `hunsu.runs.complete` with the exact result SHA and evidence for every acceptance criterion; completion succeeds only after ancestry and branch-reachability verification.
7. Attach actionable evidence first, then call `hunsu.runs.fail` when the Goal cannot be satisfied. Use `hunsu.runs.cancel` only for an intentional stop. Failed and canceled Runs create no Node or structural edge.

Never modify the Node Plan during a Run, claim completion before the push succeeds, inspect or mutate `hunsu/state`, or put credentials and mutable local paths in evidence. Plan changes require a separately confirmed Coaching transition.
