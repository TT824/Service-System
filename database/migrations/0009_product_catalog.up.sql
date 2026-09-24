-- 0009_product_catalog (up)
-- ---------------------------------------------------------------------------
-- The product catalogue: categories, the attributes a category declares, and
-- the two-level SPU/SKU model that expresses colour, size and model variants.
--
-- Four facts are added, and nothing else:
--
--   * `product_categories` is the tree a merchant files products under. It is
--     store-scoped like every other knowledge row, and `parent_id` is a
--     self-reference so a category can have a parent without a second table.
--     `status` is `enabled`/`disabled` rather than a boolean for the same reason
--     `products.enabled` is reversible: a category that goes out of use is kept,
--     because the products filed under it still name it.
--
--   * `product_category_attributes` is the per-category extension schema §8
--     calls 类目扩展字段. It is a *declaration* — code, name, value type and
--     whether the value is required/searchable — not the values themselves: the
--     values live in `product_spus.common_attributes_json`, keyed by
--     `attribute_code`. Keeping the declaration in rows rather than in code is
--     what lets a merchant add "袖长" without a release.
--
--     `value_type` is `text|number|boolean|enum|multi_enum`; `allowed_values_json`
--     is only meaningful for the two enum types and is left NULL otherwise, so a
--     free-text attribute cannot accidentally carry a closed value list.
--
--   * `product_spus` is the product a buyer talks about — the title, the link,
--     the images, the selling points — while `product_skus` is what can actually
--     be sold. One row per *thing*, one row per *variant*:
--
--         SPU「纯棉圆领 T 恤」  ← title, product_url, common_attributes_json
--           ├── SKU (颜色=黑, 尺码=M)
--           └── SKU (颜色=白, 尺码=L)
--
--     The split is what makes 颜色/尺码/型号 expressible without inventing a
--     column per variant dimension: `variant_json` holds the dimension → value
--     map, and `search_attributes_json` holds the flattened, searchable form the
--     retrieval index will filter on (SDD-014). A single flat table could not do
--     this: "the price of the black M" is not a property of the product, and
--     "the title" is not a property of the variant.
--
--     `shelf_status` is `on_shelf|off_shelf|unknown`. `unknown` is a first-class
--     value because a channel import (SDD-012) often cannot tell whether the
--     seller has the product listed — recording a guess as `off_shelf` would
--     silently hide a live product, and recording it as `on_shelf` would offer a
--     product that is not for sale. `source_type`/`source_updated_at` say where
--     the row came from and when the *source* last said so, which is not the
--     same as when this row was written.
--
--     `unique (tenant_id, store_id, product_code)` is what makes an import
--     idempotent: re-uploading the same sheet updates rows instead of forking
--     duplicates.
--
--   * `product_skus` carries `external_sku_id` and `sku_code` under the same
--     tenant-first uniqueness. `status` is `active|inactive`: an inactive SKU is
--     a variant that has been withdrawn while the product is still sold in other
--     variants, which is why it is not a delete.
--
-- All four tables are tenant-scoped, all four pair with a fully inverse
-- `.down.sql`, and the JSON columns are `NOT NULL DEFAULT` an empty value so a
-- reader never has to distinguish "empty" from "absent" — the map-shaped columns
-- default to an empty object and the list-shaped ones to an empty array. Enum
-- columns are `CHECK (col IN (...))` rather than PostgreSQL enum types: widening
-- one is then a code-and-data change instead of an `ALTER TYPE`, which cannot run
-- inside the migration's own transaction on every supported version.
-- ---------------------------------------------------------------------------

-- Categories ------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS product_categories (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  store_id TEXT NOT NULL,
  parent_id TEXT REFERENCES product_categories (id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'enabled' CHECK (status IN ('enabled', 'disabled')),
  updated_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT product_categories_code_unique UNIQUE (tenant_id, store_id, code)
);

CREATE INDEX IF NOT EXISTS product_categories_scope_idx
  ON product_categories (tenant_id, store_id, id);

-- Category attribute declarations ---------------------------------------------

CREATE TABLE IF NOT EXISTS product_category_attributes (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  category_id TEXT NOT NULL REFERENCES product_categories (id),
  attribute_code TEXT NOT NULL,
  attribute_name TEXT NOT NULL,
  value_type TEXT NOT NULL CHECK (value_type IN ('text', 'number', 'boolean', 'enum', 'multi_enum')),
  is_required BOOLEAN NOT NULL DEFAULT FALSE,
  is_searchable BOOLEAN NOT NULL DEFAULT FALSE,
  allowed_values_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT product_category_attributes_code_unique UNIQUE (tenant_id, category_id, attribute_code)
);

CREATE INDEX IF NOT EXISTS product_category_attributes_category_idx
  ON product_category_attributes (tenant_id, category_id, id);

-- Products (SPU) ---------------------------------------------------------------

CREATE TABLE IF NOT EXISTS product_spus (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  store_id TEXT NOT NULL,
  category_id TEXT REFERENCES product_categories (id),
  external_product_id TEXT,
  product_code TEXT NOT NULL,
  title TEXT NOT NULL,
  subtitle TEXT,
  main_image_url TEXT,
  product_url TEXT,
  selling_points_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  common_attributes_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  shelf_status TEXT NOT NULL DEFAULT 'unknown' CHECK (shelf_status IN ('on_shelf', 'off_shelf', 'unknown')),
  source_type TEXT NOT NULL DEFAULT 'manual' CHECK (source_type IN ('manual', 'csv', 'internal_api', 'channel_api')),
  source_updated_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT product_spus_code_unique UNIQUE (tenant_id, store_id, product_code)
);

CREATE INDEX IF NOT EXISTS product_spus_scope_idx
  ON product_spus (tenant_id, store_id, id);

CREATE INDEX IF NOT EXISTS product_spus_category_idx
  ON product_spus (tenant_id, store_id, category_id, id);

-- Variants (SKU) ---------------------------------------------------------------

CREATE TABLE IF NOT EXISTS product_skus (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  store_id TEXT NOT NULL,
  spu_id TEXT NOT NULL REFERENCES product_spus (id),
  external_sku_id TEXT,
  sku_code TEXT NOT NULL,
  variant_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  search_attributes_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  updated_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT product_skus_code_unique UNIQUE (tenant_id, store_id, sku_code)
);

CREATE INDEX IF NOT EXISTS product_skus_spu_idx
  ON product_skus (tenant_id, spu_id, id);
