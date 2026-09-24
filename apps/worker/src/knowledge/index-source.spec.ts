import { describe, expect, it } from 'vitest';
import { KNOWLEDGE_FIELDS, type IndexedSourceKind, type IndexSourceInput } from '@kefu/core';
import {
  faqIndexSource,
  faqVariantIndexSource,
  productIndexSource,
  productSkuIndexSource,
  shortcutIndexSource,
  toIndexSources,
  type KnowledgeSourceRow,
} from './index-source';

/**
 * The read side of the index job, driven with rows and nothing else.
 *
 * What is worth pinning here is not that a row maps to an object, but the three
 * decisions the mapping makes — each of which fails silently in production and
 * would fail just as silently in a test that only checked the shape:
 *
 * - the usability flag comes from the shared rule (so a 停用 row maps to
 *   `enabled: false` **and is still mapped** — dropping it is what leaves the
 *   old chunks usable for ever);
 * - a near-question takes its scope and its state from the join, since its own
 *   row has neither;
 * - the indexed columns are the kernel's `KNOWLEDGE_FIELDS`, so a field added to
 *   the kernel cannot go unindexed by this job.
 *
 * The rows below are shaped the way `pg` returns them: snake_case columns, a
 * real boolean for `BOOLEAN`, and — for a variant — the aliases its `SELECT`
 * adds.
 */

/** The column names the kernel indexes for one source kind, sorted. */
function indexedFields(kind: IndexedSourceKind): ReadonlyArray<string> {
  return KNOWLEDGE_FIELDS[kind].map((field) => field.field).sort();
}

const ENABLED_FAQ: KnowledgeSourceRow = {
  id: 'faq-1',
  tenant_id: 'tenant-1',
  store_id: 'store-1',
  question: '怎么退货？',
  answer: '七天无理由退货。',
  tags: ['售后'],
  enabled: true,
  updated_at: '2026-09-17T00:00:00.000Z',
};

/**
 * A product row as the catalogue holds one, cost price included.
 *
 * The cost is there on purpose: it is what a merchant sheet carries next to the
 * selling price, and every test below that reads this row's attributes is set up
 * so that a whitelist which stopped being applied would put it in the slice text.
 */
const PRODUCT: KnowledgeSourceRow = {
  id: 'spu-1',
  tenant_id: 'tenant-1',
  store_id: 'store-1',
  title: '云集防晒帽',
  common_attributes_json: { 品牌: '蕉下', 分类: '服饰配件', 成本价: '31' },
  shelf_status: 'unknown',
};

/** A variant row as the reader's join returns it: its own columns plus the product's two. */
const SKU: KnowledgeSourceRow = {
  id: 'sku-1',
  tenant_id: 'tenant-1',
  store_id: 'store-1',
  spu_id: 'spu-1',
  variant_json: { 颜色: '冰雾粉', 规格: 'M', 成本价: '18' },
  search_attributes_json: { 售价: '94', 库存: '0' },
  status: 'active',
  spu_shelf_status: 'unknown',
  spu_title: '云集防晒帽',
};

