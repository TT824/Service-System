/**
 * What a buyer's question is sorted into, and the four places where the honest
 * answer is a bucket the caller did not expect.
 *
 * The contract this file pins is that the three buckets are a **partition**: a
 * value lands in exactly one of them. Two of the tests exist because the failure
 * is not "a word goes missing" but "a word comes back in the wrong bucket":
 *
 *   * A rejected value must not also be a keyword — otherwise the recall path
 *     fetches precisely the thing the buyer ruled out.
 *   * A claimed value must not also be a keyword, however the buyer spelled the
 *     measure word around it (`XL码`).
 *
 * The third and fourth are the boundaries that look like gaps and are not:
 * `没有` / `不是` / `别` are **not** negations (they ask for something, and reading
 * them as rejections would file a wanted value as an excluded one), and a
 * one-character Chinese term is not a keyword (it recalls everything under
 * `pg_trgm` and distinguishes nothing).
 */

import { describe, expect, it } from 'vitest';
import { KNOWLEDGE_QUERY_MAX_KEYWORDS, parseKnowledgeQuery } from './knowledge-query';

const COLOR_AND_SIZE = [
  { text: '黑', kind: 'color' as const },
  { text: '白', kind: 'color' as const },
  { text: 'XL', kind: 'size' as const },
  { text: 'M', kind: 'size' as const },
];

const SIZES = [
  { text: 'S', kind: 'size' as const },
  { text: 'XS', kind: 'size' as const },
];

