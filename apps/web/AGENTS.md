# AGENTS.md

## Boundary

- `apps/web` is the React/Vite browser app for GitHub-backed Projects, Goals, Runners, Runs, and Coach review.
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

- The supported routes are `/projects`, `/projects/:projectId`, `/projects/:projectId/goals/:goalId`, `/projects/:projectId/runners`, `/projects/:projectId/coach`, and `/projects/:projectId/runs/:runId`.
- Project and Goal identifiers come from the URL. Comparison remains a secondary section within Goal detail.

## Product Rules

- Present lists, boards, and detail views before comparison UI.
- Require explicit confirmation for Hunsu, alternative selection or rejection, and consequential Coach proposals.
- Use bounded, visibility-aware polling. Surface structured conflicts and avoid optimistic success for GitHub writes.

## Verification

- `pnpm --filter @hunsu/web typecheck`
- `pnpm --filter @hunsu/web build`
- `pnpm run check`
