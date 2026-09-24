-- 0001_enable_vector_extension (up)
-- ---------------------------------------------------------------------------
-- Enable the extensions the platform relies on at the database level.
--
-- `vector` (pgvector) is the marker dependency of SDD-002: later tasks build
-- embedding-aware retrieval on top of it. No application tables are created
-- yet; that is SDD-003 work.
-- ---------------------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS vector;
