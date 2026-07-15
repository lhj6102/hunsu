import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep
} from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pluginRoot = resolve(repoRoot, "plugins/hunsu");
const manifestPath = resolve(pluginRoot, ".codex-plugin/plugin.json");
const mcpPath = resolve(pluginRoot, ".mcp.json");
const marketplacePath = resolve(repoRoot, ".agents/plugins/marketplace.json");
const expectedSkills = [
  "hunsu-project",
  "hunsu-run",
  "hunsu-coach",
  "hunsu-diverge"
];
const errors = [];

const manifest = readJson(manifestPath, "plugin manifest");
const marketplace = readJson(marketplacePath, "repository marketplace");
const mcpConfig = readJson(mcpPath, "MCP configuration");

if (manifest !== undefined) {
  validateManifest(manifest);
  validateNoCredentialFields(manifest, "plugin manifest");
}
if (marketplace !== undefined) {
  validateMarketplace(marketplace);
  validateNoCredentialFields(marketplace, "repository marketplace");
}
if (mcpConfig !== undefined) {
  validateMcpConfig(mcpConfig);
  validateNoCredentialFields(mcpConfig, "MCP configuration");
}

validateSkills();
validateRepositoryText();

if (errors.length > 0) {
  for (const error of errors) {
    console.error("- " + error);
  }
  console.error("Hunsu plugin validation failed with " + errors.length + " issue(s).");
  process.exitCode = 1;
} else {
  console.log("Hunsu plugin validation passed: manifest, marketplace, MCP OAuth, and four v2 skills.");
}

function validateManifest(value) {
  if (!isObject(value)) {
    issue("Plugin manifest must be a JSON object.");
    return;
  }
  if (value.name !== basename(pluginRoot)) {
    issue("Plugin manifest name must match the plugin directory name.");
  }
  if (typeof value.version !== "string" || value.version.trim() === "") {
    issue("Plugin manifest must declare a non-empty version.");
  }
  validatePluginReference(value.skills, "skills", "directory");
  validatePluginReference(value.mcpServers, "mcpServers", "file");
}

function validatePluginReference(value, field, kind) {
  if (typeof value !== "string" || value.trim() === "") {
    issue("Plugin manifest " + field + " must be a relative path.");
    return;
  }
  if (isAbsolute(value)) {
    issue("Plugin manifest " + field + " must not be absolute.");
    return;
  }
  const target = resolve(pluginRoot, value);
  if (!isWithin(pluginRoot, target)) {
    issue("Plugin manifest " + field + " must stay inside the plugin directory.");
    return;
  }
  if (!existsSync(target)) {
    issue("Plugin manifest " + field + " path does not exist: " + value);
    return;
  }
  const stat = lstatSync(target);
  if (stat.isSymbolicLink()) {
    issue("Plugin manifest " + field + " path must not be a symbolic link.");
  } else if (kind === "directory" && !stat.isDirectory()) {
    issue("Plugin manifest " + field + " must reference a directory.");
  } else if (kind === "file" && !stat.isFile()) {
    issue("Plugin manifest " + field + " must reference a file.");
  }
}

function validateMarketplace(value) {
  if (!isObject(value) || !Array.isArray(value.plugins)) {
    issue("Repository marketplace must contain a plugins array.");
    return;
  }
  const entries = value.plugins.filter(entry => isObject(entry) && entry.name === "hunsu");
  if (entries.length !== 1) {
    issue("Repository marketplace must contain exactly one Hunsu plugin entry.");
    return;
  }

  const entry = entries[0];
  if (
    !isObject(entry.source)
    || entry.source.source !== "local"
    || entry.source.path !== "./plugins/hunsu"
  ) {
    issue("Hunsu marketplace source must be the repository-local ./plugins/hunsu path.");
  } else {
    const source = resolve(repoRoot, entry.source.path);
    if (!isWithin(repoRoot, source) || source !== pluginRoot || !existsSync(source)) {
      issue("Hunsu marketplace source does not resolve to plugins/hunsu.");
    }
  }

  if (
    !isObject(entry.policy)
    || !["AVAILABLE", "INSTALLED_BY_DEFAULT"].includes(entry.policy.installation)
    || !["ON_INSTALL", "ON_USE"].includes(entry.policy.authentication)
  ) {
    issue("Hunsu marketplace policy must declare supported installation and authentication values.");
  }
}

