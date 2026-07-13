# Security policy

## Reporting

Please report suspected vulnerabilities privately to the maintainers. Include affected version or commit, impact, reproduction steps, and whether credentials or repository contents may have been exposed. Do not open a public issue for an unpatched vulnerability.

## Trust boundaries

- GitHub App installation grants bound every repository operation.
- Browser requests use a signed, expiring, HttpOnly, SameSite session cookie.
- MCP clients use OAuth and receive only plugin-safe structured errors.
- Webhook signatures are verified over the raw request body before parsing, and delivery identifiers are deduplicated.
- Durable writes use expected-head compare-and-swap and non-forced ref updates.
- Run completion requires commit existence, base ancestry, and expected-branch reachability.
- Coach output is advisory; consequential divergence and alternative decisions require an authenticated user actor.

## Secret handling

GitHub private keys, client secrets, webhook secrets, session secrets, OAuth values, installation tokens, and Codex credentials must exist only in managed secret storage or short-lived memory. They must not appear in repository state, evidence, logs, errors, plugin files, query parameters, or generated fixtures.

The state writer rejects credential-shaped fields and values before serialization. Installation access tokens should use the narrowest installation and repository permissions and remain short-lived.

## GitHub state safety

`hunsu/state` is application-managed. Never force-update it. Event files are append-only, snapshots are derived, and a rebuild must replay events rather than trust cached materializations. GitHub Actions may perform repository CI only; they are outside the Hunsu Run lifecycle.
