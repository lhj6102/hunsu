import {
  canonicalConnectPublicJwk,
  decodeConnectP256PublicJwk,
  type ConnectDeviceMetadata,
  type ConnectEnrollmentRequest,
  type ConnectP256PublicJwk
} from "../../../packages/protocol/src/connect.ts";
import type { AccessIdentity } from "./security.ts";
import {
  ConnectHttpError,
  accountIdForSubject,
  hashSecret,
  normalizeUserCode,
  randomToken,
  randomUserCode
} from "./security.ts";

const BROWSER_SESSION_TTL_MS = 8 * 60 * 60_000;
const ENROLLMENT_TTL_MS = 10 * 60_000;
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60_000;
const INITIAL_POLL_SECONDS = 5;
const MAX_ENROLLMENTS_PER_TEN_MINUTES = 5;

export type StoredBrowserSession = {
  sessionHash: string;
  ownerSubject: string;
  accountId: string;
  expiresAtMs: number;
};

export type CreatedBrowserSession = StoredBrowserSession & {
  token: string;
};

export type CreatedEnrollment = {
  enrollmentId: string;
  deviceCode: string;
  userCode: string;
  expiresAtMs: number;
  interval: number;
};

export type EnrollmentTokenContext = {
  enrollmentId: string;
  deviceCodeHash: string;
  status: "pending" | "approved" | "consumed" | "expired" | "revoked";
  signingPublicJwk: ConnectP256PublicJwk;
  signingJkt: string;
  expiresAtMs: number;
  nextPollAtMs: number;
  pollIntervalSeconds: number;
  ownerSubject?: string;
  deviceId?: string;
};

export type EnrollmentPollResult =
  | { type: "authorization_pending"; interval: number }
  | { type: "slow_down"; interval: number }
  | { type: "expired_token" }
  | { type: "invalid_grant" }
  | { type: "issued"; refreshToken: string; device: StoredDevice };

export type StoredDevice = {
  deviceId: string;
  ownerSubject: string;
  deviceName: string;
  signingPublicJwk: ConnectP256PublicJwk;
  signingJkt: string;
  agreementPublicJwk: ConnectP256PublicJwk;
  authEpoch: number;
  createdAtMs: number;
  lastSeenAtMs?: number;
  revokedAtMs?: number;
};

export type RefreshContext = {
  tokenHash: string;
  familyId: string;
  rotation: number;
  expiresAtMs: number;
  rotatedAtMs?: number;
  revokedAtMs?: number;
  device: StoredDevice;
};

export type RefreshCredentialDisposition = "rotate" | "revoke_family" | "device_revoked";

export function refreshCredentialDisposition(context: RefreshContext, nowMs: number): RefreshCredentialDisposition {
  if (context.device.revokedAtMs !== undefined) return "device_revoked";
  if (context.rotatedAtMs !== undefined || context.revokedAtMs !== undefined || context.expiresAtMs <= nowMs) {
    return "revoke_family";
  }
  return "rotate";
}

type OwnerRow = {
  subject: string;
  auth_epoch: number;
  revoked_at_ms: number | null;
};

type BrowserSessionRow = {
  session_hash: string;
  owner_subject: string;
  owner_auth_epoch: number;
  expires_at_ms: number;
  auth_epoch: number;
  owner_revoked_at_ms: number | null;
};

type EnrollmentRow = {
  id: string;
  device_code_hash: string;
  status: EnrollmentTokenContext["status"];
  signing_public_jwk: string;
  signing_jkt: string;
  expires_at_ms: number;
  next_poll_at_ms: number;
  poll_interval_seconds: number;
  owner_subject: string | null;
  device_id: string | null;
};

type EnrollmentApprovalRow = {
  id: string;
  device_name: string;
  signing_public_jwk: string;
  signing_jkt: string;
  agreement_public_jwk: string;
  agreement_jkt: string;
  expires_at_ms: number;
};

