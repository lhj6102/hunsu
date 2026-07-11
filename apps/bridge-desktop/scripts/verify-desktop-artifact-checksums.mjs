#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const directory = resolve(process.argv[2] ?? "");
if (!process.argv[2] || !existsSync(directory) || !statSync(directory).isDirectory()) {
  throw new Error("Desktop artifact checksum verification requires an existing staged directory.");
}

const checksumName = "SHA256SUMS.txt";
const checksumPath = join(directory, checksumName);
if (!existsSync(checksumPath) || !statSync(checksumPath).isFile()) {
  throw new Error(`Missing staged desktop artifact checksum manifest: ${checksumPath}`);
}

const entries = readFileSync(checksumPath, "utf8")
  .split(/\r?\n/u)
  .filter(line => line !== "")
  .map(line => {
    const match = /^([a-f0-9]{64})  ([^\r\n]+)$/u.exec(line);
    if (!match) throw new Error(`Invalid desktop artifact checksum entry: ${line}`);
    const path = match[2];
    const resolvedPath = resolve(directory, ...path.split("/"));
    const relativePath = relative(directory, resolvedPath);
    if (isAbsolute(relativePath) || relativePath === ".." || relativePath.startsWith(`..${sep}`)) {
      throw new Error(`Desktop artifact checksum path escapes the staged directory: ${path}`);
    }
    return { expected: match[1], path, resolvedPath };
  });

const uniquePaths = new Set(entries.map(entry => entry.path));
if (uniquePaths.size !== entries.length) {
  throw new Error("Desktop artifact checksum manifest contains a duplicate path.");
}

const stagedFiles = walk(directory)
  .map(path => relative(directory, path).split(sep).join("/"))
  .filter(path => path !== checksumName)
  .sort();
const manifestFiles = [...uniquePaths].sort();
if (JSON.stringify(stagedFiles) !== JSON.stringify(manifestFiles)) {
  throw new Error("Desktop artifact checksum manifest does not cover every staged file exactly once.");
}

for (const entry of entries) {
  const actual = createHash("sha256").update(readFileSync(entry.resolvedPath)).digest("hex");
  if (actual !== entry.expected) {
    throw new Error(`Desktop artifact checksum mismatch: ${entry.path}`);
  }
}

console.log(`Verified ${entries.length} staged desktop artifact checksum(s) in ${directory}.`);

function walk(root) {
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...walk(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}
