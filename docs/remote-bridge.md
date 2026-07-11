# Remote Bridge

Remote access is an outbound capability of the same local daemon:

~~~text
local enabled  -> Local Bridge API
remote enabled -> Local Bridge API plus outbound authenticated Relay connection
~~~

There is no second Remote daemon or Remote process manager.

## Login

Login uses a headless-compatible device-code flow. Opening a browser is
optional; when it fails, the CLI prints a safe fallback URL and user code.
Login does not require a custom device protocol.

Account and Relay credentials are stored in the user-only credentials store
and never appear in diagnostics or logs.

## Authorization

Remote access requires:

- a signed-in Hunsu account
- a registered device identity
- an explicit Workspace grant
- an outbound-only Relay connection
- a compatible protocol version

Remote clients receive stable Workspace IDs and safe metadata. Local paths are
redacted unless the grant explicitly permits path disclosure. Relay commands
are typed and scoped; payloads cannot override the granted local path.

Grant or revoke access locally through the authenticated daemon:

~~~sh
hunsu-bridge workspace grant <workspace-id> \
  --scopes remoteRelay.access,execute.start
hunsu-bridge workspace revoke <workspace-id>
~~~

New Workspaces are ungranted. Enabling Remote publishes only active persisted
grants; canonical path and command-scope checks are repeated inside the daemon
before a Relay command reaches local services.

The daemon owns Remote enable, disable, status, credential updates, grants, and
reconnect state. The CLI mutates them through the authenticated local control
API.

Normal integration tests use the deterministic fake Relay and require no cloud
credential. Production Relay, login, and one explicitly granted test Workspace
are release-promotion gates.