type DeviceRow = {
  id: string;
  owner_subject: string;
  name: string;
  signing_public_jwk: string;
  signing_jkt: string;
  agreement_public_jwk: string;
  auth_epoch: number;
  created_at_ms: number;
  last_seen_at_ms: number | null;
  revoked_at_ms: number | null;
};

type RefreshRow = DeviceRow & {
  token_hash: string;
  family_id: string;
  rotation: number;
  expires_at_ms: number;
  rotated_at_ms: number | null;
  refresh_revoked_at_ms: number | null;
};

export async function upsertOwner(db: D1Database, identity: AccessIdentity, nowMs: number): Promise<void> {
  const existing = await db.prepare(
    "SELECT subject, auth_epoch, revoked_at_ms FROM owners WHERE subject = ?1"
  ).bind(identity.subject).first<OwnerRow>();
  if (existing?.revoked_at_ms !== null && existing) {
    throw new ConnectHttpError(403, "connect_owner_revoked", "This Connect identity has been revoked.");
  }
  if (existing) {
    await db.prepare("UPDATE owners SET updated_at_ms = ?1 WHERE subject = ?2")
      .bind(nowMs, identity.subject).run();
    return;
  }
  await db.prepare(`
    INSERT INTO owners (subject, auth_epoch, created_at_ms, updated_at_ms, revoked_at_ms)
    VALUES (?1, 0, ?2, ?2, NULL)
  `).bind(identity.subject, nowMs).run();
}

export async function createBrowserSession(
  db: D1Database,
  identity: AccessIdentity,
  nowMs: number
): Promise<CreatedBrowserSession> {
  await upsertOwner(db, identity, nowMs);
  const owner = await db.prepare("SELECT subject, auth_epoch, revoked_at_ms FROM owners WHERE subject = ?1")
    .bind(identity.subject).first<OwnerRow>();
  if (!owner || owner.revoked_at_ms !== null) {
    throw new ConnectHttpError(403, "connect_owner_revoked", "This Connect identity has been revoked.");
  }
  const token = randomToken("cbs_", 32);
  const sessionHash = await hashSecret(token);
  const expiresAtMs = nowMs + BROWSER_SESSION_TTL_MS;
  await db.prepare(`
    INSERT INTO browser_sessions (
      session_hash, owner_subject, owner_auth_epoch, created_at_ms, expires_at_ms, revoked_at_ms
    ) VALUES (?1, ?2, ?3, ?4, ?5, NULL)
  `).bind(sessionHash, owner.subject, owner.auth_epoch, nowMs, expiresAtMs).run();
  return {
    token,
    sessionHash,
    ownerSubject: owner.subject,
    accountId: await accountIdForSubject(owner.subject),
    expiresAtMs
  };
}

export async function getBrowserSession(
  db: D1Database,
  token: string | undefined,
  nowMs: number
): Promise<StoredBrowserSession | undefined> {
  if (!token) return undefined;
  const sessionHash = await hashSecret(token);
  const row = await db.prepare(`
    SELECT s.session_hash, s.owner_subject, s.owner_auth_epoch, s.expires_at_ms,
           o.auth_epoch, o.revoked_at_ms AS owner_revoked_at_ms
    FROM browser_sessions s
    JOIN owners o ON o.subject = s.owner_subject
    WHERE s.session_hash = ?1 AND s.revoked_at_ms IS NULL AND s.expires_at_ms > ?2
  `).bind(sessionHash, nowMs).first<BrowserSessionRow>();
  if (!row || row.owner_revoked_at_ms !== null || row.owner_auth_epoch !== row.auth_epoch) return undefined;
  return {
    sessionHash: row.session_hash,
    ownerSubject: row.owner_subject,
    accountId: await accountIdForSubject(row.owner_subject),
    expiresAtMs: row.expires_at_ms
  };
}

export async function revokeBrowserSession(db: D1Database, token: string | undefined, nowMs: number): Promise<void> {
  if (!token) return;
  await db.prepare("UPDATE browser_sessions SET revoked_at_ms = ?1 WHERE session_hash = ?2 AND revoked_at_ms IS NULL")
    .bind(nowMs, await hashSecret(token)).run();
}

