#!/usr/bin/env node
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MODES = new Set(["ready", "login-required", "unsupported-model"]);
const scriptPath = fileURLToPath(import.meta.url);

export function resolveFakeCodexOptions(argv = process.argv.slice(2), env = process.env) {
  let mode = env.HUNSU_FAKE_CODEX_MODE?.trim() || "ready";
  let response = env.HUNSU_FAKE_CODEX_RESPONSE ?? "Deterministic fake Codex response.";
  let delayMs = finiteDelay(env.HUNSU_FAKE_CODEX_DELAY_MS);
  const commands = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--mode") mode = argv[++index] ?? "";
    else if (argument.startsWith("--mode=")) mode = argument.slice("--mode=".length);
    else if (argument === "--response") response = argv[++index] ?? "";
    else if (argument.startsWith("--response=")) response = argument.slice("--response=".length);
    else if (argument === "--delay-ms") delayMs = finiteDelay(argv[++index]);
    else if (argument.startsWith("--delay-ms=")) delayMs = finiteDelay(argument.slice("--delay-ms=".length));
    else commands.push(argument);
  }
  if (!MODES.has(mode)) throw new Error(`Unknown fake Codex mode: ${mode}`);
  return { mode, response, delayMs, commands };
}

export async function runFakeCodex(argv = process.argv.slice(2), env = process.env) {
  const options = resolveFakeCodexOptions(argv, env);
  if (options.commands.includes("--version")) {
    process.stdout.write("codex-cli 0.0.0-fake\n");
    return 0;
  }
  if (options.commands.includes("status")) {
    const status = options.mode === "ready"
      ? { ready: true, mode: options.mode }
      : { ready: false, mode: options.mode, reason: options.mode };
    process.stdout.write(`${JSON.stringify(status)}\n`);
    return options.mode === "ready" ? 0 : 2;
  }
  if (options.commands.includes("app-server")) {
    await runAppServer(options);
    return 0;
  }
  process.stderr.write("Usage: fake-codex.mjs --version | status | app-server [--stdio] [--mode <mode>]\n");
  return 64;
}

async function runAppServer(options) {
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let threadOrdinal = 0;
  let turnOrdinal = 0;
  for await (const line of input) {
    if (!line.trim()) continue;
    let request;
    try {
      request = JSON.parse(line);
    } catch (_error) {
      process.stdout.write(`${JSON.stringify({ error: { code: -32700, message: "Parse error" } })}\n`);
      continue;
    }
    if (request.id === undefined || typeof request.method !== "string") continue;
    if (options.delayMs > 0) await delay(options.delayMs);
    const response = appServerResponse(request, options, {
      nextThreadId: () => `fake-thread-${++threadOrdinal}`,
      nextTurnId: () => `fake-turn-${++turnOrdinal}`
    });
    process.stdout.write(`${JSON.stringify({ id: request.id, ...response })}\n`);
  }
}

export function appServerResponse(request, options, ids = {
  nextThreadId: () => "fake-thread-1",
  nextTurnId: () => "fake-turn-1"
}) {
  switch (request.method) {
    case "initialize":
      return {
        result: {
          protocolVersion: "fake-codex-app-server-v1",
          serverInfo: { name: "hunsu-fake-codex", version: "0.0.0-fake" },
          capabilities: {}
        }
      };
    case "account/read":
      return options.mode === "login-required"
        ? rpcError(-32001, "Codex login is required.")
        : { result: { account: { type: "chatgpt", email: "fixture@example.invalid" } } };
    case "account/rateLimits/read":
      return options.mode === "login-required"
        ? rpcError(-32001, "Codex login is required.")
        : { result: { primary: { usedPercent: 0, resetsAt: null } } };
    case "model/list":
      return { result: { models: [{ id: "fake-codex-model", displayName: "Fake Codex Model" }] } };
    case "thread/start":
      return options.mode === "unsupported-model"
        ? rpcError(-32002, "Selected model is unsupported by the fake Codex fixture.")
        : { result: { thread: { id: ids.nextThreadId() } } };
    case "thread/resume":
      return { result: { thread: { id: request.params?.threadId ?? ids.nextThreadId() } } };
    case "thread/goal/set":
    case "thread/goal/clear":
    case "thread/backgroundTerminals/clean":
    case "turn/interrupt":
      return { result: { ok: true } };
    case "turn/start": {
      if (options.mode === "unsupported-model") {
        return rpcError(-32002, "Selected model is unsupported by the fake Codex fixture.");
      }
      const turnId = ids.nextTurnId();
      return {
        result: {
          turn: {
            id: turnId,
            status: "completed",
            items: [{ id: `${turnId}-message`, type: "agentMessage", text: options.response }]
          }
        }
      };
    }
    default:
      return rpcError(-32601, `Unsupported fake Codex method: ${request.method}`);
  }
}

function rpcError(code, message) {
  return { error: { code, message } };
}

function finiteDelay(value) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.min(30_000, Math.trunc(parsed)) : 0;
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

if (resolve(process.argv[1] ?? "") === scriptPath) {
  runFakeCodex().then(code => {
    process.exitCode = code;
  }).catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
