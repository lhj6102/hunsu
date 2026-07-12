export const CLOUDFLARE_RESOURCE_ALLOWLIST_SCHEMA: "hunsu.cloudflare-resource-allowlist.v3";

export type CloudflareResourceAllowlist = {
  accountId: string;
  pagesProject: string;
  webPublicUrl: string;
  bridgeApiBaseUrl: string;
  connectApiBaseUrl: string;
  connectWorkerName: string;
  connectD1DatabaseName: string;
  connectD1DatabaseId: string;
  connectAccessIssuer: string;
  connectAccessAud: string;
  connectSigningPublicJwk: string;
  connectSigningKeyId: string;
  workerName: string;
  originName: string;
  hubPublicApiUrl: string;
  d1DatabaseName: string;
  d1DatabaseId: string;
  r2BucketName: string;
};

export function assertCloudflareResourceAllowlist(
  target: "preview" | "production",
  actual: CloudflareResourceAllowlist
): CloudflareResourceAllowlist;

export function cloudflareResourceAllowlist(
  target: "preview" | "production"
): CloudflareResourceAllowlist;
