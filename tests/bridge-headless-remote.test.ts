import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createHunsuRelayServer } from "../apps/relay/src/index.ts";
import type { RelayServerConfig } from "../packages/config/src/index.ts";
import { BridgeError } from "../apps/bridge/src/client/cliResult.ts";
import { createBridgeControlClient } from "../apps/bridge/src/client/controlClient.ts";
import { startBridgeDaemon, type RunningBridgeDaemon } from "../apps/bridge/src/daemon/daemon.ts";
import {
  createRemoteService,
  type RelaySocket,
  type RelaySocketFactory
} from "../apps/bridge/src/remote/remoteService.ts";
import {
  createConfigStore,
  createCredentialStore,
  createWorkspaceStore,
  resolveHunsuPaths
} from "../apps/bridge/src/state/index.ts";
import { createWorkspaceService } from "../apps/bridge/src/workspaces/workspaceService.ts";

test("Remote Bridge completes device login, safe registration, outbound auth, commands, reconnect, and disable in one daemon service", { timeout: 10_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "hunsu-headless-remote-"));
  const home = join(root, "state");
  const repository = join(root, "private-repository-path");
  const ungrantedRepository = join(root, "ungranted-repository-path");
  await mkdir(repository);
  await mkdir(ungrantedRepository);
  const paths = resolveHunsuPaths({ home });
  const configStore = createConfigStore(paths);
  const credentialStore = createCredentialStore(paths, { randomBytes: size => new Uint8Array(size).fill(9) });
  const workspaceService = createWorkspaceService({ store: createWorkspaceStore(paths) });
  const added = await workspaceService.add(repository, { displayName: "Remote Workspace" });
  assert.equal(added.ok, true);
  if (!added.ok) return;
  const ungranted = await workspaceService.add(ungrantedRepository, { displayName: "Ungrantable by default" });
  assert.equal(ungranted.ok, true);
  const granted = await workspaceService.setRemoteAccess(added.value.workspaceId, {
    enabled: true,
    scopes: ["remoteRelay.access", "execute.start", "artifactAction.run", "env.read", "hostAlias.expose"]
  });
  assert.equal(granted.ok, true);

  const accountToken = "account_access_token_must_stay_out_of_urls";
  const deviceCode = "private-device-code";
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const sockets: FakeRelaySocket[] = [];
  const socketFactory: RelaySocketFactory = url => {
    const socket = new FakeRelaySocket(url);
    sockets.push(socket);
    return socket;
  };
  const fetchImpl: typeof fetch = async (resource, init) => {
    const url = resource instanceof URL ? resource : new URL(typeof resource === "string" ? resource : resource.url);
    requests.push({ url: url.toString(), init });
    if (url.pathname === "/oauth/device/code") {
      return jsonResponse(200, {
        device_code: deviceCode,
        user_code: "ABCD-EFGH",
        verification_uri: "https://hunsu.app/activate",
        verification_uri_complete: "https://hunsu.app/activate?user_code=ABCD-EFGH",
        expires_in: 900,
        interval: 1
      });
    }
    if (url.pathname === "/oauth/token") {
      return jsonResponse(200, {
        access_token: accountToken,
        refresh_token: "private-refresh-token",
        account_id: "account-123",
        expires_in: 3_600
      });
    }
    if (url.pathname === "/v1/devices") {
      const registration = JSON.parse(String(init?.body)) as { device: Record<string, unknown> };
      return jsonResponse(202, { device: { ...registration.device, status: "offline" } });
    }
    return jsonResponse(404, { error: "not_found" });
  };

  const service = createRemoteService({
    configStore,
    credentialStore,
    workspaceService,
    authBaseUrl: "https://auth.example.test",
    relayApiUrl: "https://relay.example.test",
    relayWsUrl: "wss://relay.example.test/v1/bridge",
    fetchImpl,
    socketFactory,
    openBrowser: async () => undefined,
    deviceName: "Test Device",
    now: () => new Date("2026-07-12T00:00:00.000Z"),
    onCommand: async command => {
      if (command.command === "health") throw new Error("hunsu_control_must-not-leak /private/path");
      return { ok: true, status: 200, body: { echoed: command } };
    }
  });

  try {
    await assert.rejects(
      () => service.enable(),
      error => error instanceof BridgeError && error.code === "ACCOUNT_LOGIN_REQUIRED"
    );

    const login = await service.login({ openBrowser: false });
    assert.equal(login.state, "pending");
    assert.equal(login.userCode, "ABCD-EFGH");
    assert.equal(login.browserOpened, false);
    const safeLogin = JSON.stringify(login);
    assert.equal(safeLogin.includes(deviceCode), false);
    assert.equal(safeLogin.includes(accountToken), false);
    assert.equal(safeLogin.includes("private-refresh-token"), false);

    await waitFor(async () => (await credentialStore.read())?.account?.accessToken === accountToken);
    const tokenRequest = requests.find(request => new URL(request.url).pathname === "/oauth/token");
    assert.ok(tokenRequest);
    assert.equal(tokenRequest.url.includes(deviceCode), false);

    const enabled = await service.enable();
    assert.equal(enabled.enabled, true);
    assert.equal(enabled.signedIn, true);
    assert.deepEqual(enabled.grantedWorkspaceIds, [added.value.workspaceId]);
    assert.equal(sockets.length, 1);
    assert.equal(new URL(sockets[0]!.url).search, "");
    assert.equal(sockets[0]!.url.includes(accountToken), false);

    const registration = requests.find(request => new URL(request.url).pathname === "/v1/devices");
    assert.ok(registration);
    assert.equal(new URL(registration.url).search, "");
    assert.equal(registration.url.includes(accountToken), false);
    assert.equal(registration.url.includes(accountToken), false);
    assert.equal(registration.init?.headers && (registration.init.headers as Record<string, string>).authorization, `Bearer ${accountToken}`);
    const registrationBody = JSON.parse(String(registration.init?.body)) as {
      device: { deviceId: string; deviceName: string; protocolVersion: string };
      workspaces: Array<{ workspaceId: string; displayName: string; pathRedacted: boolean }>;
      projectGrants: Array<{ path: string; scopes: string[] }>;
    };
    assert.match(registrationBody.device.deviceId, /^device_/u);
    assert.equal(registrationBody.device.deviceName, "Test Device");
    assert.equal(registrationBody.device.protocolVersion, "local-bridge-v1");
    assert.equal(registrationBody.workspaces.length, 1);
    assert.equal(registrationBody.workspaces[0]?.workspaceId, added.value.workspaceId);
    assert.equal(registrationBody.workspaces[0]?.pathRedacted, true);
    assert.deepEqual(registrationBody.projectGrants.map(grant => grant.path), [repository]);
    assert.equal(JSON.stringify(registrationBody).includes(ungrantedRepository), false);
    assert.equal(JSON.stringify(registrationBody).includes(accountToken), false);

    sockets[0]!.emit("open");
    assert.equal((await service.status()).connection, "connected");
    const authenticate = sockets[0]!.messages().find(message => message.type === "authenticate");
    assert.deepEqual(authenticate, {
      type: "authenticate",
      protocolVersion: "local-bridge-v1",
      deviceId: registrationBody.device.deviceId,
      token: accountToken
    });
    const registered = sockets[0]!.messages().find(message => message.type === "device.register");
    assert.ok(registered);
    assert.equal(JSON.stringify(registered).includes(ungrantedRepository), false);

    sockets[0]!.emit("message", {
      data: JSON.stringify({
        type: "command",
        commandId: "request-1",
        userId: "account-123",
        command: { deviceId: registrationBody.device.deviceId, command: "bridge.status" }
      })
    });
    await waitFor(() => sockets[0]!.messages().some(message => message.type === "command.result"));
    assert.deepEqual(sockets[0]!.messages().find(message => message.type === "command.result"), {
      type: "command.result",
      commandId: "request-1",
      result: {
        ok: true,
        status: 200,
        body: { echoed: { deviceId: registrationBody.device.deviceId, command: "bridge.status" } }
      }
    });

    sockets[0]!.emit("message", {
      data: JSON.stringify({
        type: "command",
        commandId: "request-denied",
        userId: "account-123",
        command: {
          deviceId: registrationBody.device.deviceId,
          command: "roadmap.board",
          projectPath: ungrantedRepository,
          payload: { roadmapId: ungranted.ok ? ungranted.value.workspaceId : "missing" }
        }
      })
    });
    await waitFor(() => sockets[0]!.messages().some(message => message.commandId === "request-denied"));
    assert.deepEqual(sockets[0]!.messages().find(message => message.commandId === "request-denied"), {
      type: "command.result",
      commandId: "request-denied",
      result: { ok: false, status: 403, error: "Remote command Workspace is not granted." }
    });
    sockets[0]!.emit("message", {
      data: JSON.stringify({
        type: "command",
        commandId: "request-error",
        userId: "account-123",
        command: { deviceId: registrationBody.device.deviceId, command: "health", projectPath: repository }
      })
    });
    await waitFor(() => sockets[0]!.messages().some(message => message.commandId === "request-error"));
    assert.deepEqual(sockets[0]!.messages().find(message => message.commandId === "request-error"), {
      type: "command.result",
      commandId: "request-error",
      result: { ok: false, status: 500, error: "Remote command failed." }
    });
    sockets[0]!.emit("message", { data: "{malformed" });

    sockets[0]!.emit("close");
    assert.equal((await service.status()).connection, "offline");
    await waitFor(() => sockets.length === 2, 2_000);
    sockets[1]!.emit("open");
    assert.equal((await service.status()).connection, "connected");
    sockets[0]!.emit("close");
    await new Promise(resolve => setTimeout(resolve, 350));
    assert.equal(sockets.length, 2);

    const disabled = await service.disable();
    assert.equal(disabled.enabled, false);
    assert.equal(disabled.connection, "disabled");
    assert.equal(sockets[1]!.closed, true);
    assert.equal((await configStore.read()).remote.enabled, false);
  } finally {
    service.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("headless daemon registers with the real Relay and routes only explicitly granted Workspace commands", { timeout: 15_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "hunsu-headless-real-relay-"));
  const repository = join(root, "granted-workspace");
  const deniedRepository = join(root, "denied-workspace");
  await mkdir(repository);
  await mkdir(deniedRepository);
  const relay = createHunsuRelayServer({
    config: relayConfig(join(root, "relay-state.json")),
    commandTimeoutMs: 3_000
  });
  const urls = await relay.listen();
  let daemon: RunningBridgeDaemon | undefined;
  let pairingUrl = "";
  try {
    daemon = await startBridgeDaemon({
      home: join(root, "state"),
      port: 0,
      cwd: repository,
      development: true,
      env: {
        HUNSU_BRIDGE_AUTH_BASE_URL: urls.apiUrl,
        HUNSU_RELAY_API_URL: urls.apiUrl,
        HUNSU_RELAY_WS_URL: urls.wsUrl
      },
      openBrowser: async url => { pairingUrl = url; }
    });
    const client = createBridgeControlClient({ paths: daemon.paths });
    const added = await client.request<{ workspaceId: string }>("/v1/control/workspaces", {
      method: "POST",
      body: { path: repository, displayName: "Granted Workspace" }
    });
    assert.equal(added.ok, true);
    if (!added.ok || !added.value) return;
    const login = await client.request<{ verificationUriComplete?: string }>("/v1/control/login", {
      method: "POST",
      body: { openBrowser: false }
    });
    assert.equal(login.ok, true);
    if (!login.ok || !login.value?.verificationUriComplete) return;
    assert.equal((await fetch(login.value.verificationUriComplete)).status, 200);
    await waitFor(async () => Boolean((await createCredentialStore(daemon!.paths).read())?.account), 3_000);

    const granted = await client.request(`/v1/control/workspaces/${encodeURIComponent(added.value.workspaceId)}/remote-access`, {
      method: "PUT",
      body: { enabled: true, scopes: ["remoteRelay.access"] }
    });
    assert.equal(granted.ok, true);

    const paired = await client.request("/v1/control/pair", { method: "POST", body: { openBrowser: true } });
    assert.equal(paired.ok, true);
    const pairingToken = new URL(pairingUrl).searchParams.get("hunsuBridgeToken");
    assert.ok(pairingToken);
    const enabled = await fetch(`${daemon.identity.endpoint}/api/connections/remote/enable`, {
      method: "POST",
      headers: { authorization: `Bearer ${pairingToken}` }
    });
    assert.equal(enabled.status, 202);
    await waitFor(async () => {
      const status = await client.request<{ connection?: string }>("/v1/control/remote");
      return status.ok && status.value?.connection === "connected";
    }, 3_000);
    const denied = await client.request<{ workspaceId: string }>("/v1/control/workspaces", {
      method: "POST",
      body: { path: deniedRepository, displayName: "Denied Workspace" }
    });
    assert.equal(denied.ok, true);
    const credentials = await createCredentialStore(daemon.paths).read();
    assert.ok(credentials?.account?.accessToken);
    assert.ok(credentials?.relay?.deviceId);
    const relayToken = credentials.account.accessToken;
    const deviceId = credentials.relay.deviceId;

    const devices = await relayRequest(`${urls.apiUrl}/v1/devices`, relayToken);
    assert.equal((devices as { devices?: Array<{ deviceId: string; status: string; workspaces?: unknown[] }> }).devices?.[0]?.deviceId, deviceId);
    assert.equal((devices as { devices?: Array<{ status: string }> }).devices?.[0]?.status, "online");

    const statusCommand = await relayRequest(`${urls.apiUrl}/v1/commands`, relayToken, {
      deviceId,
      command: "bridge.status"
    });
    assert.equal((statusCommand as { ok?: boolean }).ok, true);
    assert.equal(JSON.stringify(statusCommand).includes(repository), false);
    assert.equal(JSON.stringify(statusCommand).includes(deniedRepository), false);

    const grantedHealth = await relayRequest(`${urls.apiUrl}/v1/commands`, relayToken, {
      deviceId,
      command: "health",
      projectPath: repository
    });
    assert.equal((grantedHealth as { ok?: boolean; status?: number }).ok, true);

    const rejected = await relayRequest(`${urls.apiUrl}/v1/commands`, relayToken, {
      deviceId,
      command: "roadmap.board",
      projectPath: deniedRepository,
      payload: { roadmapId: denied.ok ? denied.value?.workspaceId : "missing" }
    }, 403);
    assert.equal((rejected as { ok?: boolean; reason?: string }).ok, false);
    assert.equal((rejected as { reason?: string }).reason, "project_grant_denied");

    const disabled = await fetch(`${daemon.identity.endpoint}/api/connections/remote/disable`, {
      method: "POST",
      headers: { authorization: `Bearer ${pairingToken}` }
    });
    assert.equal(disabled.status, 202);
    const inspected = await client.request<{ remoteAccess?: { enabled?: boolean } }>(
      `/v1/control/workspaces/${encodeURIComponent(added.value.workspaceId)}`
    );
    assert.equal(inspected.ok, true);
    if (inspected.ok) assert.equal(inspected.value?.remoteAccess?.enabled, true);
  } finally {
    await daemon?.close().catch(() => undefined);
    await relay.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("logout cancels an in-flight device-code completion before credentials can be restored", async () => {
  const root = await mkdtemp(join(tmpdir(), "hunsu-headless-login-cancel-"));
  const paths = resolveHunsuPaths({ home: join(root, "state") });
  let resolveToken: ((response: Response) => void) | undefined;
  const tokenResponse = new Promise<Response>(resolve => { resolveToken = resolve; });
  const service = createRemoteService({
    configStore: createConfigStore(paths),
    credentialStore: createCredentialStore(paths),
    workspaceService: createWorkspaceService({ store: createWorkspaceStore(paths) }),
    authBaseUrl: "https://auth.example.test",
    relayApiUrl: "https://relay.example.test",
    fetchImpl: async resource => {
      const url = resource instanceof URL ? resource : new URL(typeof resource === "string" ? resource : resource.url);
      if (url.pathname === "/oauth/device/code") {
        return jsonResponse(200, {
          device_code: "private-device-code",
          user_code: "ABCD-EFGH",
          verification_uri: "https://auth.example.test/activate",
          expires_in: 900,
          interval: 1
        });
      }
      if (url.pathname === "/oauth/token") return tokenResponse;
      return jsonResponse(404, {});
    },
    openBrowser: async () => undefined
  });
  try {
    await service.login({ openBrowser: false });
    await waitFor(() => resolveToken !== undefined);
    await service.logout();
    resolveToken?.(jsonResponse(200, {
      access_token: "late-account-token",
      account_id: "late-account",
      expires_in: 3_600
    }));
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal((await createCredentialStore(paths).read())?.account, null);
  } finally {
    service.stop();
    await rm(root, { recursive: true, force: true });
  }
});

class FakeRelaySocket implements RelaySocket {
  readonly url: string;
  readyState = 0;
  closed = false;
  private readonly sent: string[] = [];
  private readonly listeners = new Map<string, Array<(event: { data?: unknown }) => void>>();

  constructor(url: string) {
    this.url = url;
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }

  addEventListener(type: "open" | "close" | "error" | "message", listener: (event: { data?: unknown }) => void): void {
    const current = this.listeners.get(type) ?? [];
    current.push(listener);
    this.listeners.set(type, current);
  }

  emit(type: "open" | "close" | "error" | "message", event: { data?: unknown } = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  messages(): Array<Record<string, unknown>> {
    return this.sent.map(value => JSON.parse(value) as Record<string, unknown>);
  }
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for asynchronous Remote Bridge state.");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

function relayConfig(storagePath: string): RelayServerConfig {
  return {
    relay: { name: "relay", host: "127.0.0.1", hostSource: "override", port: 0, portSource: "override", reserved: false },
    publicApiUrl: "http://127.0.0.1:0",
    publicWsUrl: "ws://127.0.0.1:0/v1/device/connect",
    issuer: "http://127.0.0.1:0",
    storagePath,
    processEnv: {}
  };
}

async function relayRequest(url: string, accessToken: string, body?: unknown, expectedStatus = 200): Promise<unknown> {
  const response = await fetch(url, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      ...(body === undefined ? {} : { "content-type": "application/json" })
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  if (response.status !== expectedStatus) assert.fail(await response.text().catch(() => ""));
  return response.json();
}