describe('index source mapping', () => {
  it('maps a FAQ row, indexing exactly the kernel fields', () => {
    const input: IndexSourceInput = faqIndexSource(ENABLED_FAQ);

    expect(input.tenantId).toBe('tenant-1');
    expect(input.sourceKind).toBe('faq');
    // `id`, not the store and not the FAQ's question: the address is the source
    // row's own primary key.
    expect(input.sourceId).toBe('faq-1');
    expect(input.storeId).toBe('store-1');
    expect(input.enabled).toBe(true);
    // `tags` is on the row and is deliberately not passed: the kernel reads only
    // what `KNOWLEDGE_FIELDS` names.
    expect(input.values).toEqual({ question: '怎么退货？', answer: '七天无理由退货。' });
    expect(Object.keys(input.values).sort()).toEqual(indexedFields('faq'));
  });

  it('maps a switched-off source too, carrying the flag rather than dropping the row', () => {
    const inputs = toIndexSources({
      faqs: [ENABLED_FAQ, { ...ENABLED_FAQ, id: 'faq-2', enabled: false }],
      faqVariants: [],
      shortcuts: [],
      products: [],
      productSkus: [],
    });

    expect(inputs).toHaveLength(2);
    expect(inputs.map((input) => input.sourceId)).toEqual(['faq-1', 'faq-2']);
    expect(inputs.map((input) => input.enabled)).toEqual([true, false]);
  });

  it('normalises an absent column to null, which the kernel reads as no slices', () => {
    const row: KnowledgeSourceRow = { id: 'faq-3', tenant_id: 'tenant-1', enabled: true };

    const input = faqIndexSource(row);

    expect(input.values).toEqual({ question: null, answer: null });
    // The row is still an input: "this source produces no slices now" is what
    // makes its stored slices stale, and that has to reach the write path.
    expect(input.storeId).toBeNull();
    expect(input.sourceId).toBe('faq-3');
  });

  it('reads only SQL NULL as tenant scope for a shortcut', () => {
    const tenantLevel: KnowledgeSourceRow = {
      id: 'shortcut-1',
      tenant_id: 'tenant-1',
      scope_type: 'tenant',
      store_id: null,
      title: '欢迎语',
      content: '您好，很高兴为您服务。',
      enabled: true,
    };

    const input = shortcutIndexSource(tenantLevel);

    expect(input.storeId).toBeNull();
    expect(input.sourceKind).toBe('shortcut');
    expect(input.values).toEqual({ title: '欢迎语', content: '您好，很高兴为您服务。' });
  });

  it('does not fold a store id that is merely falsy into tenant scope', () => {
    const empty: KnowledgeSourceRow = { id: 'shortcut-2', tenant_id: 'tenant-1', store_id: '' };
    const zero: KnowledgeSourceRow = { id: 'shortcut-3', tenant_id: 'tenant-1', store_id: '0' };

    // Both are data the schema cannot hold — `store_id` is a foreign key into
    // `stores` — so the mapper passes them through as written. What it must not
    // do is answer "no store" for them, which would re-scope the row to the
    // merchant and write a chunk at a scope no query names.
    expect(shortcutIndexSource(empty).storeId).toBe('');
    expect(shortcutIndexSource(zero).storeId).toBe('0');
  });

  it("takes a near-question's scope and usability from its FAQ", () => {
    const variant: KnowledgeSourceRow = {
      id: 'variant-1',
      tenant_id: 'tenant-1',
      faq_id: 'faq-1',
      question_text: '能退吗？',
      status: 'enabled',
      faq_store_id: 'store-9',
      faq_enabled: true,
    };

    const input = faqVariantIndexSource(variant);

    expect(input.sourceKind).toBe('faq_variant');
    expect(input.sourceId).toBe('variant-1');
    // Not the variant's own column — it has none — and not the FAQ's id either.
    expect(input.storeId).toBe('store-9');
    expect(input.enabled).toBe(true);
    expect(input.values).toEqual({ question_text: '能退吗？' });
    expect(Object.keys(input.values).sort()).toEqual(indexedFields('faq_variant'));
  });

  it('indexes a near-question as unusable when either it or its FAQ is switched off', () => {
    const base: KnowledgeSourceRow = {
      id: 'variant-1',
      tenant_id: 'tenant-1',
      question_text: '能退吗？',
      status: 'enabled',
      faq_store_id: 'store-9',
      faq_enabled: true,
    };

    expect(faqVariantIndexSource({ ...base, status: 'disabled' }).enabled).toBe(false);
    expect(faqVariantIndexSource({ ...base, faq_enabled: false }).enabled).toBe(false);
    // Still one input in both cases, for the same reason as the switched-off FAQ:
    // the copy on the stored chunk is corrected by rewriting it, not by silence.
    expect(faqVariantIndexSource({ ...base, status: 'disabled' }).sourceId).toBe('variant-1');
  });

  it('maps the five tables in a fixed order, one input per row', () => {
    const inputs = toIndexSources({
      faqs: [
        { ...ENABLED_FAQ, id: 'faq-b' },
        { ...ENABLED_FAQ, id: 'faq-a' },
      ],
      faqVariants: [{ id: 'variant-a', tenant_id: 'tenant-1', status: 'enabled' }],
      shortcuts: [{ id: 'shortcut-a', tenant_id: 'tenant-1', store_id: 'store-1' }],
      products: [{ ...PRODUCT, id: 'spu-a' }],
      productSkus: [{ ...SKU, id: 'sku-a' }],
    });

    // The order the `SELECT`s return — table by table, each already ordered by
    // id — and not a re-sort here: the write path compares this list against what
    // is stored, so the list has to be the same list twice running.
    expect(inputs.map((input) => input.sourceKind)).toEqual([
      'faq',
      'faq',
      'faq_variant',
      'shortcut',
      'product',
      'product_sku',
    ]);
    expect(inputs.map((input) => input.sourceId)).toEqual([
      'faq-b',
      'faq-a',
      'variant-a',
      'shortcut-a',
      'spu-a',
      'sku-a',
    ]);
  });

  it('maps a source whose fields are blank, leaving the empty slice set to the kernel', () => {
    const inputs = toIndexSources({
      faqs: [],
      faqVariants: [],
      shortcuts: [{ id: 'shortcut-blank', tenant_id: 'tenant-1', title: '', content: '   ' }],
      products: [],
      productSkus: [],
    });

    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.values).toEqual({ title: '', content: '   ' });
  });
});