export async function createEnrollment(
  db: D1Database,
  input: ConnectEnrollmentRequest,
  clientKeyHash: string,
  signingJkt: string,
  agreementJkt: string,
  nowMs: number
): Promise<CreatedEnrollment> {
  const recent = await db.prepare(`
    SELECT COUNT(*) AS count FROM device_enrollments
    WHERE client_key_hash = ?1 AND created_at_ms > ?2
  `).bind(clientKeyHash, nowMs - 10 * 60_000).first<{ count: number }>();
  if ((recent?.count ?? 0) >= MAX_ENROLLMENTS_PER_TEN_MINUTES) {
    throw new ConnectHttpError(429, "connect_enrollment_rate_limited", "Too many enrollment attempts. Try again later.");
  }
  const requestNonceHash = await hashSecret(input.nonce);
  const expiresAtMs = nowMs + ENROLLMENT_TTL_MS;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const enrollmentId = randomToken("ce_", 20);
    const deviceCode = randomToken("cdc_", 32);
    const userCode = randomUserCode();
    const [deviceCodeHash, userCodeHash] = await Promise.all([
      hashSecret(deviceCode),
      hashSecret(normalizeUserCode(userCode))
    ]);
    try {
      await db.prepare(`
        INSERT INTO device_enrollments (
          id, device_code_hash, user_code_hash, request_nonce_hash, client_key_hash,
          device_name, signing_public_jwk, signing_jkt, agreement_public_jwk, agreement_jkt,
          proof_issued_at_ms, status, owner_subject, device_id, created_at_ms, expires_at_ms,
          approved_at_ms, consumed_at_ms, next_poll_at_ms, poll_interval_seconds
        ) VALUES (
          ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10,
          ?11, 'pending', NULL, NULL, ?12, ?13, NULL, NULL, ?14, ?15
        )
      `).bind(
        enrollmentId,
        deviceCodeHash,
        userCodeHash,
        requestNonceHash,
        clientKeyHash,
        input.deviceName,
        canonicalConnectPublicJwk(input.signingPublicJwk),
        signingJkt,
        canonicalConnectPublicJwk(input.agreementPublicJwk),
        agreementJkt,
        Date.parse(input.issuedAt),
        nowMs,
        expiresAtMs,
        nowMs + INITIAL_POLL_SECONDS * 1_000,
        INITIAL_POLL_SECONDS
      ).run();
      return { enrollmentId, deviceCode, userCode, expiresAtMs, interval: INITIAL_POLL_SECONDS };
    } catch (error) {
      const replay = await db.prepare("SELECT id FROM device_enrollments WHERE request_nonce_hash = ?1")
        .bind(requestNonceHash).first<{ id: string }>();
      if (replay) {
        throw new ConnectHttpError(409, "connect_enrollment_replayed", "Enrollment proof nonce has already been used.");
      }
      if (attempt === 3) throw error;
    }
  }
  throw new ConnectHttpError(500, "connect_enrollment_failed", "Connect could not create an enrollment.");
}

