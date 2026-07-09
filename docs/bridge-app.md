# Hunsu Bridge App

Hunsu Bridge App is the small companion app that connects local workspaces to
Hunsu Studio. It is not an IDE and it does not replace Studio.

## Primary User Path

```text
Install Hunsu Bridge App
Open the app
Confirm Codex is ready
Add or activate a workspace
Open Studio
```

The first screen should make the local flow obvious:

```text
Codex Runtime
Workspaces
```

The advanced developer fallback remains:

```sh
npx @hunsu/bridge@latest
```

Headless machines use the same foundation through the command surface:

```sh
hunsu-bridge login
hunsu-bridge codex status
hunsu-bridge codex login --device
hunsu-bridge remote status
hunsu-bridge projects grant /path/to/project
hunsu-bridge start --remote
hunsu-bridge service install
```

Browser and Studio handoff use the app protocol surface:

```text
hunsu://open
hunsu://pair?next=/studio
hunsu://codex
hunsu://workspaces
hunsu://add-roadmap
hunsu://open-project?path=/path/to/project
hunsu://open-roadmap?roadmapId=<id>
hunsu://sign-in
hunsu://sign-out
hunsu://remote-disable
```

## Responsibilities

Hunsu Bridge App owns local runtime supervision:

- start, stop, restart, and report local Bridge health
- open Studio with a fresh pairing token
- handle `hunsu://` browser handoff links
- show Codex and Workspaces as the primary app surfaces
- keep Settings, Diagnostics, Logs, and Advanced as secondary footer or overflow
  actions
- keep Remote Access hidden by default unless a feature flag, sign-in state, or
  Advanced panel makes it relevant
- check Codex CLI readiness without reading Codex credential files
- inspect selected folders through Project Finder
- add, activate, deactivate, and remove managed Workspaces
- open existing Hunsu Roadmaps
- port Git projects into Hunsu
- create Workspaces in new folders
- expose diagnostics for support
- hold account/device state for Remote Access
- persist Project Grants and no-GUI service state with strict file permissions
  until platform installers own those native stores

## App Information Architecture

Bridge App is a local readiness companion, not an admin console. The primary
screen should show Bridge health, Studio handoff, Codex readiness, and active
Workspaces without requiring users to understand Bridge internals.

Primary sections:

- Codex
- Workspaces

Secondary actions:

- Settings
- Diagnostics
- Logs
- Advanced

Remote Access lives under Advanced or workspace details until the remote feature
is ready for ordinary users. It should not be a top-level tab during first-run
or local-only usage.

## Desktop Shell

`apps/bridge-desktop` contains the product desktop layer:

- a Tauri shell scaffold under `src-tauri/`
- a small desktop status window maintained from `src-ui/` and built into
  `dist-ui/` for packaging; it polls live status, recent projects,
  selected-folder inspection, diagnostics, and logs
- a native folder picker command for macOS, Windows, and Linux GUI
- `hunsu://` protocol registration through macOS `Info.plist`, a Windows WiX
  registry fragment, and a Linux user-level `.desktop`/`xdg-mime` handler
- a supervised sidecar process that restarts a crashed Bridge daemon and writes
  structured logs

Build commands:

```sh
pnpm --filter @hunsu/bridge-desktop build
pnpm --filter @hunsu/bridge-desktop desktop:build
```

`build` compiles the headless command package, bundles the sidecar entrypoint,
creates a Node SEA blob, downloads the pinned Node runtime archives for each
configured Tauri sidecar target, verifies them against Node's
`SHASUMS256.txt`, injects the SEA blob with `postject`, and writes native
ELF/Mach-O/PE sidecar artifacts plus `dist/sidecar-manifest.json`. The packaged
sidecar is a native executable and does not require `node` on the installed
user's `PATH`.

`desktop:build` requires Rust/Cargo plus platform Tauri dependencies. The
TypeScript sidecar/headless package can be built and tested without those native
toolchains.

The Tauri shell ships with an explicit CSP. Browser JavaScript is loaded from a
bundled app script, and native command invocation is allowlisted to known Bridge
App commands. Unsupported `hunsu://` commands are rejected instead of being
passed to the sidecar.

Studio remains the main product UI for Roadmaps, Execute, Hunsu Drafts,
Artifact Actions, and Hub.

## Codex Runtime

Codex is an external prerequisite runtime. Bridge App starts and remains useful
when Codex is missing: local Bridge pairing, Project Finder, Workspace activation,
Hub, and non-Execute Studio flows still work.

The Codex card owns the runtime setup flow:

- Not found: show Install Codex, Select existing Codex, and Recheck.
- Login required: show Sign in, Use device code, and Recheck.
- Ready: show safe access/version summary, Recheck, and Change Codex path.
- Rate limited: show Temporarily unavailable and Recheck.
- Error: show Recheck and a diagnostics affordance without credential material.

Advanced details such as binary path, source, raw rate-limit labels, last run
usage, app-server details, and environment variables stay collapsed by default.

