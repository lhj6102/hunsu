import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { accessSync, constants, existsSync, readdirSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { currentProcessEnv, resolveCodexAppServerConfig } from "@hunsu/config";

const execFileAsync = promisify(execFile);
export const DEFAULT_CODEX_PROBE_TIMEOUT_MS = 3_500;

export type CodexCliStatus = {
  installed: boolean;
  binaryPath?: string;
  source?: CodexDiscoveryCandidateSource | "unknown";
  version?: string;
  appServerAvailable?: boolean;
  discovery?: CodexDiscoveryCandidate[];
  aliasDetected?: boolean;
  error?: string;
};

export type CodexDiscoveryCandidateSource =
  | "custom"
  | "env"
  | "process_path"
  | "registry_user_path"
  | "registry_machine_path"
  | "where"
  | "powershell_get_command"
  | "known_install_dir"
  | "windows_apps_alias";

export type CodexDiscoveryCandidate = {
  source: CodexDiscoveryCandidateSource;
  path?: string;
  usable: boolean;
  versionOk?: boolean;
  appServerOk?: boolean;
  version?: string;
  error?: string;
};

export type CodexAppServerProbeResult =
  | { available: true; initialized?: unknown }
  | { available: false; error: string };

export type CodexAppServerLaunchCommand = {
  command: string;
  args: string[];
};

export type CodexDetectionOptions = {
  env?: Record<string, string | undefined>;
  customBinaryPath?: string;
  timeoutMs?: number;
  platform?: NodeJS.Platform;
};

type CodexCommandResolution =
  | {
      kind: "binary";
      installed: true;
      binaryPath: string;
      source: CodexDiscoveryCandidateSource;
    }
  | {
      kind: "missing";
      installed: false;
      source: CodexDiscoveryCandidateSource | "unknown";
      binaryPath?: string;
      error: string;
    }
  | {
      kind: "unsupported_command_string";
      installed: false;
      source: "env";
      error: string;
    };

type JsonRpcMessage = {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { message?: string };
};

type CodexDiscoveryCandidateInput = {
  candidate: string;
  source: CodexDiscoveryCandidateSource;
  rejectWhitespace?: boolean;
};

export async function detectCodexBinary(options: CodexDetectionOptions = {}): Promise<CodexCliStatus> {
  const env = options.env ?? currentProcessEnv();
  const platform = options.platform ?? process.platform;
  const candidates = await codexDiscoveryCandidates({ env, platform, customBinaryPath: options.customBinaryPath });
  const discovery: CodexDiscoveryCandidate[] = [];
  for (const candidate of candidates) {
    const diagnostic = await probeDiscoveryCandidate(candidate, env, platform, options.timeoutMs);
    discovery.push(diagnostic);
    if (candidate.rejectWhitespace && diagnostic.error?.includes("HUNSU_CODEX_APP_SERVER_COMMAND")) {
      return {
        installed: false,
        source: diagnostic.source,
        appServerAvailable: false,
        discovery,
        error: diagnostic.error
      };
    }
    if (diagnostic.usable && diagnostic.path) {
      return {
        installed: true,
        binaryPath: diagnostic.path,
        source: diagnostic.source,
        version: diagnostic.version,
        appServerAvailable: true,
        discovery
      };
    }
  }
  const appServerUnavailable = discovery.find(candidate => candidate.path && candidate.versionOk === true && candidate.appServerOk === false);
  if (appServerUnavailable?.path) {
    return {
      installed: true,
      binaryPath: appServerUnavailable.path,
      source: appServerUnavailable.source,
      version: appServerUnavailable.version,
      appServerAvailable: false,
      discovery,
      error: appServerUnavailable.error ?? "Codex was found, but Codex app-server is not available."
    };
  }
  const windowsAlias = discovery.find(candidate => candidate.source === "windows_apps_alias" || (candidate.path && isWindowsAppsExecutionAlias(candidate.path, platform)));
  if (windowsAlias) {
    return {
      installed: false,
      binaryPath: windowsAlias.path,
      source: "windows_apps_alias",
      appServerAvailable: false,
      discovery,
      aliasDetected: true,
      error: windowsAlias.error ?? "Codex resolved to a WindowsApps execution alias. Select the real Codex binary path in Hunsu Bridge."
    };
  }
  const firstCandidate = discovery.find(candidate => candidate.path) ?? discovery[0];
  return {
    installed: false,
    binaryPath: firstCandidate?.path,
    source: firstCandidate?.source ?? "unknown",
    appServerAvailable: false,
    discovery,
    error: firstCandidate?.error ?? "Codex CLI was not found by Hunsu Bridge."
  };
}

export async function getCodexVersion(input: {
  binaryPath: string;
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
}): Promise<string | undefined> {
  try {
    const env = input.env ?? currentProcessEnv();
    const platform = input.platform ?? process.platform;
    const launch = codexCliLaunchCommand(input.binaryPath, ["--version"], env, platform);
    const { stdout, stderr } = await execFileAsync(launch.command, launch.args, {
      env: processEnvForProbe(env, platform),
      timeout: input.timeoutMs ?? DEFAULT_CODEX_PROBE_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 64 * 1024
    });
    const output = `${stdout}\n${stderr}`.trim();
    return output.split(/\r?\n/).map(line => line.trim()).find(Boolean);
  } catch (_error) {
    return undefined;
  }
}

export async function probeCodexAppServer(input: {
  binaryPath?: string;
  command?: string;
  args?: string[];
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
}): Promise<CodexAppServerProbeResult> {
  const env = input.env ?? currentProcessEnv();
  const launch = input.command
    ? { ok: true as const, value: { command: input.command, args: input.args ?? ["app-server", "--stdio"] } }
    : effectiveCodexAppServerLaunchCommand({ env, cliBinaryPath: input.binaryPath });
  if (!launch.ok) {
    return { available: false, error: launch.error };
  }
  const client = new CodexAppServerProbeClient(launch.value.command, input.timeoutMs ?? DEFAULT_CODEX_PROBE_TIMEOUT_MS, {
    env,
    platform: input.platform,
    args: launch.value.args
  });
  try {
    const initialized = await client.initialize();
    return { available: true, initialized: sanitizeDiagnostics(initialized) };
  } catch (error) {
    return { available: false, error: errorMessage(error) };
  } finally {
    client.close();
  }
}

export function effectiveCodexAppServerLaunchCommand(input: {
  env: Record<string, string | undefined>;
  cliBinaryPath?: string;
}): { ok: true; value: CodexAppServerLaunchCommand } | { ok: false; error: string } {
  const configuredCommand = input.env.HUNSU_CODEX_APP_SERVER_COMMAND?.trim();
  if (configuredCommand && /\s/.test(configuredCommand)) {
    return {
      ok: false,
      error: "HUNSU_CODEX_APP_SERVER_COMMAND must be a binary path or command name without arguments. Put arguments in HUNSU_CODEX_APP_SERVER_ARGS."
    };
  }
  const resolved = resolveCodexAppServerConfig(input.env);
  if (!resolved.ok) {
    return { ok: false, error: resolved.error.message };
  }
  const cliBinaryPath = input.cliBinaryPath?.trim();
  const command = resolved.value.command === "codex" && cliBinaryPath ? cliBinaryPath : resolved.value.command;
  return {
    ok: true,
    value: {
      command,
      args: resolved.value.args
    }
  };
}

export function knownWindowsCodexInstallDirs(env: Record<string, string | undefined>, platform: NodeJS.Platform): string[] {
  if (platform !== "win32") {
    return [];
  }
  const localAppData = firstEnv(env, "LOCALAPPDATA", "LocalAppData", "localappdata");
  const appData = firstEnv(env, "APPDATA", "AppData", "appdata");
  return uniqueStrings([
    localAppData ? join(localAppData, "OpenAI", "Codex", "bin") : undefined,
    appData ? join(appData, "npm") : undefined,
    localAppData ? join(localAppData, "Programs", "OpenAI Codex") : undefined
  ]);
}

export function windowsAwarePath(env: Record<string, string | undefined>, platform: NodeJS.Platform): string {
  if (platform !== "win32") {
    return env.PATH ?? "";
  }
  return [
    env.PATH,
    env.Path,
    env.path,
    env.HUNSU_WINDOWS_USER_PATH,
    env.HUNSU_WINDOWS_MACHINE_PATH
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0).join(";");
}

async function codexDiscoveryCandidates(input: {
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  customBinaryPath?: string;
}): Promise<CodexDiscoveryCandidateInput[]> {
  const { env, platform } = input;
  const candidates: CodexDiscoveryCandidateInput[] = [];
  const customPath = input.customBinaryPath?.trim();
  if (customPath) {
    candidates.push({ candidate: customPath, source: "custom" });
  }
  const envBinaryPath = env.HUNSU_CODEX_BINARY_PATH?.trim();
  if (envBinaryPath) {
    candidates.push({ candidate: envBinaryPath, source: env.HUNSU_CODEX_BINARY_PATH_SOURCE === "user_config" ? "custom" : "env" });
  }
  const envCommand = env.HUNSU_CODEX_APP_SERVER_COMMAND?.trim();
  if (envCommand) {
    candidates.push({ candidate: envCommand, source: "env", rejectWhitespace: true });
  }
  candidates.push(...findExecutablesOnPath("codex", env, platform, processPath(env, platform)).map(candidate => ({
    candidate,
    source: "process_path" as const
  })));
  if (platform === "win32") {
    candidates.push(...findExecutablesOnPath("codex", env, platform, await windowsRegistryPath("user", env, platform)).map(candidate => ({
      candidate,
      source: "registry_user_path" as const
    })));
    candidates.push(...findExecutablesOnPath("codex", env, platform, await windowsRegistryPath("machine", env, platform)).map(candidate => ({
      candidate,
      source: "registry_machine_path" as const
    })));
    candidates.push(...(await windowsWhereCodexCandidates(env)).map(candidate => ({
      candidate,
      source: "where" as const
    })));
    candidates.push(...(await powershellCodexCandidates(env)).map(candidate => ({
      candidate,
      source: "powershell_get_command" as const
    })));
    candidates.push(...knownWindowsCodexInstallPathCandidates(env, platform).map(candidate => ({
      candidate,
      source: "known_install_dir" as const
    })));
    const alias = windowsAppsCodexAliasPath(env, platform);
    if (alias) {
      candidates.push({ candidate: alias, source: "windows_apps_alias" });
    }
  }
  return uniqueCandidateInputs(candidates);
}

async function probeDiscoveryCandidate(
  candidate: CodexDiscoveryCandidateInput,
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform,
  timeoutMs: number | undefined
): Promise<CodexDiscoveryCandidate> {
  const resolution = resolveCodexCommand(candidate.candidate, candidate.source, env, platform, {
    rejectWhitespace: candidate.rejectWhitespace
  });
  if (resolution.kind !== "binary") {
    return {
      source: resolution.source === "unknown" ? candidate.source : resolution.source,
      path: resolution.kind === "missing" ? resolution.binaryPath : undefined,
      usable: false,
      error: resolution.error
    };
  }
  const source = isWindowsAppsExecutionAlias(resolution.binaryPath, platform)
    ? "windows_apps_alias"
    : resolution.source;
  if (source === "windows_apps_alias") {
    return {
      source,
      path: resolution.binaryPath,
      usable: false,
      versionOk: false,
      appServerOk: false,
      error: "Codex resolved to a WindowsApps execution alias. Select the real Codex binary path in Hunsu Bridge."
    };
  }
  const version = await getCodexVersion({ binaryPath: resolution.binaryPath, timeoutMs, env, platform });
  if (!version) {
    return {
      source,
      path: resolution.binaryPath,
      usable: false,
      versionOk: false,
      appServerOk: false,
      error: "Codex candidate did not return a CLI version."
    };
  }
  const appServer = await probeCodexAppServer({ binaryPath: resolution.binaryPath, timeoutMs, env, platform });
  if (!appServer.available) {
    return {
      source,
      path: resolution.binaryPath,
      usable: false,
      versionOk: true,
      appServerOk: false,
      version,
      error: appServer.error
    };
  }
  return {
    source,
    path: resolution.binaryPath,
    usable: true,
    versionOk: true,
    appServerOk: true,
    version
  };
}

function resolveCodexCommand(
  candidate: string,
  source: CodexDiscoveryCandidateSource | "unknown" | undefined,
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform,
  options: { rejectWhitespace?: boolean } = {}
): CodexCommandResolution {
  const trimmed = candidate.trim();
  if (!trimmed) {
    return { kind: "missing", installed: false, source: source ?? "unknown", error: "Codex command is empty." };
  }
  if (options.rejectWhitespace && /\s/.test(trimmed)) {
    return {
      kind: "unsupported_command_string",
      installed: false,
      source: "env",
      error: "HUNSU_CODEX_APP_SERVER_COMMAND must be a binary path or command name without arguments. Put arguments in HUNSU_CODEX_APP_SERVER_ARGS."
    };
  }
  const binaryPath = isAbsolute(trimmed) ? trimmed : findExecutableOnPath(trimmed, env, platform, processPath(env, platform));
  if (!binaryPath) {
    return {
      kind: "missing",
      installed: false,
      source: source ?? "unknown",
      binaryPath: isAbsolute(trimmed) ? trimmed : undefined,
      error: isAbsolute(trimmed) ? "Configured Codex path does not exist." : `Codex command was not found on PATH: ${trimmed}`
    };
  }
  if (isWindowsAppsExecutionAlias(binaryPath, platform)) {
    return {
      kind: "missing",
      installed: false,
      source: "windows_apps_alias",
      binaryPath,
      error: "Codex resolved to a WindowsApps execution alias. Select the real Codex binary path in Hunsu Bridge."
    };
  }
  try {
    const stat = statSync(binaryPath);
    if (!stat.isFile()) {
      return { kind: "missing", installed: false, binaryPath, source: source ?? "unknown", error: "Configured Codex path is not a file." };
    }
    if (platform !== "win32") {
      accessSync(binaryPath, constants.X_OK);
    }
    return { kind: "binary", installed: true, binaryPath, source: source === "unknown" || source === undefined ? "process_path" : source };
  } catch (error) {
    return { kind: "missing", installed: false, binaryPath, source: source ?? "unknown", error: errorMessage(error) };
  }
}

function findExecutableOnPath(
  command: string,
  env: Record<string, string | undefined>,
  platform = process.platform,
  path = processPath(env, platform)
): string | undefined {
  return findExecutablesOnPath(command, env, platform, path)[0];
}

function findExecutablesOnPath(
  command: string,
  env: Record<string, string | undefined>,
  platform = process.platform,
  path = processPath(env, platform)
): string[] {
  if (isAbsolute(command)) {
    return existsSync(command) ? [command] : [];
  }
  const extensions = platform === "win32"
    ? ["", ...(env.PATHEXT ?? env.PathExt ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)]
    : [""];
  const pathDelimiter = platform === "win32" ? ";" : delimiter;
  const matches: string[] = [];
  for (const directory of path.split(pathDelimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = join(directory, platform === "win32" && !command.toUpperCase().endsWith(extension.toUpperCase()) ? `${command}${extension}` : command);
      if (existsSync(candidate)) {
        matches.push(candidate);
      }
    }
  }
  return uniqueStrings(matches);
}

function knownWindowsCodexInstallPathCandidates(env: Record<string, string | undefined>, platform: NodeJS.Platform): string[] {
  if (platform !== "win32") {
    return [];
  }
  const localAppData = firstEnv(env, "LOCALAPPDATA", "LocalAppData", "localappdata");
  const appData = firstEnv(env, "APPDATA", "AppData", "appdata");
  const candidates: string[] = [];
  if (localAppData) {
    const versionedBin = join(localAppData, "OpenAI", "Codex", "bin");
    if (existsSync(versionedBin)) {
      for (const entry of safeReadDir(versionedBin)) {
        candidates.push(join(versionedBin, entry, "codex.exe"));
      }
    }
    candidates.push(
      join(localAppData, "OpenAI", "Codex", "bin", "codex.exe"),
      join(localAppData, "Programs", "OpenAI Codex", "codex.exe")
    );
  }
  if (appData) {
    candidates.push(join(appData, "npm", "codex.cmd"));
  }
  return uniqueStrings(candidates.filter(existsSync));
}

async function windowsRegistryPath(
  hive: "user" | "machine",
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform
): Promise<string> {
  if (platform !== "win32") {
    return "";
  }
  const injected = hive === "user" ? env.HUNSU_WINDOWS_USER_PATH : env.HUNSU_WINDOWS_MACHINE_PATH;
  if (injected?.trim()) {
    return expandWindowsPathVariables(injected, env);
  }
  const key = hive === "user"
    ? "HKCU\\Environment"
    : "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment";
  try {
    const { stdout } = await execFileAsync("reg.exe", ["query", key, "/v", "Path"], {
      env,
      timeout: 1_500,
      windowsHide: true,
      maxBuffer: 64 * 1024
    });
    return expandWindowsPathVariables(registryPathFromOutput(stdout), env);
  } catch (_error) {
    return "";
  }
}

async function windowsWhereCodexCandidates(env: Record<string, string | undefined>): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("where.exe", ["codex"], {
      env,
      timeout: 1_500,
      windowsHide: true,
      maxBuffer: 64 * 1024
    });
    return outputPathLines(stdout);
  } catch (_error) {
    return [];
  }
}

