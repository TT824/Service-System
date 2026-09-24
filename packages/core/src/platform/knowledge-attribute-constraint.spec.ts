/**
 * What the attribute constraint keeps, and the ways it can look right while
 * having done nothing.
 *
 * The failure this kernel has to be protected from is not a crash — it is the
 * quiet one. A constraint that never fires returns the fused list and reads
 * exactly like a constraint that fires and agrees with fusion; a normalizer that
 * strips one character too many turns every value into the same value and the
 * filter then keeps everything. So most of the cases here are built so that the
 * *lazy* implementation and the one under test disagree:
 *
 *   * **The values are chosen to be un-alike.** The wrong-colour candidate is
 *     always the one fusion ranked *better*, so "kept the right slice" and "kept
 *     the original order" are different answers and only one of them passes.
 *   * **The size case turns on token equality.** `2XL` contains `XL`, so a query
 *     naming `2XL` is precisely the input where a substring match on a size would
 *     filter to the wrong one. The fixture has both, and the assertion is which.
 *   * **The fallback is reached through the rejecting path**, because the naming
 *     path cannot empty the list — see the last case's note. A test that reached
 *     for an empty result through `named` would pass on a suite where the
 *     fallback was never wired at all.
 *   * **A slice with no colour is kept.** That is the decision the module makes
 *     and the one most likely to be "fixed" by someone reading it later, so it
 *     is asserted rather than left to the module note.
 *
 * The normalizers are tested against the merchant's own strings — the ones this
 * catalogue actually contains, copied out of `knowledge_chunk_keywords` on
 * 2026-09-21 — because the rule exists for them and not for tidy input.
 */

import { describe, expect, it } from 'vitest';
import type { FusedRecallHit } from './knowledge-fusion';
import {
  constrainRecallByAttribute,
  normalizeColourValues,
  normalizeSizeValues,
  sliceAttributeValues,
  splitColourCell,
} from './knowledge-attribute-constraint';
import type { RecalledChunk } from './knowledge-recall';

/** One fused hit whose slice content is the only thing a case cares about. */
function hit(id: string, content: string): FusedRecallHit {
  const chunk: RecalledChunk = {
    id,
    tenantId: 'tenant-1',
    storeId: 'store-1',
    scopeType: 'store',
    sourceKind: 'product_sku',
    sourceId: `source-of-${id}`,
    sourceField: 'variant',
    chunkType: 'variant',
    chunkIndex: 0,
    content,
  };
  return {
    chunk,
    score: 1,
    ranks: { keyword: 1, semantic: null },
    modes: ['keyword'],
  };
}

/** The ids of a hit list, in order — what most cases assert. */
function ids(hits: ReadonlyArray<FusedRecallHit>): ReadonlyArray<string> {
  return hits.map((entry) => entry.chunk.id);
}

describe('normalizeColourValues', () => {
  it('strips the size that rides along with the colour', () => {
    expect(normalizeColourValues('漫暮黑L')).toEqual(['漫暮黑']);
    expect(normalizeColourValues('乌云灰S')).toEqual(['乌云灰']);
    expect(normalizeColourValues('深咖灰160/68A(M)')).toEqual(['深咖灰']);
    // The size can be a run of two numbers, and `/` is a separator because
    // `S/M/L` is one cell holding three sizes — so the value is cut at the
    // slash before the suffix is stripped, and what is left of the colour is
    // clean. The tail that is not Chinese is refused along with its note.
    expect(normalizeColourValues('樱灰粉155/64A(S)设计款2')).toEqual(['樱灰粉']);
  });

  it('splits a multi-pack into its values', () => {
    expect(normalizeColourValues('黑色+深灰+烟灰+浅灰+白色24-26')).toEqual([
      '黑色',
      '深灰',
      '烟灰',
      '浅灰',
      '白色',
    ]);
    expect(normalizeColourValues('黑色、白色')).toEqual(['黑色', '白色']);
  });

  it('answers with nothing when the cell holds no colour', () => {
    expect(normalizeColourValues('')).toEqual([]);
    expect(normalizeColourValues('F')).toEqual([]);
    expect(normalizeColourValues('黑色')).toEqual(['黑色']);
  });
});

describe('normalizeSizeValues', () => {
  it('reads the size in front of its bracket, one entry per semicolon', () => {
    expect(normalizeSizeValues('L (95-120斤);XL (120-140斤)')).toEqual(['L', 'XL']);
    expect(normalizeSizeValues('F')).toEqual(['F']);
  });

  it('refuses what is not a size', () => {
    expect(normalizeSizeValues('均码通用')).toEqual([]);
    expect(normalizeSizeValues('')).toEqual([]);
  });
});

