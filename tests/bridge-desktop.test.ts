import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  createDeviceAuthorizationRequest,
  createPkceAuthorizationRequest,
  exchangeAuthorizationCode,
  FileCredentialStore,
  LinuxSecretServiceCredentialStore,
  MacOsKeychainCredentialStore,
  pollDeviceAuthorization,
  startDeviceAuthorization,
  startLocalDevAuthServer,
  WindowsDpapiCredentialStore
} from "../apps/bridge-desktop/src/auth.ts";
import { main, normalizeBridgeAppArgv } from "../apps/bridge-desktop/src/main.ts";
import { protocolRegistrationPlan } from "../apps/bridge-desktop/src/native-shell.ts";
import { evaluateRelayCommand, FileRelayRegistry, forwardRelayCommand, forwardRelayCommandStream, LocalDevRelayService, RelayOutboundClient, relayHttpRequestForCommand, scopesForRelayCommand, type ProjectGrant } from "../apps/bridge-desktop/src/relay.ts";
import { BridgeSidecarSupervisor } from "../apps/bridge-desktop/src/sidecar-supervisor.ts";

test("Bridge App parses browser deep links into command arguments", () => {
  assert.deepEqual(normalizeBridgeAppArgv(["hunsu://open"]), ["status"]);
  assert.deepEqual(normalizeBridgeAppArgv(["hunsu://pair?next=/studio/roadmaps/roadmap_123"]), [
    "pair",
    "--next",
    "/studio/roadmaps/roadmap_123"
  ]);
  assert.deepEqual(normalizeBridgeAppArgv(["hunsu://pair?code=abc123&state=state123"]), [
    "auth-callback",
    "--code",
    "abc123",
    "--state",
    "state123"
  ]);
  assert.deepEqual(normalizeBridgeAppArgv(["hunsu://open-project?path=/tmp/example"]), ["open-project", "/tmp/example"]);
  assert.deepEqual(normalizeBridgeAppArgv(["hunsu://open-roadmap?roadmapId=roadmap_123"]), [
    "open-roadmap",
    "--roadmap-id",
    "roadmap_123"
  ]);
  assert.deepEqual(normalizeBridgeAppArgv(["hunsu://remote-disable"]), ["remote", "disable"]);
  assert.deepEqual(normalizeBridgeAppArgv(["hunsu://sign-in"]), ["login", "--gui"]);
  assert.deepEqual(normalizeBridgeAppArgv(["hunsu://sign-out"]), ["logout"]);
});

