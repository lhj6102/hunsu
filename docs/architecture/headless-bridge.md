# Headless Bridge Architecture

Hunsu Bridge is one long-lived, headless process:

~~~text
OS user service manager
  -> hunsu-bridge daemon
       -> local provider
       -> Workspace registry
       -> Local Bridge API and pairing
       -> optional outbound Connect signaling and direct browser peer

hunsu-bridge CLI
  -> authenticated local control API

hunsu.app
  -> browser compatibility API
~~~

The npm package remains @hunsu/bridge and the executable remains
hunsu-bridge. The package owns the daemon, CLI client, service adapters, setup,
state stores, and supported public library exports.

## Deployment profiles

The daemon has one durable `production | preview` deployment profile. This is
an environment selection, not a second npm package, daemon, service name, or
port. `config.json` is the authority and legacy v1 configuration migrates to
`production`. A populated home cannot switch profiles because its account,
device identity, and Connect credentials belong to that environment.

Installed daemons resolve Web and Connect URLs plus the environment's exact
ticket-signing public JWK from a fixed profile allowlist. Ambient variables
cannot redirect an installed service. Preview uses `preview.hunsu.app` and
`connect.preview.hunsu.app`; production uses `hunsu.app` and
`connect.hunsu.app`. Development mode retains explicit injectable adapters for
isolated local testing.

## Ownership

Production lifecycle belongs only to the operating system user service
manager: Task Scheduler on Windows, a LaunchAgent on macOS, and systemd --user
on Linux. The daemon has a fail-closed singleton lock but no restart loop or
product-owned restart manager.

The daemon is the only application-state writer. CLI mutations go through the
authenticated control API. A browser, CLI client, or future shell must not
start, restart, replace, or infer ownership of the daemon.

Only dev, daemon, setup, service start, and service restart may start a daemon.
All other commands return BRIDGE_NOT_RUNNING when the service is unavailable.

## State

HUNSU_HOME is the state-root override. Defaults are:

- Windows: %LOCALAPPDATA%\Hunsu\Bridge
- macOS: ~/Library/Application Support/Hunsu/Bridge
- Linux: ~/.local/share/hunsu/bridge

The root contains config.json, workspaces.json, credentials.json, runtime.json,
logs/bridge.jsonl, the `.hunsu-bridge-home.json` ownership marker, and
versioned stable runtime installations. Credentials and ownership/setup
metadata are user-only. Logs are sanitized before persistence and bounded by
rotation.

runtime.json is informational. Live authenticated status plus service-manager
state establishes identity and lifecycle; a PID, port, process name, state
file, or lock contents alone never prove ownership.

## Compatibility

The first 0.2 line preserves existing browser-facing /api routes as adapters
over provider, Workspace, pairing, and Remote services. The internal control
API is additive and does not leak HTTP shapes into domain services.

See [Control API](control-api.md), [Service Management](../service-management.md),
and [Web Pairing](../web-pairing.md). Credential and deletion boundaries are
specified in [Bridge Security](../security.md).
