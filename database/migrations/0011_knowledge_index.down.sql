-- 0011_knowledge_index (down)
-- ---------------------------------------------------------------------------
-- Undo everything `0011` did, and nothing else.
--
-- The three tables drop in foreign-key order: `knowledge_chunk_keywords` and
-- `knowledge_chunk_embeddings` both reference `knowledge_chunks`, which
-- references `tenants` and `stores` — and neither of those is touched. Their
-- own indexes go with them, including the two trigram indexes.
--
-- `pg_trgm` is dropped last, for the reason `0001` documents about `vector`:
-- the drop fails while a column still depends on the extension, which is the
-- guard rail that catches a down migration running out of order.
--
-- Unlike `0010`'s down, this one loses no data that predates the migration. The
-- index tables are derived state — every row in them can be rebuilt by running
-- the indexer again over sources that are not touched here — so the reverse is
-- lossless in the sense that matters: no source row is deleted to make the
-- rollback possible.
-- ---------------------------------------------------------------------------

DROP TABLE IF EXISTS knowledge_chunk_embeddings;
DROP TABLE IF EXISTS knowledge_chunk_keywords;
DROP TABLE IF EXISTS knowledge_chunks;

DROP EXTENSION IF EXISTS pg_trgm;
