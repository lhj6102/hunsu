#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = resolve(dirname(scriptPath), "..");
const FIVE_MINUTES_MS = 5 * 60 * 1_000;
const DEFAULT_THRESHOLD_MS = 30_000;

const phases = Object.freeze([
  { label: "no-desktop guard", args: ["run", "check:no-desktop-prototype"] },
  { label: "state-boundary guard", args: ["run", "check:bridge-state-boundaries"] },
  { label: "typecheck", args: ["run", "typecheck"] },
  { label: "headless unit and contract tests", args: ["test"] },
  { label: "foreground scenario", args: ["run", "test:headless:scenario"] },
  { label: "Web proxy and direct E2E", args: ["run", "test:e2e:stack"] },
  { label: "npm tarball smoke", args: ["run", "test:package:bridge"] }
]);

export function verificationBudget(env = process.env) {
  const thresholdMs = positiveInteger(env.HUNSU_VERIFY_BRIDGE_THRESHOLD_MS, DEFAULT_THRESHOLD_MS);
  const limitMs = positiveInteger(env.HUNSU_VERIFY_BRIDGE_BUDGET_MS, FIVE_MINUTES_MS + thresholdMs);
  return { targetMs: FIVE_MINUTES_MS, thresholdMs, limitMs };
}

export function formatElapsed(milliseconds) {
  return `${(milliseconds / 1_000).toFixed(2)}s`;
}

export function parseVerifyArguments(argv = process.argv.slice(2)) {
  let enforceBudget = false;
  for (const argument of argv) {
    if (argument === "--enforce-budget") enforceBudget = true;
    else if (argument === "--help" || argument === "-h") return { help: true, enforceBudget: false };
    else throw new Error(`Unknown verify:bridge option: ${argument}`);
  }
  return { help: false, enforceBudget };
}

export function runBridgeVerification(options = {}) {
  const budget = verificationBudget(options.env ?? process.env);
  const startedAt = performance.now();
  const timings = [];

  for (const phase of phases) {
    const phaseStartedAt = performance.now();
    const result = runPnpm(phase.args, options.env ?? process.env);
    const elapsedMs = Math.round(performance.now() - phaseStartedAt);
    timings.push({ label: phase.label, elapsedMs });
    process.stdout.write(`[verify:bridge] ${phase.label}: ${formatElapsed(elapsedMs)}\n`);
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`${phase.label} failed with exit code ${result.status ?? "unknown"}.`);
    }
  }

  const totalMs = Math.round(performance.now() - startedAt);
  process.stdout.write(`[verify:bridge] full local gate: ${formatElapsed(totalMs)}\n`);
  process.stdout.write(
    `[verify:bridge] target ${formatElapsed(budget.targetMs)} + documented threshold ${formatElapsed(budget.thresholdMs)} = ${formatElapsed(budget.limitMs)}\n`
  );
  if (options.enforceBudget === true && totalMs > budget.limitMs) {
    throw new Error(
      `Bridge verification exceeded its ${formatElapsed(budget.limitMs)} CI budget (${formatElapsed(totalMs)}).`
    );
  }
  return { totalMs, timings, budget };
}

function runPnpm(args, env) {
  const npmExecPath = env.npm_execpath;
  if (npmExecPath && /\.(?:c?js|mjs)$/iu.test(npmExecPath)) {
    return spawnSync(process.execPath, [npmExecPath, ...args], {
      cwd: repositoryRoot,
      env,
      stdio: "inherit",
      windowsHide: true
    });
  }
  return spawnSync(process.platform === "win32" ? "pnpm.cmd" : "pnpm", args, {
    cwd: repositoryRoot,
    env,
    stdio: "inherit",
    windowsHide: true,
    shell: process.platform === "win32"
  });
}

function positiveInteger(value, fallback) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("Bridge verification budget values must be positive integer milliseconds.");
  }
  return parsed;
}

function printHelp() {
  process.stdout.write([
    "Usage: pnpm verify:bridge [--enforce-budget]",
    "",
    "Runs the complete local headless Bridge gate after dependencies are installed.",
    "The normal target is five minutes. CI permits a documented 30-second scheduling threshold.",
    ""
  ].join("\n"));
}

if (resolve(process.argv[1] ?? "") === scriptPath) {
  try {
    const options = parseVerifyArguments();
    if (options.help) printHelp();
    else runBridgeVerification({ enforceBudget: options.enforceBudget });
  } catch (error) {
    process.stderr.write(`[verify:bridge] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
