#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { get } from "node:https";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { gunzipSync, inflateRawSync } from "node:zlib";
import * as esbuild from "esbuild";
import { currentProcessEnv, resolveBridgeSidecarPackagingConfig, unwrapConfigResult } from "@hunsu/config";
import {
  prepareNativeSidecars,
  sidecarArtifactNameForTarget,
  sidecarTargets,
  validateNativeSidecarArtifact
} from "./prepare-sidecars.mjs";

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(root, "dist");
const defaultNativeDir = resolve(root, "native-sidecars");
const defaultCacheDir = resolve(root, ".sidecar-cache");
const defaultNodeVersion = "22.22.0";
const seaBlobResourceName = "NODE_SEA_BLOB";
const seaFuse = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

const nodePlatformBySidecarTarget = new Map([
  ["x86_64-apple-darwin", "darwin-x64"],
  ["aarch64-apple-darwin", "darwin-arm64"],
  ["x86_64-unknown-linux-gnu", "linux-x64"],
  ["aarch64-unknown-linux-gnu", "linux-arm64"],
  ["x86_64-pc-windows-msvc", "win-x64"],
  ["aarch64-pc-windows-msvc", "win-arm64"]
]);

export async function buildNativeSidecars(options = {}) {
  const packagingConfig = unwrapConfigResult(resolveBridgeSidecarPackagingConfig(currentProcessEnv()));
  const nodeVersion = normalizeNodeVersion(options.nodeVersion ?? packagingConfig.sidecarNodeVersion ?? defaultNodeVersion);
  const nativeDir = resolve(options.nativeDir ?? packagingConfig.nativeSidecarDir ?? defaultNativeDir);
  const cacheDir = resolve(options.cacheDir ?? packagingConfig.sidecarCacheDir ?? defaultCacheDir);

  mkdirSync(dist, { recursive: true });
  mkdirSync(nativeDir, { recursive: true });
  mkdirSync(cacheDir, { recursive: true });

  const bundlePath = resolve(dist, "sidecar-bundle.cjs");
  const blobPath = resolve(dist, "hunsu-bridge-sidecar.blob");
  await bundleSidecar(bundlePath);
  createSeaBlob({ bundlePath, blobPath });

  if (options.bundleOnly) {
    return {
      schema: "hunsu.bridge-sidecar-build.v1",
      nodeVersion,
      bundlePath,
      blobPath,
      artifacts: []
    };
  }

  const shasums = await loadNodeShasums({ nodeVersion, cacheDir });
  const builtArtifacts = [];
  for (const target of sidecarTargets) {
    const archiveName = nodeArchiveNameForTarget(target, nodeVersion);
    const archivePath = await ensureNodeArchive({
      nodeVersion,
      cacheDir,
      archiveName,
      expectedSha256: shasums.get(archiveName)
    });
    const executable = extractNodeExecutable({ archivePath, target, nodeVersion });
    const artifactPath = resolve(nativeDir, sidecarArtifactNameForTarget(target));
    writeFileSync(artifactPath, executable);
    if (target.extension === "") {
      chmodSync(artifactPath, 0o755);
    }
    injectSeaBlob({ artifactPath, blobPath, target });
    if (target.extension === "") {
      chmodSync(artifactPath, 0o755);
    }
    validateNativeSidecarArtifact(artifactPath);
    builtArtifacts.push({
      target: target.target,
      file: basename(artifactPath),
      nodeRuntime: archiveName
    });
  }

  const manifest = prepareNativeSidecars({ nativeDir });
  smokeTestCurrentPlatformSidecar({ bundlePath, manifest });
  return {
    schema: "hunsu.bridge-sidecar-build.v1",
    nodeVersion,
    bundlePath,
    blobPath,
    nativeDir,
    artifacts: builtArtifacts,
    preparedManifest: manifest
  };
}

