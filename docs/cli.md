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

In JSON mode, expected product failures still write exactly one result to
stdout, keep stderr empty, and exit nonzero. Unexpected process diagnostics may
use stderr after sanitization. Neither stream may contain a credential or
token-bearing URL.

## Commands

~~~text
hunsu-bridge setup [--profile production] [--channel next] [--runtime-package <absolute.tgz>] [--json]
hunsu-bridge setup --profile preview [--channel candidate-next] [--runtime-package <absolute.tgz>] [--json]
hunsu-bridge remove [--json]
hunsu-bridge remove --delete-data --confirm-delete-data [--json]

hunsu-bridge service install|uninstall|start|stop|restart|status [--json]

hunsu-bridge dev [--host 127.0.0.1] [--port 0] [--home <path>] [--json]
hunsu-bridge daemon

hunsu-bridge status [--json]
hunsu-bridge doctor [--json]
hunsu-bridge logs [--follow] [--json]

hunsu-bridge provider list|status [--json]
hunsu-bridge provider set codex [--binary <path>] [--codex-home <path>] [--home <hunsu-home>] [--json]
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

Global singleton options `--home`, `--json`, `--help`, and `--version` are
accepted consistently regardless of position. `--home` always selects
`HUNSU_HOME` for the invocation. `--codex-home` selects Codex Home only and is
valid only for `provider set codex`; both options may be used together.
Duplicate singleton options and unknown options are rejected. The prerelease
does not keep the old ambiguous provider `--home` meaning as an alias.
Production setup uses the `next` channel; preview setup requires
`--profile preview` and the `candidate-next` channel.

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
it does not write state or start a process.

## Transactional setup

Setup acquires `HUNSU_HOME/runtime/setup.lock`, recovers an incomplete
`setup-transaction.json`, verifies or creates the home ownership marker, and
stages the exact runtime under `runtime/staging/<transaction-id>`. Only a
complete package with the expected name, version, Node engine, and CLI is moved
to `runtime/versions/<version>` and installed into the OS user-service
definition. Health, control authentication, version, and runtime path are
verified before `runtime/install.json` commits the CLI SHA-256. A same-version
rerun skips package staging only when the installed CLI still matches that
trusted digest; legacy records without a digest must re-establish trust from the
exact package source.

On a failed first install, setup removes the candidate service definition and
runtime while preserving config, Workspaces, and credentials. On a failed
upgrade it restores and verifies the previous definition/runtime. A successful
rollback reports `SETUP_VERIFICATION_FAILED`; an incomplete rollback reports
`ROLLBACK_FAILED` with recovery guidance. `doctor --json` reports
`SETUP_TRANSACTION_INCOMPLETE` and its safe phase when recovery is pending.

`--runtime-package` is an advanced local verification option. It accepts only
an absolute local `.tgz` whose package name and exact version match the
executing `@hunsu/bridge`. URLs, Git specs, dist-tags, ranges, arbitrary package
names, and relative paths are rejected before service activation. Normal setup
installs the executing CLI's exact registry version.

## Ownership-safe removal

Removal preserves config, Workspaces, credentials, and logs by default.
Destructive removal requires both explicit flags plus a verified
`.hunsu-bridge-home.json` whose canonical home and installation ID match
`runtime/install.json`. It deletes only the allowlisted Hunsu entries, never
recursively deletes `HUNSU_HOME`, never traverses a symlink/junction target,
and preserves unknown entries. The result reports basename-safe deleted and
preserved entries plus whether the now-empty home directory was removed.
Missing or mismatched ownership, unsafe containment, protected roots, and
ambiguous filesystem types return `BRIDGE_DATA_DELETE_REFUSED`.

pair JSON always omits the sensitive URL. open passes it only to the local
browser launcher; logs and diagnostics never receive it.
credential rotate authenticates through the running daemon, immediately
revokes the old control credential, and emits only safe rotation metadata.
It does not invalidate the separate active browser pairing credential.
