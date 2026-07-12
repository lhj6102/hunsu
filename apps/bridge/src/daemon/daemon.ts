import { randomBytes } from "node:crypto";
import type { Server } from "node:http";
import { mkdir } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { resolveBridgeRuntimeConfig, unwrapConfigResult } from "@hunsu/config";
import {
  bridgeDeploymentEndpoints,
  isBridgeDeploymentProfile,
  type BridgeDeploymentEndpoints,
  type BridgeDeploymentProfile
} from "../deploymentProfile.ts";
import { createStudioServer, openStudioInBrowser } from "../index.ts";
import { endpointFromHostPort } from "../client/controlClient.ts";
import { BridgeError } from "../client/cliResult.ts";
import { createDoctorReport } from "../diagnostics/doctor.ts";
import { createStructuredLog } from "../diagnostics/structuredLog.ts";
import { createPairingService } from "../pairing/pairingService.ts";
import { createHeadlessProviderService } from "../provider/providerRegistry.ts";
import { createRemoteService, type ConnectSocketFactory } from "../remote/remoteService.ts";
import { createRemoteCommandRouter, createRemoteCommandStreamRouter } from "../remote/remoteCommandRouter.ts";
import type { PeerTransportFactory } from "../remote/peerTransport.ts";
import { createHeadlessControlRouteHandler } from "../server/controlRoutes.ts";
import {
  BRIDGE_RUNTIME_SCHEMA,
  createConfigStore,
  createCredentialStore,
  createRuntimeStore,
  createWorkspaceStore,
  resolveHunsuPaths,
  type BridgeCredentials,
  type BridgeRuntimeIdentity,
  type BridgeServiceManagerKind,
  type CredentialStore,
  type HunsuPathInput,
  type HunsuPaths
} from "../state/index.ts";
import { createWorkspaceService } from "../workspaces/workspaceService.ts";
import { HUNSU_BRIDGE_PROTOCOL_VERSION, HUNSU_BRIDGE_VERSION } from "../version.ts";
import { acquireDaemonStartupLock, probeDaemonEndpoint } from "./singleton.ts";

export type BridgeDaemonOptions = HunsuPathInput & {
  host?: string;
  port?: number;
  cwd?: string;
  runtimePath?: string;
  webUrl?: string;
  deploymentProfile?: BridgeDeploymentProfile;
  development?: boolean;
  serviceManager?: BridgeServiceManagerKind;
  fetchImpl?: typeof fetch;
  openBrowser?: (url: string) => Promise<void>;
  socketFactory?: ConnectSocketFactory;
  peerTransportFactory?: PeerTransportFactory;
};

export type RunningBridgeDaemon = {
  identity: BridgeRuntimeIdentity;
  paths: HunsuPaths;
  server: Server;
  close(): Promise<void>;
  waitUntilClosed(): Promise<void>;
};

export async function rotateDaemonControlCredential(input: {
  credentialStore: Pick<CredentialStore, "read" | "rotateControlToken">;
  activate: (controlToken: string) => void;
}): Promise<void> {
  try {
    await input.credentialStore.rotateControlToken({
      onCommitted: credentials => input.activate(credentials.controlToken)
    });
  } catch (error) {
    const authoritative = await input.credentialStore.read().catch(() => undefined);
    if (authoritative) input.activate(authoritative.controlToken);
    throw error;
  }
}

