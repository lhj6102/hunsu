#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const directory = optionValue("--directory") ?? join(packageRoot, "src-tauri/target/release/bundle");
const output = optionValue("--output") ?? join(directory, "artifact-size-report.json");
const sidecarManifest = optionValue("--sidecar-manifest") ?? join(packageRoot, "dist/sidecar-manifest.json");
const expectedSidecarTarget = optionValue("--target");
const root = resolve(directory);

if (!existsSync(root)) {
  throw new Error(`Missing artifact directory: ${root}`);
}

const artifacts = walk(root)
  .filter(path => !path.endsWith("artifact-size-report.json"))
  .map(path => {
    const sizeBytes = statSync(path).size;
    return {
      path: relative(root, path).split("\\").join("/"),
      sizeBytes,
      sizeMiB: Number((sizeBytes / 1024 / 1024).toFixed(2))
    };
  })
  .sort((left, right) => left.path.localeCompare(right.path));

const totalBytes = artifacts.reduce((total, artifact) => total + artifact.sizeBytes, 0);
const sidecars = sidecarSizes(resolve(sidecarManifest), expectedSidecarTarget);
const report = {
  schema: "hunsu.bridge-desktop-artifact-sizes.v2",
  directory: root,
  generatedAt: new Date().toISOString(),
  totalBytes,
  totalMiB: Number((totalBytes / 1024 / 1024).toFixed(2)),
  artifacts,
  sidecars
};

mkdirSync(dirname(resolve(output)), { recursive: true });
writeFileSync(resolve(output), `${JSON.stringify(report, null, 2)}\n`, "utf8");
for (const artifact of artifacts) {
  console.log(`${artifact.sizeMiB.toFixed(2)} MiB  ${artifact.path}`);
}
for (const sidecar of sidecars) {
  console.log(`${sidecar.sizeMiB.toFixed(2)} MiB  sidecar:${sidecar.target} ${sidecar.file}`);
}
console.log(`${report.totalMiB.toFixed(2)} MiB  total`);

function optionValue(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function walk(directory) {
  const files = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      files.push(...walk(path));
    } else if (stat.isFile()) {
      files.push(path);
    }
  }
  return files;
}

function sidecarSizes(manifestPath, expectedTarget) {
  if (!existsSync(manifestPath)) {
    throw new Error(`Missing sidecar manifest: ${manifestPath}`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest?.schema !== "hunsu.bridge-sidecars.v1" || !Array.isArray(manifest.artifacts)) {
    throw new Error(`Invalid sidecar manifest: ${manifestPath}`);
  }
  if (manifest.artifacts.length !== 1) {
    throw new Error(`Expected exactly one staged sidecar, found ${manifest.artifacts.length}.`);
  }
  const artifact = manifest.artifacts[0];
  if (typeof artifact?.target !== "string" || typeof artifact?.file !== "string" || basename(artifact.file) !== artifact.file) {
    throw new Error(`Invalid sidecar artifact entry in ${manifestPath}`);
  }
  if (manifest.target !== artifact.target) {
    throw new Error(`Sidecar manifest target ${String(manifest.target)} does not match ${artifact.target}.`);
  }
  if (expectedTarget && artifact.target !== expectedTarget) {
    throw new Error(`Expected sidecar target ${expectedTarget}, found ${artifact.target}.`);
  }
  const path = resolve(dirname(manifestPath), artifact.file);
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new Error(`Missing staged sidecar artifact: ${path}`);
  }
  const sizeBytes = statSync(path).size;
  return [{
    target: artifact.target,
    file: artifact.file,
    sizeBytes,
    sizeMiB: Number((sizeBytes / 1024 / 1024).toFixed(2))
  }];
}
