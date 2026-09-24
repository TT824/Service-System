/**
 * What a keyword is: which dimension names the platform understands, where a
 * labelled value ends, and where the kernel deliberately returns nothing.
 *
 * The two "returns nothing" cases are the point of this file, because both look
 * like gaps from the outside and neither is one:
 *
 *   * A label outside the closed vocabulary yields no keyword, so `温馨提示：…`
 *     and the `https` of a URL never become attributes. Pinned by "ignores a
 *     label the platform cannot classify" and "does not read a URL as a label".
 *   * `规格` is absent from the map on purpose — it is as often a volume or a
 *     pack count as a size. Pinned by "leaves 规格 unclassified".
 *
 * Two separators behave differently and both are deliberate: `|` and `/` are
 * inside values (`黑|白`, `S/M/L`), while `；` and `，` end one. And a value may
 * contain spaces, so the run has to stop at the next label on its own — that is
 * the "does not let a value swallow the next pair" case, which fails if the value
 * pattern is greedy.
 */

import { describe, expect, it } from 'vitest';
import {
  KNOWLEDGE_KEYWORD_MAX,
  KNOWLEDGE_KEYWORD_MAX_CHARS,
  extractKeywords,
  kindForDimension,
  vocabularyFromVariant,
} from './knowledge-keywords';

describe('kindForDimension', () => {
  it('classifies a dimension name the map names exactly', () => {
    expect(kindForDimension('颜色')).toBe('color');
    expect(kindForDimension('尺码')).toBe('size');
    expect(kindForDimension('品牌')).toBe('brand');
    expect(kindForDimension('材质')).toBe('material');
    expect(kindForDimension('功效')).toBe('effect');
    expect(kindForDimension('型号')).toBe('model');
    expect(kindForDimension('品类')).toBe('category');
  });

  it('tolerates surrounding space and a trailing colon', () => {
    expect(kindForDimension(' 颜色 ')).toBe('color');
    expect(kindForDimension('颜色：')).toBe('color');
    expect(kindForDimension('尺码:')).toBe('size');
  });

  it('classifies a compound name by the alias it ends with', () => {
    expect(kindForDimension('商品颜色')).toBe('color');
    expect(kindForDimension('产品品牌')).toBe('brand');
    expect(kindForDimension('商品分类')).toBe('category');
  });

  it('prefers an exact alias over a longer-looking suffix', () => {
    // `颜色分类` is a Taobao colour column. Suffix matching alone would read it
    // as 分类 and file a colour under `category`.
    expect(kindForDimension('颜色分类')).toBe('color');
  });

  it('leaves 规格 unclassified', () => {
    // A volume, a weight, a power rating or a pack count as often as a size, so
    // `规格：XL` must not become a size an exact match would then hit.
    expect(kindForDimension('规格')).toBeNull();
  });

  it('returns null for a label outside the vocabulary', () => {
    expect(kindForDimension('温馨提示')).toBeNull();
    expect(kindForDimension('https')).toBeNull();
    expect(kindForDimension('')).toBeNull();
    expect(kindForDimension('颜')).toBeNull();
  });
});

