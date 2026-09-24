/**
 * Which parts of a product may be put in front of a customer — the one list.
 *
 * The catalogue holds more than a shop assistant may say. `成本价` (cost) and
 * `批发供货价` (wholesale) sit in the merchant's own spreadsheet a few columns
 * from `售价`, and the buyer is the last person who should ever see them. So the
 * rule here is a **whitelist**: a column is shown because it is named below, and
 * a column nobody named is not shown — including the one added next week. A
 * blacklist would be one rename away from leaking a purchase price, and the leak
 * would be invisible, because it would arrive looking like a normal answer.
 *
 * Both ends of the knowledge chain read this list, and that is the point of the
 * file: the Worker composes **chunk text** from these attributes (the surface
 * recall matches against) and the API composes the **answer text** from them (the
 * material a model rewrites). Two copies would drift, and this drift is the
 * silent kind — indexed but unanswerable, or answerable but unindexed — so there
 * is one copy and both import it.
 *
 * ### The names are the extractor's, not the merchant's
 *
 * A slice's keywords come from the labelled pairs its own text carries
 * ({@link extractKeywords}), so the labels below are chosen from
 * `DIMENSION_ALIASES` — the closed vocabulary the platform understands. `品牌`
 * and `分类` are both in it. `规格` is **deliberately not** (see that file's note:
 * it is as often a volume or a pack count as a size), so a `规格：M` line is still
 * sliced and still searchable as text, it simply yields no dimension keyword.
 * That is the intended behaviour and not a bug to fix here.
 *
 * The label doubling as the merchant's own column name is a coincidence of this
 * vocabulary, not a rule: what the merchant calls a column is `COLUMNS` in the
 * import scripts' business, and nothing in this file reads a spreadsheet.
 */

import { splitColourCell } from './knowledge-attribute-constraint';

/** Product attributes a customer may be told. Order is the order they are written. */
export const CUSTOMER_VISIBLE_SPU_ATTRIBUTES = ['品牌', '分类'] as const;

/**
 * Variant attributes a customer may be told.
 *
 * `尺码` and `规格` are both listed although only one is likely to be filled:
 * the catalogue's own convention (`catalog.ts`) is `{颜色, 尺码}`, while this
 * merchant's sheet writes `规格`. Listing both means neither vocabulary is
 * silently dropped, and a file that fills neither simply produces no line.
 */
export const CUSTOMER_VISIBLE_SKU_ATTRIBUTES = ['颜色', '规格', '尺码'] as const;

/**
 * Variant *facts* a customer may be told.
 *
 * Kept apart from the attributes above because they are answered from, not
 * searched on: no label here is a dimension in `DIMENSION_ALIASES`, so a slice
 * built from these lines would carry no keyword and recall nothing. They are
 * composed into the answer text — which is where "多少钱" is actually answered,
 * once the product itself has been recalled by its name, brand or colour.
 */
export const CUSTOMER_VISIBLE_SKU_FACTS = ['售价', '吊牌价', '库存'] as const;

/** An attribute map as the catalogue stores it: dimension → value. */
export type AttributeMap = Readonly<Record<string, string>>;

/**
 * Read a `jsonb` attribute column the way both ends need it.
 *
 * `pg` hands `jsonb` back already parsed, but a row built by a test, a fixture or
 * a script can arrive as the JSON *string* — and a column typed `TEXT` in some
 * future migration would too. Both are read. Anything that is not an object, and
 * any value that is not a scalar, is dropped rather than stringified: a nested
 * object rendered as `[object Object]` in a customer-facing line is worse than a
 * missing line.
 *
 * @param value - A `common_attributes_json` / `variant_json` / `search_attributes_json` value.
 * @returns The dimension → value map, possibly empty.
 */
export function toAttributeMap(value: unknown): AttributeMap {
  let parsed: unknown = value;
  if (typeof parsed === 'string') {
    const text = parsed.trim();
    if (text.length === 0) {
      return {};
    }
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      return {};
    }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {};
  }
  const map: Record<string, string> = {};
  for (const [name, raw] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') {
      const text = String(raw).trim();
      if (text.length > 0) {
        map[name] = text;
      }
    }
  }
  return map;
}