test("Bridge App headless commands persist device, Remote Access, Project Grant, and service state", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunsu-bridge-app-test-"));
  const statePath = join(root, "state.json");
  const credentialPath = join(root, "credentials.json");
  const relayRegistryPath = join(root, "relay.json");
  const roadmapRegistryPath = join(root, "roadmaps.json");
  const serviceUnitPath = join(root, "hunsu-bridge.service");
  const logPath = join(root, "bridge-app.log");
  const previousStatePath = process.env.HUNSU_BRIDGE_APP_STATE_PATH;
  const previousCredentialPath = process.env.HUNSU_BRIDGE_CREDENTIAL_PATH;
  const previousRelayRegistryPath = process.env.HUNSU_RELAY_REGISTRY_PATH;
  const previousRoadmapRegistryPath = process.env.HUNSU_ROADMAP_REGISTRY_PATH;
  const previousServiceUnitPath = process.env.HUNSU_BRIDGE_SERVICE_UNIT_PATH;
  const previousLogPath = process.env.HUNSU_BRIDGE_APP_LOG_PATH;
  const previousDevUser = process.env.HUNSU_BRIDGE_DEV_USER;
  const previousServiceDryRun = process.env.HUNSU_BRIDGE_SERVICE_DRY_RUN;
  const logs: string[] = [];
  const previousLog = console.log;

  process.env.HUNSU_BRIDGE_APP_STATE_PATH = statePath;
  process.env.HUNSU_BRIDGE_CREDENTIAL_PATH = credentialPath;
  process.env.HUNSU_RELAY_REGISTRY_PATH = relayRegistryPath;
  process.env.HUNSU_ROADMAP_REGISTRY_PATH = roadmapRegistryPath;
  process.env.HUNSU_BRIDGE_SERVICE_UNIT_PATH = serviceUnitPath;
  process.env.HUNSU_BRIDGE_APP_LOG_PATH = logPath;
  process.env.HUNSU_BRIDGE_DEV_USER = "dev@example.test";
  process.env.HUNSU_BRIDGE_SERVICE_DRY_RUN = "1";
  console.log = (...values: unknown[]) => {
    logs.push(values.map(String).join(" "));
  };

  try {
    assert.equal(await main(["login"]), 0);
    assert.equal(await main(["remote", "enable"]), 0);
    assert.equal(await main(["projects", "grant", root]), 0);
    writeFileSync(roadmapRegistryPath, JSON.stringify({
      version: 1,
      roadmaps: [{
        roadmapId: "roadmap_missing",
        displayName: "Missing Roadmap",
        repositoryPath: join(root, "missing-roadmap"),
        lastOpenedAt: new Date().toISOString(),
        health: "ok"
      }]
    }), "utf8");
    assert.equal(await main(["projects", "remove", "--roadmap-id", "roadmap_missing"]), 0);
    assert.equal(await main(["remote", "check", "execute.start", root]), 1);
    assert.equal(await main(["service", "install"]), 0);
    assert.equal(await main(["service", "start"]), 0);
    assert.equal(await main(["service", "stop"]), 0);
    assert.equal(await main(["status"]), 0);

    const state = JSON.parse(readFileSync(statePath, "utf8")) as {
      account: { status: string; email?: string };
      device: { registered: boolean };
      remoteAccess: string;
      projectGrants: Array<{ path: string; scopes: string[] }>;
      service: { installed: boolean; manager: string };
    };

    assert.deepEqual(state.account, { status: "signed-in", userId: "dev@example.test", email: "dev@example.test" });
    assert.equal(state.device.registered, true);
    assert.equal(state.remoteAccess, "registered-offline");
    assert.equal(state.projectGrants[0]?.path, root);
    assert.equal(state.projectGrants[0]?.scopes.includes("execute.start"), true);
    assert.equal(state.projectGrants[0]?.scopes.includes("remoteRelay.access"), true);
    assert.equal(state.service.installed, true);
    assert.match(state.service.manager, /systemd-user|launchd-user|windows-service|manual/);
    if (process.platform === "linux") {
      assert.match(readFileSync(serviceUnitPath, "utf8"), /ExecStart=.*supervise --cwd/);
    }
    assert.equal(logs.some(line => line.includes("Remote Access: Registered but offline")), true);
    assert.equal(existsSync(credentialPath), true);
    if (process.platform !== "win32") {
      assert.equal(statSync(credentialPath).mode & 0o077, 0);
    }
    const relay = new FileRelayRegistry(relayRegistryPath);
    assert.equal(relay.listDevices("dev@example.test")[0]?.status, "offline");
    const roadmapRegistry = JSON.parse(readFileSync(roadmapRegistryPath, "utf8")) as { roadmaps: unknown[] };
    assert.deepEqual(roadmapRegistry.roadmaps, []);
  } finally {
    console.log = previousLog;
    if (previousStatePath === undefined) {
      delete process.env.HUNSU_BRIDGE_APP_STATE_PATH;
    } else {
      process.env.HUNSU_BRIDGE_APP_STATE_PATH = previousStatePath;
    }
    if (previousCredentialPath === undefined) {
      delete process.env.HUNSU_BRIDGE_CREDENTIAL_PATH;
    } else {
      process.env.HUNSU_BRIDGE_CREDENTIAL_PATH = previousCredentialPath;
    }
    if (previousRelayRegistryPath === undefined) {
      delete process.env.HUNSU_RELAY_REGISTRY_PATH;
    } else {
      process.env.HUNSU_RELAY_REGISTRY_PATH = previousRelayRegistryPath;
    }
    if (previousRoadmapRegistryPath === undefined) {
      delete process.env.HUNSU_ROADMAP_REGISTRY_PATH;
    } else {
      process.env.HUNSU_ROADMAP_REGISTRY_PATH = previousRoadmapRegistryPath;
    }
    if (previousServiceUnitPath === undefined) {
      delete process.env.HUNSU_BRIDGE_SERVICE_UNIT_PATH;
    } else {
      process.env.HUNSU_BRIDGE_SERVICE_UNIT_PATH = previousServiceUnitPath;
    }
    if (previousLogPath === undefined) {
      delete process.env.HUNSU_BRIDGE_APP_LOG_PATH;
    } else {
      process.env.HUNSU_BRIDGE_APP_LOG_PATH = previousLogPath;
    }
    if (previousDevUser === undefined) {
      delete process.env.HUNSU_BRIDGE_DEV_USER;
    } else {
      process.env.HUNSU_BRIDGE_DEV_USER = previousDevUser;
    }
    if (previousServiceDryRun === undefined) {
      delete process.env.HUNSU_BRIDGE_SERVICE_DRY_RUN;
    } else {
      process.env.HUNSU_BRIDGE_SERVICE_DRY_RUN = previousServiceDryRun;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("Bridge App auth foundation creates PKCE, device flow, and secure file credentials", () => {
  const root = mkdtempSync(join(tmpdir(), "hunsu-bridge-auth-test-"));
  const credentialPath = join(root, "credentials.json");
  try {
    const pkce = createPkceAuthorizationRequest({
      clientId: "hunsu-bridge-app",
      redirectUri: "hunsu://pair",
      scope: "bridge relay"
    });
    assert.match(pkce.authorizationUrl, /code_challenge_method=S256/);
    assert.ok(pkce.codeVerifier.length > 30);
    assert.ok(pkce.codeChallenge.length > 30);

    const device = createDeviceAuthorizationRequest({ ttlSeconds: 60 });
    assert.match(device.verificationUri, /^https:\/\/hunsu\.app\/device/);
    assert.match(device.userCode, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);

    const store = new FileCredentialStore(credentialPath);
    store.write({
      schema: "hunsu.bridge-credentials.v1",
      accessToken: "access",
      userId: "user_123",
      deviceId: "device_123",
      deviceName: "test-device",
      savedAt: new Date().toISOString()
    });
    assert.equal(store.read()?.userId, "user_123");
    if (process.platform !== "win32") {
      assert.equal(statSync(credentialPath).mode & 0o077, 0);
    }
    store.clear();
    assert.equal(store.read(), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Bridge App auth uses OS credential adapters and exchanges GUI callback tokens", async () => {
  const macCalls: Array<{ command: string; args: string[]; input?: string }> = [];
  const macStore = new MacOsKeychainCredentialStore({
    runner: (command, args, options) => {
      macCalls.push({ command, args, input: options?.input });
      if (args[0] === "find-generic-password") {
        return JSON.stringify({
          schema: "hunsu.bridge-credentials.v1",
          accessToken: "access",
          userId: "user_123",
          deviceId: "device_123",
          deviceName: "mac",
          savedAt: new Date().toISOString()
        });
      }
      return "";
    }
  });
  assert.equal(macStore.read()?.userId, "user_123");
  macStore.write({
    schema: "hunsu.bridge-credentials.v1",
    accessToken: "access",
    userId: "user_123",
    deviceId: "device_123",
    deviceName: "mac",
    savedAt: new Date().toISOString()
  });
  assert.equal(macCalls.some(call => call.command === "security" && call.args.includes("add-generic-password")), true);

  const linuxCalls: Array<{ command: string; args: string[]; input?: string }> = [];
  const linuxStore = new LinuxSecretServiceCredentialStore({
    runner: (command, args, options) => {
      linuxCalls.push({ command, args, input: options?.input });
      return JSON.stringify({
        schema: "hunsu.bridge-credentials.v1",
        accessToken: "access",
        userId: "linux-user",
        deviceId: "device_123",
        deviceName: "linux",
        savedAt: new Date().toISOString()
      });
    }
  });
  assert.equal(linuxStore.read()?.userId, "linux-user");
  linuxStore.write({
    schema: "hunsu.bridge-credentials.v1",
    accessToken: "access",
    userId: "linux-user",
    deviceId: "device_123",
    deviceName: "linux",
    savedAt: new Date().toISOString()
  });
  assert.equal(linuxCalls.some(call => call.command === "secret-tool" && call.args[0] === "store" && call.input?.includes("linux-user")), true);

  const windowsStore = new WindowsDpapiCredentialStore("C:\\Users\\dev\\bridge-credentials.txt", () => JSON.stringify({
    schema: "hunsu.bridge-credentials.v1",
    accessToken: "access",
    userId: "windows-user",
    deviceId: "device_123",
    deviceName: "windows",
    savedAt: new Date().toISOString()
  }));
  assert.equal(windowsStore.backend, "windows-dpapi");

  const credentials = await exchangeAuthorizationCode({
    authBaseUrl: "https://auth.example.test",
    clientId: "hunsu-bridge-app",
    code: "code_123",
    codeVerifier: "verifier",
    redirectUri: "hunsu://pair",
    deviceId: "device_123",
    deviceName: "devbox",
    fetchImpl: async (url, init) => {
      assert.equal(String(url), "https://auth.example.test/oauth/token");
      assert.equal(init?.method, "POST");
      assert.match(String(init?.body), /grant_type=authorization_code/);
      return new Response(JSON.stringify({
        access_token: "access_token",
        refresh_token: "refresh_token",
        expires_in: 60,
        user_id: "user_123",
        email: "dev@example.test"
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
  });
  assert.equal(credentials.userId, "user_123");
  assert.equal(credentials.email, "dev@example.test");
  assert.equal(credentials.deviceId, "device_123");
});

test("Bridge App device flow polls and persists credentials from local dev auth provider", async () => {
  const server = await startLocalDevAuthServer({ userId: "device-user@example.test" });
  try {
    const request = await startDeviceAuthorization({
      authBaseUrl: server.authBaseUrl,
      clientId: "hunsu-bridge-headless",
      scope: "bridge device relay",
      deviceId: "device_123",
      deviceName: "devbox"
    });
    assert.match(request.userCode, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);

    const pending = pollDeviceAuthorization({
      authBaseUrl: server.authBaseUrl,
      clientId: "hunsu-bridge-headless",
      deviceCode: request.deviceCode,
      deviceId: "device_123",
      deviceName: "devbox",
      intervalSeconds: request.intervalSeconds,
      expiresAt: request.expiresAt,
      maxWaitMs: 2000,
      sleep: async () => {
        await delay(5);
      }
    });
    await fetch(request.verificationUriComplete ?? `${request.verificationUri}?user_code=${encodeURIComponent(request.userCode)}`);
    const credentials = await pending;
    assert.equal(credentials.userId, "device-user@example.test");
    assert.equal(credentials.deviceId, "device_123");
    assert.equal(credentials.deviceName, "devbox");
    assert.match(credentials.accessToken, /^local_dev_access_/);
  } finally {
    await server.close();
  }
});

test("Bridge App relay foundation enforces device status, Project Grants, and command scopes", () => {
  const grant: ProjectGrant = {
    path: "/tmp/hunsu-project",
    grantedAt: new Date().toISOString(),
    scopes: ["execute.start", "remoteRelay.access"]
  };
  const device = {
    deviceId: "device_123",
    deviceName: "devbox",
    userId: "user_123",
    registeredAt: new Date().toISOString(),
    status: "online" as const
  };

  assert.deepEqual(scopesForRelayCommand("execute.start"), ["execute.start", "remoteRelay.access"]);
  assert.deepEqual(scopesForRelayCommand("roadmap.board"), ["remoteRelay.access"]);
  assert.deepEqual(scopesForRelayCommand("artifactAction.runs"), ["remoteRelay.access"]);
  assert.equal(evaluateRelayCommand({
    device,
    command: { deviceId: device.deviceId, command: "execute.start", projectPath: "/tmp/hunsu-project" },
    projectGrants: [grant]
  }).ok, true);
  assert.equal(evaluateRelayCommand({
    device: { ...device, status: "offline" },
    command: { deviceId: device.deviceId, command: "execute.start", projectPath: "/tmp/hunsu-project" },
    projectGrants: [grant]
  }).ok, false);
  const denied = evaluateRelayCommand({
    device,
    command: { deviceId: device.deviceId, command: "artifactAction.start", projectPath: "/tmp/hunsu-project" },
    projectGrants: [grant]
  });
  assert.deepEqual(denied, {
    ok: false,
    reason: "command_scope_denied",
    message: "Project Grant does not allow artifactAction.run."
  });
  assert.deepEqual(relayHttpRequestForCommand({ deviceId: device.deviceId, command: "roadmap.open", projectPath: "/tmp/hunsu-project" }), {
    method: "POST",
    path: "/api/roadmaps/open",
    body: { path: "/tmp/hunsu-project" }
  });
  assert.deepEqual(relayHttpRequestForCommand({
    deviceId: device.deviceId,
    command: "roadmap.board",
    projectPath: "/tmp/hunsu-project",
    payload: { roadmapId: "roadmap_123" }
  }), {
    method: "GET",
    path: "/api/roadmaps/roadmap_123/board"
  });
  assert.deepEqual(relayHttpRequestForCommand({
    deviceId: device.deviceId,
    command: "execute.start",
    projectPath: "/tmp/hunsu-project",
    payload: { roadmapId: "roadmap_123", selectedDestinationIds: ["destination_001"] }
  }), {
    method: "POST",
    path: "/api/roadmaps/roadmap_123/executes/start",
    body: { roadmapId: "roadmap_123", selectedDestinationIds: ["destination_001"] }
  });
  assert.deepEqual(relayHttpRequestForCommand({
    deviceId: device.deviceId,
    command: "artifactAction.start",
    projectPath: "/tmp/hunsu-project",
    payload: { roadmapId: "roadmap_123", actionId: "host-web", commit: "HEAD" }
  }), {
    method: "POST",
    path: "/api/roadmaps/roadmap_123/artifact-actions/host-web/runs",
    body: { roadmapId: "roadmap_123", actionId: "host-web", commit: "HEAD" }
  });
  assert.deepEqual(relayHttpRequestForCommand({
    deviceId: device.deviceId,
    command: "artifactAction.stop",
    projectPath: "/tmp/hunsu-project",
    payload: { roadmapId: "roadmap_123", runId: "run_123" }
  }), {
    method: "POST",
    path: "/api/roadmaps/roadmap_123/action-runs/run_123/stop",
    body: { roadmapId: "roadmap_123", runId: "run_123" }
  });
  assert.deepEqual(relayHttpRequestForCommand({
    deviceId: device.deviceId,
    command: "moveFile.blob",
    projectPath: "/tmp/hunsu-project",
    payload: { roadmapId: "roadmap_123", moveId: "M0001", path: "src/App.tsx" }
  }), {
    method: "GET",
    path: "/api/roadmaps/roadmap_123/moves/M0001/files/blob?path=src%2FApp.tsx"
  });
  assert.deepEqual(relayHttpRequestForCommand({
    deviceId: device.deviceId,
    command: "hunsuDraft.diffArtifact.get",
    projectPath: "/tmp/hunsu-project",
    payload: { roadmapId: "roadmap_123", draftSessionId: "draft_1", diffArtifactId: "diff_1" }
  }), {
    method: "GET",
    path: "/api/roadmaps/roadmap_123/hunsu/drafts/draft_1/diff-artifacts/diff_1"
  });
  assert.deepEqual(relayHttpRequestForCommand({
    deviceId: device.deviceId,
    command: "agentSession.events",
    projectPath: "/tmp/hunsu-project",
    payload: { roadmapId: "roadmap_123", sessionId: "agent_1" }
  }), {
    method: "GET",
    path: "/api/roadmaps/roadmap_123/agent-sessions/agent_1/events",
    stream: true
  });
});

test("Bridge App Remote Access registry records offline and online device transitions", () => {
  const root = mkdtempSync(join(tmpdir(), "hunsu-remote-access-state-"));
  const registry = new FileRelayRegistry(join(root, "relay.json"));
  try {
    const registered = registry.registerDevice({
      deviceId: "device_state",
      deviceName: "state-devbox",
      userId: "user_state",
      bridgeVersion: "0.1.2",
      protocolVersion: "local-bridge-v1"
    });
    assert.equal(registered.status, "offline");
    assert.equal(registry.updateDeviceStatus("device_state", "online")?.status, "online");
    assert.equal(registry.listDevices("user_state")[0]?.status, "online");
    assert.equal(registry.updateDeviceStatus("device_state", "offline")?.status, "offline");
    assert.equal(registry.listDevices("user_state")[0]?.status, "offline");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Bridge App validates remote roadmapId against the granted local project path before forwarding", async () => {
  const calls: string[] = [];
  const result = await forwardRelayCommand({
    bridgeApiUrl: "http://127.0.0.1:19689",
    bridgeAuthToken: "token",
    command: {
      deviceId: "device_123",
      command: "execute.start",
      projectPath: "/tmp/granted-project",
      payload: { roadmapId: "roadmap_other", selectedDestinationIds: ["destination_001"] }
    },
    fetchImpl: async (url, init) => {
      calls.push(`${init?.method ?? "GET"} ${new URL(String(url)).pathname}`);
      assert.equal(String(url), "http://127.0.0.1:19689/api/roadmaps/recent");
      return new Response(JSON.stringify({
        roadmaps: [{
          roadmapId: "roadmap_other",
          repositoryPath: "/tmp/different-project",
          displayName: "Different Project"
        }]
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
  });

  assert.deepEqual(calls, ["GET /api/roadmaps/recent"]);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.status, 403);
    assert.match(result.error, /does not belong/);
  }
});

test("Bridge App forwards remote event streams incrementally", async () => {
  const events: Array<{ event?: string; data?: string }> = [];
  const result = await forwardRelayCommandStream({
    bridgeApiUrl: "http://127.0.0.1:19689",
    bridgeAuthToken: "token",
    command: {
      deviceId: "device_123",
      command: "live.events",
      projectPath: "/tmp/hunsu-project",
      payload: { roadmapId: "roadmap_123" }
    },
    onEvent: event => events.push(event),
    fetchImpl: async (url, init) => {
      const pathname = new URL(String(url)).pathname;
      if (pathname === "/api/roadmaps/recent") {
        return new Response(JSON.stringify({
          roadmaps: [{
            roadmapId: "roadmap_123",
            repositoryPath: "/tmp/hunsu-project",
            displayName: "Hunsu Project"
          }]
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      assert.equal(pathname, "/api/roadmaps/roadmap_123/executes/events");
      assert.equal(init?.method, "GET");
      return new Response([
        ": connected",
        "",
        "event: runs.snapshot",
        "data: {\"type\":\"runs.snapshot\",\"runs\":[]}",
        "",
        "event: run.updated",
        "data: {\"type\":\"run.updated\",\"run\":{\"runId\":\"run_1\"}}",
        "",
        ""
      ].join("\n"), { status: 200, headers: { "content-type": "text/event-stream" } });
    }
  });

  assert.equal(result.ok, true);
  assert.deepEqual(events, [
    { event: "runs.snapshot", data: "{\"type\":\"runs.snapshot\",\"runs\":[]}" },
    { event: "run.updated", data: "{\"type\":\"run.updated\",\"run\":{\"runId\":\"run_1\"}}" }
  ]);
});

test("Local dev Relay service authenticates sessions, lists devices, and routes typed commands", async () => {
  const relay = new LocalDevRelayService();
  relay.registerSession({ accessToken: "web-token", userId: "user_123" });
  const device = relay.registerDevice("web-token", {
    deviceId: "device_123",
    deviceName: "devbox",
    userId: "user_123",
    bridgeVersion: "0.1.2",
    protocolVersion: "local-bridge-v1"
  });
  assert.equal(device.status, "offline");
  assert.equal(relay.listDevices("web-token")[0]?.deviceName, "devbox");
  relay.connectDevice("web-token", "device_123", async envelope => {
    assert.equal(envelope.userId, "user_123");
    assert.equal(envelope.command.command, "execute.start");
    return { ok: true, status: 202, body: { accepted: true } };
  });
  assert.deepEqual(await relay.routeCommand("web-token", {
    deviceId: "device_123",
    command: "execute.start",
    projectPath: "/tmp/hunsu-project",
    payload: { roadmapId: "roadmap_123" }
  }), { ok: true, status: 202, body: { accepted: true } });
  relay.markDeviceOffline("web-token", "device_123");
  const offline = await relay.routeCommand("web-token", {
    deviceId: "device_123",
    command: "execute.start",
    projectPath: "/tmp/hunsu-project"
  });
  assert.equal(offline.ok, false);
  if (!offline.ok && "reason" in offline) assert.equal(offline.reason, "device_offline");
});

test("Bridge App outbound Relay client registers devices and forwards only granted typed commands", async () => {
  const sent: unknown[] = [];
  let onOpen: (() => void) | undefined;
  let onMessage: ((event: { data: unknown }) => void) | undefined;
  const socket = {
    send(message: string) {
      sent.push(JSON.parse(message));
    },
    close() {},
    addEventListener(event: "open" | "message" | "close" | "error", listener: (payload: unknown) => void) {
      if (event === "open") onOpen = listener as () => void;
      if (event === "message") onMessage = listener as (payload: { data: unknown }) => void;
    }
  };
  const grant: ProjectGrant = {
    path: "/tmp/hunsu-project",
    grantedAt: new Date().toISOString(),
    scopes: ["remoteRelay.access"]
  };
  const client = new RelayOutboundClient({
    relayUrl: "wss://relay.example.test/device",
    device: {
      deviceId: "device_123",
      deviceName: "devbox",
      userId: "user_123",
      registeredAt: new Date().toISOString(),
      status: "online"
    },
    projectGrants: [grant],
    bridgeApiUrl: "http://127.0.0.1:19689",
    bridgeAuthToken: "token",
    websocketFactory: () => socket,
    fetchImpl: async (url, init) => {
      assert.equal(String(url), "http://127.0.0.1:19689/api/roadmaps/open");
      assert.equal(init?.method, "POST");
      assert.equal((init?.headers as Record<string, string>)["x-hunsu-bridge-token"], "token");
      return new Response(JSON.stringify({ ok: true }), { status: 202, headers: { "content-type": "application/json" } });
    }
  });

  try {
    client.start();
    onOpen?.();
    assert.equal((sent[0] as { type: string }).type, "device.register");
    onMessage?.({ data: JSON.stringify({
      type: "command",
      commandId: "command_1",
      userId: "user_123",
      command: { deviceId: "device_123", command: "roadmap.open", projectPath: "/tmp/hunsu-project" }
    }) });
    await delay(0);
    assert.deepEqual(sent.at(-1), {
      type: "command.result",
      commandId: "command_1",
      result: { ok: true, status: 202, body: { ok: true } }
    });

    onMessage?.({ data: JSON.stringify({
      type: "command",
      commandId: "command_2",
      userId: "user_123",
      command: { deviceId: "device_123", command: "execute.start", projectPath: "/tmp/hunsu-project" }
    }) });
    await delay(0);
    assert.equal((sent.at(-1) as { result: { ok: boolean; reason?: string } }).result.ok, false);
    assert.equal((sent.at(-1) as { result: { ok: boolean; reason?: string } }).result.reason, "command_scope_denied");
  } finally {
    client.stop();
  }
});

test("Bridge App outbound Relay client heartbeats and reconnects with backoff", async () => {
  type Listener = (event?: unknown) => void;
  const sockets: Array<{
    sent: unknown[];
    closed: boolean;
    send(message: string): void;
    close(): void;
    addEventListener(event: "open" | "message" | "close" | "error", listener: Listener): void;
    emit(event: "open" | "message" | "close" | "error", payload?: unknown): void;
  }> = [];

  function createSocket() {
    const listeners = new Map<string, Listener[]>();
    const socket = {
      sent: [] as unknown[],
      closed: false,
      send(message: string) {
        socket.sent.push(JSON.parse(message));
      },
      close() {
        socket.closed = true;
      },
      addEventListener(event: "open" | "message" | "close" | "error", listener: Listener) {
        listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      },
      emit(event: "open" | "message" | "close" | "error", payload?: unknown) {
        for (const listener of listeners.get(event) ?? []) {
          listener(payload);
        }
      }
    };
    sockets.push(socket);
    return socket;
  }

  const client = new RelayOutboundClient({
    relayUrl: "wss://relay.example.test/device",
    device: {
      deviceId: "device_heartbeat",
      deviceName: "devbox",
      userId: "user_123",
      registeredAt: new Date().toISOString(),
      status: "online"
    },
    projectGrants: [],
    websocketFactory: createSocket,
    heartbeatIntervalMs: 10,
    reconnectInitialDelayMs: 15,
    reconnectMaxDelayMs: 15
  });

  try {
    client.start();
    assert.equal(sockets.length, 1);
    sockets[0]?.emit("open");
    assert.equal((sockets[0]?.sent[0] as { type?: string } | undefined)?.type, "device.register");
    assert.equal((sockets[0]?.sent[1] as { type?: string } | undefined)?.type, "device.heartbeat");
    await waitFor(() => (sockets[0]?.sent.filter(message => (message as { type?: string }).type === "device.heartbeat").length ?? 0) >= 2);

    sockets[0]?.emit("close");
    assert.equal(client.status().status, "closed");
    await waitFor(() => sockets.length === 2);
    assert.equal(client.status().status, "connecting");
    sockets[1]?.emit("open");
    assert.equal(client.status().status, "connected");
    assert.equal((sockets[1]?.sent[0] as { type?: string } | undefined)?.type, "device.register");

    client.stop();
    const socketCountAfterStop = sockets.length;
    sockets[1]?.emit("close");
    await delay(25);
    assert.equal(sockets.length, socketCountAfterStop);
    assert.equal(client.status().status, "closed");
  } finally {
    client.stop();
  }
});

const BUILT_CURRENT_PLATFORM_SIDECAR = join(
  process.cwd(),
  "apps/bridge-desktop/dist",
  process.platform === "win32" ? "hunsu-bridge-sidecar.exe" : "hunsu-bridge-sidecar"
);
const SIDECAR_DIST_DIR = join(process.cwd(), "apps/bridge-desktop/dist");
const SIDECAR_DIST_MUTATED_FILES = [
  "sidecar-manifest.json",
  "hunsu-bridge-sidecar",
  "hunsu-bridge-sidecar.exe",
  "hunsu-bridge-sidecar-x86_64-apple-darwin",
  "hunsu-bridge-sidecar-aarch64-apple-darwin",
  "hunsu-bridge-sidecar-x86_64-unknown-linux-gnu",
  "hunsu-bridge-sidecar-aarch64-unknown-linux-gnu",
  "hunsu-bridge-sidecar-x86_64-pc-windows-msvc.exe",
  "hunsu-bridge-sidecar-aarch64-pc-windows-msvc.exe"
];

test("built current-platform Bridge sidecar status matches the Node bundle", {
  skip: existsSync(BUILT_CURRENT_PLATFORM_SIDECAR) ? false : "Build @hunsu/bridge-desktop to generate the current-platform sidecar."
}, () => {
  const root = mkdtempSync(join(tmpdir(), "hunsu-bridge-sidecar-smoke-test-"));
  const env = {
    ...process.env,
    HUNSU_BRIDGE_APP_STATE_PATH: join(root, "state.json"),
    HUNSU_ROADMAP_REGISTRY_PATH: join(root, "roadmaps.json"),
    HUNSU_BRIDGE_CREDENTIAL_PATH: join(root, "credentials.json"),
    HUNSU_RELAY_REGISTRY_PATH: join(root, "relay.json"),
    HUNSU_BRIDGE_APP_LOG_PATH: join(root, "bridge-app.log")
  };
  try {
    const bundle = spawnSync(process.execPath, [
      "apps/bridge-desktop/dist/sidecar-bundle.cjs",
      "status"
    ], { cwd: process.cwd(), env, encoding: "utf8" });
    assert.equal(bundle.status, 0, bundle.stderr);

    const native = spawnSync(BUILT_CURRENT_PLATFORM_SIDECAR, ["status"], {
      cwd: process.cwd(),
      env,
      encoding: "utf8"
    });
    assert.equal(native.status, 0, native.stderr);
    assert.equal(native.stdout, bundle.stdout);
    assert.match(native.stdout, /Local Bridge: Not Running/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Bridge App protocol plan and sidecar supervisor expose native desktop foundations", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunsu-bridge-sidecar-test-"));
  const logPath = join(root, "sidecar.log");
  const sidecarDistSnapshot = snapshotSidecarDist();
  try {
    const plan = protocolRegistrationPlan("/tmp/hunsu-bridge-app");
    assert.equal(plan.protocol, "hunsu");
    assert.equal(plan.supported, process.platform === "darwin" || process.platform === "win32" || process.platform === "linux");
    assert.match(readFileSync(join(process.cwd(), "apps/bridge-desktop/src-tauri/Info.plist"), "utf8"), /CFBundleURLSchemes/);
    assert.match(readFileSync(join(process.cwd(), "apps/bridge-desktop/src-tauri/windows/hunsu-protocol.wxs"), "utf8"), /Software\\Classes\\hunsu/);
    const tauriConfig = JSON.parse(readFileSync(join(process.cwd(), "apps/bridge-desktop/src-tauri/tauri.conf.json"), "utf8")) as {
      bundle: { externalBin?: string[]; resources?: string[] };
    };
    assert.deepEqual(tauriConfig.bundle.externalBin, ["../dist/hunsu-bridge-sidecar"]);
    assert.equal(tauriConfig.bundle.resources?.includes("../dist/hunsu-bridge-sidecar*"), true);
    assert.match(readFileSync(join(process.cwd(), "apps/bridge-desktop/src-tauri/src/main.rs"), "utf8"), /hunsu-bridge-sidecar/);
    const sidecarScript = readFileSync(join(process.cwd(), "apps/bridge-desktop/scripts/prepare-sidecars.mjs"), "utf8");
    const buildScript = readFileSync(join(process.cwd(), "apps/bridge-desktop/scripts/build-native-sidecars.mjs"), "utf8");
    const packageJson = JSON.parse(readFileSync(join(process.cwd(), "apps/bridge-desktop/package.json"), "utf8")) as {
      scripts: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    assert.match(packageJson.scripts.build, /build-native-sidecars\.mjs/);
    assert.match(packageJson.scripts["sidecars:build"], /build-native-sidecars\.mjs/);
    assert.equal(packageJson.devDependencies.esbuild.length > 0, true);
    assert.equal(packageJson.devDependencies.postject.length > 0, true);
    assert.match(sidecarScript, /x86_64-apple-darwin/);
    assert.match(sidecarScript, /x86_64-pc-windows-msvc/);
    assert.match(sidecarScript, /extension: "\.exe"/);
    assert.doesNotMatch(sidecarScript, /exec node "\$SCRIPT_DIR\/main\.js"/);
    assert.doesNotMatch(sidecarScript, /hunsu-bridge-sidecar-x86_64-pc-windows-msvc\.cmd/);
    assert.match(buildScript, /NODE_SEA_BLOB/);
    assert.match(buildScript, /postject/);
    assert.match(buildScript, /SHASUMS256\.txt/);
    assert.match(buildScript, /darwin-x64/);
    assert.match(buildScript, /win-arm64/);
    assert.match(readFileSync(join(process.cwd(), "apps/bridge-desktop/src-tauri/src/main.rs"), "utf8"), /hunsu-bridge-sidecar\.exe/);

    const launcherPath = join(root, "hunsu-bridge-sidecar-x86_64-unknown-linux-gnu");
    writeFileSync(launcherPath, [
      "#!/usr/bin/env sh",
      "exec node \"$SCRIPT_DIR/main.js\" \"$@\"",
      "#".repeat(5000),
      ""
    ].join("\n"), "utf8");
    const rejected = spawnSync(process.execPath, [
      "--conditions=development",
      "apps/bridge-desktop/scripts/prepare-sidecars.mjs",
      "--check",
      launcherPath
    ], { cwd: process.cwd(), encoding: "utf8" });
    assert.notEqual(rejected.status, 0);
    assert.match(`${rejected.stdout}\n${rejected.stderr}`, /Node launcher/);

    const accepted = spawnSync(process.execPath, [
      "--conditions=development",
      "apps/bridge-desktop/scripts/prepare-sidecars.mjs",
      "--check",
      process.execPath
    ], { cwd: process.cwd(), encoding: "utf8" });
    assert.equal(accepted.status, 0, accepted.stderr);

    const nativeDir = join(root, "native-sidecars");
    mkdirSync(nativeDir);
    const sidecarArtifacts = [
      ["hunsu-bridge-sidecar-x86_64-apple-darwin", "mach-o"],
      ["hunsu-bridge-sidecar-aarch64-apple-darwin", "mach-o"],
      ["hunsu-bridge-sidecar-x86_64-unknown-linux-gnu", "elf"],
      ["hunsu-bridge-sidecar-aarch64-unknown-linux-gnu", "elf"],
      ["hunsu-bridge-sidecar-x86_64-pc-windows-msvc.exe", "pe"],
      ["hunsu-bridge-sidecar-aarch64-pc-windows-msvc.exe", "pe"]
    ] as const;
    for (const [artifact, kind] of sidecarArtifacts) {
      writeFileSync(join(nativeDir, artifact), fakeNativeExecutable(kind));
    }
    const prepared = spawnSync(process.execPath, [
      "--conditions=development",
      "apps/bridge-desktop/scripts/prepare-sidecars.mjs",
      "--native-dir",
      nativeDir
    ], { cwd: process.cwd(), encoding: "utf8" });
    assert.equal(prepared.status, 0, prepared.stderr);
    const sidecarManifest = JSON.parse(readFileSync(join(process.cwd(), "apps/bridge-desktop/dist/sidecar-manifest.json"), "utf8")) as {
      artifacts: Array<{ target: string; file: string; kind: string }>;
      currentPlatform?: { file: string };
    };
    assert.equal(sidecarManifest.artifacts.length, sidecarArtifacts.length);
    assert.deepEqual(sidecarManifest.artifacts.map(artifact => artifact.kind), sidecarArtifacts.map(() => "native-executable"));
    assert.equal(sidecarManifest.artifacts.some(artifact => artifact.file.endsWith(".cmd")), false);
    if (sidecarManifest.currentPlatform) {
      assert.equal(existsSync(join(process.cwd(), "apps/bridge-desktop/dist", sidecarManifest.currentPlatform.file)), true);
    }

    const bundleOnly = spawnSync("pnpm", [
      "--filter",
      "@hunsu/bridge-desktop",
      "sidecars:build",
      "--",
      "--bundle-only"
    ], { cwd: process.cwd(), encoding: "utf8" });
    assert.equal(bundleOnly.status, 0, bundleOnly.stderr);
    const bundledStatus = spawnSync(process.execPath, [
      "apps/bridge-desktop/dist/sidecar-bundle.cjs",
      "status"
    ], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        HUNSU_BRIDGE_APP_STATE_PATH: join(root, "bundle-state.json"),
        HUNSU_ROADMAP_REGISTRY_PATH: join(root, "bundle-roadmaps.json"),
        HUNSU_BRIDGE_CREDENTIAL_PATH: join(root, "bundle-credentials.json"),
        HUNSU_RELAY_REGISTRY_PATH: join(root, "bundle-relay.json")
      }
    });
    assert.equal(bundledStatus.status, 0, bundledStatus.stderr);
    assert.match(bundledStatus.stdout, /Local Bridge: Not Running/);

    const supervisor = new BridgeSidecarSupervisor({
      command: process.execPath,
      args: ["-e", "process.exit(2)"],
      logPath,
      restartLimit: 1,
      restartDelayMs: 20
    });
    supervisor.start();
    await waitForSidecarStatus(supervisor, "crashed", 1);
    assert.equal(supervisor.status().status, "crashed");
    assert.equal(supervisor.status().restartCount, 1);
    assert.match(readFileSync(logPath, "utf8"), /sidecar.crashed/);
  } finally {
    restoreSidecarDist(sidecarDistSnapshot);
    rmSync(root, { recursive: true, force: true });
  }
});

function snapshotSidecarDist(): Map<string, Buffer | undefined> {
  return new Map(SIDECAR_DIST_MUTATED_FILES.map(file => {
    const path = join(SIDECAR_DIST_DIR, file);
    return [path, existsSync(path) ? readFileSync(path) : undefined];
  }));
}

function restoreSidecarDist(snapshot: Map<string, Buffer | undefined>): void {
  mkdirSync(SIDECAR_DIST_DIR, { recursive: true });
  for (const [path, content] of snapshot) {
    if (content === undefined) {
      rmSync(path, { force: true });
    } else {
      writeFileSync(path, content);
      if (!path.endsWith(".exe") && path.includes("hunsu-bridge-sidecar")) {
        chmodSync(path, 0o755);
      }
    }
  }
}

function fakeNativeExecutable(kind: "elf" | "mach-o" | "pe"): Buffer {
  const buffer = Buffer.alloc(4097);
  switch (kind) {
    case "elf":
      buffer.set([0x7f, 0x45, 0x4c, 0x46], 0);
      break;
    case "mach-o":
      buffer.set([0xfe, 0xed, 0xfa, 0xcf], 0);
      break;
    case "pe":
      buffer.set([0x4d, 0x5a, 0x90, 0x00], 0);
      break;
  }
  return buffer;
}

test("Bridge App sidecar supervisor cancels crash restart when stopped intentionally", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunsu-bridge-sidecar-stop-test-"));
  const logPath = join(root, "sidecar.log");
  try {
    const supervisor = new BridgeSidecarSupervisor({
      command: process.execPath,
      args: ["-e", "process.exit(2)"],
      logPath,
      restartLimit: 3,
      restartDelayMs: 200
    });
    supervisor.start();
    await waitForSidecarStatus(supervisor, "crashed", 0);
    assert.equal(supervisor.status().status, "crashed");
    await supervisor.stop();
    await delay(260);
    assert.equal(supervisor.status().status, "stopped");
    assert.equal(supervisor.status().restartCount, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Bridge App stop terminates the integrated restart supervisor and daemon", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunsu-bridge-integrated-stop-"));
  const statePath = join(root, "bridge-app-state.json");
  const logPath = join(root, "bridge-app.log");
  const registryPath = join(root, "roadmaps.json");
  const credentialPath = join(root, "credentials.json");
  const relayRegistryPath = join(root, "relay.json");
  const bridgePort = await getUnusedPort();
  const childEnv = {
    ...process.env,
    HUNSU_BRIDGE_APP_STATE_PATH: statePath,
    HUNSU_BRIDGE_APP_LOG_PATH: logPath,
    HUNSU_ROADMAP_REGISTRY_PATH: registryPath,
    HUNSU_BRIDGE_CREDENTIAL_PATH: credentialPath,
    HUNSU_RELAY_REGISTRY_PATH: relayRegistryPath,
    HUNSU_BRIDGE_PORT: String(bridgePort)
  };
  const child = spawn(process.execPath, [
    "--conditions=development",
    "apps/bridge-desktop/src/main.ts",
    "start",
    "--cwd",
    root,
    "--web-url",
    "http://127.0.0.1:19688/studio",
    "--no-open",
    "--restart-limit",
    "3"
  ], {
    cwd: process.cwd(),
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", chunk => {
    stdout += chunk.toString("utf8");
  });
  child.stderr?.on("data", chunk => {
    stderr += chunk.toString("utf8");
  });

  const envKeys = [
    "HUNSU_BRIDGE_APP_STATE_PATH",
    "HUNSU_BRIDGE_APP_LOG_PATH",
    "HUNSU_ROADMAP_REGISTRY_PATH",
    "HUNSU_BRIDGE_CREDENTIAL_PATH",
    "HUNSU_RELAY_REGISTRY_PATH",
    "HUNSU_BRIDGE_PORT"
  ];
  const previousEnv = snapshotEnv(envKeys);
  try {
    await waitFor(async () => {
      if (!existsSync(statePath)) return false;
      const state = JSON.parse(readFileSync(statePath, "utf8")) as { supervisorPid?: number; pid?: number };
      return state.supervisorPid === child.pid && typeof state.pid === "number";
    }, 5_000);
    const health = await fetch(`http://127.0.0.1:${bridgePort}/health`);
    assert.equal(health.status, 200);

    applyEnv(childEnv, envKeys);
    const initialState = JSON.parse(readFileSync(statePath, "utf8")) as { authToken?: string; controlToken?: string };
    assert.match(initialState.authToken ?? "", /^hunsu_bridge_/);
    assert.match(initialState.controlToken ?? "", /^hunsu_bridge_control_/);

    const pairLogs: string[] = [];
    const previousPairLog = console.log;
    console.log = (...values: unknown[]) => {
      pairLogs.push(values.map(String).join(" "));
    };
    try {
      assert.equal(await main([
        "pair",
        "--web-url",
        "http://127.0.0.1:19688/studio",
        "--no-open"
      ]), 0);
    } finally {
      console.log = previousPairLog;
    }
    assert.equal(pairLogs.some(line => line.includes("Hunsu Bridge pairing refreshed on the running managed Bridge.")), true);
    const pairedState = JSON.parse(readFileSync(statePath, "utf8")) as { authToken?: string; controlToken?: string };
    assert.notEqual(pairedState.authToken, initialState.authToken);
    assert.equal(pairedState.controlToken, initialState.controlToken);
    const oldTokenResponse = await fetch(`http://127.0.0.1:${bridgePort}/api/roadmaps/recent`, {
      headers: { "x-hunsu-bridge-token": initialState.authToken ?? "" }
    });
    assert.equal(oldTokenResponse.status, 401);
    const newTokenResponse = await fetch(`http://127.0.0.1:${bridgePort}/api/roadmaps/recent`, {
      headers: { "x-hunsu-bridge-token": pairedState.authToken ?? "" }
    });
    assert.equal(newTokenResponse.status, 200);

    const logs: string[] = [];
    const previousLog = console.log;
    console.log = (...values: unknown[]) => {
      logs.push(values.map(String).join(" "));
    };
    try {
      assert.equal(await main(["stop"]), 0);
    } finally {
      console.log = previousLog;
    }
    assert.equal(logs.some(line => line.includes("Hunsu Bridge stopped.")), true);
    await waitForChildExit(child, 5_000, () => `${stdout}\n${stderr}`);
    await waitFor(async () => !(await bridgeHealthReachable(bridgePort)), 2_000);
    await delay(900);
    assert.equal(await bridgeHealthReachable(bridgePort), false);
    const stoppedState = JSON.parse(readFileSync(statePath, "utf8")) as { supervisorPid?: number; pid?: number };
    assert.equal(stoppedState.supervisorPid, undefined);
    assert.equal(stoppedState.pid, undefined);
  } finally {
    restoreEnv(previousEnv);
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await Promise.race([waitForChildExit(child, 1_000), delay(1_000)]).catch(() => undefined);
    }
    rmSync(root, { recursive: true, force: true });
  }
});

async function waitForSidecarStatus(
  supervisor: BridgeSidecarSupervisor,
  status: ReturnType<BridgeSidecarSupervisor["status"]>["status"],
  restartCount: number,
  timeoutMs = 1000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = supervisor.status();
    if (current.status === status && current.restartCount === restartCount) {
      return;
    }
    await delay(10);
  }
  const current = supervisor.status();
  assert.fail(`Timed out waiting for sidecar status ${status}/${restartCount}; got ${current.status}/${current.restartCount}`);
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await delay(10);
  }
  assert.fail("Timed out waiting for condition.");
}

async function waitForChildExit(child: ReturnType<typeof spawn>, timeoutMs: number, diagnostics: () => string = () => ""): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.off("exit", onExit);
      reject(new Error(`Timed out waiting for Bridge App child exit.\n${diagnostics()}`));
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timeout);
      resolve();
    };
    child.once("exit", onExit);
  });
}

async function getUnusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : undefined;
  await new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  });
  if (!port) {
    throw new Error("Unable to allocate an unused local port.");
  }
  return port;
}

async function bridgeHealthReachable(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    return response.ok;
  } catch (_error) {
    return false;
  }
}

function snapshotEnv(keys: string[]): Record<string, string | undefined> {
  return Object.fromEntries(keys.map(key => [key, process.env[key]]));
}

function applyEnv(values: NodeJS.ProcessEnv, keys: string[]): void {
  for (const key of keys) {
    const value = values[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function restoreEnv(values: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}
