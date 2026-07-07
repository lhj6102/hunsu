# Architecture

Hunsu is split into Hunsu Web, Hunsu Local, Cloudflare Hub API, and Git-backed
protocol packages.

```text
Hunsu Web
  -> Hunsu Local
    -> Protocol package
    -> Core Git store
    -> Codex runner
      -> Route worktree
      -> Agent Conversation
    -> Artifact Action controller
      -> detached action worktree
      -> alias routing
      -> Action Run evidence
  -> Cloudflare Hub API
    -> D1 package catalog
    -> R2 immutable package manifests and files
```

## Hunsu Web

Hunsu Web owns the human workflow:

- `/studio` Roadmap launcher.
- `/studio` open and create flows.
- `/studio/roadmaps/:roadmapId` URL-addressed Roadmap View.
- `/hub` Executor Marketplace, Hunsu Marketplace, and Skills & Plugins catalog
  surface.
- route graph.
- selected MOVE inspector.
- Execute controls.
- Artifact Action controls.
- Action Run and E2E evidence review.
- Hunsu Draft conversation.
- HUNSU Draft request-file checks and confirmation.
- Skill Draft review.

The web app never writes Git directly. `/studio` calls Hunsu Local for local
runtime control. `/hub` calls the hosted Hub API Worker for Team, Member,
Manager, Skill, and Plugin requirement discovery.

The active Roadmap must be derived from the URL:

```text
/studio                         # launcher
/studio/open?path=<encoded-path> # open an existing Hunsu Roadmap
/studio/port?path=<encoded-path> # port a Git project into Hunsu
/studio/roadmaps/<roadmapId>     # selected Roadmap
```

React state may cache loaded projections, selected nodes, or panel state, but
it must not be the source of truth for which repository is open.

## Hunsu Local

Hunsu Local owns local orchestration:

- repository path resolution
- Roadmap Registry registration
- Hunsu Port planning and application
- Execute lifecycle
- worktree creation and cleanup
- Artifact Action lifecycle
- alias URL routing
- external E2E orchestration
- Agent Conversation references
- live event streams
- command validation
- HUNSU Draft confirmation
- Git-backed event writes

Local is the boundary that keeps the Team focused. The Team receives a
prepared worktree and a narrow objective. Recording outcomes remains a Local
responsibility.

Local is also the authority for mapping `roadmapId` to a canonical local
repository path. Browser routes should never have to parse raw filesystem paths
as nested SPA routes.

Local is the authority for mapping an Artifact Action alias to the concrete
runtime endpoint for a MOVE or commit. Browser routes and E2E tests should use
alias URLs, not host port numbers.

## Cloudflare Hub API

Cloudflare Hub API owns hosted reusable package storage:

- package catalog and publish APIs.
- immutable `/v1/packages/...` Origin endpoints.
- D1 metadata for packages, versions, lineage, jobs, and audit log.
- R2 blobs for immutable manifests and Skill/package files.
- future authentication and transport policies.

Local resolves committed `origin/key/version/integrity` locks through Origin
endpoints. Hub UX can help users create or publish those versions, but runtime
execution depends on the committed lock rather than ambient Hub state.

## Protocol Package

The protocol package owns the domain model:

- Roadmap
- Team
- Destination
- Harness
- Member
- Member Path
- Skill Snapshot
- Skill Draft
- MOVE
- Execute
- Arrived
- Accident
- Hunsu
- Agent Conversation
- Artifact Action definitions
- Action Run records
- Action evidence

Protocol functions should reject malformed snapshots and invalid Member
targets before events are written.

## Core Git Store

The core package owns Git mechanics:

- encoded Hunsu runtime state in commit trees
- board reconstruction from Git history and decoded state
- MOVE and Hunsu commit helpers
- branch and worktree helpers
- optional marker refs and rebuildable local indexes

Target durable Roadmap state lives in reachable Git commits. Each executable
commit contains product files plus app-owned encoded Hunsu runtime files under
`.hunsu/`. Given a commit SHA, decoding those files should always produce the
same Roadmap runtime state. Custom `refs/hunsu/*` may exist as migration markers
or accelerators, but they must not be required to reconstruct the Roadmap.

The mutable checkout is not the Roadmap database by itself. The authoritative
unit is a Git commit containing encoded Hunsu state. That state is owned by the
app, committed with the product snapshot, and decoded only by Hunsu runtime
code.

## Codex Runner

The Codex runner owns provider-specific execution:

- starting Codex threads
- resuming threads by id
- mirroring the current Hunsu runtime objective into provider goal state when
  supported
