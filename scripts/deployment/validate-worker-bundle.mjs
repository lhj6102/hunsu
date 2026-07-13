import { readFile, readdir } from "node:fs/promises";
import { dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const forbiddenInputs = [
  "apps/api/src/main.ts",
  "apps/api/src/runtime.ts",
  "apps/api/src/server.ts"
];
const forbiddenBundleMarkers = [
  "node:http",
  "createHunsuNodeServer",
  "Hunsu API listening on",
  "ADAPTER_BODY_LIMIT",
  ...forbiddenInputs
];

try {
  const args = parseArgs(process.argv.slice(2));
  const bundleDir = resolve(args.get("--bundle-dir") ?? resolve(repoRoot, ".artifacts/worker-bundle"));
  const metafilePath = resolve(args.get("--metafile") ?? resolve(repoRoot, ".artifacts/worker-bundle-meta.json"));
  const metafile = JSON.parse(await readFile(metafilePath, "utf8"));
  const inputNames = isObject(metafile.inputs) ? Object.keys(metafile.inputs).map(normalizePath) : [];
  if (inputNames.length === 0) throw new Error("Worker metafile contains no inputs.");
  for (const forbidden of forbiddenInputs) {
    if (inputNames.some(input => input.endsWith(forbidden))) {
      throw new Error(`Worker bundle includes the Node adapter input ${forbidden}.`);
    }
  }
  if (!inputNames.some(input => input.endsWith("apps/api/src/cloudflare.ts"))) {
    throw new Error("Worker bundle metafile does not include apps/api/src/cloudflare.ts.");
  }

  const bundleFiles = (await walk(bundleDir)).filter(path => [".js", ".mjs", ".cjs"].includes(extname(path)));
  if (bundleFiles.length === 0) throw new Error("Worker dry-run produced no JavaScript bundle.");
  for (const path of bundleFiles) {
    const source = await readFile(path, "utf8");
    for (const marker of forbiddenBundleMarkers) {
      if (source.includes(marker)) {
        throw new Error(`${relative(repoRoot, path)} contains forbidden Node adapter marker ${marker}.`);
      }
    }
  }
  console.log(`Worker bundle validated across ${inputNames.length} input(s) and ${bundleFiles.length} output file(s).`);
} catch (error) {
  console.error(error instanceof Error ? error.message : "Worker bundle validation failed.");
  process.exitCode = 1;
}

async function walk(root) {
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) files.push(...await walk(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

function parseArgs(values) {
  const result = new Map();
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if ((key !== "--bundle-dir" && key !== "--metafile") || value === undefined) {
      throw new Error(`Unknown or incomplete argument: ${key ?? "<missing>"}`);
    }
    if (result.has(key)) throw new Error(`Duplicate argument: ${key}.`);
    result.set(key, value);
  }
  return result;
}

function normalizePath(value) {
  return value.replaceAll("\\", "/");
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
