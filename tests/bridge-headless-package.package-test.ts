import assert from "node:assert/strict";
import test from "node:test";
import { runBridgePackSmoke } from "../apps/bridge/scripts/pack-smoke.mjs";

test("the published Bridge tarball is source-independent and runs in a clean npm project", { timeout: 120_000 }, async context => {
  const result = await runBridgePackSmoke({
    outputDirectory: process.env.HUNSU_BRIDGE_PACK_OUTPUT
  });
  assert.equal(result.packageName, "@hunsu/bridge");
  assert.equal(result.version, "0.2.0-next.0");
  assert.equal(result.nodeEngine, ">=22.18");
  assert.ok(result.tarballBytes > 0);
  assert.deepEqual(result.files, [
    "LICENSE",
    "README.md",
    "dist/cli.js",
    "dist/index.d.ts",
    "dist/index.js",
    "package.json"
  ]);
  context.diagnostic(`packed ${result.tarballBytes} bytes and completed install/daemon smoke in ${result.durationMs} ms`);
});
