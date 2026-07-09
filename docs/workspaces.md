# Workspaces

Workspace is the user-facing name for Bridge-managed local projects.

The internal Roadmap registry remains the persistence source for now, but new
Bridge APIs return `ConnectedWorkspaceSummary` objects:

- `workspaceId`
- `roadmapId`
- display name
- optional local path
- lifecycle and health
- backend id and connection mode
- provider readiness
- user-facing actions

Active local workspaces appear in Hunsu Web's lower-left navigation. Inactive
workspaces stay in Bridge App and can be activated later. Missing or unhealthy
workspaces expose repair or remove actions.

Remote workspace summaries are scoped to active workspaces with Remote Access
enabled. Remote paths are redacted until a grant allows path visibility.
Enabling Remote Access from Bridge publishes the current active Workspace set:
active entries are marked remote-enabled and matching Project Grants are sent
with device registration. Inactive Workspaces remain local-only.

Bridge App's default Workspaces view hides low-level local paths, grant scopes,
and Relay state. Those details remain visible in Advanced/Diagnostics for
support and debugging.

Workspace Execute preflight returns `area: "workspace"` and actions that open
`hunsu://workspaces` or the specific workspace. Provider readiness is checked
after workspace health so inactive, missing, or unhealthy workspaces are not
misreported as provider failures.

## API

```text
GET  /api/workspaces
GET  /api/workspaces/active
GET  /api/workspaces/managed
POST /api/workspaces/add
POST /api/workspaces/activate
POST /api/workspaces/deactivate
POST /api/workspaces/remove
```

Workspace mutation responses use workspace-shaped payloads. Add, activate, and
deactivate return the affected `workspace` plus the current `workspaces` list;
remove returns `removed` plus the current `workspaces` list. New
`/api/workspaces/*` endpoints do not return legacy `roadmap`/`roadmaps`
mutation payloads.

Roadmap compatibility endpoints remain under `/api/roadmaps/*` and keep their
legacy response shapes for existing callers.
