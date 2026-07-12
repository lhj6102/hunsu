#!/usr/bin/env node
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  WEB_RUNTIME_CONFIG_SCHEMA,
  assertDeployTarget,
  assertSourceSha,
  requireEnv,
  validateBaseUrl,
  verifyRelease
} from "./release-lib.mjs";
import { assertCloudflareResourceAllowlist } from "./resource-allowlist.mjs";
import { validateEnvironmentContract } from "./environment-contract.mjs";

const [releaseArgument, outputArgument, hubConfigArgument, connectConfigArgument] = process.argv.slice(2);
if (!releaseArgument || !outputArgument || !hubConfigArgument || !connectConfigArgument) {
  throw new Error("Usage: prepare-deployment.mjs <release-root> <output-root> <generated-hub-config> <generated-connect-config>");
}

const releaseRoot = resolve(releaseArgument);
const outputRoot = resolve(outputArgument);
const hubConfigPath = resolve(hubConfigArgument);
const connectConfigPath = resolve(connectConfigArgument);
const target = assertDeployTarget(requireEnv("HUNSU_DEPLOY_TARGET"));
const sourceSha = assertSourceSha(requireEnv("HUNSU_RELEASE_SHA"));
const webPublicUrl = validateBaseUrl(requireEnv("HUNSU_WEB_PUBLIC_URL"), "HUNSU_WEB_PUBLIC_URL");
const hubPublicApiUrl = validateBaseUrl(requireEnv("HUNSU_HUB_PUBLIC_API_URL"), "HUNSU_HUB_PUBLIC_API_URL");
const bridgeApiBaseUrl = validateBaseUrl(requireEnv("HUNSU_BRIDGE_API_BASE_URL"), "HUNSU_BRIDGE_API_BASE_URL");
const connectApiBaseUrl = validateBaseUrl(requireEnv("HUNSU_CONNECT_API_BASE_URL"), "HUNSU_CONNECT_API_BASE_URL");
const environment = validateEnvironmentContract(target, process.env, {
  webPublicUrl,
  hubPublicApiUrl,
  bridgeApiBaseUrl,
  connectApiBaseUrl
});
assertCloudflareResourceAllowlist(target, {
  accountId: environment.accountId,
  pagesProject: environment.pagesProject,
  webPublicUrl,
  bridgeApiBaseUrl,
  connectApiBaseUrl,
  connectWorkerName: environment.connectWorkerName,
  connectD1DatabaseName: environment.connectD1DatabaseName,
  connectD1DatabaseId: environment.connectD1DatabaseId,
  connectAccessIssuer: environment.connectAccessIssuer,
  connectAccessAud: environment.connectAccessAud,
  connectSigningPublicJwk: environment.connectSigningPublicJwk,
  connectSigningKeyId: environment.connectSigningKeyId,
  workerName: environment.workerName,
  originName: environment.originName,
  hubPublicApiUrl,
  d1DatabaseName: environment.d1DatabaseName,
  d1DatabaseId: environment.d1DatabaseId,
  r2BucketName: environment.r2BucketName
});
const verified = verifyRelease(releaseRoot, { expectedSourceSha: sourceSha });
const retainedConnectTrust = verified.manifest.connectTrust[target];
if (retainedConnectTrust.apiOrigin !== connectApiBaseUrl
  || retainedConnectTrust.accessIssuer !== environment.connectAccessIssuer
  || retainedConnectTrust.accessAudience !== environment.connectAccessAud
  || retainedConnectTrust.ticketSigningKeyId !== environment.connectSigningKeyId
  || JSON.stringify(retainedConnectTrust.ticketSigningPublicJwk) !== environment.connectSigningPublicJwk) {
  throw new Error("Protected Connect trust does not match the retained release and immutable Bridge candidate.");
}

