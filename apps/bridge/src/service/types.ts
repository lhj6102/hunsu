export type BridgeServiceManagerKind =
  | "systemd-user"
  | "launchd-user"
  | "windows-task-scheduler";

export type ServiceInstallInput = {
  nodePath: string;
  cliPath: string;
  hunsuHome: string;
  packageVersion: string;
  runtimePath: string;
};

export type ServiceErrorCode =
  | "SERVICE_NOT_INSTALLED"
  | "SERVICE_ALREADY_INSTALLED"
  | "SERVICE_INSTALL_FAILED"
  | "SERVICE_START_FAILED"
  | "SERVICE_STOP_FAILED"
  | "SERVICE_STATUS_UNAVAILABLE";

export type ServiceResult =
  | {
      ok: true;
      code: "OK" | "SERVICE_ALREADY_INSTALLED";
      message: string;
      manager: BridgeServiceManagerKind;
      changed: boolean;
    }
  | {
      ok: false;
      code: ServiceErrorCode;
      message: string;
      manager: BridgeServiceManagerKind;
    };

export type ServiceManagerState = "running" | "stopped" | "unknown";
export type ServiceHealthState = "healthy" | "offline" | "unavailable";
export type ServiceAuthenticationState = "authenticated" | "unauthorized" | "unavailable";

export type ServiceStatus = {
  installed: boolean;
  manager: BridgeServiceManagerKind;
  managerState: ServiceManagerState;
  health: ServiceHealthState;
  authentication: ServiceAuthenticationState;
  definitionPath: string;
  packageVersion?: string;
  runtimePath?: string;
  detail?: string;
};

export type BridgeServiceManager = {
  install(input: ServiceInstallInput): Promise<ServiceResult>;
  uninstall(): Promise<ServiceResult>;
  start(): Promise<ServiceResult>;
  stop(): Promise<ServiceResult>;
  restart(): Promise<ServiceResult>;
  status(): Promise<ServiceStatus>;
};

export type ServiceCommand = {
  command: string;
  args: string[];
};

export type ServiceCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type ServiceCommandRunner = (command: ServiceCommand) => Promise<ServiceCommandResult>;

export type ServiceFileSystem = {
  exists(path: string): Promise<boolean>;
  readText(path: string): Promise<string | undefined>;
  mkdir(path: string, options?: { mode?: number }): Promise<void>;
  writeText(path: string, text: string, options?: { mode?: number }): Promise<void>;
  remove(path: string): Promise<void>;
};

export type AuthenticatedServiceStatus =
  | { state: "authenticated"; value?: unknown }
  | { state: "unauthorized" }
  | { state: "unavailable" };

export type InstalledRuntimeInfo = {
  packageVersion: string;
  runtimePath: string;
};

export type ServiceLifecycleDependencies = {
  requestAuthenticatedShutdown: () => Promise<boolean>;
  probeHealth: () => Promise<boolean>;
  probeAuthenticatedStatus?: () => Promise<AuthenticatedServiceStatus>;
  readInstalledRuntime?: () => Promise<InstalledRuntimeInfo | undefined>;
  sleep?: (milliseconds: number) => Promise<void>;
  stopTimeoutMs?: number;
  pollIntervalMs?: number;
};