export function smokeTestCurrentPlatformSidecar(input) {
  const currentPlatform = input.manifest.currentPlatform;
  if (!currentPlatform) {
    return;
  }
  const sidecarPath = resolve(dist, currentPlatform.file);
  const smokeRoot = mkdtempSync(join(tmpdir(), "hunsu-bridge-sidecar-smoke-"));
  const smokeEnv = {
    ...currentProcessEnv(),
    HUNSU_BRIDGE_APP_STATE_PATH: join(smokeRoot, "state.json"),
    HUNSU_ROADMAP_REGISTRY_PATH: join(smokeRoot, "roadmaps.json"),
    HUNSU_BRIDGE_CREDENTIAL_PATH: join(smokeRoot, "credentials.json"),
    HUNSU_RELAY_REGISTRY_PATH: join(smokeRoot, "relay.json"),
    HUNSU_BRIDGE_APP_LOG_PATH: join(smokeRoot, "bridge-app.log")
  };
  try {
    const bundleStatus = runCommandCapture(process.execPath, [input.bundlePath, "status"], {
      cwd: root,
      env: smokeEnv
    });
    const sidecarStatus = runCommandCapture(sidecarPath, ["status"], {
      cwd: root,
      env: smokeEnv
    });
    if (sidecarStatus.stdout !== bundleStatus.stdout) {
      throw new Error([
        "Native Hunsu Bridge sidecar status output did not match the Node bundle.",
        "",
        "Expected:",
        bundleStatus.stdout,
        "Actual:",
        sidecarStatus.stdout
      ].join("\n"));
    }
  } finally {
    rmSync(smokeRoot, { recursive: true, force: true });
  }
}

export async function bundleSidecar(bundlePath = resolve(dist, "sidecar-bundle.cjs")) {
  await esbuild.build({
    entryPoints: [resolve(root, "src/main.ts")],
    outfile: bundlePath,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    conditions: ["development"],
    mainFields: ["module", "main"],
    legalComments: "none",
    banner: {
      js: [
        "globalThis.__HUNSU_BRIDGE_BUNDLED_SIDECAR = true;",
        "const __hunsuImportMetaUrl = require(\"node:url\").pathToFileURL(process.argv[1] || process.execPath).href;"
      ].join("\n")
    },
    define: {
      "import.meta.url": "__hunsuImportMetaUrl"
    }
  });
  return bundlePath;
}

export function createSeaBlob(input) {
  const seaConfigPath = resolve(dist, "sidecar-sea-config.json");
  writeFileSync(seaConfigPath, `${JSON.stringify({
    main: input.bundlePath,
    output: input.blobPath,
    disableExperimentalSEAWarning: true
  }, null, 2)}\n`, "utf8");
  runCommand(process.execPath, ["--experimental-sea-config", seaConfigPath], { cwd: root });
  return input.blobPath;
}

export function nodeArchiveNameForTarget(target, nodeVersion = defaultNodeVersion) {
  const nodePlatform = nodePlatformForTarget(target);
  const extension = nodePlatform.startsWith("win-") ? ".zip" : ".tar.gz";
  return `node-v${normalizeNodeVersion(nodeVersion)}-${nodePlatform}${extension}`;
}

export function extractNodeExecutable(input) {
  const nodePlatform = nodePlatformForTarget(input.target);
  const baseName = `node-v${normalizeNodeVersion(input.nodeVersion)}-${nodePlatform}`;
  if (nodePlatform.startsWith("win-")) {
    return extractZipEntry(input.archivePath, `${baseName}/node.exe`);
  }
  return extractTarGzEntry(input.archivePath, `${baseName}/bin/node`);
}

export function extractTarGzEntry(archivePath, entryName) {
  const tar = gunzipSync(readFileSync(archivePath));
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) {
      break;
    }
    const name = tarHeaderName(header);
    const size = parseInt(readNullTerminated(header, 124, 12).trim() || "0", 8);
    const dataOffset = offset + 512;
    if (name === entryName) {
      return Buffer.from(tar.subarray(dataOffset, dataOffset + size));
    }
    offset = dataOffset + Math.ceil(size / 512) * 512;
  }
  throw new Error(`Node executable ${entryName} was not found in ${archivePath}`);
}

