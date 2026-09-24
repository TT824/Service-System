/**
 * What one slice is: the ceiling, the boundary, and the two cases where the
 * kernel deliberately gives up a nice property.
 *
 * The two give-ups are the point of this file, because both look like bugs from
 * the outside and neither is one:
 *
 *   * A prose slice **shorter than the target** is allowed, because the only
 *     ways to reach the target are to cross the ceiling or to cut a long
 *     sentence early. Pinned by "allows a short slice when the text gives no
 *     better break".
 *   * A structured item **longer than the ceiling** stays whole, because the
 *     alternative is splitting a spec name from its value. Pinned by "keeps an
 *     over-long structured item whole".
 *
 * The regression that nearly shipped lives here too: `;` `；` and `|` read like
 * item separators but appear inside values, so splitting on them breaks the very
 * thing the card protects. See "does not split a structured value on `;` or `|`".
 */

import { describe, expect, it } from 'vitest';
import {
  KNOWLEDGE_CHUNK_CONTEXT_CHARS,
  KNOWLEDGE_CHUNK_MAX_CHARS,
  KNOWLEDGE_CHUNK_TARGET_CHARS,
  chunkField,
  chunkProse,
  chunkSource,
  chunkStructured,
  countChars,
} from './knowledge-chunker';

/** A sentence of `size` code points ending in a full stop: `size + 1` total. */
function sentence(character: string, size: number): string {
  return `${character.repeat(size)}。`;
}

const PROSE_FIELD = { field: 'answer', chunkType: 'answer', mode: 'prose' } as const;
const STRUCTURED_FIELD = { field: 'spec', chunkType: 'spec', mode: 'structured' } as const;

describe('chunkProse', () => {
  it('leaves a field that fits entirely within one slice as one slice', () => {
    const text = '本店支持七天无理由退货。';
    expect(chunkProse(text)).toEqual([text]);
  });

  it('never produces a slice longer than the ceiling', () => {
    const text = sentence('甲', 180).repeat(9);
    const slices = chunkProse(text);
    expect(slices.length).toBeGreaterThan(1);
    for (const slice of slices) {
      expect(countChars(slice)).toBeLessThanOrEqual(KNOWLEDGE_CHUNK_MAX_CHARS);
    }
    expect(slices.join('')).toBe(text);
  });

  it('breaks at a sentence boundary rather than mid-sentence', () => {
    // 181 + 181 + 181 = 543, over the ceiling; the first two fit together (362).
    const text = sentence('甲', 180) + sentence('乙', 180) + sentence('丙', 180);
    const slices = chunkProse(text);
    expect(slices.map(countChars)).toEqual([362, 181]);
    expect(slices[0]?.endsWith('。')).toBe(true);
    expect(slices[1]?.endsWith('。')).toBe(true);
  });

  it('allows a short slice when the text gives no better break', () => {
    // 100 + 450 = 550. Emitting 550 would cross the ceiling and cutting the 450
    // early would break a sentence, so the first slice stays short.
    const text = sentence('甲', 99) + sentence('乙', 449);
    const slices = chunkProse(text);
    expect(slices.map(countChars)).toEqual([100, 450]);
    expect(countChars(slices[0] ?? '')).toBeLessThan(KNOWLEDGE_CHUNK_TARGET_CHARS);
  });

  it('cuts a single sentence longer than the ceiling at the ceiling', () => {
    const text = sentence('丙', 1199);
    const slices = chunkProse(text);
    expect(slices.map(countChars)).toEqual([500, 500, 200]);
    expect(slices.join('')).toBe(text);
  });

  it('splits by code points, never halving a surrogate pair', () => {
    // Counting UTF-16 units would put 250 emoji in a "500" slice and leave a
    // lone surrogate at the seam.
    const slices = chunkProse('😀'.repeat(600));
    expect(slices.map(countChars)).toEqual([500, 100]);
    for (const slice of slices) {
      expect(slice).toBe('😀'.repeat(countChars(slice)));
    }
  });

  it('counts a character outside the BMP as one', () => {
    expect(countChars('😀')).toBe(1);
    expect(countChars('中文')).toBe(2);
  });
});

