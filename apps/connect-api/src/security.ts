import {
  SignJWT,
  calculateJwkThumbprint,
  createRemoteJWKSet,
  decodeProtectedHeader,
  importJWK,
  jwtVerify,
  type JWK,
  type JWTPayload
} from "jose";
import {
  CONNECT_DEVICE_ACCESS_TTL_SECONDS,
  CONNECT_ENROLLMENT_SCHEMA,
  CONNECT_SESSION_TICKET_AUDIENCE,
  CONNECT_SESSION_TICKET_TYPE,
  CONNECT_SESSION_TTL_SECONDS,
  connectEnrollmentProofMessage,
  decodeConnectP256PublicJwk,
  type ConnectEnrollmentRequest,
  type ConnectEnvironment,
  type ConnectP256PublicJwk,
  type ConnectSessionTicketClaims
} from "../../../packages/protocol/src/connect.ts";

export const CONNECT_SESSION_COOKIE = "__Host-hunsu_connect_session";
export const MAX_CONNECT_BODY_BYTES = 96 * 1024;
export const DEVICE_ACCESS_AUDIENCE = "hunsu-connect-device";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export type ConnectRuntimeConfig = {
  target: "local" | "dev" | ConnectEnvironment;
  release: string;
  apiOrigin: string;
  webOrigin: string;
  accessIssuer: string;
  accessAudience: string;
  signingPublicJwk: ConnectP256PublicJwk;
  signingPrivateJwk: JWK;
  signingKeyId: string;
};

export type AccessIdentity = {
  subject: string;
  email?: string;
};

export type VerifiedDpopProof = {
  jti: string;
  jtiHash: string;
  expiresAtMs: number;
};

export type VerifiedDeviceAccess = {
  deviceId: string;
  accountId: string;
  authEpoch: number;
  signingJkt: string;
  expiresAtMs: number;
};

export class ConnectHttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ConnectHttpError";
    this.status = status;
    this.code = code;
  }
}

export function resolveConnectRuntimeConfig(env: Env): ConnectRuntimeConfig {
  const target = env.HUNSU_DEPLOY_TARGET;
  if (target !== "local" && target !== "dev" && target !== "preview" && target !== "production") {
    throw new ConnectHttpError(500, "connect_config_invalid", "Connect deployment target is invalid.");
  }
  const hosted = target === "preview" || target === "production";
  const apiOrigin = exactOrigin(env.HUNSU_CONNECT_API_BASE_URL, "Connect API origin", hosted);
  const webOrigin = exactOrigin(env.HUNSU_WEB_PUBLIC_URL, "Hunsu Web origin", hosted);
  const accessIssuer = exactAccessIssuer(env.HUNSU_CONNECT_ACCESS_ISSUER);
  const accessAudience = boundedPrintable(env.HUNSU_CONNECT_ACCESS_AUD, "Cloudflare Access audience", 256);
  const signingKeyId = boundedPrintable(env.HUNSU_CONNECT_SIGNING_KEY_ID, "Connect signing key id", 128);
  if (!/^connect-[A-Za-z0-9_-]{16,64}$/u.test(signingKeyId)) {
    throw new ConnectHttpError(500, "connect_config_invalid", "Connect signing key id is invalid.");
  }
  const signingPublicJwk = parsePublicJwk(env.HUNSU_CONNECT_SIGNING_PUBLIC_JWK, "Connect signing public JWK");
  const signingPrivateJwk = parsePrivateJwk(env.HUNSU_CONNECT_SIGNING_PRIVATE_JWK, signingPublicJwk);
  return {
    target,
    release: boundedPrintable(env.HUNSU_RELEASE_SHA, "release", 128),
    apiOrigin,
    webOrigin,
    accessIssuer,
    accessAudience,
    signingPublicJwk,
    signingPrivateJwk,
    signingKeyId
  };
}

export function requireExactRequestHost(request: Request, config: ConnectRuntimeConfig): URL {
  const url = new URL(request.url);
  if (url.origin !== config.apiOrigin || url.username || url.password) {
    throw new ConnectHttpError(421, "connect_host_denied", "Request host does not match this Connect deployment.");
  }
  return url;
}

