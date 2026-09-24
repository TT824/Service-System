-- 0008_conversation_assignment (up)
-- ---------------------------------------------------------------------------
-- Conversation assignment: who is on duty, how a pooled conversation reaches
-- them, and the history of every attempt.
--
-- Three facts are added, and nothing else:
--
--   * `agent_presence` is one row per agent seat: its availability and the last
--     time it was heard from. **A missing row means offline**, which is the
--     whole reason this needs no reaper and no cleanup: a browser that crashes
--     never reports anything, so a seat has to be able to *lapse*. Liveness is
--     `heartbeat_at` read through a window, so it expires on its own — the
--     operator notices by absence, not by a write.
--
--     Availability is one column with four values rather than two orthogonal
--     booleans. `busy` and `away` are the agent's own "not right now" switches
--     while `offline` means not connected at all, and the difference matters:
--     a busy seat is still *live*, so it is a valid transfer target but not a
--     valid auto-assignment target. Splitting that into "connected" and
--     "receiving" would let a row express the impossible "disconnected but
--     receiving".
--
--     `store_id` is denormalised here so the dispatcher can filter candidates by
--     store without joining `members`. `members.store_id` remains the authority;
--     this column is a copy, and the two are written together.
--
--   * `conversation_assignments` is the history §7.3 asks for. The assignee
--     column on `conversations` can only answer "who is handling this now"; it
--     cannot answer "who lost the race for it", "why was it transferred", or
--     "when did it go back to the pool" — so a *failed* attempt is recorded as
--     deliberately as a successful one. That is what makes "the losing claimant
--     got a definite business error" a checkable fact rather than a log line.
--
--   * `conversations` gains the pool schedule and the two response clocks. See
--     the column comments for why `pending_since` and
--     `first_response_started_at` are both here and are not the same fact.
--
-- ## There is no assignment delay
--
-- The SDD-009 specification describes a hybrid: a shared pool agents grab from,
-- with auto-dispatch only after a 60-second window of nobody claiming. The
-- product owner replaced that with immediate automatic assignment on
-- 2026-09-14, so a conversation entering the pool is due *at once*.
--
-- That is why `next_assignment_at` still exists but has no window column beside
-- it: it records *whether* an entry is scheduled (and, for an operator reading
-- the row, since when), not how long to wait. There is deliberately no
-- `assignment_timeout_ms` column, because the number would always be zero. The
-- concurrency guarantee the specification cares about is unaffected: dispatch is
-- still a compare-and-swap on `version`, so concurrent attempts produce exactly
-- one winner.
--
-- ## Backfill
--
-- Existing `open` conversations predate the schedule, so the dispatcher would
-- not see them. They are backfilled with their own pool-entry instant, which for
-- an old conversation is in the past — meaning **they become due immediately**.
-- That is intentional: they are in the pool and always were. An operator who
-- does not want a backlog dispatched the moment the sweeper starts should raise
-- `next_assignment_at` before starting it.
--
-- Forward-only and additive: no existing column is dropped or changed, no column
-- is made NOT NULL, no row is deleted, and `0002`/`0006`/`0007` are not touched.
-- Every statement is guarded, so the file is also safe to re-run by hand.
--
-- Secret handling: no column here holds a credential or provider payload text.
-- A presence row is a status and a time; a history row is who, what, why and
-- when.
-- ---------------------------------------------------------------------------

-- Foreign keys -----------------------------------------------------------------
-- Both new tables reference `tenants`, `stores`, `members` and `conversations`
-- with the same simple, separately-named foreign keys migrations `0002` and
-- `0006` use. A composite `(tenant_id, store_id)` reference would be stronger,
-- but it would depend on `UNIQUE (tenant_id, id)` constraints on those tables —
-- constraints older migrations own and whose down files must stay free to drop.
-- Reverting an old migration must never require reverting a newer one, so tenant
-- and store isolation stays what `0002` already established: every row carries
-- `tenant_id`, and every statement the application issues is scoped by it.

