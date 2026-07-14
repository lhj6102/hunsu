# Workspace structure

Dependency direction is deliberate:

```text
apps/web
  -> presentation DTOs and browser APIs only

apps/api
  -> packages/config
  -> packages/core
  -> packages/github-store
  -> packages/plugin-contract
  -> packages/projections
  -> packages/protocol

packages/projections
  -> packages/protocol

packages/core
  -> packages/protocol

packages/github-store
  -> packages/protocol (Node payload envelope only)
  -> transport-agnostic event/state codec interface

packages/plugin-contract
  -> no application dependency

packages/protocol-registry
  -> packages/protocol
```

`packages/protocol` owns branded primitives, Goal and Runner values, Node variants, Run lifecycles, Coaching and decision commands/events, and strict versioned codecs. It has no Node, browser, GitHub, filesystem, or network dependency.

`packages/core` owns pure command decisions, event application, replay, Node single-parent validation, Run transitions, Coaching confirmation boundaries, sibling comparison invariants, and user-decision enforcement. It performs no I/O.

`packages/github-store` owns repository grants, refs, blobs, trees, commits, managed Node tags, encoded materializations, append-only v2 event storage, compare-and-swap updates, Run branch creation and verification, and full reconstruction. It imports only the protocol-owned Node payload envelope contract and accepts all domain behavior through a codec interface instead of importing application services.

`packages/projections` derives disposable Project context, Node Graph, Node detail, Events, Run, evidence, comparison, and decision query models from replayed state.

`packages/plugin-contract` owns strict MCP tool schemas, `RunContract v2`, OAuth-facing safe errors, confirmation metadata, and structured results.

`packages/protocol-registry` owns exact, integrity-checked Runner type definitions and executor contracts plus Coach, Skill, and resource definitions. Registered Runner types are extensible; state cannot inject executable code.

`packages/config` is the only source for service hosts, ports, public URLs, GitHub App configuration, and session configuration.

`apps/api` composes the packages. REST and MCP call one application service. It owns authentication, authorization, registry/executor resolution, webhook verification, delivery deduplication, reconciliation, and projection caching.

`apps/web` owns React presentation and user interaction. It cannot import GitHub transports, core command handling, Node APIs, runtime worktrees, or secrets.

`plugins/hunsu` owns installation metadata and guided Project, Node Run, Coaching, Events, and sibling-decision workflows. It calls MCP and never writes GitHub state directly.
