import type {
  RuntimeProviderConfigField,
  RuntimeProviderRegistry,
  RuntimeProviderStatus
} from "@hunsu/bridge";
import type { BridgeCodexSettings } from "../state/appState.ts";

type ProviderCommandContext = {
  hasFlag: (parsed: any, name: string) => boolean;
  getFlag: (parsed: any, name: string) => string | undefined;
  providerRegistry: () => RuntimeProviderRegistry;
};

export function providerStatusSummary(provider: RuntimeProviderStatus): string {
  if (provider.usage?.rateLimited) return "Rate Limited";
  if (provider.ready) return "Ready";
  if (provider.recommendedAction === "install") return "Not Found";
  if (provider.recommendedAction === "select_binary") return "Select Binary";
  if (provider.recommendedAction === "login") return "Login Required";
  if (provider.recommendedAction === "configure") return "Setup Required";
  if (provider.recommendedAction === "recheck") return "Needs Attention";
  return provider.safeMessage ?? "Unknown";
}

export function parseCodexInstallChannel(value: string | undefined): BridgeCodexSettings["installChannel"] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === "stable" || value === "latest" || value === "manual") {
    return value;
  }
  throw new Error(`Unknown Codex install channel: ${value}`);
}

export function parseCodexAuthenticationPreference(value: string | undefined): BridgeCodexSettings["authenticationPreference"] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === "chatgpt" || value === "api_key" || value === "device_code") {
    return value;
  }
  throw new Error(`Unknown Codex authentication preference: ${value}`);
}

export async function runProviderCommand(parsed: { rest: string[] }, context: ProviderCommandContext): Promise<void> {
  const action = parsed.rest[0] ?? "status";
  const registry = context.providerRegistry();
  const provider = registry.current();
  if (action === "status") {
    const status = await provider.status({ force: context.hasFlag(parsed, "recheck") });
    printOrJson(status, context.hasFlag(parsed, "json"), () => {
      console.log(`${provider.label}: ${providerStatusSummary(status)}`);
    });
    return;
  }
  if (action === "metadata") {
    const metadata = provider.metadata();
    printOrJson(metadata, context.hasFlag(parsed, "json"), () => {
      console.log(`${metadata.label}`);
      console.log(metadata.description);
      for (const key of metadata.configKeys) {
        console.log(`  ${key.name}: ${key.label}${key.required ? " (required)" : ""}`);
      }
    });
    return;
  }
  if (action === "config") {
    await runProviderConfigCommand(parsed, context, provider);
    return;
  }
  if (action === "authenticate" || action === "login") {
    if (!provider.login) {
      throw new Error("Current provider does not support authentication.");
    }
    const method = providerAuthMethod(parsed.rest[1] ?? context.getFlag(parsed, "method"));
    const result = await provider.login({ method });
    printOrJson(result, context.hasFlag(parsed, "json"), () => {
      console.log(result.message);
    });
    return;
  }
  throw new Error("Usage: hunsu-bridge provider status|metadata|config get|config set <key> <value>|config validate [key value]|config reset [key]|authenticate [chatgpt|device|api_key]");
}

