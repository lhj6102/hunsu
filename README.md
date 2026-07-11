# Hunsu: Creative Layer for Humans, Convergent Execution by Agents

> [!NOTE]
> **Why Hunsu?**
>
> Execution layers are becoming replaceable. Once a harness is legible enough
> for agents to understand, agents can help design, adapt, and run it
> themselves.
>
> Humans need a different surface: one for hypotheses, experiments, comparison,
> judgment, and deciding which possible future should continue.
>
> Most tools blur these layers. A plan with no unresolved decisions is
> convergent execution. Wondering how something should be built, what
> alternatives should be tested, and which path is worth preserving belongs to
> the divergent layer.
>
> Hunsu focuses on that layer: helping humans think divergently, then delegate
> convergent execution to agents.

As models get better at planning, editing, testing, and retrying, convergent
execution becomes less of a human bottleneck. The harder human work moves up:
questioning whether the destination is right, noticing when the route is wrong,
discarding a local optimum, and choosing which alternative vision should
continue.

Hunsu exists for that human layer.

## Public Alpha Quickstart

Prerequisites:

- Node.js 22.18 or newer
- Git
- Codex CLI installed and authenticated when you want to run agent Executes

Install or update the exact prerelease runtime:

```sh
npx @hunsu/bridge@next setup
npx @hunsu/bridge@next status
npx @hunsu/bridge@next open
```

Codex is an external prerequisite runtime. Hunsu does not bundle Codex, read
Codex credential files, store OpenAI API keys, or transmit Codex tokens. Bridge
checks Codex readiness through its provider adapter. Execute remains disabled
until the local Codex binary, app-server, and authentication are ready.

The operating system user service manager owns the production daemon. Client
commands connect to that daemon and never create a temporary fallback process.
Login is optional for local use; signing in enables outbound Remote Relay
access. Remote responses redact local paths unless an explicit Workspace grant
allows them.

For repository development:

```sh
corepack enable
pnpm install
pnpm dev:stack
```

The local stack uses an isolated temporary HUNSU_HOME, random ports, a
hunsu.localhost Web origin, deterministic provider and Relay fixtures, and a
same-origin development proxy. See
[Local Development](docs/local-development.md).

Hunsu Bridge must not be exposed directly to a public network. Remote access
uses authenticated outbound Relay commands rather than a public HTTP proxy.

## Open Source Model

Hunsu is intended to be local-first open source:

- Hunsu Web can be deployed as a public website.
- Hunsu Bridge, CLI, protocol, registry, runner boundary, and Git-backed runtime
  code are inspectable and Apache-2.0 licensed.
- Hunsu Hub can host public reusable Team, Member, Manager, and Skill package
  metadata, while Bridge keeps repository and worktree access on the user's
  machine.

It is not a harness whose main purpose is to make agents execute harder. It is
a Roadmap for goals, routes, snapshots, and alternatives. A Team can run
through Destinations in an isolated worktree, while the user observes the route
and gives Hunsu when the goal, Destination set, Harness, runtime
result, or Execution Instructions should change.

The result is closer to navigation than task management: the agent executes, the
Inspector checks, and the human can challenge the destination, fork the route,
or stop preserving the wrong path as the default future.

## Product Loop

The product loop is:

```text
Create Roadmap
  -> MOVE 0 with immutable Team Snapshot
  -> Execute in an isolated worktree
  -> Inspector evaluates the Execute and gives retry guidance
  -> MOVE Arrived or MOVE Accident with immutable Team Snapshot
  -> Artifact Actions for the MOVE or commit
  -> external E2E/check evidence and human inspection
  -> Hunsu from any MOVE
  -> Hunsu Manager conversation and HUNSU Draft
  -> new Team at the same MOVE count
```

The visible graph is a route map. Recorded MOVEs are immutable positions on a
Team route. Active Executes appear as operational overlays between positions.
Hunsu edges are dashed route forks that create a new Team at the same MOVE
count without rewriting the source route.

