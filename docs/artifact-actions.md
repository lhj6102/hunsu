# Artifact Actions

Artifact Actions are the current model for durable, locally executed project
actions.

An immutable MOVE or commit is the source artifact. Artifact Actions are durable
Hunsu runtime state encoded under `.hunsu/artifact-actions.hunsu`; changing the
ordered action definitions requires a Hunsu transition. Action Runs are local
derived executions against a selected MOVE or commit and do not mutate the
source artifact.

## Definitions

Each action definition has:

- `id`
- `title`
- `kind`
- `sourceScope`
- `env`
- `runner`
- optional `aliases`
- optional `evidence`
- `displayOrder`

Action definitions are domain values, not loose manifests. The decoder rejects
partial or ambiguous configuration:

- `check` actions must use a `command` runner.
- required env entries must be encoded as `{ required: true }`; `required:
  false` is not a valid lifecycle state.
- env entries that reference aliases must point at a declared alias.
- aliases must declare either a concrete `target` URL/value or both `service`
  and `containerPort`; empty aliases and mixed target/service aliases are
  invalid.
- `displayOrder` must be a non-negative integer.

Draft request runtime files are validated as full action definitions. Partial
patches are not a protocol-level mutation format; if an action changes, the
resulting `artifact-actions.json` must contain a valid complete action.

v1 supports these built-in kinds:

- `host`: starts a long-running runtime from the selected artifact and exposes
  stable alias URLs such as `web`, `api`, or `storybook`.
- `check`: runs a finite command such as E2E, lint, typecheck, scan, report, or
  export generation.

Multiple actions can exist at the same MOVE snapshot. They run independently in
v1; dependencies and chained workflows are intentionally reserved for later.

## Runtime

Local creates a detached worktree from the selected source commit, injects the
declared environment, runs the configured action, and records Action Run state in
a local operational store under `.hunsu/action-runs`.

Host actions expose stable alias URLs in Studio. Concrete ports are debug
details. Check actions expose status, logs, exit code, and generated evidence.

Durable action definitions are committed Hunsu state. Action Run records are
local operational state. Durable results can later be attached as evidence or
artifacts to the MOVE or commit view through normal Hunsu/Artifact flows.

Runtime readers validate `.hunsu/artifact-actions.hunsu` all the way down to the
contained action definitions. The file is not treated as trusted JSON merely
because its envelope checksum and schema are valid.

## Hunsu Draft Editing

Artifact Actions are added, updated, removed, and reordered by editing decoded
runtime files through Hunsu Draft.
When a Draft starts from a selected MOVE or node, Local creates decoded draft
surfaces in the Draft Route worktree:

```text
.hunsu-prev/destinations.json
.hunsu-prev/harness.json
.hunsu-prev/executors.json
.hunsu-prev/resources.json
.hunsu-prev/artifact-actions.json
.hunsu-request/destinations.json
.hunsu-request/harness.json
.hunsu-request/executors.json
.hunsu-request/resources.json
.hunsu-request/artifact-actions.json
```

The Artifact Action file uses readable JSON with the same schema as encoded
`.hunsu/artifact-actions.hunsu`:

```json
{
  "schema": "hunsu.artifact-actions.v1",
  "order": "display-order",
  "actions": []
}
```

`.hunsu-prev` is the read-only baseline decoded from the source node.
`.hunsu-request` is the editable request copy. The Draft agent and user-facing
edits may change `.hunsu-request/artifact-actions.json`; they must not change
encoded `.hunsu/*`, `.hunsu-prev/*`, or product files for the Draft turn.

The Draft agent creates a DiffArtifact after editing request files. Local
validates `.hunsu-request/artifact-actions.json`, compares `.hunsu-prev` and
`.hunsu-request`, reports changed files with git-style unified file diffs, and
dry-runs the Hunsu workflow checks against the current source node. Confirm
Hunsu records the checked changed files and request Team snapshot from the
passing DiffArtifact, then regenerates encoded Hunsu runtime state. The decoded
request files are Draft UX state; the durable model remains encoded Hunsu
runtime state plus the confirmed Hunsu record.

## API

Local exposes Artifact Action endpoints:

- `GET /api/roadmaps/:roadmapId/artifact-actions`
- `POST /api/roadmaps/:roadmapId/artifact-actions/:actionId/runs`
- `GET /api/roadmaps/:roadmapId/action-runs`
- `GET /api/roadmaps/:roadmapId/action-runs/:runId`
- `POST /api/roadmaps/:roadmapId/action-runs/:runId/stop`

Local also exposes Hunsu Draft endpoints for runtime-file editing:

- `POST /api/roadmaps/:roadmapId/hunsu/drafts/:draftId/diff-artifacts`
- `GET /api/roadmaps/:roadmapId/hunsu/drafts/:draftId/diff-artifacts/:artifactId`
- `POST /api/roadmaps/:roadmapId/hunsu/drafts/:draftId/approve`

The non-roadmap-scoped debug API uses the same `/api/artifact-actions` and
`/api/action-runs` resource names.

## CLI

The CLI surface is:

- `hunsu action list`
- `hunsu action plan <action-id> --move <move-id>|--commit <ref>`
- `hunsu action run <action-id> --move <move-id>|--commit <ref>`
- `hunsu action status [run-id]`
- `hunsu action stop <run-id>`

Older preview-specific CLI commands are not part of the v1 Artifact Actions
model.
