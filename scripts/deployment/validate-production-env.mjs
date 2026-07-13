import { execFileSync } from "node:child_process";

const ENVIRONMENT = "hunsu-production";
const MAIN_REF = "refs/heads/main";
const SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

const entries = [
  variable("CLOUDFLARE_ACCOUNT_ID", value => /^[0-9a-f]{32}$/iu.test(value), "a 32-character Cloudflare account ID"),
  secret("CLOUDFLARE_API_TOKEN"),
  variable("HUNSU_GITHUB_APP_ID", value => {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 && String(parsed) === value;
  }, "a positive GitHub App numeric ID"),
  variable("HUNSU_GITHUB_CLIENT_ID"),
  variable("HUNSU_GITHUB_APP_SLUG", value => /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value), "a lower-case GitHub App slug"),
  secret("HUNSU_GITHUB_CLIENT_SECRET"),
  secret("HUNSU_GITHUB_PRIVATE_KEY", isPemPrivateKey, "a PEM encoded private key"),
  secret("HUNSU_GITHUB_WEBHOOK_SECRET"),
  secret("HUNSU_SESSION_SECRET", value => value.length >= 32, "at least 32 characters")
];

if (process.argv.length !== 2) {
  console.error("Usage: node validate-production-env.mjs");
  process.exitCode = 1;
} else {
const missing = [];
const invalid = [];
const configuredEnvironment = process.env.HUNSU_DEPLOYMENT_ENVIRONMENT?.trim() ?? "";
const sourceSha = (process.env.GITHUB_SHA ?? "").trim().toLowerCase();
const sourceRef = process.env.GITHUB_REF?.trim() ?? "";
const checkoutSha = currentCheckoutSha();
const remoteMainSha = currentRemoteMainSha();

if (configuredEnvironment !== ENVIRONMENT) {
  invalid.push(`GitHub environment (expected ${ENVIRONMENT})`);
}
if (!SHA_PATTERN.test(sourceSha)) {
  invalid.push("Current main SHA (expected a complete Git commit SHA)");
}
if (sourceRef !== MAIN_REF) {
  invalid.push(`GitHub ref (expected ${MAIN_REF})`);
}
if (!checkoutSha || checkoutSha !== sourceSha) {
  invalid.push("Checked-out commit (expected the exact current main SHA)");
}
if (!remoteMainSha || remoteMainSha !== sourceSha) {
  invalid.push("Remote main branch head (expected the exact current main SHA)");
}

for (const entry of entries) {
  const raw = process.env[entry.name];
  const value = raw?.trim() ?? "";
  if (value === "") {
    missing.push(`${ENVIRONMENT} ${entry.kind} ${entry.name}`);
  } else if (!entry.validate(value, raw ?? "")) {
    invalid.push(`${ENVIRONMENT} ${entry.kind} ${entry.name} (expected ${entry.expectation})`);
  }
}

if (missing.length > 0 || invalid.length > 0) {
  const lines = ["MANUAL_EXTERNAL_CONFIGURATION_REQUIRED", ""];
  if (missing.length > 0) {
    lines.push("Missing:", ...missing.map(item => `- ${item}`), "");
  }
  if (invalid.length > 0) {
    lines.push("Invalid:", ...invalid.map(item => `- ${item}`), "");
  }
  lines.push(
    "No Cloudflare mutation was attempted.",
    `Current main SHA: ${SHA_PATTERN.test(sourceSha) ? sourceSha : "<unavailable>"}`,
    "Safe to rerun after configuration: yes"
  );
  console.error(lines.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`${ENVIRONMENT} environment contract validated for main SHA ${sourceSha}.`);
}
}

function variable(name, validate = nonEmpty, expectation = "a non-empty value") {
  return { kind: "variable", name, validate, expectation };
}

function secret(name, validate = nonEmpty, expectation = "a non-empty value") {
  return { kind: "secret", name, validate, expectation };
}

function nonEmpty(value) {
  return value.length > 0;
}

function isPemPrivateKey(_value, raw) {
  const normalized = raw
    .trim()
    .replace(/\\r\\n/gu, "\n")
    .replace(/\\n/gu, "\n")
    .replace(/\r\n?/gu, "\n");
  return /^-----BEGIN ((?:RSA |EC )?PRIVATE KEY)-----\n[\s\S]+\n-----END \1-----$/u.test(normalized);
}

function currentCheckoutSha() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim().toLowerCase();
  } catch {
    return undefined;
  }
}

function currentRemoteMainSha() {
  try {
    return execFileSync("git", ["rev-parse", "refs/remotes/origin/main"], { encoding: "utf8" })
      .trim()
      .toLowerCase();
  } catch {
    return undefined;
  }
}
