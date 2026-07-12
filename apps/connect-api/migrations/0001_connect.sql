PRAGMA foreign_keys = ON;

CREATE TABLE owners (
  subject TEXT PRIMARY KEY,
  auth_epoch INTEGER NOT NULL DEFAULT 0 CHECK (auth_epoch >= 0),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  revoked_at_ms INTEGER
) STRICT;

CREATE TABLE browser_sessions (
  session_hash TEXT PRIMARY KEY,
  owner_subject TEXT NOT NULL REFERENCES owners(subject),
  owner_auth_epoch INTEGER NOT NULL CHECK (owner_auth_epoch >= 0),
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  revoked_at_ms INTEGER
) STRICT;

CREATE TABLE device_enrollments (
  id TEXT PRIMARY KEY,
  device_code_hash TEXT NOT NULL UNIQUE,
  user_code_hash TEXT NOT NULL UNIQUE,
  request_nonce_hash TEXT NOT NULL UNIQUE,
  client_key_hash TEXT NOT NULL,
  device_name TEXT NOT NULL,
  signing_public_jwk TEXT NOT NULL,
  signing_jkt TEXT NOT NULL,
  agreement_public_jwk TEXT NOT NULL,
  agreement_jkt TEXT NOT NULL,
  proof_issued_at_ms INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'consumed', 'expired', 'revoked')),
  owner_subject TEXT REFERENCES owners(subject),
  device_id TEXT,
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  approved_at_ms INTEGER,
  consumed_at_ms INTEGER,
  next_poll_at_ms INTEGER NOT NULL,
  poll_interval_seconds INTEGER NOT NULL CHECK (poll_interval_seconds BETWEEN 5 AND 30)
) STRICT;

CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  owner_subject TEXT NOT NULL REFERENCES owners(subject),
  name TEXT NOT NULL,
  signing_public_jwk TEXT NOT NULL,
  signing_jkt TEXT NOT NULL UNIQUE,
  agreement_public_jwk TEXT NOT NULL,
  agreement_jkt TEXT NOT NULL,
  auth_epoch INTEGER NOT NULL DEFAULT 0 CHECK (auth_epoch >= 0),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  last_seen_at_ms INTEGER,
  revoked_at_ms INTEGER
) STRICT;

CREATE TABLE refresh_tokens (
  token_hash TEXT PRIMARY KEY,
  family_id TEXT NOT NULL,
  device_id TEXT NOT NULL REFERENCES devices(id),
  source_enrollment_id TEXT UNIQUE REFERENCES device_enrollments(id),
  parent_token_hash TEXT UNIQUE,
  rotation INTEGER NOT NULL CHECK (rotation >= 0),
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  rotated_at_ms INTEGER,
  revoked_at_ms INTEGER,
  revoke_reason TEXT
) STRICT;

CREATE TABLE dpop_replays (
  jti_hash TEXT PRIMARY KEY,
  subject_ref TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL
) STRICT;

CREATE INDEX idx_browser_sessions_owner ON browser_sessions(owner_subject, expires_at_ms);
CREATE INDEX idx_device_enrollments_client ON device_enrollments(client_key_hash, created_at_ms);
CREATE INDEX idx_device_enrollments_expiry ON device_enrollments(expires_at_ms, status);
CREATE INDEX idx_devices_owner ON devices(owner_subject, revoked_at_ms);
CREATE INDEX idx_refresh_tokens_family ON refresh_tokens(family_id, revoked_at_ms);
CREATE INDEX idx_refresh_tokens_device ON refresh_tokens(device_id, expires_at_ms);
CREATE INDEX idx_dpop_replays_expiry ON dpop_replays(expires_at_ms);
