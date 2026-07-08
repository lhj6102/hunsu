# Studio

Studio is the human-facing Hunsu application.

Its job is to let the user manage Roadmaps, watch Teams travel through
Destinations, inspect MOVEs, run Artifact Actions against committed results,
and give Hunsu without taking over the Team's conversation.

## Navigation Model

Studio should behave like a local app with a launcher and URL-addressed Roadmap
views.

Canonical routes:

```text
/studio                         # Launcher
/studio/open?path=<encoded-path> # open or inspect an existing Roadmap folder
/studio/port?path=<encoded-path> # port an existing Git project into Hunsu
/studio/roadmaps/<roadmapId>     # Roadmap workspace
```

The URL, not React-only internal state, identifies the active Roadmap. Refresh,
copying a link, opening a second browser window, or reconnecting through a
remote tunnel should all preserve the selected Roadmap.

## Bridge Connection UI

Studio always shows Bridge connection state at the bottom of the left
navigation. The card is visible in expanded and collapsed navigation states and
opens Connection Center when clicked.

Required visible states include:

- Local Bridge · Connected
- Local Bridge · Pairing needed
- Bridge not connected
- Remote Bridge · Connected
- Remote Bridge · Reconnecting
- Session expired
- Project access needed
- Bridge update needed
- Bridge error

Connection Center explains missing app install, Bridge not running, missing
pairing token, wrong allowed origin, old Bridge version, missing Project Grant,
Remote Bridge offline, Relay unavailable, and Web/Bridge account mismatch.
The primary recovery action is opening Hunsu Bridge App. Download and advanced
CLI paths remain available as secondary actions.

When a paired local Bridge exposes Relay registry data, Connection Center also
lists available Remote Bridges with online/offline state so the same panel can
represent both local direct and Remote Relay modes.

## Launcher

The launcher is the default `/studio` page.

It should feel closer to a VS Code start page than to a Roadmap workspace.

Launcher responsibilities:

- active Roadmap list from the local Bridge Roadmap Registry
- open active Roadmaps
- send Add Roadmap to Bridge App through `hunsu://add-roadmap`
- show an empty state when no active Roadmaps are exposed by Bridge
- keep manual path entry as an Advanced fallback

The launcher can display many active Roadmaps. It does not show inactive
Roadmaps by default and does not show the MOVE graph. Add, activate,
deactivate, repair, and remove are Bridge App responsibilities.

## Roadmap View Shell

`/studio/roadmaps/<roadmapId>` is the focused workspace for one Roadmap.

Roadmap shell:

- Figma-like central canvas for the MOVE graph
- left panel for current Roadmap information, not a global Roadmap browser
- right panel for selected MOVE, selected Route, selected Execute, or Team
  Snapshot detail
- Artifact Actions panel for MOVE and commit results
- centered floating toolbar for current Team, snapshot status, filters, and
  view controls
- URL query parameters for selected MOVE, selected Execute, selected Route, and
  active panel

The left panel should describe the current Roadmap:

- title
- repository path
- current Team
- current MOVE
- active Execute summary
- latest Action Run summary
- recent Hunsus
- snapshot/ref health
- local registry health

Roadmap switching should happen through the launcher or an explicit Roadmap
switcher. The main Roadmap View should not rely on a permanently visible global
Roadmap browser.

## Route Nodes

The graph is rendered as `MOVE -> Route -> MOVE`.

Route node kinds:

- `Plan`: the Team planning AgentSession, rendered as a compact Route node and
  inspected read-only.
- `Path`: a Member ExecutionPlan AgentSession, rendered as a compact Route node
  and inspected read-only.
- `HunsuDraft`: an interactive AgentSession rendered with the same compact
  circular mini-node language as `Plan`, between the source MOVE and the Hunsu
  fork target.

Selecting a Route opens a Route inspector. Plan and Path inspectors show
AgentSessionRead only. Hunsu Draft inspectors show AgentSessionRead plus
AgentSessionChat. Move inspectors may start a Hunsu Draft or open an existing
Draft Route, but they do not host the Draft chat.

## Roadmap Onboarding

Studio needs three entry paths:

1. Open an existing Hunsu Roadmap.
2. Port an existing Git project into Hunsu.
3. Create a new managed Roadmap in a new folder.

Opening a Roadmap should be a reopen operation. It resolves a canonical path,
loads the Roadmap Registry entry, verifies encoded Hunsu runtime state, and
redirects to `/studio/roadmaps/<roadmapId>`.

Porting an existing Git project is the explicit migration operation. It scans
the repository, writes the `.hunsu/` runtime bundle with Initial Team state,
and then registers the Roadmap. Artifact Action definitions are proposed as
reviewable Hunsu work, not silently created by the default Port apply path.
Future route and work branches should use the `hunsu/` branch namespace.

Open Git Project is not a synonym for Roadmap creation. A project becomes a
Hunsu Roadmap after Port or Create has produced durable Roadmap state. Artifact
Action setup is an explicit Hunsu choice.

## Create Roadmap

Create Roadmap collects:

- title
- goal
- initial Destinations
- initial Harness
- Team orchestration prompt
- Member roster
- Member prompts and instructions
- model settings
- reasoning settings
- service tier
- Skills
- budget
- product template or detected stack
- Artifact Action definitions
- check or E2E command

Create Roadmap should seed a small product-oriented project task by default for
new empty folders. The default Initial Team goal asks the `Faker` and
`Keria` Members to create a minimal Hello World web project with runnable
scripts and verification evidence. Faker is seeded with worktree-write
execution, network disabled, and on-request approval delegated to Codex
app-server auto-review; Keria is seeded with worktree-write execution, network
disabled, and no approval prompts so local build verification can write
artifacts inside the Route worktree.
Artifact Action definitions are not created by default; they belong to a later
Hunsu transition. The initial state appears as MOVE 0 with a complete immutable
Team Snapshot.

Planned Harness choices can be visible but disabled until
ExecutionPlan dispatchers exist. The executable default is the Team plus
ExecutionPlan flow.

## MOVE Graph

The graph shows route positions and transitions.

Each MOVE card should show:

- Team name
- MOVE number
- outcome
- Destination summary
- Harness kind
- Member summary
- Skill count and names
- model/reasoning/service-tier summary
- reached Destination caused by the incoming MOVE
- remaining Destination count
- Hunsu marker when the incoming edge is divergent

MOVE 0 is the initial Team Snapshot. Active Executes appear as operational nodes
between a source MOVE and a target result.

Normal route edges are solid. Hunsu edges are dashed and visually distinct.

## Selected MOVE Actions

Selecting a MOVE exposes focused actions:

- start Execute for the next MOVE
- run configured Artifact Actions
- open host action aliases or inspect check action results
- start Hunsu Draft from that MOVE
- inspect Team Snapshot
- inspect Action Evidence, general evidence, and diff
- inspect conversation references

Starting an Execute is allowed only when the selected MOVE is the current playable
MOVE for that Team route and the next MOVE result does not already exist. If
a later outcome already exists, Studio must not start another Execute from that
same Team and MOVE count. The user can still give Hunsu from any MOVE.
When the current MOVE has multiple open Destinations, Studio treats them as a
queue. It may show the queue for context, but it must render only one Execute
action for the queue-head Destination and send only that Destination in the
`selectedDestinationIds` array. Changing queue order is a Hunsu change, not a
Execute-start choice.

## Execute Overlay

An Execute is visible on the MOVE graph while the Team planning turn or Member
Paths are active. The primary Roadmap canvas should project Execute Overlay data
as a compact inline ExecutionPlan trace between the source MOVE and the pending target
MOVE. The inline graph uses:

- `InlinePathPoint` for Member Paths and the pending target MOVE
- `InlinePathEdge` for `PrevMove`, Path dependency, and terminal-to-target
  links

The compact inline view should show Path id, Member id, status, dependency
shape, and short commit when available. Selecting any inline Path point or
pending target MOVE opens the expanded Execute Overlay.

The expanded Execute Overlay and debug panels should show:

- Team name
- target MOVE number
- status
- current attempt and budget
- selected Destination
- Harness kind
- current ExecutionPlan
- current Member Path
- full PathCommitMap progress
- terminal Path commit when available
- MOVE finalizer output when available
- worktree hash
- Agent Conversation hash
- latest Member Path output, provider session, or feedback summary

The read-only conversation/debug view lets the user inspect liveness,
transcript, tool output, Member Path outputs, PathCommitMap details, and
worktree identity, but cannot steer the Team conversation directly.

Studio should show the current rendered task and provider goal as live run
state, but it should not expose encoded `.hunsu/` runtime files as editable
text. Hunsu app owns decoding, digesting, and committing that state after the
Team run ends.

## Artifact Actions Panel

The Artifact Actions panel shows configured derived work for a MOVE or commit.

It should make host/check results easier to inspect than raw logs:

- source MOVE or commit
- ordered action definitions
- kind (`host` or `check`)
- alias URLs for host actions such as `web`, `api`, `storybook`, or `admin`
- status, logs, exit code, and latest run time
- check or E2E result summary
- screenshots, traces, reports, or generated evidence
- console and network failures
- stop actions for long-running host runs

The primary action is opening the `web` alias or the configured E2E target
alias. Host ports are debug details. Studio should show stable alias URLs so
the user thinks in product surfaces, not local port allocation.

Artifact Action comparison should support human judgment:

- compare the current MOVE host/check result to a parent MOVE
- compare sibling Team route action results after Hunsu
- compare screenshots or E2E status across alternatives
- start Hunsu Draft from an action failure or observed UX issue

Action Runs are retained or stopped explicitly. Closing a terminal or Codex
session should not be the lifecycle model for product evidence.

## E2E Evidence Review

E2E checks execute as configured Artifact Action `check` runs or against host
action alias URLs.

Studio should show E2E evidence as a first-class MOVE detail:

- command and status
- target alias URL
- screenshots
- Playwright traces
- browser console output
- network failures
- service logs relevant to the failure