describe('extractKeywords — labelled pairs', () => {
  it('reads a value from a name-value pair', () => {
    expect(extractKeywords({ text: '品牌：安踏' })).toEqual([{ kind: 'brand', text: '安踏' }]);
  });

  it('finds a pair in the middle of prose', () => {
    expect(extractKeywords({ text: '本店支持七天无理由退货。品牌：安踏。' })).toEqual([
      { kind: 'brand', text: '安踏' },
    ]);
  });

  it('ends a value at a comma, and starts the next pair after it', () => {
    expect(extractKeywords({ text: '品牌：安踏，尺码：M' })).toEqual([
      { kind: 'brand', text: '安踏' },
      { kind: 'size', text: 'M' },
    ]);
  });

  it('ends a value at a full-width semicolon', () => {
    expect(extractKeywords({ text: '尺码：S/M/L；XL 缺货' })).toEqual([
      { kind: 'size', text: 'S/M/L' },
    ]);
  });

  it('does not end a value at `|`, which sits inside one', () => {
    // Cutting here would give a `颜色` of `黑`, a keyword no query needs and a
    // second answer to "what is the colour value" beside the slice's `黑|白`.
    expect(extractKeywords({ text: '颜色：黑|白' })).toEqual([{ kind: 'color', text: '黑|白' }]);
  });

  it('does not let a value swallow the next pair', () => {
    // The single space is part of neither rule, so the value must end there by
    // itself. A greedy value pattern yields one `颜色` of `黑 尺码` and loses `M`.
    expect(extractKeywords({ text: '颜色：黑 尺码：M' })).toEqual([
      { kind: 'color', text: '黑' },
      { kind: 'size', text: 'M' },
    ]);
  });

  it('keeps a space inside a value and collapses a run of them', () => {
    expect(extractKeywords({ text: '材质：100%  纯棉' })).toEqual([
      { kind: 'material', text: '100% 纯棉' },
    ]);
  });

  it('ignores a label the platform cannot classify', () => {
    expect(extractKeywords({ text: '温馨提示：本店支持七天无理由退货。' })).toEqual([]);
    expect(extractKeywords({ text: '规格：500ml' })).toEqual([]);
  });

  it('does not read a URL as a label', () => {
    expect(extractKeywords({ text: '客服微信 https://work.weixin.qq.com 咨询' })).toEqual([]);
  });

  it('skips a value too long to be a keyword', () => {
    const long = '黑'.repeat(KNOWLEDGE_KEYWORD_MAX_CHARS + 1);
    expect(extractKeywords({ text: `颜色：${long}` })).toEqual([]);
    const atLimit = '黑'.repeat(KNOWLEDGE_KEYWORD_MAX_CHARS);
    expect(extractKeywords({ text: `颜色：${atLimit}` })).toHaveLength(1);
  });
});

describe('extractKeywords — vocabulary', () => {
  it('reports a known value that occurs in the slice', () => {
    expect(
      extractKeywords({
        text: '纯棉圆领T恤，透气不闷',
        vocabulary: [
          { text: '纯棉', kind: 'material' },
          { text: '真丝', kind: 'material' },
        ],
      }),
    ).toEqual([{ kind: 'material', text: '纯棉' }]);
  });

  it('does not report a one-letter size found inside a longer one', () => {
    // Size `L` is a substring of `XL`. Without the token rule this exact-matches
    // a large against a customer asking for XL — the 错品 SDD-014 caps at 5%.
    expect(
      extractKeywords({
        text: '可选尺码 XS 已售完',
        vocabulary: [
          { text: 'S', kind: 'size' },
          { text: 'XS', kind: 'size' },
        ],
      }),
    ).toEqual([{ kind: 'size', text: 'XS' }]);
  });

  it('still reports a one-letter size that stands alone', () => {
    expect(
      extractKeywords({
        text: '可选尺码 S/M/L',
        vocabulary: [{ text: 'S', kind: 'size' }],
      }),
    ).toEqual([{ kind: 'size', text: 'S' }]);
  });

  it('reports a value once when both passes find it', () => {
    expect(
      extractKeywords({
        text: '品牌：安踏',
        vocabulary: [{ text: '安踏', kind: 'brand' }],
      }),
    ).toHaveLength(1);
  });

  it('puts labelled pairs before vocabulary hits', () => {
    const keywords = extractKeywords({
      text: '品牌：安踏。面料透气',
      vocabulary: [{ text: '透气', kind: 'effect' }],
    });
    expect(keywords.map((keyword) => keyword.kind)).toEqual(['brand', 'effect']);
  });

  it('caps how many keywords one slice may carry, dropping the tail', () => {
    const tens = '甲乙丙丁戊己庚辛壬癸';
    const units = '零一二三四五六七八九';
    const values = Array.from({ length: 40 }, (_, index) => {
      return `词${tens[Math.floor(index / 10)] ?? ''}${units[index % 10] ?? ''}`;
    });
    const keywords = extractKeywords({
      text: values.join('，'),
      vocabulary: values.map((text) => ({ text, kind: 'other' as const })),
    });
    expect(keywords).toHaveLength(KNOWLEDGE_KEYWORD_MAX);
    expect(keywords[0]?.text).toBe('词甲零');
  });
});

describe('vocabularyFromVariant', () => {
  it('classifies each dimension and files an unknown one as other', () => {
    expect(vocabularyFromVariant({ 颜色: '黑', 袖长: '长袖' })).toEqual([
      { text: '黑', kind: 'color' },
      { text: '长袖', kind: 'other' },
    ]);
  });
});
