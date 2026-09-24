/**
 * What the keyword recall hands its statement, without a database.
 *
 * The statement itself is proved against a real database, where the CTE chain
 * is what is under test. What this file covers is the **wire between them** —
 * the JSON of terms and tokens, the exact half's keys, the parameter order —
 * which no integration case can reach on its own, because a statement that is
 * handed the wrong *shape* does not raise: an empty `asked` list matches nothing
 * and returns no rows, which is what a question with no answer looks like.
 *
 * That is why the assertions are on the parameters rather than on a result. The
 * previous occupant of this file tested `escapeLikePattern`, the one pure
 * function the adapter had when the free-text half was a `LIKE`; that half is
 * BM25 now and the escaping went with it, because nothing on this path builds a
 * pattern any more. The replacement is not a pure function — it is the encoding,
 * which is the part that can break silently.
 */

import { describe, expect, it } from 'vitest';
import type { ParsedKnowledgeQuery } from '@kefu/core';
import type { DatabaseService } from '../database/database.service';
import { PostgresKnowledgeKeywordRecall } from './postgres-knowledge-keyword-recall';
import {
  KNOWLEDGE_BM25_ATTRIBUTE_BOOST,
  KNOWLEDGE_BM25_B,
  KNOWLEDGE_BM25_K1,
} from './knowledge-keyword-recall';

/** A recall whose statement is recorded instead of run. */
function recorder(): {
  readonly calls: ReadonlyArray<{ sql: string; params: ReadonlyArray<unknown> }>;
  readonly leg: PostgresKnowledgeKeywordRecall;
} {
  const calls: Array<{ sql: string; params: ReadonlyArray<unknown> }> = [];
  const database = {
    pool: {
      query: (sql: string, params: ReadonlyArray<unknown>) => {
        calls.push({ sql, params });
        return Promise.resolve({ rows: [] });
      },
    },
  } as unknown as DatabaseService;
  return { calls, leg: new PostgresKnowledgeKeywordRecall(database) };
}

/** One call's parameters, by the position the statement reads them from. */
type Params = {
  readonly tenantId: unknown;
  readonly storeId: unknown;
  readonly asked: ReadonlyArray<{ text: string; kind: string | null; tokens: string[] }>;
  readonly k1: unknown;
  readonly b: unknown;
  readonly exactKeys: ReadonlyArray<string>;
  readonly boost: unknown;
  readonly negations: ReadonlyArray<string>;
  readonly limit: unknown;
};

function paramsOf(call: { params: ReadonlyArray<unknown> }): Params {
  return {
    tenantId: call.params[0],
    storeId: call.params[1],
    asked: JSON.parse(String(call.params[2])),
    k1: call.params[3],
    b: call.params[4],
    exactKeys: call.params[5] as ReadonlyArray<string>,
    boost: call.params[6],
    negations: call.params[7] as ReadonlyArray<string>,
    limit: call.params[8],
  };
}

function query(overrides: Partial<ParsedKnowledgeQuery>): ParsedKnowledgeQuery {
  return { keywords: [], attributes: [], negations: [], ...overrides };
}

describe('PostgresKnowledgeKeywordRecall', () => {
  it('sends each term with the tokens the shared tokenizer gives it', async () => {
    const { calls, leg } = recorder();
    await leg.recall({
      tenantId: 'tenant-acme',
      storeId: 'store-acme-flagship',
      query: query({
        keywords: ['冰雾粉'],
        attributes: [{ kind: 'color', text: '黑色' }],
      }),
    });

    const params = paramsOf(calls[0]!);
    expect(params.tenantId).toBe('tenant-acme');
    expect(params.storeId).toBe('store-acme-flagship');
    // The attribute carries its dimension, the free-text term carries none, and
    // both carry bigrams rather than the words a segmenter would have cut.
    expect(params.asked).toEqual([
      { text: '黑色', kind: 'color', tokens: ['黑色'] },
      { text: '冰雾粉', kind: null, tokens: ['冰雾', '雾粉'] },
    ]);
  });

  it('folds case into an exact key but keeps the text the buyer wrote', async () => {
    const { calls, leg } = recorder();
    await leg.recall({
      tenantId: 'tenant-acme',
      storeId: 'store-acme-flagship',
      query: query({ attributes: [{ kind: 'size', text: 'XL' }] }),
    });

    const params = paramsOf(calls[0]!);
    expect(params.exactKeys).toEqual(['size:xl']);
    expect(params.asked).toEqual([{ text: 'XL', kind: 'size', tokens: ['xl'] }]);
  });

  it('drops a term no slice text can carry, and asks nothing at all if that is all there is', async () => {
    const { calls, leg } = recorder();
    await leg.recall({
      tenantId: 'tenant-acme',
      storeId: 'store-acme-flagship',
      query: query({ keywords: ['码', 'L'] }),
    });

    // 「码」 is one Chinese character: no bigram, so nothing to look up. `L` is one
    // ASCII run and survives, because `L` is how a size is written.
    expect(paramsOf(calls[0]!).asked).toEqual([{ text: 'L', kind: null, tokens: ['l'] }]);

    const empty = recorder();
    await empty.leg.recall({
      tenantId: 'tenant-acme',
      storeId: 'store-acme-flagship',
      query: query({ keywords: ['码'] }),
    });
    expect(empty.calls).toEqual([]);
  });

  it('carries the scorer constants and the bound from the port, not as literals', async () => {
    const { calls, leg } = recorder();
    await leg.recall({
      tenantId: 'tenant-acme',
      storeId: 'store-acme-flagship',
      query: query({ keywords: ['卫衣'], negations: [{ kind: 'color', text: '黑色' }] }),
      limit: 7,
    });

    // Read back through the port's own exports rather than through the numbers
    // they happen to hold: a statement that hardcoded `0.75` while the constant
    // said `0` would pass a literal assertion and fail this one. The tuned
    // *values* are the evaluation set's business — see the constant's note.
    const params = paramsOf(calls[0]!);
    expect(params.k1).toBe(KNOWLEDGE_BM25_K1);
    expect(params.b).toBe(KNOWLEDGE_BM25_B);
    expect(params.boost).toBe(KNOWLEDGE_BM25_ATTRIBUTE_BOOST);
    expect(params.limit).toBe(7);
    // The negation is matched against `keyword_text`, which is stored in the
    // case the merchant wrote it.
    expect(params.negations).toEqual(['黑色']);
  });

  it('answers nothing for a bound of zero without asking the database', async () => {
    const { calls, leg } = recorder();
    const hits = await leg.recall({
      tenantId: 'tenant-acme',
      storeId: 'store-acme-flagship',
      query: query({ keywords: ['卫衣'] }),
      limit: 0,
    });

    expect(hits).toEqual([]);
    expect(calls).toEqual([]);
  });
});