At the runtime layer, Hunsu treats a Git commit as an executable state. The
commit contains the product snapshot plus encoded app-owned Hunsu state. Hunsu
decodes that state, computes the current TODO and Harness bundle, runs the
Team, updates the encoded state, and records the next commit.

## Product Shape

Hunsu has four product-facing layers:

```text
Hunsu Web
  - `/studio` launcher for recent Roadmaps, Port Git Project, and Create Roadmap
  - `/studio/open?path=...` folder handoff for existing Hunsu Roadmaps
  - `/studio/port?path=...` Git project port flow into an Artifact Action-ready Roadmap
  - `/studio/roadmaps/:roadmapId` Roadmap workspace
  - `/hub` Team, Member, and Skills & Plugins library surface
  - live Execute monitoring
  - MOVE graph and detail views
  - MOVE and commit Artifact Action views
  - E2E evidence review and result comparison
  - Hunsu Manager conversation and HUNSU Draft approval
  - Skill Draft review before accepted Skill Snapshots become history
  - Agent Conversation views for live-listen, transcript replay, and debugging

Hunsu Bridge
  - owns Git access
  - runs as one daemon owned by the OS user service manager
  - owns Roadmap Registry path resolution
  - owns Codex runner integration
  - owns Agent Conversation storage
  - owns HUNSU Draft confirmation
  - owns Artifact Action Run lifecycle and alias routing
  - exposes local HTTP and stream APIs to Hunsu Web

Hunsu Hub API
  - owns reusable Team, Member, and Skills & Plugins storage
  - exposes Hub backend APIs for publish and management flows
  - serves immutable Origin endpoints for runtime harness resolution

Hunsu CLI and core
  - Git-backed executable runtime state
  - MOVE and Hunsu ledger reconstruction
  - Roadmap reconstruction
  - immutable Team Snapshot reconstruction
  - Preview manifest parsing and command contract
  - stable command contract for Studio, Inspector, Director, and recovery tools
  - advanced `npx @hunsu/bridge@next` launcher fallback during the prerelease
```

Hunsu Web is the human-facing orchestration surface. Hunsu Bridge is the
privileged localhost runtime. Hunsu Hub API is the remote or self-hosted
Team, Member, and Skills & Plugins repository. The CLI is the harness surface.
The core package is implementation detail.

## Current State

The repository contains a `pnpm` and `turbo` TypeScript workspace:

- `packages/core` reconstructs Roadmap state from Git history. The target model
  is encoded `.hunsu/state.hunsu` in executable commits, with Hunsu-owned refs
  retained only as migration markers or optional lookup accelerators.
- `packages/cli` exposes early command surfaces for board inspection, request
  creation, movement recording, route steering, and harness changes.
- `packages/protocol` models Roadmaps, Teams, Destinations, Harnesses,
  MOVEs, Hunsus, immutable Team Snapshots, durable events, and projections.
- `packages/protocol-registry` defines Team, Member, and Skill manifests,
  schema-specific integrity, prompt template rendering, skill descriptors, and
  Origin HTTP resolution.
- `packages/codex-runner` owns the Codex app-server runner boundary for focused
  Execute execution, Inspector evaluation, prompt construction, model settings,
  reasoning settings, service-tier mapping, provider status, and streamed event
  mapping.
- `apps/bridge` exposes the local command/event/projection control plane with
  Roadmap Registry routing, repository selection, Execute lifecycle, live
  updates, artifact lookup, worktree visibility, Codex integration, and Artifact
  Action control.
- `apps/web` provides the React Hunsu Web surface with `/studio` for Roadmap
  execution and `/hub` for Team, Member, and Skills & Plugins work.
- `apps/hub-api` exposes the Cloudflare Worker Hub API and serves immutable
  Origin endpoints for package manifest resolution.
- Tests cover trailer parsing, Roadmap reconstruction, Git-backed move
  creation, Hunsu commits, CLI behavior, harness invariants, runner prompts,
  runner event mapping, and Bridge runtime control.