export function requireBrowserOrigin(request: Request, config: ConnectRuntimeConfig): void {
  if (request.headers.get("origin") !== config.webOrigin) {
    throw new ConnectHttpError(403, "connect_origin_denied", "Request origin is not allowed.");
  }
}

export function rejectForeignOrigin(request: Request, config: ConnectRuntimeConfig): void {
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== config.webOrigin) {
    throw new ConnectHttpError(403, "connect_origin_denied", "Request origin is not allowed.");
  }
}

export function corsPreflight(request: Request, config: ConnectRuntimeConfig): Response {
  requireBrowserOrigin(request, config);
  const requestedMethod = request.headers.get("access-control-request-method")?.toUpperCase();
  if (!requestedMethod || !["GET", "POST", "DELETE"].includes(requestedMethod)) {
    throw new ConnectHttpError(403, "connect_cors_denied", "Requested CORS method is not allowed.");
  }
  const headers = (request.headers.get("access-control-request-headers") ?? "")
    .split(",")
    .map(value => value.trim().toLowerCase())
    .filter(Boolean);
  if (headers.some(value => value !== "content-type")) {
    throw new ConnectHttpError(403, "connect_cors_denied", "Requested CORS header is not allowed.");
  }
  return new Response(null, { status: 204, headers: browserCorsHeaders(config.webOrigin) });
}

export async function verifyAccessIdentity(request: Request, config: ConnectRuntimeConfig): Promise<AccessIdentity> {
  const assertion = request.headers.get("cf-access-jwt-assertion");
  if (!assertion || assertion.length > 16_384) {
    throw new ConnectHttpError(403, "connect_access_denied", "Cloudflare Access assertion is required.");
  }
  try {
    const jwks = createRemoteJWKSet(new URL(`${config.accessIssuer}/cdn-cgi/access/certs`), {
      timeoutDuration: 5_000,
      cooldownDuration: 30_000,
      cacheMaxAge: 10 * 60_000
    });
    const verified = await jwtVerify(assertion, jwks, {
      issuer: config.accessIssuer,
      audience: config.accessAudience,
      algorithms: ["RS256"],
      clockTolerance: 5
    });
    return accessIdentityFromPayload(verified.payload);
  } catch (error) {
    if (error instanceof ConnectHttpError) throw error;
    console.warn(JSON.stringify({ event: "connect.access.denied", reason: error instanceof Error ? error.name : "unknown" }));
    throw new ConnectHttpError(403, "connect_access_denied", "Cloudflare Access assertion is invalid.");
  }
}

export function accessIdentityFromPayload(payload: JWTPayload): AccessIdentity {
  if (typeof payload.sub !== "string" || !payload.sub.trim() || payload.sub.length > 512) {
    throw new ConnectHttpError(403, "connect_access_denied", "Cloudflare Access identity has no valid subject.");
  }
  const email = typeof payload.email === "string" && payload.email.trim() && payload.email.length <= 320
    ? payload.email.trim().toLowerCase()
    : undefined;
  return { subject: payload.sub.trim(), ...(email ? { email } : {}) };
}

export async function accountIdForSubject(subject: string): Promise<string> {
  return `ca_${await hashSecret(subject)}`;
}

