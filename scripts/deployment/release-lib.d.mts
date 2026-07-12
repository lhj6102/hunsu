export const RELEASE_SCHEMA: "hunsu.deployment-release.v4";
export const PREVIEW_EVIDENCE_SCHEMA: "hunsu.preview-deployment-evidence.v1";
export const WEB_RUNTIME_CONFIG_SCHEMA: "hunsu.web-runtime-config.v2";
export const RELEASE_MANIFEST_FILE: "release-manifest.json";

export type ReleaseFile = {
  path: string;
  sha256: string;
  bytes: number;
};

export type ConnectTrustProfile = {
  apiOrigin: string;
  accessIssuer: string;
  accessAudience: string;
  ticketSigningKeyId: string;
  ticketSigningPublicJwk: {
    kty: "EC";
    crv: "P-256";
    x: string;
    y: string;
  };
};

export type ConnectTrust = {
  preview: ConnectTrustProfile;
  production: ConnectTrustProfile;
};

export type ReleaseManifest = {
  schema: typeof RELEASE_SCHEMA;
  source: {
    repository: string;
    sha: string;
    tree: string;
    ref: string;
  };
  bridgePackageVersion: string;
  connectTrust: ConnectTrust;
  build: {
    workflowRunId: string;
    workflowRunAttempt: string;
    nodeVersion: string;
    pnpmVersion: string;
  };
  runtimeConfig: {
    schema: typeof WEB_RUNTIME_CONFIG_SCHEMA;
    path: string;
  };
  migrations: Array<{
    component: "hub" | "connect";
    path: string;
    sha256: string;
  }>;
  files: ReleaseFile[];
};

export function assertSourceSha(value: unknown, label?: string): string;
export function assertExactSemver(value: unknown, label?: string): string;
export function assertDeployTarget(value: unknown): "preview" | "production";
export function gitValue(args: string[], cwd?: string): string;
export function sha256File(path: string): string;
export function listReleaseFiles(root: string): string[];
export function createReleaseManifest(root: string, input: {
  sourceSha: string;
  sourceTree: string;
  bridgePackageVersion: string;
  connectTrust: ConnectTrust;
  repository: string;
  ref: string;
  workflowRunId?: string;
  workflowRunAttempt?: string;
  pnpmVersion?: string;
}): ReleaseManifest;
export function verifyRelease(root: string, options?: { expectedSourceSha?: string }): {
  manifest: ReleaseManifest;
  manifestPath: string;
  manifestSha256: string;
};
export function assertRetainedWorkerModule(path: string, label?: string): void;
export function safeReleasePath(root: string, relativePath: string): string;
export function requireEnv(name: string, env?: Record<string, string | undefined>): string;
export function validateBaseUrl(value: unknown, label: string, options?: { allowEmpty?: boolean }): string;
export function relativePosix(from: string, to: string): string;
export function normalizeConnectTrust(value: unknown): ConnectTrust;
