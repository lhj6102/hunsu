import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  createReleaseManifest,
  verifyRelease,
  type ReleaseManifest
} from "../scripts/deployment/release-lib.mjs";
import { selectPromotionPullRequest } from "../scripts/deployment/promotion-gate.mjs";
import { verifyBridgeCandidate } from "../scripts/deployment/bridge-candidate-lib.mjs";
import { assertCloudflareResourceAllowlist } from "../scripts/deployment/resource-allowlist.mjs";
import { validateEnvironmentContract } from "../scripts/deployment/environment-contract.mjs";
import { writeConnectSecretsFile } from "../scripts/deployment/write-connect-secrets-file.mjs";

const SOURCE_SHA = "a".repeat(40);
const MERGE_SHA = "b".repeat(40);
const CONNECT_PUBLIC_JWK = JSON.stringify({
  kty: "EC",
  crv: "P-256",
  x: "DZDAFyOricZ4dOBOhNrNtAS2X_EdqrE2wQxB23raNcc",
  y: "qLXw7DinTp-5T0i_MdU9jN15Wpnxu0dXh-Owo5ydL1U"
});
const CONNECT_KEY_ID = "connect-vd_GiPDTK2lPIDS3Y2dDIEck";

test("deployment release manifest detects artifact changes", () => {
  const root = mkdtempSync(join(tmpdir(), "hunsu-release-"));
  try {
    mkdirSync(join(root, "web"), { recursive: true });
    mkdirSync(join(root, "hub/migrations"), { recursive: true });
    mkdirSync(join(root, "connect/migrations"), { recursive: true });
    writeFileSync(join(root, "web/hunsu-runtime-config.js"), "window.__HUNSU_WEB_RUNTIME_CONFIG__ = null;\n");
    writeFileSync(join(root, "web/index.html"), "<script src=\"/hunsu-runtime-config.js\"></script>\n");
    writeFileSync(join(root, "hub/worker.mjs"), "export default { fetch() {} };\n");
    writeFileSync(join(root, "hub/migrations/0001.sql"), "SELECT 1;\n");
    writeFileSync(join(root, "connect/worker.mjs"), "export default { fetch() {} };\n");
    writeFileSync(join(root, "connect/migrations/0001.sql"), "SELECT 1;\n");
    createReleaseManifest(root, {
      sourceSha: SOURCE_SHA,
      sourceTree: "c".repeat(40),
      bridgePackageVersion: "0.2.0-next.3",
      repository: "lhj6102/hunsu",
      ref: "refs/heads/preview",
      workflowRunId: "1",
      workflowRunAttempt: "1",
      pnpmVersion: "10.30.2"
    });
    const verified = verifyRelease(root, { expectedSourceSha: SOURCE_SHA });
    assert.deepEqual(verified.manifest.migrations.map(migration => migration.component), ["connect", "hub"]);
    writeFileSync(join(root, "hub/worker.mjs"), "tampered\n");
    assert.throws(() => verifyRelease(root), /integrity mismatch/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("production gate accepts only an exact independent QA approval", () => {
  const pullRequest = {
    number: 42,
    merged_at: "2026-07-12T00:00:00Z",
    merge_commit_sha: MERGE_SHA,
    base: { ref: "main", repo: { full_name: "lhj6102/hunsu" } },
    head: { ref: "preview", sha: SOURCE_SHA, repo: { full_name: "lhj6102/hunsu" } },
    user: { login: "author" }
  };
  const reviews = {
    42: [{
      state: "APPROVED",
      commit_id: SOURCE_SHA,
      submitted_at: "2026-07-12T00:01:00Z",
      user: { login: "qa-lead" }
    }]
  };
  assert.deepEqual(selectPromotionPullRequest({
    pullRequests: [pullRequest],
    reviewsByPullRequest: reviews,
    currentSha: MERGE_SHA,
    qaLeaders: "@qa-lead"
  }), {
    pullRequestNumber: 42,
    previewSha: SOURCE_SHA,
    qaLeader: "qa-lead",
    qaApprovedAt: "2026-07-12T00:01:00Z"
  });
  reviews[42][0].commit_id = "d".repeat(40);
  assert.throws(() => selectPromotionPullRequest({
    pullRequests: [pullRequest],
    reviewsByPullRequest: reviews,
    currentSha: MERGE_SHA,
    qaLeaders: "qa-lead"
  }), /exact preview head/u);
});

test("Cloudflare environment values must match the committed exact resource allowlist", () => {
  const production = {
    accountId: "a5e99f3b23c16ac20da1d55d34504e28",
    pagesProject: "hunsu-web",
    webPublicUrl: "https://hunsu.app",
    bridgeApiBaseUrl: "http://127.0.0.1:19687",
    connectApiBaseUrl: "https://connect.hunsu.app",
    connectWorkerName: "hunsu-connect",
    connectD1DatabaseName: "hunsu_connect",
    connectD1DatabaseId: "c71aed30-29ff-48aa-ba76-866add7f8198",
    workerName: "hunsu-hub-api",
    originName: "hunsu",
    hubPublicApiUrl: "https://api.hunsu.app",
    d1DatabaseName: "hunsu_hub",
    d1DatabaseId: "4523fd88-b827-4015-9aa4-e05c0499ece7",
    r2BucketName: "hunsu-hub-packages"
  };
  assert.deepEqual(assertCloudflareResourceAllowlist("production", production), production);
  assert.throws(() => assertCloudflareResourceAllowlist("production", {
    ...production,
    d1DatabaseId: "348e2174-ddf2-4126-be51-603e6e986f08"
  }), /committed allowlist/u);
});

test("preview and production environment contracts isolate both Hub and Connect resources", () => {
  const common = {
    CLOUDFLARE_ACCOUNT_ID: "a5e99f3b23c16ac20da1d55d34504e28",
    HUNSU_HUB_ORIGIN_NAME: "hunsu",
    HUNSU_CONNECT_ACCESS_ISSUER: "https://hunsu.cloudflareaccess.com",
    HUNSU_CONNECT_ACCESS_AUD: "a".repeat(64),
    HUNSU_CONNECT_SIGNING_PUBLIC_JWK: CONNECT_PUBLIC_JWK,
    HUNSU_CONNECT_SIGNING_KEY_ID: CONNECT_KEY_ID
  };
  const preview = {
    ...common,
    HUNSU_WEB_PAGES_PROJECT: "hunsu-web-preview",
    HUNSU_HUB_WORKER_NAME: "hunsu-hub-api-preview",
    HUNSU_HUB_D1_DATABASE_NAME: "hunsu_hub_preview",
    HUNSU_HUB_D1_DATABASE_ID: "preview-hub-id",
    HUNSU_HUB_R2_BUCKET_NAME: "hunsu-hub-packages-preview",
    HUNSU_CONNECT_WORKER_NAME: "hunsu-connect-preview",
    HUNSU_CONNECT_D1_DATABASE_NAME: "hunsu_connect_preview",
    HUNSU_CONNECT_D1_DATABASE_ID: "preview-connect-id"
  };
  assert.equal(validateEnvironmentContract("preview", preview, {
    webPublicUrl: "https://preview.hunsu.app",
    hubPublicApiUrl: "https://api.preview.hunsu.app",
    bridgeApiBaseUrl: "http://127.0.0.1:19687",
    connectApiBaseUrl: "https://connect.preview.hunsu.app"
  }).connectWorkerName, "hunsu-connect-preview");
  assert.throws(() => validateEnvironmentContract("preview", {
    ...preview,
    HUNSU_CONNECT_D1_DATABASE_NAME: "hunsu_connect"
  }), /Every preview Cloudflare resource name/u);

  const production = {
    ...common,
    HUNSU_WEB_PAGES_PROJECT: "hunsu-web",
    HUNSU_HUB_WORKER_NAME: "hunsu-hub-api",
    HUNSU_HUB_D1_DATABASE_NAME: "hunsu_hub",
    HUNSU_HUB_D1_DATABASE_ID: "production-hub-id",
    HUNSU_HUB_R2_BUCKET_NAME: "hunsu-hub-packages",
    HUNSU_CONNECT_WORKER_NAME: "hunsu-connect",
    HUNSU_CONNECT_D1_DATABASE_NAME: "hunsu_connect",
    HUNSU_CONNECT_D1_DATABASE_ID: "production-connect-id"
  };
  assert.equal(validateEnvironmentContract("production", production, {
    webPublicUrl: "https://hunsu.app",
    hubPublicApiUrl: "https://api.hunsu.app",
    bridgeApiBaseUrl: "http://localhost:19687",
    connectApiBaseUrl: "https://connect.hunsu.app"
  }).connectD1DatabaseName, "hunsu_connect");
  assert.throws(() => validateEnvironmentContract("production", {
    ...production,
    HUNSU_CONNECT_WORKER_NAME: "hunsu-connect-preview"
  }), /refuses Cloudflare resources marked preview/u);
});

test("Connect secret materialization rejects mismatched keys and writes a current-user-only Wrangler secret file", () => {
  const root = mkdtempSync(join(tmpdir(), "hunsu-connect-secret-"));
  try {
    const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const publicJwk = publicKey.export({ format: "jwk" });
    const privateJwk = privateKey.export({ format: "jwk" });
    const publicValue = JSON.stringify({ kty: "EC", crv: "P-256", x: publicJwk.x, y: publicJwk.y });
    const privateValue = JSON.stringify({
      kty: "EC",
      crv: "P-256",
      x: privateJwk.x,
      y: privateJwk.y,
      d: privateJwk.d
    });
    const output = join(root, "secrets.json");
    writeConnectSecretsFile(output, {
      HUNSU_CONNECT_SIGNING_PUBLIC_JWK: publicValue,
      HUNSU_CONNECT_SIGNING_PRIVATE_JWK: privateValue
    });
    const written = JSON.parse(readFileSync(output, "utf8"));
    assert.equal(written.HUNSU_CONNECT_SIGNING_PRIVATE_JWK, privateValue);
    assert.equal(statSync(output).mode & 0o777, 0o600);
    assert.throws(() => writeConnectSecretsFile(join(root, "mismatch.json"), {
      HUNSU_CONNECT_SIGNING_PUBLIC_JWK: CONNECT_PUBLIC_JWK,
      HUNSU_CONNECT_SIGNING_PRIVATE_JWK: privateValue
    }), /does not match/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("deployment preparation binds exact retained Connect bytes and target configuration", () => {
  const root = mkdtempSync(join(tmpdir(), "hunsu-prepare-"));
  const release = join(root, "release");
  const output = join(root, "output");
  try {
    mkdirSync(join(release, "web"), { recursive: true });
    mkdirSync(join(release, "hub/migrations"), { recursive: true });
    mkdirSync(join(release, "connect/migrations"), { recursive: true });
    writeFileSync(join(release, "web/hunsu-runtime-config.js"), "window.__HUNSU_WEB_RUNTIME_CONFIG__ = null;\n");
    writeFileSync(join(release, "web/index.html"), "<script src=\"/hunsu-runtime-config.js\"></script>\n");
    writeFileSync(join(release, "hub/worker.mjs"), "export default { fetch() {} };\n");
    writeFileSync(join(release, "hub/migrations/0001.sql"), "SELECT 1;\n");
    writeFileSync(join(release, "connect/worker.mjs"), "export default { fetch() {} };\n");
    writeFileSync(join(release, "connect/migrations/0001.sql"), "SELECT 1;\n");
    createReleaseManifest(release, {
      sourceSha: SOURCE_SHA,
      sourceTree: "c".repeat(40),
      bridgePackageVersion: "0.2.0-next.3",
      repository: "lhj6102/hunsu",
      ref: "refs/heads/preview",
      workflowRunId: "1",
      workflowRunAttempt: "1",
      pnpmVersion: "10.30.2"
    });

    const hubConfig = join(root, "hub.toml");
    writeFileSync(hubConfig, [
      'name = "hunsu-hub-api-preview"',
      'main = "./src/index.ts"',
      'migrations_dir = "../migrations"',
      '[vars]',
      'HUNSU_HUB_ORIGIN_NAME = "hunsu"',
      'HUNSU_DEPLOY_TARGET = "preview"',
      'HUNSU_HUB_PUBLIC_API_URL = "https://api.preview.hunsu.app"',
      `HUNSU_RELEASE_SHA = "${SOURCE_SHA}"`,
      '[[d1_databases]]',
      'database_name = "hunsu_hub_preview"',
      'database_id = "348e2174-ddf2-4126-be51-603e6e986f08"',
      '[[r2_buckets]]',
      'bucket_name = "hunsu-hub-packages-preview"',
      '[[routes]]',
      'pattern = "api.preview.hunsu.app"',
      'custom_domain = true',
      ""
    ].join("\n"));
    const connectConfig = join(root, "connect.json");
    writeFileSync(connectConfig, `${JSON.stringify({
      name: "hunsu-connect-preview",
      main: "../src/index.ts",
      workers_dev: false,
      preview_urls: false,
      upload_source_maps: false,
      vars: {
        HUNSU_DEPLOY_TARGET: "preview",
        HUNSU_RELEASE_SHA: SOURCE_SHA,
        HUNSU_CONNECT_API_BASE_URL: "https://connect.preview.hunsu.app",
        HUNSU_CONNECT_ACCESS_ISSUER: "https://hunsu.cloudflareaccess.com",
        HUNSU_CONNECT_ACCESS_AUD: "a".repeat(64),
        HUNSU_CONNECT_SIGNING_PUBLIC_JWK: CONNECT_PUBLIC_JWK,
        HUNSU_CONNECT_SIGNING_KEY_ID: CONNECT_KEY_ID,
        HUNSU_WEB_PUBLIC_URL: "https://preview.hunsu.app"
      },
      d1_databases: [{
        binding: "CONNECT_DB",
        database_name: "hunsu_connect_preview",
        database_id: "38cc819b-2405-47a6-925e-0d5d7de731c4",
        migrations_dir: "../migrations"
      }],
      durable_objects: { bindings: [{ name: "DEVICE_SIGNAL", class_name: "DeviceSignalDO" }] },
      migrations: [{ tag: "v1", new_sqlite_classes: ["DeviceSignalDO"] }],
      routes: [{ pattern: "connect.preview.hunsu.app", custom_domain: true }]
    }, null, 2)}\n`);

    execFileSync(process.execPath, [
      resolve(import.meta.dirname, "../scripts/deployment/prepare-deployment.mjs"),
      release,
      output,
      hubConfig,
      connectConfig
    ], {
      env: {
        ...process.env,
        CLOUDFLARE_ACCOUNT_ID: "a5e99f3b23c16ac20da1d55d34504e28",
        HUNSU_DEPLOY_TARGET: "preview",
        HUNSU_RELEASE_SHA: SOURCE_SHA,
        HUNSU_WEB_PAGES_PROJECT: "hunsu-web-preview",
        HUNSU_WEB_PUBLIC_URL: "https://preview.hunsu.app",
        HUNSU_BRIDGE_API_BASE_URL: "http://127.0.0.1:19687",
        HUNSU_CONNECT_API_BASE_URL: "https://connect.preview.hunsu.app",
        HUNSU_CONNECT_WORKER_NAME: "hunsu-connect-preview",
        HUNSU_CONNECT_D1_DATABASE_NAME: "hunsu_connect_preview",
        HUNSU_CONNECT_D1_DATABASE_ID: "38cc819b-2405-47a6-925e-0d5d7de731c4",
        HUNSU_CONNECT_ACCESS_ISSUER: "https://hunsu.cloudflareaccess.com",
        HUNSU_CONNECT_ACCESS_AUD: "a".repeat(64),
        HUNSU_CONNECT_SIGNING_PUBLIC_JWK: CONNECT_PUBLIC_JWK,
        HUNSU_CONNECT_SIGNING_KEY_ID: CONNECT_KEY_ID,
        HUNSU_HUB_WORKER_NAME: "hunsu-hub-api-preview",
        HUNSU_HUB_ORIGIN_NAME: "hunsu",
        HUNSU_HUB_PUBLIC_API_URL: "https://api.preview.hunsu.app",
        HUNSU_HUB_D1_DATABASE_NAME: "hunsu_hub_preview",
        HUNSU_HUB_D1_DATABASE_ID: "348e2174-ddf2-4126-be51-603e6e986f08",
        HUNSU_HUB_R2_BUCKET_NAME: "hunsu-hub-packages-preview"
      },
      stdio: "pipe"
    });
    assert.equal(readFileSync(join(output, "connect/worker.mjs"), "utf8"), "export default { fetch() {} };\n");
    const retainedConnectConfig = JSON.parse(readFileSync(join(output, "connect/wrangler.json"), "utf8"));
    assert.equal(retainedConnectConfig.main, "./worker.mjs");
    assert.equal(retainedConnectConfig.no_bundle, true);
    assert.equal(retainedConnectConfig.find_additional_modules, false);
    assert.equal(retainedConnectConfig.upload_source_maps, false);
    assert.equal(retainedConnectConfig.d1_databases[0].migrations_dir, "./migrations");
    const deployment = JSON.parse(readFileSync(join(output, "deployment-input.json"), "utf8"));
    assert.equal(deployment.resources.connectWorkerName, "hunsu-connect-preview");
    assert.deepEqual(deployment.migrations.map((migration: { component: string }) => migration.component), ["connect", "hub"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Bridge candidate evidence binds exact source, version, tarball, and registry integrity", () => {
  const root = mkdtempSync(join(tmpdir(), "hunsu-candidate-"));
  try {
    const tarball = Buffer.from("immutable candidate tarball");
    const artifactSha256 = createHash("sha256").update(tarball).digest("hex");
    const integrity = `sha512-${createHash("sha512").update(tarball).digest("base64")}`;
    writeFileSync(join(root, "hunsu-bridge.tgz"), tarball);
    writeFileSync(join(root, "candidate-evidence.json"), JSON.stringify({
      schema: "hunsu.bridge.candidate.v1",
      package: "@hunsu/bridge",
      version: "0.2.0-next.2",
      integrity,
      artifactSha256,
      source: {
        repository: "lhj6102/hunsu",
        sha: SOURCE_SHA,
        branch: "preview"
      },
      npmDistTag: "candidate-next",
      workflow: { runId: "9", runAttempt: "1" }
    }));
    const releaseManifest: ReleaseManifest = {
      schema: "hunsu.deployment-release.v3",
      source: {
        repository: "lhj6102/hunsu",
        sha: SOURCE_SHA,
        tree: "c".repeat(40),
        ref: "refs/heads/preview"
      },
      bridgePackageVersion: "0.2.0-next.2",
      build: {
        workflowRunId: "1",
        workflowRunAttempt: "1",
        nodeVersion: "v24.18.0",
        pnpmVersion: "10.30.2"
      },
      runtimeConfig: {
        schema: "hunsu.web-runtime-config.v2",
        path: "web/hunsu-runtime-config.js"
      },
      migrations: [],
      files: []
    };
    const binding = verifyBridgeCandidate(root, releaseManifest, {
      registryIntegrity: integrity,
      candidateVersion: "0.2.0-next.2",
      expectedWorkflowRunId: "9"
    });
    assert.equal(binding.integrity, integrity);
    assert.equal(binding.source.sha, SOURCE_SHA);
    assert.throws(() => verifyBridgeCandidate(root, {
      ...releaseManifest,
      bridgePackageVersion: "0.2.0-next.3"
    }), /does not match retained release/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("deployment workflows retain preview artifacts and forbid production rebuilds", () => {
  const root = resolve(import.meta.dirname, "..");
  const preview = readFileSync(join(root, ".github/workflows/deploy-preview.yml"), "utf8");
  const production = readFileSync(join(root, ".github/workflows/deploy-production.yml"), "utf8");
  const reusable = readFileSync(join(root, ".github/workflows/deploy-cloudflare.yml"), "utf8");
  const rollback = readFileSync(join(root, ".github/workflows/rollback-cloudflare.yml"), "utf8");
  const headless = readFileSync(join(root, ".github/workflows/bridge-headless.yml"), "utf8");
  const gate = readFileSync(join(root, "scripts/deployment/promotion-gate.mjs"), "utf8");
  const smoke = readFileSync(join(root, "scripts/deployment/smoke-deployment.mjs"), "utf8");
  const buildRelease = readFileSync(join(root, "scripts/deployment/build-release.mjs"), "utf8");
  const publish = readFileSync(join(root, ".github/workflows/publish-bridge.yml"), "utf8");
  assert.match(preview, /branches:\s*\n\s*- preview/u);
  assert.match(preview, /build_release: true/u);
  assert.match(preview, /pull-requests: write/u);
  assert.match(preview, /github\.rest\.pulls\.create/u);
  assert.doesNotMatch(preview, /Approve workflows to run/u);
  assert.match(preview, /head: "preview"/u);
  assert.match(preview, /base: "main"/u);
  assert.match(production, /branches:\s*\n\s*- main/u);
  assert.match(gate, /pullRequest\.head\?\.ref === "preview"/u);
  assert.match(production, /build_release: false/u);
  assert.match(production, /require_preview_evidence: true/u);
  assert.match(production, /approvalTime <= previewCompletedTime/u);
  assert.match(reusable, /Only the preview workflow may build a release artifact/u);
  assert.match(reusable, /publish-bridge\.yml/u);
  assert.match(reusable, /verify-bridge-candidate\.mjs/u);
  assert.match(reusable, /HUNSU_BRIDGE_API_BASE_URL/u);
  assert.match(reusable, /HUNSU_CONNECT_API_BASE_URL/u);
  assert.match(reusable, /HUNSU_CONNECT_WORKER_NAME/u);
  assert.match(reusable, /HUNSU_CONNECT_D1_DATABASE_NAME/u);
  assert.match(reusable, /hunsu-deploy\/connect\/wrangler\.json/u);
  assert.match(reusable, /Deploy retained Connect Worker module/u);
  assert.match(reusable, /write-connect-secrets-file\.mjs/u);
  assert.match(reusable, /--secrets-file "\$RUNNER_TEMP\/hunsu-connect-secrets\.json"/u);
  assert.doesNotMatch(reusable, /wrangler secret put HUNSU_CONNECT_SIGNING_PRIVATE_JWK/u);
  assert.ok(
    reusable.indexOf("write-connect-secrets-file.mjs") < reusable.indexOf("Record production D1 recovery bookmarks"),
    "Connect key-pair validation must finish before the first Cloudflare mutation"
  );
  assert.match(reusable, /Apply retained Connect forward migrations/u);
  assert.match(reusable, /d1-recovery\/hub\.json/u);
  assert.match(reusable, /d1-recovery\/connect\.json/u);
  assert.match(reusable, /ensure-pages-domain\.mjs/u);
  assert.match(reusable, /randomBytes\(32\)/u);
  assert.match(reusable, /wrangler secret put HUNSU_HUB_ADMIN_TOKEN/u);
  assert.match(reusable, /HUNSU_HUB_ADMIN_TOKEN="\$seed_token"/u);
  assert.match(reusable, /d1 time-travel info/u);
  assert.match(reusable, /--no-bundle/u);
  assert.match(reusable, /exec node --conditions=development scripts\/cloudflare-config\.mjs print/u);
  assert.doesNotMatch(reusable, /config:print\s*>/u);
  assert.doesNotMatch(reusable, /CLOUDFLARE_ACCOUNT_ID:.*\n\s+CLOUDFLARE_API_TOKEN:/u);
  assert.match(reusable, /name: production-d1-recovery-/u);
  assert.match(reusable, /deployment-failure-/u);
  assert.match(rollback, /apply_migrations: false/u);
  assert.match(rollback, /will not reverse or restore D1 migrations/u);
  assert.match(rollback, /successful exact-SHA deploy-preview\.yml push run/u);
  assert.match(rollback, /prior production evidence/u);
  assert.match(rollback, /core\.setOutput\("tooling_sha", mainBranch\.data\.commit\.sha\)/u);
  assert.match(rollback, /tooling_ref: \$\{\{ needs\.authorize\.outputs\.tooling_sha \}\}/u);
  assert.doesNotMatch(rollback, /tooling_ref: main/u);
  assert.doesNotMatch(reusable, /workflow_call:\s*[\s\S]*?secrets:\s*\n\s+CLOUDFLARE_API_TOKEN:/u);
  assert.doesNotMatch(`${preview}\n${production}\n${rollback}`, /secrets: inherit/u);
  assert.match(headless, /pull_request:\s*\n\s*branches:\s*\n\s*- preview/u);
  assert.doesNotMatch(headless, /name: Promotion candidate ready/u);
  assert.match(preview, /name: Promotion candidate ready/u);
  assert.match(preview, /if: always\(\)/u);
  assert.match(preview, /DEPLOY_RESULT: \$\{\{ needs\.deploy_preview\.result \}\}/u);
  assert.match(preview, /if \[\[ "\$DEPLOY_RESULT" != "success" \]\]/u);
  assert.match(smoke, /5 \* 60 \* 1000/u);
  assert.match(smoke, /service !== "hunsu-connect"/u);
  assert.match(buildRelease, /"@hunsu\/web\.\.\."/u);
  assert.match(buildRelease, /"@hunsu\/hub-api\.\.\."/u);
  assert.match(buildRelease, /"@hunsu\/connect-api\.\.\."/u);
  assert.ok(
    buildRelease.indexOf('"@hunsu/web..."') < buildRelease.indexOf("const webDist"),
    "Release builds must compile workspace dependency closures before consuming Web output"
  );
  assert.match(publish, /NPM_REGISTRY_URL: https:\/\/registry\.npmjs\.org/u);
  assert.match(publish, /--registry="\$NPM_REGISTRY_URL"/u);
  assert.match(publish, /git log --format='%T' origin\/main \| grep -Fqx "\$candidate_tree"/u);
});
