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
  -> transport-agnostic event/state codec interface

packages/plugin-contract
  -> no application dependency

packages/protocol-registry
  -> packages/protocol
```

`packages/protocol` owns domain primitives, unions, commands, events, and versioned JSON codecs. It has no Node, browser, GitHub, filesystem, or network dependency.

`packages/core` owns pure command decisions, event application, replay, Runner graph validation, Run transitions, divergence invariants, and user-decision enforcement. It performs no I/O.

`packages/github-store` owns GitHub repository grants, refs, blobs, trees, commits, append-only event storage, compare-and-swap updates, Run branch creation and verification, and full reconstruction. It accepts domain behavior through a codec interface instead of importing application services.

`packages/projections` derives disposable Project, Goal, Runner, Run, Coach, evidence, and comparison query models from replayed state.

`packages/plugin-contract` owns strict MCP tool schemas, the immutable Run contract, OAuth-facing safe errors, confirmation metadata, and structured results.

`packages/protocol-registry` owns exact, integrity-checked definitions for Player and Team Runners, Coaches, Skills, and resources. It is a pure package: committed locks cannot be changed by environment variables or host state.

`packages/config` is the only source for service hosts, ports, public URLs, GitHub App configuration, and session configuration.

`apps/api` composes the packages. REST and MCP call one application service. It owns authentication, repository authorization, webhook verification, delivery deduplication, reconciliation, and projection caching.

`apps/web` owns React presentation and user interaction. It cannot import GitHub transports, core command handling, Node APIs, runtime worktrees, or secrets.

`plugins/hunsu` owns installation metadata and the guided Codex workflows. It calls MCP and never writes GitHub state directly.
