import { createConfigStore, type BridgeConfig, type ConfigStore } from "../state/index.ts";
import { CodexRuntimeProvider } from "../runtime-providers/codex/codexProvider.ts";
import type { RuntimeProviderStatus } from "../runtime-providers/types.ts";
import { BridgeError } from "../client/cliResult.ts";

export type HeadlessProviderKind = "codex";

export type HeadlessProviderSummary = {
  providerId: HeadlessProviderKind;
  label: string;
  configured: boolean;
};

export type SetCodexProviderInput = {
  binaryPath?: string;
  home?: string;
};

export type HeadlessProviderService = {
  list(): Promise<HeadlessProviderSummary[]>;
  status(force?: boolean): Promise<RuntimeProviderStatus>;
  setCodex(input: SetCodexProviderInput): Promise<RuntimeProviderStatus>;
  resetCodex(): Promise<RuntimeProviderStatus>;
};

export function createHeadlessProviderService(input: {
  configStore: ConfigStore;
  env?: Record<string, string | undefined>;
}): HeadlessProviderService {
  const env = { ...(input.env ?? {}) };

  const providerFromConfig = (config: BridgeConfig): CodexRuntimeProvider => new CodexRuntimeProvider({
    env: () => env,
    settings: config.provider.kind === "codex"
      ? {
          ...(config.provider.binaryPath ? { binaryPath: config.provider.binaryPath } : {}),
          ...(config.provider.home ? { codexHome: config.provider.home } : {})
        }
      : {}
  });

  return {
    async list() {
      const config = await input.configStore.read();
      return [{ providerId: "codex", label: "Codex", configured: config.provider.kind === "codex" }];
    },
    async status(force = false) {
      const config = await input.configStore.read();
      return providerFromConfig(config).status({ force, env });
    },
    async setCodex(settings) {
      const config = await input.configStore.read();
      const next: BridgeConfig = {
        ...config,
        provider: {
          kind: "codex",
          ...(settings.binaryPath?.trim() ? { binaryPath: settings.binaryPath.trim() } : {}),
          ...(settings.home?.trim() ? { home: settings.home.trim() } : {})
        }
      };
      const status = await providerFromConfig(next).status({ force: true, env });
      if (!status.installed) {
        throw new BridgeError("PROVIDER_BINARY_NOT_FOUND", status.safeMessage ?? "Codex was not found by Hunsu Bridge.");
      }
      if (!status.configured) {
        throw new BridgeError("PROVIDER_CHECK_FAILED", status.safeMessage ?? "Codex could not initialize its app-server.");
      }
      await input.configStore.update(current => ({ ...current, provider: next.provider }));
      return status;
    },
    async resetCodex() {
      const next = await input.configStore.update(config => ({ ...config, provider: { kind: "unconfigured" } }));
      return providerFromConfig(next).status({ force: true, env });
    }
  };
}

export function createHeadlessProviderServiceForPaths(
  paths: Parameters<typeof createConfigStore>[0],
  env?: Record<string, string | undefined>
): HeadlessProviderService {
  return createHeadlessProviderService({ configStore: createConfigStore(paths), env });
}
