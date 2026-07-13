import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const WORKER_NAME = "hunsu-plugin-production";
const DOMAIN = "plugin.hunsu.app";
const PLUGIN_ENDPOINT = `https://${DOMAIN}/mcp`;
const SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const EXPECTED_SMOKE_STATUSES = new Map([
  ["web-root", 200],
  ["web-spa-projects", 200],
  ["web-runtime-config", 200],
  ["api-session", 200],
  ["oauth-protected-resource", 200],
  ["oauth-authorization-server", 200],
  ["mcp-authentication-challenge", 401],
  ["github-oauth-redirect", 302]
]);
let args = new Map();

try {
  args = parseArgs(process.argv.slice(2));
  const sourceSha = normalizeSha(required("--source-sha"));
  const wranglerEvents = parseNdjson(await readFile(resolve(required("--wrangler-output")), "utf8"));
  const deployments = JSON.parse(await readFile(resolve(required("--deployments")), "utf8"));
  const smoke = JSON.parse(await readFile(resolve(required("--smoke-results")), "utf8"));
  const wranglerVersion = (await readFile(resolve(required("--wrangler-version")), "utf8")).trim();

  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(wranglerVersion)) {
    throw new Error("Wrangler version is not a semantic version.");
  }
  const deployEvents = wranglerEvents.filter(event => isObject(event)
    && event.type === "deploy"
    && event.version === 1
    && event.worker_name === WORKER_NAME
    && typeof event.version_id === "string");
  if (deployEvents.length !== 1) throw new Error("Wrangler output must contain exactly one production deploy event.");
  const workerVersionId = deployEvents[0].version_id;
  if (!ID_PATTERN.test(workerVersionId)) throw new Error("Wrangler deploy event has an invalid Worker version ID.");

  if (!Array.isArray(deployments)) throw new Error("Wrangler deployments inventory must be a JSON array.");
  const matches = deployments.filter(deployment => isObject(deployment)
    && typeof deployment.id === "string"
    && Array.isArray(deployment.versions)
    && deployment.versions.some(version => isObject(version)
      && version.version_id === workerVersionId
      && version.percentage === 100));
  if (matches.length !== 1) throw new Error("Could not uniquely match the Worker version to a 100% deployment.");
  const deployment = matches[0];
  if (!ID_PATTERN.test(deployment.id)) throw new Error("Matched Cloudflare deployment has an invalid ID.");
  const deployedAt = new Date(deployment.created_on);
  if (Number.isNaN(deployedAt.valueOf())) throw new Error("Matched Cloudflare deployment has an invalid timestamp.");

  validateSmoke(smoke, sourceSha);
  const smokeByName = new Map(smoke.results.map(result => [result.name, result]));
  const smokeResults = [...EXPECTED_SMOKE_STATUSES.keys()].map(name => {
    const result = smokeByName.get(name);
    return {
      name,
      passed: true,
      status: result.status,
      durationMs: result.durationMs,
      message: "ok"
    };
  });
  const evidence = {
    sourceSha,
    workerName: WORKER_NAME,
    domain: DOMAIN,
    deploymentId: deployment.id,
    workerVersionId,
    deployedAt: deployedAt.toISOString(),
    wranglerVersion,
    smokeResults,
    pluginEndpoint: PLUGIN_ENDPOINT,
    webRuntimeSourceSha: smoke.webRuntimeSourceSha
  };
  const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
  assertCredentialFree(serialized);
  await writeFile(resolve(required("--output")), serialized, { encoding: "utf8", mode: 0o644, flag: "wx" });
  console.log(`Wrote credential-free deployment evidence for Worker version ${workerVersionId}.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : "Could not write deployment evidence.");
  process.exitCode = 1;
}

function validateSmoke(smoke, sourceSha) {
  if (!isObject(smoke)
    || smoke.schema !== "hunsu.plugin-production-smoke.v1"
    || smoke.sourceSha !== sourceSha
    || smoke.webRuntimeSourceSha !== sourceSha
    || smoke.domain !== DOMAIN
    || smoke.failed !== 0
    || !Array.isArray(smoke.results)
    || smoke.results.length !== EXPECTED_SMOKE_STATUSES.size
    || smoke.passed !== smoke.results.length) {
    throw new Error("Production smoke evidence is incomplete or does not match the deployed main SHA.");
  }
  const observed = new Set();
  for (const result of smoke.results) {
    if (!isObject(result)
      || typeof result.name !== "string"
      || !EXPECTED_SMOKE_STATUSES.has(result.name)
      || observed.has(result.name)
      || result.passed !== true
      || result.status !== EXPECTED_SMOKE_STATUSES.get(result.name)
      || !Number.isInteger(result.durationMs)
      || result.durationMs < 0
      || result.message !== "ok") {
      throw new Error("Production smoke result has an invalid shape.");
    }
    observed.add(result.name);
  }
  if (observed.size !== EXPECTED_SMOKE_STATUSES.size) {
    throw new Error("Production smoke evidence is missing a required check.");
  }
}

function assertCredentialFree(serialized) {
  const credentialPatterns = [
    /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/u,
    /\b(?:gh[opusr]_|github_pat_)[A-Za-z0-9_]{20,}\b/u,
    /\bBearer\s+[A-Za-z0-9._~-]{16,}\b/iu,
    /"(?:token|privateKey|clientSecret|webhookSecret|sessionSecret|cookie|oauthCode)"\s*:/iu
  ];
  if (credentialPatterns.some(pattern => pattern.test(serialized))) {
    throw new Error("Refusing to write deployment evidence that appears to contain a credential.");
  }
}

function parseNdjson(source) {
  return source.split(/\r?\n/u).filter(Boolean).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch {
      throw new Error(`Wrangler output line ${index + 1} is not valid NDJSON.`);
    }
  });
}

function required(name) {
  const value = args.get(name);
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
}

function normalizeSha(value) {
  const sourceSha = value.trim().toLowerCase();
  if (!SHA_PATTERN.test(sourceSha)) throw new Error("--source-sha must be a complete Git commit SHA.");
  return sourceSha;
}

function parseArgs(values) {
  const allowed = new Set([
    "--source-sha",
    "--wrangler-output",
    "--deployments",
    "--smoke-results",
    "--wrangler-version",
    "--output"
  ]);
  const result = new Map();
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!allowed.has(key) || value === undefined) throw new Error(`Unknown or incomplete argument: ${key ?? "<missing>"}`);
    if (result.has(key)) throw new Error(`Duplicate argument: ${key}.`);
    result.set(key, value);
  }
  return result;
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
