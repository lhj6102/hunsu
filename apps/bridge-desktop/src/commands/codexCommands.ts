import { spawn, spawnSync } from "node:child_process";
import { withBridgeCodexProviderSettings, type BridgeAppState, type BridgeCodexSettings } from "../state/appState.ts";
import { parseCodexDeviceAuthOutput, type CodexRuntimeStatus, type RuntimeProviderStatus } from "@hunsu/bridge";

type ParsedCodexArgs = {
  rest: string[];
};

type CodexCommandContext = {
  hasFlag: (parsed: any, name: string) => boolean;
  getFlag: (parsed: any, name: string) => string | undefined;
  resolvePath: (path: string) => string;
  getCodexStatus: (input: { env: Record<string, string | undefined>; force?: boolean }) => Promise<CodexRuntimeStatus>;
  codexProbeEnv: () => Record<string, string | undefined>;
  reconcileCodexLoginFromStatus: (codex: CodexRuntimeStatus) => BridgeAppState;
  runCodexInstallCli: (options: { confirmed: boolean; dryRun: boolean }) => Promise<{
    message: string;
    status: string;
    command?: string;
    args?: string[];
    providerStatus?: RuntimeProviderStatus;
  }>;
  providerStatusSummary: (provider: RuntimeProviderStatus) => string;
  runCodexApiKeyLoginCli: () => Promise<void>;
  runCodexDeviceLoginCli: (options: { json: boolean; background: boolean }) => Promise<void>;
  runCodexChatGptLoginCli: () => Promise<void>;
  runCodexCli: (args: string[]) => void;
  readState: () => BridgeAppState;
  writeState: (state: BridgeAppState) => void;
  parseInstallChannel: (value: string | undefined) => BridgeCodexSettings["installChannel"] | undefined;
  parseAuthenticationPreference: (value: string | undefined) => BridgeCodexSettings["authenticationPreference"] | undefined;
  printCodexStatus: (codex: CodexRuntimeStatus) => void;
};

export type CodexCliActionContext = {
  getCodexStatus: (input: { env: Record<string, string | undefined>; force?: boolean }) => Promise<CodexRuntimeStatus>;
  codexProbeEnv: () => Record<string, string | undefined>;
  readState: () => BridgeAppState;
  writeState: (state: BridgeAppState) => void;
  bridgeNodeExecArgs: () => string[];
  bridgeCommandPath: () => string;
};

type CodexDeviceLoginOutcome =
  | { kind: "exit"; code: number | null; signal: NodeJS.Signals | null }
  | { kind: "error"; error: Error }
  | { kind: "timeout" };

const CODEX_DEVICE_LOGIN_STARTUP_GRACE_MS = 3_000;
const CODEX_DEVICE_LOGIN_JSON_TIMEOUT_MS = 10_000;
const CODEX_DEVICE_LOGIN_BACKGROUND_LIFECYCLE_TIMEOUT_MS = 15 * 60_000;

