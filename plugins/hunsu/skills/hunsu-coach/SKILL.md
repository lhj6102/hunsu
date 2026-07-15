---
name: hunsu-coach
description: Recover or review a Hunsu Commit Node and its evidence, then propose, confirm, or reject a complete Coaching transition to a new Node Plan. Use for interrupted Coach work, steering, Goal changes, capability-validated How changes, stalled-work diagnosis, evidence assessment, and recommendations for the next experiment.
---

# Hunsu Coach

1. Load the source Node with `hunsu.nodes.get`, its lineage with `hunsu.nodes.graph`, relevant Runs with `hunsu.runs.get`, and related history with `hunsu.events.list`.
2. Recover recorded work before mutating: use `hunsu.coach.reviews.list` and `hunsu.coach.proposals.list` for the source Node, then use the matching `get` tool for any review or proposal that may be the lost response. Treat these exact-head records—not an abbreviated Node card—as disposition authority.
3. Call `hunsu.coach.review` with facts grounded in recorded evidence. Separate observations from recommendations and identify missing evidence explicitly.
4. If How will change, call repository-scoped `hunsu.runner_capabilities.list`, then `hunsu.runner_capabilities.get` with the chosen exact `RunnerTypeLock`. Validate the advertised native schema and `runContractResolution.status === "available"` before constructing the Runner Value. Player and Team are bundled examples, not exhaustive choices.
5. Build a complete proposed Node Plan—not a patch—with the desired `nextGoals` and exactly one full Runner Value. Preserve unchanged values byte-for-byte. Call `hunsu.coach.propose_transition` with the exact source SHA, source payload digest, proposed plan, required evidence summary, required rationale, state head, and a fresh logical idempotency key.
6. A proposal creates no commit, Node, or edge. Show the exact current-versus-proposed Goals and Runner Value, including type lock and integrity, before requesting a decision.
7. Only after explicit confirmation in the current conversation, call `hunsu.coach.confirm_transition` with `confirmedByUser: true`. This creates the deterministic same-tree Coaching child below the source Node.
8. Treat rejection as a separate decision: reload the complete pending proposal with `hunsu.coach.proposals.get`, show it, and call `hunsu.coach.reject_transition` with `confirmedByUser: true` only after a new explicit confirmation.
9. On a stale state head or uncertain response, repeat the bounded list read and corresponding exact get read. Never silently rewrite a proposal against a different source payload or reuse one confirmation for confirmation and rejection.

Never mutate an existing Node, apply Coach output directly, manufacture confidence, or use Coaching to create a convergence edge.