## Artifact Actions Direction

Hunsu's official derived-work surface is Artifact Actions. A committed MOVE or
commit is the immutable source artifact, and configured actions describe the
extra work Hunsu can run from that source: hosting, checks, E2E, reports,
exports, or deploy candidates.

Artifact Action definitions are durable Hunsu state in
`.hunsu/artifact-actions.hunsu`. Action Runs are local operational state in
`.hunsu/action-runs`; they execute from detached worktrees and do not mutate the
source artifact.

Host actions cover the old human-inspectable running product use case. Check
actions cover finite commands such as E2E, lint, typecheck, scans, reports, and
exports.

See [Artifact Actions](docs/artifact-actions.md) for the product model.

## Hunsu Port Direction

Opening a Git repository is not the same as making it a Hunsu Roadmap. Hunsu
Port is the explicit migration step for existing projects. It inspects the
repository, prepares a reviewable plan, and writes Hunsu-owned Roadmap refs.

Create Roadmap should produce the same action-ready end state for new
projects. Open Roadmap should reopen repositories that have already been ported
or created.

## Runtime Controls

Bridge and Web ports and proxy targets are controlled from outside the process through
environment variables. This keeps local development, Artifact Action hosts, and
MOVE-scoped checks from depending on hardcoded ports.

- `HUNSU_BRIDGE_HOST` sets the Bridge bind host. Default: `127.0.0.1`.
- `HUNSU_BRIDGE_PORT` sets the Bridge server port. Default: `19687`.
- `HUNSU_WEB_HOST` sets the Vite web bind host. Default: `127.0.0.1`.
- `HUNSU_WEB_PORT` sets the Vite web port. Default: `19688`.
- `HUNSU_WEB_URL` sets the Studio URL used by Hunsu Bridge when `--web-url` is
  omitted. Default: `https://hunsu.app/studio`.
- `HUNSU_WEB_STRICT_PORT` controls whether Vite may auto-increment when the
  requested port is busy. Default: `true`.
- `HUNSU_BRIDGE_API_PROXY_TARGET` sets the Vite `/api` proxy target. Default:
  `http://<HUNSU_BRIDGE_HOST>:<HUNSU_BRIDGE_PORT>`.
- `HUNSU_BRIDGE_ALLOWED_ORIGINS` adds comma-separated browser Origins allowed to
  call protected Hunsu Bridge APIs when using a deployed Studio website.
- `VITE_HUNSU_BRIDGE_URL` can point the browser directly at Hunsu Bridge instead
  of relying on same-origin `/api` proxying.
- `HUNSU_HUB_PUBLIC_API_URL` and `VITE_HUNSU_HUB_API_URL` point `/hub` at the
  Cloudflare Hub API Worker.
- `HUNSU_HUB_WORKER_NAME`, `HUNSU_HUB_ORIGIN_NAME`,
  `HUNSU_HUB_D1_DATABASE_NAME`, `HUNSU_HUB_D1_DATABASE_ID`,
  `HUNSU_HUB_R2_BUCKET_NAME`, and `HUNSU_HUB_PUBLISH_QUEUE_NAME` configure Hub
  API deploy and local Worker development.
- `HUNSU_AGENT_PREVIEW_PORT` reserves the default Preview debug fallback port:
  `19673`.
- `HUNSU_HOME` overrides the Bridge state root. Provider, Workspace,
  credential, runtime identity, logs, and stable runtime versions live beneath
  that one root.
- `HUNSU_CODEX_BINARY_PATH`, `HUNSU_CODEX_APP_SERVER_COMMAND`,
  `HUNSU_CODEX_APP_SERVER_ARGS`, and
  `HUNSU_CODEX_*` thread option variables are resolved by `@hunsu/config`
  before Bridge constructs the Codex runner.

Troubleshooting:

