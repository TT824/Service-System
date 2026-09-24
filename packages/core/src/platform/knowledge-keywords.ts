/**
 * Keywords: pull the searchable attributes out of a knowledge slice.
 *
 * This module owns the answer to "what is a keyword?" for the whole platform,
 * for the same reason `knowledge-chunker` owns "what is a slice?" — the indexer
 * writes these rows and retrieval matches against them, so a second copy of the
 * rule would give the platform two ideas of what an attribute is.
 *
 * Two passes, because the text knows two different things:
 *
 *   * **Labelled pairs** (`品牌：安踏`, `颜色：黑|白`) — the text names the
 *     dimension itself. Cheap and high-precision, and this is the shape the
 *     chunker's structured mode produces: one `名称：值` per line, because that
 *     is how merchants already write spec tables.
 *   * **Vocabulary hits** — the caller passes values it knows are attributes
 *     (a category's `allowed_values_json`, an observed `variant_json` value) and
 *     the pass reports the ones that actually occur in this slice. This is what
 *     catches a dimension the text never names.
 *
 * Neither pass needs a model, and neither needs a database: the vocabulary is an
 * argument, so the kernel stays a pure text function the web bundle can import
 * and the suite can drive without a fixture server.
 *
 * Three deliberate limits, each of which looks like a gap from the outside:
 *
 *   * **A label we cannot classify yields nothing.** The label vocabulary is
 *     open — any merchant may declare 袖长, and `0011`'s `keyword_kind` CHECK has
 *     no value for it. Emitting an unclassified keyword would fill the table with
 *     whatever preceded a colon: `温馨提示`, and `https` out of every URL. A
 *     value whose kind is genuinely unknown still gets in through the vocabulary
 *     pass as `other`, where the caller has vouched for it.
 *   * **No negation, and no parsing of buyer questions.** SDD-014 owns
 *     「从买家问题解析关键词、属性和否定词」. Extraction here reads merchant
 *     knowledge at index time; a negation parsed here would be stored as a
 *     property of the product, which is the opposite of what it means.
 *   * **No model-number guessing by pattern.** `A1234` looks like a 型号 and so
 *     does `XL`, a phone number and a SKU code. Tuning that trade-off needs the
 *     300–400 条评测集 SDD-014 builds and nothing builds yet; guessing now would
 *     be tuning blind. A 型号 is picked up when the text labels one
 *     (`型号：A1234`).
 */

/**
 * What a keyword is. Mirrors the `keyword_kind` CHECK in migration
 * `0011_knowledge_index` — the card's 品牌、品类、型号、颜色、尺码、材质、功效,
 * plus `other` for a value the caller vouches for but cannot classify.
 */
export type KeywordKind =
  'brand' | 'category' | 'model' | 'color' | 'size' | 'material' | 'effect' | 'other';

/** One extracted attribute: its dimension and the value as written. */
export type KnowledgeKeyword = {
  readonly kind: KeywordKind;
  readonly text: string;
};

/** A value the caller already knows to be an attribute of some dimension. */
export type KeywordVocabularyEntry = {
  readonly text: string;
  readonly kind: KeywordKind;
};

/** Input for {@link extractKeywords}. */
export type ExtractKeywordsInput = {
  readonly text: string;
  /** Values known to be attributes. Omitted means no vocabulary pass. */
  readonly vocabulary?: ReadonlyArray<KeywordVocabularyEntry> | undefined;
};

/**
 * How many keywords one slice may carry.
 *
 * A bound, not a target: the table is `(tenant_id, chunk_id, kind, text)` and an
 * unbounded pass over a long slice would let a single chunk write hundreds of
 * rows. A slice that reaches the cap is a signal that the slice is too big or
 * that the vocabulary is too loose — not a normal slice. Overflow is dropped
 * from the tail, which is where the low-confidence vocabulary hits sit.
 */
export const KNOWLEDGE_KEYWORD_MAX = 32;

/**
 * The longest value that can be a keyword.
 *
 * Past this a "value" is prose that happened to follow a colon — `注意：本店
 * 支持七天无理由退货…` — and truncating it would not make it a keyword. It is
 * skipped instead.
 */
