#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  HUB_WRANGLER_GENERATED_CONFIG_PATH,
  renderHubWranglerToml,
  resolveHubCloudflareConfig
} from "@hunsu/config/cloudflare";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const appRoot = dirname(scriptDir);
const configPath = join(appRoot, HUB_WRANGLER_GENERATED_CONFIG_PATH);
const command = process.argv[2] ?? "print";
const extraArgs = process.argv[3] === "--" ? process.argv.slice(4) : process.argv.slice(3);

const configResult = resolveHubCloudflareConfig(process.env);
if (!configResult.ok) {
  console.error(configResult.error.message);
  process.exit(1);
}

const config = configResult.value;
const LOCAL_DEV_ADMIN_TOKEN = "hunsu-local-dev-admin-token";

switch (command) {
  case "print":
    process.stdout.write(renderHubWranglerToml(config));
    break;
  case "write":
    writeGeneratedConfig();
    console.log(configPath);
    break;
  case "dev":
    writeGeneratedConfig();
    if (config.target === "local" && process.env.HUNSU_HUB_SEED_ON_DEV !== "false") {
      const env = localDevEnv();
      runWranglerOrExit(["--config", configPath, "d1", "migrations", "apply", config.d1DatabaseName, "--local"], env);
      startSeedProcess(env);
      runWrangler(["--config", configPath, "dev", ...adminTokenArgs(extraArgs), ...extraArgs], env);
    } else {
      runWrangler(["--config", configPath, "dev", ...extraArgs]);
    }
    break;
  case "deploy":
    writeGeneratedConfig();
    runWrangler(["--config", configPath, "deploy", ...extraArgs]);
    break;
  case "db:migrate:local":
    writeGeneratedConfig();
    runWrangler(["--config", configPath, "d1", "migrations", "apply", config.d1DatabaseName, "--local", ...extraArgs]);
    break;
  case "db:migrate:remote":
    writeGeneratedConfig();
    runWrangler(["--config", configPath, "d1", "migrations", "apply", config.d1DatabaseName, "--remote", ...extraArgs]);
    break;
  default:
    console.error(`Unknown hub-api Cloudflare config command: ${command}`);
    process.exit(1);
}

function writeGeneratedConfig() {
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, renderHubWranglerToml(config), "utf8");
}

function localDevEnv() {
  return {
    ...process.env,
    HUNSU_HUB_ADMIN_TOKEN: process.env.HUNSU_HUB_ADMIN_TOKEN?.trim() || LOCAL_DEV_ADMIN_TOKEN,
    HUNSU_HUB_PUBLIC_API_URL: config.publicHubApiUrl,
    HUNSU_DEPLOY_TARGET: config.target
  };
}

function adminTokenArgs(args) {
  if (args.some((arg, index) =>
    arg.startsWith("HUNSU_HUB_ADMIN_TOKEN:")
      || arg.startsWith("--var=HUNSU_HUB_ADMIN_TOKEN:")
      || (args[index - 1] === "--var" && arg.startsWith("HUNSU_HUB_ADMIN_TOKEN:"))
  )) {
    return [];
  }
  return ["--var", `HUNSU_HUB_ADMIN_TOKEN:${process.env.HUNSU_HUB_ADMIN_TOKEN?.trim() || LOCAL_DEV_ADMIN_TOKEN}`];
}

function startSeedProcess(env) {
  const child = spawn("node", [join(scriptDir, "seed-local.mjs")], {
    cwd: appRoot,
    stdio: ["ignore", "inherit", "inherit"],
    env
  });
  child.on("error", error => {
    console.error(error.message);
  });
}

function runWrangler(args, env = process.env) {
  const result = spawnSync("pnpm", ["exec", "wrangler", ...args], {
    cwd: appRoot,
    stdio: "inherit",
    env
  });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}

function runWranglerOrExit(args, env = process.env) {
  const result = spawnSync("pnpm", ["exec", "wrangler", ...args], {
    cwd: appRoot,
    stdio: "inherit",
    env
  });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
