import type { ReleaseManifest } from "./release-lib.mjs";

export const BRIDGE_CANDIDATE_SCHEMA: "hunsu.bridge.candidate.v1";
export const BRIDGE_CANDIDATE_BINDING_SCHEMA: "hunsu.bridge.candidate-binding.v1";

export type BridgeCandidateBinding = {
  schema: typeof BRIDGE_CANDIDATE_BINDING_SCHEMA;
  package: "@hunsu/bridge";
  version: string;
  integrity: string;
  artifactSha256: string;
  source: {
    repository: string;
    sha: string;
  };
  publishWorkflow: {
    runId: string;
    runAttempt: string;
  };
};

export function verifyBridgeCandidate(
  candidateRoot: string,
  releaseManifest: ReleaseManifest,
  options?: { registryIntegrity?: string; candidateVersion?: string; expectedWorkflowRunId?: string }
): BridgeCandidateBinding;

export function readRegistryBridgeIntegrity(version: string): string;
export function readCandidateNextVersion(): string;
