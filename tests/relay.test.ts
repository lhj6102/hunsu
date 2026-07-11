import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createHunsuRelayServer } from "../apps/relay/src/index.ts";
import type { RelayServerConfig } from "../packages/config/src/index.ts";

test("Relay service authenticates device flow, registers WebSocket devices, and routes typed commands", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunsu-relay-test-"));
  const relay = createHunsuRelayServer({
    config: relayTestConfig(join(root, "relay-state.json")),
    commandTimeoutMs: 1000
  });
  const urls = await relay.listen();
  try {
    const deviceCodeResponse = await postForm(`${urls.apiUrl}/oauth/device/code`, {
      client_id: "hunsu-bridge-headless",
      device_id: "device_123",
      device_name: "relay-devbox",
      scope: "bridge device relay"
    }) as {
      device_code: string;
      user_code: string;
      verification_uri_complete: string;
    };

    await fetch(deviceCodeResponse.verification_uri_complete);
    const token = await postForm(`${urls.apiUrl}/oauth/token`, {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      client_id: "hunsu-bridge-headless",
      device_code: deviceCodeResponse.device_code
    }) as { access_token: string; user_id: string };

    assert.equal(token.user_id, "local-relay-user");

    const registeredOnly = await relayJson(`${urls.apiUrl}/v1/devices`, token.access_token, {
      device: {
        deviceId: "device_123",
        deviceName: "relay-devbox",
        userId: token.user_id,
        registeredAt: new Date().toISOString(),
        status: "online",
        bridgeVersion: "0.1.2",
        protocolVersion: "local-bridge-v1"
      },
      projectGrants: [{
        path: "/tmp/hunsu-project",
        grantedAt: new Date().toISOString(),
        scopes: ["execute.start", "remoteRelay.access"]
      }]
    }, 202) as { device: { status: string } };
    assert.equal(registeredOnly.device.status, "offline");

    const grantedStatus = await relayJson(`${urls.apiUrl}/v1/project-grants/status`, token.access_token, {
      deviceId: "device_123",
      projectPath: "/tmp/hunsu-project",
      requestedScopes: ["remoteRelay.access"]
    }) as { projectAccess: string };
    assert.equal(grantedStatus.projectAccess, "granted");

    const needsGrantStatus = await relayJson(`${urls.apiUrl}/v1/project-grants/status`, token.access_token, {
      deviceId: "device_123",
      projectPath: "/tmp/other-project",
      requestedScopes: ["remoteRelay.access"]
    }) as { projectAccess: string };
    assert.equal(needsGrantStatus.projectAccess, "needs_grant");

    const inactiveGrantStatus = await relayJson(`${urls.apiUrl}/v1/project-grants/status`, token.access_token, {
      deviceId: "device_123",
      projectPath: "/tmp/inactive-project",
      requestedScopes: ["remoteRelay.access"]
    }) as { projectAccess: string };
    assert.equal(inactiveGrantStatus.projectAccess, "needs_grant");

    const deniedGrantStatus = await relayJson(`${urls.apiUrl}/v1/project-grants/status`, token.access_token, {
      deviceId: "device_123",
      projectPath: "/tmp/hunsu-project",
      requestedScopes: ["artifactAction.run", "env.read", "hostAlias.expose", "remoteRelay.access"]
    }) as { projectAccess: string; missingScopes?: string[] };
    assert.equal(deniedGrantStatus.projectAccess, "denied");
    assert.deepEqual(deniedGrantStatus.missingScopes, ["artifactAction.run", "env.read", "hostAlias.expose"]);

    const offline = await relayJson(`${urls.apiUrl}/v1/commands`, token.access_token, {
      deviceId: "device_123",
      command: "execute.start",
      projectPath: "/tmp/hunsu-project",
      payload: { roadmapId: "roadmap_123" }
    }, 409) as { ok: false; reason: string };
    assert.equal(offline.reason, "device_offline");

    const socket = new WebSocket(`${urls.wsUrl}?access_token=${encodeURIComponent(token.access_token)}`);
    await onceWebSocketOpen(socket);
    socket.send(JSON.stringify({
      type: "device.register",
      device: {
        deviceId: "device_123",
        deviceName: "relay-devbox",
        userId: token.user_id,
        registeredAt: new Date().toISOString(),
        status: "online",
        bridgeVersion: "0.1.2",
        protocolVersion: "local-bridge-v1"
      },
      projectGrants: [{
        path: "/tmp/hunsu-project",
        grantedAt: new Date().toISOString(),
        scopes: ["execute.start", "remoteRelay.access"]
      }, {
        path: "/tmp/inactive-project",
        grantedAt: new Date().toISOString(),
        scopes: ["execute.start", "remoteRelay.access"],
        active: false
      }]
    }));

    socket.addEventListener("message", event => {
      const envelope = JSON.parse(String(event.data)) as { commandId: string; command: { command: string } };
      socket.send(JSON.stringify({
        type: "command.result",
        commandId: envelope.commandId,
        result: { ok: true, status: 202, body: { routed: envelope.command.command } }
      }));
    });

    await delay(30);
    const devices = await relayJson(`${urls.apiUrl}/v1/devices`, token.access_token) as { devices: Array<{ deviceId: string; status: string }> };
    assert.equal(devices.devices[0]?.deviceId, "device_123");
    assert.equal(devices.devices[0]?.status, "online");

    const denied = await relayJson(`${urls.apiUrl}/v1/commands`, token.access_token, {
      deviceId: "device_123",
      command: "artifactAction.start",
      projectPath: "/tmp/hunsu-project",
      payload: { roadmapId: "roadmap_123", actionId: "host-web" }
    }, 403) as { ok: false; reason: string };
    assert.equal(denied.reason, "command_scope_denied");

    const inactiveCommand = await relayJson(`${urls.apiUrl}/v1/commands`, token.access_token, {
      deviceId: "device_123",
      command: "execute.start",
      projectPath: "/tmp/inactive-project",
      payload: { roadmapId: "roadmap_inactive" }
    }, 403) as { ok: false; reason: string };
    assert.equal(inactiveCommand.reason, "project_grant_denied");

    const routed = await relayJson(`${urls.apiUrl}/v1/commands`, token.access_token, {
      deviceId: "device_123",
      command: "execute.start",
      projectPath: "/tmp/hunsu-project",
      payload: { roadmapId: "roadmap_123" }
    }, 202) as { ok: true; body: { routed: string } };
    assert.equal(routed.body.routed, "execute.start");

    const board = await relayJson(`${urls.apiUrl}/v1/commands`, token.access_token, {
      deviceId: "device_123",
      command: "roadmap.board",
      projectPath: "/tmp/hunsu-project",
      payload: { roadmapId: "roadmap_123" }
    }, 202) as { ok: true; body: { routed: string } };
    assert.equal(board.body.routed, "roadmap.board");

    const providerInventory = await relayJson(`${urls.apiUrl}/v1/commands`, token.access_token, {
      deviceId: "device_123",
      command: "provider.inventory",
      payload: { backendId: "remote-device" }
    }, 202) as { ok: true; body: { routed: string } };
    assert.equal(providerInventory.body.routed, "provider.inventory");

    socket.send(JSON.stringify({
      type: "device.register",
      device: {
        deviceId: "device_123",
        deviceName: "relay-devbox",
        userId: token.user_id,
        registeredAt: new Date().toISOString(),
        status: "online",
        bridgeVersion: "0.1.2",
        protocolVersion: "local-bridge-v1"
      },
      projectGrants: [{
        path: "/tmp/hunsu-project",
        grantedAt: new Date().toISOString(),
        scopes: ["execute.start", "artifactAction.run", "env.read", "hostAlias.expose", "remoteRelay.access"]
      }]
    }));
    await delay(30);

    const routedArtifact = await relayJson(`${urls.apiUrl}/v1/commands`, token.access_token, {
      deviceId: "device_123",
      command: "artifactAction.start",
      projectPath: "/tmp/hunsu-project",
      requestedScopes: ["remoteRelay.access"],
      payload: { roadmapId: "roadmap_123", actionId: "host-web" }
    }, 202) as { ok: true; body: { routed: string } };
    assert.equal(routedArtifact.body.routed, "artifactAction.start");

    socket.send(JSON.stringify({
      type: "device.register",
      device: {
        deviceId: "device_123",
        deviceName: "relay-devbox",
        userId: token.user_id,
        registeredAt: new Date().toISOString(),
        status: "online",
        bridgeVersion: "0.1.2",
        protocolVersion: "local-bridge-v1"
      },
      projectGrants: []
    }));
    await delay(30);

    const revokedStatus = await relayJson(`${urls.apiUrl}/v1/project-grants/status`, token.access_token, {
      deviceId: "device_123",
      projectPath: "/tmp/hunsu-project",
      requestedScopes: ["remoteRelay.access"]
    }) as { projectAccess: string };
    assert.equal(revokedStatus.projectAccess, "needs_grant");

    const aliasValidation = await relayJson(`${urls.apiUrl}/v1/commands`, token.access_token, {
      deviceId: "device_123",
      command: "modelAlias.validate",
      payload: { modelSelection: { kind: "alias", aliasId: "PrimaryModel" }, aliases: [] }
    }, 202) as { ok: true; body: { routed: string } };
    assert.equal(aliasValidation.body.routed, "modelAlias.validate");

    const revokedCommand = await relayJson(`${urls.apiUrl}/v1/commands`, token.access_token, {
      deviceId: "device_123",
      command: "execute.start",
      projectPath: "/tmp/hunsu-project",
      payload: { roadmapId: "roadmap_123" }
    }, 403) as { ok: false; reason: string };
    assert.equal(revokedCommand.reason, "project_grant_denied");

    socket.close();
  } finally {
    await relay.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Relay service streams typed command events over the device WebSocket", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunsu-relay-stream-test-"));
  const relay = createHunsuRelayServer({
    config: relayTestConfig(join(root, "relay-state.json")),
    commandTimeoutMs: 1000
  });
  const urls = await relay.listen();
  try {
    const token = await relayPasswordlessToken(urls.apiUrl);
    const socket = new WebSocket(`${urls.wsUrl}?access_token=${encodeURIComponent(token.access_token)}`);
    await onceWebSocketOpen(socket);
    socket.send(JSON.stringify({
      type: "device.register",
      device: {
        deviceId: "device_stream",
        deviceName: "relay-stream-devbox",
        userId: token.user_id,
        registeredAt: new Date().toISOString(),
        status: "online",
        bridgeVersion: "0.1.2",
        protocolVersion: "local-bridge-v1"
      },
      projectGrants: [{
        path: "/tmp/hunsu-stream-project",
        grantedAt: new Date().toISOString(),
        scopes: ["remoteRelay.access"]
      }]
    }));

    socket.addEventListener("message", event => {
      const envelope = JSON.parse(String(event.data)) as { commandId: string; command: { command: string } };
      assert.equal(envelope.command.command, "live.events");
      socket.send(JSON.stringify({
        type: "command.stream.event",
        commandId: envelope.commandId,
        event: "runs.snapshot",
        data: "{\"type\":\"runs.snapshot\",\"runs\":[]}"
      }));
      socket.send(JSON.stringify({
        type: "command.stream.event",
        commandId: envelope.commandId,
        event: "run.updated",
        data: "{\"type\":\"run.updated\",\"run\":{\"runId\":\"run_stream\"}}"
      }));
      socket.send(JSON.stringify({
        type: "command.result",
        commandId: envelope.commandId,
        result: { ok: true, status: 200 }
      }));
    });

    await delay(30);
    const response = await fetch(`${urls.apiUrl}/v1/commands/events`, {
      method: "POST",
      headers: {
        "authorization": `Bearer ${token.access_token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        deviceId: "device_stream",
        command: "live.events",
        projectPath: "/tmp/hunsu-stream-project",
        payload: { roadmapId: "roadmap_stream" }
      })
    });
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.match(text, /event: runs\.snapshot/);
    assert.match(text, /event: run\.updated/);
    assert.match(text, /run_stream/);

    const eventUrl = new URL("/v1/commands/events", urls.apiUrl);
    eventUrl.searchParams.set("access_token", token.access_token);
    eventUrl.searchParams.set("command", JSON.stringify({
      deviceId: "device_stream",
      command: "live.events",
      projectPath: "/tmp/hunsu-stream-project",
      payload: { roadmapId: "roadmap_stream" }
    }));
    const browserResponse = await fetch(eventUrl);
    assert.equal(browserResponse.status, 200);
    const browserText = await browserResponse.text();
    assert.match(browserText, /event: runs\.snapshot/);
    assert.match(browserText, /event: run\.updated/);
    assert.match(browserText, /run_stream/);
    socket.close();
  } finally {
    await relay.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Relay service enforces PKCE for authorization-code token exchange", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunsu-relay-pkce-test-"));
  const relay = createHunsuRelayServer({
    config: relayTestConfig(join(root, "relay-state.json")),
    commandTimeoutMs: 1000
  });
  const urls = await relay.listen();
  try {
    const codeVerifier = randomBytes(32).toString("base64url");
    const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
    const redirectUri = "http://127.0.0.1:43123/oauth/callback";
    const authorizeUrl = new URL("/oauth/authorize", urls.apiUrl);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", "hunsu-bridge-cli");
    authorizeUrl.searchParams.set("redirect_uri", redirectUri);
    authorizeUrl.searchParams.set("code_challenge", codeChallenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
    authorizeUrl.searchParams.set("state", "pkce-state");
    const authorize = await fetch(authorizeUrl, { redirect: "manual" });
    assert.equal(authorize.status, 302);
    const location = authorize.headers.get("location");
    assert.ok(location);
    const code = new URL(location).searchParams.get("code");
    assert.ok(code);

    const wrongVerifier = await postFormRaw(`${urls.apiUrl}/oauth/token`, {
      grant_type: "authorization_code",
      client_id: "hunsu-bridge-cli",
      code,
      code_verifier: "wrong-verifier",
      redirect_uri: redirectUri
    });
    assert.equal(wrongVerifier.status, 400);
    assert.equal((await wrongVerifier.json() as { error: string }).error, "invalid_grant");

    const token = await postForm(`${urls.apiUrl}/oauth/token`, {
      grant_type: "authorization_code",
      client_id: "hunsu-bridge-cli",
      code,
      code_verifier: codeVerifier,
      redirect_uri: redirectUri
    }) as { access_token: string; user_id: string };
    assert.match(token.access_token, /^relay_access_/);
    assert.equal(token.user_id, "local-relay-user");
  } finally {
    await relay.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function relayTestConfig(storagePath: string): RelayServerConfig {
  return {
    relay: {
      name: "relay",
      host: "127.0.0.1",
      hostSource: "override",
      port: 0,
      portSource: "override",
      reserved: false
    },
    publicApiUrl: "http://127.0.0.1:0",
    publicWsUrl: "ws://127.0.0.1:0/v1/device/connect",
    issuer: "http://127.0.0.1:0",
    storagePath,
    processEnv: {}
  };
}

async function relayPasswordlessToken(apiUrl: string): Promise<{ access_token: string; user_id: string }> {
  const deviceCodeResponse = await postForm(`${apiUrl}/oauth/device/code`, {
    client_id: "hunsu-bridge-headless",
    device_id: "device_stream",
    device_name: "relay-stream-devbox",
    scope: "bridge device relay"
  }) as {
    device_code: string;
    verification_uri_complete: string;
  };
  await fetch(deviceCodeResponse.verification_uri_complete);
  return await postForm(`${apiUrl}/oauth/token`, {
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    client_id: "hunsu-bridge-headless",
    device_code: deviceCodeResponse.device_code
  }) as { access_token: string; user_id: string };
}

async function postForm(url: string, fields: Record<string, string>): Promise<unknown> {
  const response = await postFormRaw(url, fields);
  if (!response.ok) {
    assert.fail(await response.text());
  }
  return response.json() as Promise<unknown>;
}

async function postFormRaw(url: string, fields: Record<string, string>): Promise<Response> {
  return await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields)
  });
}

async function relayJson(url: string, accessToken: string, body?: unknown, expectedStatus = 200): Promise<unknown> {
  const response = await fetch(url, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "authorization": `Bearer ${accessToken}`,
      ...(body === undefined ? {} : { "content-type": "application/json" })
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  if (response.status !== expectedStatus) {
    assert.fail(await response.text());
  }
  return response.json() as Promise<unknown>;
}

function onceWebSocketOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("WebSocket failed to open")), { once: true });
  });
}