describe('chunkStructured', () => {
  it('makes one slice per line', () => {
    expect(chunkStructured('材质：纯棉\n尺码：S/M/L')).toEqual(['材质：纯棉', '尺码：S/M/L']);
  });

  it('does not split a structured value on `;` or `|`', () => {
    // Splitting here would yield `颜色：黑` and `白` — a spec name separated from
    // its value, which is the failure the card forbids and which still looks
    // well-formed from either half.
    expect(chunkStructured('颜色：黑|白\n尺码：S/M/L；XL 缺货')).toEqual([
      '颜色：黑|白',
      '尺码：S/M/L；XL 缺货',
    ]);
  });

  it('keeps an over-long structured item whole', () => {
    const item = `规格：${'很'.repeat(600)}`;
    const slices = chunkStructured(item);
    expect(slices).toEqual([item]);
    expect(countChars(slices[0] ?? '')).toBeGreaterThan(KNOWLEDGE_CHUNK_MAX_CHARS);
  });

  it('drops blank lines instead of emitting empty slices', () => {
    expect(chunkStructured('材质：纯棉\n\n  \n尺码：XL')).toEqual(['材质：纯棉', '尺码：XL']);
  });
});

describe('chunkField', () => {
  it('returns nothing for a blank value', () => {
    expect(chunkField('faq', 'f1', PROSE_FIELD, '   \n  ')).toEqual([]);
  });

  it('attaches the neighbouring edges as context, absent at the ends', () => {
    const drafts = chunkField('faq', 'f1', PROSE_FIELD, sentence('丙', 1199));
    expect(drafts.map((draft) => draft.chunkIndex)).toEqual([0, 1, 2]);
    expect(drafts[0]?.contextBefore).toBeNull();
    expect(drafts[2]?.contextAfter).toBeNull();
    expect(drafts[1]?.contextBefore).toBe(drafts[0]?.content.slice(-KNOWLEDGE_CHUNK_CONTEXT_CHARS));
    expect(drafts[1]?.contextAfter).toBe(
      drafts[2]?.content.slice(0, KNOWLEDGE_CHUNK_CONTEXT_CHARS),
    );
  });

  it('caps the context it carries', () => {
    const drafts = chunkField('faq', 'f1', PROSE_FIELD, sentence('丙', 1199));
    for (const draft of drafts) {
      for (const edge of [draft.contextBefore, draft.contextAfter]) {
        if (edge !== null) {
          expect(countChars(edge)).toBeLessThanOrEqual(KNOWLEDGE_CHUNK_CONTEXT_CHARS);
        }
      }
    }
  });

  it('reports charCount in code points and carries the field identity', () => {
    const drafts = chunkField('faq', 'faq-1', PROSE_FIELD, '退货政策：七天无理由。');
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      sourceKind: 'faq',
      sourceId: 'faq-1',
      sourceField: 'answer',
      chunkType: 'answer',
      chunkIndex: 0,
      charCount: 11,
    });
    expect(drafts[0]?.charCount).toBe(countChars(drafts[0]?.content ?? ''));
  });
});

describe('chunkSource', () => {
  it('slices the mapped fields in order and restarts chunkIndex per field', () => {
    const drafts = chunkSource({
      sourceKind: 'faq',
      sourceId: 'faq-1',
      values: { question: '怎么退货？', answer: '七天无理由。' },
    });
    expect(drafts.map((draft) => [draft.sourceField, draft.chunkType, draft.chunkIndex])).toEqual([
      ['question', 'question', 0],
      ['answer', 'answer', 0],
    ]);
  });

  it('skips a field that is absent or blank rather than emitting an empty slice', () => {
    const absent = chunkSource({ sourceKind: 'faq', sourceId: 'faq-1', values: {} });
    expect(absent).toEqual([]);
    const blank = chunkSource({
      sourceKind: 'shortcut',
      sourceId: 'sc-1',
      values: { title: '  ', content: '欢迎光临。' },
    });
    expect(blank.map((draft) => draft.sourceField)).toEqual(['content']);
  });

  it('gives an faq variant one question slice', () => {
    const drafts = chunkSource({
      sourceKind: 'faq_variant',
      sourceId: 'v-1',
      values: { question_text: '怎么退换货？' },
    });
    expect(drafts.map((draft) => [draft.sourceField, draft.chunkType])).toEqual([
      ['question_text', 'question'],
    ]);
  });

  it('produces a slice per line for a structured field', () => {
    const drafts = chunkField('shortcut', 'sc-1', STRUCTURED_FIELD, '材质：纯棉\n尺码：S/M/L');
    expect(drafts.map((draft) => draft.content)).toEqual(['材质：纯棉', '尺码：S/M/L']);
    expect(drafts.map((draft) => draft.chunkIndex)).toEqual([0, 1]);
  });
});
