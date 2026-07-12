#!/usr/bin/env node
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const MAX_EVIDENCE_BYTES = 1024 * 1024;
const expectedManagers = Object.freeze({
  windows: "Task Scheduler",
  macos: "LaunchAgent",
  linux: "systemd --user"
});

export function validateProductionEvidence(input) {
  const version = exactVersion(input.npmVersion);
  const integrity = requiredMatch(input.npmIntegrity, /^sha512-[A-Za-z0-9+/]{86}==$/u, "npm integrity");
  const evidenceUrl = safeHttpsUrl(input.evidenceUrl, "retained evidence URL");
  const evidenceSha256 = requiredMatch(input.evidenceSha256, /^sha256:[a-f0-9]{64}$/u, "retained evidence digest");
  const hunsuAppDeployment = safeHttpsUrl(input.hunsuAppDeployment, "hunsu.app deployment");
  const codexVersion = safeText(input.codexVersion, "Codex version");
  const relayEnvironment = requiredMatch(safeText(input.relayEnvironment, "Relay environment"), /^[A-Za-z0-9][A-Za-z0-9._-]{1,127}$/u, "Relay environment");
  const workspaceFixtureId = requiredMatch(safeText(input.workspaceFixtureId, "Workspace fixture ID"), /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/u, "Workspace fixture ID");
  const platforms = platformEvidence(input.platformEvidence);
  return {
    schema: "hunsu.bridge.production-evidence.v1",
    npm: { version, integrity },
    evidence: { url: evidenceUrl, sha256: evidenceSha256 },
    hunsuAppDeployment,
    codexVersion,
    relayEnvironment,
    workspaceFixtureId,
    platforms
  };
}

export async function verifyRetainedProductionEvidence(input, options = {}) {
  const url = safeHttpsUrl(input.evidenceUrl, "retained evidence URL");
  const expectedDigest = requiredMatch(input.evidenceSha256, /^sha256:[a-f0-9]{64}$/u, "retained evidence digest");
  const fetchImpl = options.fetchImpl ?? fetch;
  let response;
  try {
    response = await fetchImpl(url, {
      headers: { Accept: "application/json, text/markdown, text/plain;q=0.9" },
      redirect: "error",
      signal: AbortSignal.timeout(options.timeoutMs ?? 15_000)
    });
  } catch (_error) {
    throw new Error("The retained production evidence could not be fetched without redirects.");
  }
  ensure(response?.ok === true, `The retained production evidence returned HTTP ${response?.status ?? "unknown"}.`);
  const contentLength = Number(response.headers?.get?.("content-length"));
  ensure(!Number.isFinite(contentLength) || contentLength <= MAX_EVIDENCE_BYTES, "The retained production evidence is too large.");
  const body = await readLimitedBody(response, MAX_EVIDENCE_BYTES);
  ensure(body.length > 0, "The retained production evidence is empty.");
  const actualDigest = `sha256:${createHash("sha256").update(body).digest("hex")}`;
  ensure(actualDigest === expectedDigest, "The retained production evidence digest does not match.");
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch (_error) {
    throw new Error("The retained production evidence must be UTF-8 text or JSON.");
  }
  ensure(!unsafeEvidenceText(text), "The retained production evidence contains a credential or private local path.");
  return { url, sha256: actualDigest, body };
}

