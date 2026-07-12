export const HUNSU_BRIDGE_VERSION: "0.2.0-next.4";
export const HUNSU_BRIDGE_PROTOCOL_VERSION: "local-bridge-v1";
export const BRIDGE_CLI_RESULT_SCHEMA: "hunsu.bridge.cli-result.v1";
export const BRIDGE_DEPLOYMENT_PROFILES: readonly ["production", "preview"];

export type BridgeDeploymentProfile = "production" | "preview";
export type BridgeDeploymentEndpoints = Readonly<{
  webUrl: string;
  connectApiUrl: string;
  connectWsUrl: string;
  connectTicketIssuer: string;
  connectTicketSigningKeyId: string;
  connectTicketSigningPublicJwk: Readonly<{ kty: "EC"; crv: "P-256"; x: string; y: string }>;
}>;

export type BridgeCliResult<T = unknown> =
  | { schema: "hunsu.bridge.cli-result.v1"; ok: true; code: string; message: string; value?: T }
  | { schema: "hunsu.bridge.cli-result.v1"; ok: false; code: string; message: string; recovery?: { command?: string; documentation?: string } };

export type HunsuPathInput = {
  home?: string;
  env?: Readonly<Record<string, string | undefined>>;
  platform?: "aix" | "android" | "darwin" | "freebsd" | "haiku" | "linux" | "netbsd" | "openbsd" | "sunos" | "win32" | "cygwin";
  userHome?: string;
  localAppData?: string;
};

export type HunsuPaths = {
  home: string;
  homeOwnershipFile: string;
  configFile: string;
  workspacesFile: string;
  credentialsFile: string;
  runtimeFile: string;
  logsDirectory: string;
  structuredLogFile: string;
  runtimeDirectory: string;
  runtimeStagingDirectory: string;
  runtimeVersionsDirectory: string;
  runtimeInstallFile: string;
  setupTransactionFile: string;
  setupLockFile: string;
  daemonLockFile: string;
};

export type BridgeHealth = {
  ok: true;
  service: "hunsu-bridge";
  version: string;
  protocolVersion: "local-bridge-v1";
  deploymentProfile: BridgeDeploymentProfile;
};

export type ControlEndpointProbe =
  | { state: "offline" }
  | { state: "foreign-listener" }
  | { state: "hunsu-healthy" }
  | { state: "hunsu-unhealthy"; status?: number };

export type BridgeControlRequest = {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
  timeoutMs?: number;
};

export type BridgeControlClient = {
  endpoint(): Promise<string>;
  probe(): Promise<ControlEndpointProbe>;
  health(): Promise<BridgeHealth | undefined>;
  request<T = unknown>(path: string, input?: BridgeControlRequest): Promise<BridgeCliResult<T>>;
};

export type ConnectSocket = {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open" | "close" | "error" | "message", listener: (event: { data?: unknown }) => void): void;
};

export type ConnectSocketFactory = (input: {
  url: string;
  headers: Readonly<Record<string, string>>;
}) => ConnectSocket | Promise<ConnectSocket>;

export type BridgeDaemonOptions = HunsuPathInput & {
  host?: string;
  port?: number;
  cwd?: string;
  runtimePath?: string;
  webUrl?: string;
  deploymentProfile?: BridgeDeploymentProfile;
  development?: boolean;
  serviceManager?: "windows-task-scheduler" | "macos-launch-agent" | "linux-systemd-user" | "development";
  fetchImpl?: typeof fetch;
  openBrowser?: (url: string) => Promise<void>;
  socketFactory?: ConnectSocketFactory;
};

export type BridgeRuntimeIdentity = {
  schema: "hunsu.bridge.runtime.v1";
  instanceId: string;
  daemonPid: number;
  version: string;
  protocolVersion: "local-bridge-v1";
  deploymentProfile: BridgeDeploymentProfile;
  startedAt: string;
  endpoint: string;
  runtimePath: string;
  serviceManager: NonNullable<BridgeDaemonOptions["serviceManager"]>;
  lastHealthyAt: string;
};

export type RunningBridgeDaemon = {
  identity: BridgeRuntimeIdentity;
  paths: HunsuPaths;
  server: { readonly listening: boolean };
  close(): Promise<void>;
  waitUntilClosed(): Promise<void>;
};

export function resolveHunsuHome(input?: HunsuPathInput): string;
export function isBridgeDeploymentProfile(value: unknown): value is BridgeDeploymentProfile;
export function bridgeDeploymentEndpoints(profile: BridgeDeploymentProfile): BridgeDeploymentEndpoints;
export function bridgeSetupPackageTag(profile: BridgeDeploymentProfile): "next" | "candidate-next";
export function resolveHunsuPaths(input?: HunsuPathInput): HunsuPaths;
export function createBridgeControlClient(options?: HunsuPathInput & {
  paths?: HunsuPaths;
  endpoint?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): BridgeControlClient;
export function startBridgeDaemon(options?: BridgeDaemonOptions): Promise<RunningBridgeDaemon>;
export function runBridgeCli(
  argv?: string[],
  io?: { stdout(text: string): void; stderr(text: string): void }
): Promise<number>;
