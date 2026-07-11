#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const allowedFiles = new Set([
  "docs/adr/NNN-headless-first-bridge.md",
  "docs/internal-prototype-migration.md"
]);
const allowedPrefixes = ["scripts/maintenance/"];
const signatures = [
  ["desktop package path", ["apps", "bridge-desktop"].join("/")],
  ["native shell source path", ["src", "tauri"].join("-")],
  ["native shell npm scope", `@${["tauri", "apps"].join("-")}/`],
  ["native shell plugin", ["tauri", "plugin", ""].join("-")],
  ["native external binary setting", ["external", "Bin"].join("")],
  ["desktop artifact workflow", ["bridge", "desktop", "artifacts.yml"].join("-")],
  ["native installer template", ["installer", "template.nsi"].join("-")],
  ["single-executable injector", ["post", "ject"].join("")],
  ["native sidecar directory override", ["HUNSU", "BRIDGE", "NATIVE", "SIDECAR", "DIR"].join("_")],
  ["sidecar cache override", ["HUNSU", "BRIDGE", "SIDECAR", "CACHE", "DIR"].join("_")],
  ["sidecar Node override", ["HUNSU", "BRIDGE", "SIDECAR", "NODE", "VERSION"].join("_")],
  ["single-executable Node override", ["HUNSU", "BRIDGE", "SEA", "NODE", "PATH"].join("_")],
  ["sidecar target override", ["HUNSU", "BRIDGE", "SIDECAR", "TARGET"].join("_")],
  ["bundled sidecar runtime flag", `__${["HUNSU", "BRIDGE", "BUNDLED", "SIDECAR"].join("_")}`]
];

const listed = spawnSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { cwd: repositoryRoot, encoding: "utf8", windowsHide: true }
);

if (listed.error || listed.status !== 0) {
  const detail = listed.error?.message || listed.stderr.trim() || `git ls-files exited with ${listed.status}`;
  console.error(`[no-desktop-prototype] could not enumerate the active tree: ${detail}`);
  process.exit(2);
}

const files = listed.stdout
  .split("\0")
  .map(path => path.replaceAll("\\", "/"))
  .filter(Boolean)
  .filter(path => existsSync(resolve(repositoryRoot, path)));
const violations = [];

for (const path of files) {
  if (allowedFiles.has(path) || allowedPrefixes.some(prefix => path.startsWith(prefix))) {
    continue;
  }

  for (const [label, signature] of signatures) {
    if (path.includes(signature)) {
      violations.push({ path, line: "path", label, signature });
    }
  }

  const bytes = readFileSync(resolve(repositoryRoot, path));
  if (bytes.includes(0)) {
    continue;
  }
  const text = bytes.toString("utf8");
  for (const [label, signature] of signatures) {
    const index = text.indexOf(signature);
    if (index < 0) {
      continue;
    }
    const line = text.slice(0, index).split("\n").length;
    violations.push({ path, line, label, signature });
  }
}

if (violations.length > 0) {
  console.error("[no-desktop-prototype] deprecated desktop infrastructure remains in the active tree:");
  for (const violation of violations) {
    console.error(`  ${violation.path}:${violation.line} [${violation.label}] ${violation.signature}`);
  }
  process.exit(1);
}

console.log(`[no-desktop-prototype] passed (${files.length} active files scanned)`);
