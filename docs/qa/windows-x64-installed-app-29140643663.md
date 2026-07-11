# Windows x64 Installed-App QA Attestation

Recorded on 2026-07-11 for the Bridge App remediation based on `main` commit
`4045b913f4b5a948b1eb30c4e2125cc87a063f89`.

## Candidate

- Candidate commit: `55426874276b2011fe1c74aa6bbad672f0f53e0f`
- Workflow: [Bridge Desktop Artifacts run 29140643663](https://github.com/lhj6102/hunsu/actions/runs/29140643663)
- Linux repository validation: passed, including TypeScript, the complete test suite, and locked Rust validation
- Windows host: GitHub-hosted Windows x64, target `x86_64-pc-windows-msvc`
- Artifact: `hunsu-bridge-windows-x64`, ID `8245078964`
- Artifact size: `25059696` bytes
- GitHub artifact digest: `sha256:f70f076c4fd6993f1ae0f506ea115204e6c2dc6eba1232315e5d49ddc1b371cf`
- Artifact expiry: `2026-10-09T05:05:02Z`

## Artifact Integrity

`sha256sum -c SHA256SUMS.txt` passed for every staged file.

| File | SHA-256 |
| --- | --- |
| `SHA256SUMS.txt` | `2a47d06ed5085582e34061dc9a426a59a1cb8d1084fbd348a3d73dd8226fb0ec` |
| `nsis/Hunsu Bridge_0.1.0_x64-setup.exe` | `2523616e5808aefffa3886e0b13069ac5deafa031c4ec67581b021993ca60ddc` |
| `windows-managed-bridge-e2e-evidence.json` | `e33b74294020a68a9efeca770387915ed17c59b3ffa74e927b0e3c5dcd7f3220` |
| `windows-installed-app-e2e-evidence.json` | `fb85593f85c932f42a5f83d823424938b487baee5154d08e69da7e4628929412` |
| `windows-installed-app-e2e-screenshot.png` | `f3ac117ca144bafe16d3afdbabd47ac9d5cc7cb8962d7e2ab56286e58dd4ddf8` |

Both JSON evidence files identify run `29140643663`, attempt `1`, and candidate
commit `55426874276b2011fe1c74aa6bbad672f0f53e0f`. A post-download scan found no
URL, bearer header, `hunsuBridgeToken`, `hunsuRelayToken`, `access_token`,
`refresh_token`, or authorization value in either evidence file.

## Managed Lifecycle Scenarios

| Scenario | Result | Native evidence |
| --- | --- | --- |
| A — existing managed daemon | Passed | Two concurrent ensure requests reused one instance with one listener, daemon, and supervisor. |
| B — Pair and Open | Passed | Pair, Open, Web, and Workspace produced four distinct rotations and one browser handoff each while reusing the daemon and supervisor. |
| C — Stop and restart | Passed | Daemon and supervisor exited, the port was released, no delayed restart occurred, and a fresh daemon started afterward. |
| D — unmanaged Hunsu daemon | Passed | Ownership was reported as unmanaged; Start and Stop were refused; the foreign daemon remained alive. |
| E — non-Hunsu conflict | Passed | `BRIDGE_PORT_IN_USE` was returned, the unrelated listener survived, and no Bridge supervisor or daemon lingered. |
| F — diagnostics redaction | Passed | Fresh diagnostics, the native clipboard round trip, and persisted logs contained neither of the two synthetic raw secrets. |

## Installed-App Gate

The workflow silently installed the NSIS candidate and controlled the real Tauri
WebView2 surface through CDP. All 18 recorded checks passed, including:

- connected-managed, stopped, restarted, and remains-stopped transitions;
- lifecycle-aware Start and Stop controls;
- one Open Hunsu Web handoff and one exact-Workspace handoff;
- live vulnerable-build pairing revocation;
- fresh diagnostics copy through the native Windows clipboard with token redaction;
- no `EADDRINUSE` log, no sidecar console window, and no WebView page or console error;
- visible Validate, Recheck, provider-prerequisite, and distinct version feedback;
- configured-port conflict guidance that points to the Connection section and Start Bridge;
- a visibly selected Runtime Providers tab, no redundant global Remote Access controls,
  exactly one applicable Workspace Remote Access action, and one Git diagnostic label.

The installed-app evidence records Bridge App `0.1.0`, Bridge runtime `0.1.2`,
protocol `local-bridge-v1`, embedded Node `v22.22.0`, and the fixture Codex CLI
version as distinct values.

## Visual Evidence And Release Status

A fresh independent screenshot-only review of
`windows-installed-app-e2e-screenshot.png` returned exactly `VISUAL PASS`. This
review confirmed readable layout, visible recovery guidance, selected navigation,
non-duplicated Remote Access actions, concise Git/provider copy, understandable
runtime/version labels, and no visible credential.

This attestation does not claim the remaining human release decision:

- `automatedInstalledAppQa`: `passed`
- `manualVisualQa`: `required`
- `releaseEligible`: `false`

Human installed-app visual QA remains a prerequisite, and no dogfood installer
was published by this remediation task.
