import {
  CONNECT_ENROLLMENT_SCHEMA,
  CONNECT_SESSION_SCHEMA,
  CONNECT_DEVICE_ACCESS_TTL_SECONDS,
  decodeConnectP256PublicJwk,
  type ConnectDeviceTokenResponse,
  type ConnectEnrollmentCreated,
  type ConnectSessionCreated
} from "../../../packages/protocol/src/connect.ts";
import { DeviceSignalDO } from "./device-signal-do.ts";
import {
  CONNECT_SESSION_COOKIE,
  ConnectHttpError,
  bearerToken,
  cookieValue,
  corsPreflight,
  errorResponse,
  expiredSessionCookie,
  hasOnlyKeys,
  hashSecret,
  htmlEscape,
  htmlResponse,
  isRecord,
  jsonResponse,
  publicJwkThumbprint,
  randomToken,
  readJsonBody,
  readFormBody,
  rejectForeignOrigin,
  requireBrowserOrigin,
  requireExactRequestHost,
  requiredId,
  requiredString,
  resolveConnectRuntimeConfig,
  sessionCookie,
  signConnectSessionTicket,
  signDeviceAccessToken,
  verifyAccessIdentity,
  verifyConnectSessionTicket,
  verifyDeviceAccessToken,
  verifyDpopProof,
  decodeAndVerifyEnrollment,
  type ConnectRuntimeConfig
} from "./security.ts";
import {
  approveEnrollment,
  cleanupExpiredOutcomes,
  createBrowserSession,
  createEnrollment,
  getBrowserSession,
  getDevice,
  getEnrollmentTokenContext,
  getOwnedDevice,
  getRefreshContext,
  listDevices,
  pollEnrollment,
  recordDpopReplay,
  revokeBrowserSession,
  revokeDevice,
  rotateRefreshToken,
  toDeviceMetadata,
  touchDevice,
  type CreatedBrowserSession,
  type StoredBrowserSession,
  type StoredDevice
} from "./storage.ts";

export { DeviceSignalDO };

const SERVICE_NAME = "hunsu-connect";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    let config: ConnectRuntimeConfig | undefined;
    try {
      config = resolveConnectRuntimeConfig(env);
      const url = requireExactRequestHost(request, config);
      if (request.method === "GET" && url.pathname === "/health") {
        return jsonResponse({
          ok: true,
          service: SERVICE_NAME,
          target: config.target,
          release: config.release,
          issuer: config.apiOrigin
        });
      }
      if (request.method === "OPTIONS") return corsPreflight(request, config);
      const requestOrigin = request.headers.get("origin");
      if (!(url.pathname === "/auth/device-enrollments" && requestOrigin === config.apiOrigin)) {
        rejectForeignOrigin(request, config);
      }
      return await routeRequest(request, url, env, ctx, config);
    } catch (error) {
      const corsOrigin = config && request.headers.get("origin") === config.webOrigin
        ? config.webOrigin
        : undefined;
      return errorResponse(error, corsOrigin);
    }
  }
} satisfies ExportedHandler<Env>;