-- Agent seats ------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS agent_presence (
  tenant_id    TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  member_id    TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  -- The agent's store, copied from `members.store_id` so the dispatcher can
  -- select candidates in one query. `members.store_id` stays authoritative.
  store_id     TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  -- One column, four values: the three states SDD-009 names (在线接单 / 忙碌 /
  -- 离开) plus the one a seat that is gone needs. Plain `TEXT` with a `CHECK`,
  -- not a PostgreSQL enum type, so widening the set is a code-and-data change
  -- rather than an `ALTER TYPE`.
  status       TEXT NOT NULL CHECK (status IN ('accepting', 'busy', 'away', 'offline')),
  -- Last time this seat was heard from, whatever its status. Never NULL: a row
  -- that exists has been heard from at least once. Liveness is this column read
  -- through a window, so a stalled heartbeat turns into `offline` on read with no
  -- writer involved.
  heartbeat_at TIMESTAMPTZ NOT NULL,
  -- When `status` last actually changed, which a repeat heartbeat must not move.
  -- Without this, "how long has this seat been away" would be unanswerable the
  -- moment a heartbeat arrives.
  changed_at   TIMESTAMPTZ NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL,
  -- One seat per member. The member is the identity of the seat, so a second row
  -- would be a second, contradictory answer to "is this agent available".
  PRIMARY KEY (tenant_id, member_id)
);

-- The dispatcher's candidate scan: one store's seats, filtered by status and
-- judged fresh by `heartbeat_at`. Ordered as the query orders them.
CREATE INDEX IF NOT EXISTS agent_presence_dispatch_idx
  ON agent_presence (tenant_id, store_id, status, heartbeat_at);

-- Assignment history -----------------------------------------------------------

CREATE TABLE IF NOT EXISTS conversation_assignments (
  id                   TEXT PRIMARY KEY,
  tenant_id            TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id             TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  -- `ON DELETE CASCADE` like `messages`: the history of a conversation is part
  -- of that conversation, and is meaningless without it.
  conversation_id      TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  action               TEXT NOT NULL CHECK (action IN ('claim', 'auto_assign', 'transfer', 'return', 'release')),
  result               TEXT NOT NULL CHECK (result IN ('success', 'rejected', 'expired')),
  -- Why it was refused or expired. Plain `TEXT` owned by the core module, like
  -- every other reason code in this schema: widening the set is a code change,
  -- not a migration.
  reason_code          TEXT,
  -- Who held it and who received it. `SET NULL` rather than `CASCADE`, because a
  -- history row must survive its participants: "agent 7 lost this race" stays
  -- true after agent 7 is deleted, and deleting a member must not silently erase
  -- the record of what they did.
  from_member_id       TEXT REFERENCES members(id) ON DELETE SET NULL,
  to_member_id         TEXT REFERENCES members(id) ON DELETE SET NULL,
  -- The version read before the attempt. Written while the conversation row is
  -- still locked by the same transaction, so it is exact rather than a guess.
  state_version_before INTEGER NOT NULL,
  -- The version afterwards, and `NULL` whenever nothing advanced it.
  --
  -- Three cases write `NULL`, and all three mean the same thing: the row was not
  -- changed by this attempt. A refusal (`rejected`) lost the compare-and-swap, so
  -- it never touched the row; an `expired` row records a fallback decision that
  -- deliberately leaves `version` alone, because no client echoes that column for
  -- a conversation handed the offline reply; and a `not_found` refusal had no row
  -- to read in the first place.
  --
  -- So the invariant this column carries is the useful one — non-`NULL` on a
  -- success and only on a success — which is exactly what the `CHECK` below
  -- enforces. It is deliberately *not* "always equals the conversation's version
  -- after this row", because a failure row's version lives on the conversation,
  -- not here.
  state_version_after  INTEGER,
  created_at           TIMESTAMPTZ NOT NULL,
  -- A refusal must say why it was refused.
  CONSTRAINT conversation_assignments_rejection_reason_check
    CHECK (result <> 'rejected' OR reason_code IS NOT NULL),
  -- A success must report the version it moved to, and it must have moved
  -- forward: claiming, auto-assigning, transferring, returning and closing all
  -- bump `version`, so an equal-after-success row would mean the write did not
  -- happen the way the row claims.
  CONSTRAINT conversation_assignments_success_version_check
    CHECK (result <> 'success' OR (state_version_after IS NOT NULL AND state_version_after > state_version_before))
);

