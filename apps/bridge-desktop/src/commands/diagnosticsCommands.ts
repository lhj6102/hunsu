import { spawnSync } from "node:child_process";
import { createDefaultCredentialStore } from "../auth.ts";
import { FileRelayRegistry, type ProjectGrant } from "../relay.ts";
import { bridgeCodexProviderSettings, type BridgeAppState, type BridgeToolStatus } from "../state/appState.ts";
import { assertDiagnosticsSafe, bridgeVersionInfo, listManagedRoadmapRegistry, sanitizeDiagnostics } from "@hunsu/bridge";
import { currentProcessEnv, endpointUrl, resolveBridgeRuntimeConfig, unwrapConfigResult } from "@hunsu/config";

type DiagnosticsCommandContext = {
  appStatePath: () => string;
  appLogPath: () => string;
  credentialPath: () => string;
  relayRegistryPath: () => string;
  readState: () => BridgeAppState;
  readBridgeHealth: () => Promise<unknown>;
  snapshotProjectGrants: (projectGrants: ProjectGrant[]) => ProjectGrant[];
  activeManagedProjectGrants: (projectGrants: ProjectGrant[]) => ProjectGrant[];
  roadmapRegistryOptions: () => { roadmapRegistryPath?: string };
  safeCodexDiagnostics: () => Promise<unknown>;
  cwd?: () => string;
};

export function toolStatus(command: string, args: string[], platform = process.platform): BridgeToolStatus {
  try {
    const env = currentProcessEnv();
    const launch = diagnosticToolLaunchCommand(command, args, env, platform);
    const result = spawnSync(launch.command, launch.args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env,
      windowsHide: true
    });
    if (result.status === 0) {
      const version = `${result.stdout}\n${result.stderr}`.trim().split(/\r?\n/).find(Boolean);
      return { installed: true, binaryPath: command, version };
    }
    return { installed: false, binaryPath: command, error: (result.stderr || result.stdout || `Exited with status ${result.status}`).trim() };
  } catch (error) {
    return { installed: false, binaryPath: command, error: error instanceof Error ? error.message : String(error) };
  }
}

export function diagnosticToolLaunchCommand(
  command: string,
  args: string[],
  env: Record<string, string | undefined>,
  platform = process.platform
): { command: string; args: string[] } {
  if (platform !== "win32") {
    return { command, args };
  }
  return {
    command: env.ComSpec ?? env.COMSPEC ?? "cmd.exe",
    args: ["/d", "/s", "/c", `"${[command, ...args].map(quoteWindowsCmdArgument).join(" ")}"`]
  };
}

function quoteWindowsCmdArgument(value: string): string {
  return `"${value.replace(/"/g, "\"\"")}"`;
}

export function currentNodeRuntimeStatus(
  execPath = process.execPath,
  version = process.version
): BridgeToolStatus {
  // In a Node SEA, execPath is the sidecar itself; spawning it would re-enter the Bridge CLI.
  return {
    installed: true,
    binaryPath: execPath,
    version
  };
}

export function packageManagerStatus(commands: readonly string[] = ["npm", "pnpm", "yarn"]): BridgeToolStatus {
  for (const command of commands) {
    const status = toolStatus(command, ["--version"]);
    if (status.installed) {
      return status;
    }
  }
  return { installed: false, error: "No supported package manager was found on PATH." };
}

export async function runDiagnosticsCommand(context: DiagnosticsCommandContext): Promise<void> {
  console.log(JSON.stringify(await buildDiagnostics(context), null, 2));
}

export async function buildDiagnostics(context: DiagnosticsCommandContext): Promise<unknown> {
  const runtimeConfig = unwrapConfigResult(resolveBridgeRuntimeConfig(currentProcessEnv(), {
    cwd: context.cwd?.() ?? process.cwd()
  }));
  const health = await context.readBridgeHealth();
  const state = context.readState();
  const codexSettings = bridgeCodexProviderSettings(state);
  const credentialStore = createDefaultCredentialStore({ path: context.credentialPath() });
  const relayRegistry = new FileRelayRegistry(context.relayRegistryPath());
  const diagnostics = {
    app: {
      statePath: context.appStatePath(),
      logPath: context.appLogPath(),
      supervisorPid: state.supervisorPid,
      pid: state.pid,
      device: state.device,
      controlTokenPresent: Boolean(state.controlToken),
      pairing: state.pairing ? {
        issuedAt: state.pairing.issuedAt,
        expiresAt: state.pairing.expiresAt,
        revokedAt: state.pairing.revokedAt
      } : undefined,
      account: state.account ?? { status: "signed-out" },
      pendingAuth: state.pendingAuth ? { present: true, startedAt: state.pendingAuth.startedAt } : undefined,
      credentialBackend: credentialStore.backend,
      credentialsPresent: credentialStore.read() !== undefined,
      remoteAccess: state.remoteAccess,
      projectGrantCount: state.projectGrants.length,
      projectGrants: context.snapshotProjectGrants(state.projectGrants),
      activeProjectGrants: context.activeManagedProjectGrants(state.projectGrants),
      service: state.service,
      codex: {
        binaryPathConfigured: Boolean(codexSettings.binaryPath),
        binaryPath: codexSettings.binaryPath
      }
    },
    bridge: {
      health,
      apiUrl: endpointUrl(runtimeConfig.bridgeApi),
      version: bridgeVersionInfo()
    },
    codex: await context.safeCodexDiagnostics(),
    recentProjects: listManagedRoadmapRegistry(context.roadmapRegistryOptions()).map(project => ({
      roadmapId: project.roadmapId,
      displayName: project.displayName,
      repositoryPath: project.repositoryPath,
      lifecycle: project.lifecycle,
      health: project.health,
      type: project.type,
      primaryAction: project.primaryAction
    })),
    relay: relayRegistry.listDevices(state.account?.status === "signed-in" ? state.account.userId : undefined).map(device => ({
      deviceId: device.deviceId,
      deviceName: device.deviceName,
      status: device.status,
      lastSeenAt: device.lastSeenAt
    }))
  };
  const safeDiagnostics = sanitizeDiagnostics(diagnostics);
  assertDiagnosticsSafe(safeDiagnostics);
  return safeDiagnostics;
}
