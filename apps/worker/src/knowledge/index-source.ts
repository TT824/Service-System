/**
 * The index job's read side: one source row in, one `IndexSourceInput` out.
 *
 * SDD-013's job is fed by five tables — `faqs`, `faq_question_variants`,
 * `shortcuts`, `product_spus` and `product_skus` — and every decision the kernel
 * deliberately refuses to make is made here, because here is the only place the
 * source row is still visible:
 *
 * - **`enabled` is asked of `usableKnowledge`, never computed here.** The kernel
 *   passes the flag through unread (see its module note), so the answer has to
 *   come from somewhere in the job, and `0011` records where: the job calls the
 *   one rule and writes the answer down. A local `enabled === true` would be a
 *   second copy of the rule, and the second copy is the one that drifts.
 * - **A switched-off source is still mapped.** The same `0011` note is why this
 *   layer reads every row of the tenant instead of filtering on the way in: the
 *   copied flag is corrected on the *next* index pass, and a pass that skipped
 *   disabled rows would never make that correction — the old chunks would keep
 *   `enabled = true` for ever. So a row is dropped here for one reason only: the
 *   kernel derives no slice from it, which is the kernel's call, not this one's.
 * - **`null` is the only way to say "no store".** The kernel derives `scopeType`
 *   from `storeId`, and `0011`'s `knowledge_chunks_scope_check` holds the two
 *   columns to each other. A falsy check (`row.store_id || null`) would re-scope
 *   a store's row to the whole merchant, and nothing would raise: the chunk would
 *   simply be written at a scope no query names.
 * - **The field names come from `KNOWLEDGE_FIELDS`, not from a list here.** Which
 *   columns of which source become slices is a kernel decision that already
 *   exists; projecting the row through it means a field added to the kernel is
 *   indexed by this job without anyone remembering to edit this file. The two
 *   product kinds are the one place a field name is not a column: `attributes`
 *   and `variant` are derived from the row's attribute JSON, and they are built
 *   by {@link productValues} and {@link productSkuValues} — the only two
 *   projections that do not go through `indexableValues`.
 *
 * No I/O happens here: the rows are read by {@link IndexSourceReader}'s adapter
 * and handed in, which is what keeps this module drivable from a spec with no
 * database — the same split the kernel itself uses.
 */

import {
  CUSTOMER_VISIBLE_SKU_ATTRIBUTES,
  CUSTOMER_VISIBLE_SPU_ATTRIBUTES,
  KNOWLEDGE_FIELDS,
  labelledEntries,
  labelledLines,
  separateColourAndSize,
  toAttributeMap,
  usableKnowledge,
  type IndexSourceInput,
  type IndexedSourceKind,
} from '@kefu/core';
import { toBoolean, toText, toTextOrNull } from '../database/row-values';

/**
 * One `SELECT`ed source row, as the driver returned it.
 *
 * Deliberately not a per-table type: the columns this layer reads are named by
 * `KNOWLEDGE_FIELDS` and by the three mappers below, and a row type per table
 * would be a fourth place to keep in step with the schema.
 */
export type KnowledgeSourceRow = Readonly<Record<string, unknown>>;

/**
 * One tenant's rows, grouped by the table they came from.
 *
 * Grouping is the adapter's job because the adapter is what knows there are
 * three tables; everything downstream sees one list of inputs.
 */
export type KnowledgeSourceRows = {
  readonly faqs: ReadonlyArray<KnowledgeSourceRow>;
  readonly faqVariants: ReadonlyArray<KnowledgeSourceRow>;
  readonly shortcuts: ReadonlyArray<KnowledgeSourceRow>;
  readonly products: ReadonlyArray<KnowledgeSourceRow>;
  readonly productSkus: ReadonlyArray<KnowledgeSourceRow>;
};

/**
 * The one shelf state that means "do not sell this".
 *
 * Tested as a **non-match**, and that is the load-bearing part: `0009` makes
 * `unknown` a first-class answer, and it is the answer every product imported
 * from a merchant sheet carries — those files have no shelf column. A
 * `=== 'on_shelf'` test would therefore index the whole catalogue as unusable
 * and answer nothing with it, and an empty answer is indistinguishable from an
 * empty index. `off_shelf` is the only state that has actually been decided
 * against a customer.
 */
const OFF_SHELF = 'off_shelf';

