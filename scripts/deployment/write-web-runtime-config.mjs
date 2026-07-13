import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export function renderWebRuntimeConfig(sourceSha) {
  const normalizedSha = normalizeSourceSha(sourceSha);
  return `window.__HUNSU_WEB_RUNTIME_CONFIG__ = Object.freeze({\n  schema: "hunsu.web-runtime-config.v3",\n  target: "production",\n  sourceSha: "${normalizedSha}",\n  apiBaseUrl: ""\n});\n`;
}

export function parseWebRuntimeConfig(source) {
  const match = source.match(/^window\.__HUNSU_WEB_RUNTIME_CONFIG__ = Object\.freeze\(\{\n  schema: "hunsu\.web-runtime-config\.v3",\n  target: "production",\n  sourceSha: "([0-9a-f]{40}|[0-9a-f]{64})",\n  apiBaseUrl: ""\n\}\);\n$/u);
  if (match === null) {
    throw new Error("Runtime config does not match the exact production overlay contract.");
  }
  return {
    schema: "hunsu.web-runtime-config.v3",
    target: "production",
    sourceSha: match[1],
    apiBaseUrl: ""
  };
}

function normalizeSourceSha(value) {
  const sourceSha = value.trim().toLowerCase();
  if (!SHA_PATTERN.test(sourceSha)) {
    throw new Error("sourceSha must be a complete 40- or 64-character Git commit SHA.");
  }
  return sourceSha;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sourceSha = args.get("--source-sha") ?? process.env.GITHUB_SHA ?? "";
  const output = resolve(args.get("--output") ?? resolve(repoRoot, "apps/web/dist/hunsu-runtime-config.js"));
  const expectedOutput = resolve(repoRoot, "apps/web/dist/hunsu-runtime-config.js");
  if (!args.has("--output") && output !== expectedOutput) {
    throw new Error("Default runtime config output escaped apps/web/dist.");
  }
  const contents = renderWebRuntimeConfig(sourceSha);
  await mkdir(dirname(output), { recursive: true });
  const temporary = `${output}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, contents, { encoding: "utf8", mode: 0o644, flag: "wx" });
    await rename(temporary, output);
  } finally {
    await rm(temporary, { force: true });
  }
  console.log(`Wrote credential-free production Web runtime config for ${normalizeSourceSha(sourceSha)}.`);
}

function parseArgs(values) {
  const result = new Map();
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if ((key !== "--source-sha" && key !== "--output") || value === undefined) {
      throw new Error(`Unknown or incomplete argument: ${key ?? "<missing>"}`);
    }
    if (result.has(key)) throw new Error(`Duplicate argument: ${key}.`);
    result.set(key, value);
  }
  return result;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : "Failed to write Web runtime config.");
    process.exitCode = 1;
  });
}
