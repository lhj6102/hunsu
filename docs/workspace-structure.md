# Workspace Structure

Hunsu is a `pnpm` workspace coordinated by Turbo. The workspace is split
into product apps under `apps/*`, reusable implementation packages under
`packages/*`, and root-level integration tests under `tests/*`.

## Workspace Boundary

`pnpm-workspace.yaml` includes exactly:

```yaml
packages:
  - apps/*
  - packages/*
```

The root package is private and provides orchestration commands:

- `pnpm run dev`: runs Turbo `dev` across workspace packages in parallel.
- `pnpm run build`: runs Turbo `build`.
- `pnpm run typecheck`: runs one root TypeScript check over apps, packages, and
  tests.
- `pnpm test`: runs `node --test tests/*.test.ts`.
- `pnpm run check`: runs root typecheck and root tests.
- `pnpm hunsu`: runs the CLI package through `pnpm --filter hunsu hunsu`.

The root TypeScript config is the broadest contract. It includes:

```text
apps/**/*.ts
apps/**/*.tsx
packages/**/*.ts
tests/**/*.ts
```

Package `typecheck` and app `build` scripts are narrower local checks, usually
`tsc -p tsconfig.json --noEmit` or a frontend production build.

## Turbo Tasks

`turbo.json` defines four tasks:

- `build`: depends on `^build`, so dependency packages build before dependents.
- `typecheck`: depends on `^typecheck`, so package typechecks follow dependency
  order.
- `test`: depends on `^test`, but most tests currently live at the root instead
  of package-local test scripts.
- `dev`: persistent, uncached, and intended for long-running local servers.

Only packages with a matching script participate in a given Turbo task. For
example, `@hunsu/web` has a Vite `build`, while `@hunsu/protocol` only has
`typecheck`.

## Layer Map

The dependency direction is intentionally inward:

```text
apps/web
  -> packages/config
  -> packages/protocol

apps/bridge
  -> packages/config
  -> packages/core
  -> packages/protocol
  -> packages/protocol-registry
  -> packages/codex-runner

apps/hub-api
  -> packages/protocol-registry

packages/cli (`hunsu`)
  -> apps/bridge (`@hunsu/bridge`)
  -> packages/config
  -> packages/core
  -> packages/protocol

packages/core
  -> packages/protocol

packages/protocol-registry
  -> packages/protocol

packages/codex-runner
  -> packages/protocol
  -> @openai/codex

packages/config
  -> no workspace dependencies

packages/protocol
  -> no workspace dependencies
```

`packages/protocol` is the foundation. Runtime, registry, runner, CLI, Bridge,
and Web can depend on it. It should not depend on application or
runtime infrastructure.

## Apps

### `apps/web`

React and Vite frontend for Hunsu Web.

Responsibilities:

- `/studio` route for Studio Launcher and Roadmap View.
- `/studio/roadmaps/:roadmapId` route for Roadmap graph, Team controls, MOVE
  detail, diff inspection, and HUNSU Draft review.
- `/hub` route for Executor Marketplace, Hunsu Marketplace, and Skills &
  Plugins catalog work.
- Browser-side presentation of protocol model data.

Dependencies:

- `@hunsu/config` for app-boundary environment and runtime configuration.
- `@hunsu/protocol` for shared domain types.
- React, React DOM, Vite, and Vite React plugin.

It does not own Git access, Codex execution, or Hunsu runtime mutation. Those
belong to Hunsu Bridge.

### `apps/bridge`

Bridge runtime and server for Hunsu.

Responsibilities:

- Repository selection and Roadmap reconstruction.
- Git-backed command execution and encoded Hunsu runtime state persistence.
- Execute lifecycle, worktree creation, live events, artifact lookup, and diff
  inspection.
- Codex runner boundary.
- Origin resolution before Execute execution.

Dependencies:

- `@hunsu/config` for app-boundary environment and runtime configuration.
- `@hunsu/core` for Git-backed runtime state and Artifact Action/runtime helpers.
- `@hunsu/protocol` for commands, events, projections, and domain validation.
- `@hunsu/protocol-registry` for Team, Member, Manager, and Skill manifest
  resolution, integrity verification, prompt template rendering, and skill
  hydration.
- `@hunsu/codex-runner` for app-server-backed Team planning and Member Path
  execution.

### `apps/hub-api`

Cloudflare Worker Hub API and Origin endpoint.

Responsibilities:

- Serve package catalog and publish APIs.
- Expose immutable `/v1/packages/...` Origin endpoints.
- Use D1 for package metadata, versions, jobs, lineage, and audit log.
- Use R2 for immutable manifests and package files.
- Generate ignored Wrangler config from `@hunsu/config/cloudflare` for Worker
  dev, deploy, and D1 migrations.

Dependencies:

- `@hunsu/config` for Cloudflare deployment and Worker runtime environment
  contracts.
- `@hunsu/protocol-registry` for manifest validation, integrity, and summaries.

Default command:

```sh
pnpm --filter @hunsu/hub-api dev
```

Production deploy uses `wrangler deploy` and D1 migrations through the package
scripts or CI. Scripts must invoke Wrangler with
`apps/hub-api/.wrangler/generated.toml`, which is derived from environment
variables and never committed.

## Packages

### `packages/protocol`

