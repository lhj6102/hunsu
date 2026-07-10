# Windows Packaging

The Bridge desktop bundle packages the active native sidecar through Tauri
`externalBin` and keeps `resources` limited to `sidecar-manifest.json`. Do not add
`../dist/hunsu-bridge-sidecar*` back to resources; that wildcard causes every
prepared sidecar target to be copied into the installer payload.

The desktop artifact workflow defaults to one Windows x64 dogfood job.
`windows-arm64` selects only Windows ARM64, `windows-all` selects both Windows
targets, and `all` explicitly selects the full six-target desktop matrix. Each
matrix entry verifies the target sidecar path, builds the native bundle with
`HUNSU_BRIDGE_SIDECAR_TARGET` set to that matrix target, and then runs exactly
one native `status` smoke test with a 60-second timeout. Runtime smoke testing is
never part of the Tauri `beforeBuildCommand` or native-sidecar preparation path.

Dogfood jobs stage only installable outputs and a matching `SHA256SUMS.txt`:

- Windows: `bundle/nsis/*.exe`
- macOS: `bundle/dmg/*.dmg`
- Linux: `bundle/deb/*.deb` and `bundle/appimage/*.AppImage`

The checksum entries are relative to the staged artifact, so every referenced
file is present in the downloaded archive. Full recursive bundle outputs and
unpacked application directories are not uploaded for dogfood runs.

The explicit `all` selection also runs the target-aware size report:

```sh
pnpm --filter @hunsu/bridge-desktop artifacts:report-sizes -- --target x86_64-pc-windows-msvc
```

That report is written to
`apps/bridge-desktop/src-tauri/target/release/bundle/artifact-size-report.json`
and is staged with the installable artifact for full-matrix runs.
The report reads `dist/sidecar-manifest.json` and fails unless it names exactly
one staged sidecar matching the requested target.

Build jobs have a 60-minute hard timeout. Workflow-level concurrency cancels an
obsolete run for the same branch and platform selection. pnpm, target-specific
Cargo output, and the pinned target Node archive use separate caches; cached
Node archives are still checked against the pinned Node release SHA-256 list
before reuse.

The desktop application commits `src-tauri/Cargo.lock` so local and GitHub
builds resolve the same Rust dependency graph. Before pushing desktop Rust
changes, run the lightweight source gate:

```sh
pnpm run check:desktop-rust
```

This checks Rust formatting and runs `cargo check --locked`; the artifact
workflow still performs only one full Cargo/Tauri build. During prototype
dogfooding, the target-specific Rust cache may be saved after a failed compile
so a source-only correction can reuse already compiled dependencies.

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
subsystem check for every Windows build and the artifact-size report for
explicit full-matrix builds.

Windows defaults to current-user startup for the Bridge service command surface.
Use `hunsu-bridge service install --system` only for explicit system service
debugging or administrator-managed deployments.

The Windows NSIS bundle also installs in current-user mode. Its pre-install and
pre-uninstall hooks use Tauri's current-user process check for both the desktop
executable and `hunsu-bridge-sidecar.exe`. This stops the background supervisor
and daemon before NSIS replaces or removes the packaged sidecar, avoiding
locked-file failures when a user upgrades while the Bridge remains in its
default keep-background mode.

Each Windows artifact job exercises that contract with a silent install,
launches the installed sidecar, silently reinstalls over the locked executable,
then launches it again and silently uninstalls. Artifact staging runs only after
that reinstall/uninstall smoke succeeds.
