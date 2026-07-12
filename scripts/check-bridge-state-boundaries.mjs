import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bridgeSourceRoot = join(repositoryRoot, "apps", "bridge", "src");
const clientRoot = join(bridgeSourceRoot, "client");
const violations = [];

const clientFiles = (await walkTypeScript(clientRoot)).sort();
for (const file of clientFiles) {
  const source = await readFile(file, "utf8");
  const label = relative(repositoryRoot, file);
  for (const specifier of importSpecifiers(source)) {
    if (/(?:^|\/)daemon\//u.test(specifier)
      || /(?:^|\/)setup\//u.test(specifier)
      || /(?:^|\/)service\//u.test(specifier)) {
      violations.push(`${label} imports lifecycle code: ${specifier}`);
    }
    if (specifier.startsWith("../state/")
      && !specifier.endsWith("/atomicJsonStore.ts")
      && !specifier.endsWith("/controlStateReader.ts")
      && !specifier.endsWith("/paths.ts")) {
      violations.push(`${label} imports a state writer module: ${specifier}`);
    }
  }
  for (const symbol of [
    "createConfigStore",
    "createCredentialStore",
    "createWorkspaceStore",
    "createRuntimeStore",
    "createRuntimeInstallStore",
    "startBridgeDaemon",
    "runBridgeDaemon"
  ]) {
    if (new RegExp(`\\b${symbol}\\b`, "u").test(source)) {
      violations.push(`${label} references forbidden lifecycle/state symbol ${symbol}`);
    }
  }
  if (/\b(?:configStore|workspaceStore|credentialStore|runtimeStore|installStore)\s*\.\s*(?:write|update|clear|ensure|rotateControlToken)\s*\(/u.test(source)) {
    violations.push(`${label} calls an application-state mutator`);
  }
}

const runtimeFiles = await walkTypeScript(bridgeSourceRoot);
for (const file of runtimeFiles) {
  const label = relative(repositoryRoot, file);
  if (label === "apps/bridge/src/daemon/daemon.ts" || label === "apps/bridge/src/state/runtimeStore.ts") continue;
  const source = await readFile(file, "utf8");
  if (/\bruntimeStore\s*\.\s*(?:write|clear)\s*\(/u.test(source)) {
    violations.push(`${label} mutates daemon-owned runtime identity`);
  }
}

const clientCommandsFile = join(clientRoot, "clientCommands.ts");
const clientCommands = await readFile(clientCommandsFile, "utf8");
for (const route of [
  "/v1/control/provider",
  "/v1/control/workspaces",
  "/v1/control/pair"
]) {
  if (!clientCommands.includes(route)) {
    violations.push(`apps/bridge/src/client/clientCommands.ts is missing control route ${route}`);
  }
}

if (violations.length > 0) {
  console.error("[bridge-state-boundaries] violations found:");
  for (const violation of violations) console.error(`- ${violation}`);
  process.exitCode = 1;
} else {
  console.log(`[bridge-state-boundaries] passed (${clientFiles.length} client modules scanned)`);
}

async function walkTypeScript(root) {
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await walkTypeScript(path));
    else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(path);
  }
  return files;
}

function importSpecifiers(source) {
  return [
    ...source.matchAll(/\bfrom\s+["']([^"']+)["']/gu),
    ...source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu)
  ].map(match => match[1]);
}
