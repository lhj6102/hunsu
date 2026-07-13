---
name: hunsu-project
description: Open, create, update, or rebuild a GitHub-backed Hunsu Project. Use when a user wants to associate the active repository with Hunsu, inspect accessible Projects, change a Project objective or base ref, or recover a stale Project projection.
---

# Hunsu Project

1. Resolve the active GitHub repository and call `hunsu.projects.list` before creating anything.
2. If exactly one Project matches, open it with `hunsu.projects.get`. If several match, ask the user which one to use.
3. Before `hunsu.projects.create`, confirm the repository, base ref, title, and objective. Use a fresh idempotency key for the mutation.
4. Use `hunsu.projects.update` for intentional changes. Never edit `hunsu/state` or repository metadata directly.
5. On a stale-head conflict, reload the Project and explain what changed. Retry only after reconciling the user's intended mutation.
6. Use `hunsu.projects.rebuild` when the projection is missing or stale; GitHub remains authoritative.

Never request permanent GitHub credentials or store tokens in the repository.
