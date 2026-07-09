# Headless Service

Bridge App installs user-scoped service artifacts by default:

- Linux: `systemd --user` unit at `~/.config/systemd/user/hunsu-bridge.service`
- macOS: launchd user agent at `~/Library/LaunchAgents/app.hunsu.bridge.plist`
- Windows: current-user Scheduled Task at login that runs an env-preserving
  startup script under the user's roaming app data

System-level service commands are an advanced fallback and require
`hunsu-bridge service install --system`.

## Commands

```sh
hunsu-bridge service status
hunsu-bridge service install --cwd /path/to/project
hunsu-bridge service install --dry-run
hunsu-bridge service uninstall
hunsu-bridge service start
hunsu-bridge service stop
```

Generated systemd, launchd, and Windows startup artifacts include non-secret
provider environment from Bridge App state, including configured Codex binary
path, Codex home, app server command/args, Bridge App state path, Roadmap
registry path, and app log path. Secret provider fields are not written into
the service artifacts.

The service runs `hunsu-bridge supervise --cwd <path>`, which launches the Bridge
sidecar with the same provider configuration used by the interactive desktop app.