async function powershellCodexCandidates(env: Record<string, string | undefined>): Promise<string[]> {
  const script = "Get-Command codex -All | ForEach-Object { $_.Source }";
  for (const command of ["powershell.exe", "pwsh"]) {
    try {
      const { stdout } = await execFileAsync(command, ["-NoProfile", "-Command", script], {
        env,
        timeout: 2_000,
        windowsHide: true,
        maxBuffer: 64 * 1024
      });
      const candidates = outputPathLines(stdout);
      if (candidates.length > 0) {
        return candidates;
      }
    } catch (_error) {
      // Try the next PowerShell host.
    }
  }
  return [];
}

function registryPathFromOutput(output: string): string {
  const line = output.split(/\r?\n/).map(value => value.trim()).find(value => /^Path\s+REG_/i.test(value));
  return line?.replace(/^Path\s+REG_\w+\s+/i, "").trim() ?? "";
}

function outputPathLines(output: string): string[] {
  return uniqueStrings(output.split(/\r?\n/).map(line => line.trim()).filter(line =>
    line.length > 0
      && !/^[-\s]+$/.test(line)
      && !/^CommandType\b|^Name\b|^Source\b/i.test(line)
  ));
}

function windowsAppsCodexAliasPath(env: Record<string, string | undefined>, platform: NodeJS.Platform): string | undefined {
  if (platform !== "win32") {
    return undefined;
  }
  const localAppData = firstEnv(env, "LOCALAPPDATA", "LocalAppData", "localappdata");
  const alias = localAppData ? join(localAppData, "Microsoft", "WindowsApps", "codex.exe") : undefined;
  return alias && existsSync(alias) ? alias : undefined;
}