export async function approveEnrollment(
  db: D1Database,
  userCodeInput: unknown,
  ownerSubject: string,
  nowMs: number
): Promise<StoredDevice> {
  const userCodeHash = await hashSecret(normalizeUserCode(userCodeInput));
  const enrollment = await db.prepare(`
    SELECT id, device_name, signing_public_jwk, signing_jkt, agreement_public_jwk, agreement_jkt, expires_at_ms
    FROM device_enrollments
    WHERE user_code_hash = ?1 AND status = 'pending' AND expires_at_ms > ?2
  `).bind(userCodeHash, nowMs).first<EnrollmentApprovalRow>();
  if (!enrollment) {
    throw new ConnectHttpError(404, "connect_enrollment_not_found", "Enrollment code is unknown, expired, or already used.");
  }
  const active = await db.prepare(`
    SELECT id FROM devices
    WHERE owner_subject = ?1 AND signing_jkt = ?2 AND revoked_at_ms IS NULL
  `).bind(ownerSubject, enrollment.signing_jkt).first<{ id: string }>();
  if (active) {
    throw new ConnectHttpError(409, "connect_device_exists", "This device signing key is already enrolled.");
  }
  const deviceId = randomToken("cd_", 20);
  let results: D1Result[];
  try {
    results = await db.batch([
      db.prepare(`
        INSERT INTO devices (
          id, owner_subject, name, signing_public_jwk, signing_jkt, agreement_public_jwk,
          agreement_jkt, auth_epoch, created_at_ms, updated_at_ms, last_seen_at_ms, revoked_at_ms
        )
        SELECT ?1, ?2, device_name, signing_public_jwk, signing_jkt, agreement_public_jwk,
               agreement_jkt, 0, ?3, ?3, NULL, NULL
        FROM device_enrollments
        WHERE id = ?4 AND status = 'pending' AND expires_at_ms > ?3
      `).bind(deviceId, ownerSubject, nowMs, enrollment.id),
      db.prepare(`
        UPDATE device_enrollments
        SET status = 'approved', owner_subject = ?1, device_id = ?2, approved_at_ms = ?3, next_poll_at_ms = ?3
        WHERE id = ?4 AND status = 'pending' AND expires_at_ms > ?3
      `).bind(ownerSubject, deviceId, nowMs, enrollment.id)
    ]);
  } catch {
    throw new ConnectHttpError(409, "connect_enrollment_conflict", "Enrollment was already approved or its signing key is already enrolled.");
  }
  if ((results[0]?.meta.changes ?? 0) !== 1 || (results[1]?.meta.changes ?? 0) !== 1) {
    throw new ConnectHttpError(409, "connect_enrollment_conflict", "Enrollment was already approved or expired.");
  }
  const device = await getDevice(db, deviceId);
  if (!device) throw new ConnectHttpError(500, "connect_device_store_failed", "Approved Connect device was not persisted.");
  return device;
}

export async function getEnrollmentTokenContext(
  db: D1Database,
  enrollmentId: string,
  deviceCode: string
): Promise<EnrollmentTokenContext | undefined> {
  const deviceCodeHash = await hashSecret(deviceCode);
  const row = await db.prepare(`
    SELECT id, device_code_hash, status, signing_public_jwk, signing_jkt, expires_at_ms,
           next_poll_at_ms, poll_interval_seconds, owner_subject, device_id
    FROM device_enrollments WHERE id = ?1 AND device_code_hash = ?2
  `).bind(enrollmentId, deviceCodeHash).first<EnrollmentRow>();
  if (!row) return undefined;
  return {
    enrollmentId: row.id,
    deviceCodeHash: row.device_code_hash,
    status: row.status,
    signingPublicJwk: parseStoredPublicJwk(row.signing_public_jwk),
    signingJkt: row.signing_jkt,
    expiresAtMs: row.expires_at_ms,
    nextPollAtMs: row.next_poll_at_ms,
    pollIntervalSeconds: row.poll_interval_seconds,
    ...(row.owner_subject ? { ownerSubject: row.owner_subject } : {}),
    ...(row.device_id ? { deviceId: row.device_id } : {})
  };
}

