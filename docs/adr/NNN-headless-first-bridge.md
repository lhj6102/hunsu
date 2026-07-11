# ADR NNN: Headless-First Hunsu Bridge

Status: Accepted

## Decision

The @hunsu/bridge daemon and CLI are the product source of truth. The Tauri
prototype is deprecated and archived. A future device shell may be added only
after the headless contract is stable, and must remain a shallow client.

The historical prototype is preserved only by:

- branch archive/tauri-bridge-prototype-0.1.1
- tag tauri-bridge-prototype-0.1.1-final

## Baseline

The rewrite started from origin/main at 58dcc65. The approved plan proposed the
branch name codex/headless-bridge-v2; the user selected
codex/headless-bridge instead. No prototype QA branch was merged as part of the
rewrite; the selected latest-main baseline already contained the prototype
state now preserved by the archive branch and tag.