rmSync(outputRoot, { recursive: true, force: true });
mkdirSync(outputRoot, { recursive: true });
cpSync(resolve(releaseRoot, "web"), resolve(outputRoot, "web"), { recursive: true });
cpSync(resolve(releaseRoot, "hub"), resolve(outputRoot, "hub"), { recursive: true });
cpSync(resolve(releaseRoot, "connect"), resolve(outputRoot, "connect"), { recursive: true });

const runtimeConfig = {
  schema: WEB_RUNTIME_CONFIG_SCHEMA,
  target,
  sourceSha,
  bridgePackageVersion: verified.manifest.bridgePackageVersion,
  bridgeApiBaseUrl,
  hubApiBaseUrl: hubPublicApiUrl,
  connectApiBaseUrl
};
writeFileSync(
  resolve(outputRoot, "web/hunsu-runtime-config.js"),
  `window.__HUNSU_WEB_RUNTIME_CONFIG__ = ${JSON.stringify(runtimeConfig, null, 2)};\n`,
  "utf8"
);

const hubBaseConfig = readFileSync(hubConfigPath, "utf8");
assertGeneratedHubConfigIdentity(hubBaseConfig, {
  ...environment,
  target,
  hubPublicApiUrl,
  sourceSha
});
let hubUploadConfig = replaceExactlyOnce(
  hubBaseConfig,
  /^main\s*=.*$/mu,
  'main = "./worker.mjs"\nno_bundle = true\nfind_additional_modules = false',
  "Worker main"
);
hubUploadConfig = replaceExactlyOnce(hubUploadConfig, /^migrations_dir\s*=.*$/mu, 'migrations_dir = "./migrations"', "D1 migrations directory");
writeFileSync(resolve(outputRoot, "hub/wrangler.toml"), hubUploadConfig, "utf8");

const connectBaseConfig = JSON.parse(readFileSync(connectConfigPath, "utf8"));
assertGeneratedConnectConfigIdentity(connectBaseConfig, {
  ...environment,
  target,
  connectApiBaseUrl,
  webPublicUrl,
  sourceSha
});
const connectUploadConfig = {
  ...connectBaseConfig,
  main: "./worker.mjs",
  no_bundle: true,
  find_additional_modules: false,
  upload_source_maps: false,
  d1_databases: connectBaseConfig.d1_databases.map(database => ({
    ...database,
    migrations_dir: "./migrations"
  }))
};
writeFileSync(resolve(outputRoot, "connect/wrangler.json"), `${JSON.stringify(connectUploadConfig, null, 2)}\n`, "utf8");

const deployment = {
  schema: "hunsu.deployment-input.v3",
  target,
  sourceSha,
  sourceTree: verified.manifest.source.tree,
  bridgePackageVersion: verified.manifest.bridgePackageVersion,
  releaseManifestSha256: verified.manifestSha256,
  webPublicUrl,
  hubPublicApiUrl,
  bridgeApiBaseUrl,
  connectApiBaseUrl,
  connectTrust: retainedConnectTrust,
  resources: {
    pagesProject: environment.pagesProject,
    workerName: environment.workerName,
    d1DatabaseName: environment.d1DatabaseName,
    d1DatabaseId: environment.d1DatabaseId,
    r2BucketName: environment.r2BucketName,
    originName: environment.originName,
    connectWorkerName: environment.connectWorkerName,
    connectD1DatabaseName: environment.connectD1DatabaseName,
    connectD1DatabaseId: environment.connectD1DatabaseId,
    connectAccessIssuer: environment.connectAccessIssuer,
    connectAccessAud: environment.connectAccessAud,
    connectSigningPublicJwk: environment.connectSigningPublicJwk,
    connectSigningKeyId: environment.connectSigningKeyId
  },
  migrations: verified.manifest.migrations
};
writeFileSync(resolve(outputRoot, "deployment-input.json"), `${JSON.stringify(deployment, null, 2)}\n`, "utf8");
console.log(JSON.stringify(deployment));

