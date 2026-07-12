// Generated binding surface. Regenerate with `pnpm --filter @hunsu/connect-api types:worker`.
interface Env {
  CONNECT_DB: D1Database;
  DEVICE_SIGNAL: DurableObjectNamespace<import("./device-signal-do.ts").DeviceSignalDO>;
  HUNSU_DEPLOY_TARGET: string;
  HUNSU_RELEASE_SHA: string;
  HUNSU_CONNECT_API_BASE_URL: string;
  HUNSU_WEB_PUBLIC_URL: string;
  HUNSU_CONNECT_ACCESS_ISSUER: string;
  HUNSU_CONNECT_ACCESS_AUD: string;
  HUNSU_CONNECT_SIGNING_PUBLIC_JWK: string;
  HUNSU_CONNECT_SIGNING_KEY_ID: string;
  HUNSU_CONNECT_SIGNING_PRIVATE_JWK: string;
}