async function runProviderConfigCommand(
  parsed: { rest: string[] },
  context: ProviderCommandContext,
  provider: ReturnType<RuntimeProviderRegistry["current"]>
): Promise<void> {
  const subcommand = parsed.rest[1] ?? "get";
  if (subcommand === "get") {
    const fields = await provider.readConfig();
    printOrJson({
      providerId: provider.providerId,
      metadata: provider.metadata(),
      fields
    }, context.hasFlag(parsed, "json"), () => {
      for (const field of fields) {
        const value = field.isSecret && field.isSet ? "(set)" : field.value ?? "";
        console.log(`${field.key}=${value}`);
      }
    });
    return;
  }
  if (subcommand === "set") {
    const key = parsed.rest[2];
    const value = parsed.rest.slice(3).join(" ");
    if (!key?.trim()) {
      throw new Error("Usage: hunsu-bridge provider config set <key> <value>");
    }
    const status = await provider.saveConfig([configField(key, value)]);
    printOrJson(status, context.hasFlag(parsed, "json"), () => {
      console.log(`${provider.label} config saved: ${key}`);
      console.log(`${provider.label}: ${providerStatusSummary(status)}`);
    });
    return;
  }
  if (subcommand === "save-json") {
    const fields = providerFieldsJson(parsed.rest[2]);
    const status = await provider.saveConfig(fields);
    printOrJson(status, context.hasFlag(parsed, "json"), () => {
      console.log(`${provider.label} config saved.`);
      console.log(`${provider.label}: ${providerStatusSummary(status)}`);
    });
    return;
  }
  if (subcommand === "validate") {
    if (!provider.validateConfig) {
      throw new Error("Current provider does not support configuration validation.");
    }
    const key = parsed.rest[2];
    const value = parsed.rest.slice(3).join(" ");
    const fields = key ? [configField(key, value)] : await provider.readConfig();
    const result = await provider.validateConfig(fields);
    printOrJson(result, context.hasFlag(parsed, "json"), () => {
      console.log(result.valid ? "Provider config is valid." : "Provider config is not valid.");
      console.log(`${provider.label}: ${providerStatusSummary(result.provider)}`);
    });
    return;
  }
  if (subcommand === "validate-json") {
    if (!provider.validateConfig) {
      throw new Error("Current provider does not support configuration validation.");
    }
    const result = await provider.validateConfig(providerFieldsJson(parsed.rest[2]));
    printOrJson(result, context.hasFlag(parsed, "json"), () => {
      console.log(result.valid ? "Provider config is valid." : "Provider config is not valid.");
      console.log(`${provider.label}: ${providerStatusSummary(result.provider)}`);
    });
    return;
  }
  if (subcommand === "reset" || subcommand === "delete") {
    if (!provider.deleteConfig) {
      throw new Error("Current provider does not support configuration reset.");
    }
    const keys = parsed.rest.slice(2).map(key => key.trim()).filter(Boolean);
    const status = await provider.deleteConfig(keys.length > 0 ? keys : undefined);
    printOrJson(status, context.hasFlag(parsed, "json"), () => {
      console.log(keys.length > 0 ? `${provider.label} config reset: ${keys.join(", ")}` : `${provider.label} config reset.`);
      console.log(`${provider.label}: ${providerStatusSummary(status)}`);
    });
    return;
  }
  throw new Error("Usage: hunsu-bridge provider config get|set <key> <value>|save-json <fields>|validate [key value]|validate-json <fields>|reset [key]");
}

function configField(key: string, value: string): RuntimeProviderConfigField {
  return {
    key: key.trim(),
    value,
    isSet: value.trim() !== "",
    isSecret: false
  };
}

function providerAuthMethod(value: string | undefined): "default" | "chatgpt" | "device" | "api_key" {
  if (value === undefined || value === "default") return "default";
  if (value === "chatgpt" || value === "device" || value === "api_key") return value;
  if (value === "device_code") return "device";
  throw new Error(`Unknown provider authentication method: ${value}`);
}

function providerFieldsJson(value: string | undefined): RuntimeProviderConfigField[] {
  if (!value?.trim()) {
    throw new Error("Provider config JSON fields are required.");
  }
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("Provider config JSON must be an array.");
  }
  return parsed.map(item => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error("Provider config JSON contains an invalid field.");
    }
    const field = item as Partial<RuntimeProviderConfigField>;
    if (typeof field.key !== "string" || !field.key.trim()) {
      throw new Error("Provider config JSON field is missing key.");
    }
    const value = typeof field.value === "string" || typeof field.value === "boolean" ? field.value : undefined;
    return {
      key: field.key,
      value,
      isSet: field.isSet === true,
      isSecret: field.isSecret === true
    };
  });
}

function printOrJson<T>(value: T, json: boolean, print: () => void): void {
  if (json) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  print();
}
