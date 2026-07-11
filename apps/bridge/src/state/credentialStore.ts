import { chmod } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes as nodeRandomBytes } from "node:crypto";
import type { HunsuPaths } from "./paths.ts";
import { invalidState, readJsonState, writeJsonStateAtomic } from "./atomicJsonStore.ts";

export const BRIDGE_CREDENTIALS_SCHEMA = "hunsu.bridge.credentials.v1" as const;

export type StoredAccountCredential = {
  accountId: string;
  accessToken: string;
  refreshToken: string | null;
  expiresAt: string | null;
};

export type StoredRelayCredential = {
  deviceId: string;
  token: string;
};

export type BridgeCredentials = {
  schema: typeof BRIDGE_CREDENTIALS_SCHEMA;
  controlToken: string;
  account: StoredAccountCredential | null;
  relay: StoredRelayCredential | null;
};

export type CredentialWriteInput = {
  controlToken?: string;
  account?: StoredAccountCredential | null;
  relay?: StoredRelayCredential | null;
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
    windowsAclHardener?: (path: string) => Promise<void>;
  } = {}
): CredentialStore {
  const secureRandomBytes = options.randomBytes ?? nodeRandomBytes;
  const platform = options.platform ?? process.platform;
  const windowsAclHardener = options.windowsAclHardener ?? hardenWindowsCredentialAcl;
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
        account: input.account === undefined ? current?.account ?? null : decodeAccount(paths.credentialsFile, input.account),
        relay: input.relay === undefined ? current?.relay ?? null : decodeRelay(paths.credentialsFile, input.relay)
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
          account: current?.account ?? null,
          relay: current?.relay ?? null
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

async function hardenWindowsCredentialAcl(path: string): Promise<void> {
  const invocation = windowsCredentialAclPowerShellInvocation(path);
  try {
    await execFileAsync(invocation.command, invocation.args, {
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
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$CredentialPath = ${powerShellStringLiteral(path)}`,
    "$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name",
    "$acl = Get-Acl -LiteralPath $CredentialPath",
    "$acl.SetOwner((New-Object System.Security.Principal.NTAccount($identity)))",
    "$acl.SetAccessRuleProtection($true, $false)",
    "foreach ($existingRule in @($acl.Access)) { $acl.RemoveAccessRuleSpecific($existingRule) | Out-Null }",
    "$rule = New-Object System.Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', 'Allow')",
    "$acl.SetAccessRule($rule)",
    "Set-Acl -LiteralPath $CredentialPath -AclObject $acl"
  ].join("; ");
  return {
    command: "powershell.exe",
    args: [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64")
    ]
  };
}

function powerShellStringLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
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
    account: decodeAccount(file, value.account),
    relay: decodeRelay(file, value.relay)
  };
}

function decodeAccount(file: string, value: unknown): StoredAccountCredential | null {
  if (value === null) return null;
  if (!isRecord(value)) throw invalidState(file, "account must be null or an account credential");
  return {
    accountId: requiredString(file, "account.accountId", value.accountId),
    accessToken: requiredSecret(file, "account.accessToken", value.accessToken),
    refreshToken: nullableSecret(file, "account.refreshToken", value.refreshToken),
    expiresAt: nullableTimestamp(file, "account.expiresAt", value.expiresAt)
  };
}

function decodeRelay(file: string, value: unknown): StoredRelayCredential | null {
  if (value === null) return null;
  if (!isRecord(value)) throw invalidState(file, "relay must be null or a Relay credential");
  return {
    deviceId: requiredString(file, "relay.deviceId", value.deviceId),
    token: requiredSecret(file, "relay.token", value.token)
  };
}

function requiredSecret(file: string, field: string, value: unknown): string {
  return requiredString(file, field, value);
}

function nullableSecret(file: string, field: string, value: unknown): string | null {
  return nullableString(file, field, value);
}

function requiredString(file: string, field: string, value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw invalidState(file, `${field} must be a non-empty string`);
  }
  return value;
}

function nullableString(file: string, field: string, value: unknown): string | null {
  if (value === null) return null;
  return requiredString(file, field, value);
}

function nullableTimestamp(file: string, field: string, value: unknown): string | null {
  const timestamp = nullableString(file, field, value);
  if (timestamp !== null && !Number.isFinite(Date.parse(timestamp))) {
    throw invalidState(file, `${field} must be a valid timestamp or null`);
  }
  return timestamp;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
