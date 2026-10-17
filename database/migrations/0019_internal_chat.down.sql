-- Remove internal collaboration storage (see 0019_internal_chat.up.sql).
--
-- Messages go first: they reference the threads, so dropping the parent table
-- alone would either fail or cascade the children away depending on the engine's
-- mood. Ordering the two drops makes the rollback the same everywhere.

DROP TABLE IF EXISTS internal_messages;
DROP TABLE IF EXISTS internal_threads;
