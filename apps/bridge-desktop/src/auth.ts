import { createHash, randomBytes } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { currentProcessEnv } from "@hunsu/config";

export type BridgeAccountCredentials = {
  schema: "hunsu.bridge-credentials.v1";
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
  userId: string;
  email?: string;
  deviceId: string;
  deviceName: string;
  savedAt: string;
};

export type PkceAuthorizationRequest = {
  authorizationUrl: string;
  codeVerifier: string;
  codeChallenge: string;
  state: string;
  redirectUri: string;
};

export type DeviceAuthorizationRequest = {
  verificationUri: string;
  verificationUriComplete?: string;
  userCode: string;
  deviceCode: string;
  expiresAt: string;
  intervalSeconds: number;
};

export type CredentialStoreBackend =
  | "macos-keychain"
  | "windows-dpapi"
  | "linux-secret-service"
  | "secure-file";

export type CredentialStore = {
  backend: CredentialStoreBackend;
  read(): BridgeAccountCredentials | undefined;
  write(credentials: BridgeAccountCredentials): void;
  clear(): void;
};

export type CredentialCommandRunner = (
  command: string,
  args: string[],
  options?: { input?: string }
) => string;

export type AuthorizationCodeExchangeInput = {
  authBaseUrl?: string;
  tokenUrl?: string;
  clientId: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
  deviceId: string;
  deviceName: string;
  fetchImpl?: typeof fetch;
};

export type DeviceAuthorizationStartInput = {
  authBaseUrl?: string;
  deviceAuthorizationUrl?: string;
  clientId: string;
  scope?: string;
  deviceId: string;
  deviceName: string;
  fetchImpl?: typeof fetch;
};

export type DeviceAuthorizationPollInput = {
  authBaseUrl?: string;
  tokenUrl?: string;
  clientId: string;
  deviceCode: string;
  deviceId: string;
  deviceName: string;
  intervalSeconds?: number;
  expiresAt?: string;
  maxWaitMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
};

export type LocalDevAuthServer = {
  server: Server;
  authBaseUrl: string;
  close(): Promise<void>;
};

type OAuthTokenResponse = {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  user_id?: unknown;
  email?: unknown;
  id_token?: unknown;
  user?: {
    id?: unknown;
    email?: unknown;
  };
  error?: unknown;
  error_description?: unknown;
};

type DeviceAuthorizationResponse = {
  device_code?: unknown;
  user_code?: unknown;
  verification_uri?: unknown;
  verification_uri_complete?: unknown;
  expires_in?: unknown;
  interval?: unknown;
};

export function createPkceAuthorizationRequest(input: {
  authBaseUrl?: string;
  clientId: string;
  redirectUri: string;
  scope?: string;
  state?: string;
}): PkceAuthorizationRequest {
  const codeVerifier = randomBytes(32).toString("base64url");
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
  const state = input.state ?? randomBytes(16).toString("base64url");
  const authorizationUrl = new URL("/oauth/authorize", input.authBaseUrl ?? "https://hunsu.app");
  authorizationUrl.searchParams.set("response_type", "code");
  authorizationUrl.searchParams.set("client_id", input.clientId);
  authorizationUrl.searchParams.set("redirect_uri", input.redirectUri);
  authorizationUrl.searchParams.set("code_challenge", codeChallenge);
  authorizationUrl.searchParams.set("code_challenge_method", "S256");
  authorizationUrl.searchParams.set("state", state);
  if (input.scope?.trim()) {
    authorizationUrl.searchParams.set("scope", input.scope.trim());
  }
  return {
    authorizationUrl: authorizationUrl.toString(),
    codeVerifier,
    codeChallenge,
    state,
    redirectUri: input.redirectUri
  };
}

export function createDeviceAuthorizationRequest(input: {
  authBaseUrl?: string;
  ttlSeconds?: number;
  intervalSeconds?: number;
} = {}): DeviceAuthorizationRequest {
  const ttlSeconds = input.ttlSeconds ?? 15 * 60;
  const first = randomBytes(3).toString("base64url").replace(/[^A-Z0-9]/gi, "").slice(0, 4).toUpperCase().padEnd(4, "H");
  const second = randomBytes(3).toString("base64url").replace(/[^A-Z0-9]/gi, "").slice(0, 4).toUpperCase().padEnd(4, "U");
  return {
    verificationUri: new URL("/device", input.authBaseUrl ?? "https://hunsu.app").toString(),
    verificationUriComplete: undefined,
    userCode: `${first}-${second}`,
    deviceCode: `device_code_${randomBytes(24).toString("base64url")}`,
    expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
    intervalSeconds: input.intervalSeconds ?? 5
  };
}

