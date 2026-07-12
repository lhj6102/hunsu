export const CONNECT_SOCKET_ATTACHMENT_VERSION = 1 as const;

export type ConnectSocketAttachment =
  | {
      version: typeof CONNECT_SOCKET_ATTACHMENT_VERSION;
      role: "device";
      deviceId: string;
      accountId: string;
      authEpoch: number;
      accessExpiresAtMs: number;
    }
  | {
      version: typeof CONNECT_SOCKET_ATTACHMENT_VERSION;
      role: "browser";
      sessionId: string;
      accountId: string;
    };

export function decodeConnectSocketAttachment(value: unknown): ConnectSocketAttachment | undefined {
  if (!isRecord(value)
    || value.version !== CONNECT_SOCKET_ATTACHMENT_VERSION
    || (value.role !== "device" && value.role !== "browser")) {
    return undefined;
  }
  if (value.role === "device") {
    if (typeof value.deviceId !== "string"
      || typeof value.accountId !== "string"
      || !Number.isSafeInteger(value.authEpoch)
      || !Number.isSafeInteger(value.accessExpiresAtMs)) return undefined;
    return {
      version: CONNECT_SOCKET_ATTACHMENT_VERSION,
      role: "device",
      deviceId: value.deviceId,
      accountId: value.accountId,
      authEpoch: Number(value.authEpoch),
      accessExpiresAtMs: Number(value.accessExpiresAtMs)
    };
  }
  if (typeof value.sessionId !== "string" || typeof value.accountId !== "string") return undefined;
  return {
    version: CONNECT_SOCKET_ATTACHMENT_VERSION,
    role: "browser",
    sessionId: value.sessionId,
    accountId: value.accountId
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
