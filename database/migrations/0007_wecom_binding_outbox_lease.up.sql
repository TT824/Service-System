-- 0007_wecom_binding_outbox_lease (up)
-- ---------------------------------------------------------------------------
-- Durable half of the WeCom customer-service loop: which platform scope a
-- provider account belongs to, where that account's `kf/sync_msg` pull stopped,
-- and the claim lease that lets a worker take an outbox entry without holding a
-- database transaction across a provider call.
--
-- Three facts are added, and nothing else:
--
--   * `wecom_channel_bindings` maps one provider account — the pair
--     `(corp_id, open_kfid)` — to one tenant and store. A provider callback
--     carries no platform session, so it can only write into the scope its
--     binding names. There is at most one *active* binding per account (partial
--     unique index below), while a disabled binding is kept rather than deleted:
--     the account stays rebindable and the scope that held it stays auditable.
--
--   * `wecom_sync_cursors` holds the single cursor of each binding, with a
--     bounded lease. The provider cursor belongs to the account, not to a
--     caller, so two concurrent callbacks cannot pull the same window twice; a
--     pull that dies leaves the cursor recoverable when its lease expires, and
--     the cursor only advances for the owner that still holds it
--     (compare-by-owner). The lease is what keeps a network round trip out of a
--     database transaction: the claim is one short write, and the pull happens
--     after it commits.
--
--   * `channel_outbox` gains a nullable lease and retry diagnostics, so a due
--     entry can be claimed atomically (`status = 'pending'`, `available_at`
--     reached, no live lease), recovered when a worker dies, dispatched, or
--     abandoned after a bounded number of attempts.
--
-- Forward-only and additive: no existing column is changed, no column is made
-- NOT NULL, no row is rewritten, and `0006` is not touched, so a database that
-- already holds queued deliveries keeps them and a fresh database reaches the
-- same shape by applying `0001` -> `0007` in order. Every statement is guarded,
-- so the file is also safe to re-run by hand; the runner additionally records
-- the version once and skips an already applied migration.
--
-- Secret handling: no column here holds a credential. A lease owner is an opaque
-- worker identity, a cursor is a provider paging token, and a failure reason is
-- a stable caller-authored explanation — never provider payload text, never an
-- access token, never a customer secret.
-- ---------------------------------------------------------------------------

-- Foreign keys -----------------------------------------------------------------
-- Provider-account bindings reference tenant and store with the same simple,
-- separately-named foreign keys migration `0006` uses. A composite
-- `(tenant_id, store_id)` reference would be stronger, but it would depend on
-- `UNIQUE (tenant_id, id)` on `stores` — a constraint migration `0003` owns and
-- whose down file must stay free to drop. Reverting an old migration must never
-- require reverting a newer one, so tenant/store isolation for the binding stays
-- what `0006` already established: every row carries `tenant_id`, and every
-- statement the application issues is scoped by it.
--
-- The cursor's reference is internal to this migration, so it *is* composite: it
-- proves a cursor belongs to the binding's tenant, and disappears with the
-- binding.

-- Provider account bindings ---------------------------------------------------

CREATE TABLE IF NOT EXISTS wecom_channel_bindings (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id    TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  -- Provider identity of the customer-service account. Not a secret: the pair
  -- is what a callback carries in the clear.
  corp_id     TEXT NOT NULL,
  open_kfid   TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at  TIMESTAMPTZ NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL,
  -- Set exactly when the binding is disabled, so "disabled" is an auditable
  -- fact with a time rather than an ambiguous state.
  disabled_at TIMESTAMPTZ,
  -- `(tenant_id, id)` is unique by construction; the named constraint is what
  -- the cursor's composite foreign key below points at.
  CONSTRAINT wecom_channel_bindings_tenant_id_key UNIQUE (tenant_id, id),
  CONSTRAINT wecom_channel_bindings_status_disabled_check
    CHECK ((status = 'disabled') = (disabled_at IS NOT NULL))
);

