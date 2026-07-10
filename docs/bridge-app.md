# Hunsu Bridge App

Hunsu Bridge App is the small companion app that connects runtime providers and
local workspaces to Hunsu Studio. It is not an IDE and it does not replace
Studio.

Bridge App intentionally remains a lightweight Tauri companion app. Electron is
not used for this surface.

## Primary User Path

```text
Install Hunsu Bridge App
Open the app
Hunsu Bridge starts locally and shows the tray/menu-bar item
Provider setup or Workspace setup opens only when attention is required
Open Hunsu Web from the tray when ready
```

The advanced developer fallback remains:

```sh
npx @hunsu/bridge@latest
```

Headless machines use the same foundation through the command surface:

```sh
hunsu-bridge login
hunsu-bridge remote status
hunsu-bridge projects grant /path/to/project
hunsu-bridge start --remote
hunsu-bridge service install
hunsu-bridge model-alias list
```

See [Headless Service](headless-service.md) for user-scoped service artifacts
and [Model Aliases](model-aliases.md) for Execute model selection.

Browser and Studio handoff use the app protocol surface:

```text
hunsu://open
hunsu://provider
hunsu://provider/codex
hunsu://workspaces
hunsu://add-workspace
hunsu://connection
hunsu://connection/remote
hunsu://diagnostics
hunsu://pair?next=/studio
hunsu://open-project?path=/path/to/project
hunsu://open-workspace?workspaceId=<id>
hunsu://open-roadmap?roadmapId=<id>
```

On the primary Provider tab, a ready provider shows Recheck and Change provider.
Provider errors show Recheck, Select Existing Codex, and Show details. API-key
configuration stays in Advanced provider details instead of the primary ready
card.

Advanced and compatibility intents remain available for diagnostics, legacy
links, or account/Remote Access management:

```text
hunsu://sign-in
hunsu://sign-out
hunsu://remote-disable
```

`hunsu://open` is the safe default open/focus intent. It opens Bridge App on
the Provider view without implying that Bridge status was checked.

Older aliases remain supported:

```text
hunsu://codex
hunsu://prerequisites
hunsu://prerequisites/codex
hunsu://roadmaps
hunsu://add-roadmap
```

## Responsibilities

Hunsu Bridge App owns local runtime supervision:

- start, stop, restart, and report local Bridge health
- open Studio with a fresh pairing token
- handle `hunsu://` browser handoff links
- show Provider, Workspaces, and Connection as the primary navigation
- keep Settings, Diagnostics, logs, and provider/remote internals secondary
- check runtime provider readiness without reading provider credential files
- inspect selected folders through Project Finder
- add, activate, deactivate, and remove managed Workspaces
- open existing Hunsu Roadmaps
- port Git projects into Hunsu
- create Roadmaps in new folders
- expose diagnostics for support
- hold account/device state for Remote Access
- persist Project Grants and no-GUI service state with strict file permissions
  until platform installers own those native stores

## Desktop Shell

`apps/bridge-desktop` contains the product desktop layer:

- a Tauri shell scaffold under `src-tauri/`
- a small desktop status window maintained from `src-ui/` and built into
  `dist-ui/` for packaging; it polls live status, recent projects,
  selected-folder inspection, diagnostics, and logs
- a native folder picker command for macOS, Windows, and Linux GUI
- `hunsu://` protocol registration through Tauri's desktop deep-link plugin for
  packaged macOS and Windows apps, runtime registration for Linux GUI bundles,
  and a Linux user-level `.desktop`/`xdg-mime` handler for headless installs
- a supervised sidecar process that restarts a crashed Bridge daemon and writes
  structured logs
- a tray-first lifecycle: the main window is hidden by default, closing the
  window keeps Local Bridge running, and the tray shows Provider, Local,
  Remote, and active Workspace summary plus Open Hunsu Web, Provider Setup,
  Add Workspace, Connection, Diagnostics, and Quit

Build commands:

```sh
pnpm --filter @hunsu/bridge-desktop build
pnpm --filter @hunsu/bridge-desktop desktop:prepare
pnpm --filter @hunsu/bridge-desktop desktop:dev
pnpm --filter @hunsu/bridge-desktop desktop:build
pnpm --filter @hunsu/bridge-desktop artifacts:report-sizes
```