function processPath(env: Record<string, string | undefined>, platform: NodeJS.Platform): string {
  if (platform !== "win32") {
    return env.PATH ?? "";
  }
  return [env.PATH, env.Path, env.path]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join(";");
}

function safeReadDir(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name);
  } catch (_error) {
    return [];
  }
}

function uniqueCandidateInputs(candidates: CodexDiscoveryCandidateInput[]): CodexDiscoveryCandidateInput[] {
  const seen = new Set<string>();
  const result: CodexDiscoveryCandidateInput[] = [];
  for (const candidate of candidates) {
    const key = `${candidate.source}:${candidate.candidate}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(candidate);
  }
  return result;
}

function firstEnv(env: Record<string, string | undefined>, ...keys: string[]): string | undefined {
  return keys.map(key => env[key]).find(value => typeof value === "string" && value.trim().length > 0)?.trim();
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === "string" && value.length > 0))];
}

function isWindowsAppsExecutionAlias(binaryPath: string, platform: NodeJS.Platform): boolean {
  return platform === "win32" && /(?:^|[\\/])WindowsApps[\\/]/i.test(binaryPath);
}

function expandWindowsPathVariables(path: string, env: Record<string, string | undefined>): string {
  return path.replace(/%([^%]+)%/g, (match, rawName: string) => {
    const name = rawName.trim();
    const currentEnv = currentProcessEnv();
    const value = firstEnv(env, name, name.toUpperCase(), name.toLowerCase()) ?? currentEnv[name];
    return value ?? match;
  });
}

export function codexCliLaunchCommand(
  binaryPath: string,
  args: string[],
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform
): { command: string; args: string[] } {
  if (platform === "win32" && /\.(?:cmd|bat)$/i.test(binaryPath)) {
    return {
      command: firstEnv(env, "ComSpec", "COMSPEC") ?? "cmd.exe",
      args: ["/d", "/s", "/c", windowsCmdCommandLine(binaryPath, args)]
    };
  }
  return { command: binaryPath, args };
}

function windowsCmdCommandLine(binaryPath: string, args: string[]): string {
  return `"${[binaryPath, ...args].map(quoteWindowsCmdArg).join(" ")}"`;
}

function quoteWindowsCmdArg(value: string): string {
  return `"${value.replace(/"/g, "\"\"")}"`;
}

