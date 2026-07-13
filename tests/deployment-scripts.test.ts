import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test, { type TestContext } from "node:test";
import { findRetiredOriginReferences } from "../scripts/deployment/retired-origin-scan.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const smokeScript = resolve(repoRoot, "scripts/deployment/smoke-plugin-production.mjs");
const evidenceScript = resolve(repoRoot, "scripts/deployment/write-deployment-evidence.mjs");
const rollbackScript = resolve(repoRoot, "scripts/deployment/select-rollback-target.mjs");
const sourceSha = "0123456789abcdef0123456789abcdef01234567";
const workerVersionId = "11111111-2222-4333-8444-555555555555";
const deploymentId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const smokeChecks = [
  ["web-root", 200],
  ["web-spa-projects", 200],
  ["web-runtime-config", 200],
  ["api-session", 200],
  ["oauth-protected-resource", 200],
  ["oauth-authorization-server", 200],
  ["mcp-authentication-challenge", 401],
  ["github-oauth-redirect", 302]
] as const;

test("retired production origin scan covers workflows and deployment scripts", async t => {
  const directory = await temporaryDirectory(t);
  const roots = [
    "apps",
    "packages",
    "plugins",
    ".github/workflows",
    "scripts/deployment"
  ];
  await Promise.all(roots.map(root => mkdir(join(directory, root), { recursive: true })));
  await Promise.all([
    writeFile(join(directory, "wrangler.jsonc"), "{}\n", "utf8"),
    writeFile(join(directory, "apps/api.ts"), "export const origin = \"https://api.hunsu.app\";\n", "utf8"),
    writeFile(join(directory, ".github/workflows/deploy.yml"), "run: curl https://api.hunsu.app/health\n", "utf8"),
    writeFile(join(directory, ".github/workflows/reusable.yaml"), "env:\n  API_ORIGIN: https://api.hunsu.app\n", "utf8"),
    writeFile(join(directory, "scripts/deployment/deploy.mjs"), "export const origin = \"https://api.hunsu.app\";\n", "utf8"),
    writeFile(join(directory, "scripts/deployment/sentinel.mjs"), "export const retired = [\"api\", \"hunsu\", \"app\"].join(\".\");\n", "utf8"),
    writeFile(join(directory, "packages/ignored.txt"), "https://api.hunsu.app\n", "utf8"),
    writeFile(join(directory, "plugins/config.json"), "{}\n", "utf8")
  ]);

  assert.deepEqual(await findRetiredOriginReferences(directory), [
    ".github/workflows/deploy.yml",
    ".github/workflows/reusable.yaml",
    "apps/api.ts",
    "scripts/deployment/deploy.mjs"
  ]);
});