export async function startBridgeDaemon(options: BridgeDaemonOptions = {}): Promise<RunningBridgeDaemon> {
  const environment = { ...process.env, ...(options.env ?? {}) };
  const paths = resolveHunsuPaths({ ...options, env: environment });
  const requestedRuntimePath = options.runtimePath ?? options.cwd ?? process.cwd();
  if ((options.runtimePath !== undefined && !isAbsolute(options.runtimePath))
    || /[\u0000-\u001f\u007f]/u.test(requestedRuntimePath)) {
    throw new BridgeError("BRIDGE_STATE_INVALID", "Bridge runtime path must be absolute and contain no control characters.");
  }
  const runtimePath = resolve(requestedRuntimePath);
  await mkdir(paths.home, { recursive: true, mode: 0o700 });
  const configStore = createConfigStore(paths);
  const credentialStore = createCredentialStore(paths, { processEnv: environment });
  const runtimeStore = createRuntimeStore(paths);
  const requestedDeploymentProfile = options.deploymentProfile ?? "production";
  if (!isBridgeDeploymentProfile(requestedDeploymentProfile)) {
    throw new BridgeError("BRIDGE_STATE_INVALID", "Bridge deployment profile must be production or preview.");
  }
  const config = await configStore.ensureDeploymentProfile(requestedDeploymentProfile);
  const deploymentEndpoints = daemonDeploymentEndpoints({
    profile: config.deploymentProfile,
    development: options.development === true,
    environment,
    webUrl: options.webUrl
  });
  const requestedHost = options.host ?? config.host;
  const requestedPort = options.port ?? config.port;
  assertLoopbackHost(requestedHost);
  if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65_535) {
    throw new BridgeError("BRIDGE_STATE_INVALID", "Bridge port must be an integer from 0 through 65535.");
  }
  const existingCredentials = await credentialStore.read();
  const configuredEndpoint = endpointFromHostPort(loopbackEndpointHost(config.host), config.port);
  const startupLock = await acquireDaemonStartupLock({
    paths,
    endpoint: configuredEndpoint,
    controlToken: existingCredentials?.controlToken ?? "hunsu_control_unavailable",
    fetchImpl: options.fetchImpl
  });
  let credentials: BridgeCredentials;
  try {
    credentials = await credentialStore.ensure();
    const requestedEndpoint = endpointFromHostPort(loopbackEndpointHost(requestedHost), requestedPort);
    if (requestedEndpoint !== configuredEndpoint) {
      const requestedProbe = await probeDaemonEndpoint({
        endpoint: requestedEndpoint,
        controlToken: credentials.controlToken,
        fetchImpl: options.fetchImpl
      });
      if (requestedProbe.kind !== "unreachable") {
        throw requestedProbe.kind === "hunsu-authenticated"
          ? new BridgeError("BRIDGE_ALREADY_RUNNING", "Hunsu Bridge is already running.")
          : new BridgeError("BRIDGE_PORT_IN_USE", "The configured Hunsu Bridge port is already in use by another service.");
      }
    }
    if (requestedHost !== config.host || requestedPort !== config.port) {
      await configStore.update(current => ({ ...current, host: requestedHost, port: requestedPort }));
    }
  } catch (error) {
    await startupLock.release().catch(() => undefined);
    throw error;
  }
  let controlToken = credentials.controlToken;
  const structuredLog = createStructuredLog({ paths });
  const workspaceService = createWorkspaceService({ store: createWorkspaceStore(paths) });
  const providerService = createHeadlessProviderService({
    configStore,
    env: { ...environment, HUNSU_HOME: paths.home }
  });
  const pairingService = createPairingService({ controlToken: credentials.controlToken });
  let identity: BridgeRuntimeIdentity | undefined;
  const remoteCommandRouter = createRemoteCommandRouter({
    workspaceService,
    endpoint: () => identity?.endpoint,
    controlToken: () => controlToken,
    fetchImpl: options.fetchImpl
  });
  const remoteCommandStreamRouter = createRemoteCommandStreamRouter({
    workspaceService,
    endpoint: () => identity?.endpoint,
    controlToken: () => controlToken,
    fetchImpl: options.fetchImpl
  });
  const remoteService = createRemoteService({
    configStore,
    credentialStore,
    workspaceService,
    deploymentProfile: config.deploymentProfile,
    connectApiUrl: deploymentEndpoints.connectApiUrl,
    connectWsUrl: deploymentEndpoints.connectWsUrl,
    connectTicketIssuer: deploymentEndpoints.connectTicketIssuer,
    connectTicketSigningKeyId: deploymentEndpoints.connectTicketSigningKeyId,
    connectTicketSigningPublicJwk: deploymentEndpoints.connectTicketSigningPublicJwk,
    fetchImpl: options.fetchImpl,
    socketFactory: options.socketFactory,
    peerTransportFactory: options.peerTransportFactory,
    openBrowser: options.openBrowser ?? openStudioInBrowser,
    onCommand: remoteCommandRouter,
    onCommandStream: remoteCommandStreamRouter
  });
  const startedAt = new Date().toISOString();
  const serviceManager = options.serviceManager ?? serviceManagerForPlatform(options.development === true, options.platform ?? process.platform);
  const instanceId = `bridge_${randomBytes(16).toString("base64url")}`;
  let server: Server | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let finalized = false;
  let resolveClosed!: () => void;
  const closed = new Promise<void>(resolve => { resolveClosed = resolve; });

  const finalize = async (): Promise<void> => {
    if (finalized) return;
    finalized = true;
    if (heartbeat) clearInterval(heartbeat);
    remoteService.stop();
    if (identity) await runtimeStore.clear(identity.instanceId).catch(() => false);
    await startupLock.release().catch(() => undefined);
    await structuredLog.append({ level: "info", event: "daemon.stopped", message: "Hunsu Bridge stopped." }).catch(() => undefined);
    resolveClosed();
  };

  const close = async (): Promise<void> => {
    const activeServer = server;
    if (!activeServer || !activeServer.listening) {
      await finalize();
      return;
    }
    await new Promise<void>((resolve, reject) => {
      activeServer.close(error => error ? reject(error) : resolve());
    });
    await closed;
  };

  try {
    const processEnv = {
      ...environment,
      HUNSU_HOME: paths.home,
      HUNSU_BRIDGE_HOST: requestedHost,
      HUNSU_BRIDGE_PORT: String(requestedPort),
      HUNSU_ROADMAP_REGISTRY_PATH: paths.workspacesFile,
      HUNSU_WEB_URL: deploymentEndpoints.webUrl,
      HUNSU_CONNECT_API_BASE_URL: deploymentEndpoints.connectApiUrl,
      HUNSU_CONNECT_WS_URL: deploymentEndpoints.connectWsUrl
    };
    const runtimeConfig = unwrapConfigResult(resolveBridgeRuntimeConfig(processEnv, {
      cwd: options.cwd ?? process.cwd(),
      roadmapRegistryPath: paths.workspacesFile,
      processEnv
    }));
    const webUrl = deploymentEndpoints.webUrl;
    const allowedOrigin = new URL(webUrl).origin;
    const controlRouteHandler = createHeadlessControlRouteHandler({
      controlToken: () => controlToken,
      rotateControlToken: async () => {
        await rotateDaemonControlCredential({
          credentialStore,
          activate: nextControlToken => { controlToken = nextControlToken; }
        });
        await structuredLog.append({
          level: "info",
          event: "control.credential_rotated",
          message: "Hunsu Bridge control credential was rotated."
        }).catch(() => undefined);
      },
      runtimeIdentity: () => {
        if (!identity) throw new BridgeError("BRIDGE_CONTROL_UNAVAILABLE", "Hunsu Bridge is still starting.");
        return identity;
      },
      providerService,
      workspaceService,
      pairingService,
      remoteService,
      structuredLog,
      webUrl,
      openBrowser: options.openBrowser ?? openStudioInBrowser,
      doctor: () => createDoctorReport({ paths, providerService, online: true }),
      onShutdown: () => { void close(); }
    });
    server = createStudioServer({
      cwd: options.cwd ?? process.cwd(),
      roadmapRegistryPath: paths.workspacesFile,
      runtimeConfig,
      deploymentProfile: config.deploymentProfile,
      controlStatus: { deploymentProfile: config.deploymentProfile },
      security: {
        controlToken: () => controlToken,
        allowedOrigins: [allowedOrigin],
        requirePairing: true,
        pairingService
      },
      controlRouteHandler,
      providerService,
      headlessRemote: {
        enable: () => remoteService.enable(),
        disable: () => remoteService.disable()
      }
    });
    server.once("close", () => { void finalize(); });
    await listen(server, requestedHost, requestedPort);
    const address = server.address();
    if (!address || typeof address === "string") throw new BridgeError("BRIDGE_CONTROL_UNAVAILABLE", "Bridge listener address is unavailable.");
    const endpoint = endpointFromHostPort(loopbackEndpointHost(requestedHost), address.port);
    const healthyAt = new Date().toISOString();
    identity = {
      schema: BRIDGE_RUNTIME_SCHEMA,
      instanceId,
      daemonPid: process.pid,
      version: HUNSU_BRIDGE_VERSION,
      protocolVersion: HUNSU_BRIDGE_PROTOCOL_VERSION,
      deploymentProfile: config.deploymentProfile,
      startedAt,
      endpoint,
      runtimePath,
      serviceManager,
      lastHealthyAt: healthyAt
    };
    await runtimeStore.write(identity);
    if (requestedPort === 0) {
      await configStore.update(current => ({ ...current, host: requestedHost, port: address.port }));
    }
    await startupLock.release();
    await structuredLog.append({
      level: "info",
      event: "daemon.started",
      message: "Hunsu Bridge is ready.",
      data: {
        instanceId,
        endpoint,
        version: HUNSU_BRIDGE_VERSION,
        serviceManager,
        deploymentProfile: config.deploymentProfile
      }
    });
    heartbeat = setInterval(() => {
      if (!identity) return;
      identity = { ...identity, lastHealthyAt: new Date().toISOString() };
      void runtimeStore.write(identity).catch(error => structuredLog.append({
        level: "error",
        event: "runtime.write_failed",
        message: error instanceof Error ? error.message : "Runtime identity update failed."
      }).then(() => undefined));
    }, 30_000);
    heartbeat.unref();

    const currentConfig = await configStore.read();
    if (currentConfig.remote.enabled) {
      void remoteService.enable().catch(error => structuredLog.append({
        level: "warn",
        event: "remote.connect_failed",
        message: error instanceof Error ? error.message : "Remote Bridge could not connect."
      }).then(() => undefined));
    }
    const runningIdentity = identity;
    return {
      identity: runningIdentity,
      paths,
      server,
      close,
      waitUntilClosed: () => closed
    };
  } catch (error) {
    if (server?.listening) await new Promise<void>(resolve => server!.close(() => resolve()));
    await finalize();
    if (isErrno(error, "EADDRINUSE")) {
      throw new BridgeError("BRIDGE_PORT_IN_USE", "The configured Hunsu Bridge port is already in use.", { cause: error });
    }
    throw error;
  }
}

