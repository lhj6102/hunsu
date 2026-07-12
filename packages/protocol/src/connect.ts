export const CONNECT_ENROLLMENT_SCHEMA = "hunsu.connect.enrollment.v1" as const;
export const CONNECT_ENROLLMENT_PROOF_CONTEXT = "hunsu.connect.enrollment-proof.v1" as const;
export const CONNECT_SESSION_SCHEMA = "hunsu.connect.session.v1" as const;
export const CONNECT_SESSION_TICKET_TYPE = "hunsu-connect-session+jwt" as const;
export const CONNECT_SESSION_TICKET_AUDIENCE = "hunsu-bridge" as const;
export const CONNECT_SIGNAL_FRAME_SCHEMA = "hunsu.connect.signal-frame.v1" as const;
export const CONNECT_CONTROL_FRAME_SCHEMA = "hunsu.connect.control-frame.v1" as const;
export const CONNECT_SIGNAL_HKDF_INFO = "hunsu.connect.signal.v1" as const;
export const CONNECT_SESSION_TTL_SECONDS = 90 as const;
export const CONNECT_DEVICE_ACCESS_TTL_SECONDS = 300 as const;
export const CONNECT_MAX_SIGNAL_CIPHERTEXT_BYTES = 64 * 1024;
export const CONNECT_MAX_SIGNAL_FRAME_BYTES = 96 * 1024;

export type ConnectEnvironment = "preview" | "production";

export type ConnectP256PublicJwk = {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
};

export type ConnectEnrollmentRequest = {
  schema: typeof CONNECT_ENROLLMENT_SCHEMA;
  deviceName: string;
  signingPublicJwk: ConnectP256PublicJwk;
  agreementPublicJwk: ConnectP256PublicJwk;
  issuedAt: string;
  nonce: string;
  proof: string;
};

export type ConnectEnrollmentCreated = {
  schema: "hunsu.connect.enrollment-created.v1";
  enrollmentId: string;
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
};

export type ConnectEnrollmentApprovalRequest = {
  userCode: string;
};

export type ConnectEnrollmentTokenRequest = {
  enrollmentId: string;
  deviceCode: string;
};

export type ConnectRefreshTokenRequest = {
  refreshToken: string;
};

export type ConnectDeviceTokenResponse = {
  schema: "hunsu.connect.device-token.v1";
  tokenType: "DPoP";
  accessToken: string;
  expiresIn: typeof CONNECT_DEVICE_ACCESS_TTL_SECONDS;
  refreshToken: string;
  deviceId: string;
  accountId: string;
};

export type ConnectDeviceMetadata = {
  deviceId: string;
  deviceName: string;
  signingPublicJwk: ConnectP256PublicJwk;
  agreementPublicJwk: ConnectP256PublicJwk;
  lastSeenAt?: string;
  status: "online" | "offline" | "revoked";
};

export type ConnectBrowserSession =
  | {
      authenticated: true;
      user: { accountId: string };
      expiresAt: string;
    }
  | {
      authenticated: false;
      user: null;
    };

export type ConnectSessionCreateRequest = {
  deviceId: string;
  browserAgreementPublicJwk: ConnectP256PublicJwk;
};

export type ConnectSessionCreated = {
  schema: typeof CONNECT_SESSION_SCHEMA;
  sessionId: string;
  ticket: string;
  expiresAt: string;
  webSocketUrl: string;
};

export type ConnectSessionTicketClaims = {
  iss: string;
  aud: typeof CONNECT_SESSION_TICKET_AUDIENCE;
  sub: string;
  jti: string;
  environment: ConnectEnvironment;
  sessionId: string;
  accountId: string;
  deviceId: string;
  browserAgreementPublicJwk: ConnectP256PublicJwk;
  iat: number;
  exp: number;
};

export type ConnectSignalFrame = {
  schema: typeof CONNECT_SIGNAL_FRAME_SCHEMA;
  sessionId: string;
  sequence: number;
  iv: string;
  ciphertext: string;
};

export type ConnectCloseReason = "expired" | "replaced" | "revoked" | "peer_disconnected" | "protocol_error";

