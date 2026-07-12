export const BRIDGE_REMOTE_WORKSPACE_SCOPES = [
  "remote.access",
  "execute.start",
  "artifactAction.run",
  "env.read",
  "hostAlias.expose"
] as const;

export type BridgeRemoteWorkspaceScope = typeof BRIDGE_REMOTE_WORKSPACE_SCOPES[number];