/**
 * Write the named attributes as labelled lines, skipping the ones that are blank.
 *
 * One `标签：值` per entry, in the order the names were given — never in the map's
 * own key order, which would make the text depend on the order a spreadsheet
 * happened to be written in.
 *
 * A name the map does not carry, or carries blank, produces no entry. This is the
 * whole reason the function exists: the alternative — `Object.entries()` over
 * whatever the merchant sent — puts `成本价` in a customer's answer the day the
 * import learns to read it.
 *
 * @param attributes - The attribute map, as stored.
 * @param names - The whitelisted names to write, in order.
 * @returns One line per attribute that had a value, possibly empty.
 */
export function labelledEntries(
  attributes: AttributeMap,
  names: readonly string[],
): ReadonlyArray<string> {
  const lines: string[] = [];
  for (const name of names) {
    const value = attributes[name];
    if (value === undefined || value.trim().length === 0) {
      continue;
    }
    lines.push(`${name}：${value.trim()}`);
  }
  return lines;
}

/** The one variant attribute that is a colour. */
const COLOUR_ATTRIBUTE = '颜色';

/** The variant attributes that state a size, in the order the line is added under. */
const SIZE_ATTRIBUTES: ReadonlyArray<string> = Object.freeze(['尺码', '规格']);

/**
 * The variant attributes with the size moved off the colour it was glued to.
 *
 * A third of this catalogue's colour cells are not a colour but a whole variant:
 * `漫暮黑L`, `乌云灰S`, `漫暮黑-165/72A(L)`. Left as they are, the slice text is
 * `颜色：漫暮黑L`, and the word the buyer named is stuck to a size — which is the
 * string the reranker is asked to score and the string the keyword leg cuts into
 * terms. So the cell is split: the colour line keeps the colours
 * ({@link splitColourCell} does the reading, and it is the same rule
 * {@link normalizeColourValues} has always applied), and the tail becomes a
 * `尺码：` line of its own.
 *
 * **Only a size that has somewhere to go is moved.** A cell with no colour
 * (`kitty`, `图片色`, a bare `L`), a tail the size reader cannot read back
 * (`165/72A(L)`), and a variant that already states its size of its own are all
 * returned exactly as they came in. The rule may take a size off a colour; it may
 * not guess at a column it does not understand, and it may not shorten a line to
 * move a fact to a place the platform will not look. What that costs is stated
 * rather than hidden: the cells left alone are counted in the plan of
 * 2026-09-21, and the transform is idempotent, so a slice it has already split
 * is not split twice.
 *
 * @param attributes - The attribute map, as stored.
 * @returns The same map, with `尺码` added when a size was moved off `颜色`.
 */
export function separateColourAndSize(attributes: AttributeMap): AttributeMap {
  const colour = attributes[COLOUR_ATTRIBUTE];
  if (colour === undefined) {
    return attributes;
  }
  const { colors, size } = splitColourCell(colour);
  const declared = SIZE_ATTRIBUTES.some((name) => (attributes[name] ?? '').trim().length > 0);
  if (size === null || declared || colors.length === 0) {
    return attributes;
  }
  return {
    ...attributes,
    [COLOUR_ATTRIBUTE]: colors.join('、'),
    [SIZE_ATTRIBUTES[0] as string]: size,
  };
}

/**
 * The same entries as one block of text, one per line.
 *
 * A line is the unit the chunker cuts structured text on (`chunkStructured`), so
 * each attribute becomes its own slice and no slice can pair a name with the
 * wrong value. That is why the two functions above and below both exist rather
 * than only this one: the answer text wants the entries to lay out differently
 * (see the retrieval layer's product candidates), and splitting a joined string
 * to recover them would be a second, lossier definition of an entry.
 *
 * @param attributes - The attribute map, as stored.
 * @param names - The whitelisted names to write, in order.
 * @returns The lines joined by `\n`, or `''` when nothing was written.
 */
export function labelledLines(attributes: AttributeMap, names: readonly string[]): string {
  return labelledEntries(attributes, names).join('\n');
}
