# Hunsu Bridge CLI

The hunsu-bridge executable is a finite client of the running daemon, except
for explicit development, daemon, setup, and service lifecycle commands.

## Output contract

Every finite command supports human output and --json. JSON mode writes exactly
one result to stdout:

~~~ts
type BridgeCliResult<T = unknown> =
  | {
      schema: "hunsu.bridge.cli-result.v1";
      ok: true;
      code: "OK" | string;
      message: string;
      value?: T;
    }
  | {
      schema: "hunsu.bridge.cli-result.v1";
      ok: false;
      code: string;
      message: string;
      recovery?: {
        command?: string;
        documentation?: string;
      };
    };
~~~

Diagnostics go to stderr. Neither stream may contain a credential or
token-bearing URL.

## Commands

~~~text
hunsu-bridge setup [--channel next] [--json]
hunsu-bridge remove [--json]
hunsu-bridge remove --delete-data --confirm-delete-data [--json]

hunsu-bridge service install|uninstall|start|stop|restart|status [--json]

hunsu-bridge dev [--host 127.0.0.1] [--port 0] [--home <path>] [--json]
hunsu-bridge daemon

hunsu-bridge status [--json]
hunsu-bridge doctor [--json]
hunsu-bridge logs [--follow] [--json]

hunsu-bridge provider list|status [--json]
hunsu-bridge provider set codex [--binary <path>] [--home <path>] [--json]
hunsu-bridge provider check|reset codex [--json]

hunsu-bridge workspace add <path> [--json]
hunsu-bridge workspace list [--json]
hunsu-bridge workspace inspect|remove|open <workspace-id> [--json]
hunsu-bridge workspace grant <workspace-id> [--scopes <csv>] [--json]
hunsu-bridge workspace revoke <workspace-id> [--json]

hunsu-bridge credential rotate [--json]

hunsu-bridge pair [--workspace <workspace-id>] [--json]
hunsu-bridge open [--workspace <workspace-id>] [--json]

hunsu-bridge login|logout [--json]
hunsu-bridge remote enable|disable|status [--json]
~~~

status, doctor, provider, workspace, credential, pair, open, login, logout, remote, and
logs never start a daemon. Offline client commands return:

~~~json
{
  "schema": "hunsu.bridge.cli-result.v1",
  "ok": false,
  "code": "BRIDGE_NOT_RUNNING",
  "message": "Start Hunsu Bridge with `hunsu-bridge service start`."
}
~~~

`doctor` is the intentionally designed read-only exception: while the daemon
is offline it returns sanitized filesystem and service recovery metadata, but
it does not write state or start a process. Removal preserves config,
Workspaces, and credentials by default. Destructive removal requires the two
explicit flags above and a matching verified runtime record; it refuses
protected filesystem locations.

pair JSON always omits the sensitive URL. open passes it only to the local
browser launcher; logs and diagnostics never receive it.
credential rotate authenticates through the running daemon, immediately
revokes the old control credential, and emits only safe rotation metadata.
It does not invalidate the separate active browser pairing credential.
