import { homedir } from "node:os";
import { posix, win32 } from "node:path";

export type HunsuPathInput = {
  home?: string;
  env?: Readonly<Record<string, string | undefined>>;
  platform?: NodeJS.Platform;
  userHome?: string;
  localAppData?: string;
};

export type HunsuPaths = {
  home: string;
  configFile: string;
  workspacesFile: string;
  credentialsFile: string;
  runtimeFile: string;
  logsDirectory: string;
  structuredLogFile: string;
  runtimeDirectory: string;
  runtimeVersionsDirectory: string;
  runtimeInstallFile: string;
  daemonLockFile: string;
};

export function resolveHunsuHome(input: HunsuPathInput = {}): string {
  const platform = input.platform ?? process.platform;
  const path = platform === "win32" ? win32 : posix;
  const env = input.env ?? {};
  const configuredHome = nonEmpty(input.home) ?? nonEmpty(env.HUNSU_HOME);
  if (configuredHome) {
    return path.isAbsolute(configuredHome) ? configuredHome : path.resolve(configuredHome);
  }

  const userHome = nonEmpty(input.userHome) ?? homedir();
  if (platform === "win32") {
    const localAppData = nonEmpty(input.localAppData)
      ?? nonEmpty(env.LOCALAPPDATA)
      ?? path.join(userHome, "AppData", "Local");
    return path.join(localAppData, "Hunsu", "Bridge");
  }
  if (platform === "darwin") {
    return path.join(userHome, "Library", "Application Support", "Hunsu", "Bridge");
  }
  return path.join(userHome, ".local", "share", "hunsu", "bridge");
}

export function resolveHunsuPaths(input: HunsuPathInput = {}): HunsuPaths {
  const home = resolveHunsuHome(input);
  const path = (input.platform ?? process.platform) === "win32" ? win32 : posix;
  const logsDirectory = path.join(home, "logs");
  const runtimeDirectory = path.join(home, "runtime");
  return {
    home,
    configFile: path.join(home, "config.json"),
    workspacesFile: path.join(home, "workspaces.json"),
    credentialsFile: path.join(home, "credentials.json"),
    runtimeFile: path.join(home, "runtime.json"),
    logsDirectory,
    structuredLogFile: path.join(logsDirectory, "bridge.jsonl"),
    runtimeDirectory,
    runtimeVersionsDirectory: path.join(runtimeDirectory, "versions"),
    runtimeInstallFile: path.join(runtimeDirectory, "install.json"),
    daemonLockFile: path.join(runtimeDirectory, "daemon.lock")
  };
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