-- One *active* binding per provider account. A disabled binding is excluded, so
-- disabling an account and binding it to another tenant is a two-step move that
-- never leaves two candidates for the same callback; two disabled rows may
-- coexist because neither can resolve a callback.
CREATE UNIQUE INDEX IF NOT EXISTS wecom_channel_bindings_active_key
  ON wecom_channel_bindings (corp_id, open_kfid)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS wecom_channel_bindings_tenant_store_idx
  ON wecom_channel_bindings (tenant_id, store_id, status);

-- `kf/sync_msg` cursors --------------------------------------------------------

CREATE TABLE IF NOT EXISTS wecom_sync_cursors (
  id               TEXT PRIMARY KEY,
  tenant_id        TEXT NOT NULL,
  binding_id       TEXT NOT NULL,
  -- Provider cursor the next pull resumes from. NULL means no pull has
  -- succeeded yet, which is the position the provider's first pull starts from.
  -- It is kept distinct from an empty string so "never pulled" stays visible.
  cursor           TEXT,
  -- Bounded ownership of the pull. One owner at a time; an owner that dies
  -- leaves the cursor recoverable when the lease expires.
  lease_owner      TEXT,
  lease_expires_at TIMESTAMPTZ,
  last_synced_at   TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL,
  updated_at       TIMESTAMPTZ NOT NULL,
  -- Exactly one cursor per binding: the position belongs to the account, so a
  -- second concurrent callback has to contend for the lease instead of pulling
  -- the same window from the same cursor.
  CONSTRAINT wecom_sync_cursors_binding_id_key UNIQUE (binding_id),
  -- An expiry without an owner would describe a lease nobody can hold.
  CONSTRAINT wecom_sync_cursors_lease_pair_check
    CHECK (lease_expires_at IS NULL OR lease_owner IS NOT NULL),
  -- Composite so a cursor can never outlive its binding, can never name a
  -- binding inside another tenant, and disappears with the binding when a store
  -- or tenant is removed.
  CONSTRAINT wecom_sync_cursors_binding_fkey
    FOREIGN KEY (tenant_id, binding_id)
    REFERENCES wecom_channel_bindings (tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS wecom_sync_cursors_tenant_lease_idx
  ON wecom_sync_cursors (tenant_id, lease_expires_at);

-- Claimable outbox state -------------------------------------------------------

-- Nullable additions only: every row `0006` wrote stays valid and unclaimed.
ALTER TABLE channel_outbox
  ADD COLUMN IF NOT EXISTS lease_owner         TEXT,
  ADD COLUMN IF NOT EXISTS lease_expires_at    TIMESTAMPTZ,
  -- Retry diagnostics of the last failed dispatch attempt. Plain `TEXT` like
  -- every other failure code in `0006`; the durable adapters validate it against
  -- `DeliveryFailureCode` before it re-enters the typed domain.
  ADD COLUMN IF NOT EXISTS last_failure_code   TEXT,
  ADD COLUMN IF NOT EXISTS last_failure_reason TEXT;

-- The lease is meaningful only as a pair, on every table that carries one.
-- Guarded by a lookup because `ADD CONSTRAINT` has no `IF NOT EXISTS` form.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'channel_outbox_lease_pair_check'
  ) THEN
    ALTER TABLE channel_outbox ADD CONSTRAINT channel_outbox_lease_pair_check
      CHECK (lease_expires_at IS NULL OR lease_owner IS NOT NULL);
  END IF;
END $$;

-- The due-work claim path: the one scan a worker runs, ordered so the oldest due
-- entry is offered first. Partial, because a dispatched or abandoned entry is
-- never claimed again, which keeps the index proportional to outstanding work
-- rather than to the whole outbox history. `lease_expires_at` is in the key so
-- recovering an expired claim does not need a second path.
CREATE INDEX IF NOT EXISTS channel_outbox_due_idx
  ON channel_outbox (available_at, lease_expires_at)
  WHERE status = 'pending';