export async function pollEnrollment(
  db: D1Database,
  context: EnrollmentTokenContext,
  nowMs: number
): Promise<EnrollmentPollResult> {
  if (context.status === "consumed" || context.status === "revoked") return { type: "invalid_grant" };
  if (context.status === "expired" || context.expiresAtMs <= nowMs) {
    await db.prepare(`
      UPDATE device_enrollments SET status = 'expired'
      WHERE id = ?1 AND status IN ('pending', 'approved')
    `).bind(context.enrollmentId).run();
    return { type: "expired_token" };
  }
  if (nowMs < context.nextPollAtMs) {
    const interval = Math.min(30, context.pollIntervalSeconds + 5);
    await db.prepare(`
      UPDATE device_enrollments SET poll_interval_seconds = ?1, next_poll_at_ms = ?2
      WHERE id = ?3 AND status IN ('pending', 'approved')
    `).bind(interval, nowMs + interval * 1_000, context.enrollmentId).run();
    return { type: "slow_down", interval };
  }
  if (context.status === "pending") {
    await db.prepare(`
      UPDATE device_enrollments SET next_poll_at_ms = ?1
      WHERE id = ?2 AND status = 'pending' AND next_poll_at_ms <= ?3
    `).bind(nowMs + context.pollIntervalSeconds * 1_000, context.enrollmentId, nowMs).run();
    return { type: "authorization_pending", interval: context.pollIntervalSeconds };
  }
  if (!context.deviceId || !context.ownerSubject) return { type: "invalid_grant" };
  const device = await getDevice(db, context.deviceId);
  if (!device || device.revokedAtMs !== undefined || device.ownerSubject !== context.ownerSubject) {
    return { type: "invalid_grant" };
  }
  const refreshToken = randomToken("crt_", 32);
  const refreshHash = await hashSecret(refreshToken);
  const familyId = randomToken("crf_", 20);
  let results: D1Result[];
  try {
    results = await db.batch([
      db.prepare(`
        INSERT INTO refresh_tokens (
          token_hash, family_id, device_id, source_enrollment_id, parent_token_hash, rotation, created_at_ms,
          expires_at_ms, rotated_at_ms, revoked_at_ms, revoke_reason
        )
        SELECT ?1, ?2, ?3, ?6, NULL, 0, ?4, ?5, NULL, NULL, NULL
        WHERE EXISTS (SELECT 1 FROM device_enrollments WHERE id = ?6 AND status = 'approved')
      `).bind(refreshHash, familyId, device.deviceId, nowMs, nowMs + REFRESH_TOKEN_TTL_MS, context.enrollmentId),
      db.prepare(`
        UPDATE device_enrollments SET status = 'consumed', consumed_at_ms = ?1
        WHERE id = ?2 AND status = 'approved' AND expires_at_ms > ?1
      `).bind(nowMs, context.enrollmentId)
    ]);
  } catch {
    return { type: "invalid_grant" };
  }
  // D1 batches are transactional. A concurrent consumer can make either conditional statement a no-op.
  if ((results[0]?.meta.changes ?? 0) !== 1 || (results[1]?.meta.changes ?? 0) !== 1) {
    return { type: "invalid_grant" };
  }
  return { type: "issued", refreshToken, device };
}

export async function getRefreshContext(db: D1Database, refreshToken: string): Promise<RefreshContext | undefined> {
  const tokenHash = await hashSecret(refreshToken);
  const row = await db.prepare(`
    SELECT r.token_hash, r.family_id, r.rotation, r.expires_at_ms, r.rotated_at_ms,
           r.revoked_at_ms AS refresh_revoked_at_ms,
           d.id, d.owner_subject, d.name, d.signing_public_jwk, d.signing_jkt,
           d.agreement_public_jwk, d.auth_epoch, d.created_at_ms, d.last_seen_at_ms, d.revoked_at_ms
    FROM refresh_tokens r
    JOIN devices d ON d.id = r.device_id
    WHERE r.token_hash = ?1
  `).bind(tokenHash).first<RefreshRow>();
  if (!row) return undefined;
  return {
    tokenHash: row.token_hash,
    familyId: row.family_id,
    rotation: row.rotation,
    expiresAtMs: row.expires_at_ms,
    ...(row.rotated_at_ms === null ? {} : { rotatedAtMs: row.rotated_at_ms }),
    ...(row.refresh_revoked_at_ms === null ? {} : { revokedAtMs: row.refresh_revoked_at_ms }),
    device: deviceFromRow(row)
  };
}

