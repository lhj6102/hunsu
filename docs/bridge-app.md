# Hunsu Bridge App

Hunsu Bridge App is the small companion app that connects local workspaces to
Hunsu Studio. It is not an IDE and it does not replace Studio.

## Primary User Path

```text
Install Hunsu Bridge App
Open the app
Choose or create a project
Hunsu Bridge starts locally
Studio opens in the browser
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
```

Browser and Studio handoff use the app protocol surface:

```text
hunsu://open
hunsu://pair?next=/studio
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
- inspect selected folders through Project Finder
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
- a small desktop status window under `dist-ui/` that polls live status,
  recent projects, selected-folder inspection, diagnostics, and logs
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

Studio remains the main product UI for Roadmaps, Execute, Hunsu Drafts,
Artifact Actions, and Hub.

## Project Finder

Project Finder classifies selected folders as:

- Existing Hunsu Roadmap: primary action `Open in Studio`
- Git project not yet ported: primary action `Port into Hunsu`
- Empty or new project folder: primary action `Create Roadmap`
- Unsupported folder: primary action `Explain problem`
- Missing recent path: unhealthy recent project with remove/repair recovery

Inspection is a Bridge API primitive so the Bridge App, Studio, and headless
commands can share classification rules.

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
command scope, and Roadmap-to-path mapping.

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
