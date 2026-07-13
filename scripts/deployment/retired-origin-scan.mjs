import { readFile, readdir } from "node:fs/promises";
import { extname, relative, resolve } from "node:path";

const scanRoots = ["apps", "packages", "plugins", ".github/workflows", "scripts/deployment"];
const scannedExtensions = new Set([
  ".css",
  ".html",
  ".js",
  ".jsx",
  ".json",
  ".jsonc",
  ".md",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml"
]);

export const retiredOrigin = ["api", "hunsu", "app"].join(".");

export async function findRetiredOriginReferences(repoRoot) {
  const files = [resolve(repoRoot, "wrangler.jsonc")];
  for (const root of scanRoots) files.push(...await walk(resolve(repoRoot, root)));

  const references = [];
  for (const file of files) {
    if (!scannedExtensions.has(extname(file))) continue;
    const source = await readFile(file, "utf8");
    if (source.includes(retiredOrigin)) references.push(relative(repoRoot, file));
  }
  return references.sort();
}

async function walk(root) {
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) files.push(...await walk(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}
