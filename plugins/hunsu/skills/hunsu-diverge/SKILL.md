---
name: hunsu-diverge
description: Propose, create, compare, select, or reject deliberate Hunsu alternatives. Use when a Goal needs competing Runs from one base SHA, a user asks to give Hunsu, or completed sibling futures need an evidence-based decision.
---

# Hunsu Diverge

1. Load the source Run and ask the Coach for a Hunsu proposal when none exists.
2. Show the proposed Goal or Runner difference and require explicit user confirmation before starting a sibling Run.
3. Start the alternative from the source Run's exact base SHA. Never branch from its result commit. When the Coach proposal is still open and no divergence exists, pass its exact `coachProposalId` and `confirmedByUser: true` to `hunsu.runs.start`; that one call records the user's acceptance and starts the sibling atomically. Never pass either field without a confirmation obtained in the current conversation.
4. When Web already confirmed the divergence, start the sibling with `alternativeOfRunId` and the normal Run protocol; do not attempt to accept the Coach proposal again.
5. Call `hunsu.alternatives.compare` with a fresh idempotency key only after the alternatives have sufficient evidence. Record criterion-by-criterion findings across every included Run, plus constraints, checks, risks, and result commits.
6. Present the comparison and ask the user to choose. Call `hunsu.alternatives.select` or `hunsu.alternatives.reject` only with explicit confirmation.

Do not collapse alternatives into a single path before the decision is recorded. Never select on Coach authority alone.
