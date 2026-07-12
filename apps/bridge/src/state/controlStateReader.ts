import type { BridgeConfig } from "./configStore.ts";
import { createConfigStore } from "./configStore.ts";
import type { BridgeCredentials } from "./credentialStore.ts";
import { createCredentialStore } from "./credentialStore.ts";
import type { HunsuPaths } from "./paths.ts";

export type BridgeControlEndpointConfig = Pick<BridgeConfig, "host" | "port">;
export type BridgeControlCredential = Pick<BridgeCredentials, "controlToken">;

export type BridgeControlStateReader = {
  readEndpointConfig(): Promise<BridgeControlEndpointConfig>;
  readCredential(): Promise<BridgeControlCredential | undefined>;
};

export function createBridgeControlStateReader(paths: HunsuPaths): BridgeControlStateReader {
  return {
    async readEndpointConfig() {
      const { host, port } = await createConfigStore(paths).read();
      return { host, port };
    },
    async readCredential() {
      const credentials = await createCredentialStore(paths).read();
      return credentials ? { controlToken: credentials.controlToken } : undefined;
    }
  };
}
