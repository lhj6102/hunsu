---
name: hunsu-run
description: Start, execute, checkpoint, and finish a Hunsu Run through a Player or Team. Use when Codex should perform repository work for a Goal, report evidence, recover an interrupted Run, or report a verifiable result commit.
---

# Hunsu Run

1. Load the Project, Goal, and available Runners. When recovering an interrupted Run, call `hunsu.runs.get` and continue from its immutable snapshots, checkpoints, and evidence. Prefer a Player for the first vertical slice unless the user explicitly selects a Team.
2. If no suitable Runner exists, create one with its canonical `runnerId`; Runner definitions have no separate name. Use `hunsu.runners.create_player` for a Player or `hunsu.runners.create_team` for a Team. A Player requires its prompt, resources, and complete runtime policy. A Team requires its complete strategy (`mode`, `promptTemplate`, and `maxRounds`) plus ordered Player membership (`playerId`, `role`, and 1-based `order`). Reserve `hunsu.runners.update` for replacing the complete definition of an existing same-kind Runner; never send fields from the other variant.
3. Call `hunsu.runs.start` and treat the returned Run contract as immutable. Updating a Runner later changes only future Run snapshots.
4. Verify the active repository, exact base SHA, and returned `hunsu/run/<project>/<goal>/<run>` branch before editing. Stop and report a stale-base conflict instead of rebasing silently.
5. Perform the contract instructions in Codex. Follow its tool policy and never inspect or mutate `hunsu/state`.
6. For a Player contract, use only its snapshotted prompt, resources, and runtime policy. For a Team contract, order Players by `order` and obey the immutable strategy:
   - `sequence`: run each Player once in order, passing only repository artifacts and explicit summaries forward.
   - `parallel`: run Players independently from the same Run base, then reconcile their non-overlapping results in order. Do not let one Player silently change another Player's instructions.
   - `coordinated`: execute ordered rounds in which every Player receives the Team prompt and the prior round summary. Stop when the Goal is satisfied or after exactly `maxRounds`; never extend the round bound implicitly.
   Apply each snapshotted Player's own prompt, resources, and runtime policy during that Player's work. A Team strategy never authorizes broader tools than a Player policy.
7. Use `hunsu.runs.checkpoint` for meaningful recovery points and `hunsu.runs.attach_evidence` for checks, artifacts, or commit references. Link evidence to the exact acceptance criterion from the immutable Goal snapshot.
8. Commit and push the result branch. Then call `hunsu.runs.complete` with the exact result SHA and criterion-linked evidence covering every acceptance criterion. The service must verify reachability.
9. If work cannot satisfy the contract, call `hunsu.runs.fail` with actionable evidence. Use `hunsu.runs.cancel` only for an intentional stop.

Never claim completion before the push succeeds. Never put credentials or secret values in evidence.
