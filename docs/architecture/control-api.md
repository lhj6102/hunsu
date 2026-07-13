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
  "version": "0.2.0-next.9",
  "protocolVersion": "local-bridge-v1",
  "deploymentProfile": "production"
}
~~~

It does not expose PIDs, paths, provider state, Workspace state, account
identity, or credentials.

## Control routes

~~~text
GET    /v1/control/status
POST   /v1/control/credential/rotate

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
`BRIDGE_CONTROL_UNAUTHORIZED`. Client probing keeps phases distinct:

- refused/timed-out loopback connection: `BRIDGE_NOT_RUNNING`;
- corrupt config/credential state or a non-loopback endpoint:
  `BRIDGE_STATE_INVALID`;
- a foreign loopback listener: `BRIDGE_PORT_IN_USE`;
- healthy Hunsu with a missing/wrong control credential:
  `BRIDGE_CONTROL_UNAUTHORIZED`;
- healthy Hunsu whose authenticated request times out or returns a malformed
  control response:
  `BRIDGE_CONTROL_UNAVAILABLE`.

Authenticated `GET /v1/control/status` includes the daemon's exact package
version and stable runtime path. Transactional setup compares both values with
the staged candidate before committing `runtime/install.json`; the
unauthenticated health route never exposes the path.

Safe state errors expose only a basename, stable code, and recovery guidance.
Offline `doctor` still returns a successful diagnostic envelope; corrupt state
appears as `BRIDGE_STATE_INVALID` issue entries without full paths or contents.

`hunsu-bridge credential rotate` authenticates with the current control
credential, atomically replaces it in `credentials.json`, and immediately
revokes the previous credential. The response exposes only stable safe metadata;
it never returns either credential. Existing browser pairing remains valid
because pairing credentials have a separate lifecycle.

~~~json
{
  "schema": "hunsu.bridge.cli-result.v1",
  "ok": true,
  "code": "CONTROL_CREDENTIAL_ROTATED",
  "message": "Hunsu Bridge control credential was rotated.",
  "value": {
    "rotated": true,
    "pairingPreserved": true
  }
}
~~~

Browser-facing /api routes use a separate, short-lived pairing credential.
CLI commands do not call those compatibility routes, and domain services do
not depend on either API shape.

The `remote-access` body is `{ enabled, scopes }`. New Workspaces default to
disabled with no scopes. Bridge exposes path-free metadata to an authenticated
peer only for Workspaces with `remote.access`; it rechecks the persisted grant
before dispatching every peer command. Connect never receives this registry or
its scopes. Revocation is persisted before the next peer request is authorized.
