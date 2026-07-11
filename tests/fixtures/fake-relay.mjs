#!/usr/bin/env node
import { createServer } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);

export async function startFakeRelay(options = {}) {
  const host = options.host ?? "127.0.0.1";
  const requestedPort = options.port ?? 0;
  const authorizations = new Map();
  const devices = new Map();
  const commands = [];
  let authorizationOrdinal = 0;
  let commandOrdinal = 0;
  let connected = true;
  let baseUrl = "";

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", baseUrl || `http://${host}`);
    try {
      if (request.method === "GET" && url.pathname === "/health") {
        sendJson(response, 200, { ok: true, service: "hunsu-fake-relay" });
        return;
      }
      if (request.method === "POST" && url.pathname === "/oauth/device/code") {
        const body = new URLSearchParams(await readBody(request));
        const ordinal = ++authorizationOrdinal;
        const deviceCode = `fake-device-code-${ordinal}`;
        const userCode = `HUNSU-${String(ordinal).padStart(4, "0")}`;
        authorizations.set(deviceCode, {
          deviceCode,
          userCode,
          deviceId: body.get("device_id") || `fixture-device-${ordinal}`,
          approved: false
        });
        sendJson(response, 200, {
          device_code: deviceCode,
          user_code: userCode,
          verification_uri: `${baseUrl}/device`,
          verification_uri_complete: `${baseUrl}/device?user_code=${encodeURIComponent(userCode)}`,
          expires_in: 900,
          interval: 1
        });
        return;
      }
      if (request.method === "POST" && url.pathname === "/oauth/token") {
        const body = new URLSearchParams(await readBody(request));
        const authorization = authorizations.get(body.get("device_code"));
        if (!authorization) {
          sendJson(response, 400, { error: "expired_token" });
          return;
        }
        if (!authorization.approved) {
          sendJson(response, 400, { error: "authorization_pending" });
          return;
        }
        sendJson(response, 200, {
          access_token: `fake-account-access-${authorization.deviceCode}`,
          refresh_token: `fake-account-refresh-${authorization.deviceCode}`,
          token_type: "Bearer",
          expires_in: 3600,
          user_id: "fixture-user"
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/device") {
        response.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
        response.end("Fake Relay device approval fixture.\n");
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/devices") {
        if (!validAccountAuthorization(request.headers.authorization)) {
          sendJson(response, 401, { error: "unauthorized" });
          return;
        }
        const body = await readJson(request);
        const device = body.device && typeof body.device === "object" && !Array.isArray(body.device) ? body.device : body;
        const deviceId = requiredString(device.deviceId, "deviceId");
        devices.set(deviceId, {
          deviceId,
          deviceName: stringValue(device.deviceName) ?? "Fake Bridge",
          protocolVersion: stringValue(device.protocolVersion) ?? "local-bridge-v1",
          workspaces: Array.isArray(body.workspaces) ? body.workspaces : [],
          grants: Array.isArray(body.projectGrants) ? body.projectGrants : []
        });
        sendJson(response, 202, { device: { ...device, deviceId, status: "offline" } });
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/remote/status") {
        sendJson(response, 200, {
          connected,
          registeredDevices: [...devices.values()].map(device => ({
            deviceId: device.deviceId,
            deviceName: device.deviceName,
            protocolVersion: device.protocolVersion,
            workspaceCount: device.workspaces.length
          })),
          commandCount: commands.length
        });
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/commands") {
        if (!connected) {
          sendJson(response, 503, { ok: false, error: "relay_disconnected" });
          return;
        }
        const body = await readJson(request);
        const deviceId = requiredString(body.deviceId, "deviceId");
        if (!devices.has(deviceId)) {
          sendJson(response, 404, { ok: false, error: "device_not_registered" });
          return;
        }
        const requestId = `fake-command-${++commandOrdinal}`;
        const result = { echoed: body.command ?? null, deviceId };
        commands.push({ requestId, deviceId, command: body.command ?? null, result });
        sendJson(response, 200, { ok: true, requestId, result });
        return;
      }
      if (request.method === "POST" && url.pathname === "/__fixture/device/approve") {
        const body = await readJson(request, true);
        const target = stringValue(body.deviceCode);
        let approved = 0;
        for (const authorization of authorizations.values()) {
          if (!target || authorization.deviceCode === target) {
            authorization.approved = true;
            approved += 1;
          }
        }
        sendJson(response, approved > 0 ? 200 : 404, { ok: approved > 0, approved });
        return;
      }
      if (request.method === "POST" && url.pathname === "/__fixture/disconnect") {
        connected = false;
        sendJson(response, 200, { ok: true, connected });
        return;
      }
      if (request.method === "POST" && url.pathname === "/__fixture/reconnect") {
        connected = true;
        sendJson(response, 200, { ok: true, connected });
        return;
      }
      if (request.method === "GET" && url.pathname === "/__fixture/status") {
        sendJson(response, 200, {
          connected,
          authorizationCount: authorizations.size,
          approvedCount: [...authorizations.values()].filter(value => value.approved).length,
          deviceCount: devices.size,
          commandCount: commands.length
        });
        return;
      }
      sendJson(response, 404, { error: "not_found" });
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : "invalid_request" });
    }
  });

  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(requestedPort, host, resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fake Relay did not bind a TCP endpoint.");
  baseUrl = `http://${host}:${address.port}`;
  return {
    url: baseUrl,
    port: address.port,
    async close() {
      if (!server.listening) return;
      await new Promise((resolveClose, rejectClose) => {
        server.close(error => error ? rejectClose(error) : resolveClose());
      });
    }
  };
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1_048_576) throw new Error("request_too_large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readJson(request, allowEmpty = false) {
  const raw = await readBody(request);
  if (!raw.trim() && allowEmpty) return {};
  const value = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("json_object_required");
  return value;
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store"
  });
  response.end(body);
}

function validAccountAuthorization(value) {
  return typeof value === "string" && /^Bearer fake-account-access-fake-device-code-\d+$/u.test(value);
}

function stringValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function requiredString(value, field) {
  const result = stringValue(value);
  if (!result) throw new Error(`${field}_required`);
  return result;
}

function parseArguments(argv) {
  let host = "127.0.0.1";
  let port = 0;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--host") host = argv[++index] ?? "";
    else if (argument === "--port") port = Number(argv[++index]);
    else if (argument === "--json") json = true;
    else if (argument === "--help" || argument === "-h") return { help: true, host, port, json };
    else throw new Error(`Unknown fake Relay option: ${argument}`);
  }
  if (!host.trim()) throw new Error("Fake Relay host is required.");
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error("Fake Relay port is invalid.");
  return { help: false, host, port, json };
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (options.help) {
    process.stdout.write("Usage: fake-relay.mjs [--host 127.0.0.1] [--port 0] [--json]\n");
    return 0;
  }
  const relay = await startFakeRelay(options);
  process.stdout.write(options.json
    ? `${JSON.stringify({ ready: true, service: "hunsu-fake-relay", url: relay.url, port: relay.port })}\n`
    : `[fake-relay] ready at ${relay.url}\n`);
  await new Promise(resolveSignal => {
    process.once("SIGINT", resolveSignal);
    process.once("SIGTERM", resolveSignal);
  });
  await relay.close();
  return 0;
}

if (resolve(process.argv[1] ?? "") === scriptPath) {
  main().then(code => {
    process.exitCode = code;
  }).catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
