import type { RuntimeProviderStatus } from "../runtime-providers/types.ts";
import type { ConnectedWorkspaceSummary } from "../workspaces/workspaceRegistry.ts";

export type BridgeConnectionMode = "local" | "remote";

export type BridgeBackendStatus = {
  backendId: string;
  mode: BridgeConnectionMode;
  label: string;
  device?: {
    deviceId: string;
    name: string;
    registered: boolean;
    online: boolean;
    lastSeenAt?: string;
  };
  provider: RuntimeProviderStatus;
  connection:
    | { state: "connected" }
    | { state: "not_running" }
    | { state: "login_required" }
    | { state: "relay_offline" }
    | { state: "error"; error: string };
  workspaces: ConnectedWorkspaceSummary[];
};

export function createLocalBackendStatus(input: {
  provider: RuntimeProviderStatus;
  workspaces: ConnectedWorkspaceSummary[];
  running?: boolean;
  label?: string;
}): BridgeBackendStatus {
  return {
    backendId: "local",
    mode: "local",
    label: input.label ?? "This computer",
    provider: input.provider,
    connection: input.running === false ? { state: "not_running" } : { state: "connected" },
    workspaces: input.workspaces
  };
}
