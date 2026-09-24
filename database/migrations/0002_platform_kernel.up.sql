-- 0002_platform_kernel (up)
-- ---------------------------------------------------------------------------
-- Platform kernel data model: identity/tenants/stores/members, conversations
-- and messages, knowledge (product/FAQ/shortcut), retrieval/suggestions,
-- review (policy, queue, approved phrases), jobs, audit and retention.
--
-- The in-process store (packages/core) is the runnable stand-in behind the
-- same model; this migration describes the equivalent durable schema so a real
-- database can back the platform later. Every business table carries a
-- tenant_id so the tenant boundary can be enforced by the application and
-- indexed for tenant-scoped access.
-- ---------------------------------------------------------------------------

-- Identity and organization -------------------------------------------------

CREATE TABLE IF NOT EXISTS tenants (
  id            TEXT PRIMARY KEY,
  code          TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  enabled       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS stores (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code          TEXT NOT NULL,
  name          TEXT NOT NULL,
  enabled       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL,
  UNIQUE (tenant_id, code)
);

CREATE TABLE IF NOT EXISTS members (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT REFERENCES tenants(id) ON DELETE CASCADE,
  store_id      TEXT REFERENCES stores(id) ON DELETE SET NULL,
  role          TEXT NOT NULL CHECK (role IN ('platform_admin', 'merchant_admin', 'agent')),
  username      TEXT NOT NULL,
  display_name  TEXT NOT NULL,
  enabled       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL,
  -- A platform super administrator has no tenant; tenant admins/agents must.
  CHECK (role = 'platform_admin' OR tenant_id IS NOT NULL),
  CHECK (role <> 'agent' OR store_id IS NOT NULL)
);

-- Conversations and messages ------------------------------------------------

CREATE TABLE IF NOT EXISTS conversations (
  id                      TEXT PRIMARY KEY,
  tenant_id               TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id                TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  channel                 TEXT NOT NULL,
  external_customer_id    TEXT NOT NULL,
  external_conversation_id TEXT,
  title                   TEXT,
  status                  TEXT NOT NULL CHECK (status IN ('open', 'claimed', 'closed')),
  version                 INTEGER NOT NULL DEFAULT 1,
  assigned_member_id      TEXT REFERENCES members(id) ON DELETE SET NULL,
  opened_at               TIMESTAMPTZ NOT NULL,
  last_message_at         TIMESTAMPTZ NOT NULL,
  closed_at               TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS conversations_tenant_status_idx
  ON conversations (tenant_id, status, last_message_at DESC);
CREATE INDEX IF NOT EXISTS conversations_store_last_message_idx
  ON conversations (store_id, last_message_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id        TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  channel         TEXT NOT NULL,
  direction       TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  source          TEXT CHECK (source IN ('direct_candidate', 'edited_send', 'manual_typed', 'shortcut', 'faq_auto', 'other')),
  message_type    TEXT NOT NULL DEFAULT 'text' CHECK (message_type IN ('text', 'image', 'link')),
  content         TEXT NOT NULL,
  dedup_key       TEXT,
  review_eligible BOOLEAN NOT NULL DEFAULT FALSE,
  review_state    TEXT NOT NULL DEFAULT 'none' CHECK (review_state IN ('none', 'pending', 'approved', 'rejected')),
  candidate_id    TEXT,
  created_at      TIMESTAMPTZ NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS messages_dedup_key_idx
  ON messages (tenant_id, dedup_key) WHERE dedup_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS messages_conversation_created_idx
  ON messages (conversation_id, created_at);
CREATE INDEX IF NOT EXISTS messages_review_queue_idx
  ON messages (tenant_id, review_eligible, review_state) WHERE review_eligible;

-- Knowledge (product / FAQ / shortcut) --------------------------------------

CREATE TABLE IF NOT EXISTS products (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id      TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  sku           TEXT NOT NULL,
  title         TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  enabled       BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at    TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL,
  UNIQUE (tenant_id, store_id, sku)
);

CREATE TABLE IF NOT EXISTS faqs (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id      TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  question      TEXT NOT NULL,
  answer        TEXT NOT NULL,
  tags          TEXT[] NOT NULL DEFAULT '{}',
  enabled       BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at    TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS shortcuts (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id      TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  code          TEXT NOT NULL,
  title         TEXT NOT NULL,
  content       TEXT NOT NULL,
  enabled       BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at    TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL,
  UNIQUE (tenant_id, store_id, code)
);

-- Retrieval and suggestions -------------------------------------------------

CREATE TABLE IF NOT EXISTS suggestion_sets (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id        TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  provider        TEXT NOT NULL DEFAULT 'none' CHECK (provider IN ('none')),
  candidates      JSONB NOT NULL DEFAULT '[]',
  fallback_reasons JSONB NOT NULL DEFAULT '[]',
  created_at      TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS suggestion_sets_conversation_idx
  ON suggestion_sets (conversation_id, created_at);

-- Review ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS review_policy (
  id                          TEXT PRIMARY KEY,
  scope                       TEXT NOT NULL DEFAULT 'platform' CHECK (scope IN ('platform')),
  require_review              BOOLEAN NOT NULL DEFAULT TRUE,
  require_review_for_sources  TEXT[] NOT NULL DEFAULT '{}',
  updated_by                  TEXT,
  updated_at                  TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS approved_phrases (
  id               TEXT PRIMARY KEY,
  tenant_id        TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id         TEXT REFERENCES stores(id) ON DELETE CASCADE,
  phrase           TEXT NOT NULL,
  source_message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  approved_by      TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS approved_phrases_tenant_created_idx
  ON approved_phrases (tenant_id, created_at DESC);

-- Jobs, audit and retention ---------------------------------------------------

CREATE TABLE IF NOT EXISTS jobs (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT REFERENCES tenants(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed')),
  payload     JSONB NOT NULL DEFAULT '{}',
  result      JSONB,
  error       TEXT,
  created_at  TIMESTAMPTZ NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS jobs_status_created_idx
  ON jobs (status, created_at);

CREATE TABLE IF NOT EXISTS audit_log (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT REFERENCES tenants(id) ON DELETE CASCADE,
  actor_member_id TEXT REFERENCES members(id) ON DELETE SET NULL,
  action          TEXT NOT NULL,
  target_type     TEXT NOT NULL,
  target_id       TEXT,
  metadata        JSONB NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS audit_log_tenant_created_idx
  ON audit_log (tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS retention_policies (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT REFERENCES tenants(id) ON DELETE CASCADE,
  entity          TEXT NOT NULL CHECK (entity IN ('message', 'conversation', 'audit_log', 'approved_phrase')),
  retention_days  INTEGER NOT NULL CHECK (retention_days > 0),
  created_at      TIMESTAMPTZ NOT NULL,
  UNIQUE (tenant_id, entity)
);
