import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertDeployTarget } from "./release-lib.mjs";

export const CLOUDFLARE_RESOURCE_ALLOWLIST_SCHEMA = "hunsu.cloudflare-resource-allowlist.v2";
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const allowlist = JSON.parse(readFileSync(resolve(scriptDirectory, "cloudflare-resources.json"), "utf8"));
if (allowlist.schema !== CLOUDFLARE_RESOURCE_ALLOWLIST_SCHEMA) {
  throw new Error("Invalid committed Cloudflare resource allowlist schema.");
}

export function assertCloudflareResourceAllowlist(targetInput, actual) {
  const target = assertDeployTarget(targetInput);
  const expected = allowlist[target];
  if (!expected || typeof expected !== "object") {
    throw new Error(`Committed Cloudflare resource allowlist is missing ${target}.`);
  }
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (actual[key] !== expectedValue) {
      throw new Error(`Cloudflare ${target} ${key} must match the committed allowlist value.`);
    }
  }
  const unexpected = Object.keys(actual).filter(key => !(key in expected));
  if (unexpected.length > 0) {
    throw new Error(`Cloudflare resource input has unsupported fields: ${unexpected.join(", ")}.`);
  }
  return { ...expected };
}
