-- 0004_auth_sessions (up)
-- ---------------------------------------------------------------------------
-- Durable authentication runtime state: OTP challenges, trusted devices and
-- bearer sessions, built on the identity foundation from 0003.
--
-- Forward-only: this migration only adds objects and never rewrites 0001-0003.
--
-- Secret handling: only hashes and fingerprints are stored. An OTP row keeps
-- the hash of the delivered code (plus the delivery destination, which is
-- routing data rather than a secret), a device row keeps a fingerprint of the
-- device credential, and a session row keeps a fingerprint of the bearer
-- token. The raw code, credential and token exist only in transit and are
-- never persisted here.
-- ---------------------------------------------------------------------------

-- OTP challenges ----------------------------------------------------------------
-- One row per issued one-time code. `subject` is where the code was delivered
-- (a phone number or an email address) so a retry or an audit can name the
-- destination; the code itself is only ever present as `code_hash`.

CREATE TABLE IF NOT EXISTS otp_challenges (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT REFERENCES tenants(id) ON DELETE CASCADE,
  -- NULL until a challenge is resolved to a known account (sign-up/recovery).
  user_id         TEXT REFERENCES user_accounts(id) ON DELETE CASCADE,
  purpose         TEXT NOT NULL
                    CHECK (purpose IN ('sign_in', 'bind_identity', 'rebind_identity', 'recover')),
  channel         TEXT NOT NULL CHECK (channel IN ('sms', 'email')),
  subject         TEXT NOT NULL,
  code_hash       TEXT NOT NULL,
  code_algorithm  TEXT NOT NULL DEFAULT 'sha256',
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'consumed', 'expired', 'revoked')),
  failed_attempts INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  max_attempts    INTEGER NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
  -- Caller-supplied key that makes issue/resend retry-safe.
  idempotency_key TEXT,
  issued_at       TIMESTAMPTZ NOT NULL,
  expires_at      TIMESTAMPTZ NOT NULL,
  consumed_at     TIMESTAMPTZ,
  revoked_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL,
  CHECK (length(btrim(subject)) > 0),
  -- Same guard rail as password_hash: a stored code is always an encoded hash.
  CHECK (length(code_hash) >= 32),
  CHECK (updated_at >= created_at),
  -- A challenge must have a positive lifetime.
  CHECK (expires_at > issued_at),
  CHECK (failed_attempts <= max_attempts),
  -- Terminal states record when they happened.
  CHECK (status <> 'consumed' OR consumed_at IS NOT NULL),
  CHECK (status <> 'revoked' OR revoked_at IS NOT NULL),
  CHECK (consumed_at IS NULL OR consumed_at >= issued_at),
  CHECK (revoked_at IS NULL OR revoked_at >= issued_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS otp_challenges_idempotency_key_idx
  ON otp_challenges (idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS otp_challenges_pending_idx
  ON otp_challenges (subject, purpose, status, expires_at DESC);
CREATE INDEX IF NOT EXISTS otp_challenges_user_idx
  ON otp_challenges (user_id, issued_at DESC) WHERE user_id IS NOT NULL;

-- Trusted devices ---------------------------------------------------------------
-- A device the user chose to remember. The stored value is a fingerprint of
-- the device credential, never the credential itself.

CREATE TABLE IF NOT EXISTS trusted_devices (
  id                     TEXT PRIMARY KEY,
  user_id                TEXT NOT NULL REFERENCES user_accounts(id) ON DELETE CASCADE,
  tenant_id              TEXT REFERENCES tenants(id) ON DELETE CASCADE,
  label                  TEXT NOT NULL DEFAULT '',
  platform               TEXT NOT NULL DEFAULT 'unknown'
                           CHECK (platform IN ('web', 'ios', 'android', 'desktop', 'unknown')),
  credential_fingerprint TEXT NOT NULL,
  status                 TEXT NOT NULL DEFAULT 'active'
                           CHECK (status IN ('active', 'revoked', 'expired')),
  -- Caller-supplied key that makes device enrolment retry-safe.
  idempotency_key        TEXT,
  trusted_at             TIMESTAMPTZ NOT NULL,
  expires_at             TIMESTAMPTZ,
  last_seen_at           TIMESTAMPTZ NOT NULL,
  revoked_at             TIMESTAMPTZ,
  revoked_reason         TEXT
                           CHECK (revoked_reason IN ('user', 'admin', 'expired', 'compromised')),
  created_at             TIMESTAMPTZ NOT NULL,
  updated_at             TIMESTAMPTZ NOT NULL,
  CHECK (length(credential_fingerprint) >= 32),
  CHECK (updated_at >= created_at),
  CHECK (last_seen_at >= trusted_at),
  CHECK (expires_at IS NULL OR expires_at > trusted_at),
  CHECK (status <> 'revoked' OR revoked_at IS NOT NULL),
  CHECK (revoked_at IS NULL OR revoked_at >= trusted_at)
);

-- A credential fingerprint identifies exactly one device row.
CREATE UNIQUE INDEX IF NOT EXISTS trusted_devices_credential_fingerprint_idx
  ON trusted_devices (credential_fingerprint);
CREATE UNIQUE INDEX IF NOT EXISTS trusted_devices_idempotency_key_idx
  ON trusted_devices (idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS trusted_devices_user_idx
  ON trusted_devices (user_id, status);

-- Authentication sessions -------------------------------------------------------
-- One row per issued bearer session. `token_fingerprint` is the hash of the
-- token handed to the client; `rotation_family_id` groups every token produced
-- by refreshing one sign-in so a replayed (already rotated) token can be
-- detected and the whole family revoked.

CREATE TABLE IF NOT EXISTS auth_sessions (
  id                         TEXT PRIMARY KEY,
  user_id                    TEXT NOT NULL REFERENCES user_accounts(id) ON DELETE CASCADE,
  tenant_id                  TEXT REFERENCES tenants(id) ON DELETE CASCADE,
  -- The acting member for the session, when the user acts as one.
  member_id                  TEXT REFERENCES members(id) ON DELETE SET NULL,
  trusted_device_id          TEXT REFERENCES trusted_devices(id) ON DELETE SET NULL,
  token_fingerprint          TEXT NOT NULL,
  previous_token_fingerprint TEXT,
  rotation_family_id         TEXT NOT NULL,
  auth_method                TEXT NOT NULL
                               CHECK (auth_method IN ('password', 'otp', 'sso', 'trusted_device')),
  status                     TEXT NOT NULL DEFAULT 'active'
                               CHECK (status IN ('active', 'revoked', 'expired')),
  mfa_satisfied              BOOLEAN NOT NULL DEFAULT FALSE,
  -- Fingerprint of the client context (for example a hash of user agent and
  -- address); the raw values are not stored.
  client_fingerprint         TEXT,
  -- Caller-supplied key that makes sign-in retry-safe.
  idempotency_key            TEXT,
  issued_at                  TIMESTAMPTZ NOT NULL,
  expires_at                 TIMESTAMPTZ NOT NULL,
  last_seen_at               TIMESTAMPTZ NOT NULL,
  revoked_at                 TIMESTAMPTZ,
  revoked_reason             TEXT
                               CHECK (revoked_reason IN ('sign_out', 'rotated', 'admin_revoked', 'reuse_detected', 'expired')),
  created_at                 TIMESTAMPTZ NOT NULL,
  updated_at                 TIMESTAMPTZ NOT NULL,
  CHECK (length(token_fingerprint) >= 32),
  CHECK (updated_at >= created_at),
  -- A session must have a positive lifetime, and it cannot be used before it
  -- was issued.
  CHECK (expires_at > issued_at),
  CHECK (last_seen_at >= issued_at),
  -- Revocation is always recorded with its timestamp.
  CHECK (status <> 'revoked' OR revoked_at IS NOT NULL),
  CHECK (revoked_at IS NULL OR revoked_at >= issued_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS auth_sessions_token_fingerprint_idx
  ON auth_sessions (token_fingerprint);
CREATE UNIQUE INDEX IF NOT EXISTS auth_sessions_idempotency_key_idx
  ON auth_sessions (idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS auth_sessions_user_status_idx
  ON auth_sessions (user_id, status, expires_at DESC);
CREATE INDEX IF NOT EXISTS auth_sessions_rotation_family_idx
  ON auth_sessions (rotation_family_id);
CREATE INDEX IF NOT EXISTS auth_sessions_member_idx
  ON auth_sessions (member_id) WHERE member_id IS NOT NULL;