describe('sliceAttributeValues', () => {
  it('reads the labelled line the indexer wrote, title and all', () => {
    expect(sliceAttributeValues('26SS-蕉下女士高弹防晒袖套ES005 颜色：漫暮黑', 'color')).toEqual([
      '漫暮黑',
    ]);
  });

  it('reads through a label written a second time inside the value', () => {
    // A real slice: the merchant's variant column held the whole pair as one
    // string, so the colour column's *value* is `颜色: 漫暮黑,尺码: F`.
    expect(
      sliceAttributeValues('CC福利品-2 颜色：颜色: 漫暮黑,尺码: F', 'color'),
    ).toEqual(['漫暮黑']);
    // And the second label in that same value is a real size, read as one. A
    // reader that took the whole line as the colour would have answered `[]`
    // here and `[]` above — the same answer for both dimensions, which is the
    // shape of a reader that has stopped reading.
    expect(sliceAttributeValues('CC福利品-2 颜色：颜色: 漫暮黑,尺码: F', 'size')).toEqual(['F']);
  });

  it('keeps the dimensions apart', () => {
    const content = '某商品 颜色：炭黑 尺码：XL';
    expect(sliceAttributeValues(content, 'color')).toEqual(['炭黑']);
    expect(sliceAttributeValues(content, 'size')).toEqual(['XL']);
    // `规格` has no label in `DIMENSION_ALIASES` and so is not a dimension.
    expect(sliceAttributeValues('某商品 规格：500ml', 'size')).toEqual([]);
  });

  it('answers with nothing when the slice carries no such line', () => {
    expect(sliceAttributeValues('这件衣服怎么洗？', 'color')).toEqual([]);
  });

  it('reads both lines when one slice carries two colours', () => {
    expect(sliceAttributeValues('某商品 颜色：黑色\n颜色：白色', 'color')).toEqual(['黑色', '白色']);
  });
});

describe('constrainRecallByAttribute', () => {
  /** Fusion put the wrong colour first, so the order is part of the answer. */
  const pool = [
    hit('grey', '有棵树内裤 颜色：浅炭灰S'),
    hit('black', '有棵树内裤 颜色：漫暮黑L'),
    hit('faq', '这件内裤怎么洗？'),
  ];

  it('keeps the named colour and the slices that carry none', () => {
    const outcome = constrainRecallByAttribute({ hits: pool, query: '有棵树内裤 漫暮黑' });
    expect(ids(outcome.hits)).toEqual(['black', 'faq']);
    expect(outcome.asked).toEqual(['漫暮黑']);
    expect(outcome.dropped).toBe(1);
    expect(outcome.applied).toBe(true);
    expect(outcome.mode).toBe('named');
  });

  it('does nothing when the question names no colour in front of it', () => {
    const outcome = constrainRecallByAttribute({ hits: pool, query: '有棵树内裤怎么洗' });
    expect(ids(outcome.hits)).toEqual(ids(pool));
    expect(outcome.asked).toEqual([]);
    expect(outcome.dropped).toBe(0);
    expect(outcome.applied).toBe(false);
    expect(outcome.mode).toBe('none');
  });

  it('drops the rejected colour and keeps the rest', () => {
    const outcome = constrainRecallByAttribute({ hits: pool, query: '不要漫暮黑' });
    expect(ids(outcome.hits)).toEqual(['grey', 'faq']);
    expect(outcome.negated).toEqual(['漫暮黑']);
    expect(outcome.applied).toBe(true);
    expect(outcome.mode).toBe('rejected');
  });

  it('lets the cue decide when the question both names and rejects a colour', () => {
    // The comma is load-bearing and belongs to `knowledge-query`, not here: a
    // negation reaches to the end of its clause, so 「不要漫暮黑 要浅炭灰」 with a
    // space is *one* clause and both colours are rejected. Written the way a
    // buyer writes it, the second clause is not negative and decides the filter.
    const outcome = constrainRecallByAttribute({ hits: pool, query: '不要漫暮黑，要浅炭灰' });
    expect(ids(outcome.hits)).toEqual(['grey', 'faq']);
    expect(outcome.asked).toEqual(['浅炭灰']);
    expect(outcome.mode).toBe('named');
  });

  it('matches a size as a whole token', () => {
    const sizes = [
      hit('big', '潮流书包 尺码：2XL'),
      hit('regular', '潮流书包 尺码：XL'),
    ];
    const outcome = constrainRecallByAttribute({ hits: sizes, query: '潮流书包 2XL' });
    expect(ids(outcome.hits)).toEqual(['big']);
    expect(outcome.asked).toEqual(['2XL']);
  });

  it('falls back to the list it was given rather than answering nothing', () => {
    // Reachable only through the rejecting path: a *named* value is by
    // construction one the pool carries, so filtering to it always leaves at
    // least one candidate. A rejection has no such guarantee — here every
    // candidate is the colour the buyer refused. The fallback is the whole
    // list, and `applied` is how the caller is told it did not happen.
    const refused = [hit('black', '有棵树内裤 颜色：漫暮黑L')];
    const outcome = constrainRecallByAttribute({ hits: refused, query: '不要漫暮黑' });
    expect(ids(outcome.hits)).toEqual(['black']);
    expect(outcome.dropped).toBe(0);
    expect(outcome.applied).toBe(false);
    expect(outcome.mode).toBe('none');
  });

  it('is total over an empty pool', () => {
    const outcome = constrainRecallByAttribute({ hits: [], query: '有棵树内裤 漫暮黑' });
    expect(outcome.hits).toEqual([]);
    expect(outcome.applied).toBe(false);
  });
});

