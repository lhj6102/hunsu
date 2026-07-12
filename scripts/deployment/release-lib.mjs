import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  lstatSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync
} from "node:fs";
import { relative, resolve, sep } from "node:path";

export const RELEASE_SCHEMA = "hunsu.deployment-release.v3";
export const PREVIEW_EVIDENCE_SCHEMA = "hunsu.preview-deployment-evidence.v1";
export const WEB_RUNTIME_CONFIG_SCHEMA = "hunsu.web-runtime-config.v2";
export const RELEASE_MANIFEST_FILE = "release-manifest.json";

const SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu;
const EXACT_SEMVER_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:[0-9a-z-]+(?:\.[0-9a-z-]+)*))?(?:\+[0-9a-z-]+(?:\.[0-9a-z-]+)*)?$/iu;
const MULTIPART_WORKER_PATTERN = /^--[^\r\n]+\r?\nContent-Disposition:\s*form-data;/u;

export function assertSourceSha(value, label = "source SHA") {
  const sha = String(value ?? "").trim().toLowerCase();
  if (!SHA_PATTERN.test(sha)) {
    throw new Error(`Invalid ${label}: expected a complete 40- or 64-character hexadecimal SHA.`);
  }
  return sha;
}

export function assertExactSemver(value, label = "version") {
  const version = String(value ?? "").trim();
  if (!EXACT_SEMVER_PATTERN.test(version)) {
    throw new Error(`Invalid ${label}: expected an exact semantic version, not a tag or range.`);
  }
  return version;
}

export function assertDeployTarget(value) {
  if (value !== "preview" && value !== "production") {
    throw new Error("Deployment target must be preview or production.");
  }
  return value;
}

export function gitValue(args, cwd = process.cwd()) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

export function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function listReleaseFiles(root) {
  const absoluteRoot = resolve(root);
  const files = [];
  walk(absoluteRoot, "", files);
  return files
    .filter(path => path !== RELEASE_MANIFEST_FILE)
    .sort((left, right) => left.localeCompare(right));

  function walk(directory, prefix, output) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolutePath = resolve(directory, entry.name);
      const metadata = lstatSync(absolutePath);
      if (metadata.isSymbolicLink()) {
        throw new Error(`Release artifacts cannot contain symbolic links: ${relativePath}`);
      }
      if (entry.isDirectory()) {
        walk(absolutePath, relativePath, output);
      } else if (entry.isFile()) {
        output.push(relativePath);
      } else {
        throw new Error(`Unsupported release artifact entry: ${relativePath}`);
      }
    }
  }
}