-- One conversation's history, newest first — the order `GET
-- /conversations/:id/assignments` returns. `id` breaks ties within a
-- millisecond so paging is stable.
CREATE INDEX IF NOT EXISTS conversation_assignments_conversation_idx
  ON conversation_assignments (tenant_id, conversation_id, created_at DESC, id DESC);

-- "What has this agent been given", for an ops view and for auditing a seat that
-- keeps losing conversations.
CREATE INDEX IF NOT EXISTS conversation_assignments_member_idx
  ON conversation_assignments (tenant_id, to_member_id, created_at DESC);

-- Pool schedule and response clocks --------------------------------------------

-- Nullable additions only: every row `0002` wrote stays valid.
ALTER TABLE conversations
  -- When the conversation entered the pool for its *current* round. Restarts
  -- when an agent hands it back or a closed conversation reopens, so it answers
  -- "how long has the customer been waiting *this time*".
  ADD COLUMN IF NOT EXISTS pending_since             TIMESTAMPTZ,
  -- When the customer's *first* reply clock started: stamped the first time the
  -- conversation entered the pool and never cleared. Deliberately not
  -- `pending_since`, which restarts every round — the customer's wait did not
  -- restart because an agent changed their mind, so a first-response metric read
  -- from `pending_since` would report the latest round's wait and understate the
  -- customer's actual experience.
  ADD COLUMN IF NOT EXISTS first_response_started_at TIMESTAMPTZ,
  -- When the conversation is due for automatic assignment. A pooled conversation
  -- is due at the instant it enters, so this is set to the pool-entry instant and
  -- `NULL` means "not in the pool" — assigned, or closed. There is no delay, so
  -- there is no window to store alongside it (see the header).
  ADD COLUMN IF NOT EXISTS next_assignment_at        TIMESTAMPTZ,
  -- How many dispatch attempts this round has spent. **Observability only**: a
  -- failed attempt stays due, so the pool itself is the retry and there is no
  -- attempt budget to enforce. It exists so an operator can tell "nobody has been
  -- available for an hour" from "this row is stuck".
  ADD COLUMN IF NOT EXISTS dispatch_attempts         INTEGER NOT NULL DEFAULT 0,
  -- When the current assignee took the conversation.
  ADD COLUMN IF NOT EXISTS assigned_at               TIMESTAMPTZ,
  -- When the offline auto-reply went out. Doubles as the guard that makes that
  -- reply happen exactly once: it is written inside the dispatching transaction,
  -- so the instance that wins the write is the instance that sends.
  ADD COLUMN IF NOT EXISTS offline_reply_at          TIMESTAMPTZ,
  -- The first valid outbound of the current round, which is what closes the
  -- first-response clock. Reset by a reopen, because a new round has not been
  -- replied to yet.
  ADD COLUMN IF NOT EXISTS first_reply_at            TIMESTAMPTZ;

-- A due time on a conversation that is not in the pool would be a schedule for
-- something nobody can take. Guarded by a lookup because `ADD CONSTRAINT` has no
-- `IF NOT EXISTS` form.
--
-- True for every existing row by construction — `next_assignment_at` arrives
-- NULL and the backfill below only writes it to rows that satisfy this — so this
-- cannot fail on a populated database.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'conversations_assignment_schedule_check'
  ) THEN
    ALTER TABLE conversations ADD CONSTRAINT conversations_assignment_schedule_check
      CHECK (next_assignment_at IS NULL OR (status = 'open' AND assigned_member_id IS NULL));
  END IF;
END $$;

-- The dispatcher's due scan. Deliberately **not** prefixed by `tenant_id`: the
-- sweeper serves every tenant, and a leading tenant column would make the one
-- query it runs unindexable. Partial, so the index stays proportional to
-- outstanding work rather than to the whole conversation history.
CREATE INDEX IF NOT EXISTS conversations_dispatch_due_idx
  ON conversations (next_assignment_at, id)
  WHERE status = 'open' AND assigned_member_id IS NULL AND next_assignment_at IS NOT NULL;

-- The pool listing: one store's waiting conversations, oldest wait first.
CREATE INDEX IF NOT EXISTS conversations_pool_idx
  ON conversations (tenant_id, store_id, pending_since)
  WHERE status = 'open' AND assigned_member_id IS NULL;

-- The load count behind "进行中会话最少". Without it every selection would scan
-- the claimed conversations of every member.
CREATE INDEX IF NOT EXISTS conversations_assignee_idx
  ON conversations (tenant_id, assigned_member_id)
  WHERE status = 'claimed';

-- Backfill: give existing pooled conversations a schedule, or the dispatcher
-- cannot see them. The due instant is their own pool-entry instant — see the
-- header for why that means they become due at once.
UPDATE conversations
SET pending_since             = COALESCE(pending_since, last_message_at),
    first_response_started_at = COALESCE(first_response_started_at, opened_at),
    next_assignment_at        = COALESCE(pending_since, last_message_at)
WHERE status = 'open'
  AND assigned_member_id IS NULL
  AND next_assignment_at IS NULL;
