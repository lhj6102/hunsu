# Hunsu Codex plugin

This repository-scoped plugin turns Codex into the execution surface for GitHub-backed Hunsu Commit Node Projects. It bundles Project bootstrap, Node-scoped Run, Coaching transition, Events, and sibling-decision workflows and connects them to the authenticated Hunsu MCP service.

Durable v2 Events and Node payload materializations remain on the repository's `hunsu/state` branch. The plugin never writes that branch directly, never adds `.hunsu` files to source branches, and never stores GitHub installation credentials.

Install the repository marketplace, authenticate the Hunsu MCP server, and start a new Codex task before invoking a bundled skill.

The authenticated custom MCP server in `.mcp.json` is the working integration. `.app.json` remains an intentionally empty, valid app manifest until a registry-issued Hunsu app ID exists; the repository does not fabricate an external connector identity.
