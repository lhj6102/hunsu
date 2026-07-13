# AGENTS.md

This file routes contributors to the current source-of-truth documents.

## Domain, model, protocol, and workflow code

Read [Domain language](docs/domain-language.md) and [DMMF rules](docs/dmmf-refactoring-spec.md).

Prefer explicit domain variants and `Result` boundaries. Do not add aliases, permissive decoders, or optional-field lifecycle states.

## Package boundaries and dependencies

Read [Workspace structure](docs/workspace-structure.md).

Keep GitHub access, HTTP, authentication, MCP, runtime interaction, and repository worktrees outside `apps/web`, `packages/protocol`, and `packages/core`.

## GitHub state, Runs, and reconstruction

Read [GitHub-backed architecture](docs/architecture/github-backed-projects.md) and [Codex plugin architecture](docs/architecture/codex-plugin.md).

Do not inspect or edit `.hunsu/state.hunsu`. Never bypass the event append, idempotency, compare-and-swap, branch-verification, or explicit-confirmation boundaries.

## Service configuration

Use `@hunsu/config`. Pass environment values through its `Result`-based resolvers and never hard-code service ports or secrets in application code.
