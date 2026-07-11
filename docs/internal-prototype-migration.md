# Internal Desktop Prototype Migration

The deprecated desktop prototype is preserved only in Git:

- branch `archive/tauri-bridge-prototype-0.1.1`
- tag `tauri-bridge-prototype-0.1.1-final`

Internal testers upgrading a machine that ran the prototype can preview the
bounded cleanup scripts:

```sh
sh scripts/maintenance/remove-desktop-preview.sh
pwsh -File scripts/maintenance/remove-desktop-preview.ps1
```

After reviewing every exact target, apply the cleanup with `--apply` on
Linux/macOS or `-Apply` on Windows. The scripts act only on known prototype
service, task, executable, app-bundle, and protocol-registration paths. They do
not infer ownership from a PID, port, or process basename.

The scripts do not read or remove credentials, Workspace data, configuration,
runtime state, or logs. Normal headless setup never invokes them, and they are
outside the published `@hunsu/bridge` package.
