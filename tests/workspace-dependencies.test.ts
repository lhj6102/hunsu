import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, extname, join, relative, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");

test("protocol and core remain pure domain packages", () => {
  const protocolImports = importsUnder("packages/protocol/src");
  assert.deepEqual(
    protocolImports.filter(entry => !entry.specifier.startsWith(".")),
    [],
    "protocol may import only its own relative modules"
  );

  const coreImports = importsUnder("packages/core/src");
  assert.deepEqual(
    coreImports.filter(entry => !entry.specifier.startsWith(".") && entry.specifier !== "@hunsu/protocol"),
    [],
    "core may depend only on protocol and its own relative modules"
  );
  assert.deepEqual(workspaceDependencies("packages/protocol/package.json"), []);
  assert.deepEqual(workspaceDependencies("packages/core/package.json"), ["@hunsu/protocol"]);
});

test("github-store imports only the protocol-owned Node payload envelope contract", () => {
  const imports = importsUnder("packages/github-store/src");
  const workspaceImports = imports.filter(entry => entry.specifier.startsWith("@hunsu/"));
  assert.deepEqual(workspaceImports, [{ file: "packages/github-store/src/node-envelope.ts", specifier: "@hunsu/protocol" }]);
  assert.deepEqual(workspaceDependencies("packages/github-store/package.json"), ["@hunsu/protocol"]);

  const envelopeSource = readFileSync(join(root, "packages/github-store/src/node-envelope.ts"), "utf8");
  const protocolImport = /import\s*\{([\s\S]*?)\}\s*from\s*"@hunsu\/protocol"/u.exec(envelopeSource);
  assert.ok(protocolImport, "node-envelope.ts must consume the protocol envelope contract");
  const importedNames = protocolImport[1]!.split(",")
    .map(name => name.trim().replace(/^type\s+/u, "").split(/\s+as\s+/u)[0]!)
    .filter(Boolean)
    .sort();
  assert.deepEqual(importedNames, [
    "MAX_NODE_PAYLOAD_DECODED_BYTES",
    "MAX_NODE_PAYLOAD_ENCODED_BYTES",
    "NODE_PAYLOAD_CODEC",
    "NODE_PAYLOAD_ENVELOPE_SCHEMA",
    "NodePayload",
    "NodePayloadDigest",
    "NodePayloadEnvelope",
    "NonNegativeInteger",
    "computeNodePayloadDigest"
  ].sort());
});

test("read models, registries, plugin contracts, and Web preserve package direction", () => {
  assert.deepEqual(nonRelativeWorkspaceImports("packages/projections/src"), ["@hunsu/protocol"]);
  assert.deepEqual(nonRelativeWorkspaceImports("packages/protocol-registry/src"), ["@hunsu/protocol"]);
  assert.deepEqual(nonRelativeWorkspaceImports("packages/plugin-contract/src"), []);
  assert.deepEqual(nonRelativeWorkspaceImports("apps/web/src"), []);

  assert.deepEqual(workspaceDependencies("packages/projections/package.json"), ["@hunsu/protocol"]);
  assert.deepEqual(workspaceDependencies("packages/protocol-registry/package.json"), ["@hunsu/protocol"]);
  assert.deepEqual(workspaceDependencies("packages/plugin-contract/package.json"), []);
  assert.deepEqual(workspaceDependencies("apps/web/package.json"), ["@hunsu/config"]);
});

function nonRelativeWorkspaceImports(directory: string): string[] {
  return [...new Set(importsUnder(directory)
    .map(entry => entry.specifier)
    .filter(specifier => specifier.startsWith("@hunsu/")))].sort();
}

function importsUnder(directory: string): Array<{ file: string; specifier: string }> {
  return sourceFiles(join(root, directory)).flatMap(file => {
    const source = readFileSync(file, "utf8");
    return importSpecifiers(source).map(specifier => ({ file: relative(root, file), specifier }));
  }).sort((left, right) => left.file.localeCompare(right.file) || left.specifier.localeCompare(right.specifier));
}

function importSpecifiers(source: string): string[] {
  const matches = source.matchAll(/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)["']([^"']+)["']/gu);
  return [...matches].map(match => match[1]!);
}

function workspaceDependencies(manifestPath: string): string[] {
  const manifest = JSON.parse(readFileSync(join(root, manifestPath), "utf8")) as Record<string, unknown>;
  const names = new Set<string>();
  for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    const entries = manifest[field];
    if (!entries || typeof entries !== "object" || Array.isArray(entries)) continue;
    for (const [name, version] of Object.entries(entries)) {
      if (typeof version === "string" && version.startsWith("workspace:")) names.add(name);
    }
  }
  return [...names].sort();
}

function sourceFiles(directory: string): string[] {
  return walk(directory).filter(file => [".ts", ".tsx", ".js", ".mjs"].includes(extname(file)));
}

function walk(directory: string): string[] {
  if (!existsSync(directory)) return [];
  const output: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "dist" || entry.name === "node_modules") continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) output.push(...walk(path));
    else if (entry.isFile() && basename(path) !== "worker-configuration.d.ts") output.push(path);
  }
  return output;
}
