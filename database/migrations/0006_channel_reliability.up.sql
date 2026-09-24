-- 0006_channel_reliability (up)
-- ---------------------------------------------------------------------------
-- Provider-facing reliability trail for the channel message loop.
--
-- Migration 0002 already models the *business* history (conversations and
-- messages). What it does not model is what happened at the provider: which
-- callback was already handled, what became of each outbound message, which
-- status notifications arrived, how much reply budget a customer has left and
-- which deliveries are still queued.
--
-- These tables hold exactly that, and nothing else. Business content is still
-- written to `messages` through the platform repository, so there is one storage
-- model for history and this schema never duplicates it: a delivery *points at*
-- a message.
--
-- Two rules live in the schema rather than only in the application, because they
-- are what make a replay safe when two requests race:
--
--   * `inbound_events` is unique by `(tenant_id, channel, external_event_id)`.
--     A replayed provider callback therefore collides with the receipt the first
--     request wrote and resolves to the same business result.
--   * `message_deliveries` is unique by `(tenant_id, message_id)`. A logical
--     outbound message can have at most one delivery, so a retry appends an
--     attempt instead of producing a second delivery, and `channel_outbox` is
--     unique by the delivery it queues.
--
-- Every table carries `tenant_id` so the tenant boundary is enforced by the
-- application and can be indexed for tenant-scoped access.
-- ---------------------------------------------------------------------------

-- Callback receipts ---------------------------------------------------------

CREATE TABLE IF NOT EXISTS inbound_events (
  id                TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id          TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  channel           TEXT NOT NULL,
  external_event_id TEXT NOT NULL,
  -- Stable digest of the accepted payload, kept for diagnostics only.
  payload_hash      TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('received', 'processed', 'failed')),
  -- Set when the callback produced a message in the platform history.
  message_id        TEXT REFERENCES messages(id) ON DELETE SET NULL,
  failure_reason    TEXT,
  received_at       TIMESTAMPTZ NOT NULL,
  processed_at      TIMESTAMPTZ,
  UNIQUE (tenant_id, channel, external_event_id)
);

-- Outbound deliveries and their attempts -------------------------------------

CREATE TABLE IF NOT EXISTS message_deliveries (
  id                       TEXT PRIMARY KEY,
  tenant_id                TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id                 TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  conversation_id          TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_id               TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  channel                  TEXT NOT NULL,
  external_customer_id     TEXT NOT NULL,
  external_conversation_id TEXT NOT NULL,
  status                   TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'failed', 'unknown')),
  external_message_id      TEXT,
  attempt_count            INTEGER NOT NULL DEFAULT 0,
  failure_code             TEXT,
  failure_reason           TEXT,
  retryable                BOOLEAN NOT NULL DEFAULT FALSE,
  created_at               TIMESTAMPTZ NOT NULL,
  updated_at               TIMESTAMPTZ NOT NULL,
  -- One delivery per logical message: the rule a retry relies on.
  UNIQUE (tenant_id, message_id)
);

CREATE TABLE IF NOT EXISTS message_delivery_attempts (
  id                  TEXT PRIMARY KEY,
  tenant_id           TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  delivery_id         TEXT NOT NULL REFERENCES message_deliveries(id) ON DELETE CASCADE,
  attempt_number      INTEGER NOT NULL,
  status              TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'failed', 'unknown')),
  external_message_id TEXT,
  failure_code        TEXT,
  failure_reason      TEXT,
  retryable           BOOLEAN NOT NULL DEFAULT FALSE,
  attempted_at        TIMESTAMPTZ NOT NULL,
  UNIQUE (tenant_id, delivery_id, attempt_number)
);

-- Provider status notifications ----------------------------------------------

CREATE TABLE IF NOT EXISTS message_status_events (
  id                TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  delivery_id       TEXT NOT NULL REFERENCES message_deliveries(id) ON DELETE CASCADE,
  external_event_id TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'failed', 'unknown')),
  reason            TEXT,
  occurred_at       TIMESTAMPTZ NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL,
  -- Idempotency of a provider status notification is the event id it carries.
  UNIQUE (tenant_id, external_event_id)
);

-- Reply window budget ---------------------------------------------------------

CREATE TABLE IF NOT EXISTS send_quota_windows (
  id                   TEXT PRIMARY KEY,
  tenant_id            TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id             TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  channel              TEXT NOT NULL,
  external_customer_id TEXT NOT NULL,
  window_started_at    TIMESTAMPTZ NOT NULL,
  window_ends_at       TIMESTAMPTZ NOT NULL,
  message_limit        INTEGER NOT NULL,
  -- Logical messages already handed to the provider inside this window.
  reserved_count       INTEGER NOT NULL DEFAULT 0,
  updated_at           TIMESTAMPTZ NOT NULL,
  -- One window per customer per channel inside a store.
  UNIQUE (tenant_id, store_id, channel, external_customer_id)
);

-- Durable outbox --------------------------------------------------------------

CREATE TABLE IF NOT EXISTS channel_outbox (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id      TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  delivery_id   TEXT NOT NULL REFERENCES message_deliveries(id) ON DELETE CASCADE,
  message_id    TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  status        TEXT NOT NULL CHECK (status IN ('pending', 'dispatched', 'abandoned')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  available_at  TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL,
  -- One outbox entry per delivery, so a retry reuses the queued entry.
  UNIQUE (tenant_id, delivery_id)
);

-- Tenant-scoped access paths --------------------------------------------------

CREATE INDEX IF NOT EXISTS inbound_events_tenant_received_idx
  ON inbound_events (tenant_id, received_at);

CREATE INDEX IF NOT EXISTS message_deliveries_tenant_conversation_idx
  ON message_deliveries (tenant_id, conversation_id, created_at);

CREATE INDEX IF NOT EXISTS message_delivery_attempts_tenant_delivery_idx
  ON message_delivery_attempts (tenant_id, delivery_id, attempt_number);

CREATE INDEX IF NOT EXISTS message_status_events_tenant_delivery_idx
  ON message_status_events (tenant_id, delivery_id, occurred_at);

CREATE INDEX IF NOT EXISTS send_quota_windows_tenant_ends_idx
  ON send_quota_windows (tenant_id, window_ends_at);

CREATE INDEX IF NOT EXISTS channel_outbox_tenant_status_idx
  ON channel_outbox (tenant_id, status, available_at);