async function readLimitedBody(response, limit) {
  if (!response.body?.getReader) {
    const body = Buffer.from(await response.arrayBuffer());
    ensure(body.length <= limit, "The retained production evidence is too large.");
    return body;
  }
  const chunks = [];
  let length = 0;
  const reader = response.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = Buffer.from(value);
    length += chunk.length;
    ensure(length <= limit, "The retained production evidence is too large.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, length);
}

function platformEvidence(raw) {
  let value;
  try {
    value = JSON.parse(requiredString(raw, "platform evidence"));
  } catch (_error) {
    throw new Error("Platform evidence must be one JSON object.");
  }
  ensure(value && typeof value === "object" && !Array.isArray(value), "Platform evidence must be one JSON object.");
  ensure(Object.keys(value).sort().join(",") === "linux,macos,windows", "Platform evidence must contain exactly windows, macos, and linux.");
  const result = {};
  for (const [platform, manager] of Object.entries(expectedManagers)) {
    const entry = value[platform];
    ensure(entry && typeof entry === "object" && !Array.isArray(entry), `Platform evidence for ${platform} is missing.`);
    ensure(Object.keys(entry).sort().join(",") === "node,os,serviceManager", `${platform} evidence must contain only os, node, and serviceManager.`);
    const serviceManager = safeText(entry.serviceManager, `${platform} service manager`);
    ensure(serviceManager === manager, `${platform} must use ${manager}.`);
    result[platform] = {
      os: safeText(entry.os, `${platform} OS`),
      node: requiredMatch(entry.node, /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u, `${platform} Node version`),
      serviceManager
    };
  }
  return result;
}

function safeHttpsUrl(value, label) {
  const raw = requiredString(value, label);
  let url;
  try {
    url = new URL(raw);
  } catch (_error) {
    throw new Error(`${label} is invalid.`);
  }
  ensure(url.protocol === "https:", `${label} must use HTTPS.`);
  ensure(!url.username && !url.password && !url.search && !url.hash, `${label} cannot contain userinfo, query, or fragment data.`);
  ensure(!isLocalHostname(url.hostname), `${label} cannot target a local or private host.`);
  ensure(!secretLike(raw), `${label} contains credential-like material.`);
  return url.toString();
}

function isLocalHostname(hostname) {
  const value = hostname.toLowerCase();
  if (value === "localhost" || value.endsWith(".localhost") || value.endsWith(".local") || value.endsWith(".internal")) return true;
  if (isIP(value) === 4) {
    const [first, second] = value.split(".").map(Number);
    return first === 0 || first === 10 || first === 127 || first >= 224
      || (first === 169 && second === 254)
      || (first === 172 && second >= 16 && second <= 31)
      || (first === 192 && second === 168);
  }
  if (isIP(value) === 6) {
    return value === "::1" || value === "::" || /^f[cd][0-9a-f]:/u.test(value) || /^fe[89ab][0-9a-f]:/u.test(value);
  }
  return false;
}

function safeText(value, label) {
  const result = requiredString(value, label);
  ensure(result.length <= 200, `${label} is too long.`);
  ensure(!/[\u0000-\u001f\u007f]/u.test(result), `${label} contains control characters.`);
  ensure(!secretLike(result), `${label} contains credential-like material.`);
  ensure(!privatePathLike(result), `${label} contains a private local path.`);
  return result;
}

function unsafeEvidenceText(value) {
  return secretLike(value) || privatePathLike(value);
}

function secretLike(value) {
  return /hunsu_(?:control|bridge_pair|pairing|relay)_[A-Za-z0-9_-]+|(?:access|refresh)[_-]?token|authorization\s*[:=]|x-amz-signature|\bbearer\s+[A-Za-z0-9._~+/=-]+|\bsk-[A-Za-z0-9_-]{16,}/iu.test(value);
}

function privatePathLike(value) {
  return /(?:^|[\s"'`(])(?:[A-Za-z]:\\(?:Users|Documents and Settings)\\|\\\\[^\\\s]+\\[^\\\s]+\\|\/(?:home|Users|private|tmp)\/)/u.test(value);
}

function exactVersion(value) {
  return requiredMatch(value, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u, "npm version");
}

function requiredMatch(value, pattern, label) {
  const result = requiredString(value, label);
  ensure(pattern.test(result), `${label} has an invalid format.`);
  return result;
}

function requiredString(value, label) {
  ensure(typeof value === "string" && value.trim(), `${label} is required.`);
  return value.trim();
}

function ensure(condition, message) {
  if (!condition) throw new Error(message);
}

if (resolve(process.argv[1] ?? "") === scriptPath) {
  try {
    const input = {
      npmVersion: process.env.HUNSU_EVIDENCE_NPM_VERSION,
      npmIntegrity: process.env.HUNSU_EVIDENCE_NPM_INTEGRITY,
      evidenceUrl: process.env.HUNSU_EVIDENCE_URL,
      evidenceSha256: process.env.HUNSU_EVIDENCE_SHA256,
      hunsuAppDeployment: process.env.HUNSU_EVIDENCE_HUNSU_APP_DEPLOYMENT,
      codexVersion: process.env.HUNSU_EVIDENCE_CODEX_VERSION,
      relayEnvironment: process.env.HUNSU_EVIDENCE_RELAY_ENVIRONMENT,
      workspaceFixtureId: process.env.HUNSU_EVIDENCE_WORKSPACE_FIXTURE_ID,
      platformEvidence: process.env.HUNSU_EVIDENCE_PLATFORMS
    };
    const value = validateProductionEvidence(input);
    const retained = await verifyRetainedProductionEvidence(input);
    if (process.env.HUNSU_EVIDENCE_COPY_PATH) {
      await writeFile(process.env.HUNSU_EVIDENCE_COPY_PATH, retained.body, { mode: 0o600 });
    }
    process.stdout.write(`${JSON.stringify(value)}\n`);
  } catch (error) {
    process.stderr.write(`[production-evidence] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
