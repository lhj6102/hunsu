# AGENTS.md

## Boundary

- `apps/web` is the React/Vite browser app for GitHub-backed Project Commit Node graphs and append-only Events.
- Keep Git operations, Codex execution, worktree mutation, and runtime persistence out of this app. Use same-origin REST endpoints under `/api`.
- Do not inspect or edit `.hunsu/state.hunsu` from Web code.
- Do not add browser token storage. GitHub authentication is an HTTP-only server session.

## Styling

- Use Tailwind CSS v4, shadcn/ui primitives in `src/shared/ui`, and lucide-react icons.
- Use `src/styles/globals.css` as the only global Tailwind entry.
- Prefer the existing neutral semantic tokens and accessible status badges.

## Components

- Feature screens live in `src/features`.
- Shared primitives live in `src/shared/ui`.
- Cross-feature helpers live in `src/shared`.
- Keep API DTOs and the small REST boundary in `src/shared/api`.

## Routes

- The supported routes are `/projects`, `/projects/:projectId/graph`, `/projects/:projectId/graph/nodes/:nodeSha`, `/projects/:projectId/events`, and `/projects/:projectId/events/:eventId`.
- `/projects/:projectId` canonicalizes to the Node graph. Legacy Goal, Runner, Coach, and Run routes are not aliases.

## Product Rules

- Render only registered Node-to-Node structural edges. Runs move right, Coaching moves down, and each non-root Node has one structural parent.
- A Run action selects exactly one Goal from the Node's immutable plan and uses that Node's Runner Value.
- Require explicit confirmation for Coaching transitions and alternative selection or rejection.
- Use bounded, visibility-aware polling. Surface structured conflicts and avoid optimistic success for GitHub writes.

## Verification

- `pnpm --filter @hunsu/web typecheck`
- `pnpm --filter @hunsu/web build`
- `pnpm run test:browser`
- `pnpm run check`