async function routeRequest(
  request: Request,
  url: URL,
  env: Env,
  ctx: ExecutionContext,
  config: ConnectRuntimeConfig
): Promise<Response> {
  if (request.method === "GET" && url.pathname === "/auth/login") {
    const identity = await verifyAccessIdentity(request, config);
    const session = await createBrowserSession(env.CONNECT_DB, identity, Date.now());
    scheduleOutcomeCleanup(env, ctx);
    return browserLoginRedirect(config, session);
  }
  if (request.method === "POST" && url.pathname === "/auth/session") {
    requireBrowserOrigin(request, config);
    const identity = await verifyAccessIdentity(request, config);
    const session = await createBrowserSession(env.CONNECT_DB, identity, Date.now());
    scheduleOutcomeCleanup(env, ctx);
    return jsonResponse({
      authenticated: true,
      user: { accountId: session.accountId },
      expiresAt: new Date(session.expiresAtMs).toISOString()
    }, 201, config.webOrigin, { "set-cookie": sessionCookie(session.token, session.expiresAtMs) });
  }
  if (request.method === "GET" && url.pathname === "/auth/session") {
    requireBrowserOrigin(request, config);
    const session = await requireBrowserSession(request, env);
    return jsonResponse({
      authenticated: true,
      user: { accountId: session.accountId },
      expiresAt: new Date(session.expiresAtMs).toISOString()
    }, 200, config.webOrigin);
  }
  if (request.method === "DELETE" && url.pathname === "/auth/session") {
    requireBrowserOrigin(request, config);
    const token = cookieValue(request, CONNECT_SESSION_COOKIE);
    await revokeBrowserSession(env.CONNECT_DB, token, Date.now());
    return jsonResponse({ authenticated: false, user: null }, 200, config.webOrigin, {
      "set-cookie": expiredSessionCookie()
    });
  }
  if (request.method === "GET" && url.pathname === "/auth/device-enrollments") {
    const identity = await verifyAccessIdentity(request, config);
    const existing = await getBrowserSession(env.CONNECT_DB, cookieValue(request, CONNECT_SESSION_COOKIE), Date.now());
    const browserSession = existing?.ownerSubject === identity.subject
      ? undefined
      : await createBrowserSession(env.CONNECT_DB, identity, Date.now());
    const suppliedCode = url.searchParams.get("user_code")?.slice(0, 32) ?? "";
    return htmlResponse(renderEnrollmentPage(suppliedCode), 200, browserSession
      ? { "set-cookie": sessionCookie(browserSession.token, browserSession.expiresAtMs) }
      : undefined);
  }
  if (request.method === "POST" && url.pathname === "/auth/device-enrollments") {
    const origin = request.headers.get("origin");
    if (origin !== config.webOrigin && origin !== config.apiOrigin) {
      throw new ConnectHttpError(403, "connect_origin_denied", "Request origin is not allowed.");
    }
    const session = await requireBrowserSession(request, env);
    const formSubmission = request.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded") === true;
    const userCode = formSubmission
      ? (await readFormBody(request)).get("userCode")
      : approvalUserCode(await readJsonBody(request, 4 * 1024));
    const device = await approveEnrollment(env.CONNECT_DB, userCode, session.ownerSubject, Date.now());
    if (formSubmission) {
      return htmlResponse(renderEnrollmentApprovedPage(device.deviceName));
    }
    return jsonResponse({ device: await toDeviceMetadata(device, false) }, 200, config.webOrigin);
  }
  if (request.method === "POST" && url.pathname === "/v1/device-enrollments") {
    const nowMs = Date.now();
    const enrollment = await decodeAndVerifyEnrollment(await readJsonBody(request), nowMs);
    const [signingJkt, agreementJkt, clientKeyHash] = await Promise.all([
      publicJwkThumbprint(enrollment.signingPublicJwk),
      publicJwkThumbprint(enrollment.agreementPublicJwk),
      enrollmentClientKeyHash(request)
    ]);
    const created = await createEnrollment(env.CONNECT_DB, enrollment, clientKeyHash, signingJkt, agreementJkt, nowMs);
    scheduleOutcomeCleanup(env, ctx);
    const verificationUri = `${config.apiOrigin}/auth/device-enrollments`;
    const response: ConnectEnrollmentCreated = {
      schema: "hunsu.connect.enrollment-created.v1",
      enrollmentId: created.enrollmentId,
      deviceCode: created.deviceCode,
      userCode: created.userCode,
      verificationUri,
      verificationUriComplete: `${verificationUri}?user_code=${encodeURIComponent(created.userCode)}`,
      expiresIn: Math.floor((created.expiresAtMs - nowMs) / 1_000),
      interval: created.interval
    };
    return jsonResponse(response, 201);
  }
  if (request.method === "POST" && url.pathname === "/v1/device-enrollment-tokens") {
    return handleEnrollmentToken(request, env, ctx, config);
  }
  if (request.method === "POST" && url.pathname === "/v1/device-tokens") {
    return handleRefreshToken(request, env, ctx, config);
  }
  if (request.method === "GET" && url.pathname === "/v1/devices") {
    requireBrowserOrigin(request, config);
    const session = await requireBrowserSession(request, env);
    const devices = await listDevices(env.CONNECT_DB, session.ownerSubject);
    const metadata = await Promise.all(devices.map(async device =>
      toDeviceMetadata(device, device.revokedAtMs === undefined && await deviceOnline(env, device.deviceId))
    ));
    return jsonResponse({ devices: metadata }, 200, config.webOrigin);
  }
  const revokeMatch = /^\/v1\/devices\/(cd_[A-Za-z0-9_-]{20,125})$/u.exec(url.pathname);
  if (request.method === "DELETE" && revokeMatch?.[1]) {
    requireBrowserOrigin(request, config);
    const session = await requireBrowserSession(request, env);
    const revoked = await revokeDevice(env.CONNECT_DB, revokeMatch[1], session.ownerSubject, Date.now());
    if (!revoked) throw new ConnectHttpError(404, "connect_device_not_found", "Connect device was not found.");
    await closeDeviceSignal(env, revokeMatch[1]);
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": config.webOrigin,
        "access-control-allow-credentials": "true",
        "vary": "Origin",
        "cache-control": "no-store"
      }
    });
  }
  if (request.method === "POST" && url.pathname === "/v1/connect/sessions") {
    requireBrowserOrigin(request, config);
    return createConnectSession(request, env, config);
  }
  if (request.method === "GET" && url.pathname === "/v1/connect/device") {
    return connectDeviceSocket(request, env, ctx, config);
  }
  const browserSocketMatch = /^\/v1\/connect\/sessions\/(cs_[A-Za-z0-9_-]{20,125})\/browser$/u.exec(url.pathname);
  if (request.method === "GET" && browserSocketMatch?.[1]) {
    requireBrowserOrigin(request, config);
    return connectBrowserSocket(request, env, config, browserSocketMatch[1]);
  }
  if (url.pathname.startsWith("/auth/") || url.pathname.startsWith("/v1/")) {
    throw new ConnectHttpError(405, "connect_method_not_allowed", "Connect endpoint or method is not allowed.");
  }
  throw new ConnectHttpError(404, "connect_not_found", "Not found.");
}

