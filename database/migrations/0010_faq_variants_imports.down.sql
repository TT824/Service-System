-- 0010_faq_variants_imports (down)
-- ---------------------------------------------------------------------------
-- Undo everything `0010` did, and nothing else.
--
-- The three new tables drop in foreign-key order: `product_import_errors`
-- references `product_import_batches`, and `faq_question_variants` references
-- both `tenants` and `faqs`, which are not touched.
--
-- The `shortcuts` widening is the one part that cannot be undone without losing
-- something. Before this migration the table could not represent a merchant-level
-- shortcut at all, so a tenant-scoped row has nowhere to go once `store_id`
-- becomes `NOT NULL` again. Those rows are therefore deleted on the way down,
-- deliberately and only those: store-scoped rows — every row that existed before
-- this migration, plus any added since — keep their store and survive intact.
-- The `scope_type` values are `'tenant'` and `'store'`, so this is a precise
-- filter and not a guess.
-- ---------------------------------------------------------------------------

DROP TABLE IF EXISTS product_import_errors;
DROP TABLE IF EXISTS product_import_batches;
DROP TABLE IF EXISTS faq_question_variants;

DROP INDEX IF EXISTS shortcuts_tenant_code_unique;

ALTER TABLE shortcuts DROP CONSTRAINT IF EXISTS shortcuts_scope_check;

DELETE FROM shortcuts WHERE scope_type = 'tenant';

ALTER TABLE shortcuts ALTER COLUMN store_id SET NOT NULL;

ALTER TABLE shortcuts DROP COLUMN IF EXISTS sort_order;
ALTER TABLE shortcuts DROP COLUMN IF EXISTS intent_code;
ALTER TABLE shortcuts DROP COLUMN IF EXISTS scope_type;
