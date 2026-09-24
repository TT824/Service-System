-- 0001_enable_vector_extension (down)
-- ---------------------------------------------------------------------------
-- Remove the extension again. Dropping an extension fails if a column still
-- depends on it, which is the desired guard rail for an early marker
-- migration: revert this migration only while no vector columns exist.
-- ---------------------------------------------------------------------------

DROP EXTENSION IF EXISTS vector;
