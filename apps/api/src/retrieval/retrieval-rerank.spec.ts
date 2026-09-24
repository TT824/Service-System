import { describe, expect, it } from 'vitest';
import {
  KNOWLEDGE_FUSION_TOP,
  conversationReadAccess,
  type Conversation,
  type Member,
  type ProductSpu,
} from '@kefu/core';
import type { JsonLogger } from '../logging/json-logger';
import type { AccessService } from '../platform/access.service';
import type {
  CreateSuggestionSetRecord,
  PlatformRepository,
} from '../platform/platform-repository';
import type { KeywordRecallHit, KnowledgeKeywordRecall } from './knowledge-keyword-recall';
import type { KnowledgeSemanticRecall } from './knowledge-semantic-recall';
import { RetrievalService } from './retrieval.service';

/**
 * What the reranker is allowed to change about an answer.
 *
 * `packages/core`'s `knowledge-rerank.spec.ts` proves the ordering kernel and
 * `http-rerank-provider.spec.ts` proves the wire; `retrieval-rerank.e2e-spec.ts`
 * proves the module binds the token and that a failure is reported. What none of
 * them can show is the decision this file is about, because it needs a recall
 * that actually returns candidates *and* a reranker whose answer is known — the
 * interface suite has the first and the unit suite has the second, and every
 * interface suite in this repository answers from a catalogue whose read-back
 * the reranker cannot move.
 *
 * The decision is one line in the service and easy to get wrong in three ways:
 *
 *   * Handing the reranker the five the answer will keep instead of the whole
 *     candidate bound — which leaves it ranking the list it was brought in to
 *     replace.
 *   * Ignoring its answer, and answering in the fused order anyway.
 *   * Reading its answer as a ranking rather than as scores aligned to the
 *     documents, so the last candidate lands first.
 *
 * All three are asserted below against the same knob. The candidates'
 * contents are made identical on purpose, so the engine's own lexical score ties
 * and the recall rank is what decides — which is the service's claim that "the
 * rank is carried, not spent".
 */

const TENANT = 'tenant-rerank';
const STORE = 'store-rerank';
const CONVERSATION_ID = 'conversation-rerank';
const QUESTION = '什么时候发货';
/** Small enough that the cut is visible: five candidates, three kept. */
const LIMIT = 3;

/**
 * How many sources the recall leg offers.
 *
 * More than {@link KNOWLEDGE_FUSION_TOP} on purpose: at exactly that many, fusing
 * at the candidate bound and fusing at the answer bound produce the same list,
 * and the assertion about what the reranker was shown would hold either way.
 */
const SOURCES = 8;

/** The one warning a reranker that did not run writes. */
const RERANK_FAILURE = 'the rerank leg did not run; answering with the fused order';

/** One recalled product source, named `product-1` … `product-5`. */
function sourceId(index: number): string {
  return `product-${index}`;
}

const MEMBER = { id: 'member-rerank' } as Member;

/** 会话挂在这位坐席名下：本文件量的是重排，读权限那道门由 e2e 打。 */
const CONVERSATION = {
  id: CONVERSATION_ID,
  tenantId: TENANT,
  storeId: STORE,
  status: 'claimed',
  assignedMemberId: MEMBER.id,
} as Conversation;

/** A product that `spuKnowledge` will read back, in the answering store. */
function spu(index: number): ProductSpu {
  return {
    id: sourceId(index),
    tenantId: TENANT,
    storeId: STORE,
    // Deliberately the same for every product: equal titles score equally, so
    // the engine cannot mask the reranker by having an opinion of its own.
    title: QUESTION,
    description: '',
    commonAttributes: {},
    shelfStatus: 'on_shelf',
  } as unknown as ProductSpu;
}