export async function startDeviceAuthorization(input: DeviceAuthorizationStartInput): Promise<DeviceAuthorizationRequest> {
  const fetcher = input.fetchImpl ?? fetch;
  const endpoint = input.deviceAuthorizationUrl ?? new URL("/oauth/device/code", input.authBaseUrl ?? "https://hunsu.app").toString();
  const body = new URLSearchParams();
  body.set("client_id", input.clientId);
  body.set("device_id", input.deviceId);
  body.set("device_name", input.deviceName);
  if (input.scope?.trim()) {
    body.set("scope", input.scope.trim());
  }
  const response = await fetcher(endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body
  });
  if (!response.ok) {
    throw new Error(`Device authorization request failed with HTTP ${response.status}.`);
  }
  const parsed = await response.json() as DeviceAuthorizationResponse;
  const expiresIn = typeof parsed.expires_in === "number" && Number.isFinite(parsed.expires_in)
    ? parsed.expires_in
    : 15 * 60;
  const intervalSeconds = typeof parsed.interval === "number" && Number.isFinite(parsed.interval)
    ? Math.max(1, parsed.interval)
    : 5;
  const verificationUri = requiredString(parsed.verification_uri, "verification_uri");
  return {
    verificationUri,
    verificationUriComplete: optionalString(parsed.verification_uri_complete),
    userCode: requiredString(parsed.user_code, "user_code"),
    deviceCode: requiredString(parsed.device_code, "device_code"),
    expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
    intervalSeconds
  };
}

export async function pollDeviceAuthorization(input: DeviceAuthorizationPollInput): Promise<BridgeAccountCredentials> {
  const fetcher = input.fetchImpl ?? fetch;
  const tokenUrl = input.tokenUrl ?? new URL("/oauth/token", input.authBaseUrl ?? "https://hunsu.app").toString();
  const sleep = input.sleep ?? defaultSleep;
  let intervalMs = Math.max(1, input.intervalSeconds ?? 5) * 1000;
  const expiresAtMs = input.expiresAt ? Date.parse(input.expiresAt) : Date.now() + 15 * 60 * 1000;
  const deadlineMs = Number.isFinite(expiresAtMs) ? expiresAtMs : Date.now() + 15 * 60 * 1000;
  const maxDeadlineMs = input.maxWaitMs === undefined ? deadlineMs : Math.min(deadlineMs, Date.now() + Math.max(1, input.maxWaitMs));

  while (Date.now() <= maxDeadlineMs) {
    const body = new URLSearchParams();
    body.set("grant_type", "urn:ietf:params:oauth:grant-type:device_code");
    body.set("client_id", input.clientId);
    body.set("device_code", input.deviceCode);
    const response = await fetcher(tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body
    });
    const parsed = await response.json().catch(() => ({})) as OAuthTokenResponse;
    if (response.ok) {
      return credentialsFromOAuthTokenResponse(parsed, {
        deviceId: input.deviceId,
        deviceName: input.deviceName
      });
    }
    const errorCode = optionalString(parsed.error);
    if (errorCode === "authorization_pending") {
      await sleep(intervalMs);
      continue;
    }
    if (errorCode === "slow_down") {
      intervalMs += 5000;
      await sleep(intervalMs);
      continue;
    }
    if (errorCode === "expired_token") {
      throw new Error("Device authorization code expired before sign-in completed.");
    }
    const description = optionalString(parsed.error_description) ?? errorCode ?? `HTTP ${response.status}`;
    throw new Error(`Device authorization token exchange failed: ${description}.`);
  }
  throw new Error("Device authorization timed out before sign-in completed.");
}

