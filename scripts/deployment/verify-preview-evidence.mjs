#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  BRIDGE_CANDIDATE_BINDING_SCHEMA,
  readRegistryBridgeIntegrity
} from "./bridge-candidate-lib.mjs";
import {
  PREVIEW_EVIDENCE_SCHEMA,
  assertSourceSha,
  requireEnv,
  verifyRelease
} from "./release-lib.mjs";

const [releaseArgument, evidenceArgument, bindingOutputArgument] = process.argv.slice(2);
if (!releaseArgument || !evidenceArgument || !bindingOutputArgument) {
  throw new Error("Usage: verify-preview-evidence.mjs <release-root> <preview-evidence-json> <candidate-binding-output>");
}
const sourceSha = assertSourceSha(requireEnv("HUNSU_RELEASE_SHA"));
const verified = verifyRelease(resolve(releaseArgument), { expectedSourceSha: sourceSha });
const evidence = JSON.parse(readFileSync(resolve(evidenceArgument), "utf8"));
if (evidence.schema !== PREVIEW_EVIDENCE_SCHEMA || evidence.target !== "preview") {
  throw new Error("Artifact is not a successful preview deployment evidence record.");
}
if (evidence.sourceSha !== sourceSha || evidence.sourceTree !== verified.manifest.source.tree) {
  throw new Error("Preview evidence source identity does not match the retained release.");
}
if (evidence.releaseManifestSha256 !== verified.manifestSha256) {
  throw new Error("Preview evidence manifest digest does not match the retained release.");
}
if (evidence.bridgePackageVersion !== verified.manifest.bridgePackageVersion) {
  throw new Error("Preview evidence Bridge version does not match the retained release.");
}
const candidate = evidence.bridgeCandidate;
if (
  candidate?.schema !== BRIDGE_CANDIDATE_BINDING_SCHEMA
  || candidate.package !== "@hunsu/bridge"
  || candidate.version !== verified.manifest.bridgePackageVersion
  || candidate.source?.sha !== sourceSha
  || candidate.source?.repository !== verified.manifest.source.repository
  || typeof candidate.integrity !== "string"
) {
  throw new Error("Preview evidence is missing the exact SHA-bound Bridge candidate identity.");
}
const registryIntegrity = readRegistryBridgeIntegrity(candidate.version);
if (registryIntegrity !== candidate.integrity) {
  throw new Error("The exact npm Bridge version no longer matches preview candidate integrity.");
}
writeFileSync(resolve(bindingOutputArgument), `${JSON.stringify(candidate, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ verified: true, sourceSha, releaseManifestSha256: verified.manifestSha256 }));
