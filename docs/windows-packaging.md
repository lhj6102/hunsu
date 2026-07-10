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
The Windows x64 job then runs the managed-runtime lifecycle E2E before staging
or uploading the installer; ARM64 and non-Windows jobs do not run that x64 gate.

Dogfood jobs stage installable outputs and a matching `SHA256SUMS.txt`:

- Windows: `bundle/nsis/*.exe`
- macOS: `bundle/dmg/*.dmg`
- Linux: `bundle/deb/*.deb` and `bundle/appimage/*.AppImage`

The gated Windows x64 artifact also includes
`windows-managed-bridge-e2e-evidence.json` and
`windows-installed-app-e2e-evidence.json`. The evidence contains only passing
scenario flags and check names—never browser URLs or runtime credentials—and
both files are included in `SHA256SUMS.txt`. Other targets do not stage these
Windows-only files.

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

## Managed Bridge QA gate

Do not publish a dogfood installer unless the Windows x64 packaged sidecar
passes the managed-runtime gate before its installer is staged. The script uses
an isolated state directory and creates a disposable fixture Workspace when
`-WorkspaceFixture` is omitted:

```powershell
pwsh -File apps/bridge-desktop/scripts/windows-managed-bridge-e2e.ps1 `
  -SidecarPath .\hunsu-bridge-sidecar.exe `
  -EvidencePath .\windows-managed-bridge-e2e-evidence.json
```

Pass `-WorkspaceFixture C:\path\to\fixture-roadmap` only when deliberately
testing a dedicated existing fixture; the command may initialize it as a Hunsu
Roadmap. The script parses every concurrent `ensure-running` result, enumerates
exactly one matching supervisor and daemon, and counts exactly one captured
browser handoff for Pair, Open, Open Hunsu Web, and Workspace Open. It also
verifies authenticated Stop without supervisor restart, unmanaged-daemon
refusal, and a non-Hunsu port conflict without a lingering or restarting
sidecar. Fresh Diagnostics are copied through the Windows clipboard and checked,
along with the app log, for every captured runtime credential. The optional
evidence file records safe per-scenario results; the Windows x64 artifact job
always emits and checksum-stages it.

The same Windows x64 job then silently installs the built NSIS candidate into an
isolated temporary directory and attaches Playwright over a test-only WebView2
CDP port. This installed-app gate exercises the actual Tauri WebView and bundled
sidecar: lifecycle button states and transitions, one Open Hunsu Web handoff,
one fixture Workspace Open handoff, fresh copied/displayed Diagnostics,
legacy-token migration, an EADDRINUSE-free app log, Validate and Recheck
feedback, and all five version labels. It uninstalls the candidate and removes
its isolated runtime state afterward. The resulting evidence deliberately keeps
`releaseEligible` false until the following human visual QA is attested; an
Actions candidate artifact is not a dogfood release.

After both automated gates pass, manually verify the installed app shell:

- Connected/managed disables Start and enables Stop.
- Stop reaches Not running, releases the configured Bridge port, and remains stopped.
- Start returns to Connected with one daemon and one supervisor.
- Open Hunsu Web and Workspace Open each open one expected browser tab.
- Diagnostics and copied Diagnostics contain no bearer value.
- Validate and Recheck show pending and terminal feedback.
- App, runtime, protocol, embedded Node, and Codex versions are distinct and understandable.