function assertGeneratedHubConfigIdentity(config, environment) {
  const requiredValues = [
    environment.workerName,
    environment.originName,
    environment.d1DatabaseName,
    environment.d1DatabaseId,
    environment.r2BucketName,
    environment.target,
    environment.hubPublicApiUrl,
    environment.sourceSha
  ];
  for (const value of requiredValues) {
    if (!config.includes(JSON.stringify(value))) {
      throw new Error(`Generated Wrangler config is missing expected environment value: ${value}`);
    }
  }
  if (!/^custom_domain\s*=\s*true$/mu.test(config)) {
    throw new Error("Generated Wrangler config is missing its exact Hub custom-domain route.");
  }
}

function assertGeneratedConnectConfigIdentity(config, environment) {
  const databases = Array.isArray(config.d1_databases) ? config.d1_databases : [];
  const durableObjects = Array.isArray(config.durable_objects?.bindings) ? config.durable_objects.bindings : [];
  const routes = Array.isArray(config.routes) ? config.routes : [];
  const durableObjectMigrations = Array.isArray(config.migrations) ? config.migrations : [];
  const database = databases[0];
  const durableObject = durableObjects[0];
  const route = routes[0];
  const migration = durableObjectMigrations.find(candidate => candidate.tag === "v1");
  const expected = {
    name: environment.connectWorkerName,
    databaseName: environment.connectD1DatabaseName,
    databaseId: environment.connectD1DatabaseId,
    durableObjectClass: "DeviceSignalDO",
    route: new URL(environment.connectApiBaseUrl).hostname,
    target: environment.target,
    sourceSha: environment.sourceSha,
    connectApiBaseUrl: environment.connectApiBaseUrl,
    webPublicUrl: environment.webPublicUrl,
    accessIssuer: environment.connectAccessIssuer,
    accessAud: environment.connectAccessAud,
    signingPublicJwk: environment.connectSigningPublicJwk,
    signingKeyId: environment.connectSigningKeyId
  };
  if (
    config.name !== expected.name
    || config.workers_dev !== false
    || config.preview_urls !== false
    || databases.length !== 1
    || durableObjects.length !== 1
    || routes.length !== 1
    || durableObjectMigrations.length !== 1
    || database?.binding !== "CONNECT_DB"
    || database?.database_name !== expected.databaseName
    || database?.database_id !== expected.databaseId
    || durableObject?.name !== "DEVICE_SIGNAL"
    || durableObject?.class_name !== expected.durableObjectClass
    || route?.pattern !== expected.route
    || route?.custom_domain !== true
    || !migration?.new_sqlite_classes?.includes(expected.durableObjectClass)
    || config.vars?.HUNSU_DEPLOY_TARGET !== expected.target
    || config.vars?.HUNSU_RELEASE_SHA !== expected.sourceSha
    || config.vars?.HUNSU_CONNECT_API_BASE_URL !== expected.connectApiBaseUrl
    || config.vars?.HUNSU_WEB_PUBLIC_URL !== expected.webPublicUrl
    || config.vars?.HUNSU_CONNECT_ACCESS_ISSUER !== expected.accessIssuer
    || config.vars?.HUNSU_CONNECT_ACCESS_AUD !== expected.accessAud
    || config.vars?.HUNSU_CONNECT_SIGNING_PUBLIC_JWK !== expected.signingPublicJwk
    || config.vars?.HUNSU_CONNECT_SIGNING_KEY_ID !== expected.signingKeyId
  ) {
    throw new Error("Generated Connect Wrangler config does not match the exact protected environment identity.");
  }
}

function replaceExactlyOnce(value, pattern, replacement, label) {
  const matches = value.match(new RegExp(pattern.source, `${pattern.flags}g`));
  if (matches?.length !== 1) {
    throw new Error(`Expected exactly one ${label} entry in generated Wrangler config.`);
  }
  return value.replace(pattern, replacement);
}
