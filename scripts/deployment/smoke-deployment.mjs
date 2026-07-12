#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  PREVIEW_EVIDENCE_SCHEMA,
  WEB_RUNTIME_CONFIG_SCHEMA,
  assertDeployTarget,
  assertSourceSha,
  requireEnv,
  validateBaseUrl,
  verifyRelease
} from "./release-lib.mjs";

const [releaseArgument, candidateBindingArgument, evidenceArgument] = process.argv.slice(2);
if (!releaseArgument || !candidateBindingArgument || !evidenceArgument) {
  throw new Error("Usage: smoke-deployment.mjs <release-root> <candidate-binding-json> <evidence-output>");
}
const target = assertDeployTarget(requireEnv("HUNSU_DEPLOY_TARGET"));
const sourceSha = assertSourceSha(requireEnv("HUNSU_RELEASE_SHA"));
const webPublicUrl = validateBaseUrl(requireEnv("HUNSU_WEB_PUBLIC_URL"), "HUNSU_WEB_PUBLIC_URL");
const hubPublicApiUrl = validateBaseUrl(requireEnv("HUNSU_HUB_PUBLIC_API_URL"), "HUNSU_HUB_PUBLIC_API_URL");
const bridgeApiBaseUrl = validateBaseUrl(requireEnv("HUNSU_BRIDGE_API_BASE_URL"), "HUNSU_BRIDGE_API_BASE_URL");
const connectApiBaseUrl = validateBaseUrl(requireEnv("HUNSU_CONNECT_API_BASE_URL"), "HUNSU_CONNECT_API_BASE_URL");
const connectAccessIssuer = validateBaseUrl(requireEnv("HUNSU_CONNECT_ACCESS_ISSUER"), "HUNSU_CONNECT_ACCESS_ISSUER");
const connectAccessAud = requireEnv("HUNSU_CONNECT_ACCESS_AUD");
const originName = requireEnv("HUNSU_HUB_ORIGIN_NAME");
const verified = verifyRelease(resolve(releaseArgument), { expectedSourceSha: sourceSha });
const bridgeCandidate = JSON.parse(readFileSync(resolve(candidateBindingArgument), "utf8"));
if (
  bridgeCandidate.schema !== "hunsu.bridge.candidate-binding.v1"
  || bridgeCandidate.package !== "@hunsu/bridge"
  || bridgeCandidate.version !== verified.manifest.bridgePackageVersion
  || bridgeCandidate.source?.sha !== sourceSha
) {
  throw new Error("Bridge candidate binding does not match the retained deployment release.");
}

await waitForDeploymentIdentity();