function browserLoginRedirect(config: ConnectRuntimeConfig, session: CreatedBrowserSession): Response {
  const headers = new Headers({
    "cache-control": "no-store",
    location: `${config.webOrigin}/studio`,
    "referrer-policy": "no-referrer",
    "set-cookie": sessionCookie(session.token, session.expiresAtMs),
    "x-content-type-options": "nosniff"
  });
  return new Response(null, { status: 303, headers });
}

async function handleEnrollmentToken(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  config: ConnectRuntimeConfig
): Promise<Response> {
  const body = await readJsonBody(request, 8 * 1024);
  if (!isRecord(body) || !hasOnlyKeys(body, ["enrollmentId", "deviceCode"])) {
    throw new ConnectHttpError(400, "connect_request_invalid", "Enrollment token request is invalid.");
  }
  const enrollmentId = requiredId(body.enrollmentId, "enrollmentId", "ce_");
  const deviceCode = requiredString(body.deviceCode, "deviceCode", 256);
  if (!deviceCode.startsWith("cdc_")) throw new ConnectHttpError(400, "connect_request_invalid", "deviceCode is invalid.");
  const context = await getEnrollmentTokenContext(env.CONNECT_DB, enrollmentId, deviceCode);
  if (!context) throw new ConnectHttpError(400, "invalid_grant", "Enrollment grant is invalid.");
  const nowMs = Date.now();
  const dpop = await verifyDpopProof(request, context.signingJkt, undefined, nowMs);
  await recordDpopReplay(env.CONNECT_DB, {
    jtiHash: dpop.jtiHash,
    subjectRef: context.enrollmentId,
    expiresAtMs: dpop.expiresAtMs
  }, nowMs);
  const result = await pollEnrollment(env.CONNECT_DB, context, nowMs);
  scheduleOutcomeCleanup(env, ctx);
  if (result.type === "authorization_pending") {
    return jsonResponse({ error: "authorization_pending", interval: result.interval }, 202, undefined, { "retry-after": String(result.interval) });
  }
  if (result.type === "slow_down") {
    return jsonResponse({ error: "slow_down", interval: result.interval }, 429, undefined, { "retry-after": String(result.interval) });
  }
  if (result.type === "expired_token") throw new ConnectHttpError(410, "expired_token", "Enrollment grant expired.");
  if (result.type === "invalid_grant") throw new ConnectHttpError(400, "invalid_grant", "Enrollment grant is invalid or already used.");
  return tokenResponse(config, result.device, result.refreshToken, nowMs);
}

