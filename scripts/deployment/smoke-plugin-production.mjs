import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseWebRuntimeConfig } from "./write-web-runtime-config.mjs";

const ORIGIN = "https://plugin.hunsu.app";
const MCP_URL = `${ORIGIN}/mcp`;
const METADATA_URL = `${ORIGIN}/.well-known/oauth-protected-resource`;
const SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

class SmokeError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function main() {
const args = parseArgs(process.argv.slice(2));
const discover = args.has("--discover-source-sha");
const suppliedSha = args.get("--source-sha");
const attempts = positiveInteger(args.get("--attempts") ?? "12", "--attempts");
const retryDelayMs = nonNegativeInteger(args.get("--retry-delay-ms") ?? "10000", "--retry-delay-ms");
const output = args.get("--output");

if (discover === Boolean(suppliedSha)) {
  throw new Error("Provide exactly one of --source-sha <sha> or --discover-source-sha.");
}

let expectedSha = suppliedSha ? normalizeSha(suppliedSha) : undefined;
let report;
for (let attempt = 1; attempt <= attempts; attempt += 1) {
  report = await runSuite(expectedSha);
  if (discover && report.webRuntimeSourceSha) expectedSha = report.webRuntimeSourceSha;
  report.attempt = attempt;
  report.attempts = attempts;
  if (report.failed === 0 || attempt === attempts) break;
  console.error(`Production smoke attempt ${attempt}/${attempts} failed; retrying in ${retryDelayMs}ms.`);
  await new Promise(resolvePromise => setTimeout(resolvePromise, retryDelayMs));
}

if (output) {
  await mkdir(dirname(resolve(output)), { recursive: true });
  await writeFile(resolve(output), `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o644 });
}

for (const result of report.results) {
  console.log(`${result.passed ? "PASS" : "FAIL"} ${result.name}${result.status === null ? "" : ` (${result.status})`}: ${result.message}`);
}
console.log(`Production smoke tests: ${report.passed}/${report.results.length} passed.`);
if (report.failed > 0) process.exitCode = 1;
}

async function runSuite(sourceSha) {
  let observedRuntimeSha;
  const results = [];
  await Promise.all([check("web-root", async () => {
    const response = await request("/", { method: "GET" });
    assertStatus(response, 200);
    assertHtml(response, await readText(response, 1_000_000));
    return response.status;
  }, results), check("web-spa-projects", async () => {
    const response = await request("/projects", { method: "GET" });
    assertStatus(response, 200);
    assertHtml(response, await readText(response, 1_000_000));
    return response.status;
  }, results), check("web-runtime-config", async () => {
    const response = await request("/hunsu-runtime-config.js", { method: "GET" });
    assertStatus(response, 200);
    let runtime;
    try {
      runtime = parseWebRuntimeConfig(await readText(response, 32_768));
    } catch {
      fail("Runtime config does not match the exact production overlay contract.", response.status);
    }
    observedRuntimeSha = runtime.sourceSha;
    if (sourceSha && runtime.sourceSha !== sourceSha) fail("Runtime config sourceSha does not match the deployed main SHA.");
    return response.status;
  }, results), check("api-session", async () => {
    const response = await request("/api/session", { method: "GET" });
    assertStatus(response, 200);
    const body = await readJson(response);
    if (!isObject(body) || body.authenticated !== false) fail("Anonymous API session did not report authenticated=false.");
    return response.status;
  }, results), check("oauth-protected-resource", async () => {
    const response = await request("/.well-known/oauth-protected-resource", { method: "GET" });
    assertStatus(response, 200);
    const body = await readJson(response);
    if (!isObject(body) || body.resource !== MCP_URL) fail("Protected-resource metadata has the wrong resource.");
    if (!Array.isArray(body.authorization_servers) || !body.authorization_servers.includes(ORIGIN)) {
      fail("Protected-resource metadata has the wrong authorization server.");
    }
    return response.status;
  }, results), check("oauth-authorization-server", async () => {
    const response = await request("/.well-known/oauth-authorization-server", { method: "GET" });
    assertStatus(response, 200);
    const body = await readJson(response);
    if (!isObject(body) || body.issuer !== ORIGIN) fail("Authorization-server metadata has the wrong issuer.");
    if (body.authorization_endpoint !== `${ORIGIN}/oauth/authorize` || body.token_endpoint !== `${ORIGIN}/oauth/token`) {
      fail("Authorization-server metadata endpoints are not same-origin production endpoints.");
    }
    return response.status;
  }, results), check("mcp-authentication-challenge", async () => {
    const response = await request("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}"
    });
    assertStatus(response, 401);
    const challenge = response.headers.get("www-authenticate") ?? "";
    if (!/^Bearer\s/u.test(challenge) || !challenge.includes(`resource_metadata="${METADATA_URL}"`)) {
      fail("MCP authentication challenge does not point to production protected-resource metadata.");
    }
    return response.status;
  }, results), check("github-oauth-redirect", async () => {
    const response = await request("/api/auth/github?return_to=/", { method: "GET" });
    assertStatus(response, 302);
    const location = response.headers.get("location");
    if (!location) fail("GitHub OAuth response is missing Location.");
    let url;
    try {
      url = new URL(location);
    } catch {
      fail("GitHub OAuth Location is not a valid URL.", response.status);
    }
    if (url.origin !== "https://github.com" || url.pathname !== "/login/oauth/authorize") {
      fail("GitHub OAuth did not redirect to GitHub's authorization endpoint.");
    }
    if (url.searchParams.get("redirect_uri") !== `${ORIGIN}/api/auth/github/callback`) {
      fail("GitHub OAuth redirect_uri does not point to plugin.hunsu.app.");
    }
    const challenge = url.searchParams.get("code_challenge") ?? "";
    const state = url.searchParams.get("state") ?? "";
    if (!url.searchParams.get("client_id")
      || url.searchParams.get("code_challenge_method") !== "S256"
      || !/^[A-Za-z0-9_-]{43}$/u.test(challenge)
      || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/u.test(state)) {
      fail("GitHub OAuth redirect is missing its client, state, or PKCE contract.");
    }
    return response.status;
  }, results)]);
  return {
    schema: "hunsu.plugin-production-smoke.v1",
    sourceSha: sourceSha ?? observedRuntimeSha ?? null,
    domain: "plugin.hunsu.app",
    webRuntimeSourceSha: observedRuntimeSha ?? null,
    passed: results.filter(result => result.passed).length,
    failed: results.filter(result => !result.passed).length,
    completedAt: new Date().toISOString(),
    results
  };
}

async function check(name, operation, results) {
  const started = performance.now();
  try {
    const status = await operation();
    results.push({ name, passed: true, status, durationMs: Math.round(performance.now() - started), message: "ok" });
  } catch (error) {
    const message = error instanceof SmokeError ? error.message : "Smoke assertion failed.";
    results.push({
      name,
      passed: false,
      status: error instanceof SmokeError ? error.status : null,
      durationMs: Math.round(performance.now() - started),
      message
    });
  }
}

async function request(path, init) {
  try {
    return await fetch(`${ORIGIN}${path}`, {
      ...init,
      redirect: "manual",
      signal: AbortSignal.timeout(5_000),
      headers: {
        accept: "*/*",
        "cache-control": "no-cache",
        "user-agent": "hunsu-plugin-production-smoke/1",
        ...init.headers
      }
    });
  } catch {
    throw new SmokeError("Production request failed.", null);
  }
}

function assertStatus(response, expected) {
  if (response.status !== expected) throw new SmokeError(`Expected HTTP ${expected}.`, response.status);
}

function assertHtml(response, source) {
  if (!(response.headers.get("content-type") ?? "").toLowerCase().includes("text/html")) fail("Web response is not HTML.", response.status);
  if (!/<title>\s*Hunsu Projects\s*<\/title>/iu.test(source) || !/<div\s+id=["']root["']/iu.test(source)) {
    fail("Web response is not the Hunsu SPA shell.", response.status);
  }
}

async function readJson(response) {
  if (!(response.headers.get("content-type") ?? "").toLowerCase().includes("application/json")) {
    fail("Expected an application/json response.", response.status);
  }
  try {
    return JSON.parse(await readText(response, 1_000_000));
  } catch (error) {
    if (error instanceof SmokeError) throw error;
    fail("Response body is not valid JSON.", response.status);
  }
}

async function readText(response, maximumBytes) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let output = "";
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > maximumBytes) {
      await reader.cancel();
      fail("Response body exceeded the smoke-test size limit.", response.status);
    }
    output += decoder.decode(chunk.value, { stream: true });
  }
  return output + decoder.decode();
}

function parseArgs(values) {
  const flags = new Set(["--discover-source-sha"]);
  const valued = new Set(["--source-sha", "--attempts", "--retry-delay-ms", "--output"]);
  const result = new Map();
  for (let index = 0; index < values.length; index += 1) {
    const key = values[index];
    if (flags.has(key)) {
      if (result.has(key)) throw new Error(`Duplicate argument: ${key}.`);
      result.set(key, "true");
    } else if (valued.has(key) && values[index + 1] !== undefined) {
      if (result.has(key)) throw new Error(`Duplicate argument: ${key}.`);
      result.set(key, values[index + 1]);
      index += 1;
    } else {
      throw new Error(`Unknown or incomplete argument: ${key ?? "<missing>"}`);
    }
  }
  return result;
}

function normalizeSha(value) {
  const sourceSha = value.trim().toLowerCase();
  if (!SHA_PATTERN.test(sourceSha)) throw new Error("--source-sha must be a complete Git commit SHA.");
  return sourceSha;
}

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer.`);
  return parsed;
}

function nonNegativeInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer.`);
  return parsed;
}

function fail(message, status = null) {
  throw new SmokeError(message, status);
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : "Production smoke test setup failed.");
  process.exitCode = 1;
});
