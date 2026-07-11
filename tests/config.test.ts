import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  endpointUrl,
  resolveCodexAppServerConfig,
  resolveRelayClientConfig,
  resolveRelayServerConfig,
  resolveHunsuPorts,
  resolveBridgeApiServerConfig,
  resolveBridgeRuntimeConfig,
  resolveStudioLauncherConfig,
  resolveStudioWebServerConfig,
  resolveValidatedHunsuPorts,
  unwrapConfigResult,
  validateNoPortConflicts
} from "../packages/config/src/index.ts";
import {
  renderHubWranglerToml,
  resolveHubApiWorkerRuntimeConfig,
  resolveHubCloudflareConfig,
  type ConfigResult
} from "../packages/config/src/cloudflare.ts";

const ROOT = new URL("..", import.meta.url).pathname;

test("Hunsu config resolves canonical Bridge ports", () => {
  const ports = unwrapConfigResult(resolveHunsuPorts({}));

  assert.equal(ports.bridgeApi.port, 19687);
  assert.equal(ports.studioWeb.port, 19688);
  assert.equal(ports.agentPreview.port, 19673);
  assert.equal(ports.relay.port, 19690);
  assert.equal(ports.agentPreview.reserved, true);
});

test("Studio web config keeps Hunsu services in the dedicated port block", () => {
  const config = unwrapConfigResult(resolveStudioWebServerConfig({}));

  assert.equal(config.web.port, 19688);
  assert.equal(config.bridgeApi.port, 19687);
  assert.equal(config.strictPort, true);
  assert.equal(config.apiProxyTarget, "http://127.0.0.1:19687");
  assert.equal(config.browserHubApiUrl, "http://127.0.0.1:8787");
});

test("Studio web config honors env overrides through one resolver", () => {
  const config = unwrapConfigResult(resolveStudioWebServerConfig({
    HUNSU_WEB_HOST: "0.0.0.0",
    HUNSU_WEB_PORT: "29688",
    HUNSU_WEB_STRICT_PORT: "false",
    HUNSU_BRIDGE_PORT: "29687",
    HUNSU_BRIDGE_API_PROXY_TARGET: "http://127.0.0.1:29699"
  }));

  assert.equal(config.web.host, "0.0.0.0");
  assert.equal(config.web.port, 29688);
  assert.equal(config.strictPort, false);
  assert.equal(config.apiProxyTarget, "http://127.0.0.1:29699");
});

test("Studio web config validates browser URL and exposes it for Vite define", () => {
  const config = unwrapConfigResult(resolveStudioWebServerConfig({
    VITE_HUNSU_BRIDGE_URL: "http://127.0.0.1:19687/",
    VITE_HUNSU_HUB_API_URL: "https://hub.example.test/",
    VITE_HUNSU_RELAY_API_URL: "https://relay.example.test/"
  }));

  assert.equal(config.browserBridgeUrl, "http://127.0.0.1:19687");
  assert.equal(config.browserHubApiUrl, "https://hub.example.test");
  assert.equal(config.browserRelayApiUrl, "https://relay.example.test");
  assert.equal(config.apiProxyTarget, "http://127.0.0.1:19687");

  const publicHub = unwrapConfigResult(resolveStudioWebServerConfig({
    HUNSU_HUB_PUBLIC_API_URL: "https://hub-public.example.test/"
  }));
  assert.equal(publicHub.browserHubApiUrl, "https://hub-public.example.test");

  const hostedWithoutHub = unwrapConfigResult(resolveStudioWebServerConfig({
    HUNSU_DEPLOY_TARGET: "production"
  }));
  assert.equal(hostedWithoutHub.browserHubApiUrl, undefined);

  const invalid = resolveStudioWebServerConfig({ VITE_HUNSU_BRIDGE_URL: "not a url" });
  assert.equal(invalid.ok, false);
  if (!invalid.ok) {
    assert.equal(invalid.error.code, "invalid_url");
  }

  const invalidRelay = resolveStudioWebServerConfig({ VITE_HUNSU_RELAY_API_URL: "not a url" });
  assert.equal(invalidRelay.ok, false);
  if (!invalidRelay.ok) {
    assert.equal(invalidRelay.error.code, "invalid_url");
  }
});

test("Studio launcher config resolves the npx Studio URL", () => {
  const fallback = unwrapConfigResult(resolveStudioLauncherConfig({}));
  assert.equal(fallback.webUrl, "https://hunsu.app/studio");

  const hosted = unwrapConfigResult(resolveStudioLauncherConfig({
    HUNSU_WEB_URL: "https://studio.example.test/studio/"
  }));
  assert.equal(hosted.webUrl, "https://studio.example.test/studio");

  const invalid = resolveStudioLauncherConfig({ HUNSU_WEB_URL: "not a url" });
  assert.equal(invalid.ok, false);
  if (!invalid.ok) {
    assert.equal(invalid.error.code, "invalid_url");
  }
});