export type ConnectServerControlFrame =
  | {
      schema: typeof CONNECT_CONTROL_FRAME_SCHEMA;
      type: "connect.authenticated";
      deviceId: string;
      accountId: string;
      expiresAt: string;
    }
  | {
      schema: typeof CONNECT_CONTROL_FRAME_SCHEMA;
      type: "connect.session";
      sessionId: string;
      ticket: string;
      expiresAt: string;
    }
  | {
      schema: typeof CONNECT_CONTROL_FRAME_SCHEMA;
      type: "connect.ready";
      sessionId: string;
    }
  | {
      schema: typeof CONNECT_CONTROL_FRAME_SCHEMA;
      type: "connect.closed";
      sessionId: string;
      reason: ConnectCloseReason;
    };

export type ConnectDecodeError = {
  code: "INVALID_CONNECT_WIRE";
  field: string;
  message: string;
};

export type ConnectDecodeResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ConnectDecodeError };

export function canonicalConnectPublicJwk(jwk: ConnectP256PublicJwk): string {
  return `{"crv":"P-256","kty":"EC","x":${JSON.stringify(jwk.x)},"y":${JSON.stringify(jwk.y)}}`;
}

export function connectEnrollmentProofMessage(input: Omit<ConnectEnrollmentRequest, "schema" | "proof">): string {
  return [
    CONNECT_ENROLLMENT_PROOF_CONTEXT,
    input.deviceName,
    input.issuedAt,
    input.nonce,
    canonicalConnectPublicJwk(input.signingPublicJwk),
    canonicalConnectPublicJwk(input.agreementPublicJwk)
  ].join("\n");
}

export function decodeConnectP256PublicJwk(value: unknown, field = "publicJwk"): ConnectDecodeResult<ConnectP256PublicJwk> {
  if (!isRecord(value) || !hasOnlyKeys(value, ["kty", "crv", "x", "y"])) {
    return invalid(field, "P-256 public JWK must contain only kty, crv, x, and y.");
  }
  if (value.kty !== "EC" || value.crv !== "P-256") {
    return invalid(field, "Public JWK must use EC P-256.");
  }
  if (!isBase64UrlBytes(value.x, 32, 32) || !isBase64UrlBytes(value.y, 32, 32)) {
    return invalid(field, "P-256 public JWK coordinates must be 32-byte base64url values.");
  }
  return { ok: true, value: { kty: "EC", crv: "P-256", x: value.x, y: value.y } };
}

export function decodeConnectSignalFrame(value: unknown): ConnectDecodeResult<ConnectSignalFrame> {
  if (!isRecord(value) || !hasOnlyKeys(value, ["schema", "sessionId", "sequence", "iv", "ciphertext"])) {
    return invalid("$signal", "Connect signal frame has unknown or missing fields.");
  }
  if (value.schema !== CONNECT_SIGNAL_FRAME_SCHEMA) {
    return invalid("schema", "Connect signal frame schema is not supported.");
  }
  if (typeof value.sessionId !== "string" || !/^cs_[A-Za-z0-9_-]{20,125}$/u.test(value.sessionId)) {
    return invalid("sessionId", "Connect session ID is invalid.");
  }
  if (!Number.isSafeInteger(value.sequence) || Number(value.sequence) < 1) {
    return invalid("sequence", "Connect signal sequence must be a positive safe integer starting at 1.");
  }
  if (!isBase64UrlBytes(value.iv, 12, 12)) {
    return invalid("iv", "Connect signal IV must be exactly 12 bytes of base64url data.");
  }
  if (!isBase64UrlBytes(value.ciphertext, 16, CONNECT_MAX_SIGNAL_CIPHERTEXT_BYTES)) {
    return invalid("ciphertext", `Connect signal ciphertext must contain 16-${CONNECT_MAX_SIGNAL_CIPHERTEXT_BYTES} bytes of base64url data.`);
  }
  return {
    ok: true,
    value: {
      schema: CONNECT_SIGNAL_FRAME_SCHEMA,
      sessionId: value.sessionId,
      sequence: Number(value.sequence),
      iv: value.iv,
      ciphertext: value.ciphertext
    }
  };
}

function invalid(field: string, message: string): ConnectDecodeResult<never> {
  return { ok: false, error: { code: "INVALID_CONNECT_WIRE", field, message } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every(key => keys.includes(key));
}

function isBase64UrlBytes(value: unknown, minBytes: number, maxBytes: number): value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/u.test(value)) return false;
  const remainder = value.length % 4;
  if (remainder === 1) return false;
  const decodedBytes = Math.floor(value.length * 3 / 4);
  return decodedBytes >= minBytes && decodedBytes <= maxBytes;
}
