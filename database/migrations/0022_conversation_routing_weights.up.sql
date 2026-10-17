-- 0022_conversation_routing_weights (up)
-- ---------------------------------------------------------------------------
-- 会话分流: how much of the automatic assignment each seat takes.
--
-- One fact is added, and nothing else:
--
--   * `conversation_routing_weights` is one row per seat an administrator has
--     given a weight to. The weight is a **relative share, not a percentage** —
--     what decides is the ratio between seats, so `60 / 40` and `6 / 4` are the
--     same policy and the numbers never have to add up to anything. The table
--     therefore stores the number the console sent and never normalises it.
--
-- ## A missing row means the default, not zero
--
-- The dispatcher reads a weight through the same candidate query that reads
-- `agent_presence` (`readCandidates` in
-- `apps/api/src/platform/postgres-platform.repository.ts`), so a seat with no row
-- here weighs 1 — which is exactly the behaviour every deployment had before this
-- migration. That is why the table is created empty and why it *stays* empty
-- until somebody deliberately changes a seat: being migrated must not change how
-- a deployment routes conversations.
--
-- `weight = 0` is therefore a deliberate exclusion from automatic assignment, and
-- is stored explicitly. A zero-weight seat is still a valid **manual transfer
-- target** — the assignment rule keeps "may this seat be given work at all" and
-- "should the dispatcher pick it" apart, in `selectAutoAssignee`
-- (`packages/core/src/platform/assignment.ts`).
--
-- ## Why not a column on `agent_presence`
--
-- A weight is deployment policy with an author and a decided-at instant; presence
-- is a seat's own heartbeat. Different writers, different lifetimes, different
-- reasons to change — and putting the weight beside `heartbeat_at` would mean
-- every heartbeat rewrote policy data.
--
-- ## Why an audit column and no history table
--
-- `updated_at` / `updated_by` answer "who set this, when", which is what the
-- settings surface shows. A full history of every past ratio would be a second
-- ledger nobody reads; the platform's own `audit_log` gets a row per save
-- instead, written by the service that authorised it.
--
-- Forward-only and additive: no existing table, column or row is touched. Every
-- statement is guarded, so the file is also safe to re-run by hand.
--
-- Secret handling: a weight is a small integer and a record of who set it. No
-- column here holds a credential or a provider payload text.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS conversation_routing_weights (
  tenant_id  TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  member_id  TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  -- Shares, not percent. Plain INTEGER with a lower bound only; the upper bound
  -- (`ASSIGNMENT_WEIGHT_MAX`) is the application's, so raising it is a code
  -- change rather than a migration.
  weight     INTEGER NOT NULL CHECK (weight >= 0),
  updated_at TIMESTAMPTZ NOT NULL,
  -- Who last set it. `SET NULL` rather than `CASCADE`, like the assignment
  -- history: the weight outlives the administrator who chose it, and deleting a
  -- member must not silently change the policy for everyone else.
  updated_by TEXT REFERENCES members(id) ON DELETE SET NULL,
  -- One row per seat, which is also the key the dispatcher's candidate query
  -- joins on — so no separate index is needed for either reader.
  PRIMARY KEY (tenant_id, member_id)
);
