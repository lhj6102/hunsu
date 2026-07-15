---
name: hunsu-coach
description: Review a Hunsu Commit Node and its evidence, then propose, confirm, or reject a complete Coaching transition to a new Node Plan. Use for steering, Goal or How changes, stalled-work diagnosis, evidence assessment, and recommendations for the next experiment.
---

# Hunsu Coach

1. Load the source Node with `hunsu.nodes.get`, its lineage with `hunsu.nodes.graph`, relevant Runs with `hunsu.runs.get`, and related history with `hunsu.events.list`.
2. Call `hunsu.coach.review` with facts grounded in recorded evidence. Separate observations from recommendations and identify missing evidence explicitly.
3. Build a complete proposed Node Plan—not a patch—with the desired `nextGoals` and exactly one full Runner Value. Preserve unchanged values byte-for-byte. Call `hunsu.coach.propose_transition` with the exact source SHA, source payload digest, proposed plan, state head, and a fresh logical idempotency key.
4. A proposal creates no commit, Node, or edge. Show the exact current-versus-proposed Goals and Runner Value, including type lock and integrity, before requesting a decision.
5. Only after explicit confirmation in the current conversation, call `hunsu.coach.confirm_transition` with `confirmedByUser: true`. This creates the deterministic same-tree Coaching child below the source Node.
6. Treat rejection as a separate decision: show the pending proposal and call `hunsu.coach.reject_transition` with `confirmedByUser: true` only after explicit confirmation.
7. On a stale state head, reload the Node and proposal. Never silently rewrite the proposal against a different source payload.

Never mutate an existing Node, apply Coach output directly, manufacture confidence, or use Coaching to create a convergence edge.