export function extractZipEntry(archivePath, entryName) {
  const zip = readFileSync(archivePath);
  const centralDirectory = findZipCentralDirectory(zip);
  let offset = centralDirectory.offset;
  const end = centralDirectory.offset + centralDirectory.size;
  while (offset < end) {
    if (zip.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error(`Invalid ZIP central directory in ${archivePath}`);
    }
    const method = zip.readUInt16LE(offset + 10);
    const compressedSize = zip.readUInt32LE(offset + 20);
    const fileNameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    const localHeaderOffset = zip.readUInt32LE(offset + 42);
    const name = zip.subarray(offset + 46, offset + 46 + fileNameLength).toString("utf8");
    if (name === entryName) {
      return readZipLocalEntry(zip, archivePath, localHeaderOffset, compressedSize, method);
    }
    offset += 46 + fileNameLength + extraLength + commentLength;
  }
  throw new Error(`Node executable ${entryName} was not found in ${archivePath}`);
}

function readZipLocalEntry(zip, archivePath, offset, compressedSize, method) {
  if (zip.readUInt32LE(offset) !== 0x04034b50) {
    throw new Error(`Invalid ZIP local entry in ${archivePath}`);
  }
  const fileNameLength = zip.readUInt16LE(offset + 26);
  const extraLength = zip.readUInt16LE(offset + 28);
  const dataOffset = offset + 30 + fileNameLength + extraLength;
  const data = zip.subarray(dataOffset, dataOffset + compressedSize);
  if (method === 0) {
    return Buffer.from(data);
  }
  if (method === 8) {
    return inflateRawSync(data);
  }
  throw new Error(`Unsupported ZIP compression method ${method} in ${archivePath}`);
}

function findZipCentralDirectory(zip) {
  const minOffset = Math.max(0, zip.length - 0xffff - 22);
  for (let offset = zip.length - 22; offset >= minOffset; offset -= 1) {
    if (zip.readUInt32LE(offset) === 0x06054b50) {
      return {
        size: zip.readUInt32LE(offset + 12),
        offset: zip.readUInt32LE(offset + 16)
      };
    }
  }
  throw new Error("ZIP end of central directory was not found");
}

function tarHeaderName(header) {
  const name = readNullTerminated(header, 0, 100);
  const prefix = readNullTerminated(header, 345, 155);
  return prefix ? `${prefix}/${name}` : name;
}

function readNullTerminated(buffer, offset, length) {
  return buffer.subarray(offset, offset + length).toString("utf8").replace(/\0.*$/u, "");
}

async function loadNodeShasums(input) {
  const checksumPath = resolve(input.cacheDir, `node-v${input.nodeVersion}-SHASUMS256.txt`);
  if (!existsSync(checksumPath)) {
    await downloadFile(nodeDistUrl(input.nodeVersion, "SHASUMS256.txt"), checksumPath);
  }
  const shasums = new Map();
  for (const line of readFileSync(checksumPath, "utf8").split(/\r?\n/u)) {
    const match = /^([a-f0-9]{64})\s+(.+)$/u.exec(line.trim());
    if (match) {
      shasums.set(match[2], match[1]);
    }
  }
  return shasums;
}

async function ensureNodeArchive(input) {
  if (!input.expectedSha256) {
    throw new Error(`Node release checksums do not include ${input.archiveName}`);
  }
  const archivePath = resolve(input.cacheDir, input.archiveName);
  if (existsSync(archivePath) && sha256File(archivePath) === input.expectedSha256) {
    return archivePath;
  }
  if (existsSync(archivePath)) {
    rmSync(archivePath, { force: true });
  }
  await downloadFile(nodeDistUrl(input.nodeVersion, input.archiveName), archivePath);
  const actual = sha256File(archivePath);
  if (actual !== input.expectedSha256) {
    rmSync(archivePath, { force: true });
    throw new Error(`Checksum mismatch for ${input.archiveName}: expected ${input.expectedSha256}, got ${actual}`);
  }
  return archivePath;
}

