/**
 * What makes two index rows the same row — and what makes them different ones.
 *
 * The suite is built around the three claims the module makes, because each of
 * them is a claim that nothing else in the repo can check and each fails
 * silently:
 *
 *   * **The id addresses position, not content.** `deriveChunkId` covers exactly
 *     the five columns of `knowledge_chunks_slice_unique`, so a reindex finds its
 *     own rows. Pinned by the five-way table and, from the other side, by
 *     "changes the hash but not the id when the slice text changes": an id that
 *     had folded the content in would look correct in every other case and would
 *     turn every edit into a fresh row plus a cascade of the old one's keywords.
 *   * **`contentHash` covers `content` alone.** Pinned by a pair that differs in
 *     the *neighbour* (hash must not move) and a pair that differs in the text
 *     itself (hash must move). The first pair asserts the neighbour really did
 *     change — otherwise it would pass on a fixture where nothing moved.
 *   * **A keyword hangs off the slice that produced it.** Pinned by a source that
 *     cuts into two slices with the attribute in the second: the assertion is
 *     that the keyword's `chunkId` is the *second* slice's id, which is false
 *     both for `chunks[0].id` and for any join-then-extract implementation.
 *   * **The model is part of an embedding row's address.** `deriveEmbeddingId`
 *     covers `knowledge_chunk_embeddings_unique`'s three columns, so a second
 *     model's vectors are new rows beside the first model's rather than updates
 *     of them — which is the difference between a rebuild that can find the old
 *     vectors and one that has already overwritten them.
 *
 * Two behaviours of the kernels below are relied on rather than re-tested here
 * (`KNOWLEDGE_KEYWORD_MAX`, the `(kind, text)` dedupe, `chunkProse`'s packing
 * rule): they have their own suites, and a second assertion of them here would
 * be a second answer to the same question.
 */

import { describe, expect, it } from 'vitest';
import { chunkSource, type KnowledgeChunkDraft } from './knowledge-chunker';
import type { KeywordKind } from './knowledge-keywords';
import {
  buildKnowledgeIndex,
  deriveChunkId,
  deriveEmbeddingId,
  deriveKeywordId,
  hashChunkContent,
  type IndexSourceInput,
} from './knowledge-indexer';

/** The address `deriveChunkId` takes, named so the table below can vary one field. */
type ChunkAddress = Parameters<typeof deriveChunkId>[0];

const TENANT = 'tenant-acme';
const STORE = 'store-acme-flagship';
const OTHER_TENANT = 'tenant-beta';

/**
 * The tail every long answer ends with: short, label-bearing, and — with a
 * 600-code-point head in front of it — the whole of the answer's second slice.
 */
const ANSWER_TAIL = '品牌：安踏';

/** Prose with no terminator, so it hard-splits at the ceiling into 500 + 106. */
const LONG_ANSWER = `${'退'.repeat(600)}${ANSWER_TAIL}`;

/** A question whose only interesting property is that it is one short slice. */
const QUESTION = '如何申请退货？';

/** The two-slice faq every structural case is built from. */
function faqInput(overrides: Partial<IndexSourceInput> = {}): IndexSourceInput {
  return {
    tenantId: TENANT,
    storeId: STORE,
    sourceKind: 'faq',
    sourceId: 'faq-1',
    enabled: true,
    values: { question: QUESTION, answer: LONG_ANSWER },
    ...overrides,
  };
}

/** The single slice of the `question` field, found by field rather than index. */
function questionChunk(rows: ReturnType<typeof buildKnowledgeIndex>) {
  const chunk = rows.chunks.find((row) => row.sourceField === 'question');
  if (chunk === undefined) {
    throw new Error('the fixture no longer produces a question slice');
  }
  return chunk;
}

/** The last slice of the whole source, whatever shape the fixture has. */
function lastChunk(rows: ReturnType<typeof buildKnowledgeIndex>) {
  const chunk = rows.chunks[rows.chunks.length - 1];
  if (chunk === undefined) {
    throw new Error('the fixture no longer produces any slices');
  }
  return chunk;
}

