# Windows Packaging

The Bridge desktop bundle packages the active native sidecar through Tauri
`externalBin` and keeps `resources` limited to `sidecar-manifest.json`. Do not add
`../dist/hunsu-bridge-sidecar*` back to resources; that wildcard causes every
prepared sidecar target to be copied into the installer payload.

The desktop artifact workflow builds Windows x64 and Windows ARM64 release
artifacts where GitHub-hosted runners are available. Each matrix entry verifies
the target sidecar path, builds the native bundle, writes checksums, lists
bundle outputs, and runs:

```sh
pnpm --filter @hunsu/bridge-desktop artifacts:report-sizes
```

The size report is written to
`apps/bridge-desktop/src-tauri/target/release/bundle/artifact-size-report.json`
and is uploaded with the bundle artifacts.

The packaging tests assert that `externalBin` is `../dist/hunsu-bridge-sidecar`,
`resources` contains only `../dist/sidecar-manifest.json`, and sidecar resources
are not duplicated through both fields. Local Linux tests do not inspect the
contents or size of a real Windows installer; the CI artifact-size report is the
release evidence for built installers.

Windows defaults to current-user startup for the Bridge service command surface.
Use `hunsu-bridge service install --system` only for explicit system service
debugging or administrator-managed deployments.