test("Hunsu config rejects active port conflicts", () => {
  const result = resolveValidatedHunsuPorts({
    HUNSU_WEB_PORT: "19687"
  }, {
    activePortNames: ["bridgeApi", "studioWeb"]
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "port_conflict");
    assert.match(result.error.message, /bridgeApi and studioWeb/);
  }
});

test("Hunsu config rejects invalid env values", () => {
  const portResult = resolveBridgeApiServerConfig({ HUNSU_BRIDGE_PORT: "abc" });
  const booleanResult = resolveStudioWebServerConfig({ HUNSU_WEB_STRICT_PORT: "maybe" });
  const enumResult = resolveBridgeRuntimeConfig({ HUNSU_CODEX_SANDBOX_MODE: "root" });
  const jsonResult = resolveCodexAppServerConfig({ HUNSU_CODEX_APP_SERVER_ARGS: "[1]" });
  const missingResult = resolveCodexAppServerConfig({}, { command: "" });

  assert.equal(portResult.ok, false);
  assert.equal(booleanResult.ok, false);
  assert.equal(enumResult.ok, false);
  assert.equal(jsonResult.ok, false);
  assert.equal(missingResult.ok, false);
  if (!portResult.ok) {
    assert.equal(portResult.error.code, "invalid_port");
  }
  if (!booleanResult.ok) {
    assert.equal(booleanResult.error.code, "invalid_boolean");
  }
  if (!enumResult.ok) {
    assert.equal(enumResult.error.code, "invalid_enum");
  }
  if (!jsonResult.ok) {
    assert.equal(jsonResult.error.code, "invalid_json");
  }
  if (!missingResult.ok) {
    assert.equal(missingResult.error.code, "missing_required_env");
  }
});

test("endpointUrl formats Bridge service endpoints", () => {
  assert.equal(endpointUrl({ host: "127.0.0.1", port: 19688 }), "http://127.0.0.1:19688");
});

test("Reserved agent preview port participates only when requested", () => {
  const ports = unwrapConfigResult(resolveHunsuPorts({ HUNSU_WEB_PORT: "19673" }));

  assert.equal(validateNoPortConflicts(ports, ["studioWeb"]).ok, true);
  assert.equal(validateNoPortConflicts(ports, ["studioWeb", "agentPreview"]).ok, false);
});

test("Bridge runtime config resolves paths and Codex app-server settings at the app boundary", () => {
  const config = unwrapConfigResult(resolveBridgeRuntimeConfig({
    HUNSU_ROADMAP_REGISTRY_PATH: "roadmaps.json",
    HUNSU_ROUTE_WORKTREE_ROOT: "routes",
    HUNSU_ACTION_WORKTREE_ROOT: "actions",
    HUNSU_CODEX_APP_SERVER_COMMAND: "codex-dev",
    HUNSU_CODEX_APP_SERVER_ARGS: "[\"app-server\",\"--stdio\",\"--debug\"]",
    HUNSU_CODEX_SANDBOX_MODE: "workspace-write",
    HUNSU_CODEX_APPROVAL_POLICY: "on-request",
    HUNSU_CODEX_APPROVALS_REVIEWER: "auto_review",
    HUNSU_CODEX_NETWORK_ACCESS: "on",
    HUNSU_CODEX_ADDITIONAL_DIRECTORIES: "/opt/a, /opt/b"
  }, {
    cwd: "/tmp/hunsu-bridge",
    homeDir: "/tmp/hunsu-home"
  }));

  assert.equal(config.roadmapRegistryPath, "/tmp/hunsu-bridge/roadmaps.json");
  assert.equal(config.routeWorktreeRoot, "/tmp/hunsu-bridge/routes");
  assert.equal(config.actionWorktreeRoot, "/tmp/hunsu-bridge/actions");
  assert.equal(config.codexAppServer.command, "codex-dev");
  assert.deepEqual(config.codexAppServer.args, ["app-server", "--stdio", "--debug"]);
  assert.equal(config.codexThreadOptions.sandboxMode, "workspace-write");
  assert.equal(config.codexThreadOptions.approvalPolicy, "on-request");
  assert.equal(config.codexThreadOptions.approvalsReviewer, "auto_review");
  assert.equal(config.codexThreadOptions.networkAccessEnabled, true);
  assert.deepEqual(config.codexThreadOptions.additionalDirectories, ["/opt/a", "/opt/b"]);

  const whitespaceArgs = unwrapConfigResult(resolveCodexAppServerConfig({
    HUNSU_CODEX_APP_SERVER_ARGS: "app-server --stdio --debug"
  }));
  assert.deepEqual(whitespaceArgs.args, ["app-server", "--stdio", "--debug"]);
});

