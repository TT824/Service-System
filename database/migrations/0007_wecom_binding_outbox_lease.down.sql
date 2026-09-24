-- 0007_wecom_binding_outbox_lease (down)
-- ---------------------------------------------------------------------------
-- Revert the binding, cursor and outbox-lease additions in reverse dependency
-- order.
--
-- Nothing in `0006` is touched: `channel_outbox` keeps every row it had before
-- `0007`, and only the columns this migration added disappear with the claim
-- state they held. An entry that was claimed but not yet dispatched returns to
-- the plain `pending` state `0006` describes — claimable again rather than lost —
-- and its attempts stay on `message_delivery_attempts`, which `0006` owns.
--
-- `wecom_sync_cursors` is dropped before `wecom_channel_bindings` because it
-- references it; the indexes of both tables are dropped with them, so only the
-- index added to the `0006` table needs an explicit drop.
-- ---------------------------------------------------------------------------

DROP INDEX IF EXISTS channel_outbox_due_idx;

ALTER TABLE channel_outbox DROP CONSTRAINT IF EXISTS channel_outbox_lease_pair_check;

ALTER TABLE channel_outbox
  DROP COLUMN IF EXISTS last_failure_reason,
  DROP COLUMN IF EXISTS last_failure_code,
  DROP COLUMN IF EXISTS lease_expires_at,
  DROP COLUMN IF EXISTS lease_owner;

DROP TABLE IF EXISTS wecom_sync_cursors;
DROP TABLE IF EXISTS wecom_channel_bindings;
