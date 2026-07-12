#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const PACKAGE_NAME = "@hunsu/bridge";
const REPOSITORY_URL = "https://github.com/lhj6102/hunsu";
const WORKFLOW_PATH = ".github/workflows/publish-bridge.yml";
const SLSA_PREDICATE = "https://slsa.dev/provenance/v1";
const GITHUB_ACTIONS_BUILD_TYPE = "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1";
const GITHUB_HOSTED_BUILDER = "https://github.com/actions/runner/github-hosted";
const PREVIEW_PUBLICATION_REF = "refs/heads/preview";

export function verifyBridgeNpmProvenanceAudit(input) {
  const version = exactVersion(input.version);
  const versionTag = requiredMatch(input.versionTag, /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u, "candidate tag");
  ensure(versionTag === `v${version}`, "The provenance candidate tag does not match the npm version.");
  const gitSha = requiredMatch(input.gitSha, /^[a-f0-9]{40}$/u, "candidate Git SHA");
  const expectedSha512 = integrityHex(input.integrity);
  const audit = requiredObject(input.audit, "npm signature audit");

  ensure(Array.isArray(audit.invalid) && audit.invalid.length === 0, "npm reported an invalid registry signature or attestation.");
  ensure(Array.isArray(audit.missing) && audit.missing.length === 0, "npm reported a missing registry signature or attestation.");
  ensure(Array.isArray(audit.verified), "npm did not return verified attestation records.");
  const candidates = audit.verified.filter(value => value?.name === PACKAGE_NAME && value?.version === version);
  ensure(candidates.length === 1, "npm did not verify exactly one attestation for the exact Bridge candidate.");
  const candidate = requiredObject(candidates[0], "verified Bridge attestation");
  ensure(candidate.registry === "https://registry.npmjs.org/", "The Bridge attestation came from an unexpected registry.");

  const provenanceUrl = registryAttestationUrl(candidate.attestations?.url, version);
  ensure(candidate.attestations?.provenance?.predicateType === SLSA_PREDICATE, "The registry did not advertise SLSA v1 provenance.");
  ensure(Array.isArray(candidate.attestationBundles), "npm did not include the verified attestation bundle.");
  const bundles = candidate.attestationBundles.filter(value => value?.predicateType === SLSA_PREDICATE);
  ensure(bundles.length === 1, "npm did not verify exactly one SLSA v1 provenance bundle.");
  const bundle = requiredObject(bundles[0]?.bundle, "SLSA provenance bundle");
  const envelope = requiredObject(bundle.dsseEnvelope, "SLSA DSSE envelope");
  ensure(envelope.payloadType === "application/vnd.in-toto+json", "The provenance used an unexpected DSSE payload type.");
  ensure(Array.isArray(envelope.signatures) && envelope.signatures.length > 0, "The provenance DSSE envelope was unsigned.");
  const tlogEntries = bundle.verificationMaterial?.tlogEntries;
  ensure(Array.isArray(tlogEntries) && tlogEntries.length > 0, "The provenance did not contain a transparency-log entry.");

  const statement = decodeStatement(envelope.payload);
  ensure(statement._type === "https://in-toto.io/Statement/v1", "The provenance used an unexpected in-toto statement type.");
  ensure(statement.predicateType === SLSA_PREDICATE, "The signed statement was not SLSA v1 provenance.");
  ensure(Array.isArray(statement.subject) && statement.subject.length === 1, "The provenance must identify exactly one npm package subject.");
  const subject = statement.subject[0];
  ensure(subject?.name === `pkg:npm/%40hunsu/bridge@${version}`, "The provenance subject did not identify the exact Bridge package.");
  ensure(subject?.digest?.sha512 === expectedSha512, "The signed provenance subject did not match the npm integrity.");

  const buildDefinition = requiredObject(statement.predicate?.buildDefinition, "SLSA build definition");
  ensure(buildDefinition.buildType === GITHUB_ACTIONS_BUILD_TYPE, "The candidate was not built by the GitHub Actions SLSA workflow build type.");
  const workflow = requiredObject(buildDefinition.externalParameters?.workflow, "SLSA workflow identity");
  ensure(workflow.repository === REPOSITORY_URL, "The provenance repository did not match Hunsu.");
  ensure(workflow.path === WORKFLOW_PATH, "The provenance workflow did not match publish-bridge.yml.");
  ensure(workflow.ref === PREVIEW_PUBLICATION_REF, "The provenance workflow ref did not match the protected preview branch.");
  ensure(buildDefinition.internalParameters?.github?.event_name === "push", "The candidate was not published by the protected preview push workflow.");

  ensure(Array.isArray(buildDefinition.resolvedDependencies), "The provenance omitted resolved source dependencies.");
  const expectedSourceUri = `git+${REPOSITORY_URL}@${PREVIEW_PUBLICATION_REF}`;
  const source = buildDefinition.resolvedDependencies.find(value => value?.uri === expectedSourceUri);
  ensure(source?.digest?.gitCommit === gitSha, "The signed provenance source commit did not match the candidate Git SHA.");
  ensure(statement.predicate?.runDetails?.builder?.id === GITHUB_HOSTED_BUILDER, "The candidate was not published from a GitHub-hosted runner.");
  const invocationId = requiredString(statement.predicate?.runDetails?.metadata?.invocationId, "SLSA invocation ID");
  ensure(
    /^https:\/\/github\.com\/lhj6102\/hunsu\/actions\/runs\/\d+\/attempts\/\d+$/u.test(invocationId),
    "The provenance invocation did not identify a Hunsu GitHub Actions run."
  );

  return {
    schema: "hunsu.bridge.npm-provenance.v1",
    url: provenanceUrl,
    predicateType: SLSA_PREDICATE,
    subject: { name: subject.name, sha512: subject.digest.sha512 },
    source: {
      repository: REPOSITORY_URL,
      workflow: WORKFLOW_PATH,
      ref: PREVIEW_PUBLICATION_REF,
      gitSha,
      builder: GITHUB_HOSTED_BUILDER,
      invocationId
    }
  };
}