`build` compiles the headless command package, bundles the sidecar entrypoint,
creates a Node SEA blob, downloads the pinned Node runtime archive for the
selected Tauri target, verifies it against Node's `SHASUMS256.txt`, injects the
SEA blob with `postject`, and writes that target's native ELF/Mach-O/PE sidecar
plus `dist/sidecar-manifest.json`. The target defaults to the build host and can
be selected with `HUNSU_BRIDGE_SIDECAR_TARGET` or `--target`. Desktop packaging
uses Tauri `externalBin` for the active sidecar and keeps resources limited to
the sidecar manifest; see [Windows Packaging](windows-packaging.md). The
packaged sidecar is a native executable and does not require `node` on the
installed user's `PATH`.

SEA generation verifies that its Node executable reports exactly the pinned
embedded runtime version before creating the blob. Local builds can set
`HUNSU_BRIDGE_SEA_NODE_PATH` to an exact-version Node executable; mismatches
fail before bundling or injection. After `postject` modifies a macOS sidecar,
the build ad-hoc signs it and verifies the new signature before native
validation and the `status` smoke test.

`desktop:prepare` builds the UI and command package, removes stale prepared
sidecars, and builds only the current host target plus its manifest. Therefore
`desktop:dev` can start from a clean checkout without generated `dist/`,
`native-sidecars/`, or `.sidecar-cache/` content.

`desktop:build` requires Rust/Cargo plus platform Tauri dependencies. The
TypeScript sidecar/headless package can be built and tested without those native
toolchains.

The Tauri shell ships with an explicit CSP. Browser JavaScript is loaded from a
bundled app script, and native command invocation is allowlisted to known Bridge
App commands. Unsupported `hunsu://` commands are rejected instead of being
passed to the sidecar.

Tray Provider Setup, Add Workspace, Workspaces, Connection, Diagnostics, and
cold-start `hunsu://` entries route through the same sidecar intent path and
show/focus the Bridge window after routing. The tray summary is rebuilt from the
sidecar snapshot on an asynchronous periodic refresh so provider, local, remote,
and workspace state do not stay at launch-time values. Diagnostics routes to
`hunsu://diagnostics`; `hunsu://prerequisites` remains a Provider compatibility
alias.

Quit is explicit. The native menu confirms before exiting and honors the
persisted background preference for keeping or stopping the supervised Local
Bridge. The preference is exposed in Bridge App Settings and through
`hunsu-bridge settings quit-behavior`.

Studio remains the main product UI for Roadmaps, Execute, Hunsu Drafts,
Artifact Actions, and Hub.

## Provider Setup

Codex is the first supported runtime provider. Bridge App starts and remains
useful when Codex is missing: local Bridge pairing, Project Finder, Workspace
activation, Hub, and non-Execute Studio flows still work.

Codex resolution order is:

1. saved provider `binaryPath`
2. saved provider `appServerCommand`
3. `codex` on `PATH`
4. Windows known OpenAI Codex install directories
5. missing

Codex provider setup saves all Codex config under
`runtimeProviders.providers.codex.settings`:

- `binaryPath`
- `codexHome`
- `appServerCommand`
- `appServerArgs`
- `authenticationPreference`

Legacy `codex.binaryPath` and `codex.environment` fields are read as migration
inputs only. Bridge App writes the canonical provider settings object after
configuration.

The Provider tab owns setup. Configure opens a Codex setup modal generated from
provider metadata. Primary fields are Codex binary and Codex home, authentication
method is a separate section, and app-server command/args remain collapsed under
Advanced.

On Windows, Bridge checks the process `PATH`, Windows `Path`, and captured User
PATH and Machine PATH snapshots when available, then known OpenAI Codex install
directories such as LocalAppData OpenAI Codex and roaming npm locations.
WindowsApps execution aliases are treated as "select an existing binary"
because they can launch a Store prompt instead of a usable Codex executable.

`codexHome` is the Bridge App setting for `CODEX_HOME`. On Windows this is the
main recovery path when Codex is detected but remains Login Required because
Bridge was launched with a different home than the one that contains
`auth.json`. Bridge App can suggest the default Codex home when the effective
home has no `auth.json` and the default home does. This diagnostic checks only
file existence and paths; it never reads `auth.json` or credential contents.

