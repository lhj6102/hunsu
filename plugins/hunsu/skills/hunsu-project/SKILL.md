---
name: hunsu-project
description: Open, initialize, inspect, or rebuild a GitHub-backed Hunsu Commit Node Project. Use when a user wants to associate a repository with Hunsu v2, choose an existing Project, inspect its Node Graph or append-only Events, establish the first Node Plan, or recover a stale projection.
---

# Hunsu Project

1. Resolve the active GitHub repository and call `hunsu.projects.list`. Read its repository `state.status`, `state.expectedStateSource`, and full `state.expectedStateSha`. If one initialized Project matches, load it with `hunsu.projects.get`; if several match, ask which one to use.
2. Inspect lineage with `hunsu.nodes.graph`, one decoded Node with `hunsu.nodes.get`, and progress history with `hunsu.events.list` or `hunsu.events.get`.
3. Before `hunsu.projects.create`, verify the real full root commit SHA and prepare the complete initial Node Plan: every next Goal value and exactly one full Runner Value with its registered type lock.
4. Show the repository, root SHA, Goals, Runner name, type key, schema version, integrity, and exact expected state SHA. Obtain explicit confirmation in the current conversation, then pass `confirmedByUser: true` with a fresh idempotency key and exactly the latest `state.expectedStateSha`: the default-branch head when `hunsu/state` is absent, or the existing `hunsu/state` head when that branch exists.
5. On a stale-state conflict, reload and reconcile the intended bootstrap. Retry the same logical mutation with the same idempotency key only when its content is unchanged.
6. Use `hunsu.projects.rebuild` only to reconstruct disposable materializations from authoritative v2 Events. Show the Project and exact current `hunsu/state` SHA, obtain a separate explicit confirmation, then pass `confirmedByUser: true`, a fresh logical idempotency key, and that SHA as `expectedStateSha`. The rebuild is a normal CAS mutation and records one `ProjectMaterializationsRebuilt` audit Event; retry an unchanged lost-response rebuild with the same key.

An existing `hunsu/state` branch with no `.hunsu/v2` root is v2-uninitialized. Use its returned state-branch head as `expectedStateSha`; do not inspect, decode, convert, or migrate any v1 file.

Never edit `hunsu/state`, create source-tree `.hunsu` files, decode v1 state, request permanent GitHub credentials, or treat Goals and Runners as Project-level mutable entities.
