-- 0014_knowledge_chunk_terms (down)
-- ---------------------------------------------------------------------------
-- The index goes before the table it indexes, so the drop cannot depend on the
-- implicit order, and the table goes before nothing — `knowledge_chunks` is not
-- this migration's to drop, and the foreign key leaves with the table.
--
-- The rows are derived data: dropping them loses nothing that
-- `database/scripts/backfill-chunk-terms.cjs` cannot rebuild from the slices
-- that are still there. That is what makes this a safe rollback rather than a
-- destructive one, and it is the property the keyword leg's exact half does not
-- have — the keywords are merchant knowledge and have to be re-extracted.
-- ---------------------------------------------------------------------------

DROP INDEX IF EXISTS knowledge_chunk_terms_lookup_idx;

DROP TABLE IF EXISTS knowledge_chunk_terms;