export async function decodeAndVerifyEnrollment(value: unknown, nowMs: number): Promise<ConnectEnrollmentRequest> {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    "schema", "deviceName", "signingPublicJwk", "agreementPublicJwk", "issuedAt", "nonce", "proof"
  ])) {
    throw new ConnectHttpError(400, "connect_enrollment_invalid", "Enrollment request has unknown or missing fields.");
  }
  if (value.schema !== CONNECT_ENROLLMENT_SCHEMA) {
    throw new ConnectHttpError(400, "connect_enrollment_invalid", "Enrollment schema is not supported.");
  }
  const deviceName = boundedPrintable(value.deviceName, "device name", 128);
  const signing = decodeConnectP256PublicJwk(value.signingPublicJwk, "signingPublicJwk");
  const agreement = decodeConnectP256PublicJwk(value.agreementPublicJwk, "agreementPublicJwk");
  if (!signing.ok) throw new ConnectHttpError(400, "connect_enrollment_invalid", signing.error.message);
  if (!agreement.ok) throw new ConnectHttpError(400, "connect_enrollment_invalid", agreement.error.message);
  const issuedAt = boundedPrintable(value.issuedAt, "issuedAt", 64);
  const issuedAtMs = Date.parse(issuedAt);
  if (!Number.isFinite(issuedAtMs)
    || new Date(issuedAtMs).toISOString() !== issuedAt
    || Math.abs(nowMs - issuedAtMs) > 5 * 60_000) {
    throw new ConnectHttpError(400, "connect_enrollment_expired", "Enrollment proof timestamp is outside the allowed window.");
  }
  const nonce = boundedBase64Url(value.nonce, "nonce", 16, 64);
  const proof = boundedBase64Url(value.proof, "proof", 64, 64);
  const [signingJkt, agreementJkt] = await Promise.all([
    publicJwkThumbprint(signing.value),
    publicJwkThumbprint(agreement.value)
  ]);
  if (signingJkt === agreementJkt) {
    throw new ConnectHttpError(400, "connect_enrollment_invalid", "Signing and agreement keys must be distinct.");
  }
  const enrollment: ConnectEnrollmentRequest = {
    schema: CONNECT_ENROLLMENT_SCHEMA,
    deviceName,
    signingPublicJwk: signing.value,
    agreementPublicJwk: agreement.value,
    issuedAt: new Date(issuedAtMs).toISOString(),
    nonce,
    proof
  };
  const key = await crypto.subtle.importKey(
    "jwk",
    signing.value,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"]
  );
  const valid = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    Uint8Array.from(decodeBase64Url(proof)).buffer,
    encoder.encode(connectEnrollmentProofMessage(enrollment))
  );
  if (!valid) {
    throw new ConnectHttpError(403, "connect_enrollment_proof_invalid", "Enrollment proof of possession is invalid.");
  }
  return enrollment;
}

export async function publicJwkThumbprint(jwk: ConnectP256PublicJwk): Promise<string> {
  return calculateJwkThumbprint(jwk, "sha256");
}

export async function verifyDpopProof(
  request: Request,
  expectedJkt: string,
  accessToken?: string,
  nowMs = Date.now()
): Promise<VerifiedDpopProof> {
  const proof = request.headers.get("dpop");
  if (!proof || proof.length > 8_192) {
    throw new ConnectHttpError(401, "connect_dpop_required", "A DPoP proof is required.");
  }
  let protectedHeader: ReturnType<typeof decodeProtectedHeader>;
  try {
    protectedHeader = decodeProtectedHeader(proof);
  } catch {
    throw new ConnectHttpError(401, "connect_dpop_invalid", "DPoP proof header is invalid.");
  }
  if (protectedHeader.alg !== "ES256" || protectedHeader.typ?.toLowerCase() !== "dpop+jwt") {
    throw new ConnectHttpError(401, "connect_dpop_invalid", "DPoP proof must use ES256 and typ dpop+jwt.");
  }
  const publicJwk = decodeConnectP256PublicJwk(protectedHeader.jwk, "dpop.jwk");
  if (!publicJwk.ok || await publicJwkThumbprint(publicJwk.value) !== expectedJkt) {
    throw new ConnectHttpError(401, "connect_dpop_invalid", "DPoP proof key does not match the enrolled device key.");
  }
  let payload: JWTPayload;
  try {
    const key = await importJWK(publicJwk.value, "ES256");
    payload = (await jwtVerify(proof, key, { algorithms: ["ES256"], clockTolerance: 5 })).payload;
  } catch {
    throw new ConnectHttpError(401, "connect_dpop_invalid", "DPoP proof signature is invalid.");
  }
  const url = new URL(request.url);
  const expectedHtu = `${url.origin}${url.pathname}`;
  if (payload.htm !== request.method.toUpperCase() || payload.htu !== expectedHtu) {
    throw new ConnectHttpError(401, "connect_dpop_invalid", "DPoP proof is not bound to this request.");
  }
  if (typeof payload.iat !== "number" || Math.abs(Math.floor(nowMs / 1_000) - payload.iat) > 60) {
    throw new ConnectHttpError(401, "connect_dpop_expired", "DPoP proof timestamp is outside the allowed window.");
  }
  if (typeof payload.jti !== "string" || !/^[A-Za-z0-9_-]{16,256}$/u.test(payload.jti)) {
    throw new ConnectHttpError(401, "connect_dpop_invalid", "DPoP proof jti is invalid.");
  }
  if (accessToken) {
    const expectedAth = await hashSecret(accessToken);
    if (payload.ath !== expectedAth) {
      throw new ConnectHttpError(401, "connect_dpop_invalid", "DPoP proof is not bound to the access token.");
    }
  } else if (payload.ath !== undefined) {
    throw new ConnectHttpError(401, "connect_dpop_invalid", "DPoP proof contains an unexpected access-token binding.");
  }
  return {
    jti: payload.jti,
    jtiHash: await hashSecret(payload.jti),
    expiresAtMs: (payload.iat + 120) * 1_000
  };
}

