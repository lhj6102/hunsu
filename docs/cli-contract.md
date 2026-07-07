# CLI Contract

The Hunsu CLI is the control-plane and Director-facing protocol surface.

Humans, Studio, and recovery scripts should not need to import TypeScript
packages. They should learn a small command set and rely on JSON where
automation needs stability. Team and Member agents should not need the CLI
in the default Execute loop; they work inside the prepared worktree and Studio
handles evaluation and recording.

## Principles

- Human-readable output by default.
- `--json` for stable machine-readable output.
- Non-zero exit codes for failed operations.
- Errors written to stderr.
- No hidden mutation without explicit confirmation.
- Commands should be safe to call from Studio, Director workflows, and recovery
  scripts.
- Team-facing commands are debug or recovery tools, not the normal Team
  contract.
- Studio records Arrived or Accident after the ExecutionPlan reaches a terminal
  result. For Arrived, the terminal Member Path commit is finalized into a new
  MOVE product commit that records the finalizer-written commit message.
- Director commands change Destinations, Harness, Team prompts,
  Member configs, Skills, or route direction through Hunsu.

## Pre-Release Compatibility

Hunsu has not shipped as a stable product. Breaking CLI changes are acceptable
while the Roadmap, Team, Destination, and Roadmap Registry language is being
made consistent. Product docs should teach only the target surface below.

## Target Roadmap Registry Commands

```bash
hunsu roadmap list --json
hunsu roadmap open /path/to/roadmap --json
hunsu roadmap create /path/to/new-folder --title <title> --json
hunsu roadmap port inspect /path/to/repo --json
hunsu roadmap port apply /path/to/repo --title <title> --goal <goal> --write
hunsu roadmap forget <roadmap-id> --json
hunsu roadmap doctor <roadmap-id> --json
```

These commands operate on the local user-level Roadmap Registry. They do not
store durable Roadmap graph state. `roadmap open` is for an existing Hunsu
Roadmap. It canonicalizes the path, registers or updates the local entry,
reports health, and returns the stable `roadmapId` Studio uses for
`/studio/roadmaps/<roadmapId>`.

`roadmap port inspect` is for an arbitrary Git project. It should detect stack
shape, package manager, scripts, Docker files, environment variables, hardcoded
ports, and Artifact Action readiness. `roadmap port apply` turns the project
into a Hunsu-ready Roadmap by writing encoded Hunsu runtime state and Initial
Team state.

## Target Roadmap State Commands

```bash
hunsu roadmap init /path/to/repo
hunsu roadmap status --json
hunsu roadmap graph --json
```

`roadmap init` should be non-invasive. It writes the `.hunsu/` runtime bundle and
Roadmap metadata into an explicit executable commit without changing unrelated
ordinary branches. Studio usually reaches this command from Port or Create, not
from a generic open folder action.

## Target Port Commands

```bash
hunsu port inspect /path/to/repo --json
hunsu port plan /path/to/repo --title <title> --goal <goal> --json
hunsu port apply /path/to/repo --title <title> --goal <goal> --write
```

The Port command family is the product-facing migration path for existing Git
projects. It should produce a reviewable plan before editing project files.
The plan can include:

- env-injection edits for hardcoded ports, hosts, or proxy targets
- initial Team and Destination events
- later Hunsu transitions that add Artifact Action definitions

Port succeeds when the repository is both a Git-backed Hunsu Roadmap and a
project that can receive Artifact Action definitions through Hunsu.

## Target Artifact Action Commands

```bash
hunsu action list
hunsu action plan <action-id> --move <move-id>|--commit <ref> --json
hunsu action run <action-id> --move <move-id>|--commit <ref>
hunsu action status [run-id] --json
hunsu action stop <run-id>
```

Artifact Action definitions are durable Hunsu state. Action Runs are local
operational state created from a selected MOVE or commit.

## Target Destination Commands

```bash
hunsu destination list --roadmap <id> --json
hunsu destination add --from <move-id> --title <title> --write
hunsu destination rewrite --from <move-id> --id <destination-id> --file destination.md --write
hunsu destination remove --from <move-id> --id <destination-id> --reason <reason> --write
hunsu destination block --from <move-id> --id <destination-id> --reason <reason> --write
hunsu destination unblock --from <move-id> --id <destination-id> --write
```

Destination mutation commands are Director actions. They should record Hunsu and
create a new Team route at the same MOVE count.

## Target Execute Commands