Pure domain model package.

Responsibilities:

- Roadmap entities, commands, events, projections, and validation.
- Harness snapshots and Member configs.
- HunsuOrigin and HubPackageLock data shapes.
- Destination, MOVE, HUNSU, Team Snapshot, and Board Projection invariants.

It has no workspace dependencies and should remain infrastructure-free.

### `packages/core`

Git-backed runtime state package.

Responsibilities:

- Encode and decode Hunsu runtime files.
- Load Roadmap state from worktree, commits, legacy state, or migration refs.
- Write accepted domain events into app-owned runtime files.
- Commit runtime state when requested.
- Preview runtime and Git utility boundaries.

Dependency:

- `@hunsu/protocol`.

### `packages/protocol-registry`

Hub package manifest and Origin resolver package.

Responsibilities:

- Team, Member, Manager, and Skill manifest schema validation.
- Canonicalization and integrity calculation.
- HTTP Origin resolver.
- Prompt-template-aware Team, Member, Manager, and Skill metadata validation.

Dependency:

- `@hunsu/protocol`.

This package is a registry/resolver boundary. It is not the Roadmap runtime
state and does not decide which Destination should use which Harness.

### `packages/codex-runner`

Codex app-server runner boundary.

Responsibilities:

- Build Team planning and Member Path prompts from active runtime input.
- Start, resume, pause, and stop Codex app-server runs.
- Map app-server events into Studio-friendly runner events.
- Render Harness Team and Member prompt templates from active
  Destination and Path context.
- Return Member outputs while leaving Path commit creation to the local Hunsu
  engine.

Dependencies:

- `@hunsu/protocol`.
- `@openai/codex`.

### `packages/config`

App-boundary configuration package.

Responsibilities:

- Parse and validate environment variables into explicit `ConfigResult`
  values.
- Own Bridge, Web, Hub, Cloudflare deploy, Artifact Action, and Codex runner
  environment contracts.
- Keep lower-level packages from reading ambient process environment.
- Provide a Worker-safe `@hunsu/config/cloudflare` entrypoint with no Node
  filesystem or OS imports.

Dependency:

- No workspace dependencies.

### `packages/cli`

Repository command-line interface package.

Responsibilities:

- Expose early Hunsu commands for Roadmap inspection and mutation.
- Bridge CLI input into core/protocol commands.
- Provide the root `pnpm hunsu` entrypoint and npm `npx @hunsu/bridge@latest`
  launcher.
- Start Hunsu Bridge with a pairing token and hand the browser to Hunsu Web.

Dependencies:

- `@hunsu/core`.
- `@hunsu/config`.
- `@hunsu/bridge`.
- `@hunsu/protocol`.

## Runtime Relationship

Hub, Origin, Bridge, and the Hunsu runtime are separate layers.

Hub is the web UX for discovering, editing, forking, and publishing reusable
Team, Member, Manager, and Skill packages. `apps/hub-api` is the stateless
Cloudflare Worker backend for that UX. D1 and R2 are the stateful Hub resources.
Origin is the immutable endpoint role served by the Worker. Bridge is the
privileged localhost runtime.

During Execute, the Hunsu runtime decodes a Roadmap commit, selects the active
Destinations and their Team/Member/Skill package locks, resolves only the
required Origin references, builds the Member execution environment, runs the
Team, and records the next commit. During Hunsu Draft, Bridge resolves the
selected Manager lock or built-in default Manager, records the Manager snapshot
in the Draft route runtime, materializes only that Manager's Skills/Plugins in
the Draft worktree, and asks Codex to run the draft turn. Roadmap state stores
only minimal Origin reference metadata so old package catalogs, unrelated
versions, and historical context do not leak into agent prompts.

## Test Layout

Tests live in root `tests/*.test.ts` and run with Node's built-in test runner.

The root tests intentionally exercise package boundaries together:

- `protocol.test.ts`: domain commands, events, projections, and invariants.
- `protocol-registry.test.ts`: Hub package integrity, Origin resolution,
  Manager manifests, prompt templates, and skill hydration.
- `codex-runner.test.ts`: Team planning and Member Path prompt construction
  plus Codex app-server runner behavior.
- `local.test.ts`: Bridge control plane, Git persistence, Execute
  lifecycle, Origin package resolution, and runtime safety.
- `web.test.ts`: frontend request builders and planned UI behavior.
- `git-cli.test.ts`: CLI and Git-backed command behavior.
- `port.test.ts` and `artifact-actions.test.ts`: Roadmap porting and Artifact
  Action behavior.

Because tests import source files directly, root `pnpm run check` is the most
reliable full verification command.

## Change Guidelines

- Put pure domain rules in `packages/protocol`.
- Put Git-backed runtime encoding, loading, and persistence in `packages/core`.
- Put package registry, Origin resolution, manifest integrity, prompt
  templates, and skill materialization in `packages/protocol-registry`.
- Put Codex app-server integration in `packages/codex-runner`.
- Put local orchestration, Git access, Codex integration, and Artifact Action
  Run control in `apps/bridge`.
- Put browser UI routes in `apps/web`.
- Put Cloudflare Worker Hub API and Origin endpoint request handling in
  `apps/hub-api`.
- Avoid dependencies from lower layers back into apps or runner-specific code.
