import { spawn } from "node:child_process";
import { currentProcessEnv } from "@hunsu/config";
import { codexCliLaunchCommand, detectCodexBinary } from "./codexDetection.ts";
import type { RuntimeProviderLoginResult } from "../types.ts";

export type CodexLoginProcessState = {
  kind: "chatgpt" | "device";
  pid?: number;
  startedAt: string;
  status: "starting" | "device_code" | "pending" | "completed" | "failed";
  verificationUri?: string;
  verificationUriComplete?: string;
  userCode?: string;
  lastOutput?: string;
  error?: string;
};

export type CodexLoginStateHost = {
  codexLogin?: CodexLoginProcessState;
};

type TrackedCodexLoginProcess = {
  child: ReturnType<typeof spawn>;
  command: string;
  startedAt: string;
  output: string;
  cleared: boolean;
};

const codexLoginTrackers = new WeakMap<CodexLoginStateHost, TrackedCodexLoginProcess>();

export async function spawnCodexAction(args: string[], env: Record<string, string | undefined>): Promise<{
  started: boolean;
  command?: string;
  args: string[];
  message?: string;
}> {
  const cli = await detectCodexBinary({ env });
  if (!cli.installed || !cli.binaryPath) {
    return { started: false, args, message: cli.error ?? "Codex CLI was not found." };
  }
  try {
    const launch = codexCliLaunchCommand(cli.binaryPath, args, env, process.platform);
    const child = spawn(launch.command, launch.args, {
      detached: true,
      stdio: "ignore",
      env: { ...currentProcessEnv(), ...env },
      windowsHide: true
    });
    await waitForCodexChildSpawn(child);
    child.unref();
    return { started: true, command: cli.binaryPath, args };
  } catch (error) {
    return {
      started: false,
      command: cli.binaryPath,
      args,
      message: error instanceof Error ? error.message : String(error)
    };
  }
}

export async function spawnCodexChatGptLogin(
  state: CodexLoginStateHost,
  env: Record<string, string | undefined>
): Promise<Omit<RuntimeProviderLoginResult, "providerId" | "method">> {
  const args = ["login"];
  const cli = await detectCodexBinary({ env });
  const startedAt = new Date().toISOString();
  if (!cli.installed || !cli.binaryPath) {
    const failed = updateCodexLoginState(state, {
      kind: "chatgpt",
      startedAt,
      status: "failed",
      error: cli.error ?? "Codex CLI was not found.",
      lastOutput: "Browser login failed to start."
    });
    return codexChatGptLoginResult(undefined, args, failed, false);
  }
  try {
    const launch = codexCliLaunchCommand(cli.binaryPath, args, env, process.platform);
    const child = spawn(launch.command, launch.args, {
      detached: true,
      stdio: "ignore",
      env: { ...currentProcessEnv(), ...env },
      windowsHide: true
    });
    await waitForCodexChildSpawn(child);
    child.unref();
    const pending = updateCodexLoginState(state, {
      kind: "chatgpt",
      pid: child.pid,
      startedAt,
      status: "pending",
      lastOutput: "Browser login started. Complete sign-in, then click Recheck."
    });
    return codexChatGptLoginResult(cli.binaryPath, args, pending);
  } catch (error) {
    const failed = updateCodexLoginState(state, {
      kind: "chatgpt",
      startedAt,
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
      lastOutput: "Browser login failed to start."
    });
    return codexChatGptLoginResult(cli.binaryPath, args, failed, false);
  }
}

export async function spawnCodexDeviceLogin(
  state: CodexLoginStateHost,
  env: Record<string, string | undefined>,
  timeoutMs = 3_000
): Promise<Omit<RuntimeProviderLoginResult, "providerId" | "method">> {
  const args = ["login", "--device-auth"];
  const existing = codexLoginTrackers.get(state);
  if (existing && !existing.cleared) {
    return codexDeviceLoginResult(existing.command, args, state.codexLogin);
  }
  const cli = await detectCodexBinary({ env });
  if (!cli.installed || !cli.binaryPath) {
    const failed = updateCodexLoginState(state, {
      kind: "device",
      startedAt: new Date().toISOString(),
      status: "failed",
      error: cli.error ?? "Codex CLI was not found."
    });
    return codexDeviceLoginResult(undefined, args, failed, false);
  }

  const launch = codexCliLaunchCommand(cli.binaryPath, args, env, process.platform);
  const child = spawn(launch.command, launch.args, {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...currentProcessEnv(), ...env },
    windowsHide: true
  });
  const tracker: TrackedCodexLoginProcess = {
    child,
    command: cli.binaryPath,
    startedAt: new Date().toISOString(),
    output: "",
    cleared: false
  };
  codexLoginTrackers.set(state, tracker);
  updateCodexLoginState(state, {
    kind: "device",
    pid: child.pid,
    startedAt: tracker.startedAt,
    status: "starting"
  });
  const append = (chunk: Buffer | string) => {
    if (tracker.cleared) return;
    tracker.output = `${tracker.output}${chunk.toString()}`.slice(-64 * 1024);
    const details = parseCodexDeviceAuthOutput(tracker.output);
    updateCodexLoginState(state, {
      kind: "device",
      pid: child.pid,
      startedAt: tracker.startedAt,
      status: details.verificationUri || details.userCode ? "device_code" : "pending",
      ...details,
      lastOutput: tracker.output.trim().slice(-4096)
    });
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  child.once("error", error => {
    if (tracker.cleared) return;
    updateCodexLoginState(state, {
      kind: "device",
      pid: child.pid,
      startedAt: tracker.startedAt,
      status: "failed",
      error: error.message,
      lastOutput: tracker.output.trim().slice(-4096)
    });
    codexLoginTrackers.delete(state);
  });
  child.once("close", (code, signal) => {
    if (tracker.cleared) return;
    const details = parseCodexDeviceAuthOutput(tracker.output);
    const failed = code !== 0;
    updateCodexLoginState(state, {
      kind: "device",
      pid: child.pid,
      startedAt: tracker.startedAt,
      status: failed ? "failed" : details.verificationUri || details.userCode ? "device_code" : "completed",
      ...details,
      lastOutput: tracker.output.trim().slice(-4096),
      error: failed ? `Codex device login exited with status ${code ?? signal ?? "unknown"}.` : undefined
    });
    codexLoginTrackers.delete(state);
  });

  await waitForCodexLoginInitialState(state, timeoutMs);
  return codexDeviceLoginResult(cli.binaryPath, args, state.codexLogin);
}

