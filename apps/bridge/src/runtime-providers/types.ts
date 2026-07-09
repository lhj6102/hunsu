export type RuntimeProviderKind =
  | "codex"
  | "claude_code"
  | "gemini_cli"
  | "openhands"
  | "acp_agent"
  | "litellm_gateway"
  | "openrouter_gateway"
  | "custom";

export type RuntimeProviderConnectionKind =
  | "local_cli"
  | "local_server"
  | "remote_agent_server"
  | "gateway";

export type RuntimeProviderAuthKind =
  | "none"
  | "chatgpt_oauth"
  | "api_key"
  | "device_flow"
  | "provider_owned"
  | "unknown";

export type RuntimeProviderRecommendedAction =
  | "install"
  | "select_binary"
  | "login"
  | "connect"
  | "configure"
  | "recheck"
  | "none";

export type RuntimeProviderConfigKey = {
  name: string;
  label: string;
  description?: string;
  required: boolean;
  secret: boolean;
  default?: string;
  primary: boolean;
  advanced?: boolean;
  kind:
    | "text"
    | "path"
    | "file"
    | "directory"
    | "select"
    | "boolean"
    | "oauth"
    | "device_code";
  options?: Array<{
    value: string;
    label: string;
  }>;
  envName?: string;
  placeholder?: string;
  validation?: {
    mustExist?: boolean;
    executable?: boolean;
    directory?: boolean;
  };
};

export type RuntimeProviderMetadata = {
  providerId: string;
  label: string;
  description: string;
  configKeys: RuntimeProviderConfigKey[];
  setupSteps?: string[];
};

export type RuntimeProviderConfigField = {
  key: string;
  value?: string | boolean;
  isSet: boolean;
  isSecret: boolean;
  label?: string;
};

export type RuntimeProviderDiagnostics = {
  effectiveEnv?: Record<string, string | null>;
  codexHome?: unknown;
  [key: string]: unknown;
};

export type RuntimeProviderCapabilities = {
  canExecute: boolean;
  canEditFiles: boolean;
  canRunShell: boolean;
  supportsWorktree: boolean;
  supportsEventStream: boolean;
  supportsUsage: boolean;
  supportsSubscriptionAuth: boolean;
  supportsDeviceAuth: boolean;
  supportsApiKeyAuth: boolean;
  supportsRemoteRelay: boolean;
  supportsAcp: boolean;
};

export type RuntimeProviderStatus = {
  providerId: string;
  kind: RuntimeProviderKind;
  label: string;
  description?: string;
  connectionKind: RuntimeProviderConnectionKind;
  installed: boolean;
  configured: boolean;
  authenticated: boolean | "unknown";
  ready: boolean;
  auth: {
    kind: RuntimeProviderAuthKind;
    state: "authenticated" | "not_authenticated" | "expired" | "invalid" | "unknown" | "error";
    access?: "subscription" | "usage_based" | "gateway" | "local" | "unknown";
    accountSummary?: {
      displayName?: string;
      email?: string;
      workspaceName?: string;
      planLabel?: string;
    };
    error?: string;
    homeDiagnostic?: unknown;
  };
  install?: {
    installed: boolean;
    binaryPath?: string;
    source?: string;
    version?: string;
    error?: string;
    discovery?: unknown;
  };
  usage?: {
    available: boolean;
    rateLimited?: boolean;
    summary?: {
      label?: string;
      resetAt?: string;
      remainingLabel?: string;
    };
    lastRunUsage?: {
      inputTokens: number;
      cachedInputTokens: number;
      outputTokens: number;
      reasoningTokens: number;
    };
    error?: string;
  };
  capabilities: RuntimeProviderCapabilities;
  recommendedAction: RuntimeProviderRecommendedAction;
  diagnostics?: RuntimeProviderDiagnostics;
  safeMessage?: string;
};

export type RuntimeProviderInstallPlan = {
  providerId: string;
  available: boolean;
  label: string;
  instructions?: string[];
  command?: string;
  args?: string[];
  confirmationRequired?: boolean;
};

export type RuntimeProviderInstallResult = {
  providerId: string;
  confirmed: boolean;
  started: boolean;
  status: "confirmation_required" | "already_installed" | "dry_run" | "completed" | "failed";
  message: string;
  plan?: RuntimeProviderInstallPlan;
  command?: string;
  args?: string[];
  exitCode?: number;
  output?: string;
  error?: string;
  providerStatus?: RuntimeProviderStatus;
};

export type RuntimeProviderLoginResult = {
  providerId: string;
  started: boolean;
  method: "default" | "chatgpt" | "device" | "api_key";
  message: string;
  command?: string;
  args?: string[];
  state?: string;
  status?: string;
  verificationUri?: string;
  verificationUriComplete?: string;
  userCode?: string;
  lastOutput?: string;
  error?: string;
};

export type RuntimeProviderConfigurationInput = {
  binaryPath?: string;
  selectBinaryPath?: string;
  clearBinaryPath?: boolean;
  authMethod?: "api_key";
  apiKey?: string;
  env?: Record<string, string | undefined>;
};

export type RuntimeProviderAdapter = {
  providerId: string;
  kind: RuntimeProviderKind;
  label: string;
  hiddenByDefault?: boolean;
  metadata(): RuntimeProviderMetadata;
  readConfig(): Promise<RuntimeProviderConfigField[]>;
  saveConfig(fields: RuntimeProviderConfigField[]): Promise<RuntimeProviderStatus>;
  deleteConfig?(keys?: string[]): Promise<RuntimeProviderStatus>;
  validateConfig?(fields: RuntimeProviderConfigField[]): Promise<{
    valid: boolean;
    provider: RuntimeProviderStatus;
    diagnostics?: RuntimeProviderDiagnostics;
  }>;
  status(input?: {
    force?: boolean;
    env?: Record<string, string | undefined>;
  }): Promise<RuntimeProviderStatus>;
  installPlan?(): Promise<RuntimeProviderInstallPlan>;
  install?(input?: {
    confirmed?: boolean;
    dryRun?: boolean;
    env?: Record<string, string | undefined>;
  }): Promise<RuntimeProviderInstallResult>;
  login?(input: {
    method: "default" | "chatgpt" | "device" | "api_key";
  }): Promise<RuntimeProviderLoginResult>;
  recheck(): Promise<RuntimeProviderStatus>;
  configure?(input: RuntimeProviderConfigurationInput): Promise<RuntimeProviderStatus>;
};

export type RuntimeProviderRegistry = {
  list(): RuntimeProviderAdapter[];
  get(providerId: string): RuntimeProviderAdapter | undefined;
  current(): RuntimeProviderAdapter;
  setCurrent(providerId: string): Promise<void>;
};

export const unavailableProviderCapabilities: RuntimeProviderCapabilities = {
  canExecute: false,
  canEditFiles: false,
  canRunShell: false,
  supportsWorktree: false,
  supportsEventStream: false,
  supportsUsage: false,
  supportsSubscriptionAuth: false,
  supportsDeviceAuth: false,
  supportsApiKeyAuth: false,
  supportsRemoteRelay: false,
  supportsAcp: false
};