export async function runCodexCommand(parsed: ParsedCodexArgs, context: CodexCommandContext): Promise<void> {
  const action = parsed.rest[0] ?? "status";
  if (action === "status" || action === "recheck") {
    const codex = await context.getCodexStatus({ env: context.codexProbeEnv(), force: true });
    context.reconcileCodexLoginFromStatus(codex);
    if (context.hasFlag(parsed, "json")) {
      console.log(JSON.stringify(codex, null, 2));
      return;
    }
    context.printCodexStatus(codex);
    return;
  }
  if (action === "install") {
    const result = await context.runCodexInstallCli({
      confirmed: context.hasFlag(parsed, "confirm"),
      dryRun: context.hasFlag(parsed, "dry-run")
    });
    if (context.hasFlag(parsed, "json")) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(result.message);
    if (result.status === "confirmation_required") {
      console.log("Run again with --confirm after reviewing the installer source and package name.");
    }
    if (result.command && result.args) {
      console.log(`Installer: ${[result.command, ...result.args].join(" ")}`);
    }
    if (result.providerStatus) {
      console.log(`Codex: ${result.providerStatus.ready ? "Ready" : context.providerStatusSummary(result.providerStatus)}`);
    }
    return;
  }
  if (action === "login") {
    if (context.hasFlag(parsed, "api-key")) {
      await context.runCodexApiKeyLoginCli();
      return;
    }
    if (context.hasFlag(parsed, "device")) {
      await context.runCodexDeviceLoginCli({ json: context.hasFlag(parsed, "json"), background: context.hasFlag(parsed, "background") });
      return;
    }
    if (context.hasFlag(parsed, "json") || context.hasFlag(parsed, "background")) {
      throw new Error("codex login --json/--background requires --device.");
    }
    await context.runCodexChatGptLoginCli();
    return;
  }
  if (action === "logout") {
    context.runCodexCli(["logout"]);
    return;
  }
  if (action === "path") {
    const subcommand = parsed.rest[1];
    if (subcommand === "set") {
      const binaryPath = parsed.rest[2];
      if (!binaryPath?.trim()) {
        throw new Error("Usage: hunsu-bridge codex path set /path/to/codex");
      }
      const resolvedPath = context.resolvePath(binaryPath);
      const status = await context.getCodexStatus({ env: { ...context.codexProbeEnv(), HUNSU_CODEX_BINARY_PATH: resolvedPath, HUNSU_CODEX_BINARY_PATH_SOURCE: "user_config" }, force: true });
      if (!status.cli.installed || !status.cli.version || !status.appServer.available) {
        throw new Error(status.appServer.error ?? status.cli.error ?? "Selected file is not a usable Codex CLI for Hunsu.");
      }
      const state = context.readState();
      context.writeState(withBridgeCodexProviderSettings(state, { binaryPath: resolvedPath }));
      console.log(`Codex binary path set to ${resolvedPath}`);
      return;
    }
    if (subcommand === "reset") {
      const state = context.readState();
      context.writeState(withBridgeCodexProviderSettings(state, { binaryPath: undefined }));
      console.log("Codex binary path reset to auto-detect.");
      return;
    }
  }
  if (action === "home") {
    const subcommand = parsed.rest[1];
    if (subcommand === "set") {
      const codexHome = parsed.rest[2];
      if (!codexHome?.trim()) {
        throw new Error("Usage: hunsu-bridge codex home set /path/to/codex-home");
      }
      const resolvedHome = context.resolvePath(codexHome);
      const status = await context.getCodexStatus({ env: { ...context.codexProbeEnv(), CODEX_HOME: resolvedHome }, force: true });
      if (!status.cli.installed || !status.cli.version || !status.appServer.available) {
        throw new Error(status.appServer.error ?? status.cli.error ?? "Codex is not usable with the selected CODEX_HOME.");
      }
      const state = context.readState();
      context.writeState(withBridgeCodexProviderSettings(state, { codexHome: resolvedHome }));
      console.log(`Codex home set to ${resolvedHome}`);
      if (status.auth.homeDiagnostic?.authFileExistsAtEffectiveHome === false) {
        console.log("No auth.json was found at that Codex home. Sign in, then recheck.");
      }
      return;
    }
    if (subcommand === "reset") {
      const state = context.readState();
      context.writeState(withBridgeCodexProviderSettings(state, { codexHome: undefined }));
      console.log("Codex home reset to Codex default.");
      return;
    }
  }
  if (action === "settings") {
    const subcommand = parsed.rest[1];
    if (subcommand === "set") {
      const installChannel = context.parseInstallChannel(context.getFlag(parsed, "install-channel"));
      const authenticationPreference = context.parseAuthenticationPreference(context.getFlag(parsed, "auth-preference"));
      const codexHome = context.getFlag(parsed, "codex-home");
      const appServerCommand = context.getFlag(parsed, "app-server-command");
      const appServerArgs = context.getFlag(parsed, "app-server-args");
      const state = context.readState();
      context.writeState(withBridgeCodexProviderSettings(state, {
        ...(installChannel ? { installChannel } : {}),
        ...(authenticationPreference ? { authenticationPreference } : {}),
        ...(codexHome !== undefined ? { codexHome: codexHome ? context.resolvePath(codexHome) : undefined } : {}),
        ...(appServerCommand !== undefined ? { appServerCommand: appServerCommand || undefined } : {}),
        ...(appServerArgs !== undefined ? { appServerArgs: appServerArgs || undefined } : {})
      }));
      console.log("Codex settings saved.");
      return;
    }
  }
  throw new Error("Usage: hunsu-bridge codex status|install [--confirm] [--dry-run]|login [--device|--api-key] [--background]|recheck|logout|path set <path>|path reset|home set <path>|home reset|settings set [--install-channel stable|latest|manual] [--auth-preference chatgpt|api_key|device_code] [--codex-home path] [--app-server-command command] [--app-server-args args]");
}