describe('product source mapping', () => {
  it('indexes the customer-visible attributes and nothing else the map carries', () => {
    const input = productIndexSource(PRODUCT);

    expect(input.sourceKind).toBe('product');
    expect(input.sourceId).toBe('spu-1');
    expect(input.values['title']).toBe('云集防晒帽');
    // 成本价 is in the row's attribute map. The whitelist is the only thing
    // keeping it out of the slice text — and out of what a model would later be
    // handed — so this is the assertion that fails when it stops being applied.
    expect(input.values['attributes']).toBe('品牌：蕉下\n分类：服饰配件');
    expect(Object.keys(input.values).sort()).toEqual(indexedFields('product'));
  });

  it('reads an unknown shelf state as sellable, which is what every import writes', () => {
    // `unknown` is a first-class answer in `0009` and the one a merchant sheet
    // without a shelf column produces. Read the other way round, the whole
    // catalogue indexes as unusable and retrieval answers nothing — a state that
    // looks exactly like an empty index.
    expect(productIndexSource(PRODUCT).enabled).toBe(true);
    expect(productIndexSource({ ...PRODUCT, shelf_status: 'on_shelf' }).enabled).toBe(true);

    const offShelf = productIndexSource({ ...PRODUCT, shelf_status: 'off_shelf' });
    expect(offShelf.enabled).toBe(false);
    // Still an input: the flag is corrected by rewriting the stored slices, and a
    // row dropped here would keep its old slices answerable for ever.
    expect(offShelf.sourceId).toBe('spu-1');
  });

  it('produces no attribute value for a product that carries none', () => {
    const bare = productIndexSource({
      id: 'spu-2',
      tenant_id: 'tenant-1',
      store_id: 'store-1',
      title: '纯棉圆领 T 恤',
    });

    // `null` and not `''`: both mean "no slices" to the kernel, and the
    // projection saying so plainly is what keeps the two-value case from being
    // rediscovered at the other end of the pipeline.
    expect(bare.values['attributes']).toBeNull();
    expect(bare.values['title']).toBe('纯棉圆领 T 恤');
  });

  it('indexes a variant by its dimensions, each line naming its product', () => {
    const input = productSkuIndexSource(SKU);

    expect(input.sourceKind).toBe('product_sku');
    expect(input.sourceId).toBe('sku-1');
    expect(input.storeId).toBe('store-1');
    // Price and stock are in `search_attributes_json` and are not indexed: the
    // kernel slices no such field, so nothing here has to exclude them.
    //
    // `云集防晒帽` on **both** lines, and the whole point of it being here: the
    // slice is cut on lines, so `颜色：冰雾粉` alone is a slice that names no
    // product — and nothing downstream can pair it with the title slice, because
    // the keyword leg's substring pass and the semantic leg both see one slice at
    // a time. A query naming a product *and* a dimension (`防晒帽 冰雾粉`) is
    // what fails when this prefix is dropped, silently: the slice is still
    // written, still enabled, still embedded.
    expect(input.values).toEqual({
      variant: '云集防晒帽 颜色：冰雾粉\n云集防晒帽 规格：M',
    });
    expect(Object.keys(input.values).sort()).toEqual(indexedFields('product_sku'));
    expect(input.enabled).toBe(true);
  });

  it('moves a size glued to the colour onto a line of its own', () => {
    // A third of this catalogue's colour cells are a whole variant (`漫暮黑L`) —
    // the merchant's colour column held the size as well. Left glued, the line is
    // `颜色：漫暮黑L`, and every reader that follows is asked to take the colour
    // word apart from the size by looking at the string: the cross-encoder that
    // scores the query against it, and the keyword leg that cuts it into terms.
    const glued = productSkuIndexSource({
      ...SKU,
      variant_json: { 颜色: '漫暮黑L', 成本价: '18' },
    });
    expect(glued.values).toEqual({
      variant: '云集防晒帽 颜色：漫暮黑\n云集防晒帽 尺码：L',
    });

    // A multi-pack cell carries one size and several colours, and the size rides
    // on the last of them: it is the variant's size either way.
    const packed = productSkuIndexSource({
      ...SKU,
      variant_json: { 颜色: '黑色+深灰+白色24-26', 成本价: '18' },
    });
    expect(packed.values).toEqual({
      variant: '云集防晒帽 颜色：黑色、深灰、白色\n云集防晒帽 尺码：24-26',
    });
  });

  it('leaves a colour cell it cannot read exactly as it found it', () => {
    // Every one of these is a row of this catalogue's colour column, and none of
    // them is a colour with a size the platform could read back: `kitty` and a
    // bare `L` name no colour, `图片色` and a whole labelled pair have no tail,
    // and the article number in `漫暮黑-165/72A(L)` is longer than any size this
    // vocabulary has. The rule may take a size off a colour; it may not guess at
    // a column it does not understand, and it may not shorten a line to move a
    // fact somewhere the platform will not look for it.
    for (const raw of [
      'kitty',
      '图片色',
      'L',
      '颜色: 漫暮黑,尺码: XL',
      '漫暮黑-165/72A(L)',
      '黑色镜框+灰色镜片-F(均码)',
    ]) {
      const input = productSkuIndexSource({ ...SKU, variant_json: { 颜色: raw } });
      expect(input.values).toEqual({ variant: `云集防晒帽 颜色：${raw}` });
    }
  });

  it('adds no second size to a variant that already states one', () => {
    // Three rows in this catalogue fill both columns. Reading a size off a colour
    // is not evidence enough to contradict the column that exists to carry it, so
    // the variant is left alone — its colour too, which is the price of the rule
    // being one rule rather than two.
    const both = productSkuIndexSource({
      ...SKU,
      variant_json: { 颜色: '漫暮黑L', 规格: 'M' },
    });
    expect(both.values).toEqual({
      variant: '云集防晒帽 颜色：漫暮黑L\n云集防晒帽 规格：M',
    });
  });

  it('keeps a variant without a title indexable, unprefixed', () => {
    // Not a shape the reader produces — its join always carries the title — but
    // the mapper must not invent one from the id, and the kernel must still get a
    // slice: a variant whose product row has a blank title is answerable by its
    // colour alone, which is worse recall and not a lost row.
    const blank = productSkuIndexSource({ ...SKU, spu_title: '   ' });
    const absent = productSkuIndexSource({ ...SKU, spu_title: null });

    expect(blank.values).toEqual({ variant: '颜色：冰雾粉\n规格：M' });
    expect(absent.values).toEqual({ variant: '颜色：冰雾粉\n规格：M' });
  });

  it('indexes a variant as unusable when it is inactive or its product is off the shelf', () => {
    expect(productSkuIndexSource({ ...SKU, status: 'inactive' }).enabled).toBe(false);
    // The variant's own row says nothing about the shelf — the join is where this
    // comes from, and without it a customer is offered a variant of a product the
    // merchant has taken down.
    expect(productSkuIndexSource({ ...SKU, spu_shelf_status: 'off_shelf' }).enabled).toBe(false);
  });
});
