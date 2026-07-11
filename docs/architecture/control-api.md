# Local Control API

The CLI talks to the running daemon through an authenticated loopback API.
Except for health, every control route requires:

~~~text
X-Hunsu-Bridge-Control-Token: <credential>
~~~

The control token is generated during bootstrap, stored only in
credentials.json, never accepted in a URL, and never logged.

## Health

GET /health is unauthenticated and returns only safe service identity:

~~~json
{
  "ok": true,
  "service": "hunsu-bridge",
  "version": "0.2.0-next.0",
  "protocolVersion": "local-bridge-v1"
}
~~~

It does not expose PIDs, paths, provider state, Workspace state, account
identity, or credentials.

## Control routes

~~~text
GET    /v1/control/status

GET    /v1/control/provider
PUT    /v1/control/provider
POST   /v1/control/provider/check

GET    /v1/control/workspaces
POST   /v1/control/workspaces
GET    /v1/control/workspaces/:id
DELETE /v1/control/workspaces/:id
PUT    /v1/control/workspaces/:id/remote-access

POST   /v1/control/pair
POST   /v1/control/workspaces/:id/pair

POST   /v1/control/login
POST   /v1/control/logout

GET    /v1/control/remote
POST   /v1/control/remote/enable
POST   /v1/control/remote/disable

POST   /v1/control/shutdown
~~~

Unknown, missing, or invalid credentials fail with
BRIDGE_CONTROL_UNAUTHORIZED. An offline endpoint fails at the client boundary
with BRIDGE_NOT_RUNNING or BRIDGE_CONTROL_UNAVAILABLE.

Browser-facing /api routes use a separate, short-lived pairing credential.
CLI commands do not call those compatibility routes, and domain services do
not depend on either API shape.

The `remote-access` body is `{ enabled, scopes }`. New Workspaces default to
disabled with no scopes. Remote Relay registration and command routing include
only explicitly enabled Workspaces with `remoteRelay.access`; revocation is
persisted before the next outbound registration.
