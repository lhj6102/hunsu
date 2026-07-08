import type { StudioConnectionStatus } from "@/shared/api/bridgeTypes";

export function isUsableStudioConnectionStatus(connection: StudioConnectionStatus | undefined): connection is StudioConnectionStatus {
  if (!connection) {
    return false;
  }
  return connection.health === "connected"
    && connection.auth === "paired"
    && (connection.projectAccess === "granted" || connection.projectAccess === "not_applicable")
    && connection.compatibility?.compatible !== false;
}

export function isUsableLocalStudioConnectionStatus(connection: StudioConnectionStatus | undefined): connection is StudioConnectionStatus {
  return connection?.mode === "local" && isUsableStudioConnectionStatus(connection);
}

export function isUsableRemoteStudioConnectionStatus(connection: StudioConnectionStatus | undefined): connection is StudioConnectionStatus {
  return connection?.mode === "remote" && isUsableStudioConnectionStatus(connection);
}