/** One slice of one product, in the shape both recall legs answer with. */
function chunk(index: number): KeywordRecallHit {
  return {
    chunk: {
      id: `chunk-${index}`,
      tenantId: TENANT,
      storeId: STORE,
      scopeType: 'store',
      sourceKind: 'product',
      sourceId: sourceId(index),
      sourceField: 'title',
      chunkType: 'field',
      chunkIndex: 0,
      content: QUESTION,
    },
    mode: 'keyword',
    // Descending, so fusion preserves the order they are offered in rather than
    // re-sorting by slice id — the fused order is this file's input, not a thing
    // it should have to guess.
    score: SOURCES - index,
    matched: [],
  };
}

/** Every request the reranker was asked, so its inputs can be asserted. */
type Asked = { readonly query: string; readonly documents: ReadonlyArray<string> };

/** A service over hand-written seams, recording what crossed them. */
function serviceOver(
  mode: 'abstain' | 'reverse' | 'fail' | 'absent',
): {
  readonly service: RetrievalService;
  readonly writes: CreateSuggestionSetRecord[];
  readonly asked: Asked[];
  readonly logs: ReadonlyArray<Record<string, unknown>>;
} {
  const writes: CreateSuggestionSetRecord[] = [];
  const asked: Asked[] = [];
  const logs: Record<string, unknown>[] = [];

  const repository = {
    getConversation: () => Promise.resolve(CONVERSATION),
    listMessages: () => Promise.resolve([{ direction: 'inbound', content: QUESTION }]),
    // No products of the store's own: every candidate has to arrive through the
    // recall legs, or the reranker's effect could not be told apart from the
    // store list the engine always has.
    listProducts: () => Promise.resolve([]),
    getSpu: (_tenantId: string, spuId: string) => Promise.resolve(spu(Number(spuId.slice(8)))),
    listSkus: () => Promise.resolve([]),
    createSuggestionSet: (record: CreateSuggestionSetRecord) => {
      writes.push(record);
      return Promise.resolve({ ...record, id: 'suggestion-rerank-1' });
    },
  } as unknown as PlatformRepository;

  const access = {
    resolveStoreScope: () => Promise.resolve(STORE),
    // 走 core 的规则本身，而不是写死 `full`：写死的话这一层的门在单测里永远不红。
    conversationReadAccess: (
      _tenantId: string,
      conversation: Parameters<typeof conversationReadAccess>[0]['conversation'],
      member: { readonly id: string },
    ) =>
      Promise.resolve(
        conversationReadAccess({
          conversation,
          readerMemberId: member.id,
          readerIsAdmin: false,
          handedOffAt: undefined,
        }),
      ),
  } as unknown as AccessService;

  const index = Array.from({ length: SOURCES }, (_, offset) => offset + 1);
  const keywordRecall = {
    recall: () => Promise.resolve(index.map((offset) => chunk(offset))),
  } as unknown as KnowledgeKeywordRecall;

  const semanticRecall = {
    recall: () => Promise.resolve({ hits: [], unavailable: null }),
  } as unknown as KnowledgeSemanticRecall;

  const reranker =
    mode === 'absent'
      ? undefined
      : {
          model: 'fake-reranker',
          rerank: (query: string, documents: ReadonlyArray<string>) => {
            asked.push({ query, documents });
            if (mode === 'fail') {
              return Promise.resolve({
                ok: false as const,
                code: 'rerank_service_unreachable',
                reason: 'the rerank service could not be reached',
              });
            }
            return Promise.resolve({
              ok: true as const,
              // `abstain` gives every candidate the same score, so the fused
              // order survives; `reverse` ranks them by position, which puts the
              // last candidate first. Reading these as a *ranking* rather than
              // as positions would reverse them twice and land back on the
              // fused order — which is why the assertion below is on sources and
              // not on the scores.
              scores: documents.map((_, position) => (mode === 'reverse' ? position : 0)),
            });
          },
        };

  const logger = {
    logStructured: (
      level: string,
      message: string,
      fields: Record<string, unknown>,
    ): void => {
      logs.push({ level, message, ...fields });
    },
  } as unknown as JsonLogger;

  return {
    service: new RetrievalService(
      repository,
      access,
      keywordRecall,
      semanticRecall,
      reranker,
      // No generation provider: this file is about the candidates the engine
      // would write, and a provider that delivered would replace them.
      undefined,
      [],
      logger,
    ),
    writes,
    asked,
    logs,
  };
}

