import type {
  RuntimeProviderConfigField,
  RuntimeProviderConfigKey,
  RuntimeProviderMetadata
} from "../types.ts";

export type BridgeCodexSettings = {
  binaryPath?: string;
  codexHome?: string;
  appServerCommand?: string;
  appServerArgs?: string;
  installChannel?: "stable" | "latest" | "manual";
  authenticationPreference?: "chatgpt" | "api_key" | "device_code";
};

export const codexConfigKeys: RuntimeProviderConfigKey[] = [
  {
    name: "binaryPath",
    envName: "HUNSU_CODEX_BINARY_PATH",
    label: "Codex binary",
    description: "Path to the Codex CLI executable used by Hunsu.",
    kind: "file",
    required: false,
    secret: false,
    primary: true,
    validation: {
      mustExist: true,
      executable: true
    }
  },
  {
    name: "codexHome",
    envName: "CODEX_HOME",
    label: "Codex home",
    description: "Directory where Codex stores auth and configuration. Usually ~/.codex.",
    kind: "directory",
    required: false,
    secret: false,
    primary: true,
    placeholder: "~/.codex",
    validation: {
      directory: true
    }
  },
  {
    name: "appServerCommand",
    envName: "HUNSU_CODEX_APP_SERVER_COMMAND",
    label: "App-server command",
    description: "Advanced override for the Codex command used by Hunsu.",
    kind: "text",
    required: false,
    secret: false,
    primary: false,
    advanced: true
  },
  {
    name: "appServerArgs",
    envName: "HUNSU_CODEX_APP_SERVER_ARGS",
    label: "App-server args",
    description: "Advanced app-server arguments.",
    kind: "text",
    required: false,
    secret: false,
    primary: false,
    advanced: true
  },
  {
    name: "authenticationPreference",
    label: "Authentication method",
    kind: "select",
    required: false,
    secret: false,
    primary: false,
    default: "chatgpt",
    options: [
      { value: "chatgpt", label: "ChatGPT sign-in" },
      { value: "device_code", label: "Device code" },
      { value: "api_key", label: "API key" }
    ]
  }
];

export const codexProviderMetadata: RuntimeProviderMetadata = {
  providerId: "codex",
  label: "Codex",
  description: "OpenAI Codex CLI through the local app-server boundary.",
  configKeys: codexConfigKeys,
  setupSteps: [
    "Choose the Codex executable Hunsu should use.",
    "Choose the Codex Home that contains the auth.json file for this daemon.",
    "Sign in or recheck after saving."
  ]
};

export const codexProviderConfigKeyNames = new Set(codexConfigKeys.map(key => key.name));

export function codexProviderEnv(input: {
  baseEnv: Record<string, string | undefined>;
  settings: BridgeCodexSettings;
}): Record<string, string | undefined> {
  return {
    ...input.baseEnv,
    ...(input.settings.binaryPath
      ? {
          HUNSU_CODEX_BINARY_PATH: input.settings.binaryPath,
          HUNSU_CODEX_BINARY_PATH_SOURCE: "user_config"
        }
      : {}),
    ...(input.settings.codexHome
      ? { CODEX_HOME: input.settings.codexHome }
      : {}),
    ...(input.settings.appServerCommand
      ? { HUNSU_CODEX_APP_SERVER_COMMAND: input.settings.appServerCommand }
      : {}),
    ...(input.settings.appServerArgs
      ? { HUNSU_CODEX_APP_SERVER_ARGS: input.settings.appServerArgs }
      : {})
  };
}

export function codexEffectiveEnvSummary(env: Record<string, string | undefined>): Record<string, string | null> {
  return {
    HUNSU_CODEX_BINARY_PATH: env.HUNSU_CODEX_BINARY_PATH ?? null,
    CODEX_HOME: env.CODEX_HOME ?? null,
    HUNSU_CODEX_APP_SERVER_COMMAND: env.HUNSU_CODEX_APP_SERVER_COMMAND ?? null,
    HUNSU_CODEX_APP_SERVER_ARGS: env.HUNSU_CODEX_APP_SERVER_ARGS ?? null
  };
}

export function codexSettingsFromRecord(record: Record<string, unknown> | undefined): BridgeCodexSettings {
  const binaryPath = stringSetting(record, "binaryPath");
  const codexHome = stringSetting(record, "codexHome");
  const appServerCommand = stringSetting(record, "appServerCommand");
  const appServerArgs = stringSetting(record, "appServerArgs");
  const installChannel = record?.installChannel === "stable" || record?.installChannel === "latest" || record?.installChannel === "manual"
    ? record.installChannel
    : undefined;
  const authenticationPreference =
    record?.authenticationPreference === "chatgpt"
      || record?.authenticationPreference === "api_key"
      || record?.authenticationPreference === "device_code"
      ? record.authenticationPreference
      : undefined;
  return {
    ...(binaryPath ? { binaryPath } : {}),
    ...(codexHome ? { codexHome } : {}),
    ...(appServerCommand ? { appServerCommand } : {}),
    ...(appServerArgs ? { appServerArgs } : {}),
    ...(installChannel ? { installChannel } : {}),
    ...(authenticationPreference ? { authenticationPreference } : {})
  };
}

export function codexConfigFieldsFromSettings(settings: BridgeCodexSettings): RuntimeProviderConfigField[] {
  return codexConfigKeys.map(key => {
    const value = settings[key.name as keyof BridgeCodexSettings];
    const stringValue = typeof value === "string" ? value : undefined;
    return {
      key: key.name,
      value: stringValue ?? key.default,
      isSet: Boolean(stringValue),
      isSecret: key.secret,
      label: key.label
    };
  });
}

export function settingsWithCodexConfigFields(
  current: BridgeCodexSettings,
  fields: RuntimeProviderConfigField[]
): BridgeCodexSettings {
  const next: BridgeCodexSettings = { ...current };
  for (const field of fields) {
    const key = field.key.trim();
    if (!codexProviderConfigKeyNames.has(key)) {
      throw new Error(`Unsupported Codex provider config key: ${key}`);
    }
    const value = typeof field.value === "string" ? field.value.trim() : "";
    switch (key) {
      case "binaryPath":
        setOptional(next, "binaryPath", value);
        break;
      case "codexHome":
        setOptional(next, "codexHome", value);
        break;
      case "appServerCommand":
        setOptional(next, "appServerCommand", value);
        break;
      case "appServerArgs":
        setOptional(next, "appServerArgs", value);
        break;
      case "authenticationPreference":
        if (value === "") {
          delete next.authenticationPreference;
        } else if (value === "chatgpt" || value === "api_key" || value === "device_code") {
          next.authenticationPreference = value;
        } else {
          throw new Error(`Unsupported Codex authenticationPreference: ${value}`);
        }
        break;
    }
  }
  return next;
}

function setOptional<T extends "binaryPath" | "codexHome" | "appServerCommand" | "appServerArgs">(
  settings: BridgeCodexSettings,
  key: T,
  value: string
): void {
  if (value) {
    settings[key] = value;
  } else {
    delete settings[key];
  }
}

function stringSetting(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
