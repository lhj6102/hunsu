# Service Management

The operating system user service manager is the only production owner of the
Hunsu Bridge daemon.

~~~text
Windows  -> Task Scheduler user task named Hunsu Bridge
macOS    -> ~/Library/LaunchAgents/app.hunsu.bridge.plist
Linux    -> ~/.config/systemd/user/hunsu-bridge.service
~~~

Service definitions use absolute paths to the selected Node executable and the
versioned stable @hunsu/bridge runtime. They never execute code from an npm
cache or a relative path. The same fixed service identity and port `19687` are
used for both deployment profiles; each definition carries
`--profile production|preview` so a restart cannot silently change targets.

## Lifecycle

~~~sh
hunsu-bridge service install --json
hunsu-bridge service start --json
hunsu-bridge service status --json
hunsu-bridge service restart --json
hunsu-bridge service stop --json
hunsu-bridge service uninstall --json
~~~

service status works while the daemon is offline. It combines manager state,
health, authenticated status when available, installed version, and configured
runtime path and deployment profile.

Stop first requests authenticated /v1/control/shutdown and waits for health to
disappear. If the daemon is unresponsive, the adapter stops only its exact
owned task or unit. It never kills by process name, port, or unverified PID.

## Platform contracts

Windows uses a current-user scheduled task, starts at logon without
administrator rights, hides the console window, and runs the daemon directly.

macOS uses RunAtLoad plus KeepAlive-on-crash and redirects output to
HUNSU_HOME/logs.

Linux uses Restart=on-failure and systemctl --user daemon-reload plus enable.
The explicit setup or service start step then starts the unit; service install
alone does not violate the no-implicit-startup contract by using --now.

The daemon has no internal restart loop. A second daemon fails with
BRIDGE_ALREADY_RUNNING; a foreign listener fails with BRIDGE_PORT_IN_USE.

## Stable runtime setup

npx @hunsu/bridge@next setup installs the exact package version under
HUNSU_HOME/runtime/versions, installs or repairs the service definition, starts
it, and verifies health plus authenticated status. Re-running setup is
idempotent and cannot create a second daemon.

Preview QA installs the canonical candidate with:

~~~sh
npx @hunsu/bridge@candidate-next setup --profile preview
~~~

The selected profile is written to `config.json`, `runtime/install.json`, the
OS service arguments, runtime identity, health, and authenticated control
status. Legacy v1 configuration migrates explicitly to `production`. Setup
fails before credential or service mutation if a populated home is already
bound to the other profile.

Setup is a serialized side-by-side transaction:

1. acquire `HUNSU_HOME/runtime/setup.lock`;
2. bind and verify the durable deployment profile;
3. recover any incomplete `setup-transaction.json`;
4. verify the home ownership marker and ensure control credentials;
5. install into `runtime/staging/<transaction-id>` and verify the exact package;
6. atomically move the candidate to `runtime/versions/<version>`;
7. switch the service definition to stable absolute Node and CLI paths;
8. start and verify health, authentication, version, runtime path, and profile;
9. atomically commit `runtime/install.json` with the verified CLI SHA-256, then
   clear the journal and lock.

Same-version setup reuses the stable runtime only when the current CLI bytes
match that persisted digest. A mismatch stages the exact package again,
atomically repairs the version directory, and restarts the daemon before health
verification. Legacy `runtime-install.v1` records migrate as untrusted rather
than deriving trust from whatever CLI bytes happen to be present; the next
successful exact-package setup commits `runtime-install.v2`.

An initial-install failure stops and uninstalls the service and removes only
the failed candidate runtime. Config, Workspaces, and credentials remain. An
upgrade failure restores the previous service definition, starts it, verifies
it, and restores the previous install record. `ROLLBACK_FAILED` means an
invariant could not be restored and includes explicit recovery guidance;
otherwise the original candidate failure is returned after rollback.

Normal setup uses the executing CLI's exact registry version. The advanced
`--runtime-package <absolute.tgz>` option exists for local tarball verification
and is never written as a dist-tag, range, URL, Git spec, or npm-cache service
path.
