import { chmod } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes as nodeRandomBytes } from "node:crypto";
import {
  windowsCurrentUserOnlyFileAclPowerShellInvocation,
  windowsPowerShellEnvironment
} from "../windowsPowerShell.ts";
import type { HunsuPaths } from "./paths.ts";
import { invalidState, readJsonState, writeJsonStateAtomic } from "./atomicJsonStore.ts";

export const BRIDGE_CREDENTIALS_SCHEMA = "hunsu.bridge.credentials.v2" as const;

type StoredDeviceKeys = {
  signingPrivateKey: JsonWebKey;
  signingPublicKey: JsonWebKey;
  agreementPrivateKey: JsonWebKey;
  agreementPublicKey: JsonWebKey;
};

export type StoredConnectCredential = StoredDeviceKeys & (
  | {
      state: "enrolling";
      enrollmentId: string;
      deviceCode: string;
      userCode: string;
      verificationUri: string;
      verificationUriComplete: string;
      interval: number;
      expiresAt: string;
    }
  | {
      state: "registered";
      deviceId: string;
      accountId: string;
      refreshToken: string;
      accessToken: string;
      expiresAt: string;
      connectWsUrl: string;
    }
);

export type BridgeCredentials = {
  schema: typeof BRIDGE_CREDENTIALS_SCHEMA;
  controlToken: string;
  connect: StoredConnectCredential | null;
};

export type CredentialWriteInput = {
  controlToken?: string;
  connect?: StoredConnectCredential | null;
};

export type ControlTokenRotation = {
  onCommitted?: (credentials: BridgeCredentials) => void;
};

export type CredentialStore = {
  read(): Promise<BridgeCredentials | undefined>;
  ensure(): Promise<BridgeCredentials>;
  write(input: CredentialWriteInput): Promise<BridgeCredentials>;
  rotateControlToken(input?: ControlTokenRotation): Promise<BridgeCredentials>;
};

export function createCredentialStore(
  paths: HunsuPaths,
  options: {
    randomBytes?: (size: number) => Uint8Array;
    platform?: NodeJS.Platform;
    processEnv?: Readonly<Record<string, string | undefined>>;
    windowsAclHardener?: (path: string) => Promise<void>;
  } = {}
): CredentialStore {
  const secureRandomBytes = options.randomBytes ?? nodeRandomBytes;
  const platform = options.platform ?? process.platform;
  const windowsAclHardener = options.windowsAclHardener
    ?? (path => hardenWindowsCredentialAcl(path, options.processEnv ?? {}));
  let writeQueue = Promise.resolve();

  const readCurrent = async (): Promise<BridgeCredentials | undefined> => {
    const value = await readJsonState(paths.credentialsFile);
    if (value === undefined) return undefined;
    return decodeCredentials(paths.credentialsFile, value);
  };
  const read = async (): Promise<BridgeCredentials | undefined> => {
    await writeQueue;
    return readCurrent();
  };

  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const task = writeQueue.then(operation, operation);
    writeQueue = task.then(() => undefined, () => undefined);
    return task;
  };

  const write = async (input: CredentialWriteInput): Promise<BridgeCredentials> => {
    return serialize(async () => {
      const current = await readCurrent();
      const credentials: BridgeCredentials = {
        schema: BRIDGE_CREDENTIALS_SCHEMA,
        controlToken: requiredSecret(
          paths.credentialsFile,
          "controlToken",
          input.controlToken ?? current?.controlToken ?? createControlToken(secureRandomBytes)
        ),
        connect: input.connect === undefined ? current?.connect ?? null : decodeConnect(paths.credentialsFile, input.connect)
      };
      await writeJsonStateAtomic(paths.credentialsFile, credentials, {
        mode: 0o600,
        ...(platform === "win32" ? { prepareTemporaryFile: windowsAclHardener } : {})
      });
      return credentials;
    });
  };

  return {
    read,
    async ensure() {
      const existing = await read();
      if (existing) {
        if (platform === "win32") await windowsAclHardener(paths.credentialsFile);
        else await chmod(paths.credentialsFile, 0o600);
        return existing;
      }
      return write({});
    },
    write,
    rotateControlToken(input = {}) {
      return serialize(async () => {
        const current = await readCurrent();
        let controlToken = createControlToken(secureRandomBytes);
        for (let attempt = 0; controlToken === current?.controlToken && attempt < 8; attempt += 1) {
          controlToken = createControlToken(secureRandomBytes);
        }
        if (controlToken === current?.controlToken) {
          throw invalidState(paths.credentialsFile, "a distinct control credential could not be generated");
        }
        const credentials: BridgeCredentials = {
          schema: BRIDGE_CREDENTIALS_SCHEMA,
          controlToken,
          connect: current?.connect ?? null
        };
        await writeJsonStateAtomic(paths.credentialsFile, credentials, {
          mode: 0o600,
          ...(platform === "win32" ? { prepareTemporaryFile: windowsAclHardener } : {}),
          onCommitted: () => input.onCommitted?.(credentials)
        });
        return credentials;
      });
    }
  };
}

const execFileAsync = promisify(execFile);

async function hardenWindowsCredentialAcl(
  path: string,
  processEnv: Readonly<Record<string, string | undefined>>
): Promise<void> {
  const invocation = windowsCredentialAclPowerShellInvocation(path);
  try {
    await execFileAsync(invocation.command, invocation.args, {
      env: windowsPowerShellEnvironment(processEnv),
      windowsHide: true
    });
  } catch (_error) {
    throw invalidState(path, "credentials ACL could not be restricted to the current Windows user");
  }
}

