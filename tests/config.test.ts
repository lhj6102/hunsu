import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveApiServerConfig,
  resolveGitHubAppConfig,
  resolveSessionConfig,
  resolveWebServerConfig
} from "../packages/config/src/index.ts";

test("service endpoints resolve through one validated environment pipeline", () => {
  assert.deepEqual(resolveApiServerConfig({}), {
    ok: true,
    value: { api: { name: "api", host: "127.0.0.1", port: 19687 } }
  });
  const web = resolveWebServerConfig({
    HUNSU_API_HOST: "0.0.0.0",
    HUNSU_API_PORT: "4100",
    HUNSU_WEB_HOST: "127.0.0.1",
    HUNSU_WEB_PORT: "4200",
    HUNSU_API_PROXY_TARGET: "https://api.example.test"
  });
  assert.equal(web.ok, true);
  if (web.ok) {
    assert.equal(web.value.api.port, 4100);
    assert.equal(web.value.web.port, 4200);
    assert.equal(web.value.apiProxyTarget, "https://api.example.test");
  }
  const conflict = resolveWebServerConfig({ HUNSU_API_PORT: "4100", HUNSU_WEB_PORT: "4100" });
  assert.equal(conflict.ok, false);
  if (!conflict.ok) assert.equal(conflict.error.code, "port_conflict");
});

test("GitHub App and session configuration fail closed", () => {
  const missing = resolveGitHubAppConfig({});
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.error.code, "missing_required_env");

  const environment = {
    HUNSU_GITHUB_APP_ID: "123",
    HUNSU_GITHUB_CLIENT_ID: "client-id",
    HUNSU_GITHUB_CLIENT_SECRET: "client-value",
    HUNSU_GITHUB_PRIVATE_KEY: "-----BEGIN " + "PRIVATE KEY-----\nfixture-value\n-----END " + "PRIVATE KEY-----",
    HUNSU_GITHUB_WEBHOOK_SECRET: "webhook-value",
    HUNSU_GITHUB_APP_SLUG: "hunsu-test",
    HUNSU_SESSION_SECRET: "s".repeat(32),
    HUNSU_PUBLIC_API_URL: "https://api.example.test",
    HUNSU_WEB_URL: "https://app.example.test"
  };
  const app = resolveGitHubAppConfig(environment);
  assert.equal(app.ok, true);
  const session = resolveSessionConfig(environment);
  assert.equal(session.ok, true);
  if (session.ok) {
    assert.equal(session.value.cookieName, "hunsu_session");
    assert.equal(session.value.secure, true);
  }

  const weak = resolveSessionConfig({ ...environment, HUNSU_SESSION_SECRET: "too-short" });
  assert.equal(weak.ok, false);
  if (!weak.ok) assert.equal(weak.error.code, "invalid_secret");
});
