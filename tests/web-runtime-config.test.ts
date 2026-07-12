import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  bridgeDeploymentProfileForTarget,
  bridgeProfileCompatibilityError,
  bridgeSetupCommands,
  HUNSU_WEB_RUNTIME_CONFIG_SCHEMA,
  parseHunsuWebRuntimeConfig,
  resolveHunsuWebRuntimeConfig,
  type HunsuWebRuntimeConfig
} from "../apps/web/src/shared/config/runtimeConfig.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const SOURCE_SHA = "0123456789abcdef0123456789abcdef01234567";

test("Web runtime config validates and normalizes a hosted preview identity", () => {
  const result = parseHunsuWebRuntimeConfig({
    schema: HUNSU_WEB_RUNTIME_CONFIG_SCHEMA,
    target: "preview",
    sourceSha: SOURCE_SHA.toUpperCase(),
    bridgePackageVersion: "0.2.0-next.3",
    bridgeApiBaseUrl: "https://preview.hunsu.app/",
    hubApiBaseUrl: "https://api.preview.hunsu.app/",
    connectApiBaseUrl: "https://connect.preview.hunsu.app/"
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.value, {
    schema: HUNSU_WEB_RUNTIME_CONFIG_SCHEMA,
    target: "preview",
    sourceSha: SOURCE_SHA,
    bridgePackageVersion: "0.2.0-next.3",
    bridgeApiBaseUrl: "https://preview.hunsu.app",
    hubApiBaseUrl: "https://api.preview.hunsu.app",
    connectApiBaseUrl: "https://connect.preview.hunsu.app"
  });
});

test("Web runtime config fails closed for mutable package selectors and unsafe URLs", () => {
  const base = {
    schema: HUNSU_WEB_RUNTIME_CONFIG_SCHEMA,
    target: "production",
    sourceSha: SOURCE_SHA,
    bridgePackageVersion: "0.2.0",
    bridgeApiBaseUrl: "",
    hubApiBaseUrl: "https://api.hunsu.app",
    connectApiBaseUrl: "https://connect.hunsu.app"
  };

  const mutablePackage = parseHunsuWebRuntimeConfig({ ...base, bridgePackageVersion: "next" });
  assert.equal(mutablePackage.ok, false);
  if (!mutablePackage.ok) assert.equal(mutablePackage.error.field, "bridgePackageVersion");

  const missingHostedPackage = parseHunsuWebRuntimeConfig({ ...base, bridgePackageVersion: "" });
  assert.equal(missingHostedPackage.ok, false);
  if (!missingHostedPackage.ok) assert.equal(missingHostedPackage.error.field, "bridgePackageVersion");

  const credentialedUrl = parseHunsuWebRuntimeConfig({ ...base, hubApiBaseUrl: "https://token@example.test" });
  assert.equal(credentialedUrl.ok, false);
  if (!credentialedUrl.ok) assert.equal(credentialedUrl.error.field, "hubApiBaseUrl");

  assert.throws(
    () => resolveHunsuWebRuntimeConfig({ ...base, sourceSha: "main" }),
    /sourceSha/
  );
});

test("Web runtime config retains explicit compile-time fallbacks when no overlay exists", () => {
  const fallback: HunsuWebRuntimeConfig = {
    schema: HUNSU_WEB_RUNTIME_CONFIG_SCHEMA,
    target: "local",
    sourceSha: "development",
    bridgePackageVersion: "",
    bridgeApiBaseUrl: "http://127.0.0.1:19687",
    hubApiBaseUrl: "http://127.0.0.1:8787",
    connectApiBaseUrl: ""
  };

  assert.deepEqual(resolveHunsuWebRuntimeConfig(null, fallback), fallback);
});

test("Web loads the no-store runtime overlay before the module bundle", () => {
  const html = readFileSync(join(ROOT, "apps/web/index.html"), "utf8");
  const placeholder = readFileSync(join(ROOT, "apps/web/public/hunsu-runtime-config.js"), "utf8");
  const headers = readFileSync(join(ROOT, "apps/web/public/_headers"), "utf8");

  assert.ok(html.indexOf("/hunsu-runtime-config.js") < html.indexOf("/src/main.tsx"));
  assert.match(placeholder, /__HUNSU_WEB_RUNTIME_CONFIG__ = null/);
  assert.match(headers, /\/hunsu-runtime-config\.js[\s\S]*Cache-Control: no-store/);
});

test("Web generates profile-bound Bridge setup commands from the immutable hosted package", () => {
  const preview: HunsuWebRuntimeConfig = {
    schema: HUNSU_WEB_RUNTIME_CONFIG_SCHEMA,
    target: "preview",
    sourceSha: SOURCE_SHA,
    bridgePackageVersion: "0.2.0-next.3",
    bridgeApiBaseUrl: "",
    hubApiBaseUrl: "https://api.preview.hunsu.app",
    connectApiBaseUrl: "https://connect.preview.hunsu.app"
  };
  assert.equal(bridgeDeploymentProfileForTarget(preview.target), "preview");
  assert.equal(
    bridgeSetupCommands(preview),
    [
      "npx @hunsu/bridge@0.2.0-next.3 setup --profile preview",
      "hunsu-bridge status",
      "hunsu-bridge open"
    ].join("\n")
  );
  assert.equal(bridgeProfileCompatibilityError("preview", "preview"), undefined);
  assert.match(bridgeProfileCompatibilityError("preview", "production") ?? "", /requires.*preview profile/);
  assert.equal(bridgeProfileCompatibilityError("local", undefined), undefined);
});