export async function rotateRefreshToken(
  db: D1Database,
  context: RefreshContext,
  nowMs: number
): Promise<{ refreshToken: string; device: StoredDevice } | undefined> {
  const disposition = refreshCredentialDisposition(context, nowMs);
  if (disposition === "revoke_family") {
    await revokeRefreshFamilyAndAdvanceEpoch(db, context.familyId, context.device.deviceId, "refresh_reuse", nowMs);
    return undefined;
  }
  if (disposition === "device_revoked") return undefined;
  const refreshToken = randomToken("crt_", 32);
  const refreshHash = await hashSecret(refreshToken);
  try {
    const results = await db.batch([
      db.prepare(`
        UPDATE refresh_tokens
        SET rotated_at_ms = ?1, revoked_at_ms = ?1, revoke_reason = 'rotated'
        WHERE token_hash = ?2 AND rotated_at_ms IS NULL AND revoked_at_ms IS NULL AND expires_at_ms > ?1
      `).bind(nowMs, context.tokenHash),
      db.prepare(`
        INSERT INTO refresh_tokens (
          token_hash, family_id, device_id, source_enrollment_id, parent_token_hash, rotation, created_at_ms,
          expires_at_ms, rotated_at_ms, revoked_at_ms, revoke_reason
        ) VALUES (?1, ?2, ?3, NULL, ?4, ?5, ?6, ?7, NULL, NULL, NULL)
      `).bind(
        refreshHash,
        context.familyId,
        context.device.deviceId,
        context.tokenHash,
        context.rotation + 1,
        nowMs,
        nowMs + REFRESH_TOKEN_TTL_MS
      )
    ]);
    if ((results[0]?.meta.changes ?? 0) !== 1 || (results[1]?.meta.changes ?? 0) !== 1) {
      await revokeRefreshFamilyAndAdvanceEpoch(db, context.familyId, context.device.deviceId, "refresh_race", nowMs);
      return undefined;
    }
  } catch {
    await revokeRefreshFamilyAndAdvanceEpoch(db, context.familyId, context.device.deviceId, "refresh_race", nowMs);
    return undefined;
  }
  const device = await getDevice(db, context.device.deviceId);
  return device ? { refreshToken, device } : undefined;
}

export async function recordDpopReplay(
  db: D1Database,
  input: { jtiHash: string; subjectRef: string; expiresAtMs: number },
  nowMs: number
): Promise<void> {
  try {
    await db.prepare(`
      INSERT INTO dpop_replays (jti_hash, subject_ref, created_at_ms, expires_at_ms)
      VALUES (?1, ?2, ?3, ?4)
    `).bind(input.jtiHash, input.subjectRef, nowMs, input.expiresAtMs).run();
  } catch (error) {
    const replay = await db.prepare("SELECT jti_hash FROM dpop_replays WHERE jti_hash = ?1")
      .bind(input.jtiHash).first<{ jti_hash: string }>();
    if (replay) throw new ConnectHttpError(409, "connect_dpop_replayed", "DPoP proof has already been used.");
    throw error;
  }
}

export async function cleanupExpiredOutcomes(db: D1Database, nowMs: number): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM dpop_replays WHERE expires_at_ms <= ?1").bind(nowMs),
    db.prepare(`
      UPDATE device_enrollments SET status = 'expired'
      WHERE expires_at_ms <= ?1 AND status IN ('pending', 'approved')
    `).bind(nowMs),
    db.prepare("UPDATE browser_sessions SET revoked_at_ms = ?1 WHERE expires_at_ms <= ?1 AND revoked_at_ms IS NULL").bind(nowMs)
  ]);
}

export async function listDevices(db: D1Database, ownerSubject: string): Promise<StoredDevice[]> {
  const result = await db.prepare(`
    SELECT id, owner_subject, name, signing_public_jwk, signing_jkt, agreement_public_jwk,
           auth_epoch, created_at_ms, last_seen_at_ms, revoked_at_ms
    FROM devices WHERE owner_subject = ?1 ORDER BY created_at_ms DESC LIMIT 100
  `).bind(ownerSubject).all<DeviceRow>();
  return result.results.map(deviceFromRow);
}

export async function getOwnedDevice(
  db: D1Database,
  deviceId: string,
  ownerSubject: string
): Promise<StoredDevice | undefined> {
  const device = await getDevice(db, deviceId);
  return device?.ownerSubject === ownerSubject ? device : undefined;
}