test("production smoke writes structured failure evidence instead of crashing", async t => {
  const directory = await temporaryDirectory(t);
  const mock = await writeFetchMock(directory);
  const output = join(directory, "smoke-failure.json");

  const result = await runScript(smokeScript, [
    "--source-sha", sourceSha,
    "--attempts", "1",
    "--retry-delay-ms", "0",
    "--output", output
  ], { importModule: mock, environment: { HUNSU_SMOKE_FIXTURE: "root-failure", HUNSU_SMOKE_SOURCE_SHA: sourceSha } });

  assert.equal(result.code, 1);
  assert.equal(result.signal, null);
  assert.doesNotMatch(result.stderr, /before initialization|ReferenceError|\n\s+at\s|node:internal|file:\/\//u);
  const report = await readJson(output);
  assert.equal(report.schema, "hunsu.plugin-production-smoke.v1");
  assert.equal(report.sourceSha, sourceSha);
  assert.equal(report.passed, 7);
  assert.equal(report.failed, 1);
  assert.equal(report.attempt, 1);
  assert.equal(report.attempts, 1);
  const webRoot = report.results.find((entry: { name?: unknown }) => entry.name === "web-root");
  assert.equal(Number.isInteger(webRoot.durationMs) && webRoot.durationMs >= 0, true);
  assert.deepEqual({ ...webRoot, durationMs: undefined }, {
    name: "web-root",
    passed: false,
    status: 503,
    durationMs: undefined,
    message: "Expected HTTP 200."
  });
  assert.match(result.stdout, /FAIL web-root \(503\): Expected HTTP 200\./u);
});

test("production smoke rejects a GitHub redirect without state and PKCE", async t => {
  const directory = await temporaryDirectory(t);
  const mock = await writeFetchMock(directory);
  const output = join(directory, "smoke-missing-oauth-contract.json");

  const result = await runScript(smokeScript, [
    "--source-sha", sourceSha,
    "--attempts", "1",
    "--retry-delay-ms", "0",
    "--output", output
  ], { importModule: mock, environment: { HUNSU_SMOKE_FIXTURE: "missing-oauth-contract", HUNSU_SMOKE_SOURCE_SHA: sourceSha } });

  assert.equal(result.code, 1);
  assert.doesNotMatch(result.stderr, /\n\s+at\s|node:internal|file:\/\//u);
  const report = await readJson(output);
  assert.equal(report.passed, 7);
  assert.equal(report.failed, 1);
  const oauth = report.results.find((entry: { name?: unknown }) => entry.name === "github-oauth-redirect");
  assert.equal(Number.isInteger(oauth.durationMs) && oauth.durationMs >= 0, true);
  assert.deepEqual({ ...oauth, durationMs: undefined }, {
    name: "github-oauth-redirect",
    passed: false,
    status: null,
    durationMs: undefined,
    message: "GitHub OAuth redirect is missing its client, state, or PKCE contract."
  });
});

test("production smoke passes all eight checks with isolated HTTP fixtures", async t => {
  const directory = await temporaryDirectory(t);
  const mock = await writeFetchMock(directory);
  const output = join(directory, "smoke-success.json");

  const result = await runScript(smokeScript, [
    "--source-sha", sourceSha,
    "--attempts", "1",
    "--retry-delay-ms", "0",
    "--output", output
  ], { importModule: mock, environment: { HUNSU_SMOKE_FIXTURE: "success", HUNSU_SMOKE_SOURCE_SHA: sourceSha } });

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.signal, null);
  const report = await readJson(output);
  assert.equal(report.schema, "hunsu.plugin-production-smoke.v1");
  assert.equal(report.domain, "plugin.hunsu.app");
  assert.equal(report.sourceSha, sourceSha);
  assert.equal(report.webRuntimeSourceSha, sourceSha);
  assert.equal(report.passed, 8);
  assert.equal(report.failed, 0);
  assert.deepEqual(
    new Map(report.results.map((entry: { name: string; status: number }) => [entry.name, entry.status])),
    new Map(smokeChecks)
  );
  assert.match(result.stdout, /Production smoke tests: 8\/8 passed\./u);
});

test("deployment evidence rejects contradictory smoke data and writes the canonical fixture", async t => {
  await t.test("rejects a duplicate smoke check", async subtest => {
    const directory = await temporaryDirectory(subtest);
    const smoke = canonicalSmoke();
    smoke.results[7] = { ...smoke.results[0] };
    const result = await runEvidence(directory, smoke);

    assertCleanFailure(result, "Production smoke result has an invalid shape.");
    await assertMissing(join(directory, "evidence.json"));
  });

  await t.test("rejects impossible pass and failure counters", async subtest => {
    const directory = await temporaryDirectory(subtest);
    const smoke = canonicalSmoke();
    smoke.passed = 9;
    smoke.failed = -1;
    const result = await runEvidence(directory, smoke);

    assertCleanFailure(result, "Production smoke evidence is incomplete or does not match the deployed main SHA.");
    await assertMissing(join(directory, "evidence.json"));
  });

  await t.test("accepts and normalizes the canonical smoke fixture", async subtest => {
    const directory = await temporaryDirectory(subtest);
    const result = await runEvidence(directory, canonicalSmoke());

    assert.equal(result.code, 0, result.stderr);
    const evidence = await readJson(join(directory, "evidence.json"));
    assert.deepEqual(evidence, {
      sourceSha,
      workerName: "hunsu-plugin-production",
      domain: "plugin.hunsu.app",
      deploymentId,
      workerVersionId,
      deployedAt: "2026-07-13T00:00:00.000Z",
      wranglerVersion: "4.110.0",
      smokeResults: canonicalSmoke().results,
      pluginEndpoint: "https://plugin.hunsu.app/mcp",
      webRuntimeSourceSha: sourceSha
    });
  });
});

test("rollback selection requires complete smoke and exactly one fully active version", async t => {
  await t.test("rejects incomplete smoke evidence", async subtest => {
    const directory = await temporaryDirectory(subtest);
    const smoke = canonicalSmoke();
    smoke.results.pop();
    smoke.passed = 7;
    const result = await runRollback(directory, canonicalDeployment(), smoke);

    assertCleanFailure(result, "No known-good rollback target: Current production did not pass the full baseline smoke suite.");
    await assertMissing(join(directory, "rollback.json"));
  });

  await t.test("rejects a deployment containing multiple versions", async subtest => {
    const directory = await temporaryDirectory(subtest);
    const deployment = canonicalDeployment();
    deployment.versions.push({ version_id: "99999999-8888-4777-8666-555555555555", percentage: 0 });
    const result = await runRollback(directory, deployment, canonicalSmoke());

    assertCleanFailure(result, "No known-good rollback target: Current deployment is not a single 100% stable Worker version.");
    await assertMissing(join(directory, "rollback.json"));
  });

  await t.test("accepts one version at 100 percent", async subtest => {
    const directory = await temporaryDirectory(subtest);
    const result = await runRollback(directory, canonicalDeployment(), canonicalSmoke());

    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(await readJson(join(directory, "rollback.json")), {
      deploymentId,
      workerVersionId,
      sourceSha
    });
  });
});

test("delivery script argument errors are concise and stack-free", async t => {
  const directory = await temporaryDirectory(t);
  const mock = await writeFetchMock(directory);
  const cases = [
    {
      name: "smoke duplicate",
      script: smokeScript,
      args: ["--source-sha", sourceSha, "--source-sha", sourceSha],
      importModule: mock,
      message: "Duplicate argument: --source-sha."
    },
    {
      name: "smoke unknown",
      script: smokeScript,
      args: ["--unknown", "value"],
      importModule: mock,
      message: "Unknown or incomplete argument: --unknown"
    },
    {
      name: "evidence duplicate",
      script: evidenceScript,
      args: ["--source-sha", sourceSha, "--source-sha", sourceSha],
      message: "Duplicate argument: --source-sha."
    },
    {
      name: "evidence unknown",
      script: evidenceScript,
      args: ["--unknown", "value"],
      message: "Unknown or incomplete argument: --unknown"
    },
    {
      name: "rollback duplicate",
      script: rollbackScript,
      args: ["--deployment", "one.json", "--deployment", "two.json"],
      message: "No known-good rollback target: Duplicate argument: --deployment."
    },
    {
      name: "rollback unknown",
      script: rollbackScript,
      args: ["--unknown", "value"],
      message: "No known-good rollback target: Unknown or incomplete argument: --unknown"
    }
  ];

  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      const result = await runScript(fixture.script, fixture.args, {
        importModule: fixture.importModule,
        environment: { HUNSU_SMOKE_FIXTURE: "success", HUNSU_SMOKE_SOURCE_SHA: sourceSha }
      });
      assertCleanFailure(result, fixture.message);
    });
  }
});

