import { CodexRuntimeProvider, type CodexRuntimeProviderOptions } from "./codex.ts";
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
  providers?: RuntimeProviderAdapter[];
  codex?: CodexRuntimeProviderOptions;
} = {}): RuntimeProviderRegistry {
  let currentProviderId = input.currentProviderId ?? "codex";
  const providers = input.providers ?? [
    new CodexRuntimeProvider(input.codex),
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
      currentProviderId = next.providerId;
    }
  };
}

export function placeholderProvider(kind: Exclude<RuntimeProviderKind, "codex" | "custom">): RuntimeProviderAdapter {
  const label = providerLabels[kind];
  return {
    providerId: kind,
    kind,
    label,
    hiddenByDefault: true,
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