async function handleRefreshToken(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  config: ConnectRuntimeConfig
): Promise<Response> {
  const body = await readJsonBody(request, 8 * 1024);
  if (!isRecord(body) || !hasOnlyKeys(body, ["refreshToken"])) {
    throw new ConnectHttpError(400, "connect_request_invalid", "Refresh request is invalid.");
  }
  const refreshToken = requiredString(body.refreshToken, "refreshToken", 256);
  if (!refreshToken.startsWith("crt_")) throw new ConnectHttpError(400, "invalid_grant", "Refresh token is invalid.");
  const context = await getRefreshContext(env.CONNECT_DB, refreshToken);
  if (!context) throw new ConnectHttpError(400, "invalid_grant", "Refresh token is invalid.");
  const nowMs = Date.now();
  const dpop = await verifyDpopProof(request, context.device.signingJkt, undefined, nowMs);
  await recordDpopReplay(env.CONNECT_DB, {
    jtiHash: dpop.jtiHash,
    subjectRef: context.device.deviceId,
    expiresAtMs: dpop.expiresAtMs
  }, nowMs);
  const rotated = await rotateRefreshToken(env.CONNECT_DB, context, nowMs);
  scheduleOutcomeCleanup(env, ctx);
  if (!rotated) {
    await closeDeviceSignal(env, context.device.deviceId);
    throw new ConnectHttpError(400, "invalid_grant", "Refresh token was reused, revoked, or expired.");
  }
  return tokenResponse(config, rotated.device, rotated.refreshToken, nowMs);
}

async function tokenResponse(
  config: ConnectRuntimeConfig,
  device: StoredDevice,
  refreshToken: string,
  nowMs: number
): Promise<Response> {
  const accountId = await hashAccount(device.ownerSubject);
  const access = await signDeviceAccessToken(config, {
    deviceId: device.deviceId,
    accountId,
    authEpoch: device.authEpoch,
    signingJkt: device.signingJkt
  }, nowMs);
  const response: ConnectDeviceTokenResponse = {
    schema: "hunsu.connect.device-token.v1",
    tokenType: "DPoP",
    accessToken: access.token,
    expiresIn: CONNECT_DEVICE_ACCESS_TTL_SECONDS,
    refreshToken,
    deviceId: device.deviceId,
    accountId
  };
  return jsonResponse(response);
}

async function createConnectSession(request: Request, env: Env, config: ConnectRuntimeConfig): Promise<Response> {
  const session = await requireBrowserSession(request, env);
  const body = await readJsonBody(request, 8 * 1024);
  if (!isRecord(body) || !hasOnlyKeys(body, ["deviceId", "browserAgreementPublicJwk"])) {
    throw new ConnectHttpError(400, "connect_request_invalid", "Connect session request is invalid.");
  }
  const deviceId = requiredId(body.deviceId, "deviceId", "cd_");
  const browserKey = decodeConnectP256PublicJwk(body.browserAgreementPublicJwk, "browserAgreementPublicJwk");
  if (!browserKey.ok) throw new ConnectHttpError(400, "connect_request_invalid", browserKey.error.message);
  const device = await getOwnedDevice(env.CONNECT_DB, deviceId, session.ownerSubject);
  if (!device || device.revokedAtMs !== undefined) {
    throw new ConnectHttpError(404, "connect_device_not_found", "Connect device was not found.");
  }
  if (!await deviceOnline(env, deviceId)) {
    throw new ConnectHttpError(409, "connect_device_offline", "Connect device is offline.");
  }
  const nowMs = Date.now();
  const sessionId = randomToken("cs_", 20);
  const ticketJti = randomToken("ctj_", 20);
  const signed = await signConnectSessionTicket(config, {
    sessionId,
    accountId: session.accountId,
    deviceId,
    browserAgreementPublicJwk: browserKey.value,
    jti: ticketJti
  }, nowMs);
  const stub = env.DEVICE_SIGNAL.getByName(deviceId);
  const internal = await stub.fetch("https://connect.internal/sessions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hunsu-connect-internal": "1"
    },
    body: JSON.stringify({
      sessionId,
      accountId: session.accountId,
      ticket: signed.ticket,
      ticketHash: await hashSecret(signed.ticket),
      ticketJti,
      expiresAtMs: signed.expiresAtMs
    })
  });
  if (!internal.ok) throw await internalConnectError(internal);
  const browserUrl = new URL(`${config.apiOrigin}/v1/connect/sessions/${encodeURIComponent(sessionId)}/browser`);
  browserUrl.protocol = browserUrl.protocol === "https:" ? "wss:" : "ws:";
  browserUrl.searchParams.set("ticket", signed.ticket);
  const response: ConnectSessionCreated = {
    schema: CONNECT_SESSION_SCHEMA,
    sessionId,
    ticket: signed.ticket,
    expiresAt: new Date(signed.expiresAtMs).toISOString(),
    webSocketUrl: browserUrl.toString()
  };
  return jsonResponse(response, 201, config.webOrigin);
}

