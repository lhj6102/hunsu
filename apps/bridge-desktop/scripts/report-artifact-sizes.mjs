#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const args = process.argv.slice(2);
const directory = optionValue("--directory") ?? "apps/bridge-desktop/src-tauri/target/release/bundle";
const output = optionValue("--output") ?? join(directory, "artifact-size-report.json");
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
const report = {
  schema: "hunsu.bridge-desktop-artifact-sizes.v1",
  directory: root,
  generatedAt: new Date().toISOString(),
  totalBytes,
  totalMiB: Number((totalBytes / 1024 / 1024).toFixed(2)),
  artifacts
};

mkdirSync(dirname(resolve(output)), { recursive: true });
writeFileSync(resolve(output), `${JSON.stringify(report, null, 2)}\n`, "utf8");
for (const artifact of artifacts) {
  console.log(`${artifact.sizeMiB.toFixed(2)} MiB  ${artifact.path}`);
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