function daemonDeploymentEndpoints(input: {
  profile: BridgeDeploymentProfile;
  development: boolean;
  environment: Readonly<Record<string, string | undefined>>;
  webUrl?: string;
}): BridgeDeploymentEndpoints {
  const allowlisted = bridgeDeploymentEndpoints(input.profile);
  if (!input.development) {
    if (input.webUrl !== undefined && input.webUrl !== allowlisted.webUrl) {
      throw new BridgeError(
        "BRIDGE_STATE_INVALID",
        `Installed ${input.profile} Bridge daemons use the allowlisted Web URL for that profile.`
      );
    }
    return allowlisted;
  }
  return {
    webUrl: input.webUrl ?? input.environment.HUNSU_WEB_URL ?? allowlisted.webUrl,
    connectApiUrl: input.environment.HUNSU_CONNECT_API_BASE_URL ?? allowlisted.connectApiUrl,
    connectWsUrl: input.environment.HUNSU_CONNECT_WS_URL ?? allowlisted.connectWsUrl,
    connectTicketIssuer: allowlisted.connectTicketIssuer,
    connectTicketSigningKeyId: allowlisted.connectTicketSigningKeyId,
    connectTicketSigningPublicJwk: allowlisted.connectTicketSigningPublicJwk
  };
}

export async function runBridgeDaemon(options: BridgeDaemonOptions = {}): Promise<RunningBridgeDaemon> {
  const daemon = await startBridgeDaemon(options);
  const shutdown = (): void => { void daemon.close(); };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  try {
    await daemon.waitUntilClosed();
    return daemon;
  } finally {
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
  }
}

function listen(server: Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolve();
    });
  });
}

function assertLoopbackHost(host: string): void {
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1" && host !== "[::1]") {
    throw new BridgeError("BRIDGE_STATE_INVALID", "Hunsu Bridge must bind to a loopback address.");
  }
}

function loopbackEndpointHost(host: string): string {
  return host === "localhost" ? "127.0.0.1" : host === "[::1]" ? "::1" : host;
}

function serviceManagerForPlatform(development: boolean, platform: NodeJS.Platform): BridgeServiceManagerKind {
  if (development) return "development";
  if (platform === "win32") return "windows-task-scheduler";
  if (platform === "darwin") return "macos-launch-agent";
  return "linux-systemd-user";
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
}