Bridge App may run `codex --version`, `codex app-server --stdio`, and Codex
app-server account/rate-limit requests. It must not read `~/.codex/auth.json`,
token files, OpenAI API keys, or credential stores directly. Diagnostics include
safe readiness fields such as installed/version/source/app-server/auth/access
state, the effective provider env summary, and Codex Home auth-file existence
booleans. Diagnostics redact token-like values and must not include credential
contents.

Codex UI states:

- Install Required: show Install Codex, Use Existing Installation, and Recheck.
  Install Codex asks for explicit confirmation before running the fixed Codex
  npm installer and rechecks provider status after the installer returns.
- Select Binary: show Select Existing Codex and Recheck.
- Login Required: show Sign in with ChatGPT, Use Device Code, API key advanced,
  and Recheck.
- Ready: show auth method/access where safely detectable.
- Error: show Recheck and diagnostics without credential material.

Provider Configure opens metadata-like fields for Codex binary, Codex Home,
app-server command, app-server args, and authentication preference. Native file
and directory pickers should fill the binary and Codex Home fields. Validate
and Save use the provider config API/CLI. Save may succeed when auth is missing
as long as the binary and app-server are usable, so users can fix Codex Home
before signing in again.

Advanced Runtime Providers lists the current Codex provider plus future
providers such as Claude Code, Gemini CLI, OpenHands Agent Server, ACP Agent,
LiteLLM Gateway, and OpenRouter Gateway as Coming later. That list is hidden
from the default Provider UI until the adapters exist.

The Advanced list is populated from the provider registry API. The default
Provider view shows only the current provider and keeps Codex source, binary
path, raw usage/rate-limit payloads, and other low-level details in
Advanced/Diagnostics.

The first Provider screen is a compact summary:

```text
Provider: Codex · Ready
Workspaces: N active
Connection: Local · Connected / Remote · Off or On
```

Account, Remote Access, device, service, Project Grant, and raw Codex details
live under Connection, Advanced, Settings, or Diagnostics instead of the
primary Provider panel.

## Project Finder

Project Finder classifies selected folders as:

- Existing Hunsu Roadmap: primary action `Open in Studio`
- Git project not yet ported: primary action `Port into Hunsu`
- Empty or new project folder: primary action `Create Roadmap`
- Unsupported folder: primary action `Explain problem`
- Missing recent path: unhealthy recent project with remove/repair recovery

Inspection is a Bridge API primitive so the Bridge App, Studio, and headless
commands can share classification rules.

## Active Workspaces

Bridge App manages Workspaces through Add Workspace, Activate Workspace,
Deactivate Workspace, and Remove Workspace. Remove only deletes the Bridge registry entry; it
does not delete local files.

Studio consumes active Workspaces from Bridge by default. Inactive Workspaces remain
visible in Bridge App Workspaces but are hidden from Studio navigation and are not
Remote Access candidates until activated again.

## Connection Center

Studio always shows Bridge connection state and active workspaces at the bottom
of the left navigation. The footer opens Connection Center.

Connection Center shows:

- Provider readiness
- Local and Remote Bridge connections
- active local and remote Workspaces
- Bridge name, version, protocol version, started time, and last seen time in
  Advanced details
- Web account and Bridge account relationship in Advanced details
- current Project Grant status in Advanced details
- registered Remote Bridge devices with online/offline state in Advanced details
- normal recovery actions: Open Hunsu Bridge App, Provider Setup, Workspaces,
  Connections, Download Hunsu Bridge App, and Reconnect
- advanced recovery actions: Pair again, Sign in, Sign out, Disable Remote
  Access, and Copy diagnostics

Local Bridge is always represented. Remote Bridge uses three primary states:
signed out with a Sign in action, signed in but off with Enable Remote Access,
and signed in/on with Disable Remote Access. Low-level endpoint, grant, path,
scope, pairing, Relay, CLI, and diagnostics details stay under Advanced.

Web asks `/api/bridge/status` for the combined provider, workspace, and
connection summary. Local status combines request account hints, Relay headers,
and Bridge App persisted sign-in state and grants when available. When a local
Bridge token exists and Web also has a selected remote Bridge session, Web keeps
the local backend and fetches the selected remote `bridge.status` so the
lower-left navigation can show local and remote Workspaces together. If the
local Bridge status request is unavailable, Web falls back to the same Relay or
direct remote command path and normalizes the result as a remote backend.
Remote devices remain visible when connected even before they expose remote
workspaces. Remote workspace paths stay redacted until the matching Project
Grant allows `remoteRelay.access`.