- streaming typed provider turn and item events
- building Team prompts
- building Member prompts
- mapping model, reasoning setting, and service tier
- passing the Team planning structured output schema

The runner does not own the Roadmap. It returns execution output and events to
Hunsu Local.

## Execute Flow

```text
select current MOVE
  -> resolve the open Destination queue head
  -> start Execute with exactly one selected Destination
  -> create worktree from selected MOVE commit
  -> decode the .hunsu/ runtime bundle from the source commit
  -> compute selected TODO and Harness bundle
  -> set provider goal when supported
  -> start Team planning conversation
  -> Team emits ExecutionPlan
  -> Hunsu engine validates the ExecutionPlan
  -> materialize .hunsu/current-execution.hunsu
  -> interpret QueueExecutionPlan and GoalExecutionPlan through Member Paths
  -> record Path commit and update Map<PathId | PrevMove, Commit>
  -> retry: give feedback to Team or Member Paths
  -> accepted: finalizer agent compares source MOVE to terminal Path commit
  -> accepted: create one MOVE N+1 commit with the finalizer commit message and updated .hunsu runtime bundle
  -> budget exhausted or crash: update encoded Hunsu state and record Accident MOVE commit
  -> cleanup or retain worktree for debugging
```

Execute itself is live operational state while running. When a MOVE completes, the
MOVE commit stores metadata-only previous execution state in
`.hunsu/previous-execution.hunsu`: Execute id, worktree hash, Agent session ids,
ExecutionPlan statuses, Path commits, terminal Path commit, and finalizer
session reference. Full transcripts remain provider/runtime data. Path commits
remain in the direct history before the MOVE commit so debugging can walk the
exact execution sequence.

The Route worktree is based on the selected MOVE position, not on whatever
branch the control checkout currently has checked out. For a normal route
position, the base is the previous MOVE's recorded commit. For a HUNSU-created
Team route, the base resolves through the cloned source MOVE position. MOVE 0
falls back to repository HEAD because it has no previous MOVE commit.

## Artifact Action Flow

```text
select MOVE or commit
  -> resolve source commit
  -> read .hunsu/artifact-actions.hunsu
  -> select configured action
  -> create detached action worktree scoped to source position
  -> inject Hunsu-controlled environment variables
  -> run host or check command
  -> map aliases to concrete service URLs for host actions
  -> collect status, logs, exit code, and configured evidence
  -> attach durable evidence to the MOVE or commit view when requested
  -> retain or stop operational Action Runs explicitly
```

Artifact Actions are derived operations against an immutable source artifact,
not scratch execution. Their purpose is to let the human inspect, check, export,
or produce evidence from the selected MOVE or commit without mutating it.

`host` actions are long-running and expose stable aliases such as `web`, `api`,
or `storybook`. `check` actions are finite commands such as E2E, lint,
typecheck, security scans, reports, or export generation. v1 actions run
independently; chained workflows are a later extension.

Concrete host ports are debug details. Studio and E2E should address Artifact
Action aliases. Durable action definitions are committed Hunsu state; Action
Runs are local operational state.

## Hunsu Port Flow

Hunsu Port is the explicit boundary between an arbitrary Git project and a
Hunsu Roadmap.

```text
select Git project
  -> inspect stack, package manager, scripts, env usage, and Docker files
  -> detect existing scripts, host/check surfaces, and env requirements
  -> propose Artifact Action definitions when useful
  -> detect hardcoded ports, hosts, and proxy targets
  -> propose env-injection edits when needed
  -> select initial goal, Destinations, Harness, and Skills
  -> create or update the encoded .hunsu/ runtime bundle
  -> record Initial Team state in the initial executable commit
  -> leave action setup as explicit Hunsu state
  -> register Roadmap and open /studio/roadmaps/<roadmapId>
```

Porting should be explicit and reviewable because it may add or change project
files. It should not be hidden behind a generic "open folder" action. Opening a
folder can inspect health, but Port is the operation that makes the repository
Hunsu-ready.

The target end state of Port is an Artifact Action-ready Roadmap:

- Git repository with encoded Hunsu runtime state in `.hunsu/`
- Initial Team and at least one Destination
- no implicit host/check actions by default
- later Hunsu transitions can add `.hunsu/artifact-actions.hunsu`
- runtime environment variables are declared on action definitions
- alias definitions such as `web`, `api`, or `storybook` are stable Studio/E2E
  contracts
- check actions can run E2E or report commands from the selected artifact

## Artifact Action Alias Routing

Artifact Action routes should hide host port allocation from users:

