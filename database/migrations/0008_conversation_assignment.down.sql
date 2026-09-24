-- 0008_conversation_assignment (down)
-- ---------------------------------------------------------------------------
-- Revert the presence, assignment-history and pool-schedule additions in reverse
-- dependency order.
--
-- Nothing in `0002` is touched: `conversations` keeps every row it had before
-- `0008`, and only the columns this migration added disappear with the schedule
-- they held. A conversation that was waiting in the pool goes back to being an
-- ordinary `open` row — the state `0002` describes — and the messages that were
-- exchanged stay on `messages`, which `0002` owns.
--
-- The three indexes on `conversations` are dropped explicitly because the table
-- outlives them. The two new tables are dropped in dependency order with their
-- own indexes, which disappear with them: `conversation_assignments` references
-- `conversations`, and `agent_presence` references `tenants`, `stores` and
-- `members`, so both must go before anything they point at could.
--
-- The backfill is not reversed. `pending_since`, `first_response_started_at` and
-- `next_assignment_at` are dropped columns, so there is no value left to restore
-- and `0002` has no column they could have overwritten. A `last_message_at` or
-- `opened_at` this migration read is untouched.
-- ---------------------------------------------------------------------------

-- Pool schedule on an existing table -------------------------------------------

DROP INDEX IF EXISTS conversations_dispatch_due_idx;
DROP INDEX IF EXISTS conversations_pool_idx;
DROP INDEX IF EXISTS conversations_assignee_idx;

ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_assignment_schedule_check;

ALTER TABLE conversations
  DROP COLUMN IF EXISTS first_reply_at,
  DROP COLUMN IF EXISTS offline_reply_at,
  DROP COLUMN IF EXISTS assigned_at,
  DROP COLUMN IF EXISTS dispatch_attempts,
  DROP COLUMN IF EXISTS next_assignment_at,
  DROP COLUMN IF EXISTS first_response_started_at,
  DROP COLUMN IF EXISTS pending_since;

-- New tables -------------------------------------------------------------------

DROP TABLE IF EXISTS conversation_assignments;
DROP TABLE IF EXISTS agent_presence;
