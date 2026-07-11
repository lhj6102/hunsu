# Windows x64 Installed-App QA Attestation

Recorded on 2026-07-11 for the managed-startup and diagnostics-clipboard
follow-up fixes.

## Candidate

- Candidate commit: `3df55aa058736baacf6635515112ccd6f165ffd3`
- Workflow: [Bridge Desktop Artifacts run 29147290486](https://github.com/lhj6102/hunsu/actions/runs/29147290486), attempt `1`
- Workflow window: `2026-07-11T09:10:04Z` through `2026-07-11T09:22:46Z`
- Linux repository validation: passed, including TypeScript, all 458 emitted tests, Rust formatting, and locked Rust/Tauri validation
- Windows host: `Microsoft Windows NT 10.0.26100.0`, runner image `win25-vs2026`, target `x86_64-pc-windows-msvc`
- Artifact: `hunsu-bridge-windows-x64`, ID `8247220443`
- Artifact size: `25065843` bytes
- GitHub artifact digest: `sha256:2e3523cdf3684ddd0c7ff9672db8fbdeed6c0ad25f24c3f0b96e08bc2a8e1ce9`
- Artifact expiry: `2026-10-09T09:10:05Z`

## Artifact Integrity

`sha256sum -c SHA256SUMS.txt` passed for every staged file.

| File | SHA-256 |
| --- | --- |
| `SHA256SUMS.txt` | `62aac066a2e0177593e6e439481d34893a4b7e12038c471253f7fcd875032dae` |
| `nsis/Hunsu Bridge_0.1.0_x64-setup.exe` | `200ebc9d7c5ce95e0d64772f4d42eb9eb877a4ecd78865db2f8cbe10c3fb378c` |
| `windows-managed-bridge-e2e-evidence.json` | `7579d23c6baca7a306999161deb547c296b9bede92385f0b9fb534dc888dd312` |
| `windows-installed-app-e2e-evidence.json` | `c579be15dab0ec4ac067a901f38358b0b00c1c8446bbfafb2624f6a43308468d` |
| `windows-installed-app-e2e-screenshot.png` | `22a421ba5d4cc9dd2162eba18697450f0ebdcff30598b1e5d213e02ec554b3c3` |

Both JSON evidence files identify run `29147290486`, attempt `1`, candidate
commit `3df55aa058736baacf6635515112ccd6f165ffd3`, and target
`x86_64-pc-windows-msvc`. The installed-app evidence embeds the matching
installer and screenshot checksums. A post-download scan found no URL, bearer
header, `hunsuBridgeToken`, `hunsuRelayToken`, `access_token`, `refresh_token`,
authorization value, or sensitive query parameter in either evidence file.

## Automated Validation

The Linux job passed the complete repository validation. The Windows job then
passed:

- the Tauri and NSIS desktop bundle build;
- Windows GUI subsystem verification;
- the post-build native `status` smoke in 6.6 seconds under its strict
  60-second timeout;
- managed Bridge lifecycle scenarios A-F;
- the silently installed NSIS/Tauri WebView2 automation;
- checksum staging and artifact upload.

The production-shaped delayed detached-start interleaving is covered by the
TypeScript managed-runtime regression suite, while the existing real Windows
lifecycle suite confirms one managed listener, daemon, supervisor, and instance
with retained process ownership. The UI suites separately cover safe clipboard
success, sensitive-payload blocking, and a synthetic clipboard rejection that
returns `CLIPBOARD_WRITE_FAILED` without recording a redaction event or exposing
the raw exception.

## Independent Visual Evidence

The machine-readable review record
[`windows-x64-installed-app-29147290486-visual-review.json`](windows-x64-installed-app-29147290486-visual-review.json)
binds the review to the workflow run, candidate commit, artifact ID and digest,
and screenshot SHA-256. It records:

- review time `2026-07-11T09:26:26Z`;
- fresh context-free reviewer `/root/windows_visual_review_29147290486`;
- the complete visual rubric; and
- exact verdict `VISUAL PASS`.

## Release Status

Automation and independent screenshot review do not substitute for the required
human installation and interaction on Windows:

- `automatedInstalledAppQa`: `passed`
- `independentVisualEvidenceQa`: `passed`
- `manualVisualQa`: `required`
- `releaseEligible`: `false`

The human record must remain bound to this run, candidate, artifact, installer,
managed evidence, installed-app evidence, and screenshot before the release gate
can be opened.
