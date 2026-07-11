# Windows x64 Installed-App QA Attestation

Recorded on 2026-07-11 for the Bridge App remediation based on `main` commit
`4045b913f4b5a948b1eb30c4e2125cc87a063f89`.

## Candidate

- Candidate commit: `29bbb2d903500612b3cc6d7a5853acc267eec89c`
- Workflow: [Bridge Desktop Artifacts run 29143013811](https://github.com/lhj6102/hunsu/actions/runs/29143013811)
- Linux repository validation: passed, including TypeScript, all 449 emitted tests, and locked Rust/Tauri validation
- Windows host: GitHub-hosted Windows x64, target `x86_64-pc-windows-msvc`
- Artifact: `hunsu-bridge-windows-x64`, ID `8245874656`
- Artifact size: `25064955` bytes
- GitHub artifact digest: `sha256:0d3142388ab68a98c1e661bb3ca52dac8c60d2558ac2cc7cb2b9537aa7f44ca0`
- Artifact expiry: `2026-10-09T06:33:22Z`

## Artifact Integrity

`sha256sum -c SHA256SUMS.txt` passed for every staged file.

| File | SHA-256 |
| --- | --- |
| `SHA256SUMS.txt` | `8d0589ad1d0634f39eb88c8d2429cf890acfa5f74635589afa4f8e1fa1db87a8` |
| `nsis/Hunsu Bridge_0.1.0_x64-setup.exe` | `6e17239aa61e37007eac53f3cbef1de68cac9a829d62a8d5cd7a3a0149f2ada9` |
| `windows-managed-bridge-e2e-evidence.json` | `526a19acc4a595e909e67a22901bc4d9a2b414689d072c83a1902c7f0ecc0da0` |
| `windows-installed-app-e2e-evidence.json` | `97497a4c6f23c6ba1af7ef9d0959c06912fa1aa393c25b214e11e91ba2dc7fed` |
| `windows-installed-app-e2e-screenshot.png` | `b5aa9da0c3a57313c9cbf55643e727b072d3b46cb1874d374d2986ebb62a2748` |

Both JSON evidence files identify run `29143013811`, attempt `1`, and candidate
commit `29bbb2d903500612b3cc6d7a5853acc267eec89c`. A post-download scan found no
URL, bearer header, `hunsuBridgeToken`, `hunsuRelayToken`, `access_token`,
`refresh_token`, authorization value, or sensitive query parameter in either
evidence file.

## Managed Lifecycle Scenarios

| Scenario | Result | Native evidence |
| --- | --- | --- |
| A — existing managed daemon | Passed | Two concurrent ensure requests reused one instance with one listener, daemon, and supervisor. |
| B — Pair and Open | Passed | Pair, Open, Web, and Workspace produced four distinct rotations and one browser handoff each while reusing the daemon and supervisor. |
| C — Stop and restart | Passed | Daemon and supervisor exited, the port was released, no delayed restart occurred, and a fresh daemon started afterward. |
| D — unmanaged Hunsu daemon | Passed | Ownership was reported as unmanaged; Start and Stop were refused; the foreign daemon remained alive. |
| E — non-Hunsu conflict | Passed | A real post-discovery bind race emitted `BRIDGE_PORT_IN_USE`, exited with typed terminal code `78`, started the direct supervisor exactly once, preserved the unrelated listener, and left no supervisor or daemon. |
| F — diagnostics redaction | Passed | Fresh diagnostics, the native clipboard round trip, and persisted logs contained neither of the two synthetic raw secrets. |

## Installed-App Gate

The workflow silently installed the NSIS candidate and controlled the real Tauri
WebView2 surface through CDP. All 18 recorded checks passed, including:

- connected-managed, stopped, restarted, and remains-stopped transitions;
- lifecycle-aware Start and Stop controls;
- one Open Hunsu Web handoff and one exact-Workspace handoff;
- live vulnerable-build pairing revocation;
- fresh diagnostics copy through the native Windows clipboard with token redaction;
- no `EADDRINUSE` log, sidecar console window, WebView page error, or console error;
- visible Validate, Recheck, provider-prerequisite, and distinct version feedback;
- configured-port conflict guidance that points to the Connection section and Start Bridge;
- a visibly selected Runtime Providers tab, no redundant global Remote Access controls,
  exactly one applicable Workspace Remote Access action, and one Git diagnostic label.

The installed-app evidence records Bridge App `0.1.0`, Bridge runtime `0.1.2`,
protocol `local-bridge-v1`, embedded Node `v22.22.0`, and fixture Codex CLI
`codex-qa 0.0.0` as distinct values.

## Independent Visual Evidence

The machine-readable review record
[`windows-x64-installed-app-29143013811-visual-review.json`](windows-x64-installed-app-29143013811-visual-review.json)
binds the review to the workflow run, candidate commit, artifact ID and digest,
and screenshot SHA-256. It records:

- review time `2026-07-11T06:47:41Z`;
- fresh context-free reviewer `/root/windows_visual_review_29143013811`;
- the complete visual rubric; and
- exact verdict `VISUAL PASS`.

## Release Status

This attestation does not claim the remaining human release decision:

- `automatedInstalledAppQa`: `passed`
- `independentVisualEvidenceQa`: `passed`
- `manualVisualQa`: `required`
- `releaseEligible`: `false`

Human installed-app visual QA remains a prerequisite, and no dogfood installer
was published by this remediation task.
