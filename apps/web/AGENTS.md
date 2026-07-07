# AGENTS.md

## Boundary

- `apps/web` is the React/Vite browser app for `/studio`, `/studio/roadmaps/:roadmapId`, `/hub`, and `/dev/handoffs/roadmap-v3`.
- Keep Git, Codex execution, worktree mutation, and runtime persistence out of this app. Use Bridge API calls for runtime control.
- Do not inspect or edit `.hunsu/state.hunsu` from web code.

## Styling

- Use Tailwind CSS v4, shadcn/ui primitives in `src/shared/ui`, and lucide-react icons.
- Use `src/styles/globals.css` as the only global Tailwind entry.
- Start from shadcn neutral tokens. Reintroduce Hunsu colors through semantic variables in `src/shared/design`.
- Do not re-add legacy `styles.css`, `studio-white-theme.css`, or legacy class-name contracts.

## Components

- Feature screens live in `src/features`.
- Shared primitives live in `src/shared/ui`.
- Cross-feature helpers live in `src/shared`.
- Use `@/shared/ui/*`, `@/lib/utils`, and feature-local imports.

## Routes

- Preserve `/studio`, `/studio/open`, `/studio/port`, `/studio/roadmaps/:roadmapId`, `/hub`, and `/dev/handoffs/roadmap-v3`.
- The active Roadmap comes from the URL. Query params may hold selected MOVE, Execute, and panel state.

## Figma Contract

- Preserve the data contract names in `src/shared/design/figmaContracts.ts`.
- `/dev/handoffs/roadmap-v3` is the lightweight design QA surface until formal Storybook is added.

## Verification

- `pnpm --filter @hunsu/web typecheck`
- `pnpm --filter @hunsu/web build`
- `pnpm run check`
