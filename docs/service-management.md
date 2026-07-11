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
cache or a relative path.

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
runtime path.

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
idempotent. A failed upgrade restores the previous service definition and
runtime version.
