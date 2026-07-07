import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const SCAN_ROOTS = ["apps", "packages"];
const ALLOWED_ENV_READ_FILES = new Set([
  "apps/hub-api/scripts/cloudflare-config.mjs",
  "apps/hub-api/scripts/seed-local.mjs",
  "apps/local/src/index.ts",
  "apps/web/scripts/verify-handoffs.mjs",
  "apps/web/vite.config.ts",
  "packages/config/src/index.ts"
]);

test("environment variables are read only at app boundaries and @hunsu/config", () => {
  const offenders = sourceFiles(SCAN_ROOTS.map(path => join(ROOT, path)))
    .filter(file => !ALLOWED_ENV_READ_FILES.has(relative(ROOT, file)))
    .filter(file => {
      const text = readFileSync(file, "utf8");
      return /\bprocess\.env\b|\bimport\.meta\.env\b/.test(text);
    })
    .map(file => relative(ROOT, file));

  assert.deepEqual(offenders, []);
});

function sourceFiles(paths: string[]): string[] {
  const files: string[] = [];
  for (const path of paths) {
    const stat = statSync(path);
    if (stat.isDirectory()) {
      for (const entry of readdirSync(path)) {
        if (entry === "node_modules" || entry === "dist" || entry === ".turbo") {
          continue;
        }
        files.push(...sourceFiles([join(path, entry)]));
      }
    } else if (/\.(?:ts|tsx|mjs)$/.test(path)) {
      files.push(path);
    }
  }
  return files;
}
