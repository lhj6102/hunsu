# Contributing to Hunsu

Use Node.js 24.18 or newer and pnpm 10.30.2.

```bash
pnpm install
pnpm check
pnpm build
```

Keep changes inside the package that owns the behavior:

- protocol defines domain values, commands, events, and versioned codecs;
- core owns pure validation, decisions, replay, and invariants;
- github-store owns GitHub transport and durable state mechanics;
- projections owns disposable query models;
- plugin-contract owns MCP schemas and plugin-safe values;
- api owns authentication, authorization, application services, HTTP, MCP, and reconciliation;
- web owns presentation and user interaction;
- config owns service endpoint and secret configuration validation.

New mutations must be idempotent, compare-and-swap protected, represented by append-only events, and callable through the shared application service. Add parity coverage when REST and MCP expose the same command.

Run completion tests must prove GitHub reachability. Coach and alternative-decision tests must prove that proposals cannot become consequential decisions without explicit user authority.

Plugin changes must keep the manifest, marketplace entry, MCP binding, and every `SKILL.md` valid:

```bash
pnpm plugin:validate
```

Do not commit credentials, generated installation tokens, personal repository data, or local `.env` files. See [Security](SECURITY.md) and [Workspace structure](docs/workspace-structure.md).
