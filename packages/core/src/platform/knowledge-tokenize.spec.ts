/**
 * What the tokenizer cuts, and the cuts that look right while being wrong.
 *
 * A tokenizer is the second-easiest kind of code to test badly, after a sort:
 * almost any rule produces *some* tokens, so a suite that only checks that the
 * words it wanted came out proves nothing about the rules that decide where a
 * token *ends*. Every case below is one where a plausible implementation returns
 * a different — and still non-empty, still plausible-looking — list:
 *
 *   * **`XL` against `XLL`.** This is the whole reason the tokenizer exists in
 *     the shape it does. A run-keeping implementation separates them; a
 *     character-window implementation that ignored script would produce `xl` and
 *     `xl` from the second, and the 错品 the kernel's partition was built to
 *     prevent would come back through the scorer.
 *   * **`颜色：冰雾粉`.** The punctuation test. Reading "Chinese" as "not ASCII"
 *     emits `色：` and `：冰`, which no query can ever produce; the assertions
 *     name those two tokens so that an implementation which emits them fails
 *     here rather than silently diluting the length normalisation.
 *   * **`有棵树YSPJ1143`.** The script boundary. A window rule that skipped the
 *     script test would emit `树Y`, a token that belongs to neither the title nor
 *     the code.
 *   * **`加大码女款` against `加大码`.** Partial credit, which is the property
 *     that makes bigrams worth their noise. A whole-run rule scores it zero.
 *   * **A lone `L`.** The asymmetry with a lone Chinese character: one is a size,
 *     the other is a term that recalls the whole catalogue.
 */

import { describe, expect, it } from 'vitest';
import { tokenizeKnowledgeQuery, tokenizeKnowledgeText } from './knowledge-tokenize';

describe('tokenizeKnowledgeText', () => {
  it('keeps an ASCII run whole and folds its case', () => {
    expect(tokenizeKnowledgeText('规格：170/100(XL)')).toEqual(['规格', '170', '100', 'xl']);
  });

  it('separates XL from XLL', () => {
    const size = tokenizeKnowledgeText('XL');
    const larger = tokenizeKnowledgeText('XLL');
    expect(size).toEqual(['xl']);
    expect(larger).toEqual(['xll']);
    expect(size.filter((token) => larger.includes(token))).toEqual([]);
  });

  it('cuts Chinese into adjacent pairs', () => {
    expect(tokenizeKnowledgeText('有棵树')).toEqual(['有棵', '棵树']);
  });

  it('does not pair a Chinese character with punctuation', () => {
    const tokens = tokenizeKnowledgeText('颜色：冰雾粉');
    expect(tokens).toEqual(['颜色', '冰雾', '雾粉']);
    // The tokens a "not ASCII" implementation would have produced instead.
    expect(tokens).not.toContain('色：');
    expect(tokens).not.toContain('：冰');
  });

  it('does not pair a Chinese character with an ASCII run', () => {
    const tokens = tokenizeKnowledgeText('有棵树YSPJ1143');
    expect(tokens).toEqual(['有棵', '棵树', 'yspj1143']);
    expect(tokens).not.toContain('树y');
  });

  it('gives partial credit to a longer run', () => {
    const asked = tokenizeKnowledgeQuery('加大码女款');
    const slice = tokenizeKnowledgeText('规格：加大码');
    expect(asked.filter((token) => slice.includes(token))).toEqual(['加大', '大码']);
  });

  it('drops a lone Chinese character but keeps a lone ASCII one', () => {
    expect(tokenizeKnowledgeText('码')).toEqual([]);
    expect(tokenizeKnowledgeText('L')).toEqual(['l']);
  });

  it('keeps multiplicity, so a caller can count occurrences', () => {
    expect(tokenizeKnowledgeText('黑色 黑色')).toEqual(['黑色', '黑色']);
  });

  it('slides the window, so a repeat also yields the pair spanning it', () => {
    // The junk token is the price of a dictionary-free rule and it is paid in
    // length normalisation, not in recall: no query produces `色黑`.
    expect(tokenizeKnowledgeText('黑色黑色')).toEqual(['黑色', '色黑', '黑色']);
  });

  it('answers an empty slice with no tokens', () => {
    expect(tokenizeKnowledgeText('')).toEqual([]);
  });
});

describe('tokenizeKnowledgeQuery', () => {
  it('collapses what the text function keeps', () => {
    expect(tokenizeKnowledgeQuery('黑色 黑色')).toEqual(['黑色']);
  });

  it('reads a term the way the slice was read', () => {
    expect(tokenizeKnowledgeQuery('冰雾粉')).toEqual(['冰雾', '雾粉']);
  });
});