export async function runCodexDeviceLoginCli(options: { json: boolean; background: boolean }, context: CodexCliActionContext): Promise<void> {
  const args = ["login", "--device-auth"];
  const codex = await context.getCodexStatus({ env: context.codexProbeEnv(), force: true });
  const binaryPath = codex.cli.binaryPath;
  if (!binaryPath || !codex.cli.installed) {
    throw new Error(codex.cli.error ?? "Codex CLI was not found.");
  }
  if (!options.json && !options.background) {
    const startedAt = new Date().toISOString();
    writeCodexLoginState({ kind: "device", startedAt, status: "starting" }, context);
    const child = spawnSync(binaryPath, args, {
      stdio: "inherit",
      env: context.codexProbeEnv(),
      windowsHide: false
    });
    if (child.status === 0) {
      writeCodexLoginState({ kind: "device", startedAt, status: "completed" }, context);
      return;
    }
    writeCodexLoginState({
      kind: "device",
      startedAt,
      status: "failed",
      error: child.error?.message ?? `Codex device login exited with status ${child.status ?? child.signal ?? "unknown"}.`
    }, context);
    if (child.status && child.status !== 0) {
      process.exitCode = child.status;
      return;
    }
    if (child.error) throw child.error;
    return;
  }

  const child = spawn(binaryPath, args, {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: context.codexProbeEnv(),
    windowsHide: true
  });
  const startedAt = new Date().toISOString();
  writeCodexLoginState({ kind: "device", pid: child.pid, startedAt, status: "starting" }, context);
  let output = "";
  let finalized = false;
  const append = (chunk: Buffer | string) => {
    if (finalized) {
      return;
    }
    output = `${output}${chunk.toString()}`.slice(-64 * 1024);
    const details = parseCodexDeviceAuthOutput(output);
    writeCodexLoginState({
      kind: "device",
      pid: child.pid,
      startedAt,
      status: details.verificationUri || details.userCode ? "device_code" : "pending",
      ...details,
      lastOutput: output.trim().slice(-4096)
    }, context);
  };
  const startupTimer = setTimeout(() => {
    const state = context.readState().codexLogin;
    if (state?.startedAt === startedAt && state.status === "starting") {
      writeCodexLoginState({ ...state, status: "pending" }, context);
    }
  }, CODEX_DEVICE_LOGIN_STARTUP_GRACE_MS);
  const finalize = (outcome: CodexDeviceLoginOutcome) => {
    finalized = true;
    clearTimeout(startupTimer);
    const details = parseCodexDeviceAuthOutput(output);
    const failed = outcome.kind === "error" || outcome.kind === "timeout" || outcome.code !== 0;
    writeCodexLoginState({
      kind: "device",
      pid: child.pid,
      startedAt,
      status: failed ? "failed" : details.verificationUri || details.userCode ? "device_code" : "completed",
      ...details,
      lastOutput: output.trim().slice(-4096),
      error: codexDeviceLoginError(outcome, output)
    }, context);
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  const outcome = await waitForCodexDeviceLoginOutcome(
    child,
    options.background ? CODEX_DEVICE_LOGIN_BACKGROUND_LIFECYCLE_TIMEOUT_MS : CODEX_DEVICE_LOGIN_JSON_TIMEOUT_MS
  );
  if (outcome.kind === "timeout") {
    child.kill();
  }
  finalize(outcome);
  const processState = context.readState().codexLogin ?? { kind: "device" as const, pid: child.pid, startedAt, status: "pending" as const };
  const result = {
    started: outcome.kind !== "error",
    command: binaryPath,
    args,
    state: processState.status,
    verificationUri: processState.verificationUri,
    verificationUriComplete: processState.verificationUriComplete,
    userCode: processState.userCode,
    lastOutput: processState.lastOutput,
    error: processState.error,
    message: processState.status === "failed"
      ? processState.error ?? "Codex device login failed."
      : outcome.kind === "error"
        ? outcome.error.message
        : outcome.kind === "exit" && outcome.code !== 0
          ? `Codex device login exited with status ${outcome.code ?? outcome.signal ?? "unknown"}.`
          : processState.verificationUri || processState.userCode
            ? "Codex device login started. Complete authorization in your browser."
            : processState.status === "completed"
              ? "Codex device login completed."
              : "Codex device login started, but no device code has been emitted yet."
  };
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(result.message);
  if (result.verificationUriComplete ?? result.verificationUri) {
    console.log(`Verification URL: ${result.verificationUriComplete ?? result.verificationUri}`);
  }
  if (result.userCode) {
    console.log(`Code: ${result.userCode}`);
  }
}

export async function runCodexChatGptLoginCli(context: CodexCliActionContext): Promise<void> {
  const args = ["login"];
  const codex = await context.getCodexStatus({ env: context.codexProbeEnv(), force: true });
  const binaryPath = codex.cli.binaryPath;
  const startedAt = new Date().toISOString();
  if (!binaryPath || !codex.cli.installed) {
    writeCodexLoginState({
      kind: "chatgpt",
      startedAt,
      status: "failed",
      error: codex.cli.error ?? "Codex CLI was not found.",
      lastOutput: "Browser login failed to start."
    }, context);
    throw new Error(codex.cli.error ?? "Codex CLI was not found.");
  }
  try {
    const child = spawn(binaryPath, args, {
      detached: true,
      stdio: "ignore",
      env: context.codexProbeEnv(),
      windowsHide: true
    });
    child.unref();
    writeCodexLoginState({
      kind: "chatgpt",
      pid: child.pid,
      startedAt,
      status: "pending",
      lastOutput: "Browser login started. Complete sign-in, then click Recheck."
    }, context);
    console.log("Codex login started. Complete sign-in in your browser, then click Recheck.");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeCodexLoginState({
      kind: "chatgpt",
      startedAt,
      status: "failed",
      error: message,
      lastOutput: "Browser login failed to start."
    }, context);
    throw error;
  }
}

export async function runCodexApiKeyLoginCli(context: CodexCliActionContext): Promise<void> {
  const args = ["login", "--api-key"];
  const codex = await context.getCodexStatus({ env: context.codexProbeEnv(), force: true });
  const binaryPath = codex.cli.binaryPath;
  if (!binaryPath || !codex.cli.installed) {
    throw new Error(codex.cli.error ?? "Codex CLI was not found.");
  }
  const child = spawn(binaryPath, args, {
    detached: true,
    stdio: "ignore",
    env: context.codexProbeEnv(),
    windowsHide: true
  });
  child.unref();
  console.log("Codex API-key configuration started. Complete it in Codex, then click Recheck.");
}

export function reconcileCodexLoginFromStatus(codex: CodexRuntimeStatus, context: Pick<CodexCliActionContext, "readState" | "writeState">): BridgeAppState {
  const state = context.readState();
  if (!state.codexLogin) {
    return state;
  }
  if (codex.auth.state === "authenticated") {
    const next = { ...state, codexLogin: undefined };
    context.writeState(next);
    return next;
  }
  return state;
}

export function runCodexCli(args: string[], context: CodexCliActionContext): void {
  const status = spawnSync(process.execPath, [
    ...context.bridgeNodeExecArgs(),
    context.bridgeCommandPath(),
    "codex",
    "status",
    "--json"
  ], {
    encoding: "utf8",
    env: context.codexProbeEnv()
  });
  const codex = status.status === 0 ? JSON.parse(status.stdout) as CodexRuntimeStatus : undefined;
  const binaryPath = codex?.cli.binaryPath;
  if (!binaryPath || !codex?.cli.installed) {
    throw new Error(codex?.cli.error ?? "Codex CLI was not found.");
  }
  const child = spawnSync(binaryPath, args, {
    stdio: "inherit",
    env: context.codexProbeEnv()
  });
  if (child.status && child.status !== 0) {
    process.exitCode = child.status;
  }
}

function writeCodexLoginState(codexLogin: BridgeAppState["codexLogin"], context: Pick<CodexCliActionContext, "readState" | "writeState">): void {
  if (!codexLogin) {
    return;
  }
  const state = context.readState();
  context.writeState({ ...state, codexLogin });
}

function waitForCodexDeviceLoginOutcome(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<CodexDeviceLoginOutcome> {
  return new Promise(resolve => {
    let settled = false;
    let timer: NodeJS.Timeout;
    const finish = (outcome: CodexDeviceLoginOutcome) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      child.off("close", onClose);
      child.off("error", onError);
      resolve(outcome);
    };
    const onClose = (code: number | null, signal: NodeJS.Signals | null) => finish({ kind: "exit", code, signal });
    const onError = (error: Error) => finish({ kind: "error", error });
    timer = setTimeout(() => finish({ kind: "timeout" }), timeoutMs);
    child.once("close", onClose);
    child.once("error", onError);
  });
}

function codexDeviceLoginError(outcome: CodexDeviceLoginOutcome, output: string): string | undefined {
  const lastOutput = lastNonEmptyLine(output);
  if (outcome.kind === "error") {
    return lastOutput ? `${outcome.error.message}: ${lastOutput}` : outcome.error.message;
  }
  if (outcome.kind === "timeout") {
    return lastOutput
      ? `Codex device login timed out while waiting for Codex to finish: ${lastOutput}`
      : "Codex device login timed out while waiting for Codex to finish.";
  }
  if (outcome.code === 0) {
    return undefined;
  }
  const status = outcome.code ?? outcome.signal ?? "unknown";
  return lastOutput
    ? `Codex device login exited with status ${status}: ${lastOutput}`
    : `Codex device login exited with status ${status}.`;
}

function lastNonEmptyLine(output: string): string | undefined {
  return output
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .at(-1);
}
