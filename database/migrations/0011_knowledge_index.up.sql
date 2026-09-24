-- 0011_knowledge_index (up)
-- ---------------------------------------------------------------------------
-- The retrieval index layer for SDD-013. Three new tables, no renames, no
-- drops, and nothing that touches a table that already exists.
--
--   * `knowledge_chunks` is one slice of one source field, plus the provenance
--     needed to walk back to where it came from. `source_kind` + `source_id` +
--     `source_field` + `chunk_index` is the full address: which kind of thing,
--     which row, which field of it, and which slice of that field. The
--     uniqueness constraint on exactly that tuple is what makes indexing
--     idempotent — running the indexer twice over one FAQ must update the same
--     chunks rather than accumulate a second copy of them.
--
--     `scope_type` + a nullable `store_id` mirror `shortcuts` from `0010`,
--     because knowledge inherits the scope of the thing it came from: a FAQ
--     belongs to a store, but a merchant-level shortcut belongs to the whole
--     tenant. Making `store_id` `NOT NULL` would have forced the alternative —
--     one copy of a tenant-level phrase per store — which goes stale the moment
--     a store is added. The CHECK keeps the two columns from disagreeing.
--
--     `enabled` is a *copy* of the source row's usability, refreshed by the
--     indexer, and it exists for one reason: the retrieval read has to apply
--     the usability rule but cannot join to the source, because the sources are
--     three different tables with three different shapes. The rule itself still
--     lives in one place (`usableKnowledge` in `packages/core`); the indexer
--     calls it and writes down the answer. A chunk whose source was switched off
--     after indexing is corrected on the next index pass, not by a second rule.
--
--     `content_hash` is what lets a reindex skip what did not change, and what
--     lets an embedding be recognised as stale when the text underneath it moved.
--
--   * `knowledge_chunk_keywords` holds the extracted 品牌 / 品类 / 型号 / 颜色 /
--     尺码 / 材质 / 功效 terms as rows rather than one text blob, for the same
--     reason `faq_question_variants` is a row set: each term has its own kind, so
--     "which chunks are 黑色" is a query rather than a parse.
--
--   * `knowledge_chunk_embeddings` carries one row per (chunk, model). The
--     vector column deliberately has **no declared dimension**.
--
--     This is the part worth reading carefully. A `vector(1536)` column would
--     bake today's model into the schema, and the design is explicit that the
--     model may change (SDD-013 acceptance: "变更 Embedding 模型时能识别旧向量
--     并触发重建策略"). An unconstrained `vector` column accepts any dimension and
--     stores it per row, so a new model writes new rows next to the old ones
--     instead of forcing a column type change. Identifying what needs rebuilding
--     is then one LEFT JOIN:
--
--       SELECT c.id FROM knowledge_chunks c
--       LEFT JOIN knowledge_chunk_embeddings e
--         ON e.tenant_id = c.tenant_id AND e.chunk_id = c.id
--        AND e.embedding_model = $1
--       WHERE e.id IS NULL;
--
--     The price of that choice is that **no ANN index can be created yet**.
--     Verified against this database: `CREATE INDEX ... USING hnsw (embedding
--     vector_cosine_ops)` on a dimension-less column fails with "column does not
--     have dimensions". That is acceptable while no embedding provider is
--     configured — there are no vectors to search — and the index is a later,
--     additive migration once a model and its dimension are chosen. At that
--     point it must be built as an *expression* index naming the dimension:
--
--       CREATE INDEX ... ON knowledge_chunk_embeddings
--         USING hnsw ((embedding::vector(1536)) vector_cosine_ops);
--
--     so that the base column stays dimension-agnostic.
--
--     `content_hash` on this row is the hash of the text that was actually
--     embedded, so a vector whose chunk text has since changed is detectable
--     without re-embedding anything.
--
-- **Why `pg_trgm` and not `to_tsvector`.** SDD-013 asks for PostgreSQL full-text
-- search. Measured on this database (pgvector/pgvector:pg16), the built-in
-- parser does not segment Chinese and no Chinese parser is available —
-- `pg_available_extensions` offers `vector`, `pg_trgm`, `unaccent`, `btree_gin`
-- and no `zhparser` / `pg_jieba` / `pgroonga`:
--
--   to_tsvector('simple', '加绒卫衣加厚保暖不起球')  ->  '加绒卫衣加厚保暖不起球':1
--
-- i.e. the whole sentence becomes one token. Even when the text is pre-split on
-- spaces, FTS matches tokens and not substrings, so a buyer's 卫衣 does not find
-- the token 加绒卫衣:
--
--   to_tsvector('simple','安踏 加绒卫衣 男款') @@ plainto_tsquery('simple','卫衣') -> false
--
-- Merchants write descriptions and answers without spaces, so a literal
-- `to_tsvector` index here would be one that can never match. `pg_trgm` indexes
-- character trigrams, which for CJK means the codepoints themselves, and it was
-- measured working: `content LIKE '%卫衣%'` returns the 加绒卫衣 row and not the
-- unrelated one. The recall path is therefore trigram substring plus pgvector
-- semantics; `%` (the similarity operator) is deliberately not relied on for
-- short queries, because a two-character query has no three-character trigram
-- and `'加绒卫衣加厚' % '卫衣'` measured false.
--
-- `pg_trgm` is enabled here for the same reason `0001` enabled `vector`: an
-- extension the schema depends on is turned on by the migration that first needs
-- it, so a fresh database reaches the same state as a migrated one.
--
-- Enum columns are `CHECK (col IN (...))`, not PostgreSQL enum types, and the
-- table creations are `IF NOT EXISTS`, as in every migration before this one.
-- ---------------------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Knowledge chunks -------------------------------------------------------------

CREATE TABLE IF NOT EXISTS knowledge_chunks (
  id             TEXT PRIMARY KEY,
  tenant_id      TEXT NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  store_id       TEXT REFERENCES stores (id) ON DELETE CASCADE,
  scope_type     TEXT NOT NULL CHECK (scope_type IN ('tenant', 'store')),
  source_kind    TEXT NOT NULL
    CHECK (source_kind IN ('faq', 'faq_variant', 'shortcut', 'product', 'product_sku')),
  source_id      TEXT NOT NULL,
  source_field   TEXT NOT NULL,
  chunk_type     TEXT NOT NULL
    CHECK (chunk_type IN (
      'title', 'selling_point', 'spec', 'usage', 'after_sale',
      'question', 'answer', 'content', 'price', 'stock'
    )),
  chunk_index    INTEGER NOT NULL CHECK (chunk_index >= 0),
  content        TEXT NOT NULL,
  -- The neighbour slices kept for context. Bounded by the chunker, never the
  -- whole field: the point is to let one slice be read in the company it was
  -- written in, without re-importing the document it was cut from.
  context_before TEXT,
  context_after  TEXT,
  char_count     INTEGER NOT NULL CHECK (char_count > 0),
  enabled        BOOLEAN NOT NULL DEFAULT TRUE,
  content_hash   TEXT NOT NULL,
  index_status   TEXT NOT NULL DEFAULT 'pending'
    CHECK (index_status IN ('pending', 'indexed', 'failed', 'skipped')),
  index_attempts INTEGER NOT NULL DEFAULT 0 CHECK (index_attempts >= 0),
  index_error    TEXT,
  indexed_at     TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL,
  updated_at     TIMESTAMPTZ NOT NULL,
  -- The same discipline as `shortcuts_scope_check` in 0010: a tenant-level chunk
  -- with a store, or a store-level chunk without one, is not representable.
  CONSTRAINT knowledge_chunks_scope_check CHECK (
    (scope_type = 'tenant' AND store_id IS NULL)
    OR (scope_type = 'store' AND store_id IS NOT NULL)
  ),
  -- The composite key the keyword and embedding tables point at, so their
  -- foreign keys cannot cross a tenant boundary.
  CONSTRAINT knowledge_chunks_scope_unique UNIQUE (tenant_id, id),
  -- The address of one slice. A reindex updates these rows in place.
  CONSTRAINT knowledge_chunks_slice_unique
    UNIQUE (tenant_id, source_kind, source_id, source_field, chunk_index)
);

-- The retrieval read: this tenant's usable chunks, optionally one store's.
CREATE INDEX IF NOT EXISTS knowledge_chunks_retrieval_idx
  ON knowledge_chunks (tenant_id, store_id, enabled, id);

-- Provenance and reindex: every chunk of one source row.
CREATE INDEX IF NOT EXISTS knowledge_chunks_source_idx
  ON knowledge_chunks (tenant_id, source_kind, source_id, chunk_index);

-- The retry sweep and the index status query.
CREATE INDEX IF NOT EXISTS knowledge_chunks_status_idx
  ON knowledge_chunks (tenant_id, index_status, updated_at);

-- The recall path. `gin_trgm_ops` is what makes `content LIKE '%词%'` an index
-- scan; without it the query is correct but sequential.
CREATE INDEX IF NOT EXISTS knowledge_chunks_content_trgm_idx
  ON knowledge_chunks USING gin (content gin_trgm_ops);

-- Extracted keywords -----------------------------------------------------------

CREATE TABLE IF NOT EXISTS knowledge_chunk_keywords (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL,
  chunk_id     TEXT NOT NULL,
  keyword_kind TEXT NOT NULL
    CHECK (keyword_kind IN (
      'brand', 'category', 'model', 'color', 'size', 'material', 'effect', 'other'
    )),
  keyword_text TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL,
  CONSTRAINT knowledge_chunk_keywords_chunk_fk
    FOREIGN KEY (tenant_id, chunk_id)
    REFERENCES knowledge_chunks (tenant_id, id)
    ON DELETE CASCADE,
  CONSTRAINT knowledge_chunk_keywords_unique
    UNIQUE (tenant_id, chunk_id, keyword_kind, keyword_text)
);

CREATE INDEX IF NOT EXISTS knowledge_chunk_keywords_chunk_idx
  ON knowledge_chunk_keywords (tenant_id, chunk_id, keyword_kind);

-- "Which chunks are 黑色" — the structured half of the recall path.
CREATE INDEX IF NOT EXISTS knowledge_chunk_keywords_lookup_idx
  ON knowledge_chunk_keywords (tenant_id, keyword_kind, keyword_text);

CREATE INDEX IF NOT EXISTS knowledge_chunk_keywords_text_trgm_idx
  ON knowledge_chunk_keywords USING gin (keyword_text gin_trgm_ops);

-- Chunk embeddings -------------------------------------------------------------

CREATE TABLE IF NOT EXISTS knowledge_chunk_embeddings (
  id                   TEXT PRIMARY KEY,
  tenant_id            TEXT NOT NULL,
  chunk_id             TEXT NOT NULL,
  embedding_model      TEXT NOT NULL,
  embedding_dimensions INTEGER NOT NULL CHECK (embedding_dimensions > 0),
  -- No declared dimension, on purpose: see the header. The ANN index is a later
  -- additive migration and must be an expression index naming its dimension.
  embedding            vector NOT NULL,
  -- The hash of the text that was embedded, so a vector is detectable as stale
  -- when the chunk's content changes underneath it.
  content_hash         TEXT NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL,
  CONSTRAINT knowledge_chunk_embeddings_chunk_fk
    FOREIGN KEY (tenant_id, chunk_id)
    REFERENCES knowledge_chunks (tenant_id, id)
    ON DELETE CASCADE,
  CONSTRAINT knowledge_chunk_embeddings_unique
    UNIQUE (tenant_id, chunk_id, embedding_model)
);

-- The rebuild question: which chunks have no vector for the model in use.
CREATE INDEX IF NOT EXISTS knowledge_chunk_embeddings_model_idx
  ON knowledge_chunk_embeddings (tenant_id, embedding_model, chunk_id);
