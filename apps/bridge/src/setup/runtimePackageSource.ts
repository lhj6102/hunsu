import { isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { HUNSU_BRIDGE_VERSION } from "../version.ts";

export type RuntimePackageSource =
  | {
      kind: "registry-exact";
      packageName: "@hunsu/bridge";
      version: string;
    }
  | {
      kind: "local-tarball";
      fileUrl: string;
      expectedVersion: string;
    };

export class RuntimePackageSourceError extends Error {
  readonly code = "RUNTIME_INSTALL_FAILED" as const;

  constructor(message: string) {
    super(message);
    this.name = "RuntimePackageSourceError";
  }
}

export function executingBridgeRuntimeSource(): RuntimePackageSource {
  return {
    kind: "registry-exact",
    packageName: "@hunsu/bridge",
    version: HUNSU_BRIDGE_VERSION
  };
}

export function localBridgeTarballSource(
  absoluteTarballPath: string,
  expectedVersion: string = HUNSU_BRIDGE_VERSION
): RuntimePackageSource {
  if (containsControlCharacter(absoluteTarballPath)
    || !isAbsolute(absoluteTarballPath)
    || !absoluteTarballPath.toLowerCase().endsWith(".tgz")) {
    throw new RuntimePackageSourceError("--runtime-package requires an absolute local .tgz path.");
  }
  if (!isExactVersion(expectedVersion)) {
    throw new RuntimePackageSourceError("The local runtime package requires an exact expected version.");
  }
  return {
    kind: "local-tarball",
    fileUrl: pathToFileURL(absoluteTarballPath).href,
    expectedVersion
  };
}

export function runtimePackageName(source: RuntimePackageSource): "@hunsu/bridge" {
  validateRuntimePackageSource(source);
  return "@hunsu/bridge";
}

export function runtimePackageVersion(source: RuntimePackageSource): string {
  const validated = validateRuntimePackageSource(source);
  return validated.kind === "registry-exact" ? validated.version : validated.expectedVersion;
}

export function runtimePackageSpec(source: RuntimePackageSource): string {
  const validated = validateRuntimePackageSource(source);
  if (validated.kind === "local-tarball") return validated.fileUrl;
  return `${validated.packageName}@${validated.version}`;
}

export function validateRuntimePackageSource(source: RuntimePackageSource): RuntimePackageSource {
  if (source.kind === "registry-exact") {
    if (source.packageName !== "@hunsu/bridge" || !isExactVersion(source.version)) {
      throw new RuntimePackageSourceError("Bridge setup requires one exact @hunsu/bridge package version.");
    }
    return { kind: "registry-exact", packageName: "@hunsu/bridge", version: source.version };
  }
  if (source.kind !== "local-tarball" || !isExactVersion(source.expectedVersion)) {
    throw new RuntimePackageSourceError("Bridge setup requires one exact @hunsu/bridge package version.");
  }
  let url: URL;
  try {
    url = new URL(source.fileUrl);
  } catch (error) {
    throw new RuntimePackageSourceError("The local runtime package must be a file URL created from an absolute .tgz path.");
  }
  if (url.protocol !== "file:" || url.username || url.password || url.search || url.hash) {
    throw new RuntimePackageSourceError("The local runtime package must be a credential-free local file URL.");
  }
  let path: string;
  try {
    path = fileURLToPath(url);
  } catch (error) {
    throw new RuntimePackageSourceError("The local runtime package file URL is invalid.");
  }
  if (!isAbsolute(path) || !path.toLowerCase().endsWith(".tgz") || containsControlCharacter(path)) {
    throw new RuntimePackageSourceError("The local runtime package must resolve to an absolute .tgz path.");
  }
  return {
    kind: "local-tarball",
    fileUrl: pathToFileURL(path).href,
    expectedVersion: source.expectedVersion
  };
}

export function isExactVersion(value: string): boolean {
  return /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u.test(value);
}

function containsControlCharacter(value: string): boolean {
  return /[\u0000-\u001f\u007f]/u.test(value);
}
