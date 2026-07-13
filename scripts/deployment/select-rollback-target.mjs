import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

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
const SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
let args = new Map();

try {
  args = parseArgs(process.argv.slice(2));
  const deployment = JSON.parse(await readFile(resolve(required("--deployment")), "utf8"));
  const smoke = JSON.parse(await readFile(resolve(required("--smoke-results")), "utf8"));
  if (!isObject(deployment) || typeof deployment.id !== "string" || !ID_PATTERN.test(deployment.id) || !Array.isArray(deployment.versions)) {
    throw new Error("Current deployment status is invalid.");
  }
  if (!isObject(smoke)
    || smoke.schema !== "hunsu.plugin-production-smoke.v1"
    || smoke.domain !== "plugin.hunsu.app"
    || smoke.failed !== 0
    || typeof smoke.sourceSha !== "string"
    || !SHA_PATTERN.test(smoke.sourceSha)
    || smoke.webRuntimeSourceSha !== smoke.sourceSha
    || smoke.passed !== EXPECTED_SMOKE_STATUSES.size
    || !hasCompleteSmokeResults(smoke.results)) {
    throw new Error("Current production did not pass the full baseline smoke suite.");
  }
  const stable = deployment.versions[0];
  if (deployment.versions.length !== 1
    || !isObject(stable)
    || stable.percentage !== 100
    || typeof stable.version_id !== "string"
    || !ID_PATTERN.test(stable.version_id)) {
    throw new Error("Current deployment is not a single 100% stable Worker version.");
  }
  const target = {
    deploymentId: deployment.id,
    workerVersionId: stable.version_id,
    sourceSha: smoke.sourceSha
  };
  await writeFile(resolve(required("--output")), `${JSON.stringify(target, null, 2)}\n`, { encoding: "utf8", mode: 0o644, flag: "wx" });
  console.log(`Recorded known-good rollback target ${target.workerVersionId}.`);
} catch (error) {
  console.error(error instanceof Error ? `No known-good rollback target: ${error.message}` : "No known-good rollback target.");
  process.exitCode = 1;
}

function required(name) {
  const value = args.get(name);
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
}

function parseArgs(values) {
  const allowed = new Set(["--deployment", "--smoke-results", "--output"]);
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

function hasCompleteSmokeResults(results) {
  if (!Array.isArray(results) || results.length !== EXPECTED_SMOKE_STATUSES.size) return false;
  const observed = new Set();
  for (const result of results) {
    if (!isObject(result)
      || typeof result.name !== "string"
      || !EXPECTED_SMOKE_STATUSES.has(result.name)
      || observed.has(result.name)
      || result.passed !== true
      || result.status !== EXPECTED_SMOKE_STATUSES.get(result.name)
      || !Number.isInteger(result.durationMs)
      || result.durationMs < 0
      || result.message !== "ok") {
      return false;
    }
    observed.add(result.name);
  }
  return observed.size === EXPECTED_SMOKE_STATUSES.size;
}
