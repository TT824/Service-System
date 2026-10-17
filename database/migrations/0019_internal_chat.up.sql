-- Internal collaboration: colleague-to-colleague messages inside one tenant.
--
-- Deliberately not a row in `conversations`. That table means "a customer is
-- being served": it carries a channel, a customer identity, a serving store and
-- the 48-hour reply window, and it feeds the workspace queue, the response-time
-- metrics and the customer-record export. A message between two colleagues has
-- none of those properties, so it gets its own two tables and touches none of
-- those surfaces.

CREATE TABLE IF NOT EXISTS internal_threads (
  id                TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind              TEXT NOT NULL CHECK (kind IN ('direct')),
  -- The two participants, stored ascending. The ordering is a constraint rather
  -- than a convention so that (A,B) and (B,A) cannot become two rows holding
  -- half a conversation each; the deterministic id is built from the same
  -- ascending pair.
  participant_a     TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  participant_b     TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  created_at        TIMESTAMPTZ NOT NULL,
  last_message_at   TIMESTAMPTZ NOT NULL,
  CHECK (participant_a < participant_b)
);

-- Reading "my threads, newest first" is the only list query there is.
CREATE INDEX IF NOT EXISTS internal_threads_tenant_participant_a_idx
  ON internal_threads (tenant_id, participant_a, last_message_at DESC);
CREATE INDEX IF NOT EXISTS internal_threads_tenant_participant_b_idx
  ON internal_threads (tenant_id, participant_b, last_message_at DESC);

CREATE TABLE IF NOT EXISTS internal_messages (
  id                TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  thread_id         TEXT NOT NULL REFERENCES internal_threads(id) ON DELETE CASCADE,
  sender_member_id  TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  body              TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS internal_messages_thread_idx
  ON internal_messages (thread_id, created_at);