async function connectDeviceSocket(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  config: ConnectRuntimeConfig
): Promise<Response> {
  requireUpgrade(request);
  if (request.headers.has("origin")) {
    throw new ConnectHttpError(403, "connect_origin_denied", "Device WebSocket must be an outbound non-browser connection.");
  }
  const accessToken = bearerToken(request);
  const nowMs = Date.now();
  const access = await verifyDeviceAccessToken(accessToken, config, nowMs);
  const device = await getDevice(env.CONNECT_DB, access.deviceId);
  if (!device || device.revokedAtMs !== undefined) throw new ConnectHttpError(401, "connect_device_revoked", "Connect device is revoked.");
  const accountId = await hashAccount(device.ownerSubject);
  if (accountId !== access.accountId
    || device.signingJkt !== access.signingJkt
    || device.authEpoch !== access.authEpoch) {
    throw new ConnectHttpError(401, "connect_access_token_revoked", "Device access token has been revoked.");
  }
  const dpop = await verifyDpopProof(request, device.signingJkt, accessToken, nowMs);
  await recordDpopReplay(env.CONNECT_DB, {
    jtiHash: dpop.jtiHash,
    subjectRef: device.deviceId,
    expiresAtMs: dpop.expiresAtMs
  }, nowMs);
  await touchDevice(env.CONNECT_DB, device.deviceId, nowMs);
  scheduleOutcomeCleanup(env, ctx);
  const headers = new Headers(request.headers);
  headers.set("x-hunsu-connect-internal", "1");
  headers.set("x-connect-device-id", device.deviceId);
  headers.set("x-connect-account-id", accountId);
  headers.set("x-connect-auth-epoch", String(device.authEpoch));
  headers.set("x-connect-access-expires-at-ms", String(access.expiresAtMs));
  headers.delete("authorization");
  headers.delete("dpop");
  return env.DEVICE_SIGNAL.getByName(device.deviceId).fetch(new Request("https://connect.internal/device", {
    method: "GET",
    headers
  }));
}

async function connectBrowserSocket(
  request: Request,
  env: Env,
  config: ConnectRuntimeConfig,
  sessionId: string
): Promise<Response> {
  requireUpgrade(request);
  const browserSession = await requireBrowserSession(request, env);
  const ticket = new URL(request.url).searchParams.get("ticket") ?? "";
  const claims = await verifyConnectSessionTicket(ticket, config, Date.now());
  if (claims.sessionId !== sessionId || claims.accountId !== browserSession.accountId) {
    throw new ConnectHttpError(401, "connect_session_ticket_invalid", "Connect session ticket binding is invalid.");
  }
  const device = await getOwnedDevice(env.CONNECT_DB, claims.deviceId, browserSession.ownerSubject);
  if (!device || device.revokedAtMs !== undefined) {
    throw new ConnectHttpError(401, "connect_session_ticket_invalid", "Connect session device is unavailable.");
  }
  const headers = new Headers(request.headers);
  headers.set("x-hunsu-connect-internal", "1");
  headers.set("x-connect-session-id", sessionId);
  headers.set("x-connect-account-id", browserSession.accountId);
  headers.set("x-connect-ticket-hash", await hashSecret(ticket));
  headers.delete("cookie");
  return env.DEVICE_SIGNAL.getByName(device.deviceId).fetch(new Request("https://connect.internal/browser", {
    method: "GET",
    headers
  }));
}

