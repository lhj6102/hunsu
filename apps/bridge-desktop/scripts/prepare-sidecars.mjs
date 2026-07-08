#!/usr/bin/env node
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { currentProcessEnv, resolveBridgeSidecarPackagingConfig, unwrapConfigResult } from "@hunsu/config";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(root, "dist");
const defaultNativeDir = resolve(root, "native-sidecars");

export const sidecarTargets = [
  { target: "x86_64-apple-darwin", platform: "darwin", arch: "x64", extension: "" },
  { target: "aarch64-apple-darwin", platform: "darwin", arch: "arm64", extension: "" },
  { target: "x86_64-unknown-linux-gnu", platform: "linux", arch: "x64", extension: "" },
  { target: "aarch64-unknown-linux-gnu", platform: "linux", arch: "arm64", extension: "" },
  { target: "x86_64-pc-windows-msvc", platform: "win32", arch: "x64", extension: ".exe" },
  { target: "aarch64-pc-windows-msvc", platform: "win32", arch: "arm64", extension: ".exe" }
];

export function sidecarArtifactNameForTarget(target) {
  return `hunsu-bridge-sidecar-${target.target}${target.extension}`;
}

export function genericSidecarNameForPlatform(platform = process.platform) {
  return platform === "win32" ? "hunsu-bridge-sidecar.exe" : "hunsu-bridge-sidecar";
}

export function validateNativeSidecarArtifact(path) {
  if (!existsSync(path)) {
    throw new Error(`Native sidecar artifact is missing: ${path}`);
  }
  const stat = statSync(path);
  if (!stat.isFile()) {
    throw new Error(`Native sidecar artifact is not a file: ${path}`);
  }
  if (stat.size < 4096) {
    throw new Error(`Native sidecar artifact is too small to be a bundled executable: ${path}`);
  }
  const sample = readFileSync(path).subarray(0, 4096);
  if (!hasNativeExecutableMagic(sample)) {
    const text = sample.toString("utf8").replace(/\0/g, "");
    const launcherHint = /(^#!|@echo\s+off|\bnode(?:\.exe)?\b|main\.js|process\.execPath)/i.test(text)
      ? " It looks like a Node launcher, not a bundled sidecar."
      : "";
    throw new Error(`Native sidecar artifact must be an ELF, Mach-O, universal Mach-O, or PE executable: ${path}.${launcherHint}`);
  }
}

export function prepareNativeSidecars(options = {}) {
  const packagingConfig = unwrapConfigResult(resolveBridgeSidecarPackagingConfig(currentProcessEnv()));
  const nativeDir = resolve(options.nativeDir ?? packagingConfig.nativeSidecarDir ?? defaultNativeDir);
  const outputDir = resolve(options.distDir ?? dist);
  mkdirSync(outputDir, { recursive: true });
  const manifest = {
    schema: "hunsu.bridge-sidecars.v1",
    source: nativeDir,
    artifacts: []
  };

  for (const target of sidecarTargets) {
    const artifactName = sidecarArtifactNameForTarget(target);
    const source = resolve(nativeDir, artifactName);
    const destination = resolve(outputDir, artifactName);
    validateNativeSidecarArtifact(source);
    copyFileSync(source, destination);
    if (target.extension === "") {
      chmodSync(destination, 0o755);
    }
    manifest.artifacts.push({
      target: target.target,
      file: basename(destination),
      kind: "native-executable"
    });
  }

  const currentTarget = sidecarTargets.find(target => target.platform === process.platform && target.arch === process.arch);
  if (currentTarget) {
    const source = resolve(outputDir, sidecarArtifactNameForTarget(currentTarget));
    const destination = resolve(outputDir, genericSidecarNameForPlatform());
    copyFileSync(source, destination);
    if (currentTarget.extension === "") {
      chmodSync(destination, 0o755);
    }
    manifest.currentPlatform = {
      target: currentTarget.target,
      file: basename(destination)
    };
  }

  writeFileSync(resolve(outputDir, "sidecar-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

function hasNativeExecutableMagic(bytes) {
  if (bytes.length < 4) return false;
  const first4 = bytes.subarray(0, 4).toString("hex");
  return first4 === "7f454c46"
    || first4 === "cafebabe"
    || first4 === "bebafeca"
    || first4 === "feedface"
    || first4 === "cefaedfe"
    || first4 === "feedfacf"
    || first4 === "cffaedfe"
    || (bytes[0] === 0x4d && bytes[1] === 0x5a);
}

function printNativeSidecarInstructions() {
  const packagingConfig = unwrapConfigResult(resolveBridgeSidecarPackagingConfig(currentProcessEnv()));
  const nativeDir = packagingConfig.nativeSidecarDir ?? defaultNativeDir;
  console.error("Hunsu Bridge desktop packaging requires native sidecar executables.");
  console.error("");
  console.error(`Place bundled artifacts in ${nativeDir}:`);
  for (const target of sidecarTargets) {
    console.error(`  - ${sidecarArtifactNameForTarget(target)}`);
  }
  console.error("");
  console.error("Do not provide shell, cmd, or Node launchers. Installed Tauri apps must not require Node on PATH.");
}

function runCli(argv) {
  if (argv[0] === "--check") {
    const path = argv[1];
    if (!path) {
      throw new Error("Usage: prepare-sidecars.mjs --check <artifact>");
    }
    validateNativeSidecarArtifact(resolve(path));
    return;
  }
  const nativeDirArgIndex = argv.indexOf("--native-dir");
  const nativeDir = nativeDirArgIndex >= 0 ? argv[nativeDirArgIndex + 1] : undefined;
  if (nativeDirArgIndex >= 0 && !nativeDir) {
    throw new Error("Usage: prepare-sidecars.mjs --native-dir <directory>");
  }
  const distDirArgIndex = argv.indexOf("--dist-dir");
  const distDir = distDirArgIndex >= 0 ? argv[distDirArgIndex + 1] : undefined;
  if (distDirArgIndex >= 0 && !distDir) {
    throw new Error("Usage: prepare-sidecars.mjs --dist-dir <directory>");
  }
  const manifest = prepareNativeSidecars({ nativeDir, distDir });
  console.log(`Prepared ${manifest.artifacts.length} native Hunsu Bridge sidecar artifacts in ${resolve(distDir ?? dist)}.`);
}

function isCurrentScriptEntrypoint() {
  const entrypoint = process.argv[1];
  return Boolean(entrypoint) && import.meta.url === pathToFileURL(resolve(entrypoint)).href;
}

if (isCurrentScriptEntrypoint()) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    printNativeSidecarInstructions();
    console.error("");
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