/**
 * Ask the platform's one usability rule about one source row.
 *
 * {@link usableKnowledge} answers "which of these may answer a customer?", and
 * the job needs that answer per row. Running the filter over a single-item list
 * is how this layer asks it without restating it; the alternative — a local
 * `enabled === true` — is the second answer the rule exists to prevent.
 *
 * @param enabled - The row's own state, already normalised to a boolean.
 * @returns `true` when the row may be used to answer customers.
 */
function usability(enabled: boolean): boolean {
  return usableKnowledge([{ enabled }]).length === 1;
}

/**
 * Read a scope column the only way `0011` allows it to be read.
 *
 * `null` means tenant-level and nothing else does — in particular the empty
 * string is *not* a second way to say "no store". Both scope columns are foreign
 * keys into `stores`, so an empty string cannot be stored in the first place;
 * the rule is written out anyway because the failure it prevents is silent (see
 * the module note).
 *
 * @param value - Column value as the driver returned it.
 * @returns The store id, or `null` for a tenant-level row.
 */
function toStoreId(value: unknown): string | null {
  return value === null || value === undefined ? null : toText(value);
}

/**
 * The field values the kernel will slice, keyed by column name.
 *
 * The key set is `KNOWLEDGE_FIELDS` for the kind, so the projection cannot
 * disagree with the kernel about which columns are indexed. A column the row
 * does not carry is `null`, which the kernel already reads as "no slices from
 * this field" — the row itself is still passed on, because a source with no
 * slices is a source whose slices must be deleted, not a source to skip.
 *
 * @param row - The source row.
 * @param sourceKind - Which table's field list applies.
 * @returns Field values by column name.
 */
function indexableValues(
  row: KnowledgeSourceRow,
  sourceKind: IndexedSourceKind,
): Readonly<Record<string, string | null | undefined>> {
  const values: Record<string, string | null | undefined> = {};
  for (const field of KNOWLEDGE_FIELDS[sourceKind]) {
    values[field.field] = toTextOrNull(row[field.field]);
  }
  return values;
}

/**
 * Map one `faqs` row.
 *
 * `faqs.store_id` is `NOT NULL` (`0002`), so a FAQ is always store-scoped today;
 * the column still travels through the same null-means-tenant rule as the other
 * two sources, so that the day a tenant-level FAQ becomes representable there is
 * one mapper to change rather than three.
 *
 * @param row - One `faqs` row.
 * @returns The kernel input for that FAQ.
 */
export function faqIndexSource(row: KnowledgeSourceRow): IndexSourceInput {
  return {
    tenantId: toText(row['tenant_id']),
    storeId: toStoreId(row['store_id']),
    sourceKind: 'faq',
    sourceId: toText(row['id']),
    enabled: usability(toBoolean(row['enabled'])),
    values: indexableValues(row, 'faq'),
  };
}

/**
 * Map one `faq_question_variants` row, joined to the FAQ it belongs to.
 *
 * Two of this input's fields do not exist on the variant's own row, and both are
 * read from the join:
 *
 * - **The scope.** `0010`'s variant table has no `store_id`: a near-question is
 *   asked about a FAQ, so it lives where that FAQ lives. It is selected as
 *   `faq_store_id`.
 * - **The usability.** The variant's state is `status`, `TEXT` over
 *   `FAQ_VARIANT_STATUSES` — not the `BOOLEAN` the shared rule reads — and it is
 *   not the whole answer either: a near-question carries no answer of its own, so
 *   a variant of a switched-off FAQ must not be indexed as usable, or retrieval
 *   would match a phrase and find a disabled answer behind it. Both columns
 *   (`status` and the FAQ's `enabled`, selected as `faq_enabled`) are therefore
 *   normalised to booleans and combined *before* the rule is asked, so the rule
 *   still sees a boolean and stays the only place that decides.
 *
 * The join is an inner one on purpose: the foreign key cascades, so a variant
 * whose FAQ is gone cannot exist, and if one somehow did, dropping the input is
 * better than inventing a scope for it. The chunk it used to have is then stale,
 * and the write path deletes it.
 *
 * @param row - One `faq_question_variants` row, joined to its FAQ.
 * @returns The kernel input for that near-question.
 */