async function runEvidence(directory: string, smoke: ReturnType<typeof canonicalSmoke>): Promise<CommandResult> {
  const wranglerOutput = join(directory, "wrangler.ndjson");
  const deployments = join(directory, "deployments.json");
  const smokeResults = join(directory, "smoke.json");
  const wranglerVersion = join(directory, "wrangler-version.txt");
  await Promise.all([
    writeFile(wranglerOutput, `${JSON.stringify({
      type: "deploy",
      version: 1,
      worker_name: "hunsu-plugin-production",
      version_id: workerVersionId
    })}\n`, "utf8"),
    writeJson(deployments, [canonicalDeployment()]),
    writeJson(smokeResults, smoke),
    writeFile(wranglerVersion, "4.110.0\n", "utf8")
  ]);
  return runScript(evidenceScript, [
    "--source-sha", sourceSha,
    "--wrangler-output", wranglerOutput,
    "--deployments", deployments,
    "--smoke-results", smokeResults,
    "--wrangler-version", wranglerVersion,
    "--output", join(directory, "evidence.json")
  ]);
}

async function runRollback(
  directory: string,
  deployment: ReturnType<typeof canonicalDeployment>,
  smoke: ReturnType<typeof canonicalSmoke>
): Promise<CommandResult> {
  const deploymentPath = join(directory, "deployment.json");
  const smokePath = join(directory, "smoke.json");
  await Promise.all([writeJson(deploymentPath, deployment), writeJson(smokePath, smoke)]);
  return runScript(rollbackScript, [
    "--deployment", deploymentPath,
    "--smoke-results", smokePath,
    "--output", join(directory, "rollback.json")
  ]);
}

function canonicalSmoke() {
  return {
    schema: "hunsu.plugin-production-smoke.v1",
    sourceSha,
    domain: "plugin.hunsu.app",
    webRuntimeSourceSha: sourceSha,
    passed: 8,
    failed: 0,
    completedAt: "2026-07-13T00:00:01.000Z",
    results: smokeChecks.map(([name, status], index) => ({
      name,
      passed: true,
      status,
      durationMs: index + 1,
      message: "ok"
    }))
  };
}

function canonicalDeployment() {
  return {
    id: deploymentId,
    created_on: "2026-07-13T00:00:00.000Z",
    versions: [{ version_id: workerVersionId, percentage: 100 }]
  };
}