export async function signDeviceAccessToken(
  config: ConnectRuntimeConfig,
  input: { deviceId: string; accountId: string; authEpoch: number; signingJkt: string },
  nowMs: number
): Promise<{ token: string; expiresAtMs: number }> {
  const issuedAt = Math.floor(nowMs / 1_000);
  const expiresAt = issuedAt + CONNECT_DEVICE_ACCESS_TTL_SECONDS;
  const key = await importJWK(config.signingPrivateJwk, "ES256");
  const token = await new SignJWT({
    deviceId: input.deviceId,
    accountId: input.accountId,
    authEpoch: input.authEpoch,
    cnf: { jkt: input.signingJkt }
  })
    .setProtectedHeader({ alg: "ES256", typ: "at+jwt", kid: config.signingKeyId })
    .setIssuer(config.apiOrigin)
    .setAudience(DEVICE_ACCESS_AUDIENCE)
    .setSubject(input.deviceId)
    .setJti(randomToken("caj_", 20))
    .setIssuedAt(issuedAt)
    .setNotBefore(issuedAt - 5)
    .setExpirationTime(expiresAt)
    .sign(key);
  return { token, expiresAtMs: expiresAt * 1_000 };
}

export async function verifyDeviceAccessToken(
  token: string,
  config: ConnectRuntimeConfig,
  nowMs: number
): Promise<VerifiedDeviceAccess> {
  if (!token || token.length > 8_192) {
    throw new ConnectHttpError(401, "connect_access_token_invalid", "Device access token is invalid.");
  }
  try {
    const key = await importJWK(config.signingPublicJwk, "ES256");
    const { payload, protectedHeader } = await jwtVerify(token, key, {
      issuer: config.apiOrigin,
      audience: DEVICE_ACCESS_AUDIENCE,
      algorithms: ["ES256"],
      clockTolerance: 5,
      currentDate: new Date(nowMs)
    });
    if (protectedHeader.kid !== config.signingKeyId || protectedHeader.typ !== "at+jwt") {
      throw new Error("access header mismatch");
    }
    const deviceId = requiredId(payload.deviceId, "deviceId", "cd_");
    const accountId = requiredId(payload.accountId, "accountId", "ca_");
    if (payload.sub !== deviceId || !Number.isSafeInteger(payload.authEpoch) || Number(payload.authEpoch) < 0) {
      throw new Error("access claims invalid");
    }
    const cnf = payload.cnf;
    if (!isRecord(cnf) || typeof cnf.jkt !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(cnf.jkt)) {
      throw new Error("access confirmation invalid");
    }
    if (typeof payload.exp !== "number") throw new Error("access expiry missing");
    return {
      deviceId,
      accountId,
      authEpoch: Number(payload.authEpoch),
      signingJkt: cnf.jkt,
      expiresAtMs: payload.exp * 1_000
    };
  } catch (error) {
    if (error instanceof ConnectHttpError) throw error;
    throw new ConnectHttpError(401, "connect_access_token_invalid", "Device access token is invalid.");
  }
}