async function requireBrowserSession(request: Request, env: Env): Promise<StoredBrowserSession> {
  const session = await getBrowserSession(
    env.CONNECT_DB,
    cookieValue(request, CONNECT_SESSION_COOKIE),
    Date.now()
  );
  if (!session) throw new ConnectHttpError(401, "connect_session_required", "A valid Connect browser session is required.");
  return session;
}

async function deviceOnline(env: Env, deviceId: string): Promise<boolean> {
  const response = await env.DEVICE_SIGNAL.getByName(deviceId).fetch("https://connect.internal/status", {
    headers: { "x-hunsu-connect-internal": "1" }
  });
  if (!response.ok) return false;
  const body: unknown = await response.json();
  return isRecord(body) && body.online === true;
}

async function closeDeviceSignal(env: Env, deviceId: string): Promise<void> {
  await env.DEVICE_SIGNAL.getByName(deviceId).fetch("https://connect.internal/revoke", {
    method: "POST",
    headers: { "x-hunsu-connect-internal": "1" }
  });
}

function scheduleOutcomeCleanup(env: Env, ctx: ExecutionContext): void {
  ctx.waitUntil(cleanupExpiredOutcomes(env.CONNECT_DB, Date.now()).catch(error => {
    console.error(JSON.stringify({ event: "connect.cleanup.failed", error: error instanceof Error ? error.message : String(error) }));
  }));
}

async function enrollmentClientKeyHash(request: Request): Promise<string> {
  const address = request.headers.get("cf-connecting-ip") ?? "unknown";
  const userAgent = request.headers.get("user-agent") ?? "unknown";
  return hashSecret(`${address}\n${userAgent.slice(0, 256)}`);
}

async function hashAccount(ownerSubject: string): Promise<string> {
  return `ca_${await hashSecret(ownerSubject)}`;
}

function requireUpgrade(request: Request): void {
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    throw new ConnectHttpError(426, "connect_upgrade_required", "WebSocket upgrade is required.");
  }
}

async function internalConnectError(response: Response): Promise<ConnectHttpError> {
  let status = response.status;
  if (status < 400 || status > 599) status = 503;
  let code = "connect_signal_unavailable";
  let description = "Connect signaling is unavailable.";
  const length = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(length) && length <= 4_096) {
    const value: unknown = await response.json().catch(() => undefined);
    if (isRecord(value)) {
      if (typeof value.error === "string" && value.error.length <= 128) code = value.error;
      if (typeof value.error_description === "string" && value.error_description.length <= 512) description = value.error_description;
    }
  }
  return new ConnectHttpError(status, code, description);
}

function approvalUserCode(body: unknown): unknown {
  if (!isRecord(body) || !hasOnlyKeys(body, ["userCode"])) {
    throw new ConnectHttpError(400, "connect_request_invalid", "Approval request must contain only userCode.");
  }
  return body.userCode;
}

function renderEnrollmentPage(userCode: string): string {
  const code = htmlEscape(userCode);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Approve Hunsu Connect device</title><style>body{font:16px system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem}label,input,button{display:block;width:100%;box-sizing:border-box}input,button{font:inherit;padding:.75rem;margin-top:.5rem}button{margin-top:1rem}</style></head>
<body><h1>Approve a Connect device</h1><p>Confirm that this is the one-time code shown by your device.</p>
<form method="post" action="/auth/device-enrollments"><label>One-time code<input name="userCode" value="${code}" required autocomplete="one-time-code" maxlength="9"></label><button type="submit">Approve device</button></form></body></html>`;
}

function renderEnrollmentApprovedPage(deviceName: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Device approved</title></head><body><h1>Device approved</h1><p>${htmlEscape(deviceName)} can now connect. You may close this page.</p></body></html>`;
}