const evidence = {
  schema: target === "preview" ? PREVIEW_EVIDENCE_SCHEMA : "hunsu.production-deployment-evidence.v1",
  target,
  sourceSha,
  sourceTree: verified.manifest.source.tree,
  bridgePackageVersion: verified.manifest.bridgePackageVersion,
  bridgeCandidate,
  releaseManifestSha256: verified.manifestSha256,
  webPublicUrl,
  hubPublicApiUrl,
  bridgeApiBaseUrl,
  connectApiBaseUrl,
  connectAccessIssuer,
  connectAccessAud,
  originName,
  deploymentRun: process.env.GITHUB_RUN_ID
    ? `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : "local",
  deployedAt: new Date().toISOString(),
  migrations: verified.manifest.migrations
};
writeFileSync(resolve(evidenceArgument), `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
console.log(JSON.stringify(evidence));

function parseRuntimeConfig(source) {
  const match = source.match(/window\.__HUNSU_WEB_RUNTIME_CONFIG__\s*=\s*(\{[\s\S]*\})\s*;?\s*$/u);
  if (!match) throw new Error("Deployed Web runtime config has an invalid assignment.");
  return JSON.parse(match[1]);
}

async function waitForDeploymentIdentity() {
  const deadline = Date.now() + 5 * 60 * 1000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      await verifyDeploymentIdentity();
      return;
    } catch (error) {
      lastError = error;
      console.log(`Deployment identity is not ready: ${error instanceof Error ? error.message : String(error)}`);
      await new Promise(resolve => setTimeout(resolve, 10000));
    }
  }
  throw new Error(`Timed out waiting for deployed Web, Hub, and Connect identity: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

async function verifyDeploymentIdentity() {
  const webResponse = await fetchForSmoke(`${webPublicUrl}/`);
  if (!webResponse.ok) throw new Error(`Web smoke returned HTTP ${webResponse.status}.`);
  const webHtml = await webResponse.text();
  if (!webHtml.includes("/hunsu-runtime-config.js")) {
    throw new Error("Web smoke did not find the runtime-config bootstrap in deployed HTML.");
  }

  const runtimeResponse = await fetchForSmoke(`${webPublicUrl}/hunsu-runtime-config.js?release=${sourceSha}`);
  if (!runtimeResponse.ok) throw new Error(`Web runtime config returned HTTP ${runtimeResponse.status}.`);
  const runtimeConfig = parseRuntimeConfig(await runtimeResponse.text());
  if (
    runtimeConfig.schema !== WEB_RUNTIME_CONFIG_SCHEMA
    || runtimeConfig.target !== target
    || runtimeConfig.sourceSha !== sourceSha
    || runtimeConfig.bridgePackageVersion !== verified.manifest.bridgePackageVersion
    || runtimeConfig.bridgeApiBaseUrl !== bridgeApiBaseUrl
    || runtimeConfig.hubApiBaseUrl !== hubPublicApiUrl
    || runtimeConfig.connectApiBaseUrl !== connectApiBaseUrl
  ) {
    throw new Error("Deployed Web runtime identity does not match the retained release and target environment.");
  }

  const hubResponse = await fetchForSmoke(`${hubPublicApiUrl}/health?release=${sourceSha}`);
  if (!hubResponse.ok) throw new Error(`Hub health smoke returned HTTP ${hubResponse.status}.`);
  const hubHealth = await hubResponse.json();
  if (
    hubHealth?.status !== "ok"
    || hubHealth?.service !== "hunsu-hub-api"
    || hubHealth?.target !== target
    || hubHealth?.origin !== originName
    || hubHealth?.release !== sourceSha
  ) {
    throw new Error("Deployed Hub health identity does not match the retained release and target environment.");
  }

  const connectResponse = await fetchForSmoke(`${connectApiBaseUrl}/health?release=${sourceSha}`);
  if (!connectResponse.ok) throw new Error(`Connect health smoke returned HTTP ${connectResponse.status}.`);
  const connectHealth = await connectResponse.json();
  if (
    connectHealth?.ok !== true
    || connectHealth?.service !== "hunsu-connect"
    || connectHealth?.target !== target
    || connectHealth?.release !== sourceSha
    || connectHealth?.issuer !== connectApiBaseUrl
  ) {
    throw new Error("Deployed Connect health identity does not match the target environment.");
  }

  const sessionResponse = await fetchForSmoke(`${connectApiBaseUrl}/auth/session`, {
    redirect: "manual",
    headers: {
      accept: "application/json",
      origin: webPublicUrl
    }
  });
  if (sessionResponse.status !== 401
    || sessionResponse.headers.get("access-control-allow-origin") !== webPublicUrl) {
    throw new Error("Connect session status must bypass Access and enforce its own browser-session CORS boundary.");
  }

  const preflightResponse = await fetchForSmoke(`${connectApiBaseUrl}/auth/session`, {
    method: "OPTIONS",
    redirect: "manual",
    headers: {
      origin: webPublicUrl,
      "access-control-request-method": "DELETE",
      "access-control-request-headers": "content-type"
    }
  });
  if (preflightResponse.status !== 204
    || preflightResponse.headers.get("access-control-allow-origin") !== webPublicUrl
    || preflightResponse.headers.get("access-control-allow-credentials") !== "true") {
    throw new Error("Connect session preflight must reach the Worker CORS policy instead of the Access wildcard.");
  }
}

function fetchForSmoke(url, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("cache-control", "no-cache");
  return fetch(url, {
    ...init,
    headers,
    signal: AbortSignal.timeout(10000)
  });
}