export function clearCodexLoginState(state: CodexLoginStateHost): void {
  const tracker = codexLoginTrackers.get(state);
  if (tracker) {
    tracker.cleared = true;
    codexLoginTrackers.delete(state);
  }
  state.codexLogin = undefined;
}

export function parseCodexDeviceAuthOutput(output: string): Pick<RuntimeProviderLoginResult, "verificationUri" | "verificationUriComplete" | "userCode"> {
  const urls = [...output.matchAll(/https?:\/\/[^\s)'"]+/g)].map(match => match[0].replace(/[.,;:]+$/, ""));
  const verificationUriComplete = urls.find(url => /[?&](user_?code|code)=/i.test(url));
  const verificationUri = urls.find(url => url !== verificationUriComplete) ?? verificationUriComplete;
  const codeFromUrl = verificationUriComplete ? codeFromVerificationUrl(verificationUriComplete) : undefined;
  const codeFromText = output.match(/(?:user\s+code|one[-\s]?code|one[-\s]?time\s+code|code)[:\s]+([A-Z0-9][A-Z0-9\-\s]{3,}[A-Z0-9])/i)?.[1]
    ?.trim()
    .replace(/\s+/g, "-");
  return {
    ...(verificationUri ? { verificationUri } : {}),
    ...(verificationUriComplete ? { verificationUriComplete } : {}),
    ...(codeFromUrl ?? codeFromText ? { userCode: codeFromUrl ?? codeFromText } : {})
  };
}

function codexChatGptLoginResult(
  command: string | undefined,
  args: string[],
  state: CodexLoginProcessState,
  started = true
): Omit<RuntimeProviderLoginResult, "providerId" | "method"> {
  return {
    started,
    command,
    args,
    state: state.status,
    status: state.status,
    lastOutput: state.lastOutput,
    error: state.error,
    message: state.status === "failed"
      ? state.error ?? "Codex login failed to start."
      : "Codex login started. Complete sign-in in your browser, then click Recheck."
  };
}

function codexDeviceLoginResult(
  command: string | undefined,
  args: string[],
  state: CodexLoginProcessState | undefined,
  started = true
): Omit<RuntimeProviderLoginResult, "providerId" | "method"> {
  const status = state?.status ?? "pending";
  return {
    started,
    command,
    args,
    state: status,
    status,
    verificationUri: state?.verificationUri,
    verificationUriComplete: state?.verificationUriComplete,
    userCode: state?.userCode,
    lastOutput: state?.lastOutput,
    error: state?.error,
    message: status === "failed"
      ? state?.error ?? "Codex device login failed."
      : state?.verificationUri || state?.userCode
        ? "Codex device login started. Complete authorization in your browser."
        : status === "completed"
          ? "Codex device login completed."
          : "Codex device login started."
  };
}

function updateCodexLoginState(state: CodexLoginStateHost, codexLogin: CodexLoginProcessState): CodexLoginProcessState {
  state.codexLogin = codexLogin;
  return codexLogin;
}

async function waitForCodexLoginInitialState(state: CodexLoginStateHost, timeoutMs: number): Promise<void> {
  const startedAt = state.codexLogin?.startedAt;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const codexLogin = state.codexLogin;
    const status = codexLogin && codexLogin.startedAt === startedAt ? codexLogin.status : undefined;
    if (status === "device_code") {
      await waitForCodexLoginTerminalSettle(state, startedAt);
      return;
    }
    if (status === "failed" || status === "completed") {
      return;
    }
    await sleep(50);
  }
  const tracker = codexLoginTrackers.get(state);
  if (tracker && !tracker.cleared && state.codexLogin?.startedAt === tracker.startedAt && state.codexLogin.status === "starting") {
    updateCodexLoginState(state, { ...state.codexLogin, status: "pending" });
  }
}

async function waitForCodexLoginTerminalSettle(
  state: CodexLoginStateHost,
  startedAt: string | undefined,
  settleMs = 100
): Promise<void> {
  const deadline = Date.now() + settleMs;
  while (Date.now() < deadline) {
    const codexLogin = state.codexLogin;
    const status = codexLogin && codexLogin.startedAt === startedAt ? codexLogin.status : undefined;
    if (status !== "device_code") {
      return;
    }
    if (!codexLoginTrackers.has(state)) {
      return;
    }
    await sleep(10);
  }
}

function codeFromVerificationUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.searchParams.get("user_code") ?? url.searchParams.get("user-code") ?? url.searchParams.get("code") ?? undefined;
  } catch (_error) {
    return undefined;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function waitForCodexChildSpawn(child: ReturnType<typeof spawn>): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
}
