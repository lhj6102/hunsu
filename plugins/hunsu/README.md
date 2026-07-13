# Hunsu Codex plugin

This repository-scoped plugin turns Codex into the execution surface for GitHub-backed Hunsu Projects. It bundles Project, Goal, Run, Coach, and divergence workflows and connects them to the authenticated Hunsu MCP service.

Durable state remains on the repository's `hunsu/state` branch. The plugin never writes that branch directly and never stores GitHub installation credentials.

Install the repository marketplace, authenticate the Hunsu MCP server, and start a new Codex task before invoking a bundled skill.

The authenticated custom MCP server in `.mcp.json` is the working integration. `.app.json` remains an intentionally empty, valid app manifest until a registry-issued Hunsu app ID exists; the repository does not fabricate an external connector identity.
