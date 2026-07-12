#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  CONNECT_WRANGLER_GENERATED_CONFIG_PATH,
  renderConnectWranglerJson,
  resolveConnectCloudflareConfig
} from "@hunsu/config/cloudflare";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const appRoot = dirname(scriptDir);
const configPath = join(appRoot, CONNECT_WRANGLER_GENERATED_CONFIG_PATH);
const generatedTypesPath = join(appRoot, "src", "worker-configuration.d.ts");
const command = process.argv[2] ?? "print";
const extraArgs = process.argv[3] === "--" ? process.argv.slice(4) : process.argv.slice(3);
const configResult = resolveConnectCloudflareConfig(process.env);

if (!configResult.ok) {
  process.stderr.write(`${configResult.error.message}\n`);
  process.exit(1);
}

const config = configResult.value;

switch (command) {
  case "print":
    process.stdout.write(renderConnectWranglerJson(config));
    break;
  case "write":
    writeConfig();
    process.stdout.write(`${configPath}\n`);
    break;
  case "types":
    writeConfig();
    runWrangler(["types", generatedTypesPath, "--config", configPath]);
    break;
  case "dev":
    writeConfig();
    runWrangler(["dev", "--config", configPath, ...extraArgs]);
    break;
  case "build": {
    writeConfig();
    const output = resolve(extraArgs[0] ?? join(appRoot, ".generated", "connect", "worker.mjs"));
    const bundleDirectory = resolve(`${output}.bundle`);
    const bundledEntry = join(bundleDirectory, "index.js");
    const bundledMetadata = join(bundleDirectory, "bundle-meta.json");
    rmSync(bundleDirectory, { recursive: true, force: true });
    runWrangler(["deploy", "--config", configPath, "--dry-run", "--outdir", bundleDirectory, "--metafile", bundledMetadata]);
    if (!existsSync(bundledEntry)) {
      throw new Error("Wrangler did not emit the Connect Worker index.js bundle.");
    }
    mkdirSync(dirname(output), { recursive: true });
    copyFileSync(bundledEntry, output);
    if (existsSync(bundledMetadata)) copyFileSync(bundledMetadata, `${output}.meta.json`);
    rmSync(bundleDirectory, { recursive: true, force: true });
    break;
  }
  case "deploy":
    writeConfig();
    runWrangler(["deploy", "--config", configPath, ...extraArgs]);
    break;
  case "db:migrate:local":
    writeConfig();
    runWrangler(["d1", "migrations", "apply", config.d1DatabaseName, "--local", "--config", configPath, ...extraArgs]);
    break;
  case "db:migrate:remote":
    writeConfig();
    runWrangler(["d1", "migrations", "apply", config.d1DatabaseName, "--remote", "--config", configPath, ...extraArgs]);
    break;
  default:
    process.stderr.write(`Unknown Connect Cloudflare command: ${command}\n`);
    process.exit(1);
}

function writeConfig() {
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, renderConnectWranglerJson(config), "utf8");
}

function runWrangler(args) {
  const result = spawnSync("pnpm", ["exec", "wrangler", ...args], {
    cwd: appRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      WRANGLER_LOG_PATH: join(appRoot, ".generated", "wrangler.log"),
      WRANGLER_WRITE_LOGS: "false",
      WRANGLER_SEND_METRICS: "false"
    }
  });
  if (result.error) {
    process.stderr.write(`${result.error.message}\n`);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}
