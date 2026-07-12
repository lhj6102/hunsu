export type DeploymentEnvironment = {
  accountId: string;
  pagesProject: string;
  workerName: string;
  originName: string;
  d1DatabaseName: string;
  d1DatabaseId: string;
  r2BucketName: string;
  connectWorkerName: string;
  connectD1DatabaseName: string;
  connectD1DatabaseId: string;
  connectAccessIssuer: string;
  connectAccessAud: string;
  connectSigningPublicJwk: string;
  connectSigningKeyId: string;
};

export function validateEnvironmentContract(
  target: unknown,
  env: Record<string, string | undefined>,
  urls?: Partial<Record<"webPublicUrl" | "hubPublicApiUrl" | "bridgeApiBaseUrl" | "connectApiBaseUrl", string>>
): DeploymentEnvironment;
export function validateAccessIssuer(value: unknown): string;
export function validateAccessAudience(value: unknown): string;
export function validateP256PublicJwk(value: unknown): string;
export function validateSigningKeyId(value: unknown): string;
