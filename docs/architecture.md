# Architecture

Hunsu has five authority boundaries:

```text
Hunsu Web
  -> authenticated REST
Hunsu API and MCP service
  -> installation-scoped GitHub operations
GitHub refs and commits

Codex plugin
  -> OAuth-authenticated MCP
Hunsu API and MCP service

packages/protocol + packages/core
  -> pure domain decisions used by every command path
```

GitHub owns durable truth. The API owns command validation, authorization, Run verification, and disposable projections. The plugin owns the guided execution interaction. Codex performs repository work. Web owns presentation and explicit user decisions.

See [GitHub-backed Projects](architecture/github-backed-projects.md), [Codex plugin](architecture/codex-plugin.md), and [Workspace structure](workspace-structure.md).