When Remote Access is enabled, Bridge publishes the active Workspace set as
remote workspace grants and marks those active Workspaces remote-enabled in the
local registry. The same snapshot includes the current provider's explicit
model-inventory state, so remote model validation uses the provider-owned
catalog. Inactive Workspaces are not published until activated.

## Local Pairing And Security

Local Bridge binds to `127.0.0.1` by default. Protected APIs require a
short-lived pairing token and trusted Studio origin. Pairing sessions carry
issued, expiry, and revoked timestamps; Bridge App can revoke and rotate them.
`/health` is public and non-sensitive so Studio can distinguish “Bridge
reachable” from “fully paired.”

Permission layers are modeled separately:

1. Local Bridge pairing
2. Bridge device identity
3. Workspace access grant
4. Dangerous action scope

Planned dangerous scopes include Execute start, Artifact Action run,
environment variable access, host alias exposure, and Remote Relay access.

## Account And Device Foundation

Local Bridge usage does not require login.

GUI Bridge App uses Authorization Code + PKCE in the external browser.
Headless Linux/devbox usage uses Device Authorization Flow. Device credentials
are stored in OS secure storage when available, with strict-permission file
fallback for no-GUI environments.

The current implementation includes PKCE request generation, GUI
`hunsu://pair?code=...&state=...` callback token exchange, Device Authorization
Flow start/poll/token exchange, sign-out cleanup, device identity, and a
credential-store interface. Device flow runs against `HUNSU_BRIDGE_AUTH_BASE_URL`
or an explicit `--auth-url`. `apps/relay` provides the in-repo authenticated
OAuth/Relay service for local hosted validation. For isolated auth-provider
debugging, run:

```sh
hunsu-bridge auth-dev-server
hunsu-bridge login --auth-url http://127.0.0.1:<printed-port>
```

or:

```sh
hunsu-bridge login --local-dev --auto-approve
```

The default credential store uses macOS Keychain, Windows DPAPI-backed storage,
Linux Secret Service when a GUI session and `secret-tool` are available, and a
strict-permission file fallback for no-GUI environments. Tests cover the hosted
token exchange boundary, local-dev device polling, and OS adapter command
boundaries with mocks.

## Remote Relay Foundation

Remote Bridge access must not expose Bridge directly to the public internet.

The current no-GUI command foundation exposes:

```sh
hunsu-bridge remote status
hunsu-bridge remote enable
hunsu-bridge remote disable
hunsu-bridge remote devices
hunsu-bridge remote check execute.start /path/to/project
hunsu-bridge projects list
hunsu-bridge projects grant /path/to/project
hunsu-bridge projects revoke /path/to/project
```

`remote enable` requires a signed-in device foundation, registers the device
with the configured Relay HTTP API when `HUNSU_RELAY_PUBLIC_API_URL` or
`HUNSU_RELAY_API_URL` is present, and applies Project Grant scopes. The
file-backed registry remains a local fallback when no Relay API is configured.
Enable and disable persist a final `remoteAccess` state in the Relay or local
device registry. Disabled devices are filtered from remote connection lists and
remote command routing, so `/api/bridge/status` and `/api/connections/remote`
reflect the off state without touching `.hunsu/state.hunsu`.
`start --remote` opens an authenticated outbound WebSocket Relay session from
`HUNSU_RELAY_PUBLIC_WS_URL` or `HUNSU_RELAY_WS_URL`.

`apps/relay` is the in-repo hosted Relay/Auth implementation. It exposes
Device Authorization and PKCE-compatible token endpoints, authenticated
`/v1/devices` and `/v1/commands` HTTP APIs, and `/v1/device/connect` WebSocket
device sessions. Relay stores device presence, checks Web session ownership,
checks Project Grants and command scopes, and sends typed command envelopes to
the outbound Bridge device connection. The Bridge device independently checks
the requested project and command scope before forwarding mapped commands to
localhost Bridge APIs.

