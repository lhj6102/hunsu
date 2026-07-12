#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const expectedManagers = Object.freeze({
  windows: "Task Scheduler",
  macos: "LaunchAgent",
  linux: "systemd --user"
});

export function validateProductionEvidence(input) {
  const version = exactVersion(input.npmVersion);
  const integrity = requiredMatch(input.npmIntegrity, /^sha512-[A-Za-z0-9+/]{86}==$/u, "npm integrity");
  const evidenceUrl = safeHttpsUrl(input.evidenceUrl, "retained evidence URL");
  const provenanceUrl = safeHttpsUrl(input.npmProvenanceUrl, "npm provenance URL");
  const hunsuAppDeployment = safeHttpsUrl(input.hunsuAppDeployment, "hunsu.app deployment");
  const codexVersion = safeText(input.codexVersion, "Codex version");
  const relayEnvironment = requiredMatch(safeText(input.relayEnvironment, "Relay environment"), /^[A-Za-z0-9][A-Za-z0-9._-]{1,127}$/u, "Relay environment");
  const workspaceFixtureId = requiredMatch(safeText(input.workspaceFixtureId, "Workspace fixture ID"), /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/u, "Workspace fixture ID");
  const platforms = platformEvidence(input.platformEvidence);
  return {
    schema: "hunsu.bridge.production-evidence.v1",
    npm: { version, integrity, provenanceUrl },
    evidenceUrl,
    hunsuAppDeployment,
    codexVersion,
    relayEnvironment,
    workspaceFixtureId,
    platforms
  };
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
  ensure(!secretLike(raw), `${label} contains credential-like material.`);
  return url.toString();
}

function safeText(value, label) {
  const result = requiredString(value, label);
  ensure(result.length <= 200, `${label} is too long.`);
  ensure(!/[\u0000-\u001f\u007f]/u.test(result), `${label} contains control characters.`);
  ensure(!secretLike(result), `${label} contains credential-like material.`);
  ensure(!/(?:^|\s)(?:[A-Za-z]:\\|\/(?:home|Users|private|tmp)\/)/u.test(result), `${label} contains a private local path.`);
  return result;
}

function secretLike(value) {
  return /hunsu_(?:control|bridge_pair|relay)_[A-Za-z0-9_-]+|(?:access|refresh)[_-]?token|authorization\s*[:=]|x-amz-signature/iu.test(value);
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
    const value = validateProductionEvidence({
      npmVersion: process.env.HUNSU_EVIDENCE_NPM_VERSION,
      npmIntegrity: process.env.HUNSU_EVIDENCE_NPM_INTEGRITY,
      npmProvenanceUrl: process.env.HUNSU_EVIDENCE_NPM_PROVENANCE_URL,
      evidenceUrl: process.env.HUNSU_EVIDENCE_URL,
      hunsuAppDeployment: process.env.HUNSU_EVIDENCE_HUNSU_APP_DEPLOYMENT,
      codexVersion: process.env.HUNSU_EVIDENCE_CODEX_VERSION,
      relayEnvironment: process.env.HUNSU_EVIDENCE_RELAY_ENVIRONMENT,
      workspaceFixtureId: process.env.HUNSU_EVIDENCE_WORKSPACE_FIXTURE_ID,
      platformEvidence: process.env.HUNSU_EVIDENCE_PLATFORMS
    });
    process.stdout.write(`${JSON.stringify(value)}\n`);
  } catch (error) {
    process.stderr.write(`[production-evidence] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
