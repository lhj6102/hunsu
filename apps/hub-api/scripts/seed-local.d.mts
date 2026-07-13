import type { HubPackageManifest } from "../../../packages/protocol-registry/src/index.ts";

interface SeedRequestOptions {
  baseUrl: string;
  token: string;
  attempts: number;
  delayMs: number;
  fetchImpl?: typeof fetch;
  sleep?: (delayMs: number) => Promise<void>;
}

export interface SeedHubPackagesOptions extends SeedRequestOptions {
  manifests: readonly HubPackageManifest[];
  log?: (message: string) => void;
}

export interface PublishSeedManifestOptions extends SeedRequestOptions {
  manifest: HubPackageManifest;
}

export declare function seedHubPackages(options: SeedHubPackagesOptions): Promise<void>;

export declare function publishSeedManifest(
  options: PublishSeedManifestOptions
): Promise<"published" | "already-present">;

export declare function waitForHubApi(
  url: string,
  maxAttempts: number,
  waitMs: number,
  fetchImpl?: typeof fetch,
  sleep?: (delayMs: number) => Promise<void>
): Promise<void>;