async function downloadFile(url, destination) {
  mkdirSync(dirname(destination), { recursive: true });
  const temporary = `${destination}.tmp-${process.pid}`;
  await downloadToTemporary(url, temporary);
  renameSync(temporary, destination);
}

async function downloadToTemporary(url, temporary, redirects = 0) {
  if (redirects > 5) {
    throw new Error(`Too many redirects while downloading ${url}`);
  }
  await new Promise((resolveDownload, rejectDownload) => {
    const request = get(url, { headers: { "user-agent": "hunsu-bridge-sidecar-builder" } }, response => {
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        downloadToTemporary(new URL(response.headers.location, url).toString(), temporary, redirects + 1).then(resolveDownload, rejectDownload);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        rejectDownload(new Error(`Failed to download ${url}: HTTP ${response.statusCode ?? "unknown"}`));
        return;
      }
      pipeline(response, createWriteStream(temporary)).then(resolveDownload, rejectDownload);
    });
    request.on("error", rejectDownload);
  });
}

function nodeDistUrl(nodeVersion, fileName) {
  return `https://nodejs.org/dist/v${nodeVersion}/${fileName}`;
}

function injectSeaBlob(input) {
  const postjectCli = require.resolve("postject/dist/cli.js");
  const args = [
    postjectCli,
    input.artifactPath,
    seaBlobResourceName,
    input.blobPath,
    "--sentinel-fuse",
    seaFuse,
    "--overwrite"
  ];
  if (input.target.platform === "darwin") {
    args.push("--macho-segment-name", "NODE_SEA");
  }
  runCommand(process.execPath, args, { cwd: root });
}

function nodePlatformForTarget(target) {
  const platform = nodePlatformBySidecarTarget.get(target.target);
  if (!platform) {
    throw new Error(`No Node runtime mapping is configured for ${target.target}`);
  }
  return platform;
}

function normalizeNodeVersion(version) {
  return String(version).replace(/^v/u, "");
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    stdio: "inherit"
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status ?? "unknown"}`);
  }
}

function runCommandCapture(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8"
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error([
      `${command} ${args.join(" ")} failed with exit code ${result.status ?? "unknown"}`,
      result.stdout,
      result.stderr
    ].join("\n"));
  }
  return {
    stdout: result.stdout,
    stderr: result.stderr
  };
}

async function runCli(argv) {
  const parsed = parseArgs(argv);
  const manifest = await buildNativeSidecars(parsed);
  if (parsed.bundleOnly) {
    console.log(`Built Hunsu Bridge sidecar bundle and SEA blob in ${dist}.`);
    return;
  }
  console.log(`Built ${manifest.artifacts.length} native Hunsu Bridge sidecar artifacts in ${manifest.nativeDir}.`);
}

function parseArgs(argv) {
  const nativeDirArgIndex = argv.indexOf("--native-dir");
  const cacheDirArgIndex = argv.indexOf("--cache-dir");
  const nodeVersionArgIndex = argv.indexOf("--node-version");
  return {
    bundleOnly: argv.includes("--bundle-only"),
    nativeDir: readRequiredArg(argv, nativeDirArgIndex, "--native-dir"),
    cacheDir: readRequiredArg(argv, cacheDirArgIndex, "--cache-dir"),
    nodeVersion: readRequiredArg(argv, nodeVersionArgIndex, "--node-version")
  };
}

function readRequiredArg(argv, index, flag) {
  if (index < 0) {
    return undefined;
  }
  const value = argv[index + 1];
  if (!value) {
    throw new Error(`Usage: build-native-sidecars.mjs ${flag} <value>`);
  }
  return value;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCli(process.argv.slice(2)).catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