export const KNOWLEDGE_KEYWORD_MAX_CHARS = 40;

/**
 * The one place a Chinese dimension name becomes a {@link KeywordKind}.
 *
 * Rows and not code is the right home for a merchant's *own* attributes (that is
 * why `product_category_attributes` exists), but this map is the opposite kind
 * of fact: the closed set of words the platform itself understands. Widening it
 * is a code change in one place, on purpose.
 *
 * `规格` is **absent** deliberately, though `规格：500ml` reads like a size. It is
 * as often a volume, a weight, a power rating or a pack count, and the schema's
 * `spec` is already the chunk type for "a spec, of whatever kind" — so
 * `规格：XL` would be mislabelled as a size a query for `XL` would then exact-match
 * on. It falls to nothing here and to `other` through the vocabulary pass.
 */
export const DIMENSION_ALIASES: Readonly<Record<string, KeywordKind>> = Object.freeze({
  品牌: 'brand',
  牌子: 'brand',
  厂商: 'brand',
  生产商: 'brand',
  制造商: 'brand',
  品类: 'category',
  类目: 'category',
  分类: 'category',
  类别: 'category',
  型号: 'model',
  货号: 'model',
  款号: 'model',
  机型: 'model',
  颜色: 'color',
  // Exact, because suffix matching would read this as 分类 and file a colour
  // under `category`. Taobao sheets use this header for the colour column.
  颜色分类: 'color',
  色彩: 'color',
  色号: 'color',
  色系: 'color',
  尺码: 'size',
  尺寸: 'size',
  码数: 'size',
  鞋码: 'size',
  材质: 'material',
  面料: 'material',
  成分: 'material',
  材料: 'material',
  功效: 'effect',
  功能: 'effect',
  作用: 'effect',
  效果: 'effect',
} satisfies Record<string, KeywordKind>);

/**
 * Classify a dimension name written by a merchant.
 *
 * An exact hit wins. Otherwise the longest alias that the name *ends with*
 * classifies it, which is what makes `商品颜色` and `产品品牌` work without a row
 * per compound. A name that matches neither is `null` and, from a label, yields
 * no keyword — see the module note on why a guess would be worse.
 *
 * @param name - A dimension name, as written (`颜色`, `商品颜色`, `颜色：`).
 * @returns The kind, or `null` when the name is outside the closed vocabulary.
 */
export function kindForDimension(name: string): KeywordKind | null {
  const normalized = normalize(name).replace(/[：:]$/u, '');
  if (normalized.length === 0) {
    return null;
  }
  const exact = DIMENSION_ALIASES[normalized];
  if (exact !== undefined) {
    return exact;
  }
  let bestAlias = '';
  let bestKind: KeywordKind | null = null;
  for (const [alias, kind] of Object.entries(DIMENSION_ALIASES)) {
    if (
      normalized.length > alias.length &&
      normalized.endsWith(alias) &&
      alias.length > bestAlias.length
    ) {
      bestAlias = alias;
      bestKind = kind;
    }
  }
  return bestKind;
}

/**
 * Build vocabulary entries from a variant map, classifying each dimension.
 *
 * The bridge between the catalogue's `variant_json` (`{ 颜色: '黑', 尺码: 'M' }`)
 * and this kernel, kept here so that the alias map stays in one file: a dimension
 * the map cannot classify becomes `other` rather than being dropped, because the
 * merchant did declare it and the value is genuinely an attribute of the product.
 *
 * @param variant - Dimension → value, as `product_skus.variant_json` stores it.
 * @returns One entry per dimension, in the map's own order.
 */
export function vocabularyFromVariant(
  variant: Readonly<Record<string, string>>,
): ReadonlyArray<KeywordVocabularyEntry> {
  const entries: KeywordVocabularyEntry[] = [];
  for (const [dimension, value] of Object.entries(variant)) {
    entries.push({ text: value, kind: kindForDimension(dimension) ?? 'other' });
  }
  return entries;
}