describe('deriveChunkId', () => {
  it('derives the same id for the same address', () => {
    const address = {
      tenantId: TENANT,
      sourceKind: 'faq' as const,
      sourceId: 'faq-1',
      sourceField: 'answer',
      chunkIndex: 2,
    };
    expect(deriveChunkId(address)).toBe(deriveChunkId(address));
  });

  it('changes the id when any one address component changes', () => {
    const base = {
      tenantId: TENANT,
      sourceKind: 'faq' as const,
      sourceId: 'faq-1',
      sourceField: 'answer',
      chunkIndex: 2,
    };
    const variants: ReadonlyArray<[string, ChunkAddress]> = [
      ['tenantId', { ...base, tenantId: OTHER_TENANT }],
      ['sourceKind', { ...base, sourceKind: 'shortcut' }],
      ['sourceId', { ...base, sourceId: 'faq-2' }],
      ['sourceField', { ...base, sourceField: 'question' }],
      ['chunkIndex', { ...base, chunkIndex: 3 }],
    ];
    const ids = variants.map(([, variant]) => deriveChunkId(variant));
    // Every component is load-bearing: five distinct addresses, five distinct
    // ids, and none of them the base's.
    expect(new Set(ids).size).toBe(variants.length);
    expect(ids).not.toContain(deriveChunkId(base));
  });

  it('keeps the id short enough to read in a log line', () => {
    const id = deriveChunkId({
      tenantId: TENANT,
      sourceKind: 'faq',
      sourceId: 'faq-1',
      sourceField: 'answer',
      chunkIndex: 0,
    });
    expect(id).toMatch(/^kchunk-[0-9a-f]{32}$/u);
  });
});

describe('hashChunkContent', () => {
  it('digests the content as 64 hex characters and tracks the text', () => {
    const hash = hashChunkContent('退换货说明');
    expect(hash).toMatch(/^[0-9a-f]{64}$/u);
    expect(hashChunkContent('退换货说明')).toBe(hash);
    expect(hashChunkContent('退换货说明。')).not.toBe(hash);
  });
});

describe('deriveKeywordId', () => {
  it('changes the id when any one of its four components changes', () => {
    const base = [TENANT, 'kchunk-abc', 'brand', '安踏'] as const;
    const variants: ReadonlyArray<readonly [string, string, KeywordKind, string]> = [
      [OTHER_TENANT, base[1], base[2], base[3]],
      [base[0], 'kchunk-def', base[2], base[3]],
      [base[0], base[1], 'color', base[3]],
      [base[0], base[1], base[2], '李宁'],
    ];
    const ids = variants.map((variant) => deriveKeywordId(...variant));
    expect(new Set(ids).size).toBe(variants.length);
    expect(ids).not.toContain(deriveKeywordId(...base));
    expect(deriveKeywordId(...base)).toMatch(/^kkw-[0-9a-f]{32}$/u);
  });
});

describe('deriveEmbeddingId', () => {
  it('changes the id when any one of its three components changes', () => {
    const base = [TENANT, 'kchunk-abc', 'bge-m3'] as const;
    const variants: ReadonlyArray<readonly [string, string, string]> = [
      [OTHER_TENANT, base[1], base[2]],
      [base[0], 'kchunk-def', base[2]],
      // The model moves the id, so a rebuild under a new model writes new rows
      // and leaves the old model's vectors findable.
      [base[0], base[1], 'text-embedding-3-small'],
    ];
    const ids = variants.map((variant) => deriveEmbeddingId(...variant));
    expect(new Set(ids).size).toBe(variants.length);
    expect(ids).not.toContain(deriveEmbeddingId(...base));
    expect(deriveEmbeddingId(...base)).toMatch(/^kemb-[0-9a-f]{32}$/u);
  });
});

