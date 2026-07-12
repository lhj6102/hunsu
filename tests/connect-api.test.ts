import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  CONNECT_ENROLLMENT_SCHEMA,
  CONNECT_MAX_SIGNAL_CIPHERTEXT_BYTES,
  CONNECT_SESSION_TICKET_AUDIENCE,
  CONNECT_SIGNAL_FRAME_SCHEMA,
  connectEnrollmentProofMessage,
  decodeConnectSignalFrame,
  type ConnectEnrollmentRequest,
  type ConnectP256PublicJwk
} from "../packages/protocol/src/connect.ts";
import {
  ConnectHttpError,
  accessIdentityFromPayload,
  decodeAndVerifyEnrollment,
  expiredSessionCookie,
  publicJwkThumbprint,
  sessionCookie,
  signConnectSessionTicket,
  verifyConnectSessionTicket,
  type ConnectRuntimeConfig
} from "../apps/connect-api/src/security.ts";
import {
  CONNECT_SOCKET_ATTACHMENT_VERSION,
  decodeConnectSocketAttachment
} from "../apps/connect-api/src/signal-state.ts";
import {
  refreshCredentialDisposition,
  type RefreshContext,
  type StoredDevice
} from "../apps/connect-api/src/storage.ts";

test("Connect browser identity and cookie boundary fails closed", () => {
  assert.deepEqual(accessIdentityFromPayload({ sub: "access-user", email: "USER@EXAMPLE.COM" }), {
    subject: "access-user",
    email: "user@example.com"
  });
  assert.throws(
    () => accessIdentityFromPayload({ email: "user@example.com" }),
    (error: unknown) => error instanceof ConnectHttpError && error.status === 403
  );
  const cookie = sessionCookie("cbs_secret", Date.UTC(2030, 0, 1));
  assert.match(cookie, /^__Host-hunsu_connect_session=/u);
  assert.match(cookie, /HttpOnly/u);
  assert.match(cookie, /Secure/u);
  assert.match(cookie, /SameSite=Lax/u);
  assert.doesNotMatch(cookie, /Domain=/u);
  assert.match(expiredSessionCookie(), /Max-Age=0/u);
  const routes = readFileSync(resolve("apps/connect-api/src/index.ts"), "utf8");
  assert.match(routes, /request\.method === "GET" && url\.pathname === "\/auth\/login"/u);
  assert.match(routes, /location: `\$\{config\.webOrigin\}\/studio`/u);
  assert.doesNotMatch(routes, /return[_-]?(?:to|url)|redirect[_-]?uri/iu);
});

test("Connect enrollment proof requires both distinct P-256 private keys", async () => {
  const nowMs = Date.UTC(2030, 0, 1, 12);
  const signing = await p256KeyPair();
  const agreement = await p256KeyPair();
  const signingPublicJwk = await publicConnectJwk(signing.publicKey);
  const agreementPublicJwk = await publicConnectJwk(agreement.publicKey);
  const unsigned = {
    deviceName: "QA bridge",
    signingPublicJwk,
    agreementPublicJwk,
    issuedAt: new Date(nowMs).toISOString(),
    nonce: base64Url(new Uint8Array(16).fill(7))
  };
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    signing.privateKey,
    new TextEncoder().encode(connectEnrollmentProofMessage(unsigned))
  );
  const request: ConnectEnrollmentRequest = {
    schema: CONNECT_ENROLLMENT_SCHEMA,
    ...unsigned,
    proof: base64Url(new Uint8Array(signature))
  };
  assert.deepEqual(await decodeAndVerifyEnrollment(request, nowMs), request);
  await assert.rejects(
    decodeAndVerifyEnrollment({ ...request, deviceName: "tampered" }, nowMs),
    (error: unknown) => error instanceof ConnectHttpError && error.code === "connect_enrollment_proof_invalid"
  );
});

test("Connect ES256 ticket binds environment, account, device, browser key, and 90-second expiry", async () => {
  const signing = await p256KeyPair();
  const publicJwk = await publicConnectJwk(signing.publicKey);
  const privateJwk = await crypto.subtle.exportKey("jwk", signing.privateKey);
  const browser = await p256KeyPair();
  const browserAgreementPublicJwk = await publicConnectJwk(browser.publicKey);
  const nowMs = Date.UTC(2030, 0, 1, 12);
  const config: ConnectRuntimeConfig = {
    target: "preview",
    release: "a".repeat(40),
    apiOrigin: "https://connect.preview.hunsu.app",
    webOrigin: "https://preview.hunsu.app",
    accessIssuer: "https://example.cloudflareaccess.com",
    accessAudience: "a".repeat(32),
    signingPublicJwk: publicJwk,
    signingPrivateJwk: privateJwk,
    signingKeyId: "connect-test-key-123456"
  };
  const signed = await signConnectSessionTicket(config, {
    sessionId: `cs_${"s".repeat(24)}`,
    accountId: `ca_${"a".repeat(43)}`,
    deviceId: `cd_${"d".repeat(24)}`,
    browserAgreementPublicJwk,
    jti: `ctj_${"j".repeat(24)}`
  }, nowMs);
  const claims = await verifyConnectSessionTicket(signed.ticket, config, nowMs);
  assert.equal(claims.aud, CONNECT_SESSION_TICKET_AUDIENCE);
  assert.equal(claims.environment, "preview");
  assert.equal(claims.deviceId, claims.sub);
  assert.equal(claims.exp - claims.iat, 90);
  assert.deepEqual(claims.browserAgreementPublicJwk, browserAgreementPublicJwk);
  await assert.rejects(
    verifyConnectSessionTicket(signed.ticket, { ...config, target: "production" }, nowMs),
    (error: unknown) => error instanceof ConnectHttpError && error.code === "connect_session_ticket_invalid"
  );
});

