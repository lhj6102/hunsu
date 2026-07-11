import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runBridgePackSmoke } from "../apps/bridge/scripts/pack-smoke.mjs";

test("the protected publish workflow selects an immutable tag and publishes an explicit local tarball", async () => {
  const workflow = await readFile(new URL("../.github/workflows/publish-bridge.yml", import.meta.url), "utf8");
  assert.match(workflow, /GITHUB_REF_TYPE" != "branch" \|\| "\$GITHUB_REF_NAME" != "main"/u);
  assert.match(workflow, /checked_out_sha=\$\(git rev-parse HEAD\)/u);
  assert.match(workflow, /npm publish \.\/bridge-release\/\*\.tgz --tag "\$DIST_TAG" --provenance/u);
  assert.doesNotMatch(workflow, /npm publish bridge-release\/\*\.tgz/u);
});

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
