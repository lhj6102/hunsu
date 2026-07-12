export const CLOUDFLARE_RESOURCE_ALLOWLIST_SCHEMA: "hunsu.cloudflare-resource-allowlist.v2";

export type CloudflareResourceAllowlist = {
  accountId: string;
  pagesProject: string;
  webPublicUrl: string;
  bridgeApiBaseUrl: string;
  connectApiBaseUrl: string;
  connectWorkerName: string;
  connectD1DatabaseName: string;
  connectD1DatabaseId: string;
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