describe('buildKnowledgeIndex on the two-slice faq', () => {
  it('cuts the fixture into the two slices the other cases assume', () => {
    // The whole suite rests on this shape. If the fixture stopped cutting, the
    // keyword-attribution cases below would pass by having nothing to attribute.
    const { chunks } = buildKnowledgeIndex(faqInput());
    expect(chunks.map((row) => row.sourceField)).toEqual(['question', 'answer', 'answer']);
    expect(chunks.map((row) => row.chunkIndex)).toEqual([0, 0, 1]);
    expect(chunks[1]?.contextAfter).not.toBeNull();
  });

  it("returns the chunker's drafts with only the identity fields added", () => {
    const drafts = chunkSource({ sourceKind: 'faq', sourceId: 'faq-1', values: faqInput().values });
    const { chunks } = buildKnowledgeIndex(faqInput());
    expect(chunks).toHaveLength(drafts.length);
    chunks.forEach((chunk, index) => {
      // Nothing the chunker decided may be rewritten on the way through.
      expect(chunk).toMatchObject(drafts[index] as KnowledgeChunkDraft);
    });
  });

  it('adds exactly the row shape `0011` declares, and nothing more', () => {
    const { chunks, keywords } = buildKnowledgeIndex(faqInput());
    expect(Object.keys(chunks[0] ?? {}).sort()).toEqual(
      [
        'charCount',
        'chunkIndex',
        'chunkType',
        'content',
        'contentHash',
        'contextAfter',
        'contextBefore',
        'enabled',
        'id',
        'indexStatus',
        'scopeType',
        'sourceField',
        'sourceId',
        'sourceKind',
        'storeId',
        'tenantId',
      ].sort(),
    );
    expect(Object.keys(keywords[0] ?? {}).sort()).toEqual(
      ['chunkId', 'id', 'keywordKind', 'keywordText', 'tenantId'].sort(),
    );
  });

  it('carries the tenant and the store onto every row', () => {
    const { chunks, keywords } = buildKnowledgeIndex(faqInput());
    expect(chunks.every((row) => row.tenantId === TENANT)).toBe(true);
    expect(chunks.every((row) => row.storeId === STORE)).toBe(true);
    expect(chunks.every((row) => row.scopeType === 'store')).toBe(true);
    expect(keywords.every((row) => row.tenantId === TENANT)).toBe(true);
  });

  it('reads a null store as tenant scope and a store id as store scope', () => {
    const tenant = buildKnowledgeIndex(faqInput({ storeId: null }));
    expect(tenant.chunks.every((row) => row.scopeType === 'tenant')).toBe(true);
    expect(tenant.chunks.every((row) => row.storeId === null)).toBe(true);
    const store = buildKnowledgeIndex(faqInput({ storeId: STORE }));
    expect(store.chunks.every((row) => row.scopeType === 'store')).toBe(true);
  });

  it('passes `enabled` through rather than deciding it, and marks rows pending', () => {
    const { chunks } = buildKnowledgeIndex(faqInput({ enabled: false }));
    expect(chunks.every((row) => row.enabled === false)).toBe(true);
    expect(chunks.every((row) => row.indexStatus === 'pending')).toBe(true);
  });

  it('returns deeply equal rows for the same input', () => {
    const first = buildKnowledgeIndex(faqInput());
    const second = buildKnowledgeIndex(faqInput());
    // Deep, not by length: a random id makes two same-length arrays differ.
    expect(second.chunks).toEqual(first.chunks);
    expect(second.keywords).toEqual(first.keywords);
  });

  it('returns nothing for a source whose fields are all empty', () => {
    const rows = buildKnowledgeIndex(
      faqInput({ values: { question: null, answer: '   ', summary: undefined } }),
    );
    expect(rows.chunks).toEqual([]);
    expect(rows.keywords).toEqual([]);
  });

  it('derives different ids for the same position in a different tenant', () => {
    // Position is the tenant's own; the id is not shared across tenants because
    // `tenantId` is part of the address. This is the positive half of the
    // five-way table above, at the level the job actually calls.
    const acme = buildKnowledgeIndex(faqInput());
    const beta = buildKnowledgeIndex(faqInput({ tenantId: OTHER_TENANT }));
    expect(beta.chunks.map((row) => row.id)).not.toEqual(acme.chunks.map((row) => row.id));
  });
});

describe('buildKnowledgeIndex on the content hash', () => {
  it('does not move the hash when only a neighbouring slice changes', () => {
    // Context is carried *within* a field, so the neighbour has to be a sibling
    // slice: the answer is cut into a 500-code-point head and this tail, and the
    // two fixtures differ only in the head.
    const before = buildKnowledgeIndex(
      faqInput({ values: { question: QUESTION, answer: `${'甲'.repeat(500)}${ANSWER_TAIL}` } }),
    );
    const after = buildKnowledgeIndex(
      faqInput({ values: { question: QUESTION, answer: `${'乙'.repeat(500)}${ANSWER_TAIL}` } }),
    );
    const beforeTail = lastChunk(before);
    const afterTail = lastChunk(after);

    // The setup is real: the slice under test is the one after the change, its
    // own text did not move, and its `contextBefore` did. Without these two
    // lines the assertions below would pass on a fixture where nothing moved.
    expect(beforeTail.content).toBe(ANSWER_TAIL);
    expect(afterTail.contextBefore).not.toBe(beforeTail.contextBefore);
    expect(afterTail.content).toBe(beforeTail.content);
    expect(afterTail.contentHash).toBe(beforeTail.contentHash);
    // And the slice that really did change reports a new hash.
    expect(after.chunks[1]?.contentHash).not.toBe(before.chunks[1]?.contentHash);
  });

  it('moves the hash but not the id when the slice text itself changes', () => {
    const before = buildKnowledgeIndex(
      faqInput({ values: { question: '如何申请退货？', answer: LONG_ANSWER } }),
    );
    const after = buildKnowledgeIndex(
      faqInput({ values: { question: '如何申请换货？', answer: LONG_ANSWER } }),
    );
    const beforeQuestion = questionChunk(before);
    const afterQuestion = questionChunk(after);

    expect(afterQuestion.content).not.toBe(beforeQuestion.content);
    expect(afterQuestion.contentHash).not.toBe(beforeQuestion.contentHash);
    // The position did not move, so the row the reindex updates is the same row.
    // An id with the content folded in would give a new id here and leave the old
    // row behind — which is exactly the failure `knowledge_chunks_slice_unique`
    // exists to prevent.
    expect(afterQuestion.id).toBe(beforeQuestion.id);
  });
});

