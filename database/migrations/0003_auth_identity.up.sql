-- 0003_auth_identity (up)
-- ---------------------------------------------------------------------------
-- Durable identity foundation for authentication: user accounts, external
-- identities, the member <-> user linkage, and per-member store scopes.
--
-- Forward-only: this migration only adds objects. It never rewrites 0001 or
-- 0002, so an existing database migrates in place and a fresh database reaches
-- the same shape by applying 0001 -> 0002 -> 0003 in order.
--
-- Scope: schema only. The MVP keeps running on the in-process store
-- (packages/core); these tables are the durable equivalent that later
-- authentication work reads and writes.
--
-- Secret handling: credential material is stored as a hash only. Raw
-- passwords, bearer tokens, device credentials and OTP codes never reach the
-- database, and no column here is meant to hold them.
-- ---------------------------------------------------------------------------

-- Foreign-key targets ---------------------------------------------------------
-- `stores.id` and `members.id` are already primary keys, so (tenant_id, id) is
-- unique by construction. The constraints add no new uniqueness; they exist so
-- tenant-scoped child tables can reference store/member rows *within a tenant*
-- with a composite foreign key instead of only checking the row id.

-- Guarded so the file stays safe to re-run by hand, matching the
-- `IF NOT EXISTS` style of 0001/0002; the migration runner additionally
-- records the version and skips an already applied migration.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'stores_tenant_id_id_key'
  ) THEN
    ALTER TABLE stores ADD CONSTRAINT stores_tenant_id_id_key UNIQUE (tenant_id, id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'members_tenant_id_id_key'
  ) THEN
    ALTER TABLE members ADD CONSTRAINT members_tenant_id_id_key UNIQUE (tenant_id, id);
  END IF;
END $$;

-- User accounts ----------------------------------------------------------------

CREATE TABLE IF NOT EXISTS user_accounts (
  id                 TEXT PRIMARY KEY,
  username           TEXT NOT NULL,
  display_name       TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'active'
                       CHECK (status IN ('pending', 'active', 'locked', 'disabled')),
  -- Encoded password hash. NULL means the account has no password credential
  -- yet (for example an account that only signs in through an external
  -- identity); the column never stores a raw password.
  password_hash      TEXT,
  password_updated_at TIMESTAMPTZ,
  failed_login_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_login_count >= 0),
  locked_until       TIMESTAMPTZ,
  last_login_at      TIMESTAMPTZ,
  -- Caller-supplied key that makes account provisioning retry-safe.
  idempotency_key    TEXT,
  created_at         TIMESTAMPTZ NOT NULL,
  updated_at         TIMESTAMPTZ NOT NULL,
  -- Sign-in compares usernames case-insensitively, so blank values are invalid.
  CHECK (length(btrim(username)) > 0),
  CHECK (length(btrim(display_name)) > 0),
  -- Guard rail: a stored credential is an encoded hash, never a short raw
  -- password. Fine-grained format checks belong to the hashing component.
  CHECK (password_hash IS NULL OR length(password_hash) >= 32),
  -- Audit timestamps cannot move backwards.
  CHECK (updated_at >= created_at),
  -- A locked account records until when it stays locked.
  CHECK (status <> 'locked' OR locked_until IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS user_accounts_username_lower_idx
  ON user_accounts (lower(username));
CREATE INDEX IF NOT EXISTS user_accounts_status_idx
  ON user_accounts (status);
CREATE UNIQUE INDEX IF NOT EXISTS user_accounts_idempotency_key_idx
  ON user_accounts (idempotency_key) WHERE idempotency_key IS NOT NULL;

-- User identities ---------------------------------------------------------------
-- One row per external identity a user can sign in with. `subject` is the
-- provider-scoped identifier (a phone number for `phone`, the `sub` claim for
-- `oidc`, a WeCom user id for `wecom`, the username for `password`); it is an
-- identifier, never a secret.

CREATE TABLE IF NOT EXISTS user_identities (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES user_accounts(id) ON DELETE CASCADE,
  provider    TEXT NOT NULL CHECK (provider IN ('password', 'phone', 'wecom', 'oidc')),
  subject     TEXT NOT NULL,
  verified    BOOLEAN NOT NULL DEFAULT FALSE,
  verified_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL,
  CHECK (length(btrim(subject)) > 0),
  CHECK (updated_at >= created_at),
  -- `verified` and `verified_at` are the same fact; they cannot disagree.
  CHECK (verified = (verified_at IS NOT NULL)),
  -- A phone identity may only exist once the number was actually verified.
  CHECK (provider <> 'phone' OR verified)
);

-- Subjects are compared case-insensitively (phone/OIDC/WeCom ids are not
-- case-sensitive identifiers), so the uniqueness rule folds case.
CREATE UNIQUE INDEX IF NOT EXISTS user_identities_provider_subject_idx
  ON user_identities (provider, lower(subject));
CREATE INDEX IF NOT EXISTS user_identities_user_id_idx
  ON user_identities (user_id);

-- Member <-> user linkage -------------------------------------------------------
-- A member (the tenant-scoped platform actor) is bound to a user account. A
-- member has at most one active link; a user may act through several members.

CREATE TABLE IF NOT EXISTS member_user_links (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES user_accounts(id) ON DELETE CASCADE,
  tenant_id  TEXT REFERENCES tenants(id) ON DELETE CASCADE,
  member_id  TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  linked_by  TEXT,
  linked_at  TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CHECK (updated_at >= created_at),
  CHECK (revoked_at IS NULL OR revoked_at >= linked_at),
  -- When the link names a tenant, the member must belong to that same tenant.
  -- A platform member has a NULL tenant, and a composite foreign key with a
  -- NULL component is not enforced (MATCH SIMPLE), which is the intended
  -- behaviour: the member_id foreign key above still proves the row exists.
  FOREIGN KEY (tenant_id, member_id) REFERENCES members (tenant_id, id)
    ON DELETE CASCADE
);

-- At most one active link per member; revoked links stay for the audit trail.
CREATE UNIQUE INDEX IF NOT EXISTS member_user_links_member_active_idx
  ON member_user_links (member_id) WHERE revoked_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS member_user_links_user_member_idx
  ON member_user_links (user_id, member_id);
CREATE INDEX IF NOT EXISTS member_user_links_user_idx
  ON member_user_links (user_id);

-- Member store scopes -----------------------------------------------------------
-- The stores a member may operate on. The primary key plus the two composite
-- foreign keys make tenant/member/store integrity structural: a scope row can
-- only name a member *and* a store that both belong to its tenant.

CREATE TABLE IF NOT EXISTS member_store_scopes (
  tenant_id  TEXT NOT NULL,
  member_id  TEXT NOT NULL,
  store_id   TEXT NOT NULL,
  is_primary BOOLEAN NOT NULL DEFAULT FALSE,
  granted_by TEXT,
  granted_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, member_id, store_id),
  CHECK (updated_at >= created_at),
  CHECK (revoked_at IS NULL OR revoked_at >= granted_at),
  FOREIGN KEY (tenant_id, member_id) REFERENCES members (tenant_id, id)
    ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, store_id) REFERENCES stores (tenant_id, id)
    ON DELETE CASCADE
);

-- At most one primary store per member, and only among active scopes.
CREATE UNIQUE INDEX IF NOT EXISTS member_store_scopes_primary_idx
  ON member_store_scopes (tenant_id, member_id) WHERE is_primary AND revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS member_store_scopes_store_idx
  ON member_store_scopes (tenant_id, store_id);