```text
/studio/roadmaps/<roadmapId>/moves/<moveId>/actions/<actionId>/<alias>/*
/studio/roadmaps/<roadmapId>/commits/<sha>/actions/<actionId>/<alias>/*
```

An alias such as `web`, `api`, `storybook`, or `admin` maps to the service URL
reported by a host action. Hunsu may allocate random host ports internally, but
Studio should present alias URLs as the product contract.

Path-based proxying can break apps that assume root-relative assets,
websocket paths, or base URLs. Hunsu may expose direct host URLs as debug
fallbacks, but alias routing remains the Studio-facing abstraction.

## Hunsu Flow

```text
select MOVE
  -> start Hunsu Draft
  -> Local creates a Draft Route worktree and AgentSession(owner=HunsuDraft)
  -> Local registers the source Harness snapshot in a content-addressed Draft artifact cache
  -> Local resolves the selected Manager lock or built-in default Manager
  -> Local records the Manager snapshot and optional lock in .hunsu/hunsu-draft.hunsu
  -> Local materializes only that Manager's Skills and Plugins in the Draft worktree
  -> Local decodes the source runtime into .hunsu-prev/*.json and .hunsu-request/*.json
  -> Studio displays a compact HunsuDraft Route node between the source MOVE and the future Hunsu fork
  -> Draft agent receives Manager instructions, Team Snapshot, editable request runtime files, and surrounding Roadmap context
  -> user and Draft agent discuss the desired route change
  -> Draft agent edits the relevant request runtime file; simple TODO changes use destinations.json only
  -> harness.json changes only for explicit root Team, Harness policy, guardrail, lock, or Artifact Action requests
  -> executors.json is the Team/Member source of truth and changes only for explicit Executor requests
  -> resources.json is the Skill/Plugin/resource-binding source of truth and changes only for explicit Resource requests
  -> Local composes harness.json, executors.json, and resources.json into the resolved Harness Snapshot and run prompt
  -> new Destinations do not create Executor or Resource bindings
  -> Draft agent runs Local's Draft check command and creates a DiffArtifact
  -> Draft agent includes the DiffArtifact marker in chat
  -> Studio renders the DiffArtifact card with changed files and Confirm Hunsu
  -> Studio renders all Draft progress from the shared AgentSession item stream, using Reasoning as the user-facing activity label
  -> user confirms the passing DiffArtifact
  -> the HunsuDraft Route node remains as a completed route log connected to the new Team MOVE
  -> protocol records the request Harness snapshot and changed runtime files
  -> protocol creates a new Team at the same MOVE count
  -> encoded .hunsu/* runtime files are regenerated from the confirmed state
```

Direct command/delta Hunsu mutation APIs are not part of the v1 Draft contract.
Route changes go through decoded request runtime files and the same check and
approval path.

Hunsu Draft Local APIs:

- `GET /api/roadmaps/:roadmapId/hunsu/drafts`
- `POST /api/roadmaps/:roadmapId/hunsu/drafts`
- `POST /api/roadmaps/:roadmapId/hunsu/drafts/:id/messages`
- `POST /api/roadmaps/:roadmapId/hunsu/drafts/:id/diff-artifacts`
- `GET /api/roadmaps/:roadmapId/hunsu/drafts/:id/diff-artifacts/:artifactId`
- `POST /api/roadmaps/:roadmapId/hunsu/drafts/:id/approve`
- `POST /api/roadmaps/:roadmapId/hunsu/drafts/:id/discard`

`/messages` is the primary interactive surface. The Draft agent may edit only
decoded runtime files under `.hunsu-request/` in the route worktree.
`/diff-artifacts` validates both runtime bundles, compares `.hunsu-prev` and
`.hunsu-request`, builds the ready Draft with changed files and the request
snapshot, and dry-runs `ConfirmHunsuDraft`. `/approve` requires a passing
DiffArtifact id and rejects it if the request files have changed since the
artifact was created.
Local still records meaningful Draft Route transitions in the route worktree's
`.hunsu/hunsu-draft.hunsu`. Only `/approve` writes `ConfirmHunsuDraft` to the
main Git-backed Roadmap runtime bundle. `/discard` and failed DiffArtifacts leave
HUNSU counts, forked Team routes, and MOVE counts unchanged while preserving
terminal Draft Route state.

AgentSession Local APIs:

- `GET /api/agent-sessions`
- `GET /api/roadmaps/:roadmapId/agent-sessions`

