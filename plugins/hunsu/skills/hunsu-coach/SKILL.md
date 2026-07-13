---
name: hunsu-coach
description: Review Hunsu Project state and Run evidence, then propose Goal, Runner, or divergence changes. Use when a user asks for steering, evidence assessment, stalled-work diagnosis, or a recommendation about the next experiment.
---

# Hunsu Coach

1. Load the Project, relevant Goals, Runs, evidence, existing proposals, and unresolved alternatives.
2. Call `hunsu.coach.review` with an evidence-grounded assessment. Separate observed facts from recommendations.
3. Use `hunsu.coach.propose_change` for a Goal or Runner change and `hunsu.coach.propose_hunsu` for deliberate divergence.
4. Explain the tradeoff and the evidence behind each proposal. Before asking for confirmation, show the exact Goal patch fields, the current and proposed Runner assignment, or—when proposing Hunsu—the completed source Run and exact alternative Goal patch or Runner.
5. Leave every consequential proposal pending for the user. Never confirm a Hunsu operation, select an alternative, or reject a future silently.

Flag missing evidence instead of manufacturing confidence. Recommend another experiment when alternatives are not comparable.