export function createDefaultCredentialStore(input: { path?: string } = {}): CredentialStore {
  const env = currentProcessEnv();
  const requested = env.HUNSU_BRIDGE_CREDENTIAL_BACKEND?.trim() as CredentialStoreBackend | undefined;
  const fallbackPath = input.path ?? defaultCredentialPath();
  if (requested === "secure-file") {
    return new FileCredentialStore(fallbackPath);
  }
  if (requested === "macos-keychain") {
    return new MacOsKeychainCredentialStore();
  }
  if (requested === "windows-dpapi") {
    return new WindowsDpapiCredentialStore(fallbackPath);
  }
  if (requested === "linux-secret-service") {
    return new LinuxSecretServiceCredentialStore();
  }

  const os = platform();
  if (os === "darwin") {
    return new MacOsKeychainCredentialStore();
  }
  if (os === "win32") {
    return new WindowsDpapiCredentialStore(fallbackPath);
  }
  if (os === "linux" && (env.DISPLAY || env.WAYLAND_DISPLAY) && commandAvailable("secret-tool")) {
    return new LinuxSecretServiceCredentialStore();
  }
  return new FileCredentialStore(fallbackPath);
}

export class FileCredentialStore implements CredentialStore {
  private readonly path: string;
  readonly backend: CredentialStoreBackend;

  constructor(path: string, backend: CredentialStoreBackend = "secure-file") {
    this.path = path;
    this.backend = backend;
  }

  read(): BridgeAccountCredentials | undefined {
    if (!existsSync(this.path)) {
      return undefined;
    }
    const parsed = JSON.parse(readFileSync(this.path, "utf8")) as Partial<BridgeAccountCredentials>;
    if (parsed.schema !== "hunsu.bridge-credentials.v1" || typeof parsed.accessToken !== "string" || typeof parsed.userId !== "string") {
      return undefined;
    }
    return parsed as BridgeAccountCredentials;
  }

