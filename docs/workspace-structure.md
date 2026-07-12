# Workspace Structure

Hunsu is a pnpm workspace coordinated by Turbo. Product applications live
under apps, reusable implementation packages live under packages, and
cross-package tests live under tests.

~~~text
apps/web
  -> packages/config
  -> packages/protocol

apps/bridge
  -> packages/config
  -> packages/core
  -> packages/protocol
  -> packages/protocol-registry
  -> packages/codex-runner

apps/hub-api
  -> packages/config
  -> packages/protocol-registry

apps/relay
  -> packages/config

packages/cli
  -> apps/bridge
  -> packages/config
  -> packages/core
  -> packages/protocol

packages/core
  -> packages/protocol

packages/protocol-registry
  -> packages/protocol

packages/codex-runner
  -> packages/protocol
  -> @openai/codex
~~~

Dependency direction stays inward. Protocol and domain packages do not import
application lifecycle, service-manager, worktree orchestration, or browser UI
code.

## apps/web

The React/Vite browser client owns presentation for Studio and Hub. It does not
own Git, Codex execution, runtime persistence, service management, or daemon
lifecycle. Runtime mutations go through Bridge APIs.

## apps/bridge

This is the single published @hunsu/bridge product package. It owns:

- the foreground daemon and singleton boundary
- the authenticated CLI control client
- browser compatibility routes
- provider, Workspace, pairing, and Remote services
- HUNSU_HOME state and credential stores
- OS user-service adapters
- stable runtime setup and removal
- Git, Execute, Artifact Action, and Codex runner integration

Domain services do not contain CLI parsing, HTTP request objects, or
service-manager logic. CLI-only code performs no direct product-state writes;
setup and service installation are the narrow filesystem exceptions.

## apps/hub-api and apps/relay

Hub API serves immutable reusable package metadata and versions. Relay
authenticates accounts and routes typed commands to outbound Bridge device
connections. Neither service receives arbitrary local repository access.

## packages

packages/protocol defines stable domain and wire types. packages/core contains
Git-backed runtime behavior. packages/codex-runner is the Codex app-server
boundary. packages/config resolves application-boundary configuration.
packages/protocol-registry resolves immutable Team, Member, Manager, and Skill
packages. packages/cli is the separate Hunsu Roadmap/control-plane CLI, not a
second Bridge daemon package.

## Root commands

~~~sh
pnpm dev:bridge
pnpm dev:web
pnpm dev:stack
pnpm run check
pnpm run test:e2e:stack
pnpm run test:package:bridge
pnpm run check:no-desktop-prototype
pnpm run check:bridge-state-boundaries
pnpm verify:bridge
~~~

The normal Bridge gate runs on Ubuntu. Cross-platform service-manager smoke is
isolated to nightly, manual, and release-candidate workflows.
