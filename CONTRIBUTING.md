# Contributing

Thanks for helping make Hunsu easier to inspect, run, and trust.

## Setup

```sh
corepack enable
pnpm install
pnpm run check
```

For the Bridge Studio launcher:

```sh
pnpm --filter @hunsu/bridge bridge --dry-run
pnpm hunsu studio --dry-run
pnpm hunsu studio --no-open
```

## Checks

Run the narrowest useful check while developing, then run the full check before
opening a PR:

```sh
pnpm run typecheck
pnpm test
pnpm run check
```

Frontend changes should also pass:

```sh
pnpm --filter @hunsu/web build
```

## Architecture Boundaries

- Keep Git, Codex execution, worktree mutation, and runtime persistence out of
  `apps/web`.
- Keep lower-level packages from reading ambient process environment directly;
  use `@hunsu/config` at app boundaries.
- Treat `.hunsu/*` encoded runtime files as app-owned state. Agents and UI code
  should use decoded API surfaces rather than editing those files directly.
- Do not silently change committed Origin package locks from environment
  variables.

## Security-Sensitive Changes

Be especially careful when changing:

- Hunsu Bridge HTTP routes, CORS, pairing tokens, or filesystem browsing
- Artifact Action command execution
- Git worktree creation or cleanup
- provider runner permissions, sandbox mode, approval policy, or network access
- Hub publishing and Origin integrity verification

Add tests for these changes whenever possible.

## Secrets

Do not commit real `.env` files, tokens, API keys, private keys, provider
transcripts, generated Wrangler config, Playwright reports, or local runtime
state.