function validateMcpConfig(value) {
  if (!isObject(value) || !isObject(value.mcpServers)) {
    issue("MCP configuration must contain an mcpServers object.");
    return;
  }
  const names = Object.keys(value.mcpServers);
  if (names.length !== 1 || names[0] !== "hunsu") {
    issue("MCP configuration must declare exactly one server named hunsu.");
    return;
  }
  const server = value.mcpServers.hunsu;
  if (!isObject(server)) {
    issue("Hunsu MCP server configuration must be an object.");
    return;
  }
  const url = parseHttpsUrl(server.url, "Hunsu MCP URL");
  const oauthResource = parseHttpsUrl(server.oauth_resource, "Hunsu MCP OAuth resource");
  if (url !== undefined && !url.pathname.endsWith("/mcp")) {
    issue("Hunsu MCP URL path must end in /mcp.");
  }
  if (server.auth !== "oauth") {
    issue("Hunsu MCP server must use OAuth authentication.");
  }
  if (url !== undefined && oauthResource !== undefined && url.href !== oauthResource.href) {
    issue("Hunsu MCP OAuth resource must equal the canonical MCP URL.");
  }

  const forbiddenKeys = [
    "apikey",
    "authorization",
    "clientsecret",
    "headers",
    "password",
    "privatekey",
    "token"
  ];
  for (const key of Object.keys(server)) {
    if (forbiddenKeys.includes(key.toLowerCase().replace(/[^a-z]/gu, ""))) {
      issue("Hunsu MCP configuration must not embed credentials or authorization headers.");
    }
  }
}

function validateSkills() {
  const skillsRoot = resolve(pluginRoot, "skills");
  if (!existsSync(skillsRoot)) {
    issue("Plugin skills directory is missing.");
    return;
  }
  const actual = readdirSync(skillsRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort();
  const expected = [...expectedSkills].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    issue("Plugin must contain exactly the four expected Hunsu v2 skill directories.");
  }

  for (const skillName of expectedSkills) {
    const skillPath = resolve(skillsRoot, skillName, "SKILL.md");
    if (!existsSync(skillPath)) {
      issue("Missing skill definition: skills/" + skillName + "/SKILL.md");
      continue;
    }
    const source = readFileSync(skillPath, "utf8");
    const frontmatter = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u);
    if (frontmatter === null) {
      issue("Skill " + skillName + " must start with YAML frontmatter.");
      continue;
    }
    const fields = parseFlatFrontmatter(frontmatter[1]);
    if (fields.name !== skillName) {
      issue("Skill " + skillName + " frontmatter name must match its directory.");
    }
    if (typeof fields.description !== "string" || fields.description.trim() === "") {
      issue("Skill " + skillName + " must have a non-empty frontmatter description.");
    }
  }
}

function validateRepositoryText() {
  const files = [...walkFiles(pluginRoot), marketplacePath].filter(existsSync);
  for (const path of files) {
    const stat = lstatSync(path);
    if (!stat.isFile()) {
      continue;
    }
    const source = readFileSync(path, "utf8");
    const label = relative(repoRoot, path);
    if (/\bTODO\b|\[TODO:/iu.test(source)) {
      issue(label + " contains an unresolved TODO.");
    }
    if (
      /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/u.test(source)
      || /\bgh(?:p|o|u|s|r)_[A-Za-z0-9_]{20,}\b/u.test(source)
      || /\bgithub_pat_[A-Za-z0-9_]{20,}\b/u.test(source)
      || /\bBearer\s+[A-Za-z0-9._~-]{16,}\b/iu.test(source)
    ) {
      issue(label + " appears to contain an embedded credential.");
    }
  }
}

function validateNoCredentialFields(value, label, path = []) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      validateNoCredentialFields(entry, label, [...path, String(index)]);
    });
    return;
  }
  if (!isObject(value)) {
    return;
  }

  const forbiddenKeys = [
    "apikey",
    "authorization",
    "clientsecret",
    "headers",
    "password",
    "privatekey",
    "secret",
    "token",
    "webhooksecret"
  ];
  for (const [key, entry] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase().replace(/[^a-z]/gu, "");
    if (forbiddenKeys.includes(normalizedKey)) {
      issue(
        label
        + " must not contain credential field "
        + [...path, key].join(".")
        + "."
      );
    }
    validateNoCredentialFields(entry, label, [...path, key]);
  }
}

function parseHttpsUrl(value, label) {
  if (typeof value !== "string") {
    issue(label + " must be an HTTPS URL.");
    return undefined;
  }
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:"
      || url.username !== ""
      || url.password !== ""
      || url.search !== ""
      || url.hash !== ""
    ) {
      throw new Error("unsafe URL");
    }
    return url;
  } catch {
    issue(label + " must be a credential-free HTTPS URL without a query or fragment.");
    return undefined;
  }
}

function parseFlatFrontmatter(source) {
  const fields = {};
  for (const line of source.split(/\r?\n/u)) {
    const match = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/u);
    if (match !== null) {
      fields[match[1]] = match[2].trim();
    }
  }
  return fields;
}

function readJson(path, label) {
  if (!existsSync(path)) {
    issue("Missing " + label + ": " + relative(repoRoot, path));
    return undefined;
  }
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    issue("Invalid JSON in " + label + ": " + relative(repoRoot, path));
    return undefined;
  }
}

function* walkFiles(root) {
  if (!existsSync(root)) {
    return;
  }
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) {
      yield* walkFiles(path);
    } else if (entry.isFile()) {
      yield path;
    } else if (entry.isSymbolicLink()) {
      issue(relative(repoRoot, path) + " must not be a symbolic link.");
    }
  }
}

function isWithin(root, target) {
  const path = relative(root, target);
  return path === "" || (!path.startsWith(".." + sep) && path !== ".." && !isAbsolute(path));
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function issue(message) {
  errors.push(message);
}
