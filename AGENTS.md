# AGENTS.md

This file routes agents to docs they are likely to miss. Do not duplicate those
docs here.

## Routing Guidance

### Domain, Model, Protocol, Workflow, Or Runtime Code

Read [DMMF Refactoring Spec](docs/dmmf-refactoring-spec.md).

Prefer explicit domain types and Result boundaries. Do not add compatibility
shims or optional-field lifecycle states by habit.

### Package Boundaries Or Workspace Dependencies

Read [Workspace Structure](docs/workspace-structure.md).

Keep Git, Codex, runtime orchestration, and worktrees out of `apps/web`. Do not
pull app/runtime dependencies into lower-level packages.

### `.hunsu`, Execute Worktrees, Provider Goals, Or Runtime Persistence

Read [Executable Runtime State](docs/executable-runtime-state.md) and
[Codex Runner](docs/codex-runner.md).

Do not inspect or edit `.hunsu/state.hunsu`. Execute worktrees start from the
selected MOVE position.

### Artifact Actions, Action Runs, Host/Check Behavior, Or Old Preview Behavior

Read [Artifact Actions](docs/artifact-actions.md).

Use Artifact Action aliases as the Studio/E2E contract. Concrete host ports and
unmanaged dev servers are debug fallbacks only.

### Origin, Harness Registry, Or Skill Package Resolution

Read [Hub, Origin, And Package Registry](docs/harness-registry.md).

Environment variables must not silently change committed
origin/key/version/integrity locks.

### Hunsu Service Ports

Use `@hunsu/config`.

Use the monadic environment-variable pass pipeline. Do not hard-code service
ports in app code.
