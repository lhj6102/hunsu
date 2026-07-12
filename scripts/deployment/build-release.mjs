#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertRetainedWorkerModule,
  assertSourceSha,
  createReleaseManifest,
  gitValue,
  verifyRelease
} from "./release-lib.mjs";
import { cloudflareResourceAllowlist } from "./resource-allowlist.mjs";

const scriptRoot = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptRoot, "../..");
const outputRoot = resolve(process.argv[2] ?? "deployment-release");
const sourceSha = assertSourceSha(process.env.HUNSU_RELEASE_SHA ?? gitValue(["rev-parse", "HEAD"], repositoryRoot));
const actualSha = assertSourceSha(gitValue(["rev-parse", "HEAD"], repositoryRoot));
if (actualSha !== sourceSha) {
  throw new Error(`Checked-out source ${actualSha} does not match HUNSU_RELEASE_SHA ${sourceSha}.`);
}
const dirtyEntries = gitValue(["status", "--porcelain=v1", "--untracked-files=all"], repositoryRoot);
if (dirtyEntries) {
  throw new Error("Refusing to build a release from a dirty Git worktree.");
}

rmSync(outputRoot, { recursive: true, force: true });
mkdirSync(resolve(outputRoot, "hub/migrations"), { recursive: true });
mkdirSync(resolve(outputRoot, "connect/migrations"), { recursive: true });

run("pnpm", [
  "--filter",
  "@hunsu/web...",
  "--filter",
  "@hunsu/hub-api...",
  "--filter",
  "@hunsu/connect-api...",
  "run",
  "build"
]);
const webDist = resolve(repositoryRoot, "apps/web/dist");
const neutralRuntimeConfig = resolve(webDist, "hunsu-runtime-config.js");
if (!existsSync(neutralRuntimeConfig) || !readFileSync(neutralRuntimeConfig, "utf8").includes("__HUNSU_WEB_RUNTIME_CONFIG__ = null")) {
  throw new Error("Web build did not retain the neutral hunsu-runtime-config.js placeholder.");
}
cpSync(webDist, resolve(outputRoot, "web"), { recursive: true });

run("pnpm", ["--filter", "@hunsu/hub-api", "config:write"]);
const hubBundleDirectory = resolve(outputRoot, ".hub-worker-build");
rmSync(hubBundleDirectory, { recursive: true, force: true });
run("pnpm", [
  "--filter",
  "@hunsu/hub-api",
  "exec",
  "wrangler",
  "deploy",
  "--config",
  ".wrangler/generated.toml",
  "--dry-run",
  "--outdir",
  hubBundleDirectory,
  "--metafile",
  resolve(hubBundleDirectory, "bundle-meta.json")
]);
const hubBundleEntry = resolve(hubBundleDirectory, "index.js");
const retainedHubWorker = resolve(outputRoot, "hub/worker.mjs");
if (!existsSync(hubBundleEntry)) {
  throw new Error("Wrangler dry-run did not produce the retained Hub Worker module.");
}
copyFileSync(hubBundleEntry, retainedHubWorker);
rmSync(hubBundleDirectory, { recursive: true, force: true });
assertRetainedWorkerModule(retainedHubWorker, "Hub");
cpSync(resolve(repositoryRoot, "apps/hub-api/migrations"), resolve(outputRoot, "hub/migrations"), { recursive: true });

run("pnpm", [
  "--filter",
  "@hunsu/connect-api",
  "run",
  "build:worker",
  "--",
  resolve(outputRoot, "connect/worker.mjs")
]);
if (!existsSync(resolve(outputRoot, "connect/worker.mjs"))) {
  throw new Error("Wrangler dry-run did not produce the retained Connect Worker module.");
}
rmSync(resolve(outputRoot, "connect/worker.mjs.meta.json"), { force: true });
assertRetainedWorkerModule(resolve(outputRoot, "connect/worker.mjs"), "Connect");
cpSync(resolve(repositoryRoot, "apps/connect-api/migrations"), resolve(outputRoot, "connect/migrations"), { recursive: true });

const bridgePackage = JSON.parse(readFileSync(resolve(repositoryRoot, "apps/bridge/package.json"), "utf8"));
const pnpmVersion = execFileSync("pnpm", ["--version"], { cwd: repositoryRoot, encoding: "utf8" }).trim();
const connectTrust = Object.fromEntries(["preview", "production"].map(target => {
  const resources = cloudflareResourceAllowlist(target);
  return [target, {
    apiOrigin: resources.connectApiBaseUrl,
    accessIssuer: resources.connectAccessIssuer,
    accessAudience: resources.connectAccessAud,
    ticketSigningKeyId: resources.connectSigningKeyId,
    ticketSigningPublicJwk: JSON.parse(resources.connectSigningPublicJwk)
  }];
}));
createReleaseManifest(outputRoot, {
  sourceSha,
  sourceTree: gitValue(["rev-parse", "HEAD^{tree}"], repositoryRoot),
  bridgePackageVersion: bridgePackage.version,
  connectTrust,
  repository: process.env.GITHUB_REPOSITORY ?? "local/hunsu",
  ref: process.env.GITHUB_REF ?? "local",
  workflowRunId: process.env.GITHUB_RUN_ID,
  workflowRunAttempt: process.env.GITHUB_RUN_ATTEMPT,
  pnpmVersion
});
const verified = verifyRelease(outputRoot, { expectedSourceSha: sourceSha });
console.log(JSON.stringify({
  releaseRoot: outputRoot,
  sourceSha,
  sourceTree: verified.manifest.source.tree,
  bridgePackageVersion: verified.manifest.bridgePackageVersion,
  manifestSha256: verified.manifestSha256
}));

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    env: { ...process.env, HUNSU_RELEASE_SHA: sourceSha },
    stdio: "inherit"
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with status ${result.status}.`);
  }
}