export function createReleaseManifest(root, input) {
  const absoluteRoot = resolve(root);
  const sourceSha = assertSourceSha(input.sourceSha);
  const sourceTree = assertSourceSha(input.sourceTree, "source tree SHA");
  const bridgePackageVersion = assertExactSemver(input.bridgePackageVersion, "Bridge package version");
  const files = listReleaseFiles(absoluteRoot).map(path => {
    const absolutePath = safeReleasePath(absoluteRoot, path);
    return {
      path,
      sha256: sha256File(absolutePath),
      bytes: statSync(absolutePath).size
    };
  });
  if (!files.some(file => file.path === "web/hunsu-runtime-config.js")) {
    throw new Error("Release is missing the neutral Web runtime-config overlay.");
  }
  if (!files.some(file => file.path === "hub/worker.mjs")) {
    throw new Error("Release is missing the prebuilt Hub Worker module.");
  }
  if (!files.some(file => file.path === "connect/worker.mjs")) {
    throw new Error("Release is missing the prebuilt Connect Worker module.");
  }
  assertRetainedWorkerModule(resolve(absoluteRoot, "hub/worker.mjs"), "Hub");
  assertRetainedWorkerModule(resolve(absoluteRoot, "connect/worker.mjs"), "Connect");
  const migrations = files
    .filter(file => /^(?:hub|connect)\/migrations\/[^/]+\.sql$/u.test(file.path))
    .map(file => ({
      component: file.path.startsWith("hub/") ? "hub" : "connect",
      path: file.path,
      sha256: file.sha256
    }));
  const manifest = {
    schema: RELEASE_SCHEMA,
    source: {
      repository: input.repository,
      sha: sourceSha,
      tree: sourceTree,
      ref: input.ref
    },
    bridgePackageVersion,
    build: {
      workflowRunId: String(input.workflowRunId ?? "local"),
      workflowRunAttempt: String(input.workflowRunAttempt ?? "1"),
      nodeVersion: process.version,
      pnpmVersion: String(input.pnpmVersion ?? "unknown")
    },
    runtimeConfig: {
      schema: WEB_RUNTIME_CONFIG_SCHEMA,
      path: "web/hunsu-runtime-config.js"
    },
    migrations,
    files
  };
  writeFileSync(resolve(absoluteRoot, RELEASE_MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

export function verifyRelease(root, options = {}) {
  const absoluteRoot = resolve(root);
  const manifestPath = resolve(absoluteRoot, RELEASE_MANIFEST_FILE);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.schema !== RELEASE_SCHEMA) {
    throw new Error(`Invalid release manifest schema: ${String(manifest.schema)}`);
  }
  const sourceSha = assertSourceSha(manifest.source?.sha);
  assertSourceSha(manifest.source?.tree, "source tree SHA");
  assertExactSemver(manifest.bridgePackageVersion, "Bridge package version");
  if (options.expectedSourceSha && sourceSha !== assertSourceSha(options.expectedSourceSha, "expected source SHA")) {
    throw new Error(`Release source ${sourceSha} does not match expected source ${options.expectedSourceSha}.`);
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new Error("Release manifest has no artifact files.");
  }
  const actualFiles = listReleaseFiles(absoluteRoot);
  const declaredFiles = manifest.files.map(file => String(file.path));
  if (new Set(declaredFiles).size !== declaredFiles.length) {
    throw new Error("Release manifest contains duplicate file paths.");
  }
  if (JSON.stringify(actualFiles) !== JSON.stringify([...declaredFiles].sort((a, b) => a.localeCompare(b)))) {
    throw new Error("Release artifact file set does not match its manifest.");
  }
  for (const file of manifest.files) {
    const absolutePath = safeReleasePath(absoluteRoot, file.path);
    const actualHash = sha256File(absolutePath);
    const actualBytes = statSync(absolutePath).size;
    if (actualHash !== file.sha256 || actualBytes !== file.bytes) {
      throw new Error(`Release artifact integrity mismatch: ${file.path}`);
    }
  }
  assertRetainedWorkerModule(safeReleasePath(absoluteRoot, "hub/worker.mjs"), "Hub");
  assertRetainedWorkerModule(safeReleasePath(absoluteRoot, "connect/worker.mjs"), "Connect");
  const expectedMigrations = manifest.files
    .filter(file => /^(?:hub|connect)\/migrations\/[^/]+\.sql$/u.test(file.path))
    .map(file => ({
      component: file.path.startsWith("hub/") ? "hub" : "connect",
      path: file.path,
      sha256: file.sha256
    }));
  if (JSON.stringify(manifest.migrations) !== JSON.stringify(expectedMigrations)) {
    throw new Error("Release migration inventory does not match its retained Hub and Connect migrations.");
  }
  return {
    manifest,
    manifestPath,
    manifestSha256: sha256File(manifestPath)
  };
}

export function assertRetainedWorkerModule(path, label = "Retained") {
  const source = readFileSync(path, "utf8");
  if (!source.trim()) {
    throw new Error(`${label} Worker module is empty.`);
  }
  if (MULTIPART_WORKER_PATTERN.test(source)) {
    throw new Error(`${label} Worker module is a multipart upload body, not JavaScript.`);
  }
  if (!/\bexport\s+(?:default|\{)/u.test(source)) {
    throw new Error(`${label} Worker module does not contain an ES module export.`);
  }
  const checked = spawnSync(process.execPath, ["--check", path], {
    encoding: "utf8",
    stdio: "pipe"
  });
  if (checked.error || checked.status !== 0) {
    throw new Error(`${label} Worker module is not syntactically valid JavaScript.`);
  }
}

export function safeReleasePath(root, relativePath) {
  if (typeof relativePath !== "string" || relativePath.includes("\\") || relativePath.startsWith("/") || relativePath.split("/").includes("..")) {
    throw new Error(`Unsafe release path: ${String(relativePath)}`);
  }
  const absoluteRoot = resolve(root);
  const absolutePath = resolve(absoluteRoot, relativePath);
  const prefix = absoluteRoot.endsWith(sep) ? absoluteRoot : `${absoluteRoot}${sep}`;
  if (!absolutePath.startsWith(prefix)) {
    throw new Error(`Release path escapes artifact root: ${relativePath}`);
  }
  return absolutePath;
}

export function requireEnv(name, env = process.env) {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable ${name}.`);
  }
  return value;
}

export function validateBaseUrl(value, label, { allowEmpty = false } = {}) {
  const raw = String(value ?? "").trim();
  if (!raw && allowEmpty) return "";
  try {
    const url = new URL(raw);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.search || url.hash) {
      throw new Error("unsupported URL");
    }
    return url.toString().replace(/\/$/u, "");
  } catch {
    throw new Error(`Invalid ${label}: expected a credential-free HTTP(S) base URL without query or fragment.`);
  }
}

export function relativePosix(from, to) {
  return relative(from, to).split(sep).join("/");
}