```bash
hunsu execute start --from <move-id> --write
hunsu execute pause <execute-id> --write
hunsu execute resume <execute-id> --write
hunsu execute stop <execute-id> --write
hunsu execute status <execute-id> --json
hunsu execute conversation <execute-id> --json
```

Starting an Execute creates a Git worktree and assigns a worktree hash. The Team
conversation is read-only to the user. The Execute resolves to one recorded MOVE.

## Target MOVE Commands

```bash
hunsu move arrived --execute <execute-id> --from <ref> --summary <summary> --destination <destination-id> --evidence <evidence> --write
hunsu move accident --execute <execute-id> --reason <reason> --evidence <evidence> --write
hunsu move show <move-id> --json
```

These are control-plane commands for Studio, scripts, or recovery flows. A
Team should not call them directly in normal operation.

## Target Harness Commands

```bash
hunsu harness show --from <move-id> --json
hunsu harness set --from <move-id> --file harness.json --write
hunsu team prompt set --from <move-id> --file prompt.md --write
hunsu member prompt set --from <move-id> --member <member-id> --file prompt.md --write
hunsu member model set --from <move-id> --member <member-id> --model <model-id> --write
hunsu member reasoning set --from <move-id> --member <member-id> --level <level> --write
hunsu member service-tier set --from <move-id> --member <member-id> --tier <tier> --write
hunsu member skill add --from <move-id> --member <member-id> --skill <skill-ref|skill.json> --write
hunsu member skill remove --from <move-id> --member <member-id> --name <name> --write
```

Harness and Member commands validate the selected Team Snapshot before
writing. Unknown Member ids, malformed Harness snapshots, and malformed Skill
bindings must fail before events are appended.

## Target Hunsu Commands

```bash
hunsu hunsu manager start --from <move-id> --write
hunsu hunsu draft show <hunsu-draft-id> --json
hunsu hunsu draft confirm <hunsu-draft-id> --write
hunsu hunsu draft discard <hunsu-draft-id> --write
hunsu conversation show <conversation-hash> --json
hunsu hunsu copy --from <move-id> --write
```

`hunsu copy` is the retry primitive. It records a copy-only Hunsu, assigns a
new Team name, and creates a sibling MOVE with the same MOVE count. Retry then
starts a new Execute from that sibling route.

## JSON Shape

Target graph response:

```json
{
  "roadmaps": [
    {
      "id": "roadmap_001",
      "title": "AI Dev Harness",
      "activeRouteId": "route_t1"
    }
  ],
  "routes": [
    {
      "id": "route_t1",
      "teamName": "T1",
      "status": "active",
      "moves": ["M0000", "M0001", "M0002"],
      "currentMoveId": "M0002"
    }
  ],
  "moves": [
    {
      "id": "M0002",
      "teamName": "T1",
      "ordinal": 2,
      "outcome": "Arrived",
      "reachedDestinations": ["destination_001"],
      "snapshot": {
        "teamName": "T1",
        "destinations": ["destination_001", "destination_002"],
        "harness": {
          "kind": "team_execution_plan"
        }
      }
    }
  ],
  "edges": [
    {
      "type": "route",
      "fromMoveId": "M0001",
      "toMoveId": "M0002"
    },
    {
      "type": "hunsu",
      "fromMoveId": "M0002",
      "toMoveId": "M0002-ruler",
      "hunsuId": "K0001"
    }
  ]
}
```

## Git Storage Contract

Roadmap state should be reconstructed from reachable Git commits that contain
encoded Hunsu runtime state:

```text
product files
.hunsu/completed-destinations.hunsu
.hunsu/destinations.hunsu
.hunsu/harness.hunsu
.hunsu/executors.hunsu
.hunsu/resources.hunsu
.hunsu/artifact-actions.hunsu
.hunsu/current-execution.hunsu # optional, execution NODE commits only
.hunsu/previous-execution.hunsu # optional, completed MOVE commits only
.hunsu/hunsu-draft.hunsu # optional, Hunsu Draft Route commits only
```

Route branches should use ordinary branch refs:

```text
refs/heads/hunsu/routes/...
```

Custom refs under `refs/hunsu/*` may exist as migration markers or optional
lookup accelerators, but CLI commands must not require them as the only durable
Roadmap database. If the local app cache and custom refs are missing, Hunsu
should rebuild projections by scanning commits and decoding the `.hunsu/`
runtime bundle.
