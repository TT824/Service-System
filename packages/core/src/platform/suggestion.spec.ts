import { describe, expect, it } from 'vitest';
import {
  clampSuggestionLimit,
  generateSuggestions,
  SUGGESTION_MAX_CANDIDATES,
  type RetrievableKnowledge,
} from './suggestion';
import { SUGGESTION_FALLBACK_REASONS } from './types';

function knowledge(): ReadonlyArray<RetrievableKnowledge> {
  return [
    {
      id: 'product-acme-black-xl',
      tenantId: 'tenant-acme',
      storeId: 'store-acme-flagship',
      kind: 'product',
      title: '黑色 XL 加绒卫衣',
      content: '加绒黑色连帽卫衣，XL 码现货充足。',
    },
    {
      id: 'faq-acme-shrink',
      tenantId: 'tenant-acme',
      storeId: 'store-acme-flagship',
      kind: 'faq',
      title: '这款卫衣会缩水吗？',
      content: '纯棉面料建议冷水轻柔洗涤并平铺晾干。',
    },
    {
      id: 'shortcut-acme-greeting',
      tenantId: 'tenant-acme',
      storeId: 'store-acme-flagship',
      kind: 'shortcut',
      title: '开场白',
      content: '您好，欢迎光临云集服饰旗舰店。',
    },
  ];
}

describe('generateSuggestions', () => {
  it('returns at most three candidates even when the limit is higher', () => {
    const many: ReadonlyArray<RetrievableKnowledge> = Array.from({ length: 8 }, (_, index) => ({
      id: `item-${index}`,
      tenantId: 'tenant-acme',
      storeId: 'store-acme-flagship',
      kind: 'faq',
      title: `常见问题 ${index}`,
      content: `包含关键词：黑色 XL 加绒卫衣 (${index})`,
    }));
    const result = generateSuggestions({
      query: '黑色 XL 加绒卫衣',
      knowledge: many,
      providerConfigured: false,
      limit: 10,
    });
    expect(result.candidates.length).toBeLessThanOrEqual(SUGGESTION_MAX_CANDIDATES);
    expect(clampSuggestionLimit(10)).toBe(3);
  });

  it('records a fallback reason when no generation provider is configured', () => {
    const result = generateSuggestions({
      query: '黑色 XL',
      knowledge: knowledge(),
      providerConfigured: false,
    });
    expect(result.fallbackReasons).toContain(SUGGESTION_FALLBACK_REASONS.noProvider);
  });

  it('preserves tenant/store/source references on each candidate', () => {
    const result = generateSuggestions({
      query: '黑色 XL 卫衣',
      knowledge: knowledge(),
      providerConfigured: false,
    });
    expect(result.candidates.length).toBeGreaterThan(0);
    const candidate = result.candidates[0];
    expect(candidate).toMatchObject({
      tenantId: 'tenant-acme',
      storeId: 'store-acme-flagship',
      kind: 'product',
      sourceId: 'product-acme-black-xl',
      rank: 1,
    });
  });

  it('returns no candidates and records no_knowledge_match on no match', () => {
    const result = generateSuggestions({
      query: '完全不存在的内容',
      knowledge: knowledge(),
      providerConfigured: true,
    });
    expect(result.candidates).toEqual([]);
    expect(result.fallbackReasons).toContain(SUGGESTION_FALLBACK_REASONS.noKnowledgeMatch);
  });

  it('does not call any external provider path (no provider configured is the only mode)', () => {
    // The engine is a pure function: with providerConfigured=false it must still
    // produce deterministic knowledge candidates and never attempt I/O.
    const result = generateSuggestions({
      query: '黑色 XL',
      knowledge: knowledge(),
      providerConfigured: false,
    });
    expect(Array.isArray(result.candidates)).toBe(true);
    expect(result.candidates.length).toBeGreaterThan(0);
  });

  it('ranks title matches above body-only matches', () => {
    const result = generateSuggestions({
      query: '黑色 XL',
      knowledge: knowledge(),
      providerConfigured: false,
    });
    const titleCandidate = result.candidates.find((item) => item.kind === 'product');
    expect(titleCandidate?.rank).toBe(1);
  });
});