Passing E2E means the running product result passed from the user perspective.
It does not mean deployment is complete, but it gives the user a stable result
to approve, compare, or Hunsu.

## Hunsu Draft Conversation

Hunsu Draft is the assisted route-change surface.

Target flow:

```text
select MOVE
  -> start Hunsu Draft
  -> Bridge creates a Draft Route worktree and Draft AgentSession
  -> Bridge writes .hunsu-prev and .hunsu-request decoded draft surfaces
  -> Studio displays a Plan-style compact HunsuDraft Route node between the source MOVE and the future Hunsu-created MOVE
  -> user selects route=hunsu-draft:<draftSessionId>
  -> Draft agent receives Team Snapshot, decoded local Roadmap context, and current request files
  -> Director chats with Draft agent
  -> Draft agent asks follow-up questions or edits decoded runtime files in .hunsu-request/
  -> Draft agent runs Bridge's Draft check command and creates a DiffArtifact
  -> Draft agent includes the DiffArtifact marker in chat
  -> Studio renders the inline DiffArtifact card with changed files and Confirm Hunsu
  -> approval calls ConfirmHunsuDraft with the DiffArtifact id, updates encoded runtime state, and creates a new Team route
  -> Studio keeps the completed HunsuDraft Route node as the route log and connects it to the new HUNSU-created node
  -> Studio refreshes the board and selects the new HUNSU-created node with panel=hunsu
```

The Draft agent is conversational and owns the interactive Draft Route
AgentSession. DiffArtifact cards in chat are the review surface for what will be
confirmed. Confirm is enabled only for a passing DiffArtifact, and Bridge rejects
confirmation if `.hunsu-request` changed after that artifact was created. Raw
request files remain a route-worktree editing surface, not durable Roadmap
state. The detail inspector renders as a centered modal over the Roadmap canvas
so long logs and runtime diffs have enough horizontal review space. The
inspector renders the same AgentSession item stream used by Team Plan and
Member Path logs. It shows `Reasoning` rows, assistant text deltas, command
output, file-change items, tool calls, elapsed time, and a temporary `Starting`
row before the first provider item arrives. Running elapsed time is derived
from Codex app-server item lifecycle timestamps and is frozen on completion;
completed items must keep their final elapsed label instead of falling back to
`0s`.

Editable Hunsu Draft files in v1:

- `.hunsu-request/destinations.json`
- `.hunsu-request/harness.json`
- `.hunsu-request/executors.json`
- `.hunsu-request/resources.json`
- `.hunsu-request/artifact-actions.json`

Simple TODO/task additions edit `destinations.json` only. `harness.json` is
edited only when the user explicitly asks to change the locked root Team,
Harness policy, guardrails, locks, or Artifact Actions and must not contain
Executor definitions. `executors.json` is the Team/Member source of truth and
is edited only when the user explicitly asks to change Executor definitions or
Executor config. `resources.json` is the Skill/Plugin/resource-binding source
of truth and is edited only when the user explicitly asks to change Resource
bindings or requirements. New Destinations do not need Executor or Resource
binding changes. Bridge composes Harness runtime state from `harness.json`,
`executors.json`, and `resources.json` when it renders Team Snapshots and starts
execution.

DiffArtifact cards render each changed runtime file with a git-style unified
diff. TODO/task/follow-up requests are reviewed as Destination runtime file
changes so the approved route has open work to Execute. Artifact Action changes
are reviewed as `artifact-actions.json` runtime file changes. Confirmed HUNSU
nodes label the recorded files as Runtime Changes and Changed Files.

Discarding a HUNSU Draft leaves Roadmap Hunsu, fork, MOVE, and Team counts
unchanged. Before approval, the Draft Route is route runtime state, not an
accepted Roadmap transition. Bridge writes compact route metadata to
`.hunsu/hunsu-draft.hunsu`; raw conversation bodies remain AgentSession/provider
operational data. The conversation reference is recorded in the accepted Hunsu
only when approval creates it.

## Skill Draft Workspace

Skill changes need a draft layer.

The draft workspace should support:

- querying current Codex skill folders
- creating a mutable draft folder
- spawning a skill-edit subagent against that draft
- showing draft files and transcript
- accepting the draft into a Hunsu
- discarding the draft without changing the Roadmap

Accepted drafts become immutable Skill Snapshots referenced by Member configs
in the new Team's Harness.

## Visual Direction

The primary metaphor is autonomous execution with a Director seat.

Useful visual cues:

- launcher for Roadmap selection
- left Roadmap View panel for current Roadmap context
- route lines for Team paths
- Team badge on active route
- Destination list inside MOVE cards
- Artifact Action status and E2E evidence markers inside MOVE detail
- warning marker for Accident outcomes
- dashed route switch for Hunsu
- lock icon for immutable snapshots

The user should mostly read MOVEs, Action Runs, E2E evidence, and
Destination/Harness snapshots, not raw logs. Logs remain available
through selected Execute, Action Run, and Agent Conversation details for
trust and debugging.