export async function signConnectSessionTicket(
  config: ConnectRuntimeConfig,
  input: {
    sessionId: string;
    accountId: string;
    deviceId: string;
    browserAgreementPublicJwk: ConnectP256PublicJwk;
    jti: string;
  },
  nowMs: number
): Promise<{ ticket: string; claims: ConnectSessionTicketClaims; expiresAtMs: number }> {
  if (config.target !== "preview" && config.target !== "production") {
    throw new ConnectHttpError(503, "connect_session_unavailable", "Signed Connect sessions are available only in preview and production.");
  }
  const issuedAt = Math.floor(nowMs / 1_000);
  const expiresAt = issuedAt + CONNECT_SESSION_TTL_SECONDS;
  const claims: ConnectSessionTicketClaims = {
    iss: config.apiOrigin,
    aud: CONNECT_SESSION_TICKET_AUDIENCE,
    sub: input.deviceId,
    jti: input.jti,
    environment: config.target,
    sessionId: input.sessionId,
    accountId: input.accountId,
    deviceId: input.deviceId,
    browserAgreementPublicJwk: input.browserAgreementPublicJwk,
    iat: issuedAt,
    exp: expiresAt
  };
  const key = await importJWK(config.signingPrivateJwk, "ES256");
  const ticket = await new SignJWT({
    environment: claims.environment,
    sessionId: claims.sessionId,
    accountId: claims.accountId,
    deviceId: claims.deviceId,
    browserAgreementPublicJwk: claims.browserAgreementPublicJwk
  })
    .setProtectedHeader({ alg: "ES256", typ: CONNECT_SESSION_TICKET_TYPE, kid: config.signingKeyId })
    .setIssuer(claims.iss)
    .setAudience(claims.aud)
    .setSubject(claims.sub)
    .setJti(claims.jti)
    .setIssuedAt(claims.iat)
    .setExpirationTime(claims.exp)
    .sign(key);
  return { ticket, claims, expiresAtMs: expiresAt * 1_000 };
}

export async function verifyConnectSessionTicket(
  ticket: string,
  config: ConnectRuntimeConfig,
  nowMs: number
): Promise<ConnectSessionTicketClaims> {
  if (!ticket || ticket.length > 12_288 || (config.target !== "preview" && config.target !== "production")) {
    throw new ConnectHttpError(401, "connect_session_ticket_invalid", "Connect session ticket is invalid.");
  }
  try {
    const key = await importJWK(config.signingPublicJwk, "ES256");
    const { payload, protectedHeader } = await jwtVerify(ticket, key, {
      issuer: config.apiOrigin,
      audience: CONNECT_SESSION_TICKET_AUDIENCE,
      algorithms: ["ES256"],
      clockTolerance: 5,
      currentDate: new Date(nowMs)
    });
    if (protectedHeader.alg !== "ES256"
      || protectedHeader.typ !== CONNECT_SESSION_TICKET_TYPE
      || protectedHeader.kid !== config.signingKeyId) {
      throw new Error("ticket header mismatch");
    }
    const deviceId = requiredId(payload.deviceId, "deviceId", "cd_");
    const sessionId = requiredId(payload.sessionId, "sessionId", "cs_");
    const accountId = requiredId(payload.accountId, "accountId", "ca_");
    const jti = requiredId(payload.jti, "jti", "ctj_");
    const browserKey = decodeConnectP256PublicJwk(payload.browserAgreementPublicJwk, "browserAgreementPublicJwk");
    if (!browserKey.ok
      || payload.sub !== deviceId
      || payload.environment !== config.target
      || typeof payload.iat !== "number"
      || typeof payload.exp !== "number"
      || payload.exp - payload.iat > CONNECT_SESSION_TTL_SECONDS
      || payload.exp <= payload.iat
      || payload.iat > Math.floor(nowMs / 1_000) + 5) {
      throw new Error("ticket claims mismatch");
    }
    return {
      iss: config.apiOrigin,
      aud: CONNECT_SESSION_TICKET_AUDIENCE,
      sub: deviceId,
      jti,
      environment: config.target,
      sessionId,
      accountId,
      deviceId,
      browserAgreementPublicJwk: browserKey.value,
      iat: payload.iat,
      exp: payload.exp
    };
  } catch (error) {
    if (error instanceof ConnectHttpError) throw error;
    throw new ConnectHttpError(401, "connect_session_ticket_invalid", "Connect session ticket is invalid or expired.");
  }
}

export async function readJsonBody(request: Request, maxBytes = MAX_CONNECT_BODY_BYTES): Promise<unknown> {
  const type = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (type !== "application/json") {
    throw new ConnectHttpError(415, "connect_media_type_invalid", "Request body must use application/json.");
  }
  const text = await readBoundedBody(request, maxBytes);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ConnectHttpError(400, "connect_json_invalid", "Request body must contain valid JSON.");
  }
}