function processEnvForProbe(env: Record<string, string | undefined>, platform: NodeJS.Platform): NodeJS.ProcessEnv {
  const current = currentProcessEnv();
  const merged: NodeJS.ProcessEnv = {
    ...current,
    ...env
  };
  const separator = platform === "win32" ? ";" : delimiter;
  for (const key of ["PATH", "Path", "path"]) {
    const overrideValue = env[key];
    const currentValue = current[key];
    if (overrideValue === "" && currentValue) {
      merged[key] = currentValue;
      continue;
    }
    if (overrideValue && currentValue && !overrideValue.split(separator).includes(currentValue)) {
      merged[key] = `${overrideValue}${separator}${currentValue}`;
    }
  }
  return merged;
}

export class CodexAppServerProbeClient {
  private readonly command: string;
  private readonly args: string[];
  private readonly timeoutMs: number;
  private child: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private buffer = "";
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();

  constructor(
    command: string,
    timeoutMs: number,
    options: {
      env?: Record<string, string | undefined>;
      platform?: NodeJS.Platform;
      args?: string[];
    } = {}
  ) {
    this.command = command;
    this.args = options.args ?? ["app-server", "--stdio"];
    this.timeoutMs = timeoutMs;
    const env = options.env ?? currentProcessEnv();
    const platform = options.platform ?? process.platform;
    const launch = codexCliLaunchCommand(this.command, this.args, env, platform);
    this.child = spawn(launch.command, launch.args, {
      env: processEnvForProbe(env, platform),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", chunk => this.read(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.on("error", error => this.rejectAll(error));
    this.child.on("exit", () => this.rejectAll(new Error("Codex app-server process exited before probe completed.")));
  }

  request(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server probe timed out: ${method}`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async initialize(): Promise<unknown> {
    const initialized = await this.request("initialize", {
      clientInfo: { name: "hunsu-bridge", title: "Hunsu Bridge", version: "0.1.0" }
    });
    this.notify("initialized", {});
    return initialized;
  }

  notify(method: string, params?: unknown): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  close(): void {
    this.rejectAll(new Error("Codex app-server probe closed."));
    this.child.kill();
  }

  private write(message: JsonRpcMessage & { jsonrpc: "2.0" }): void {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private read(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      newline = this.buffer.indexOf("\n");
      if (!line) continue;
      let message: JsonRpcMessage;
      try {
        message = JSON.parse(line) as JsonRpcMessage;
      } catch (error) {
        this.rejectAll(new Error(`Invalid Codex app-server JSON-RPC line: ${errorMessage(error)}`));
        continue;
      }
      if (message.id === undefined || typeof message.id !== "number") {
        continue;
      }
      const pending = this.pending.get(message.id);
      if (!pending) {
        continue;
      }
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message ?? "Codex app-server request failed."));
      } else {
        pending.resolve(message.result);
      }
    }
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}

export function sanitizeDiagnostics(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sanitizeDiagnostics);
  }
  if (typeof value !== "object" || value === null) {
    return typeof value === "string" ? redactSecretText(value) : value;
  }
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    result[key] = isSecretKey(key) ? "[redacted]" : sanitizeDiagnostics(child);
  }
  return result;
}

export function redactSecretText(value: string): string {
  return value
    .replace(/sk-[A-Za-z0-9_-]{10,}/g, "[redacted]")
    .replace(/(OPENAI_API_KEY|CODEX_ACCESS_TOKEN)=\S+/g, "$1=[redacted]")
    .replace(/~\/\.codex\/auth\.json/g, "[redacted]")
    .replace(/("(?:apiKey|refreshToken|accessToken|authorization)"\s*:\s*")[^"]+(")/gi, "$1[redacted]$2")
    .replace(/\b(apiKey|refreshToken|accessToken|authorization)=(?:Bearer\s+)?\S+/gi, "$1=[redacted]")
    .replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, "$1[redacted]");
}

export function errorMessage(error: unknown): string {
  return redactSecretText(error instanceof Error ? error.message : String(error));
}

function isSecretKey(key: string): boolean {
  return /token|secret|api.?key|authorization|credential|auth\.json/i.test(key);
}