describe('buildKnowledgeIndex on keyword attribution', () => {
  it('hangs a labelled pair off the slice that contains it', () => {
    const { chunks, keywords } = buildKnowledgeIndex(faqInput());
    expect(keywords).toHaveLength(1);
    expect(keywords[0]).toMatchObject({ keywordKind: 'brand', keywordText: '安踏' });
    // The attribute is in the *second* answer slice, not the first and not the
    // question. `chunks[0].id` and a join-then-extract both fail here.
    expect(chunks[2]?.content).toContain('品牌：安踏');
    expect(keywords[0]?.chunkId).toBe(chunks[2]?.id);
    expect(keywords[0]?.chunkId).not.toBe(chunks[0]?.id);
  });

  it('gives each keyword row an id derived from its own address', () => {
    const { chunks, keywords } = buildKnowledgeIndex(faqInput());
    expect(keywords[0]?.id).toBe(deriveKeywordId(TENANT, chunks[2]?.id ?? '', 'brand', '安踏'));
    expect(keywords[0]?.id).not.toBe(deriveKeywordId(TENANT, chunks[0]?.id ?? '', 'brand', '安踏'));
  });

  it('returns no keywords for prose with neither labels nor vocabulary', () => {
    const rows = buildKnowledgeIndex(
      faqInput({
        values: { question: QUESTION, answer: '本店支持七天无理由退货，请保持商品完好。' },
      }),
    );
    expect(rows.chunks.length).toBeGreaterThan(0);
    expect(rows.keywords).toEqual([]);
  });

  it('matches a vocabulary value only on the slice that contains it', () => {
    const rows = buildKnowledgeIndex(
      faqInput({
        values: { question: '能否上门安装？', answer: '安装服务由第三方提供。' },
        vocabulary: [{ text: '上门安装', kind: 'other' }],
      }),
    );
    expect(rows.keywords).toEqual([
      expect.objectContaining({
        chunkId: rows.chunks[0]?.id,
        keywordKind: 'other',
        keywordText: '上门安装',
      }),
    ]);
    // The answer slice does not contain the value, so it must carry nothing.
    expect(rows.keywords.some((row) => row.chunkId === rows.chunks[1]?.id)).toBe(false);
  });

  it('orders keyword rows behind the chunks that produced them', () => {
    const rows = buildKnowledgeIndex(
      faqInput({
        values: { question: '品牌：安踏', answer: LONG_ANSWER },
      }),
    );
    expect(rows.keywords.map((row) => row.chunkId)).toEqual([
      rows.chunks[0]?.id,
      rows.chunks[2]?.id,
    ]);
    expect(rows.keywords.map((row) => row.keywordText)).toEqual(['安踏', '安踏']);
  });
});

describe('buildKnowledgeIndex on the other source kinds', () => {
  it('leaves an empty field out without misattributing its keywords', () => {
    for (const empty of ['', '   ', null, undefined]) {
      const rows = buildKnowledgeIndex({
        tenantId: TENANT,
        storeId: null,
        sourceKind: 'shortcut',
        sourceId: 'sc-1',
        enabled: true,
        values: { title: '品牌：安踏', content: empty },
      });
      expect(rows.chunks).toHaveLength(1);
      expect(rows.chunks[0]?.sourceField).toBe('title');
      expect(rows.keywords.map((row) => row.chunkId)).toEqual([rows.chunks[0]?.id]);
    }
  });

  it('indexes both fields of a shortcut, each with its own chunk indices', () => {
    const rows = buildKnowledgeIndex({
      tenantId: TENANT,
      storeId: null,
      sourceKind: 'shortcut',
      sourceId: 'sc-1',
      enabled: true,
      values: { title: '退货入口', content: '在我的订单里点退货。' },
    });
    expect(rows.chunks.map((row) => row.sourceField)).toEqual(['title', 'content']);
    expect(rows.chunks.map((row) => row.chunkType)).toEqual(['title', 'content']);
    // `chunkIndex` restarts per field — the pair with `source_field` is what the
    // unique key uses, so two fields both starting at zero is the intended shape.
    expect(rows.chunks.map((row) => row.chunkIndex)).toEqual([0, 0]);
  });

  it('indexes a faq_variant through its own field list', () => {
    const rows = buildKnowledgeIndex({
      tenantId: TENANT,
      storeId: null,
      sourceKind: 'faq_variant',
      sourceId: 'var-1',
      enabled: true,
      values: { question_text: '尺码：M', question: 'not a field of this source' },
    });
    expect(rows.chunks).toHaveLength(1);
    expect(rows.chunks[0]?.sourceField).toBe('question_text');
    expect(rows.chunks[0]?.chunkType).toBe('question');
    expect(rows.keywords.map((row) => row.keywordKind)).toEqual(['size']);
  });
});
