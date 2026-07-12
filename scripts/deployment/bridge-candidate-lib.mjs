import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { assertExactSemver, assertSourceSha, sha256File } from "./release-lib.mjs";

export const BRIDGE_CANDIDATE_SCHEMA = "hunsu.bridge.candidate.v1";
export const BRIDGE_CANDIDATE_BINDING_SCHEMA = "hunsu.bridge.candidate-binding.v1";
const NPM_REGISTRY = "https://registry.npmjs.org";

export function verifyBridgeCandidate(candidateRoot, releaseManifest, options = {}) {
  const root = resolve(candidateRoot);
  const evidence = JSON.parse(readFileSync(resolve(root, "candidate-evidence.json"), "utf8"));
  if (evidence.schema !== BRIDGE_CANDIDATE_SCHEMA || evidence.package !== "@hunsu/bridge") {
    throw new Error("Invalid Hunsu Bridge candidate evidence schema or package identity.");
  }
  const version = assertExactSemver(evidence.version, "candidate Bridge version");
  if (!version.includes("-")) {
    throw new Error("Preview Bridge candidate must use an explicit prerelease version.");
  }
  const sourceSha = assertSourceSha(evidence.source?.sha, "candidate source SHA");
  if (version !== releaseManifest.bridgePackageVersion) {
    throw new Error(`Bridge candidate ${version} does not match retained release ${releaseManifest.bridgePackageVersion}.`);
  }
  if (sourceSha !== releaseManifest.source.sha) {
    throw new Error("Bridge candidate source SHA does not match the retained deployment release.");
  }
  if (evidence.source?.repository !== releaseManifest.source.repository) {
    throw new Error("Bridge candidate repository does not match the retained deployment release.");
  }
  if (evidence.source?.branch !== "preview" || evidence.npmDistTag !== "candidate-next") {
    throw new Error("Bridge candidate evidence was not produced by the preview candidate publication lane.");
  }
  if (options.expectedWorkflowRunId !== undefined && String(evidence.workflow?.runId) !== String(options.expectedWorkflowRunId)) {
    throw new Error("Bridge candidate evidence workflow run does not match the downloaded exact-SHA artifact run.");
  }
  const tarballs = readdirSync(root).filter(name => name.endsWith(".tgz") && statSync(resolve(root, name)).isFile());
  if (tarballs.length !== 1) {
    throw new Error(`Expected exactly one Bridge candidate tarball; found ${tarballs.length}.`);
  }
  const tarballPath = resolve(root, tarballs[0]);
  const artifactSha256 = sha256File(tarballPath);
  const integrity = `sha512-${createHash("sha512").update(readFileSync(tarballPath)).digest("base64")}`;
  if (artifactSha256 !== evidence.artifactSha256 || integrity !== evidence.integrity) {
    throw new Error("Bridge candidate tarball does not match its SHA-bound candidate evidence.");
  }
  if (options.registryIntegrity !== undefined && integrity !== String(options.registryIntegrity).trim()) {
    throw new Error("npm registry integrity does not match the exact retained Bridge candidate tarball.");
  }
  if (options.candidateVersion !== undefined && version !== String(options.candidateVersion).trim()) {
    throw new Error("npm candidate-next does not identify the exact preview Bridge version.");
  }
  return {
    schema: BRIDGE_CANDIDATE_BINDING_SCHEMA,
    package: "@hunsu/bridge",
    version,
    integrity,
    artifactSha256,
    source: {
      repository: evidence.source.repository,
      sha: sourceSha
    },
    publishWorkflow: {
      runId: String(evidence.workflow?.runId ?? ""),
      runAttempt: String(evidence.workflow?.runAttempt ?? "")
    }
  };
}

export function readRegistryBridgeIntegrity(version) {
  const exactVersion = assertExactSemver(version, "registry Bridge version");
  return execFileSync("npm", ["view", `@hunsu/bridge@${exactVersion}`, "dist.integrity", `--registry=${NPM_REGISTRY}`], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"]
  }).trim();
}

export function readCandidateNextVersion() {
  return execFileSync("npm", ["view", "@hunsu/bridge", "dist-tags.candidate-next", `--registry=${NPM_REGISTRY}`], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"]
  }).trim();
}