/**
 * The same cells, read for the size the colour was glued to.
 *
 * This is the writer's half of the rule — `knowledge/index-source.ts` rewrites
 * the slice text from what this returns — so the colours themselves are not the
 * interesting part (`normalizeColourValues` already owns those, and these are its
 * strings). What is pinned is the two ways the *size* can be wrong: taken off a
 * cell that is not a colour at all, or handed back in a shape the size reader
 * cannot read off the line about to be written.
 */
describe('splitColourCell', () => {
  it('takes the trailing size off the merchant’s own cells', () => {
    expect(splitColourCell('漫暮黑L')).toEqual({ colors: ['漫暮黑'], size: 'L' });
    expect(splitColourCell('乌云灰S')).toEqual({ colors: ['乌云灰'], size: 'S' });
    // The separator goes with the size it introduced.
    expect(splitColourCell('漫暮黑-165/72A(L)')).toEqual({ colors: ['漫暮黑'], size: null });
  });

  it('keeps `/` as a colour separator', () => {
    // The reason the tail has to be read off the whole cell: this `/` really does
    // separate two colours, and both ends of the rule have to agree on which. An
    // article number carries the same character, so a rule that read the tail off
    // the last separated part would call `漫暮黑-160/84A(M)` two values.
    expect(splitColourCell('黑色/白色')).toEqual({ colors: ['黑色', '白色'], size: null });
    expect(splitColourCell('黑色/白色24-26')).toEqual({
      colors: ['黑色', '白色'],
      size: '24-26',
    });
  });

  it('takes nothing apart when a part of the cell is not a colour', () => {
    // A real row, and the one that says why this guard exists: taken apart part
    // by part it is the colour `黑色镜框` and the size `)` — the second colour
    // deleted and a bracket written into the line as a size. The colours are
    // still reported (the cell does name one), and `size: null` is what tells the
    // writer to leave the whole line as the merchant wrote it.
    expect(splitColourCell('黑色镜框+灰色镜片-F(均码)')).toEqual({
      colors: ['黑色镜框'],
      size: null,
    });
  });

  it('takes the size off the last colour of a multi-pack and leaves the others whole', () => {
    expect(splitColourCell('黑色+深灰+烟灰+浅灰+白色24-26')).toEqual({
      colors: ['黑色', '深灰', '烟灰', '浅灰', '白色'],
      size: '24-26',
    });
  });

  it('reports no size for a cell that is not a colour', () => {
    // All three are rows of this catalogue's colour column. The colour rule is
    // the whole of the evidence that a size was glued on, so a cell that names no
    // colour has no tail to move — however much its tail looks like one.
    expect(splitColourCell('kitty')).toEqual({ colors: [], size: null });
    expect(splitColourCell('30ml')).toEqual({ colors: [], size: null });
    expect(splitColourCell('L')).toEqual({ colors: [], size: null });
  });

  it('reports no size when the colour is whole', () => {
    expect(splitColourCell('黑色')).toEqual({ colors: ['黑色'], size: null });
  });
});
