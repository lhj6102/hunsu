import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runBridgePackSmoke } from "../apps/bridge/scripts/pack-smoke.mjs";

test("preview publishes one SHA-bound immutable candidate while tag and dist-tag promotion stay manual", async () => {
  const [publish, headless, service, registry, production, serviceSmoke] = await Promise.all([
    readFile(new URL("../.github/workflows/publish-bridge.yml", import.meta.url), "utf8"),
    readFile(new URL("../.github/workflows/bridge-headless.yml", import.meta.url), "utf8"),
    readFile(new URL("../.github/workflows/bridge-service-smoke.yml", import.meta.url), "utf8"),
    readFile(new URL("../.github/workflows/bridge-registry-smoke.yml", import.meta.url), "utf8"),
    readFile(new URL("../.github/workflows/bridge-production-integration.yml", import.meta.url), "utf8"),
    readFile(new URL("../scripts/bridge-service-smoke.mjs", import.meta.url), "utf8")
  ]);
  assert.match(headless, /push:\s+branches:\s+- main\s+- preview/su);
  assert.match(publish, /push:\s+branches:\s+- preview/su);
  assert.match(publish, /Automatic candidate publication is restricted to the protected preview branch/u);
  assert.doesNotMatch(publish, /publish-candidate/u);
  assert.match(publish, /Bridge Headless preview run/u);
  assert.match(publish, /GITHUB_REF_TYPE" != "tag" \|\| "\$GITHUB_REF_NAME" != "\$VERSION_TAG"/u);
  assert.match(publish, /ref: \$\{\{ github\.sha \}\}/u);
  assert.match(publish, /checked_out_sha=\$\(git rev-parse HEAD\)/u);
  assert.match(publish, /remote_tag_sha.*GITHUB_SHA/su);
  assert.match(publish, /npm publish \.\/bridge-release\/\*\.tgz --tag candidate-next --provenance/u);
  assert.match(publish, /Verify signed provenance binds this protected preview push/u);
  assert.match(publish, /verify-bridge-npm-provenance\.mjs > bridge-release\/npm-provenance\.json/u);
  assert.match(publish, /registry_integrity.*LOCAL_INTEGRITY/su);
  assert.match(publish, /already exists with different bytes\. Bump apps\/bridge\/package\.json/u);
  assert.match(publish, /candidate-next points to \$candidate\. Bump the version/u);
  assert.match(publish, /expectedGitTag: process\.env\.VERSION_TAG/u);
  assert.match(publish, /bridge-candidate-\$\{\{ needs\.verify_headless\.outputs\.verified_sha \}\}/u);
  assert.doesNotMatch(publish, /npm publish \.\/bridge-release\/\*\.tgz --tag (?:next|latest)/u);
  assert.match(publish, /bridge-registry-smoke\.yml/u);
  assert.match(publish, /bridge-production-integration\.yml/u);
  assert.match(publish, /run\.head_branch === process\.env\.VERSION_TAG/u);
  assert.match(publish, /npm dist-tag add @hunsu\/bridge@\$PACKAGE_VERSION \$target/u);
  assert.doesNotMatch(publish, /^\s*run:\s*npm dist-tag add/mu);

  assert.match(service, /bridge-service-smoke\.mjs --tarball/u);
  assert.doesNotMatch(service, /runtime\/install\.json/u);
  assert.match(registry, /bridge-service-smoke\.mjs --registry-version/u);
  assert.match(registry, /dist-tags\.candidate-next/u);
  assert.match(registry, /dist\.integrity/u);
  assert.match(registry, /\^sha512-/u);
  assert.match(registry, /ref: \$\{\{ github\.sha \}\}/u);
  assert.match(registry, /candidate tag moved after this registry smoke was dispatched/u);

  assert.match(production, /evidence_sha256:/u);
  assert.match(production, /npm audit signatures --json --include-attestations/u);
  assert.match(production, /verify-bridge-npm-provenance\.mjs/u);
  assert.match(production, /provenance\.source\.ref !== "refs\/heads\/preview"/u);
  assert.doesNotMatch(production, /provenance\.source\.ref !== `refs\/tags\//u);
  assert.match(production, /retained-qa-evidence\.record/u);
  assert.match(production, /ref: \$\{\{ github\.sha \}\}/u);
  assert.doesNotMatch(production, /npm_provenance_url:/u);

  assert.match(serviceSmoke, /loaded LaunchAgent arguments omitted/u);
  assert.match(serviceSmoke, /current\.pid !== previous\.pid/u);
});

test("the published Bridge tarball is source-independent and runs in a clean npm project", { timeout: 120_000 }, async context => {
  const result = await runBridgePackSmoke({
    outputDirectory: process.env.HUNSU_BRIDGE_PACK_OUTPUT
  });
  assert.equal(result.packageName, "@hunsu/bridge");
  assert.equal(result.version, "0.2.0-next.4");
  assert.equal(result.nodeEngine, ">=24.18");
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
