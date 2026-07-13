import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { RUNTIME_INSTALL_SCHEMA } from "../apps/bridge/src/setup/runtimeInstaller.ts";

const serviceSmoke = readFileSync(new URL("../scripts/bridge-service-smoke.mjs", import.meta.url), "utf8");

test("cross-platform service smoke verifies the current trusted runtime-install schema", () => {
  assert.match(serviceSmoke, new RegExp(`const RUNTIME_INSTALL_SCHEMA = ${JSON.stringify(RUNTIME_INSTALL_SCHEMA)}`, "u"));
  assert.match(serviceSmoke, /install\.current\?\.cliSha256/u);
  assert.match(serviceSmoke, /install\.installationId/u);
  assert.doesNotMatch(serviceSmoke, /runtime-install\.v1/u);
});
