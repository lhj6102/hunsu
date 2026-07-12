#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  readCandidateNextVersion,
  readRegistryBridgeIntegrity,
  verifyBridgeCandidate
} from "./bridge-candidate-lib.mjs";
import { RELEASE_MANIFEST_FILE, verifyRelease } from "./release-lib.mjs";

const [releaseArgument, candidateArgument, outputArgument] = process.argv.slice(2);
if (!releaseArgument || !candidateArgument || !outputArgument) {
  throw new Error("Usage: verify-bridge-candidate.mjs <release-root> <candidate-root> <binding-output>");
}
const release = verifyRelease(resolve(releaseArgument));
const registryIntegrity = readRegistryBridgeIntegrity(release.manifest.bridgePackageVersion);
const candidateVersion = readCandidateNextVersion();
const binding = verifyBridgeCandidate(resolve(candidateArgument), release.manifest, {
  registryIntegrity,
  candidateVersion,
  expectedWorkflowRunId: process.env.HUNSU_BRIDGE_CANDIDATE_RUN_ID
});
writeFileSync(resolve(outputArgument), `${JSON.stringify(binding, null, 2)}\n`, "utf8");
console.log(JSON.stringify({
  sourceSha: binding.source.sha,
  version: binding.version,
  integrity: binding.integrity,
  releaseManifest: RELEASE_MANIFEST_FILE
}));