export function faqVariantIndexSource(row: KnowledgeSourceRow): IndexSourceInput {
  // `'enabled'` is the non-停用 member of `FAQ_VARIANT_STATUSES`; naming it as a
  // comparison rather than casting `status` to a boolean keeps the two
  // vocabularies — the variant's `TEXT` and the rule's `BOOLEAN` — from being
  // silently conflated.
  const variantEnabled = toText(row['status']) === 'enabled';
  return {
    tenantId: toText(row['tenant_id']),
    storeId: toStoreId(row['faq_store_id']),
    sourceKind: 'faq_variant',
    sourceId: toText(row['id']),
    enabled: usability(variantEnabled && toBoolean(row['faq_enabled'])),
    values: indexableValues(row, 'faq_variant'),
  };
}

/**
 * Map one `shortcuts` row.
 *
 * `0010` made `store_id` nullable and added `scope_type`, so this is the one
 * source that can be tenant-level: `scope_type = 'tenant'` and `store_id IS NULL`
 * are held together by `shortcuts_scope_check`, and the kernel re-derives the
 * same pair for the chunk. Nothing here reads `scope_type` — the column and the
 * null are one fact, and reading the fact twice is how two answers start.
 *
 * @param row - One `shortcuts` row.
 * @returns The kernel input for that phrase.
 */
export function shortcutIndexSource(row: KnowledgeSourceRow): IndexSourceInput {
  return {
    tenantId: toText(row['tenant_id']),
    storeId: toStoreId(row['store_id']),
    sourceKind: 'shortcut',
    sourceId: toText(row['id']),
    enabled: usability(toBoolean(row['enabled'])),
    values: indexableValues(row, 'shortcut'),
  };
}

/**
 * The field values of one product row.
 *
 * `title` is a column; `attributes` is **not** — it is the name the kernel's
 * field list gives the derived value, and what is derived is the labelled lines
 * of the customer-visible attributes ({@link labelledLines}). Projecting the map
 * through the whitelist here, rather than passing the raw JSON and filtering
 * later, is what makes "a cost price never becomes a slice" a property of the
 * one list instead of a rule the chunker would have to also know.
 *
 * @param row - One `product_spus` row.
 * @returns The two field values the kernel slices.
 */
function productValues(row: KnowledgeSourceRow): Readonly<Record<string, string | null>> {
  const lines = labelledLines(
    toAttributeMap(row['common_attributes_json']),
    CUSTOMER_VISIBLE_SPU_ATTRIBUTES,
  );
  return {
    title: toTextOrNull(row['title']),
    // No lines is no slices: the kernel reads `null` as "this field produced
    // nothing", and `''` would be the same answer reached by a longer path.
    attributes: lines.length === 0 ? null : lines,
  };
}

/**
 * The field values of one variant row.
 *
 * Same derivation as {@link productValues}, from `variant_json` and the SKU
 * whitelist, plus the one fact the variant's own row cannot supply: **its
 * product's title, prefixed to every line** (`云集防晒帽 颜色：冰雾粉`).
 *
 * The prefix is what keeps a dimension answerable. A slice reading only
 * `颜色：冰雾粉` names no product, and a query that names both the product and the
 * dimension (`防晒帽 冰雾粉`) then matches neither slice that exists: the title
 * slice carries no colour and the colour slice carries no title. Both recall legs
 * read one slice at a time — the keyword leg's substring pass asks each
 * `content` for the query's terms, and the semantic leg embeds each slice by
 * itself — so the two facts have to meet inside one slice before either leg can
 * find the pair.
 *
 * Prefixed to each line rather than appended once, and never a line of its own:
 * the value is cut on lines (`chunkStructured`), so a title line would become a
 * slice with no dimension in it — a second copy of the product title, which the
 * product source already writes.
 *
 * A row with no title (or a reader that did not join one) yields the unprefixed
 * lines, unchanged from before: the title is an addition to the slice, and
 * nothing downstream may depend on it being there.
 *
 * The merchant's colour column held the whole variant, so its value is taken
 * apart before it is written: `漫暮黑L` becomes `颜色：漫暮黑` and a `尺码：L` line
 * rather than one line with the colour glued to the size. That is
 * {@link separateColourAndSize}, and it is applied here rather than to the row
 * because this is the only place that decides what a slice says — the reader of
 * a slice (`sliceAttributeValues`) reads labels, so the two ends agree by
 * construction instead of by a second parsing rule.
 *
 * The variant's facts (`售价`, `库存`) are not among the fields the kernel slices
 * at all — see `KNOWLEDGE_FIELDS` — so nothing here has to exclude them.
 *
 * @param row - One `product_skus` row, joined to its product.
 * @returns The one field value the kernel slices.
 */