async function writeFetchMock(directory: string): Promise<string> {
  const path = join(directory, "mock-production-fetch.mjs");
  await writeFile(path, `
const origin = "https://plugin.hunsu.app";
const sourceSha = process.env.HUNSU_SMOKE_SOURCE_SHA;
const fixture = process.env.HUNSU_SMOKE_FIXTURE;
const html = "<!doctype html><html><head><title>Hunsu Projects</title></head><body><div id=\\"root\\"></div></body></html>";
const runtime = [
  "window.__HUNSU_WEB_RUNTIME_CONFIG__ = Object.freeze({",
  "  schema: \\"hunsu.web-runtime-config.v3\\",",
  "  target: \\"production\\",",
  "  sourceSha: \\"" + sourceSha + "\\",",
  "  apiBaseUrl: \\"\\"",
  "});",
  ""
].join("\\n");

globalThis.fetch = async input => {
  const url = new URL(typeof input === "string" ? input : input.url);
  if (url.origin !== origin) throw new Error("Unexpected smoke origin: " + url.origin);
  switch (url.pathname) {
    case "/":
      return new Response(html, {
        status: fixture === "root-failure" ? 503 : 200,
        headers: { "content-type": "text/html; charset=utf-8" }
      });
    case "/projects":
      return new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
    case "/hunsu-runtime-config.js":
      return new Response(runtime, { status: 200, headers: { "content-type": "application/javascript" } });
    case "/api/session":
      return Response.json({ authenticated: false });
    case "/.well-known/oauth-protected-resource":
      return Response.json({
        resource: origin + "/mcp",
        authorization_servers: [origin]
      });
    case "/.well-known/oauth-authorization-server":
      return Response.json({
        issuer: origin,
        authorization_endpoint: origin + "/oauth/authorize",
        token_endpoint: origin + "/oauth/token"
      });
    case "/mcp":
      return new Response(null, {
        status: 401,
        headers: { "www-authenticate": "Bearer resource_metadata=\\\"" + origin + "/.well-known/oauth-protected-resource\\\"" }
      });
    case "/api/auth/github": {
      const redirect = new URL("https://github.com/login/oauth/authorize");
      redirect.searchParams.set("client_id", "fixture-client");
      redirect.searchParams.set("redirect_uri", origin + "/api/auth/github/callback");
      if (fixture !== "missing-oauth-contract") {
        redirect.searchParams.set("code_challenge_method", "S256");
        redirect.searchParams.set("code_challenge", "c".repeat(43));
        redirect.searchParams.set("state", "fixture." + "s".repeat(43));
      }
      return new Response(null, { status: 302, headers: { location: redirect.href } });
    }
    default:
      throw new Error("Unexpected smoke path: " + url.pathname);
  }
};
`, "utf8");
  return path;
}

interface RunOptions {
  importModule?: string;
  environment?: {
    HUNSU_SMOKE_FIXTURE?: string;
    HUNSU_SMOKE_SOURCE_SHA?: string;
  };
}

interface CommandResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

async function runScript(script: string, args: string[], options: RunOptions = {}): Promise<CommandResult> {
  const nodeArgs = options.importModule
    ? ["--import", pathToFileURL(options.importModule).href, script, ...args]
    : [script, ...args];
  return new Promise((resolvePromise, reject) => {
    const environment: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      LANG: "C",
      LC_ALL: "C",
      TZ: "UTC",
      NO_COLOR: "1",
      HUNSU_PUBLIC_API_URL: "https://plugin.hunsu.app",
      HUNSU_WEB_URL: "https://plugin.hunsu.app",
      HUNSU_GITHUB_APP_ID: "__HUNSU_PRODUCTION_ENVIRONMENT__",
      HUNSU_GITHUB_CLIENT_ID: "__HUNSU_PRODUCTION_ENVIRONMENT__",
      HUNSU_GITHUB_APP_SLUG: "__HUNSU_PRODUCTION_ENVIRONMENT__",
      HUNSU_GITHUB_CLIENT_SECRET: "",
      HUNSU_GITHUB_PRIVATE_KEY: "",
      HUNSU_GITHUB_WEBHOOK_SECRET: "",
      HUNSU_SESSION_SECRET: "",
      ...options.environment
    };
    const child = spawn(process.execPath, nodeArgs, {
      cwd: repoRoot,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"]
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Timed out running ${script}.`));
    }, 10_000);
    child.once("error", error => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      resolvePromise({ code, signal, stdout, stderr });
    });
  });
}

function assertCleanFailure(result: CommandResult, message: string): void {
  assert.equal(result.code, 1);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr.trim(), message);
  assert.doesNotMatch(result.stderr, /\n\s+at\s|node:internal|file:\/\/|(?:Reference|Type)Error/u);
}

async function temporaryDirectory(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "hunsu-delivery-test-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(resolve(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readJson(path: string): Promise<any> {
  return JSON.parse(await readFile(path, "utf8"));
}

async function assertMissing(path: string): Promise<void> {
  await assert.rejects(access(path), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
}
