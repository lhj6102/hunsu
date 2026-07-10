# Windows Packaging

The Bridge desktop bundle packages the active native sidecar through Tauri
`externalBin` and keeps `resources` limited to `sidecar-manifest.json`. Do not add
`../dist/hunsu-bridge-sidecar*` back to resources; that wildcard causes every
prepared sidecar target to be copied into the installer payload.

The desktop artifact workflow builds Windows x64 and Windows ARM64 release
artifacts where GitHub-hosted runners are available. Each matrix entry verifies
the target sidecar path, builds the native bundle with
`HUNSU_BRIDGE_SIDECAR_TARGET` set to that matrix target, writes checksums, lists
bundle outputs, and runs the target-aware size report:

```sh
pnpm --filter @hunsu/bridge-desktop artifacts:report-sizes -- --target x86_64-pc-windows-msvc
```

The size report is written to
`apps/bridge-desktop/src-tauri/target/release/bundle/artifact-size-report.json`
and is uploaded with the bundle artifacts.
The report reads `dist/sidecar-manifest.json` and fails unless it names exactly
one staged sidecar matching the requested target.

Release builds mark the parent Tauri executable as a Windows GUI application.
Each Windows artifact job runs `desktop:verify-windows-gui` against Cargo's
`src-tauri/target/release/hunsu-bridge.exe` output. The validator reads the PE
Optional Header directly and fails unless `Subsystem` is Windows GUI (value 2),
rather than Windows CUI (value 3).

The packaging tests assert that `externalBin` is `../dist/hunsu-bridge-sidecar`,
`resources` contains only `../dist/sidecar-manifest.json`, and sidecar resources
are not duplicated through both fields. Rust launches the packaged binary by
the configured Tauri sidecar name rather than resolving an executable from the
resource directory. Local Linux tests do not inspect the contents or size of a
real Windows installer. Windows artifact jobs provide the executable-level
subsystem check and artifact-size report for built releases.

Windows defaults to current-user startup for the Bridge service command surface.
Use `hunsu-bridge service install --system` only for explicit system service
debugging or administrator-managed deployments.