test("Connect signal decoder preserves opaque ciphertext and enforces replay and size bounds", () => {
  const ciphertext = base64Url(new Uint8Array(16).fill(23));
  const frame = {
    schema: CONNECT_SIGNAL_FRAME_SCHEMA,
    sessionId: `cs_${"s".repeat(24)}`,
    sequence: 1,
    iv: base64Url(new Uint8Array(12).fill(17)),
    ciphertext
  };
  const decoded = decodeConnectSignalFrame(frame);
  assert.equal(decoded.ok, true);
  if (decoded.ok) assert.equal(decoded.value.ciphertext, ciphertext);
  assert.equal(decodeConnectSignalFrame({ ...frame, sequence: 0 }).ok, false);
  assert.equal(decodeConnectSignalFrame({ ...frame, sequence: 1 }).ok, true);
  assert.equal(decodeConnectSignalFrame({ ...frame, plaintext: "offer" }).ok, false);
  assert.equal(decodeConnectSignalFrame({
    ...frame,
    ciphertext: base64Url(new Uint8Array(CONNECT_MAX_SIGNAL_CIPHERTEXT_BYTES + 1))
  }).ok, false);
});

test("Connect refresh-token state revokes reused families and rejected devices", () => {
  const device = storedDevice();
  const current: RefreshContext = {
    tokenHash: "hash",
    familyId: "family",
    rotation: 0,
    expiresAtMs: 2_000,
    device
  };
  assert.equal(refreshCredentialDisposition(current, 1_000), "rotate");
  assert.equal(refreshCredentialDisposition({ ...current, rotatedAtMs: 900 }, 1_000), "revoke_family");
  assert.equal(refreshCredentialDisposition({ ...current, expiresAtMs: 999 }, 1_000), "revoke_family");
  assert.equal(refreshCredentialDisposition({ ...current, device: { ...device, revokedAtMs: 900 } }, 1_000), "device_revoked");
});

test("DeviceSignalDO uses hibernation attachments and never creates an offline signal mailbox", () => {
  const attachment = {
    version: CONNECT_SOCKET_ATTACHMENT_VERSION,
    role: "browser",
    sessionId: `cs_${"s".repeat(24)}`,
    accountId: `ca_${"a".repeat(43)}`
  } as const;
  assert.deepEqual(decodeConnectSocketAttachment(structuredClone(attachment)), attachment);
  assert.equal(decodeConnectSocketAttachment({ ...attachment, version: 2 }), undefined);

  const source = readFileSync(resolve("apps/connect-api/src/device-signal-do.ts"), "utf8");
  assert.match(source, /acceptWebSocket\(/u);
  assert.match(source, /serializeAttachment\(/u);
  assert.match(source, /deserializeAttachment\(/u);
  assert.match(source, /getWebSockets\(/u);
  assert.doesNotMatch(source, /\.accept\(\)/u);
  const migration = readFileSync(resolve("apps/connect-api/migrations/0001_connect.sql"), "utf8");
  assert.match(migration, /auth_epoch INTEGER NOT NULL/u);
  assert.match(migration, /parent_token_hash TEXT UNIQUE/u);
  assert.match(migration, /source_enrollment_id TEXT UNIQUE/u);
  assert.match(migration, /dpop_replays[\s\S]*jti_hash TEXT PRIMARY KEY/u);
  assert.doesNotMatch(source, /INSERT INTO .*signal.*ciphertext/iu);
});

test("Connect app contains only identity, device metadata, tickets, and opaque signaling", () => {
  const sourceRoot = resolve("apps/connect-api/src");
  const source = readdirSync(sourceRoot)
    .filter(file => file.endsWith(".ts"))
    .map(file => readFileSync(join(sourceRoot, file), "utf8"))
    .join("\n");
  for (const forbidden of [
    "workspaceId",
    "projectPath",
    "command.request",
    "command.result",
    "stream.chunk"
  ]) {
    assert.equal(source.includes(forbidden), false, `Connect source must not contain ${forbidden}`);
  }
  const routes = readFileSync(resolve("apps/connect-api/src/index.ts"), "utf8");
  assert.match(routes, /\/v1\/connect\/device/u);
  assert.match(routes, /\/v1\/connect\/sessions/u);
});

async function p256KeyPair(): Promise<CryptoKeyPair> {
  const generated = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"]
  );
  if (!("publicKey" in generated)) throw new Error("P-256 key generation did not return a key pair.");
  return generated;
}

async function publicConnectJwk(key: CryptoKey): Promise<ConnectP256PublicJwk> {
  const jwk = await crypto.subtle.exportKey("jwk", key);
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || !jwk.x || !jwk.y) {
    throw new Error("P-256 public key export failed.");
  }
  const result = { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y } as const;
  assert.equal((await publicJwkThumbprint(result)).length, 43);
  return result;
}

function base64Url(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function storedDevice(): StoredDevice {
  const jwk: ConnectP256PublicJwk = {
    kty: "EC",
    crv: "P-256",
    x: base64Url(new Uint8Array(32).fill(1)),
    y: base64Url(new Uint8Array(32).fill(2))
  };
  return {
    deviceId: `cd_${"d".repeat(24)}`,
    ownerSubject: "owner",
    deviceName: "device",
    signingPublicJwk: jwk,
    signingJkt: base64Url(new Uint8Array(32).fill(3)),
    agreementPublicJwk: jwk,
    authEpoch: 0,
    createdAtMs: 0
  };
}