function productSkuValues(row: KnowledgeSourceRow): Readonly<Record<string, string | null>> {
  const entries = labelledEntries(
    separateColourAndSize(toAttributeMap(row['variant_json'])),
    CUSTOMER_VISIBLE_SKU_ATTRIBUTES,
  );
  const title = toText(row['spu_title']).trim();
  const lines: ReadonlyArray<string> =
    title.length === 0 ? entries : entries.map((entry) => `${title} ${entry}`);
  // One string, not the lines: a field value is the text the kernel cuts, and the
  // line breaks are what it cuts on (`chunkStructured`).
  return { variant: lines.length === 0 ? null : lines.join('\n') };
}

/**
 * Map one `product_spus` row.
 *
 * Usability is the shelf state alone — see {@link OFF_SHELF} for why it is
 * written as a non-match. The row's `common_attributes_json` is projected
 * through the customer-visible whitelist; a product with no attributes at all
 * still produces its title slice, which is the field a customer names it by.
 *
 * @param row - One `product_spus` row.
 * @returns The kernel input for that product.
 */
export function productIndexSource(row: KnowledgeSourceRow): IndexSourceInput {
  return {
    tenantId: toText(row['tenant_id']),
    storeId: toStoreId(row['store_id']),
    sourceKind: 'product',
    sourceId: toText(row['id']),
    enabled: usability(toText(row['shelf_status']) !== OFF_SHELF),
    values: productValues(row),
  };
}

/**
 * Map one `product_skus` row, joined to the product it belongs to.
 *
 * The join carries two columns this mapper needs and the variant's own table does
 * not have: its product's shelf state and its title. A variant of an off-shelf
 * product is not answerable either, and the two states are combined *before* the
 * usability rule is asked — the same arrangement `faqVariantIndexSource` makes
 * with `faq_enabled`, and for the same reason: a slice recalled by its colour must
 * not lead to a product the merchant has taken down. The title goes into the slice
 * text itself — see {@link productSkuValues} — which is why the *reader's* `SELECT`
 * is where a lost alias would show up as a silent loss of recall rather than as a
 * failure.
 *
 * `status` is compared to `'active'` rather than to its negation because, unlike
 * the shelf state, this column is always written by the import (`SKU_STATUSES`'s
 * default is `active`) and `inactive` is a decision the merchant made.
 *
 * @param row - One `product_skus` row, joined to its product.
 * @returns The kernel input for that variant.
 */
export function productSkuIndexSource(row: KnowledgeSourceRow): IndexSourceInput {
  const sellable =
    toText(row['status']) === 'active' && toText(row['spu_shelf_status']) !== OFF_SHELF;
  return {
    tenantId: toText(row['tenant_id']),
    storeId: toStoreId(row['store_id']),
    sourceKind: 'product_sku',
    sourceId: toText(row['id']),
    enabled: usability(sellable),
    values: productSkuValues(row),
  };
}

/**
 * Map one tenant's source rows to the kernel's inputs.
 *
 * Order is fixed — `faqs`, then the variants, then the shortcuts, then the
 * products, then their variants, each in the order its `SELECT` returned (by id)
 * — so two passes over an unchanged tenant
 * produce the same inputs in the same order. That matters for more than tidiness:
 * the write path compares incoming rows against stored ones, and a pass whose
 * order moved would make a diff unreadable and a failure unreproducible.
 *
 * Which *rows* are read is not decided here. That is the adapter's `WHERE`, and
 * keeping it there is what lets this half be driven from a spec.
 *
 * @param rows - The five tables' rows for one tenant.
 * @returns One input per source row, in table-then-id order.
 */
export function toIndexSources(rows: KnowledgeSourceRows): ReadonlyArray<IndexSourceInput> {
  return [
    ...rows.faqs.map(faqIndexSource),
    ...rows.faqVariants.map(faqVariantIndexSource),
    ...rows.shortcuts.map(shortcutIndexSource),
    ...rows.products.map(productIndexSource),
    ...rows.productSkus.map(productSkuIndexSource),
  ];
}