test("Bridge runtime config keeps process env separate from Codex app-server env overrides", () => {
  const config = unwrapConfigResult(resolveBridgeRuntimeConfig({
    SHARED: "ambient",
    CODEX_HOME: "/ambient/codex"
  }, {
    codexAppServer: {
      environment: { CODEX_HOME: "/codex/only" }
    }
  }));

  assert.equal(config.processEnv.SHARED, "ambient");
  assert.equal(config.processEnv.CODEX_HOME, "/ambient/codex");
  assert.equal(config.codexAppServer.environment.CODEX_HOME, "/codex/only");
});

test("Relay config resolves hosted auth and WebSocket endpoints explicitly", () => {
  const server = unwrapConfigResult(resolveRelayServerConfig({
    HUNSU_RELAY_PORT: "0",
    HUNSU_RELAY_PUBLIC_API_URL: "https://relay.example.test/",
    HUNSU_RELAY_PUBLIC_WS_URL: "wss://relay.example.test/v1/device/connect/",
    HUNSU_BRIDGE_AUTH_BASE_URL: "https://auth.example.test/",
    HUNSU_RELAY_STORAGE_PATH: "relay-state.json"
  }, {
    homeDir: "/tmp/hunsu-home"
  }));

  assert.equal(server.relay.port, 0);
  assert.equal(server.publicApiUrl, "https://relay.example.test");
  assert.equal(server.publicWsUrl, "wss://relay.example.test/v1/device/connect");
  assert.equal(server.issuer, "https://auth.example.test");
  assert.equal(server.storagePath, join(ROOT, "relay-state.json"));

  const client = unwrapConfigResult(resolveRelayClientConfig({
    HUNSU_BRIDGE_AUTH_BASE_URL: "https://auth.example.test/",
    HUNSU_RELAY_PUBLIC_API_URL: "https://relay.example.test/",
    HUNSU_RELAY_PUBLIC_WS_URL: "wss://relay.example.test/v1/device/connect/"
  }));
  assert.equal(client.authBaseUrl, "https://auth.example.test");
  assert.equal(client.relayApiUrl, "https://relay.example.test");
  assert.equal(client.relayWsUrl, "wss://relay.example.test/v1/device/connect");

  const invalidWs = resolveRelayClientConfig({ HUNSU_RELAY_PUBLIC_WS_URL: "https://relay.example.test/ws" });
  assert.equal(invalidWs.ok, false);
  if (!invalidWs.ok) assert.equal(invalidWs.error.code, "invalid_url");
});

test("Hub Cloudflare config resolves local defaults and deterministic dev config", () => {
  const local = unwrapCloudflareConfig(resolveHubCloudflareConfig({ HUNSU_DEPLOY_TARGET: "local" }));
  assert.equal(local.workerName, "hunsu-hub-api-local");
  assert.equal(local.originName, "hunsu-local");
  assert.equal(local.publicHubApiUrl, "http://127.0.0.1:8787");
  assert.equal(local.d1DatabaseName, "hunsu_hub_local");

  const dev = unwrapCloudflareConfig(resolveHubCloudflareConfig({
    HUNSU_DEPLOY_TARGET: "dev",
    HUNSU_HUB_WORKER_NAME: "hunsu-hub-api-dev",
    HUNSU_HUB_ORIGIN_NAME: "motorhome-dev",
    HUNSU_HUB_PUBLIC_API_URL: "https://hub-dev.example.test/",
    HUNSU_HUB_D1_DATABASE_NAME: "hunsu_hub_dev",
    HUNSU_HUB_D1_DATABASE_ID: "dev-db-id",
    HUNSU_HUB_R2_BUCKET_NAME: "hunsu-hub-packages-dev",
    HUNSU_HUB_PUBLISH_QUEUE_NAME: "hunsu-hub-publish-dev"
  }));

  assert.equal(dev.target, "dev");
  assert.equal(dev.publicHubApiUrl, "https://hub-dev.example.test");
  assert.deepEqual(dev.compatibilityFlags, ["nodejs_compat"]);
  assert.equal(dev.publishQueueName, "hunsu-hub-publish-dev");
});