Studio can list Remote Bridge devices through `/api/remote/devices` and select a
device through `/api/remote/connect`. The returned `StudioConnectionStatus`
detects account mismatch and Bridge/Studio protocol incompatibility before a
remote session is shown as connected. When a remote device is selected, Studio
maps Roadmap open/create/port, Execute start/status, Artifact Action
start/stop, live events, and AgentSession events to `/api/remote/commands` so
remote mode goes through Relay rather than local-only Bridge endpoints. Local
use remains account-optional and Remote Access does not expose Bridge directly.

Target architecture:

```text
Hunsu Web
  -> authenticated WebSocket/HTTPS
Hunsu Relay
  -> outbound persistent connection
Bridge App / Bridge Daemon
  -> localhost Bridge API
Local Git / Worktree / Codex / Artifact Actions
```

Relay forwards typed commands and events, not a blind HTTP proxy. Command names
include `health`, `bridge.status`, `connection.status`, `roadmap.registry.list`,
`roadmap.open`, `roadmap.port.inspect`, `roadmap.port.apply`,
`roadmap.create`, `execute.start`, `execute.status`,
`artifactAction.start`, `artifactAction.stop`, `agentSession.events`, and
`live.events`. `execute.start`, `artifactAction.start`, and
`artifactAction.stop` are mapped to protected Bridge API endpoints only after
Project Grant and command-scope checks pass.

Relay checks Web session, device access, Remote Access enablement, device online
state, Project Grant, and command scope. Bridge checks Relay session, granted
project path, allowed command scope, and Roadmap-to-path mapping. Remote
`connection.status`, `bridge.status`, and Roadmap Registry results do not expose
local repository paths unless the requested project is granted.

## Execute Preflight

Execute preflight returns user-facing areas rather than legacy setup buckets:

- Provider problems route to `hunsu://provider` or `hunsu://provider/codex`.
- Workspace problems route to `hunsu://workspaces` or the specific workspace.
- Connection problems route to `hunsu://connection`.

Roadmap compatibility endpoints keep their API shape, but their preflight
errors now use Provider, Workspaces, and Connection language so Web can send the
user to the right Bridge App section.

Remote Execute preflight also reports production connection failures:
`BRIDGE_NOT_CONNECTED`, `REMOTE_NOT_CONNECTED`, and `REMOTE_LOGIN_REQUIRED`.

## Process Status, Stop, And Services

Bridge App status checks the stored managed `bridgeApiUrl` before falling back
to the configured default endpoint. It records process metadata when Bridge is
started, checks PID liveness, and clears stale runtime process fields while
keeping account, device, and Project Grant state.

`hunsu-bridge stop` tries the Bridge control endpoint first:

```text
POST /api/bridge/control/shutdown
```

The endpoint requires the Bridge control token. PID termination is only a
fallback after the stored process still appears alive and its command line
matches a Hunsu Bridge App sidecar/supervisor process.

Headless service artifacts are generated per platform. Linux systemd user units
quote paths, percent signs, and environment values; macOS emits a launchd plist
artifact; Windows remains installer-managed with a documented manual fallback.

## Native And Manual QA Matrix

Automated coverage validates TypeScript surfaces, command parsing, service unit
generation, protocol artifacts, credential adapters with mocks, Relay command
decisions, sidecar crash restart, Bridge supervisor lifecycle, security
rejections, Project Finder, and Connection Center data contracts.

The native/browser QA contract is recorded in
`docs/qa/bridge-platform-matrix.json` and verified by
`tests/bridge-qa-matrix.test.ts`. The matrix covers macOS, Windows, Linux GUI,
Linux no-GUI, and Chrome/Safari/Edge/Firefox browser checks with concrete
in-repo evidence files and command checklists. Real native-host executions are
recorded separately in the matrix's `nativeHostResults` section. As of
2026-07-10, this Linux no-GUI workspace has not run macOS, Windows, Linux GUI,
packaged installer, tray/menu-bar, or native daemon QA; those remain external
host blockers rather than contract-only pass claims.

## Compatibility

Bridge exposes version information:

```ts
type BridgeVersionInfo = {
  bridgeVersion: string;
  bridgeAppVersion?: string;
  protocolVersion: string;
  minSupportedStudioVersion?: string;
  supportedFeatures: string[];
};
```

Studio evaluates the version and feature contract returned by Bridge and by
Remote Bridge device selection. It shows clear update states for Bridge update
needed, Studio update needed, feature unavailable on this Bridge version, and
Remote Relay requires newer Bridge App instead of treating these as generic
offline failures.
