-- 0022_conversation_routing_weights (down)
-- ---------------------------------------------------------------------------
-- Drops the 会话分流 table. With no rows to read, every seat weighs
-- `DEFAULT_ASSIGNMENT_WEIGHT` again — the behaviour every deployment had before
-- the migration — so a rollback loses the configured ratios but never strands a
-- conversation, and it leaves `agent_presence`, `conversation_assignments` and
-- the conversation tables exactly as `0008` left them.
-- ---------------------------------------------------------------------------

DROP TABLE IF EXISTS conversation_routing_weights;