export async function readFormBody(request: Request, maxBytes = 8 * 1024): Promise<URLSearchParams> {
  const type = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (type !== "application/x-www-form-urlencoded") {
    throw new ConnectHttpError(415, "connect_media_type_invalid", "Request body must use application/x-www-form-urlencoded.");
  }
  return new URLSearchParams(await readBoundedBody(request, maxBytes));
}

export async function readBoundedBody(request: Request, maxBytes: number): Promise<string> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const parsed = Number(declared);
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maxBytes) {
      throw new ConnectHttpError(413, "connect_request_too_large", `Request body exceeds ${maxBytes} bytes.`);
    }
  }
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      total += item.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("Connect request body limit exceeded.");
        throw new ConnectHttpError(413, "connect_request_too_large", `Request body exceeds ${maxBytes} bytes.`);
      }
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return decoder.decode(bytes);
  } catch {
    throw new ConnectHttpError(400, "connect_utf8_invalid", "Request body must be valid UTF-8.");
  }
}

export function randomToken(prefix: string, byteLength = 32): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return `${prefix}${encodeBase64Url(bytes)}`;
}

export function randomUserCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const raw = [...bytes].map(value => alphabet[value % alphabet.length]).join("");
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

export async function hashSecret(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(secret));
  return encodeBase64Url(new Uint8Array(digest));
}

export function sessionCookie(value: string, expiresAtMs: number): string {
  return `${CONNECT_SESSION_COOKIE}=${encodeURIComponent(value)}; Path=/; Expires=${new Date(expiresAtMs).toUTCString()}; HttpOnly; Secure; SameSite=Lax`;
}

