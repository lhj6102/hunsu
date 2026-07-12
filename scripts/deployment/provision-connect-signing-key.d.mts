export type ConnectSigningRotationEnvironment = "hunsu-preview" | "hunsu-production";
export type ConnectSigningRotationTarget = "preview" | "production";

export type ConnectSigningPublicJwk = {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
};

export type ConnectSigningPrivateJwk = ConnectSigningPublicJwk & { d: string };

export type ConnectSigningRotationBundle = {
  schema: "hunsu.connect-signing-key-rotation.v1";
  environment: ConnectSigningRotationEnvironment;
  repository: string;
  createdAt: string;
  publicJwk: ConnectSigningPublicJwk;
  keyId: string;
  privateJwk: ConnectSigningPrivateJwk;
};

export type ConnectSigningRotationMetadata = {
  schema: "hunsu.connect-signing-key-rotation.v1";
  state: "staged" | "activating" | "activated";
  environment: ConnectSigningRotationEnvironment;
  repository: string;
  bundleFile: string;
  publicJwk: string;
  keyId: string;
};

export const CONNECT_SIGNING_KEY_ROTATION_SCHEMA: "hunsu.connect-signing-key-rotation.v1";

export function generateConnectSigningKeyRotation(input: {
  environment: ConnectSigningRotationEnvironment;
  repository?: string;
  bundlePath: string;
  now?: Date;
  platform?: NodeJS.Platform;
  windowsSecureWriter?: (path: string, content: string) => void;
  windowsAclValidator?: (path: string) => void;
}): ConnectSigningRotationMetadata;

export function activateConnectSigningKeyRotation(input: {
  environment: ConnectSigningRotationEnvironment;
  repository?: string;
  bundlePath: string;
}, dependencies?: {
  resourceAllowlist?: (target: ConnectSigningRotationTarget) => {
    connectSigningPublicJwk: string;
    connectSigningKeyId: string;
    [key: string]: unknown;
  };
  platform?: NodeJS.Platform;
  windowsAclValidator?: (path: string) => void;
  runGit?: (args: string[]) => string;
  runGh?: (args: string[], input?: string) => string | undefined;
  report?: (metadata: ConnectSigningRotationMetadata) => void;
}): ConnectSigningRotationMetadata;

export function readRotationBundle(bundlePath: string, options?: {
  platform?: NodeJS.Platform;
  windowsAclValidator?: (path: string) => void;
}): ConnectSigningRotationBundle;
export function windowsAtomicPrivateBundlePowerShellInvocation(path: string): {
  command: "powershell.exe";
  args: string[];
};
export function main(argv?: string[]): void;