describe('parseKnowledgeQuery', () => {
  it('sorts one question into one bucket per value', () => {
    const parsed = parseKnowledgeQuery({
      text: '不要黑色的，有XL码的吗',
      vocabulary: COLOR_AND_SIZE,
    });

    expect(parsed.negations).toEqual([{ kind: 'color', text: '黑' }]);
    expect(parsed.attributes).toEqual([{ kind: 'size', text: 'XL' }]);
    expect(parsed.keywords).toEqual([]);
  });

  it('keeps a rejected value out of the keywords', () => {
    const parsed = parseKnowledgeQuery({ text: '不要黑色', vocabulary: COLOR_AND_SIZE });

    expect(parsed.negations).toEqual([{ kind: 'color', text: '黑' }]);
    expect(parsed.keywords).not.toContain('黑色');
    expect(parsed.keywords).toEqual([]);
  });

  it('rejects only the clause the cue is in', () => {
    const parsed = parseKnowledgeQuery({
      text: '不要黑色的，白色的有吗',
      vocabulary: COLOR_AND_SIZE,
    });

    expect(parsed.negations).toEqual([{ kind: 'color', text: '黑' }]);
    expect(parsed.attributes).toEqual([{ kind: 'color', text: '白' }]);
  });

  it('reads a rejection the buyer put after the value', () => {
    const parsed = parseKnowledgeQuery({ text: '黑色的不要', vocabulary: COLOR_AND_SIZE });

    expect(parsed.negations).toEqual([{ kind: 'color', text: '黑' }]);
    expect(parsed.keywords).toEqual([]);
  });

  it('splits a rejected value from the wanted one at the pivot verb', () => {
    const parsed = parseKnowledgeQuery({ text: '不要XL要M', vocabulary: COLOR_AND_SIZE });

    expect(parsed.negations).toEqual([{ kind: 'size', text: 'XL' }]);
    expect(parsed.attributes).toEqual([{ kind: 'size', text: 'M' }]);
    expect(parsed.keywords).toEqual([]);
  });

  it('reports a rejection it cannot classify with a null kind', () => {
    const parsed = parseKnowledgeQuery({ text: '不要加绒的' });

    expect(parsed.negations).toEqual([{ kind: null, text: '加绒' }]);
    expect(parsed.keywords).toEqual([]);
  });

  it('reads a labelled pair in the question as an attribute, not a keyword', () => {
    const parsed = parseKnowledgeQuery({ text: '颜色：黑，尺码：M' });

    expect(parsed.attributes).toEqual([
      { kind: 'color', text: '黑' },
      { kind: 'size', text: 'M' },
    ]);
    expect(parsed.keywords).toEqual([]);
  });

  it('matches a vocabulary value as a whole token, not as a substring', () => {
    const parsed = parseKnowledgeQuery({ text: '有XS码的吗', vocabulary: SIZES });

    expect(parsed.attributes).toEqual([{ kind: 'size', text: 'XS' }]);
    expect(parsed.keywords).toEqual([]);
  });

  it('keeps a term that merely ends in a classifier', () => {
    const parsed = parseKnowledgeQuery({ text: '大码的有吗' });

    expect(parsed.keywords).toEqual(['大码']);
  });

  it('does not invent an attribute the vocabulary never vouched for', () => {
    const parsed = parseKnowledgeQuery({
      text: '有黑色的吗',
      vocabulary: [{ text: '白', kind: 'color' }],
    });

    expect(parsed.attributes).toEqual([]);
    expect(parsed.keywords).toEqual(['黑色']);
  });

  it('keeps a dimension label out of the keywords', () => {
    const parsed = parseKnowledgeQuery({ text: '颜色有吗' });

    expect(parsed.keywords).toEqual([]);
    expect(parsed.attributes).toEqual([]);
  });

  it('reads an A-not-A question as a question, not as a rejection', () => {
    const parsed = parseKnowledgeQuery({ text: '要不要黑色的' });

    expect(parsed.negations).toEqual([]);
    expect(parsed.keywords).toEqual(['黑色']);
  });

  it('keeps a rejection that is spelled twice in a row', () => {
    // `不要` ends in `要`, so a second 「不要」 opens an A-not-A form one character
    // into the cue (`要·不·要`). Blanking that form erases the rejection and leaves
    // the rejected value as something to search *for* — the 错品 direction,
    // arriving as a parse rather than as a match.
    const parsed = parseKnowledgeQuery({ text: '不要不要XL', vocabulary: COLOR_AND_SIZE });

    expect(parsed.negations).toEqual([{ kind: 'size', text: 'XL' }]);
    expect(parsed.attributes).toEqual([]);
    expect(parsed.keywords).toEqual([]);
  });

  it('keeps a repeated rejection of a value the vocabulary names', () => {
    const parsed = parseKnowledgeQuery({ text: '不要不要黑色', vocabulary: COLOR_AND_SIZE });

    expect(parsed.negations).toEqual([{ kind: 'color', text: '黑' }]);
    expect(parsed.attributes).toEqual([]);
    expect(parsed.keywords).toEqual([]);
  });

  it('records one rejection once, not once per cue that claimed it', () => {
    const parsed = parseKnowledgeQuery({ text: '不要黑色的不要', vocabulary: COLOR_AND_SIZE });

    expect(parsed.negations).toEqual([{ kind: 'color', text: '黑' }]);
  });

  it('reads 有没有 as a question about the value, and leaves no term behind', () => {
    const parsed = parseKnowledgeQuery({ text: '有没有XL码', vocabulary: COLOR_AND_SIZE });

    expect(parsed.attributes).toEqual([{ kind: 'size', text: 'XL' }]);
    expect(parsed.negations).toEqual([]);
    expect(parsed.keywords).toEqual([]);
  });

  it('reads 别的颜色 as a question about other colours', () => {
    // The segmentation is a run, not a word — that is the documented boundary —
    // but the question is not a rejection, which is the point here.
    const parsed = parseKnowledgeQuery({ text: '别的颜色有吗' });

    expect(parsed.negations).toEqual([]);
    expect(parsed.attributes).toEqual([]);
    expect(parsed.keywords).toEqual(['别的颜色']);
  });

  it('answers an empty question with three empty buckets', () => {
    const parsed = parseKnowledgeQuery({ text: '   ' });

    expect(parsed).toEqual({ keywords: [], attributes: [], negations: [] });
  });

  it('caps the keywords and drops the tail', () => {
    const terms = Array.from({ length: 20 }, (_, index) => `k${index}term`);
    const parsed = parseKnowledgeQuery({ text: terms.join('，') });

    expect(parsed.keywords).toHaveLength(KNOWLEDGE_QUERY_MAX_KEYWORDS);
    expect(parsed.keywords[0]).toBe('k0term');
    expect(parsed.keywords).not.toContain('k19term');
  });
});