  write(credentials: BridgeAccountCredentials): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, `${JSON.stringify(credentials, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    if (platform() !== "win32") {
      const mode = statSync(this.path).mode & 0o777;
      if ((mode & 0o077) !== 0) {
        throw new Error(`Credential file permissions are too broad: ${mode.toString(8)}`);
      }
    }
  }

  clear(): void {
    rmSync(this.path, { force: true });
  }
}

export class MacOsKeychainCredentialStore implements CredentialStore {
  readonly backend = "macos-keychain" as const;
  private readonly service: string;
  private readonly account: string;
  private readonly runner: CredentialCommandRunner;

  constructor(input: { service?: string; account?: string; runner?: CredentialCommandRunner } = {}) {
    this.service = input.service ?? "app.hunsu.bridge.credentials";
    this.account = input.account ?? "device";
    this.runner = input.runner ?? defaultCredentialCommandRunner;
  }

  read(): BridgeAccountCredentials | undefined {
    try {
      const text = this.runner("security", ["find-generic-password", "-s", this.service, "-a", this.account, "-w"]);
      return parseCredentialJson(text);
    } catch (_error) {
      return undefined;
    }
  }

  write(credentials: BridgeAccountCredentials): void {
    this.runner("security", [
      "add-generic-password",
      "-U",
      "-s",
      this.service,
      "-a",
      this.account,
      "-w",
      JSON.stringify(credentials)
    ]);
  }

  clear(): void {
    try {
      this.runner("security", ["delete-generic-password", "-s", this.service, "-a", this.account]);
    } catch (_error) {
      // Keychain delete returns a non-zero exit code when the item is already absent.
    }
  }
}

export class LinuxSecretServiceCredentialStore implements CredentialStore {
  readonly backend = "linux-secret-service" as const;
  private readonly runner: CredentialCommandRunner;
  private readonly attributes: string[];

  constructor(input: { runner?: CredentialCommandRunner; attributes?: string[] } = {}) {
    this.runner = input.runner ?? defaultCredentialCommandRunner;
    this.attributes = input.attributes ?? ["application", "hunsu-bridge", "schema", "hunsu.bridge-credentials.v1"];
  }

  read(): BridgeAccountCredentials | undefined {
    try {
      const text = this.runner("secret-tool", ["lookup", ...this.attributes]);
      return parseCredentialJson(text);
    } catch (_error) {
      return undefined;
    }
  }

  write(credentials: BridgeAccountCredentials): void {
    this.runner("secret-tool", ["store", "--label", "Hunsu Bridge credentials", ...this.attributes], {
      input: JSON.stringify(credentials)
    });
  }

  clear(): void {
    try {
      this.runner("secret-tool", ["clear", ...this.attributes]);
    } catch (_error) {
      // Secret Service delete returns a non-zero exit code when the item is already absent.
    }
  }
}

export class WindowsDpapiCredentialStore implements CredentialStore {
  readonly backend = "windows-dpapi" as const;
  private readonly path: string;
  private readonly runner: CredentialCommandRunner;

  constructor(path = defaultCredentialPath(), runner: CredentialCommandRunner = defaultCredentialCommandRunner) {
    this.path = path;
    this.runner = runner;
  }

  read(): BridgeAccountCredentials | undefined {
    if (!existsSync(this.path)) {
      return undefined;
    }
    try {
      const script = [
        "$encrypted = [IO.File]::ReadAllText($args[0])",
        "$secure = ConvertTo-SecureString $encrypted",
        "$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)",
        "try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }"
      ].join("; ");
      return parseCredentialJson(this.runner("powershell.exe", ["-NoProfile", "-Command", script, this.path]));
    } catch (_error) {
      return undefined;
    }
  }

  write(credentials: BridgeAccountCredentials): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const encoded = Buffer.from(JSON.stringify(credentials), "utf8").toString("base64");
    const script = [
      "$plain = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($args[0]))",
      "$secure = ConvertTo-SecureString -String $plain -AsPlainText -Force",
      "$encrypted = $secure | ConvertFrom-SecureString",
      "[IO.File]::WriteAllText($args[1], $encrypted)"
    ].join("; ");
    this.runner("powershell.exe", ["-NoProfile", "-Command", script, encoded, this.path]);
  }

  clear(): void {
    rmSync(this.path, { force: true });
  }
}

export async function exchangeAuthorizationCode(input: AuthorizationCodeExchangeInput): Promise<BridgeAccountCredentials> {
  const fetcher = input.fetchImpl ?? fetch;
  const tokenUrl = input.tokenUrl ?? new URL("/oauth/token", input.authBaseUrl ?? "https://hunsu.app").toString();
  const body = new URLSearchParams();
  body.set("grant_type", "authorization_code");
  body.set("client_id", input.clientId);
  body.set("code", input.code);
  body.set("code_verifier", input.codeVerifier);
  body.set("redirect_uri", input.redirectUri);
  const response = await fetcher(tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body
  });
  if (!response.ok) {
    throw new Error(`Authorization code exchange failed with HTTP ${response.status}.`);
  }
  const parsed = await response.json() as OAuthTokenResponse;
  return credentialsFromOAuthTokenResponse(parsed, {
    deviceId: input.deviceId,
    deviceName: input.deviceName
  });
}

export async function startLocalDevAuthServer(input: {
  userId?: string;
  email?: string;
  host?: string;
  port?: number;
} = {}): Promise<LocalDevAuthServer> {
  const requests = new Map<string, {
    deviceCode: string;
    userCode: string;
    deviceId: string;
    deviceName: string;
    expiresAtMs: number;
    approved: boolean;
  }>();
  const userId = input.userId ?? "local-dev-user";
  const email = input.email ?? (userId.includes("@") ? userId : "local-dev@hunsu.test");
  let authBaseUrl = "";
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", authBaseUrl || `http://${input.host ?? "127.0.0.1"}:${input.port ?? 0}`);
      if (request.method === "POST" && url.pathname === "/oauth/device/code") {
        const form = await readFormBody(request);
        const deviceCode = `local_device_${randomBytes(16).toString("base64url")}`;
        const userCode = localDevUserCode();
        requests.set(deviceCode, {
          deviceCode,
          userCode,
          deviceId: form.get("device_id") ?? "device_local_dev",
          deviceName: form.get("device_name") ?? "Local Dev Bridge",
          expiresAtMs: Date.now() + 15 * 60 * 1000,
          approved: false
        });
        sendJson(response, 200, {
          device_code: deviceCode,
          user_code: userCode,
          verification_uri: `${authBaseUrl}/device`,
          verification_uri_complete: `${authBaseUrl}/device?user_code=${encodeURIComponent(userCode)}`,
          expires_in: 15 * 60,
          interval: 1
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/device") {
        const userCode = url.searchParams.get("user_code")?.trim().toUpperCase();
        const matching = [...requests.values()].find(candidate => candidate.userCode === userCode);
        if (matching) {
          matching.approved = true;
          sendText(response, 200, `Hunsu Bridge local-dev device approved for ${email}.\n`);
          return;
        }
        sendText(response, 200, "Hunsu Bridge local-dev auth provider is running. Add ?user_code=ABCD-EFGH to approve a device.\n");
        return;
      }
      if (request.method === "POST" && url.pathname === "/oauth/token") {
        const form = await readFormBody(request);
        const grantType = form.get("grant_type");
        if (grantType === "authorization_code") {
          sendJson(response, 200, localDevTokenResponse(userId, email));
          return;
        }
        if (grantType !== "urn:ietf:params:oauth:grant-type:device_code") {
          sendJson(response, 400, { error: "unsupported_grant_type" });
          return;
        }
        const deviceCode = form.get("device_code") ?? "";
        const pending = requests.get(deviceCode);
        if (!pending || pending.expiresAtMs <= Date.now()) {
          sendJson(response, 400, { error: "expired_token" });
          return;
        }
        if (!pending.approved) {
          sendJson(response, 400, { error: "authorization_pending" });
          return;
        }
        sendJson(response, 200, localDevTokenResponse(userId, email));
        return;
      }
      sendJson(response, 404, { error: "not_found" });
    } catch (error) {
      sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(input.port ?? 0, input.host ?? "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (typeof address !== "object" || !address) {
        reject(new Error("Local dev auth server did not expose a TCP address."));
        return;
      }
      authBaseUrl = `http://${input.host ?? "127.0.0.1"}:${address.port}`;
      resolve();
    });
  });
  return {
    server,
    authBaseUrl,
    close: () => new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    })
  };
}