Codex resolution order is:

1. user-configured custom Codex path
2. `HUNSU_CODEX_BINARY_PATH`
3. `HUNSU_CODEX_APP_SERVER_COMMAND`
4. Bridge App process `PATH`
5. Windows user `PATH` from the registry
6. Windows machine `PATH` from the registry
7. `where.exe codex`
8. PowerShell `Get-Command codex -All`
9. known install directories such as
   `%LOCALAPPDATA%\OpenAI\Codex\bin\*\codex.exe`
10. WindowsApps alias detection at
    `%LOCALAPPDATA%\Microsoft\WindowsApps\codex.exe`

Bridge App may run `codex --version`, `codex app-server --stdio`, and Codex
app-server account/rate-limit requests. It must not read `~/.codex/auth.json`,
token files, OpenAI API keys, or credential stores directly. Diagnostics include
safe readiness fields such as installed/version/source/app-server/auth/access
state, and redact token-like values.

Every discovered candidate must pass both `codex --version` and
`codex app-server --stdio` probing before Bridge App treats it as usable. If
Windows discovery finds only an App Execution Alias or another non-usable
candidate, Bridge App should recommend Select existing Codex instead of
presenting only Install Codex.

Windows copy for that state:

```text
Codex works in your terminal, but Hunsu Bridge App cannot find it.

This can happen when Windows resolves `codex` through an App Execution Alias or
a shell-specific PATH that desktop apps do not inherit.

Select the real codex.exe file or restart Hunsu Bridge App after updating PATH.
```

## Project Finder

Project Finder classifies selected folders as:

- Existing Hunsu Roadmap: primary action `Activate workspace`
- Git project not yet ported: primary action `Port into Hunsu`
- Empty or new project folder: primary action `Create workspace`
- Unsupported folder: primary action `Explain problem`
- Missing recent path: unhealthy recent project with remove/repair recovery

Inspection is a Bridge API primitive so the Bridge App, Studio, and headless
commands can share classification rules.

## Workspaces

Bridge App uses Workspaces as the user-facing label. The internal model can
remain Roadmaps.

Bridge App manages Workspaces through Add workspace, Activate, Deactivate, and
Remove. Remove only deletes the Bridge registry entry; it does not delete local
files.

Active Workspaces are the default list. Inactive Workspaces are collapsed or
secondary. Full repository paths, health details, Project Grant scopes, Remote
Access scopes, last-opened timestamps, and per-workspace Codex details stay
behind expanded details.

Studio consumes active Workspaces from Bridge by default. Inactive Workspaces
remain visible in Bridge App but are hidden from Studio navigation and are not
Remote Access candidates until activated again.

## Secondary UI

Settings, Diagnostics, Logs, and Advanced are available but not part of the
first-run path.

Diagnostics default actions:

- Copy diagnostics
- Open logs

Raw diagnostic JSON is shown only from Advanced details.

Settings default actions:

- Codex binary path
- Reset Codex path
- Bridge startup

Advanced settings may include environment variables, service install, protocol
handler repair, Project Grants, and Remote Access.

## Connection Center

Studio always shows Bridge connection state at the bottom of the left
navigation. The card opens Connection Center.

Connection Center shows:

- connection mode: Local direct, Remote relay, or Not connected
- Bridge name, version, protocol version, started time, and last seen time
- Web account and Bridge account relationship
- current Project Grant status
- registered Remote Bridge devices with online/offline state
- recovery actions: Open Hunsu Bridge App, Download Hunsu Bridge App,
  Reconnect, Pair again, Sign in, Sign out, Disable Remote Access, and Copy
  diagnostics

Advanced terminal instructions remain available but secondary.

## Local Pairing And Security

Local Bridge binds to `127.0.0.1` by default. Protected APIs require a
short-lived pairing token and trusted Studio origin. Pairing sessions carry
issued, expiry, and revoked timestamps; Bridge App can revoke and rotate them.
`/health` is public and non-sensitive so Studio can distinguish “Bridge
reachable” from “fully paired.”

Permission layers are modeled separately:

1. Local Bridge pairing
2. Bridge device identity
3. Project Grant
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
include `health`, `connection.status`, `roadmap.registry.list`,
`roadmap.open`, `roadmap.port.inspect`, `roadmap.port.apply`,
`roadmap.create`, `execute.start`, `execute.status`,
`artifactAction.start`, `artifactAction.stop`, `agentSession.events`, and
`live.events`. `execute.start`, `artifactAction.start`, and
`artifactAction.stop` are mapped to protected Bridge API endpoints only after
Project Grant and command-scope checks pass.

Relay checks Web session, device access, device online state, Project Grant,
and command scope. Bridge checks Relay session, granted project path, allowed
command scope, and Roadmap-to-path mapping. Remote `connection.status` and
Roadmap Registry results do not expose local repository paths unless the
requested project is granted.

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
2026-07-08, this Linux workspace has not run macOS, Windows, Linux GUI,
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
