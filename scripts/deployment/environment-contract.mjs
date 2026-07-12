import {
  assertDeployTarget,
  requireEnv,
  validateBaseUrl
} from "./release-lib.mjs";

const PREVIEW_SEGMENT = /(?:^|[-_])preview(?:$|[-_])/iu;
const ACCESS_AUD_PATTERN = /^[A-Za-z0-9_-]{16,128}$/u;

export function validateEnvironmentContract(targetInput, env, urls = {}) {
  const target = assertDeployTarget(targetInput);
  const environment = {
    accountId: requireEnv("CLOUDFLARE_ACCOUNT_ID", env),
    pagesProject: requireEnv("HUNSU_WEB_PAGES_PROJECT", env),
    workerName: requireEnv("HUNSU_HUB_WORKER_NAME", env),
    originName: requireEnv("HUNSU_HUB_ORIGIN_NAME", env),
    d1DatabaseName: requireEnv("HUNSU_HUB_D1_DATABASE_NAME", env),
    d1DatabaseId: requireEnv("HUNSU_HUB_D1_DATABASE_ID", env),
    r2BucketName: requireEnv("HUNSU_HUB_R2_BUCKET_NAME", env),
    connectWorkerName: requireEnv("HUNSU_CONNECT_WORKER_NAME", env),
    connectD1DatabaseName: requireEnv("HUNSU_CONNECT_D1_DATABASE_NAME", env),
    connectD1DatabaseId: requireEnv("HUNSU_CONNECT_D1_DATABASE_ID", env),
    connectAccessIssuer: validateAccessIssuer(requireEnv("HUNSU_CONNECT_ACCESS_ISSUER", env)),
    connectAccessAud: validateAccessAudience(requireEnv("HUNSU_CONNECT_ACCESS_AUD", env)),
    connectSigningPublicJwk: validateP256PublicJwk(requireEnv("HUNSU_CONNECT_SIGNING_PUBLIC_JWK", env)),
    connectSigningKeyId: validateSigningKeyId(requireEnv("HUNSU_CONNECT_SIGNING_KEY_ID", env))
  };
  const resourceNames = [
    environment.pagesProject,
    environment.workerName,
    environment.d1DatabaseName,
    environment.r2BucketName,
    environment.connectWorkerName,
    environment.connectD1DatabaseName
  ];
  if (urls.webPublicUrl && new URL(urls.webPublicUrl).protocol !== "https:") {
    throw new Error("Remote Web URL must use HTTPS.");
  }
  if (urls.hubPublicApiUrl && new URL(urls.hubPublicApiUrl).protocol !== "https:") {
    throw new Error("Remote Hub API URL must use HTTPS.");
  }
  if (urls.connectApiBaseUrl && new URL(urls.connectApiBaseUrl).protocol !== "https:") {
    throw new Error("Remote Connect API URL must use HTTPS.");
  }
  if (urls.bridgeApiBaseUrl) {
    const bridgeUrl = new URL(urls.bridgeApiBaseUrl);
    if (bridgeUrl.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(bridgeUrl.hostname)) {
      throw new Error("Hosted Web must use an HTTP loopback HUNSU_BRIDGE_API_BASE_URL.");
    }
  }
  if (target === "preview") {
    if (!resourceNames.every(value => PREVIEW_SEGMENT.test(value))) {
      throw new Error("Every preview Cloudflare resource name must contain a preview segment.");
    }
    if (urls.webPublicUrl && new URL(urls.webPublicUrl).hostname !== "preview.hunsu.app") {
      throw new Error("Preview Web URL must be https://preview.hunsu.app.");
    }
    if (urls.hubPublicApiUrl && new URL(urls.hubPublicApiUrl).hostname !== "api.preview.hunsu.app") {
      throw new Error("Preview Hub API URL must be https://api.preview.hunsu.app.");
    }
    if (urls.connectApiBaseUrl && new URL(urls.connectApiBaseUrl).hostname !== "connect.preview.hunsu.app") {
      throw new Error("Preview Connect API URL must be https://connect.preview.hunsu.app.");
    }
  } else {
    if (resourceNames.some(value => PREVIEW_SEGMENT.test(value))) {
      throw new Error("Production deployment refuses Cloudflare resources marked preview.");
    }
    if (urls.webPublicUrl && new URL(urls.webPublicUrl).hostname !== "hunsu.app") {
      throw new Error("Production Web URL must be https://hunsu.app.");
    }
    if (urls.hubPublicApiUrl && new URL(urls.hubPublicApiUrl).hostname !== "api.hunsu.app") {
      throw new Error("Production Hub API URL must be https://api.hunsu.app.");
    }
    if (urls.connectApiBaseUrl && new URL(urls.connectApiBaseUrl).hostname !== "connect.hunsu.app") {
      throw new Error("Production Connect API URL must be https://connect.hunsu.app.");
    }
  }
  return environment;
}

export function validateAccessIssuer(value) {
  const domain = validateBaseUrl(value, "HUNSU_CONNECT_ACCESS_ISSUER");
  const url = new URL(domain);
  if (url.protocol !== "https:" || !url.hostname.endsWith(".cloudflareaccess.com") || url.pathname !== "/") {
    throw new Error("HUNSU_CONNECT_ACCESS_ISSUER must be an HTTPS Cloudflare Access team issuer.");
  }
  return domain;
}

export function validateAccessAudience(value) {
  const audience = String(value ?? "").trim();
  if (!ACCESS_AUD_PATTERN.test(audience)) {
    throw new Error("HUNSU_CONNECT_ACCESS_AUD must be one exact Cloudflare Access application audience.");
  }
  return audience;
}

export function validateP256PublicJwk(value) {
  let jwk;
  try {
    jwk = JSON.parse(String(value));
  } catch {
    throw new Error("HUNSU_CONNECT_SIGNING_PUBLIC_JWK must be valid JSON.");
  }
  if (!jwk || typeof jwk !== "object" || Array.isArray(jwk)
    || jwk.kty !== "EC" || jwk.crv !== "P-256"
    || !/^[A-Za-z0-9_-]{43}$/u.test(jwk.x)
    || !/^[A-Za-z0-9_-]{43}$/u.test(jwk.y)
    || "d" in jwk) {
    throw new Error("HUNSU_CONNECT_SIGNING_PUBLIC_JWK must be a public P-256 JWK without private material.");
  }
  return JSON.stringify({ kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y });
}

export function validateSigningKeyId(value) {
  const keyId = String(value ?? "").trim();
  if (!/^connect-[A-Za-z0-9_-]{16,64}$/u.test(keyId)) {
    throw new Error("HUNSU_CONNECT_SIGNING_KEY_ID must be a stable credential-free Connect key id.");
  }
  return keyId;
}
