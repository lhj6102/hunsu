import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runBridgePackSmoke } from "../apps/bridge/scripts/pack-smoke.mjs";

test("release workflows publish candidate-next before exact registry smoke and proof-of-presence promotion", async () => {
  const [publish, service, registry] = await Promise.all([
    readFile(new URL("../.github/workflows/publish-bridge.yml", import.meta.url), "utf8"),
    readFile(new URL("../.github/workflows/bridge-service-smoke.yml", import.meta.url), "utf8"),
    readFile(new URL("../.github/workflows/bridge-registry-smoke.yml", import.meta.url), "utf8")
  ]);
  assert.match(publish, /GITHUB_REF_TYPE" != "branch" \|\| "\$GITHUB_REF_NAME" != "main"/u);
  assert.match(publish, /checked_out_sha=\$\(git rev-parse HEAD\)/u);
  assert.match(publish, /npm publish \.\/bridge-release\/\*\.tgz --tag candidate-next --provenance/u);
  assert.doesNotMatch(publish, /npm publish \.\/bridge-release\/\*\.tgz --tag (?:next|latest)/u);
  assert.match(publish, /bridge-registry-smoke\.yml/u);
  assert.match(publish, /bridge-production-integration\.yml/u);
  assert.match(publish, /npm dist-tag add @hunsu\/bridge@\$PACKAGE_VERSION \$target/u);
  assert.doesNotMatch(publish, /^\s*run:\s*npm dist-tag add/mu);

  assert.match(service, /bridge-service-smoke\.mjs --tarball/u);
  assert.doesNotMatch(service, /runtime\/install\.json/u);
  assert.match(registry, /bridge-service-smoke\.mjs --registry-version/u);
  assert.match(registry, /dist-tags\.candidate-next/u);
});

test("the published Bridge tarball is source-independent and runs in a clean npm project", { timeout: 120_000 }, async context => {
  const result = await runBridgePackSmoke({
    outputDirectory: process.env.HUNSU_BRIDGE_PACK_OUTPUT
  });
  assert.equal(result.packageName, "@hunsu/bridge");
  assert.equal(result.version, "0.2.0-next.1");
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