/**
 * The two kinds of evidence, and what the engine does with each.
 *
 * The question in this block is deliberately worded so that it shares no token
 * with the knowledge — the shape SDD-014's semantic leg exists for, and the
 * shape the engine used to answer with nothing at all.
 */
describe('generateSuggestions · recall evidence', () => {
  function recalled(
    id: string,
    rank: number,
    modes: ReadonlyArray<'keyword' | 'semantic'> = ['semantic'],
  ): RetrievableKnowledge {
    return {
      id,
      tenantId: 'tenant-acme',
      storeId: 'store-acme-flagship',
      kind: 'faq',
      title: '洗涤与保养说明',
      content: '三十度以下机洗，避免烘干。',
      recall: { rank, modes },
    };
  }

  function product(id: string, title: string): RetrievableKnowledge {
    return {
      id,
      tenantId: 'tenant-acme',
      storeId: 'store-acme-flagship',
      kind: 'product',
      title,
      content: '现货充足。',
    };
  }

  it('offers a recalled entry the question shares no word with', () => {
    const result = generateSuggestions({
      query: '这件衣服怎么保养',
      knowledge: [recalled('faq-acme-care', 1)],
      providerConfigured: true,
    });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      sourceId: 'faq-acme-care',
      rank: 1,
      // The engine's own evidence is nil, and the report says so rather than
      // inventing a number for an entry it did not match.
      score: 0,
    });
    expect(result.fallbackReasons).not.toContain(SUGGESTION_FALLBACK_REASONS.noKnowledgeMatch);
  });

  it('orders score-zero entries by the rank the recall gave them', () => {
    const result = generateSuggestions({
      query: '这件衣服怎么保养',
      knowledge: [recalled('faq-third', 3), recalled('faq-first', 1), recalled('faq-second', 2)],
      providerConfigured: true,
    });
    expect(result.candidates.map((candidate) => candidate.sourceId)).toEqual([
      'faq-first',
      'faq-second',
      'faq-third',
    ]);
  });

  it('keeps the engine’s own lexical evidence ahead of a recalled entry', () => {
    const result = generateSuggestions({
      query: '黑色 XL',
      knowledge: [
        recalled('faq-acme-care', 1),
        product('product-acme-black-xl', '黑色 XL 加绒卫衣'),
      ],
      providerConfigured: true,
    });
    expect(result.candidates.map((candidate) => candidate.sourceId)).toEqual([
      'product-acme-black-xl',
      'faq-acme-care',
    ]);
  });

  it('breaks a lexical tie by recall rank, not by id', () => {
    const result = generateSuggestions({
      query: '保养',
      knowledge: [
        // The recalled entry sorts *later* by id, so an answer ordered by id
        // would put the plain one first — which is what this pins down.
        { ...recalled('zz-recalled', 2, ['keyword', 'semantic']), title: '保养说明' },
        { ...product('aa-plain', '保养说明'), kind: 'faq' as const },
      ],
      providerConfigured: true,
    });
    expect(result.candidates.map((candidate) => candidate.sourceId)).toEqual([
      'zz-recalled',
      'aa-plain',
    ]);
  });

  it('still refuses an entry with neither lexical nor recall evidence', () => {
    const result = generateSuggestions({
      query: '完全不存在的内容',
      knowledge: [product('product-acme-black-xl', '黑色 XL 加绒卫衣')],
      providerConfigured: true,
    });
    expect(result.candidates).toEqual([]);
    expect(result.fallbackReasons).toContain(SUGGESTION_FALLBACK_REASONS.noKnowledgeMatch);
  });

  it('reports the semantic leg’s outage without emptying the answer', () => {
    const running = generateSuggestions({
      query: '黑色 XL',
      knowledge: knowledge(),
      providerConfigured: true,
      semanticRecallUnavailable: false,
    });
    expect(running.fallbackReasons).not.toContain(
      SUGGESTION_FALLBACK_REASONS.semanticRecallUnavailable,
    );

    const down = generateSuggestions({
      query: '黑色 XL',
      knowledge: knowledge(),
      providerConfigured: true,
      semanticRecallUnavailable: true,
    });
    expect(down.fallbackReasons).toContain(SUGGESTION_FALLBACK_REASONS.semanticRecallUnavailable);
    expect(down.candidates.length).toBeGreaterThan(0);
  });
});