function defaultCredentialPath(): string {
  return join(homedir(), ".config", "hunsu", "bridge-credentials.json");
}

function parseCredentialJson(text: string): BridgeAccountCredentials | undefined {
  const parsed = JSON.parse(text.trim()) as Partial<BridgeAccountCredentials>;
  if (parsed.schema !== "hunsu.bridge-credentials.v1" || typeof parsed.accessToken !== "string" || typeof parsed.userId !== "string") {
    return undefined;
  }
  return parsed as BridgeAccountCredentials;
}

function credentialsFromOAuthTokenResponse(parsed: OAuthTokenResponse, device: { deviceId: string; deviceName: string }): BridgeAccountCredentials {
  const accessToken = requiredString(parsed.access_token, "access_token");
  const userId = optionalString(parsed.user_id)
    ?? optionalString(parsed.user?.id)
    ?? subjectFromJwt(optionalString(parsed.id_token))
    ?? "unknown-user";
  const expiresIn = typeof parsed.expires_in === "number" && Number.isFinite(parsed.expires_in)
    ? parsed.expires_in
    : undefined;
  return {
    schema: "hunsu.bridge-credentials.v1",
    accessToken,
    refreshToken: optionalString(parsed.refresh_token),
    expiresAt: expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : undefined,
    userId,
    email: optionalString(parsed.email) ?? optionalString(parsed.user?.email),
    deviceId: device.deviceId,
    deviceName: device.deviceName,
    savedAt: new Date().toISOString()
  };
}

function defaultCredentialCommandRunner(command: string, args: string[], options: { input?: string } = {}): string {
  return execFileSync(command, args, {
    encoding: "utf8",
    input: options.input,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true
  });
}

function commandAvailable(command: string): boolean {
  const result = spawnSync(command, ["--version"], { stdio: "ignore", windowsHide: true });
  return result.status === 0 || result.status === 1;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`OAuth token response is missing ${label}.`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function localDevUserCode(): string {
  const first = randomBytes(3).toString("base64url").replace(/[^A-Z0-9]/gi, "").slice(0, 4).toUpperCase().padEnd(4, "H");
  const second = randomBytes(3).toString("base64url").replace(/[^A-Z0-9]/gi, "").slice(0, 4).toUpperCase().padEnd(4, "U");
  return `${first}-${second}`;
}

function localDevTokenResponse(userId: string, email: string): OAuthTokenResponse {
  return {
    access_token: `local_dev_access_${randomBytes(16).toString("base64url")}`,
    refresh_token: `local_dev_refresh_${randomBytes(16).toString("base64url")}`,
    expires_in: 3600,
    user_id: userId,
    email
  };
}

async function readFormBody(request: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.end(`${JSON.stringify(body)}\n`);
}

function sendText(response: ServerResponse, status: number, body: string): void {
  response.statusCode = status;
  response.setHeader("content-type", "text/plain; charset=utf-8");
  response.end(body);
}

function subjectFromJwt(token: string | undefined): string | undefined {
  if (!token) {
    return undefined;
  }
  const [, payload] = token.split(".");
  if (!payload) {
    return undefined;
  }
  try {
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const parsed = JSON.parse(Buffer.from(normalized, "base64").toString("utf8")) as { sub?: unknown };
    return optionalString(parsed.sub);
  } catch (_error) {
    return undefined;
  }
}