function decodeStatement(payload) {
  const encoded = requiredMatch(payload, /^[A-Za-z0-9+/]+={0,2}$/u, "DSSE payload");
  let value;
  try {
    value = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  } catch (_error) {
    throw new Error("The verified DSSE payload was not valid JSON.");
  }
  return requiredObject(value, "SLSA statement");
}

function integrityHex(value) {
  const integrity = requiredMatch(value, /^sha512-[A-Za-z0-9+/]{86}==$/u, "npm integrity");
  return Buffer.from(integrity.slice("sha512-".length), "base64").toString("hex");
}

function registryAttestationUrl(value, version) {
  const raw = requiredString(value, "registry attestation URL");
  let url;
  try {
    url = new URL(raw);
  } catch (_error) {
    throw new Error("The registry attestation URL was invalid.");
  }
  ensure(url.protocol === "https:" && url.origin === "https://registry.npmjs.org", "The attestation URL did not use the npm registry.");
  ensure(!url.username && !url.password && !url.search && !url.hash, "The attestation URL contained unsafe URL components.");
  ensure(
    url.pathname.toLowerCase() === `/-/npm/v1/attestations/@hunsu%2fbridge@${version}`.toLowerCase(),
    "The attestation URL did not identify the exact Bridge candidate."
  );
  return url.toString();
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

function requiredObject(value, label) {
  ensure(value && typeof value === "object" && !Array.isArray(value), `${label} is required.`);
  return value;
}

function ensure(condition, message) {
  if (!condition) throw new Error(message);
}

if (resolve(process.argv[1] ?? "") === scriptPath) {
  try {
    const auditPath = requiredString(process.env.HUNSU_NPM_AUDIT_PATH, "npm audit path");
    ensure(isAbsolute(auditPath), "The npm audit path must be absolute.");
    const audit = JSON.parse(await readFile(auditPath, "utf8"));
    const value = verifyBridgeNpmProvenanceAudit({
      audit,
      version: process.env.HUNSU_EVIDENCE_NPM_VERSION,
      versionTag: process.env.VERSION_TAG,
      integrity: process.env.HUNSU_EVIDENCE_NPM_INTEGRITY,
      gitSha: process.env.GITHUB_SHA
    });
    process.stdout.write(`${JSON.stringify(value)}\n`);
  } catch (error) {
    process.stderr.write(`[npm-provenance] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
