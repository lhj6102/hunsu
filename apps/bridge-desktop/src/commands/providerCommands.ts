import type { RuntimeProviderStatus } from "@hunsu/bridge";
import type { BridgeCodexSettings } from "../state/appState.ts";

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