/**
 * Extract the attributes of one slice.
 *
 * Labelled pairs come first, in the order they appear; vocabulary hits follow, in
 * the vocabulary's order. Duplicates are dropped on `(kind, text)` with ASCII
 * case folded, keeping the first surface form met, so a slice never carries the
 * same attribute twice because two passes found it. At most
 * {@link KNOWLEDGE_KEYWORD_MAX} are returned.
 *
 * @param input - The slice text and, optionally, the values known to be attributes.
 * @returns The keywords, deduplicated and capped, in the order described above.
 */
export function extractKeywords(input: ExtractKeywordsInput): ReadonlyArray<KnowledgeKeyword> {
  const found: KnowledgeKeyword[] = [];
  const seen = new Set<string>();

  const push = (kind: KeywordKind, text: string): void => {
    if (found.length >= KNOWLEDGE_KEYWORD_MAX) {
      return;
    }
    const key = `${kind} ${text.toLowerCase()}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    found.push(Object.freeze({ kind, text } satisfies KnowledgeKeyword));
  };

  for (const match of input.text.matchAll(LABELLED_PAIR)) {
    const label = match[1] ?? '';
    const rawValue = match[2] ?? '';
    const kind = kindForDimension(label);
    if (kind === null) {
      continue;
    }
    const value = normalize(rawValue);
    if (value.length === 0 || countChars(value) > KNOWLEDGE_KEYWORD_MAX_CHARS) {
      continue;
    }
    push(kind, value);
  }

  for (const entry of input.vocabulary ?? []) {
    const value = normalize(entry.text);
    if (value.length === 0 || countChars(value) > KNOWLEDGE_KEYWORD_MAX_CHARS) {
      continue;
    }
    if (!occurs(input.text, value)) {
      continue;
    }
    push(entry.kind, value);
  }

  return found;
}

/**
 * A `名称：值` pair, anywhere in the text rather than line-anchored, because a
 * merchant's prose says `…。品牌：安踏。` as readily as a spec table does.
 *
 * The value is a **tempered** run: it stops at sentence punctuation, and it stops
 * before anything that begins a new pair. That second clause is what makes
 * `颜色：黑 尺码：M` yield two keywords instead of a `颜色` of `黑 尺码` — the
 * space in the middle is part of neither rule, so the value has to end there on
 * its own.
 *
 * `|` and `/` are **not** terminators, and that is the same finding the chunker
 * recorded: `黑|白` and `S/M/L` are single values with a separator inside them,
 * so cutting here would produce a well-formed-looking keyword that no query would
 * ever need. `；` and `，` *are* terminators: a writer uses them to end a value,
 * where `|` is used inside one.
 */
const LABELLED_PAIR =
  /([\p{Script=Han}A-Za-z]{1,6})[：:]((?:(?![\p{Script=Han}A-Za-z]{1,6}[：:])[^\n；;，,。、！!？?：:])+)/gu;

/**
 * Whether `needle` occurs in `haystack` as a token rather than inside a longer
 * word, when `needle` is pure ASCII alphanumerics.
 *
 * The case that forces this: size `L` is a substring of `XL`, so a vocabulary
 * holding both would report `XL` as a match for `L` and exact-match a large
 * against a customer asking for XL — precisely the 错品 SDD-014 caps at 5%. A
 * Chinese value needs no such guard; it is not a fragment of a longer Chinese
 * word in the way `L` is a fragment of `XL`.
 */
function occurs(haystack: string, needle: string): boolean {
  if (!/^[A-Za-z0-9]+$/u.test(needle)) {
    return haystack.includes(needle);
  }
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) {
      return false;
    }
    const before = at === 0 ? '' : (haystack[at - 1] ?? '');
    const after = haystack[at + needle.length] ?? '';
    if (!isAsciiAlphanumeric(before) && !isAsciiAlphanumeric(after)) {
      return true;
    }
    from = at + 1;
  }
}

/** Trim, and collapse internal whitespace runs so `100%  纯棉` reads as written. */
function normalize(text: string): string {
  return text.trim().replace(/\s+/gu, ' ');
}

function isAsciiAlphanumeric(character: string): boolean {
  return /^[A-Za-z0-9]$/u.test(character);
}

/** Length in Unicode code points, matching the chunker's counter. */
function countChars(text: string): number {
  return Array.from(text).length;
}
