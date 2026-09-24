-- 0006_channel_reliability (down)
-- ---------------------------------------------------------------------------
-- Drop the channel reliability trail in reverse dependency order.
--
-- Nothing in migration `0002` is touched: the business history in
-- `conversations` and `messages` survives this revert untouched, and only the
-- provider-facing rows disappear with it. The indexes are dropped with their
-- tables, so no separate index cleanup is needed.
-- ---------------------------------------------------------------------------

DROP TABLE IF EXISTS channel_outbox;
DROP TABLE IF EXISTS send_quota_windows;
DROP TABLE IF EXISTS message_status_events;
DROP TABLE IF EXISTS message_delivery_attempts;
DROP TABLE IF EXISTS message_deliveries;
DROP TABLE IF EXISTS inbound_events;
