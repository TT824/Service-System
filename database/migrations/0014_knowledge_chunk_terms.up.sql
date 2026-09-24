-- 0014_knowledge_chunk_terms (up)
-- ---------------------------------------------------------------------------
-- Give the keyword leg something BM25 can count.
--
-- The keyword leg scored by substring: `content ILIKE '%卫衣%'` was worth one
-- point, an exact keyword hit two, and the points were summed. That scorer has
-- no term frequency, no inverse document frequency and no document length — a
-- slice that says 「卫衣」 once and one that says it three times scored the same,
-- and 「规格」, which is in almost every slice of this catalogue, weighed exactly
-- as much as 「冰雾粉」, which is in nine.
--
-- BM25 needs all three, and all three need *terms*. This table holds them: one
-- row per (slice, term), `tf` being how many times that term occurs in that
-- slice's text, exactly as `knowledge_chunk_keywords` holds one row per
-- (slice, extracted keyword).
--
-- **Why the terms are stored and not derived per question.** The tokenizer is a
-- pure function of the slice text, so it *can* run inside the scoring statement.
-- It was measured both ways on this database's 18,147 slices, and the difference
-- is the whole reason this table exists:
--
--   * tokenising inside the statement, filtering as it goes — 400 ms per
--     question, and the regex work is per character of the whole catalogue;
--   * reading pre-counted rows through `knowledge_chunk_terms_lookup_idx` —
--     97 ms, which is the same order as the semantic leg's full vector scan
--     (85 ms) and the reason the two legs stay comparable.
--
-- **There is no surrogate `id`, unlike `knowledge_chunk_keywords`.** The keyword
-- table has one because the Worker reconciles it by id — delete the rows whose
-- ids are gone, insert the ones that are new, and an unchanged keyword keeps its
-- `created_at`. A term has no history worth keeping: it is derived from the text
-- it indexes, so when the text changes the terms are simply replaced. The
-- composite key is the identity and nothing else is needed.
--
-- **The tokenizer is not here.** It lives in
-- `packages/core/src/platform/knowledge-tokenize.ts` and is called by the
-- Worker on the way in and by the API on the way out, so there is exactly one
-- answer to "what is a term". A second implementation in SQL, for the sake of
-- backfilling this table in this file, is the duplicate this repository spends
-- the most effort making unrepresentable. The existing 18,147 slices are
-- backfilled by `database/scripts/backfill-chunk-terms.cjs`, which imports the
-- same function the Worker does.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS knowledge_chunk_terms (
  tenant_id TEXT NOT NULL,
  chunk_id  TEXT NOT NULL,
  term      TEXT NOT NULL,
  tf        INTEGER NOT NULL CHECK (tf > 0),
  CONSTRAINT knowledge_chunk_terms_chunk_fk
    FOREIGN KEY (tenant_id, chunk_id)
    REFERENCES knowledge_chunks (tenant_id, id)
    ON DELETE CASCADE,
  CONSTRAINT knowledge_chunk_terms_pkey
    PRIMARY KEY (chunk_id, term)
);

-- "Which slices carry this term, and how often" — the scoring statement's only
-- lookup. `INCLUDE`d columns are the two the statement reads once it has found
-- the row, so the scan does not have to visit the heap.
CREATE INDEX IF NOT EXISTS knowledge_chunk_terms_lookup_idx
  ON knowledge_chunk_terms (tenant_id, term) INCLUDE (chunk_id, tf);