Local keeps a common in-memory `agentSessions` registry. Route runs and Hunsu
Draft sessions hold only AgentSession ids and active-session ids at their
boundary. AgentSessions use one Route reference shape with `routeId`, route
kind, source line/node, optional target node, and optional worktree. Plan, Path,
finalizer, Draft, and create turns differ by owner and Route kind, not by
separate route reference families. List endpoints may return bounded summaries,
while the Local registry remains the source for live AgentSession detail.

## Git Persistence Policy

Hunsu's target source of truth is the commit graph plus encoded Hunsu state in
each executable commit. A branch points at the current head of a route. The
commit itself carries enough encoded state for Hunsu to rebuild the Roadmap
projection.

Recommended route branches:

```text
refs/heads/hunsu/main
refs/heads/hunsu/routes/...
```

Route branches are unique per Route id and must never be force-moved to reuse
an old id. Hunsu Draft route branches record compact draft runtime state before
approval; confirmed Team route branches point at that route's latest
executable commit.

Custom refs are optional:

```text
refs/hunsu/moves/...
refs/hunsu/runs/...
refs/hunsu/interventions/...
```

They may speed up lookup or support migration from the current implementation,
but they are not authoritative. If all custom refs disappear, Hunsu must be able
to rebuild MOVE, HUNSU, run, Destination, and Harness indexes by walking
reachable commits and decoding the `.hunsu/` runtime bundle.

## Roadmap Registry

A globally installed Hunsu app needs a user-level Roadmap Registry. The
registry should store only local app metadata. A platform-specific user config
location is acceptable; for development it can be represented as a JSON file
under the user's config directory.

- Roadmap id
- display name
- canonical repository path
- last opened time
- last known branch
- simple status summary
- missing-path state

The registry is not the Roadmap source of truth. Selecting a Roadmap causes
Hunsu Local to read reachable route commits, decode `.hunsu` runtime files, and
reconstruct or refresh the local Roadmap projection cache.

Opening a folder should follow this flow:

```text
browser opens /studio/open?path=<encoded-path>
  -> Hunsu Local canonicalizes the path
  -> Hunsu Local verifies it is already a Hunsu Roadmap
  -> Hunsu Local registers or updates the Roadmap Registry entry
  -> browser redirects to /studio/roadmaps/<roadmapId>
  -> Roadmap View loads Roadmap projection from decoded commit state
```

Porting a Git project should follow a separate flow:

```text
browser opens /studio/port?path=<encoded-path>
  -> Hunsu Local canonicalizes the path
  -> Hunsu Local prepares a Port plan
  -> user reviews Roadmap state and optional Artifact Action changes
  -> Hunsu Local applies the Port plan
  -> Hunsu Local registers or updates the Roadmap Registry entry
  -> browser redirects to /studio/roadmaps/<roadmapId>
```

The registry may be deleted and rebuilt from user-selected folders. Deleting it
must not delete Roadmap history.

## Local HTTP Shape

Target local API:

```text
GET  /api/roadmaps/recent
POST /api/roadmaps/open
POST /api/roadmaps/create
POST /api/roadmaps/port/inspect
POST /api/roadmaps/port/apply
GET  /api/roadmaps/:roadmapId
GET  /api/roadmaps/:roadmapId/board
POST /api/roadmaps/:roadmapId/execute
POST /api/roadmaps/:roadmapId/hunsu
GET  /api/roadmaps/:roadmapId/artifact-actions
POST /api/roadmaps/:roadmapId/artifact-actions/:actionId/runs
GET  /api/roadmaps/:roadmapId/action-runs
GET  /api/roadmaps/:roadmapId/action-runs/:runId
POST /api/roadmaps/:roadmapId/action-runs/:runId/stop
```

`/api/roadmaps/open` accepts a filesystem path for an already-portable or
already-initialized Roadmap and returns a Roadmap id plus repository health.
`/api/roadmaps/port/inspect` returns a reviewable Port plan for a Git project.
`/api/roadmaps/port/apply` applies the plan and registers the new Roadmap.
`/api/roadmaps/:roadmapId/board` reconstructs the Roadmap from Git each time or
from a validated cache derived from decoded commit state.

## Existing Repository Port

Port should be explicit:

1. User selects an existing Git repository.
2. Hunsu Local inspects Git, scripts, environment usage, Docker files, and
   candidate Artifact Action surfaces.
3. Studio shows the Port plan.
4. User accepts the plan.
5. Port writes encoded `.hunsu` runtime files and initial Roadmap state.
6. Port does not create action definitions implicitly; later Hunsu transitions
   can add Artifact Actions.
7. Existing ordinary branches are left alone.
8. Future Hunsu work branches use the `hunsu/` branch namespace.

This makes Hunsu safe to introduce into real repositories while still making
the product execution contract first-class.
