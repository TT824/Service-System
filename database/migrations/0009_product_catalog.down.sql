-- 0009_product_catalog (down)
-- ---------------------------------------------------------------------------
-- Drop the four catalogue tables in reverse dependency order, and nothing else.
--
-- Order is forced by the foreign keys: `product_skus` references `product_spus`,
-- `product_spus` and `product_category_attributes` reference
-- `product_categories`, and `product_categories.parent_id` references itself.
-- Dropping a table takes its own indexes and its own outgoing constraints with
-- it, so only the tables need naming.
--
-- Nothing in `0002` is touched. The legacy `products` table is a separate row
-- set that this migration neither reads nor writes: a knowledge product created
-- before `0009` is still there afterwards, and so are its FAQs and shortcuts.
-- The two models coexist on purpose — `products` is what the reply pipeline
-- reads today, and the SPU/SKU tree is the structure SDD-012 imports into and
-- SDD-014 indexes.
-- ---------------------------------------------------------------------------

DROP TABLE IF EXISTS product_skus;
DROP TABLE IF EXISTS product_spus;
DROP TABLE IF EXISTS product_category_attributes;
DROP TABLE IF EXISTS product_categories;
