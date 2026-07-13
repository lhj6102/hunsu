# Local development

Install dependencies and run the validation gate:

```bash
pnpm install
pnpm check
pnpm build
```

Start the API and Web processes in separate terminals:

```bash
pnpm dev:api
pnpm dev:web
```

Default endpoints are `http://127.0.0.1:19687` for the API and `http://127.0.0.1:19688` for Web. Override them only through `@hunsu/config`:

```text
HUNSU_API_HOST
HUNSU_API_PORT
HUNSU_WEB_HOST
HUNSU_WEB_PORT
HUNSU_API_PROXY_TARGET
VITE_HUNSU_API_URL
HUNSU_PUBLIC_API_URL
HUNSU_WEB_URL
```

The API additionally requires the GitHub App and session values listed in the root README. Put local values in an ignored environment file or your shell secret facility; never commit them.

Focused commands:

```bash
pnpm --filter @hunsu/api typecheck
pnpm --filter @hunsu/web typecheck
pnpm --filter @hunsu/web build
pnpm plugin:validate
node --conditions=development --test tests/*.test.ts
```

Tests use an in-memory GitHub transport with a real commit graph. It exercises branch creation, compare-and-swap, ancestry, reachability, event reconstruction, and projection deletion without making external repository changes.
