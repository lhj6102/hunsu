import { readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findRetiredOriginReferences, retiredOrigin } from "./retired-origin-scan.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const errors = [];
const workerName = "hunsu-plugin-production";
const origin = "https://plugin.hunsu.app";
const requiredDynamicPaths = ["/api/*", "/oauth/*", "/.well-known/*", "/mcp"];
const requiredSecrets = [
  "HUNSU_GITHUB_CLIENT_SECRET",
  "HUNSU_GITHUB_PRIVATE_KEY",
  "HUNSU_GITHUB_WEBHOOK_SECRET",
  "HUNSU_SESSION_SECRET"
];

if (process.argv.length !== 2) {
  console.error("Usage: node validate-production-contract.mjs");
  process.exitCode = 1;
} else {
const wrangler = await readJsonc(resolve(repoRoot, "wrangler.jsonc"));
const plugin = await readJson(resolve(repoRoot, "plugins/hunsu/.mcp.json"));

if (wrangler) validateWrangler(wrangler);
if (plugin) validatePlugin(plugin);
await validateRetiredOriginIsAbsent();

if (errors.length > 0) {
  errors.forEach(error => console.error(`- ${error}`));
  console.error(`Production contract validation failed with ${errors.length} issue(s).`);
  process.exitCode = 1;
} else {
  console.log("Production contract validated: Worker, custom domain, dynamic routes, secrets, and Plugin endpoint.");
}
}

function validateWrangler(value) {
  if (!isObject(value)) return issue("wrangler.jsonc must contain a JSON object.");
  equal(value.name, workerName, "Worker name");
  equal(value.main, "apps/api/src/cloudflare.ts", "Worker entrypoint");
  if (!Array.isArray(value.compatibility_flags) || !value.compatibility_flags.includes("nodejs_compat")) {
    issue("Wrangler compatibility_flags must include nodejs_compat.");
  }
  if (typeof value.compatibility_date !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value.compatibility_date)) {
    issue("Wrangler compatibility_date must be an explicit ISO date.");
  }
  equal(value.workers_dev, false, "workers_dev");

  if (!isObject(value.assets)) {
    issue("Wrangler assets configuration is missing.");
  } else {
    equal(value.assets.directory, "./apps/web/dist", "assets.directory");
    equal(value.assets.binding, "ASSETS", "assets.binding");
    equal(value.assets.not_found_handling, "single-page-application", "assets.not_found_handling");
    const paths = Array.isArray(value.assets.run_worker_first) ? value.assets.run_worker_first : [];
    for (const path of requiredDynamicPaths) {
      if (!paths.includes(path)) issue(`assets.run_worker_first does not cover ${path}.`);
    }
  }

  if (!isObject(value.vars)) {
    issue("Wrangler vars configuration is missing.");
  } else {
    equal(value.vars.HUNSU_PUBLIC_API_URL, origin, "HUNSU_PUBLIC_API_URL");
    equal(value.vars.HUNSU_WEB_URL, origin, "HUNSU_WEB_URL");
    for (const name of ["HUNSU_GITHUB_APP_ID", "HUNSU_GITHUB_CLIENT_ID", "HUNSU_GITHUB_APP_SLUG"]) {
      equal(value.vars[name], "__HUNSU_PRODUCTION_ENVIRONMENT__", `${name} repository placeholder`);
    }
  }

  const configuredSecrets = isObject(value.secrets) && Array.isArray(value.secrets.required)
    ? value.secrets.required
    : [];
  if (JSON.stringify([...configuredSecrets].sort()) !== JSON.stringify([...requiredSecrets].sort())) {
    issue("Wrangler required secrets must contain exactly the four hunsu-production runtime secrets.");
  }

  const bindings = isObject(value.durable_objects) && Array.isArray(value.durable_objects.bindings)
    ? value.durable_objects.bindings
    : [];
  if (!bindings.some(binding => isObject(binding)
    && binding.name === "EPHEMERAL_STATE"
    && binding.class_name === "HunsuEphemeralState")) {
    issue("Wrangler must bind EPHEMERAL_STATE to HunsuEphemeralState.");
  }
  const migrations = Array.isArray(value.migrations) ? value.migrations : [];
  if (!migrations.some(migration => isObject(migration)
    && migration.tag === "v1"
    && Array.isArray(migration.new_sqlite_classes)
    && migration.new_sqlite_classes.includes("HunsuEphemeralState"))) {
    issue("Wrangler must declare the v1 SQLite Durable Object migration.");
  }
  const routes = Array.isArray(value.routes) ? value.routes : [];
  if (routes.length !== 1 || !isObject(routes[0])
    || routes[0].pattern !== "plugin.hunsu.app"
    || routes[0].custom_domain !== true) {
    issue("Wrangler must declare plugin.hunsu.app as its sole custom domain.");
  }
  if (!isObject(value.observability) || value.observability.enabled !== true) {
    issue("Wrangler observability must be enabled for production.");
  } else {
    if (!isObject(value.observability.logs)
      || value.observability.logs.enabled !== true
      || value.observability.logs.invocation_logs !== false) {
      issue("Wrangler logs must disable invocation logs so OAuth callback query values are not retained.");
    }
    if (!isObject(value.observability.traces) || value.observability.traces.enabled !== false) {
      issue("Wrangler traces must be explicitly disabled for OAuth callback safety.");
    }
  }
}

function validatePlugin(value) {
  const server = isObject(value)
    && isObject(value.mcpServers)
    && Object.keys(value.mcpServers).length === 1
    ? value.mcpServers.hunsu
    : undefined;
  if (!isObject(server)) return issue("Plugin MCP config must contain exactly one hunsu server.");
  equal(server.url, `${origin}/mcp`, "Plugin MCP endpoint");
  equal(server.auth, "oauth", "Plugin MCP auth");
  equal(server.oauth_resource, `${origin}/mcp`, "Plugin OAuth resource");
}

async function validateRetiredOriginIsAbsent() {
  for (const path of await findRetiredOriginReferences(repoRoot)) {
    issue(`${path} still refers to retired production origin ${retiredOrigin}.`);
  }
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    issue(`${relative(repoRoot, path)} is not valid JSON: ${error instanceof Error ? error.message : "unknown error"}`);
  }
}

async function readJsonc(path) {
  try {
    const source = await readFile(path, "utf8");
    return JSON.parse(stripJsonComments(source));
  } catch (error) {
    issue(`${relative(repoRoot, path)} is not valid JSONC: ${error instanceof Error ? error.message : "unknown error"}`);
  }
}

function stripJsonComments(source) {
  let output = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (inString) {
      output += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
    } else if (character === '"') {
      inString = true;
      output += character;
    } else if (character === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") index += 1;
      output += "\n";
    } else if (character === "/" && next === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) index += 1;
      index += 1;
    } else {
      output += character;
    }
  }
  return output;
}

function equal(actual, expected, label) {
  if (actual !== expected) issue(`${label} must be ${JSON.stringify(expected)}.`);
}

function issue(message) {
  errors.push(message);
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
