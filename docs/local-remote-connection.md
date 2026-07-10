# Local And Remote Bridge Connection

Bridge models connection state as backends.

Local Bridge is always represented while the Bridge App is running. The desktop
UI auto-starts the local sidecar when possible and shows Connecting or Starting
instead of presenting Local Bridge as a normal Not Running state:

```text
backendId: local
mode: local
label: This computer
connection: connected | connecting
workspaces: active local workspaces
```

Remote Bridge is additive. It appears after a signed-in request or Bridge App
persisted sign-in state can see remote devices through Relay or the local relay
device registry:

```text
backendId: remote:<deviceId>
mode: remote
label: device name
connection: connected | relay_offline | login_required
workspaces: active remote-enabled workspaces
```

Remote workspace paths are redacted in the bridge status response until the
matching Project Grant includes remote Relay access. Workspace names and
provider readiness can still be shown so users understand what is available
without exposing local filesystem details.

Remote enable publishes active Workspaces in two places: active registry
entries are marked remote-enabled locally, and the same active workspace paths
are sent as Project Grants when the device is registered with Relay. Inactive
Workspaces are skipped.

Remote backend provider status is modeled separately from the local provider.
If a Relay device reports a provider status, Bridge uses that status. If the
device does not report provider status yet, `/api/bridge/status` returns an
explicit unavailable remote-provider status instead of reusing the local Codex
status. Provider status includes a required model-inventory availability union.
Bridge App publishes the provider-owned inventory with each Remote snapshot;
an older or incomplete snapshot without that field is treated as inventory
unavailable and never receives the local catalog.

Web model-alias validation follows the selected backend. Local validation calls
`/api/providers/inventory` and `/api/model-aliases/validate` on the local
Bridge; the inventory response names the backend with `backendId`. Remote
validation uses the Relay command path for `provider.inventory`,
`modelAlias.validate`, and `modelAlias.resolve`, and successful resolution
returns the backend id that actually validated the model. Relay translates the
selected `remote:<deviceId>` to `local` only at the target Bridge transport
boundary, then restores the remote id in the response. Unknown explicit backend
ids fail with `BACKEND_UNAVAILABLE` rather than being relabeled local results.

Local Bridge child processes inherit the effective runtime provider env from
Bridge App state. That includes saved Codex `binaryPath`, `codexHome`,
`appServerCommand`, and `appServerArgs`. The sidecar daemon, remote attach
processes, status checks, login commands, diagnostics, and Execute runner must
all see the same effective Codex env so a fixed Provider Setup configuration is
recoverable after restart and during Remote Access.

The Bridge App Connection tab keeps this model simple:

- Local is always visible while the app is running.
- Local start/stop controls are Advanced/debug controls.
- Remote signed out shows a Sign in action.
- Remote signed in but off shows Enable Remote Access.
- Remote signed in/on shows Disable Remote Access and the device status.

Remote endpoint, Relay, path, grant, scope, and pairing details are Advanced
details, not the primary connection view.

Remote enable and disable persist a final `remoteAccess` state in the Relay or
local device registry. Disabled devices are filtered from remote device lists
and remote command routing, so they disappear from `/api/connections/remote`
and the remote portion of `/api/bridge/status` until enabled again.

Web normally reads local `/api/bridge/status`. That response combines provider,
workspace, account, local connection, and remote connection state. It can report
signed-in/no-remote, signed-in/remote-off, signed-in/remote-online, and provider
not-ready states without requiring a separate status alias. When Web has both a
local Bridge token and a selected remote Bridge session, it keeps the local
backend and also fetches selected remote `bridge.status`, then renders both
local and remote Workspaces together. If the local request is unavailable, Web
sends `bridge.status` through the existing Relay/direct remote session path and
renders the result as a remote backend.

## API

```text
GET  /api/connections
GET  /api/connections/local
GET  /api/connections/remote
POST /api/connections/remote/enable
POST /api/connections/remote/disable
POST /api/connections/remote/connect
GET  /api/bridge/status
```

`/api/bridge/status` is the preferred Web entrypoint because it returns the
provider, connections, workspaces, and account state together.