test("Hub Cloudflare config rejects missing or invalid deployment environment", () => {
  const missingId = resolveHubCloudflareConfig({
    HUNSU_DEPLOY_TARGET: "production",
    HUNSU_HUB_WORKER_NAME: "hunsu-hub-api",
    HUNSU_HUB_ORIGIN_NAME: "motorhome",
    HUNSU_HUB_PUBLIC_API_URL: "https://hub.example.test",
    HUNSU_HUB_D1_DATABASE_NAME: "hunsu_hub",
    HUNSU_HUB_R2_BUCKET_NAME: "hunsu-hub-packages"
  });
  const invalidTarget = resolveHubCloudflareConfig({ HUNSU_DEPLOY_TARGET: "staging" });
  const invalidUrl = resolveHubCloudflareConfig({
    HUNSU_DEPLOY_TARGET: "dev",
    HUNSU_HUB_WORKER_NAME: "hunsu-hub-api-dev",
    HUNSU_HUB_ORIGIN_NAME: "motorhome-dev",
    HUNSU_HUB_PUBLIC_API_URL: "ftp://hub-dev.example.test",
    HUNSU_HUB_D1_DATABASE_NAME: "hunsu_hub_dev",
    HUNSU_HUB_D1_DATABASE_ID: "dev-db-id",
    HUNSU_HUB_R2_BUCKET_NAME: "hunsu-hub-packages-dev"
  });

  assert.equal(missingId.ok, false);
  assert.equal(invalidTarget.ok, false);
  assert.equal(invalidUrl.ok, false);
  if (!missingId.ok) assert.equal(missingId.error.code, "missing_required_env");
  if (!invalidTarget.ok) assert.equal(invalidTarget.error.code, "invalid_enum");
  if (!invalidUrl.ok) assert.equal(invalidUrl.error.code, "invalid_url");
});

test("Hub generated Wrangler TOML omits secrets and placeholders", () => {
  const config = unwrapCloudflareConfig(resolveHubCloudflareConfig({
    HUNSU_DEPLOY_TARGET: "production",
    HUNSU_HUB_WORKER_NAME: "hunsu-hub-api",
    HUNSU_HUB_ORIGIN_NAME: "motorhome",
    HUNSU_HUB_PUBLIC_API_URL: "https://hub.example.test",
    HUNSU_HUB_D1_DATABASE_NAME: "hunsu_hub",
    HUNSU_HUB_D1_DATABASE_ID: "prod-db-id",
    HUNSU_HUB_R2_BUCKET_NAME: "hunsu-hub-packages",
    HUNSU_HUB_ADMIN_TOKEN: "must-not-render"
  }));
  const toml = renderHubWranglerToml(config);

  assert.match(toml, /name = "hunsu-hub-api"/);
  assert.match(toml, /database_id = "prod-db-id"/);
  assert.doesNotMatch(toml, /replace-with|placeholder|HUNSU_HUB_ADMIN_TOKEN|must-not-render/);
});

test("Hub API Worker runtime config fails closed without an origin", () => {
  const missing = resolveHubApiWorkerRuntimeConfig({});
  const valid = unwrapCloudflareConfig(resolveHubApiWorkerRuntimeConfig({
    HUNSU_HUB_ORIGIN_NAME: "motorhome",
    HUNSU_HUB_PUBLIC_API_URL: "https://hub.example.test",
    HUNSU_HUB_ADMIN_TOKEN: "token"
  }));

  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.error.code, "missing_required_env");
  assert.equal(valid.originName, "motorhome");
  assert.equal(valid.publicHubApiUrl, "https://hub.example.test");
  assert.equal(valid.adminToken, "token");
});

test("Hub API scripts use generated Wrangler config instead of a tracked Wrangler file", () => {
  const hubPackage = JSON.parse(readFileSync(join(ROOT, "apps/hub-api/package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };

  assert.equal(existsSync(join(ROOT, "apps/hub-api/wrangler.toml")), false);
  for (const scriptName of ["config:print", "config:write", "dev", "deploy", "db:migrate:local", "db:migrate:remote"]) {
    assert.match(hubPackage.scripts[scriptName], /scripts\/cloudflare-config\.mjs/);
    assert.doesNotMatch(hubPackage.scripts[scriptName], /wrangler\.toml/);
  }
  assert.match(hubPackage.scripts["seed:local"], /scripts\/seed-local\.mjs/);
  assert.doesNotMatch(hubPackage.scripts["seed:local"], /wrangler\.toml/);
});

function unwrapCloudflareConfig<T>(result: ConfigResult<T>): T {
  if (result.ok) {
    return result.value;
  }
  throw new Error(result.error.message);
}
