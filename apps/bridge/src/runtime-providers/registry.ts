import { CodexRuntimeProvider, type CodexRuntimeProviderOptions } from "./codex/codexProvider.ts";
import { codexSettingsFromRecord, type BridgeCodexSettings } from "./codex/codexConfig.ts";
import {
  defaultBridgeRuntimeProviderState,
  normalizeBridgeRuntimeProviderState,
  type BridgeRuntimeProviderState,
  type RuntimeProviderStateStore
} from "./currentProviderStore.ts";
import {
  unavailableProviderCapabilities,
  type RuntimeProviderAdapter,
  type RuntimeProviderKind,
  type RuntimeProviderRegistry,
  type RuntimeProviderStatus
} from "./types.ts";

const providerLabels: Record<RuntimeProviderKind, string> = {
  codex: "Codex",
  claude_code: "Claude Code",
  gemini_cli: "Gemini CLI",
  openhands: "OpenHands Agent Server",
  acp_agent: "ACP Agent",
  litellm_gateway: "LiteLLM Gateway",
  openrouter_gateway: "OpenRouter Gateway",
  custom: "Custom Provider"
};

export function createRuntimeProviderRegistry(input: {
  currentProviderId?: string;
  providerState?: BridgeRuntimeProviderState;
  providerStateStore?: RuntimeProviderStateStore;
  providers?: RuntimeProviderAdapter[];
  codex?: CodexRuntimeProviderOptions;
} = {}): RuntimeProviderRegistry {
  let runtimeProviderState = normalizeBridgeRuntimeProviderState(
    input.providerState ?? input.providerStateStore?.read() ?? {
      ...defaultBridgeRuntimeProviderState(),
      currentProviderId: input.currentProviderId ?? "codex"
    }
  );
  let currentProviderId = runtimeProviderState.providers[runtimeProviderState.currentProviderId]?.enabled
    ? runtimeProviderState.currentProviderId
    : "codex";
  const providers = input.providers ?? [
    new CodexRuntimeProvider({
      ...input.codex,
      settings: runtimeProviderState.providers.codex?.settings ?? {},
      onConfigure(configuration) {
        runtimeProviderState = nextRuntimeProviderStateWithCodexSettings(runtimeProviderState, configuration);
        input.providerStateStore?.write(runtimeProviderState);
        input.codex?.onConfigure?.(configuration);
      }
    }),
    placeholderProvider("claude_code"),
    placeholderProvider("gemini_cli"),
    placeholderProvider("openhands"),
    placeholderProvider("acp_agent"),
    placeholderProvider("litellm_gateway"),
    placeholderProvider("openrouter_gateway")
  ];
  return {
    list: () => [...providers],
    get: providerId => providers.find(provider => provider.providerId === providerId),
    current: () => providers.find(provider => provider.providerId === currentProviderId) ?? providers[0],
    async setCurrent(providerId: string): Promise<void> {
      const next = providers.find(provider => provider.providerId === providerId);
      if (!next) {
        throw new Error(`Unknown runtime provider: ${providerId}`);
      }
      if (next.providerId !== "codex" || runtimeProviderState.providers[next.providerId]?.enabled !== true) {
        throw new Error(`${next.label} is not an enabled runtime provider yet.`);
      }
      currentProviderId = next.providerId;
      runtimeProviderState = normalizeBridgeRuntimeProviderState({
        ...runtimeProviderState,
        currentProviderId
      });
      input.providerStateStore?.write(runtimeProviderState);
    }
  };
}

function nextRuntimeProviderStateWithCodexSettings(
  state: BridgeRuntimeProviderState,
  configuration: BridgeCodexSettings
): BridgeRuntimeProviderState {
  const settings = codexSettingsToRecord(configuration);
  return normalizeBridgeRuntimeProviderState({
    ...state,
    providers: {
      ...state.providers,
      codex: {
        enabled: true,
        settings
      }
    }
  });
}

function codexSettingsToRecord(settings: BridgeCodexSettings): Record<string, unknown> {
  const normalized = codexSettingsFromRecord(settings as Record<string, unknown>);
  const record: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(normalized)) {
    if (value !== undefined) {
      record[key] = value;
    }
  }
  return record;
}

export function placeholderProvider(kind: Exclude<RuntimeProviderKind, "codex" | "custom">): RuntimeProviderAdapter {
  const label = providerLabels[kind];
  return {
    providerId: kind,
    kind,
    label,
    hiddenByDefault: true,
    metadata() {
      return {
        providerId: kind,
        label,
        description: "Future runtime provider.",
        configKeys: []
      };
    },
    async readConfig() {
      return [];
    },
    async saveConfig(): Promise<RuntimeProviderStatus> {
      throw new Error(`${label} does not support configuration yet.`);
    },
    async status(): Promise<RuntimeProviderStatus> {
      return {
        providerId: kind,
        kind,
        label,
        description: "Future runtime provider.",
        connectionKind: kind.includes("gateway") ? "gateway" : kind === "openhands" || kind === "acp_agent" ? "remote_agent_server" : "local_cli",
        installed: false,
        configured: false,
        authenticated: "unknown",
        ready: false,
        auth: {
          kind: "unknown",
          state: "unknown",
          access: "unknown"
        },
        install: {
          installed: false
        },
        usage: {
          available: false
        },
        capabilities: unavailableProviderCapabilities,
        recommendedAction: "configure",
        safeMessage: "Coming later"
      };
    },
    async recheck(): Promise<RuntimeProviderStatus> {
      return this.status();
    }
  };
}
