# Vision

Hunsu turns agentic development into a Roadmap that humans can steer without
holding the wheel.

The user creates a Roadmap with Destinations and a Harness. A Team
turns those Destinations into a closure-free ExecutionPlan, and Hunsu
interprets it in an isolated worktree. Verification is a first-class evaluator
Member in a Goal ExecutionPlan when the Harness needs it. When the Execute ends,
Studio records a MOVE as Arrived or Accident.

After a MOVE or candidate commit exists, Hunsu should be able to run configured
Artifact Actions from that immutable artifact. A host action lets the human
inspect the actual running result, not only a diff or agent log. Check actions,
including external E2E, exercise that result and can become evidence attached
to the Roadmap.

The human primarily acts as Director. Instead of editing agent prompts directly
or interrupting the running agent conversation, the user gives Hunsu from a
specific MOVE. That Hunsu creates a new Team at the same MOVE count with a
changed or copied Team Snapshot. Hunsu can be based on the route, the
snapshot, or Artifact Action results.

## Product Promise

Hunsu should let a user say:

```text
Show me the route.
Show me what the Team is doing.
Show me what each MOVE reached.
Show me the running product for this MOVE.
Show me the E2E evidence for that product.
Let me give Hunsu when the route, Destinations, or Harness are wrong.
Let me give Hunsu when the product result is wrong.
Never rewrite the source route silently.
```

## Core Experience

1. User creates a Roadmap.
2. Studio records MOVE 0 with the initial Team Snapshot.
3. Studio starts an Execute for the next MOVE.
4. The Team receives the selected Destination queue head and emits an ExecutionPlan.
5. Hunsu validates the ExecutionPlan and repeatedly interprets it.
6. Each completed Path records an automated Path commit and updates the Path
   commit map.
7. Member Paths execute or verify focused work and return ordinary Path output.
8. After all Paths complete, a MOVE finalizer agent compares the source MOVE to
   the terminal Path commit and returns the MOVE N+1 commit message.
9. Studio records a new MOVE N+1 commit after the terminal Path commit, or
   records an Accident MOVE.
10. Studio runs configured Artifact Actions for the MOVE or commit.
11. External E2E checks run as check actions or against host action aliases.
12. The user can inspect Action Runs, evidence, diff, conversation, Path commits,
    and snapshot.
13. The user can start Hunsu Manager from any MOVE.
14. The Manager prepares a HUNSU Draft.
15. Confirming the HUNSU Draft creates a new Team at the same MOVE count.
16. The new Team continues from the changed or copied snapshot.

## Non Goals

- Hunsu is not a general chat client.
- Hunsu is not a task manager detached from Git.
- Hunsu is not a hidden prompt mutator.
- Hunsu is not a replacement for code review or tests.
- Hunsu does not make scratch work visible as Roadmap state.
- Hunsu does not treat unmanaged dev servers as durable product evidence.

## Durable Model

The durable model is append-only and Git-backed. In the target runtime model, a
commit is an executable state:

- product files and the encoded `.hunsu/` runtime bundle live in the commit tree.
- Hunsu decodes the state, computes the current TODO and Harness
  bundle, asks the Team for an ExecutionPlan, interprets it through Member Paths,
  records automated Path commits, finalizes the terminal Path commit into a
  human-readable MOVE commit, updates encoded state, and records the next MOVE.
- MOVEs carry immutable Team Snapshots.
- Hunsu forks create new Team routes.
- Agent transcripts are referenced by conversation hashes.
- Worktrees are execution surfaces, not the source of truth.
- Artifact Actions are reproducible derived surfaces for inspection, checks,
  reports, exports, deploy candidates, and E2E evidence.
- E2E evidence is attached to the MOVE or commit it actually exercised.

Custom refs can be used as migration markers or local acceleration, but the
Roadmap must be reconstructable from reachable commits. This keeps historical
checkouts, Route worktrees, and future route branches able to reconstruct the
same Roadmap without copying mutable app state.
