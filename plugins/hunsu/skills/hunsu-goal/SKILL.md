---
name: hunsu-goal
description: Create, inspect, refine, pause, or complete outcome-oriented Hunsu Goals. Use when a user wants to turn a product outcome into acceptance criteria and constraints, assign a Runner, or update Goal lifecycle state.
---

# Hunsu Goal

1. Load the Project with `hunsu.projects.get` and existing Goals with `hunsu.goals.list`.
2. Express the Goal as a desired outcome, not an implementation task. Capture measurable acceptance criteria and explicit constraints.
3. Ask only for missing choices that materially change the outcome. Then call `hunsu.goals.create` with a fresh idempotency key.
4. Use `hunsu.goals.update` to refine intent or assign a Runner. Preserve criteria that still apply.
5. Pause with `hunsu.goals.pause` when work should stop without discarding evidence.
6. Complete with `hunsu.goals.complete` only when the recorded Run evidence supports every acceptance criterion.

On stale state, reload before proposing a retry. Never treat a Goal as a granular checklist item.