export function windowsCredentialAclPowerShellInvocation(path: string): {
  command: "powershell.exe";
  args: string[];
} {
  if (/[\u0000-\u001f\u007f]/u.test(path)) {
    throw invalidState(path, "credentials path cannot contain control characters");
  }
  return windowsCurrentUserOnlyFileAclPowerShellInvocation(path, "CredentialPath");
}

function createControlToken(randomBytes: (size: number) => Uint8Array): string {
  return `hunsu_control_${Buffer.from(randomBytes(32)).toString("base64url")}`;
}

function decodeCredentials(file: string, value: unknown): BridgeCredentials {
  if (!isRecord(value) || value.schema !== BRIDGE_CREDENTIALS_SCHEMA) {
    throw invalidState(file, `expected schema ${BRIDGE_CREDENTIALS_SCHEMA}`);
  }
  return {
    schema: BRIDGE_CREDENTIALS_SCHEMA,
    controlToken: requiredSecret(file, "controlToken", value.controlToken),
    connect: decodeConnect(file, value.connect)
  };
}

function decodeConnect(file: string, value: unknown): StoredConnectCredential | null {
  if (value === null) return null;
  if (!isRecord(value)) throw invalidState(file, "connect must be null or a Connect credential");
  const keys: StoredDeviceKeys = {
    signingPrivateKey: requiredP256Jwk(file, "connect.signingPrivateKey", value.signingPrivateKey, true),
    signingPublicKey: requiredP256Jwk(file, "connect.signingPublicKey", value.signingPublicKey, false),
    agreementPrivateKey: requiredP256Jwk(file, "connect.agreementPrivateKey", value.agreementPrivateKey, true),
    agreementPublicKey: requiredP256Jwk(file, "connect.agreementPublicKey", value.agreementPublicKey, false)
  };
  if (value.state === "enrolling") {
    return {
      ...keys,
      state: "enrolling",
      enrollmentId: requiredString(file, "connect.enrollmentId", value.enrollmentId),
      deviceCode: requiredSecret(file, "connect.deviceCode", value.deviceCode),
      userCode: requiredString(file, "connect.userCode", value.userCode),
      verificationUri: requiredSecureHttpUrl(file, "connect.verificationUri", value.verificationUri),
      verificationUriComplete: requiredSecureHttpUrl(file, "connect.verificationUriComplete", value.verificationUriComplete),
      interval: requiredPollingInterval(file, "connect.interval", value.interval),
      expiresAt: requiredTimestamp(file, "connect.expiresAt", value.expiresAt)
    };
  }
  if (value.state !== "registered") throw invalidState(file, "connect.state must be enrolling or registered");
  return {
    ...keys,
    state: "registered",
    deviceId: requiredString(file, "connect.deviceId", value.deviceId),
    accountId: requiredString(file, "connect.accountId", value.accountId),
    refreshToken: requiredSecret(file, "connect.refreshToken", value.refreshToken),
    accessToken: requiredSecret(file, "connect.accessToken", value.accessToken),
    expiresAt: requiredTimestamp(file, "connect.expiresAt", value.expiresAt),
    connectWsUrl: requiredSecureWebSocketUrl(file, "connect.connectWsUrl", value.connectWsUrl)
  };
}

function requiredSecret(file: string, field: string, value: unknown): string {
  return requiredString(file, field, value);
}

function requiredString(file: string, field: string, value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw invalidState(file, `${field} must be a non-empty string`);
  }
  return value;
}

function requiredTimestamp(file: string, field: string, value: unknown): string {
  const timestamp = requiredString(file, field, value);
  if (!Number.isFinite(Date.parse(timestamp))) {
    throw invalidState(file, `${field} must be a valid timestamp`);
  }
  return timestamp;
}

function requiredSecureWebSocketUrl(file: string, field: string, value: unknown): string {
  const raw = requiredString(file, field, value);
  let url: URL;
  try {
    url = new URL(raw);
  } catch (_error) {
    throw invalidState(file, `${field} must be a valid WebSocket URL`);
  }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]" || url.hostname === "::1";
  if (url.protocol !== "wss:" && !(url.protocol === "ws:" && loopback)) {
    throw invalidState(file, `${field} must use WSS except for loopback fixtures`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw invalidState(file, `${field} must not contain credentials`);
  }
  return url.toString();
}

function requiredSecureHttpUrl(file: string, field: string, value: unknown): string {
  const raw = requiredString(file, field, value);
  let url: URL;
  try {
    url = new URL(raw);
  } catch (_error) {
    throw invalidState(file, `${field} must be a valid URL`);
  }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]" || url.hostname === "::1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw invalidState(file, `${field} must use HTTPS except for loopback fixtures`);
  }
  if (url.username || url.password || url.hash) throw invalidState(file, `${field} must not contain credentials`);
  return url.toString();
}

function requiredPollingInterval(file: string, field: string, value: unknown): number {
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 30) {
    throw invalidState(file, `${field} must be an integer from 1 through 30`);
  }
  return Number(value);
}

function requiredP256Jwk(file: string, field: string, value: unknown, requirePrivate: boolean): JsonWebKey {
  if (!isRecord(value)
    || value.kty !== "EC"
    || value.crv !== "P-256"
    || typeof value.x !== "string"
    || typeof value.y !== "string"
    || (requirePrivate && typeof value.d !== "string")
    || (!requirePrivate && value.d !== undefined)) {
    throw invalidState(file, `${field} must be a ${requirePrivate ? "private" : "public"} P-256 JWK`);
  }
  return {
    kty: "EC",
    crv: "P-256",
    x: value.x,
    y: value.y,
    ...(requirePrivate ? { d: value.d as string } : {}),
    ext: true
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
