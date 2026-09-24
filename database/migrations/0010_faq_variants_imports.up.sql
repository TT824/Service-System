-- 0010_faq_variants_imports (up)
-- ---------------------------------------------------------------------------
-- Three facts that finish the knowledge model, and one widening of a table that
-- already exists. Nothing is renamed and nothing is dropped.
--
--   * `faq_question_variants` holds the ways buyers actually ask one question.
--     It is a separate row set rather than a text column on `faqs` because each
--     near-question has to be switched off on its own, counted on its own, and
--     turned into its own embedding later (SDD-013) — none of which is possible
--     if several questions are concatenated into one field.
--
--     `unique (tenant_id, faq_id, question_text)` makes generation idempotent:
--     re-running the generator over a FAQ must not accumulate the same
--     near-question twice. `source` records how the row got here — a person
--     typed it, a model proposed it, or an import brought it — which is what an
--     operator needs in order to decide how much to trust it.
--
--   * `product_import_batches` and `product_import_errors` are the audit trail
--     of a product import. The batch row records the file, its hash and the row
--     counts; the error rows record which line failed and why, one row per
--     (line, field) so a bad cell can be shown next to the value that caused it.
--     `raw_value_masked` is the value *after* masking, never the raw value: an
--     import file can carry a customer's phone number in a column nobody meant
--     to import, and an error report is the last place it should reappear.
--
--     `status` covers the whole life of a batch — `uploaded`, `validating`,
--     `importing`, `completed`, `partial_failed`, `failed` — because "the file
--     arrived", "we are checking it", "we are writing it" and "it is done, some
--     rows failed" are four different things to the person watching.
--
--   * `shortcuts` gains a scope. Until now every shortcut was store-scoped,
--     because its `store_id` was `NOT NULL`. The design has merchant-level
--     shortcuts too: a phrase like 欢迎语 belongs to the whole tenant and should
--     be visible from every store, while 本店发货时效 belongs to one store.
--     `scope_type` + a now-nullable `store_id` express both, and the CHECK keeps
--     the two columns from ever disagreeing — a `tenant` row with a store, or a
--     `store` row without one, is not representable.
--
--     The existing `unique (tenant_id, store_id, code)` cannot police
--     tenant-scoped rows: PostgreSQL treats each NULL `store_id` as distinct, so
--     two tenant-level shortcuts could share a code. A partial unique index over
--     `(tenant_id, code) WHERE scope_type = 'tenant'` is what makes the code
--     unique within the scope that actually applies.
--
-- Enum columns are `CHECK (col IN (...))`, not PostgreSQL enum types, and the
-- table creations are `IF NOT EXISTS`, as in every migration before this one.
-- ---------------------------------------------------------------------------

-- FAQ near-questions -----------------------------------------------------------

CREATE TABLE IF NOT EXISTS faq_question_variants (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  faq_id TEXT NOT NULL REFERENCES faqs (id) ON DELETE CASCADE,
  question_text TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'generated', 'imported')),
  status TEXT NOT NULL DEFAULT 'enabled' CHECK (status IN ('enabled', 'disabled')),
  updated_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT faq_question_variants_text_unique UNIQUE (tenant_id, faq_id, question_text)
);

CREATE INDEX IF NOT EXISTS faq_question_variants_faq_idx
  ON faq_question_variants (tenant_id, faq_id, id);

-- Product import batches -------------------------------------------------------

CREATE TABLE IF NOT EXISTS product_import_batches (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  store_id TEXT NOT NULL REFERENCES stores (id) ON DELETE CASCADE,
  source_type TEXT NOT NULL CHECK (source_type IN ('csv', 'xlsx', 'internal_api')),
  file_object_key TEXT,
  file_sha256 TEXT,
  status TEXT NOT NULL DEFAULT 'uploaded'
    CHECK (status IN ('uploaded', 'validating', 'importing', 'completed', 'partial_failed', 'failed')),
  total_rows INTEGER NOT NULL DEFAULT 0 CHECK (total_rows >= 0),
  success_rows INTEGER NOT NULL DEFAULT 0 CHECK (success_rows >= 0),
  failed_rows INTEGER NOT NULL DEFAULT 0 CHECK (failed_rows >= 0),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  -- The composite key `product_import_errors` points at. The id alone is
  -- already unique; naming the tenant alongside it is what lets the error table
  -- carry a foreign key that cannot cross a tenant boundary.
  CONSTRAINT product_import_batches_scope_unique UNIQUE (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS product_import_batches_store_idx
  ON product_import_batches (tenant_id, store_id, created_at DESC, id);

-- Import error details ---------------------------------------------------------

CREATE TABLE IF NOT EXISTS product_import_errors (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  row_number INTEGER NOT NULL CHECK (row_number >= 1),
  field_name TEXT,
  error_code TEXT NOT NULL,
  error_message TEXT,
  raw_value_masked TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT product_import_errors_batch_fk
    FOREIGN KEY (tenant_id, batch_id)
    REFERENCES product_import_batches (tenant_id, id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS product_import_errors_batch_idx
  ON product_import_errors (tenant_id, batch_id, row_number, id);

-- Shortcut scope ---------------------------------------------------------------

ALTER TABLE shortcuts
  ADD COLUMN IF NOT EXISTS scope_type TEXT NOT NULL DEFAULT 'store',
  ADD COLUMN IF NOT EXISTS intent_code TEXT,
  ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0;

-- Every row that exists today is store-scoped, so `scope_type` starting at
-- `'store'` describes them truthfully rather than merely defaulting.
ALTER TABLE shortcuts ALTER COLUMN store_id DROP NOT NULL;

ALTER TABLE shortcuts
  DROP CONSTRAINT IF EXISTS shortcuts_scope_check;

ALTER TABLE shortcuts
  ADD CONSTRAINT shortcuts_scope_check CHECK (
    scope_type IN ('tenant', 'store')
    AND (
      (scope_type = 'tenant' AND store_id IS NULL)
      OR (scope_type = 'store' AND store_id IS NOT NULL)
    )
  );

-- `(tenant_id, store_id, code)` cannot cover tenant-scoped rows, because each
-- NULL store_id compares as distinct. This index is the one that applies to them.
CREATE UNIQUE INDEX IF NOT EXISTS shortcuts_tenant_code_unique
  ON shortcuts (tenant_id, code)
  WHERE scope_type = 'tenant';
