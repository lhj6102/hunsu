# Workspaces

Workspace is the public name for a Bridge-managed local repository.

The daemon owns the Workspace registry in HUNSU_HOME/workspaces.json. Every
entry has a stable opaque ID, display name, canonical local path, lifecycle,
health, and safe metadata. Automated tests always use temporary registries and
disposable repositories.

~~~sh
hunsu-bridge workspace add <path> --json
hunsu-bridge workspace list --json
hunsu-bridge workspace inspect <workspace-id> --json
hunsu-bridge workspace open <workspace-id> --json
hunsu-bridge workspace remove <workspace-id> --json
~~~

These commands are clients of the running daemon and never start it. Offline
requests return BRIDGE_NOT_RUNNING. Invalid or missing entries return stable
Workspace error codes rather than requiring clients to parse stderr.

## Local and browser access

The browser compatibility adapter preserves the existing /api/workspaces
routes during the 0.2 transition. Hunsu Web receives stable IDs and safe
metadata. Local path disclosure is limited to an authenticated local browser
session.

## Remote grants

A Workspace is never remotely accessible merely because it is registered.
Remote access requires an explicit grant. Relay summaries redact local paths
unless that grant separately authorizes path visibility, and Remote payloads
cannot replace the granted path.

Workspace history remains Git-backed Hunsu state. Removing a local registry
entry does not delete repository history or files.