export async function getDevice(db: D1Database, deviceId: string): Promise<StoredDevice | undefined> {
  const row = await db.prepare(`
    SELECT id, owner_subject, name, signing_public_jwk, signing_jkt, agreement_public_jwk,
           auth_epoch, created_at_ms, last_seen_at_ms, revoked_at_ms
    FROM devices WHERE id = ?1
  `).bind(deviceId).first<DeviceRow>();
  return row ? deviceFromRow(row) : undefined;
}

export async function touchDevice(db: D1Database, deviceId: string, nowMs: number): Promise<void> {
  await db.prepare(`
    UPDATE devices SET last_seen_at_ms = ?1, updated_at_ms = ?1
    WHERE id = ?2 AND revoked_at_ms IS NULL
  `).bind(nowMs, deviceId).run();
}

export async function revokeDevice(
  db: D1Database,
  deviceId: string,
  ownerSubject: string,
  nowMs: number
): Promise<boolean> {
  const results = await db.batch([
    db.prepare(`
      UPDATE devices SET revoked_at_ms = ?1, updated_at_ms = ?1, auth_epoch = auth_epoch + 1
      WHERE id = ?2 AND owner_subject = ?3 AND revoked_at_ms IS NULL
    `).bind(nowMs, deviceId, ownerSubject),
    db.prepare(`
      UPDATE refresh_tokens SET revoked_at_ms = ?1, revoke_reason = 'device_revoked'
      WHERE device_id = ?2 AND revoked_at_ms IS NULL
    `).bind(nowMs, deviceId)
  ]);
  return (results[0]?.meta.changes ?? 0) === 1;
}

export async function toDeviceMetadata(device: StoredDevice, online: boolean): Promise<ConnectDeviceMetadata> {
  return {
    deviceId: device.deviceId,
    deviceName: device.deviceName,
    signingPublicJwk: device.signingPublicJwk,
    agreementPublicJwk: device.agreementPublicJwk,
    ...(device.lastSeenAtMs === undefined ? {} : { lastSeenAt: new Date(device.lastSeenAtMs).toISOString() }),
    status: device.revokedAtMs !== undefined ? "revoked" : online ? "online" : "offline"
  };
}

async function revokeRefreshFamilyAndAdvanceEpoch(
  db: D1Database,
  familyId: string,
  deviceId: string,
  reason: string,
  nowMs: number
): Promise<void> {
  await db.batch([
    db.prepare(`
      UPDATE refresh_tokens SET revoked_at_ms = ?1, revoke_reason = ?2
      WHERE family_id = ?3 AND revoked_at_ms IS NULL
    `).bind(nowMs, reason, familyId),
    db.prepare(`
      UPDATE devices SET auth_epoch = auth_epoch + 1, updated_at_ms = ?1
      WHERE id = ?2 AND revoked_at_ms IS NULL
    `).bind(nowMs, deviceId)
  ]);
}

function deviceFromRow(row: DeviceRow): StoredDevice {
  return {
    deviceId: row.id,
    ownerSubject: row.owner_subject,
    deviceName: row.name,
    signingPublicJwk: parseStoredPublicJwk(row.signing_public_jwk),
    signingJkt: row.signing_jkt,
    agreementPublicJwk: parseStoredPublicJwk(row.agreement_public_jwk),
    authEpoch: row.auth_epoch,
    createdAtMs: row.created_at_ms,
    ...(row.last_seen_at_ms === null ? {} : { lastSeenAtMs: row.last_seen_at_ms }),
    ...(row.revoked_at_ms === null ? {} : { revokedAtMs: row.revoked_at_ms })
  };
}

function parseStoredPublicJwk(value: string): ConnectP256PublicJwk {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new ConnectHttpError(500, "connect_data_invalid", "Stored Connect public key is invalid.");
  }
  const decoded = decodeConnectP256PublicJwk(parsed, "storedPublicJwk");
  if (!decoded.ok) throw new ConnectHttpError(500, "connect_data_invalid", "Stored Connect public key is invalid.");
  return decoded.value;
}