export function expiredSessionCookie(): string {
  return `${CONNECT_SESSION_COOKIE}=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

export function cookieValue(request: Request, name: string): string | undefined {
  const header = request.headers.get("cookie");
  if (!header || header.length > 8_192) return undefined;
  for (const item of header.split(";")) {
    const separator = item.indexOf("=");
    if (separator < 0 || item.slice(0, separator).trim() !== name) continue;
    try {
      const value = decodeURIComponent(item.slice(separator + 1).trim());
      return value.length <= 1_024 ? value : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function jsonResponse(value: unknown, status = 200, corsOrigin?: string, headers?: HeadersInit): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("content-type", "application/json; charset=utf-8");
  responseHeaders.set("cache-control", "no-store");
  responseHeaders.set("x-content-type-options", "nosniff");
  responseHeaders.set("referrer-policy", "no-referrer");
  if (corsOrigin) {
    for (const [key, item] of browserCorsHeaders(corsOrigin)) responseHeaders.set(key, item);
  }
  return new Response(JSON.stringify(value), { status, headers: responseHeaders });
}

export function htmlResponse(html: string, status = 200, headers?: HeadersInit): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("content-type", "text/html; charset=utf-8");
  responseHeaders.set("cache-control", "no-store");
  responseHeaders.set("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
  responseHeaders.set("permissions-policy", "camera=(), microphone=(), geolocation=()");
  responseHeaders.set("referrer-policy", "no-referrer");
  responseHeaders.set("x-content-type-options", "nosniff");
  return new Response(html, { status, headers: responseHeaders });
}

export function htmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function errorResponse(error: unknown, corsOrigin?: string): Response {
  if (error instanceof ConnectHttpError) {
    return jsonResponse({ error: error.code, error_description: error.message }, error.status, corsOrigin);
  }
  console.error(JSON.stringify({ event: "connect.request.error", error: error instanceof Error ? error.message : String(error) }));
  return jsonResponse({ error: "connect_internal_error", error_description: "Connect request failed." }, 500, corsOrigin);
}

export function bearerToken(request: Request): string {
  const authorization = request.headers.get("authorization") ?? "";
  const match = /^DPoP ([A-Za-z0-9._~-]+)$/u.exec(authorization);
  if (!match?.[1]) {
    throw new ConnectHttpError(401, "connect_access_token_required", "A DPoP-bound device access token is required.");
  }
  return match[1];
}

export function requiredString(value: unknown, field: string, maxLength: number): string {
  return boundedPrintable(value, field, maxLength);
}

export function requiredId(value: unknown, field: string, prefix: string): string {
  if (typeof value !== "string" || !value.startsWith(prefix) || !/^[A-Za-z0-9_-]{20,256}$/u.test(value)) {
    throw new ConnectHttpError(400, "connect_request_invalid", `${field} is invalid.`);
  }
  return value;
}

export function normalizeUserCode(value: unknown): string {
  if (typeof value !== "string") throw new ConnectHttpError(400, "connect_user_code_invalid", "User code is invalid.");
  const normalized = value.trim().toUpperCase().replace(/[^A-Z2-9]/gu, "");
  if (!/^[A-HJ-NP-Z2-9]{8}$/u.test(normalized)) {
    throw new ConnectHttpError(400, "connect_user_code_invalid", "User code is invalid.");
  }
  return `${normalized.slice(0, 4)}-${normalized.slice(4)}`;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every(key => keys.includes(key));
}

function parsePublicJwk(value: string, label: string): ConnectP256PublicJwk {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new ConnectHttpError(500, "connect_config_invalid", `${label} is invalid.`);
  }
  const decoded = decodeConnectP256PublicJwk(parsed, label);
  if (!decoded.ok) throw new ConnectHttpError(500, "connect_config_invalid", decoded.error.message);
  return decoded.value;
}

function parsePrivateJwk(value: string, publicJwk: ConnectP256PublicJwk): JWK {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new ConnectHttpError(500, "connect_config_invalid", "Connect signing private JWK is invalid.");
  }
  if (!isRecord(parsed)
    || parsed.kty !== "EC"
    || parsed.crv !== "P-256"
    || parsed.x !== publicJwk.x
    || parsed.y !== publicJwk.y
    || typeof parsed.d !== "string"
    || !isBase64UrlLength(parsed.d, 32, 32)) {
    throw new ConnectHttpError(500, "connect_config_invalid", "Connect signing private JWK does not match the configured public key.");
  }
  return { kty: "EC", crv: "P-256", x: publicJwk.x, y: publicJwk.y, d: parsed.d };
}

function exactAccessIssuer(value: string): string {
  const origin = exactOrigin(value, "Cloudflare Access issuer", true);
  if (!new URL(origin).hostname.endsWith(".cloudflareaccess.com")) {
    throw new ConnectHttpError(500, "connect_config_invalid", "Cloudflare Access issuer is invalid.");
  }
  return origin;
}

function exactOrigin(value: string, label: string, requireHttps: boolean): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ConnectHttpError(500, "connect_config_invalid", `${label} is invalid.`);
  }
  if ((requireHttps && parsed.protocol !== "https:")
    || (!requireHttps && parsed.protocol !== "https:" && parsed.protocol !== "http:")
    || parsed.username
    || parsed.password
    || parsed.pathname !== "/"
    || parsed.search
    || parsed.hash
    || parsed.origin !== value) {
    throw new ConnectHttpError(500, "connect_config_invalid", `${label} must be an exact origin.`);
  }
  return parsed.origin;
}

function boundedPrintable(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string") throw new ConnectHttpError(400, "connect_request_invalid", `${label} is required.`);
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength || /[\u0000-\u001f\u007f]/u.test(trimmed)) {
    throw new ConnectHttpError(400, "connect_request_invalid", `${label} is invalid.`);
  }
  return trimmed;
}

function boundedBase64Url(value: unknown, label: string, minBytes: number, maxBytes: number): string {
  if (typeof value !== "string" || !isBase64UrlLength(value, minBytes, maxBytes)) {
    throw new ConnectHttpError(400, "connect_request_invalid", `${label} is invalid.`);
  }
  return value;
}

function isBase64UrlLength(value: string, minBytes: number, maxBytes: number): boolean {
  if (!/^[A-Za-z0-9_-]+$/u.test(value) || value.length % 4 === 1) return false;
  const bytes = Math.floor(value.length * 3 / 4);
  return bytes >= minBytes && bytes <= maxBytes;
}

function decodeBase64Url(value: string): Uint8Array {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

function encodeBase64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function browserCorsHeaders(origin: string): Headers {
  return new Headers({
    "access-control-allow-origin": origin,
    "access-control-allow-credentials": "true",
    "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "600",
    "vary": "Origin"
  });
}