/** The sources an answer cites, in the order it cites them. */
function sources(set: CreateSuggestionSetRecord): string[] {
  return set.candidates.map((candidate) => String(candidate['sourceId']));
}

/** One suggestion, over its own seams, under one reranker behaviour. */
async function suggest(mode: 'abstain' | 'reverse' | 'fail' | 'absent') {
  const { service, writes, asked, logs } = serviceOver(mode);
  await service.suggest(TENANT, MEMBER, { conversationId: CONVERSATION_ID, limit: LIMIT });
  expect(writes).toHaveLength(1);
  return { set: writes[0] as CreateSuggestionSetRecord, asked, logs };
}

describe('RetrievalService reranking', () => {
  it('offers the reranker every candidate, not only the ones the answer will keep', async () => {
    const { set, asked } = await suggest('abstain');

    expect(asked).toHaveLength(1);
    expect(asked[0]?.query).toBe(QUESTION);
    // The whole point of the leg: `LIMIT` candidates are what the answer keeps,
    // and a reranker shown exactly those has only the fused ranking to reorder.
    expect(asked[0]?.documents).toHaveLength(SOURCES);
    expect(SOURCES).toBeGreaterThan(KNOWLEDGE_FUSION_TOP);
    expect(SOURCES).toBeGreaterThan(LIMIT);
    expect(set.candidates).toHaveLength(LIMIT);
  });

  it('keeps the fused order when the reranker has no opinion', async () => {
    const abstained = sources((await suggest('abstain')).set);

    // And with no reranker at all, which is the deployment that never bought
    // one. These two must agree: an abstaining reranker is not a behaviour
    // change, and this is the assertion that says so.
    const absent = sources((await suggest('absent')).set);

    expect(abstained).toHaveLength(LIMIT);
    expect(absent).toEqual(abstained);
  });

  it('builds the answer from the order the reranker returned', async () => {
    const abstained = sources((await suggest('abstain')).set);
    const { set: reversed } = await suggest('reverse');

    // Every candidate carries the same text, so the engine's lexical score ties
    // and the recall rank decides — reversing the order therefore changes
    // *which* sources the answer is built from, not merely the order they are
    // listed in.
    expect(sources(reversed)).not.toEqual(abstained);
    expect(sources(reversed)).toHaveLength(LIMIT);
  });

  it('answers with the fused order, and says so, when the reranker fails', async () => {
    const abstained = sources((await suggest('abstain')).set);
    const { set, logs } = await suggest('fail');

    expect(sources(set)).toEqual(abstained);

    // `no_rerank_provider` would be the opposite fact: nobody bought this. A
    // reranker that is configured and down has to be visible, and its reason
    // travels without the question or any candidate text.
    const reported = logs.filter((log) => log['message'] === RERANK_FAILURE);
    expect(reported).toHaveLength(1);
    expect(reported[0]?.['level']).toBe('warn');
    expect(reported[0]?.['code']).toBe('rerank_service_unreachable');
    expect(reported[0]?.['model']).toBe('fake-reranker');
    expect(reported[0]?.['candidates']).toBe(SOURCES);
    expect(JSON.stringify(reported[0])).not.toContain(QUESTION);
  });

  it('says nothing at all when no reranker is configured', async () => {
    const { logs } = await suggest('absent');

    // The distinction the whole port is shaped around: `undefined` is a
    // deployment that never wanted this, and it must not be logged as an
    // outage — an operator reading a warn every request learns to ignore it.
    expect(logs.filter((log) => log['message'] === RERANK_FAILURE)).toHaveLength(0);
  });
});