- Bridge not running: run `hunsu-bridge service start`.
- Codex CLI not found: install Codex or run
  `hunsu-bridge provider set codex --binary <path>`.
- Codex login required or expired: run `hunsu-bridge provider check codex` and
  complete the provider's supported login flow.
- Codex app-server unavailable: run `hunsu-bridge provider check codex` and verify
  `codex app-server --stdio` works in your shell.
- Codex rate limited: wait for Codex access to recover; Hunsu shows only safe
  rate-limit summaries when Codex provides them.
- Workspace missing: inspect or remove it with `hunsu-bridge workspace`
  commands. Hunsu Web shows only registered, healthy Workspaces.
- Project Grant missing: grant the project path before Remote Access Execute or
  Artifact Action commands.

## Docs

- [Vision](docs/vision.md): product intent for Roadmap, Team, and Hunsu
  orchestration.
- [Ubiquitous Language](docs/ubiquitous-language.md): canonical domain terms
  and retired vocabulary.
- [Architecture](docs/architecture.md): system boundaries across Hunsu Web,
  Hunsu Bridge, Hub API, CLI, core, runner, Git, and event storage.
- [Headless Bridge](docs/architecture/headless-bridge.md): daemon ownership,
  process boundaries, state, and compatibility adapter.
- [Control API](docs/architecture/control-api.md): authenticated local CLI
  control routes and health contract.
- [Bridge CLI](docs/cli.md): stable JSON results and command behavior.
- [Service Management](docs/service-management.md): user-service adapters,
  exact runtime paths, setup, and lifecycle.
- [Local Development](docs/local-development.md): isolated stack, random ports,
  deterministic fixtures, and browser modes.
- [Web Pairing](docs/web-pairing.md): browser credential separation and
  compatibility behavior.
- [Remote Bridge](docs/remote-bridge.md): outbound Relay, login, grants, and
  path redaction.
- [Bridge Releases](docs/releasing-bridge.md): protected OIDC publication,
  provenance, exact tags, and stable-promotion gates.
- [Workspace Structure](docs/workspace-structure.md): pnpm workspace, Turbo
  tasks, package roles, dependencies, and test layout.
- [Executable Runtime State](docs/executable-runtime-state.md): Git commit as
  the runtime input, encoded Hunsu state, lazy cache, and provider goal model.
- [Hub, Origin, And Harness Registry](docs/harness-registry.md):
  reusable Team, Member, and Skill manifests, resource descriptors, and
  integrity locking.
- [Domain Model](docs/domain-model.md): DMMF-style entities, events,
  invariants, and projections.
- [Studio](docs/studio-gui.md): Studio launcher, URL-addressed Roadmap View,
  graph behavior, and detail panels.
- [Artifact Actions](docs/artifact-actions.md): durable action definitions,
  local Action Runs, aliases, environment, and evidence model.
- [Codex Runner](docs/codex-runner.md): Team and Inspector runner contract.
- [CLI Contract](docs/cli-contract.md): command surface for mutation and
  recovery.
- [Roadmap](docs/roadmap.md): phased product direction.

Older planning and research notes are still kept where useful, but the files
above describe the current product direction. This root README is the source of
truth for the published docs index.

Markdown documents should use the current product language: Hunsu, Studio, Hub,
Bridge, Origin, Roadmap, Team, Director, Destination, Harness, Execute,
Inspector, Arrived, Accident, Team Snapshot, Studio Launcher, Roadmap
Registry, Roadmap View, Artifact Actions, Action Runs, Action Alias,
Action Evidence, Executable Runtime State, Provider Goal, Harness
Registry, and Workspace Structure.

Do not reintroduce retired execution, combat, or checklist vocabulary in product
docs. If code compatibility needs to mention an older implementation name, keep
it in code comments or migration notes outside the published docs.

## Development Checks

```bash
pnpm run check:no-desktop-prototype
pnpm run check
pnpm run build
pnpm run test:e2e:stack
pnpm run test:package:bridge
```
