import { randomBytes as nodeRandomBytes, timingSafeEqual } from "node:crypto";
import { err, ok, type Result } from "@hunsu/protocol";

export const DEFAULT_PAIRING_TTL_MS = 5 * 60 * 1_000;

export type PairingSafeMetadata = {
  pairingId: string;
  expiresAt: string;
  workspaceId: string | null;
  browserOpened: boolean;
  status: "active" | "consumed" | "expired" | "revoked";
};

export type PairingInternalCredential = {
  pairingId: string;
  credential: string;
  pairingUrl: string;
};

export type PairingRotation = {
  safe: PairingSafeMetadata;
  internal: PairingInternalCredential;
};

export type PairingGrant = {
  pairingId: string;
  workspaceId: string | null;
  expiresAt: string;
};

export type PairingValidation =
  | { valid: true }
  | { valid: false; reason: "missing" | "invalid" | "expired" | "revoked" };

export type PairingError =
  | { code: "PAIRING_ROTATION_FAILED"; message: string }
  | { code: "PAIRING_CREDENTIAL_INVALID"; message: string }
  | { code: "PAIRING_CREDENTIAL_EXPIRED"; message: string }
  | { code: "PAIRING_CREDENTIAL_REVOKED"; message: string };

export type PairingService = {
  rotate(input: { browserUrl: string; workspaceId?: string }): Result<PairingRotation, PairingError>;
  consume(credential: string): Result<PairingGrant, PairingError>;
  validate(credential?: string): PairingValidation;
  revoke(pairingId?: string): boolean;
  markBrowserOpened(pairingId: string): boolean;
  getSafeMetadata(): PairingSafeMetadata | null;
  getPairingUrl(pairingId: string): Result<string, PairingError>;
};

type PairingSession = {
  pairingId: string;
  credential: string;
  pairingUrl: string;
  workspaceId: string | null;
  expiresAtMs: number;
  browserOpened: boolean;
  consumed: boolean;
  revoked: boolean;
};

export function createPairingService(input: {
  controlToken: string;
  ttlMs?: number;
  now?: () => number;
  randomBytes?: (size: number) => Uint8Array;
  initialPairing?: {
    credential: string;
    browserUrl: string;
    workspaceId?: string;
  };
}): PairingService {
  if (!input.controlToken.trim()) {
    throw new Error("Control token is required before pairing can be enabled.");
  }
  const ttlMs = input.ttlMs ?? DEFAULT_PAIRING_TTL_MS;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new Error("Pairing TTL must be positive.");
  }
  const now = input.now ?? Date.now;
  const randomBytes = input.randomBytes ?? nodeRandomBytes;
  let current: PairingSession | undefined;
  if (input.initialPairing) {
    const credential = input.initialPairing.credential.trim();
    if (!credential || secretEquals(input.controlToken, credential)) {
      throw new Error("Initial pairing credential must be non-empty and distinct from the control token.");
    }
    const url = pairingBrowserUrl(input.initialPairing.browserUrl);
    if (!url) throw new Error("Initial pairing browser URL is invalid.");
    const pairingId = `pair_${Buffer.from(randomBytes(12)).toString("base64url")}`;
    url.searchParams.set("hunsuBridgeToken", credential);
    if (input.initialPairing.workspaceId) url.searchParams.set("workspace", input.initialPairing.workspaceId);
    current = {
      pairingId,
      credential,
      pairingUrl: url.toString(),
      workspaceId: input.initialPairing.workspaceId ?? null,
      expiresAtMs: now() + ttlMs,
      browserOpened: false,
      consumed: false,
      revoked: false
    };
  }

  const safeMetadata = (session: PairingSession): PairingSafeMetadata => ({
    pairingId: session.pairingId,
    expiresAt: new Date(session.expiresAtMs).toISOString(),
    workspaceId: session.workspaceId,
    browserOpened: session.browserOpened,
    status: session.revoked
      ? "revoked"
      : now() >= session.expiresAtMs
        ? "expired"
        : session.consumed
          ? "consumed"
          : "active"
  });

  const authorize = (credential: string): Result<PairingGrant, PairingError> => {
    if (!current || !secretEquals(current.credential, credential)) {
      return err({ code: "PAIRING_CREDENTIAL_INVALID", message: "Pairing credential is invalid." });
    }
    if (current.revoked) {
      return err({ code: "PAIRING_CREDENTIAL_REVOKED", message: "Pairing credential has been revoked." });
    }
    if (now() >= current.expiresAtMs) {
      return err({ code: "PAIRING_CREDENTIAL_EXPIRED", message: "Pairing credential has expired." });
    }
    return ok({
      pairingId: current.pairingId,
      workspaceId: current.workspaceId,
      expiresAt: new Date(current.expiresAtMs).toISOString()
    });
  };

  return {
    rotate(rotationInput) {
      const url = pairingBrowserUrl(rotationInput.browserUrl);
      if (!url) {
        return err({ code: "PAIRING_ROTATION_FAILED", message: "Browser URL is invalid." });
      }
      const credential = `hunsu_bridge_pair_${Buffer.from(randomBytes(32)).toString("base64url")}`;
      if (credential === input.controlToken) {
        return err({ code: "PAIRING_ROTATION_FAILED", message: "Pairing credential generation failed." });
      }
      const pairingId = `pair_${Buffer.from(randomBytes(12)).toString("base64url")}`;
      url.searchParams.set("hunsuBridgeToken", credential);
      if (rotationInput.workspaceId) url.searchParams.set("workspace", rotationInput.workspaceId);
      if (current) current.revoked = true;
      current = {
        pairingId,
        credential,
        pairingUrl: url.toString(),
        workspaceId: rotationInput.workspaceId ?? null,
        expiresAtMs: now() + ttlMs,
        browserOpened: false,
        consumed: false,
        revoked: false
      };
      return ok({
        safe: safeMetadata(current),
        internal: { pairingId, credential, pairingUrl: current.pairingUrl }
      });
    },
    consume(credential) {
      const grant = authorize(credential);
      if (grant.ok && current) current.consumed = true;
      return grant;
    },
    validate(credential) {
      if (!credential) return { valid: false, reason: "missing" };
      if (!current || !secretEquals(current.credential, credential)) return { valid: false, reason: "invalid" };
      if (current.revoked) return { valid: false, reason: "revoked" };
      if (now() >= current.expiresAtMs) return { valid: false, reason: "expired" };
      return { valid: true };
    },
    revoke(pairingId) {
      if (!current || (pairingId !== undefined && current.pairingId !== pairingId)) return false;
      current.revoked = true;
      return true;
    },
    markBrowserOpened(pairingId) {
      if (!current || current.pairingId !== pairingId || current.revoked || now() >= current.expiresAtMs) return false;
      current.browserOpened = true;
      return true;
    },
    getSafeMetadata() {
      return current ? safeMetadata(current) : null;
    },
    getPairingUrl(pairingId) {
      if (!current || current.pairingId !== pairingId) {
        return err({ code: "PAIRING_CREDENTIAL_INVALID", message: "Pairing credential is invalid." });
      }
      const valid = authorize(current.credential);
      return valid.ok ? ok(current.pairingUrl) : valid;
    }
  };
}

function pairingBrowserUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url : undefined;
  } catch (_error) {
    return undefined;
  }
}

function secretEquals(expected: string, candidate: string): boolean {
  const expectedBytes = Buffer.from(expected);
  const candidateBytes = Buffer.from(candidate);
  return expectedBytes.length === candidateBytes.length && timingSafeEqual(expectedBytes, candidateBytes);
}
