import { describe, expect, it } from 'vitest';
import {
  conversationReadAccess,
  type Conversation,
  type GenerationProvider,
  type GenerationRequest,
  type Member,
  type ProductSpu,
} from '@kefu/core';
import type { JsonLogger } from '../logging/json-logger';
import type { AccessService } from '../platform/access.service';
import type {
  CreateSuggestionSetRecord,
  PlatformRepository,
} from '../platform/platform-repository';
import type { KnowledgeKeywordRecall } from './knowledge-keyword-recall';
import type { KnowledgeSemanticRecall } from './knowledge-semantic-recall';
import { RetrievalService } from './retrieval.service';

/**
 * Which text becomes the question a suggestion set is generated for.
 *
 * The rest of this service is proved at the interface level, where a real
 * database and the real HTTP stack are in play. What is left for this file is
 * the one decision no interface test in this repository discriminates, because
 * every one of them passes `query` explicitly: **what an agent's workbench is
 * asking about when the newest message in the conversation carries no words**.
 *
 * That case is a customer's image, voice note or file: the platform stores it as
 * a text message whose content is a placeholder (§块 3), so without a guard here
 * the placeholder *is* the question — `[语音消息]` goes to the model, and the
 * candidate that comes back cites it. Worse, a guard that reached further back
 * would answer the message before it, and the agent would send that answer as
 * though the voice note had been listened to. Both failure modes are asserted
 * below, from the two sides that can tell them apart: what the provider was
 * asked, and what the set the service tried to store carries.
 */

const TENANT = 'tenant-unit';
const STORE = 'store-unit';
const CONVERSATION_ID = 'conversation-unit';

/** What one call to the service touched, from the seams that can see it. */
type Recorded = {
  /** Every request the generation provider was asked — the model's side. */
  readonly asked: GenerationRequest[];
  /** Every set the service tried to persist — the storage side. */
  readonly writes: CreateSuggestionSetRecord[];
  /**
   * How many times each recall leg was called.
   *
   * A count rather than a boolean because the claim under test is about *cost*:
   * the chitchat path's whole point is that it spends none of these, and a test
   * that only read the persisted set could not tell "skipped the search" from
   * "searched and found nothing".
   */
  readonly recalls: { keyword: number; semantic: number };
};

/** What a test can arrange behind the service's seams. */
type Seams = {
  /** Slices the keyword leg hands back, as the fusion sees them. */
  readonly keywordHits?: ReadonlyArray<unknown>;
  /** The shortcut a recalled slice reads back to; absent means its source is gone. */
  readonly shortcut?: unknown;
  /** What the fake provider answers with; default none, like a model that failed. */
  readonly providerCandidates?: ReadonlyArray<{
    readonly sourceId: string;
    readonly content: string;
  }>;
  /** Leave the generation provider unconfigured, as a deployment with no key is. */
  readonly withoutProvider?: boolean;
};

/** One customer message, in the only two fields this decision reads. */
function message(direction: 'inbound' | 'outbound', content: string): Record<string, unknown> {
  return { direction, content };
}

/** A store product, so the knowledge the question is answered from is never empty. */
const PRODUCT = {
  id: 'knowledge-unit-1',
  tenantId: TENANT,
  storeId: STORE,
  enabled: true,
  title: '什么时候发货',
  description: '我们会在 48 小时内发出。',
} as unknown as ProductSpu;

const MEMBER = { id: 'member-unit' } as Member;

/**
 * 这条会话挂在这位坐席名下。
 *
 * 读权限那道门（`conversationReadAccess`）只有「我的/池中/我交出去的」才放行，
 * 而本文件关心的是「问什么」，所以夹具就摆一条自己的会话；门本身由 e2e 打。
 */
const CONVERSATION = {
  id: CONVERSATION_ID,
  tenantId: TENANT,
  storeId: STORE,
  status: 'claimed',
  assignedMemberId: MEMBER.id,
} as Conversation;

/** A service over hand-written seams, recording what crossed them. */
function serviceOver(
  messages: ReadonlyArray<Record<string, unknown>>,
  seams: Seams = {},
): {
  readonly service: RetrievalService;
  readonly recorded: Recorded;
} {
  const recorded: Recorded = { asked: [], writes: [], recalls: { keyword: 0, semantic: 0 } };

  const repository = {
    getConversation: () => Promise.resolve(CONVERSATION),
    listMessages: () => Promise.resolve(messages),
    listProducts: () => Promise.resolve([PRODUCT]),
    // The read-back half of a recalled shortcut: a slice is polymorphic text and
    // has to be resolved to its source before it can be a candidate.
    getShortcut: () => Promise.resolve(seams.shortcut),
    createSuggestionSet: (record: CreateSuggestionSetRecord) => {
      recorded.writes.push(record);
      // Returned as stored: this file asserts on `writes`, never on this value,
      // because a fake's own answer would prove nothing about the service.
      return Promise.resolve({ ...record, id: 'suggestion-unit-1' });
    },
  } as unknown as PlatformRepository;

  const access = {
    resolveStoreScope: () => Promise.resolve(STORE),
    // 读权限走 core 的规则本身，而不是写死 `full`：写死的话，这一层的门在单测里
    // 永远不会红，等于没有（真正的门由 e2e 打）。
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

  const keywordRecall = {
    recall: () => {
      recorded.recalls.keyword += 1;
      return Promise.resolve(seams.keywordHits ?? []);
    },
  } as unknown as KnowledgeKeywordRecall;

  const semanticRecall = {
    recall: () => {
      recorded.recalls.semantic += 1;
      return Promise.resolve({ hits: [], unavailable: null });
    },
  } as unknown as KnowledgeSemanticRecall;

  const generation: GenerationProvider = {
    model: 'fake-model',
    generate: (request: GenerationRequest) => {
      recorded.asked.push(request);
      return Promise.resolve({ ok: true as const, candidates: seams.providerCandidates ?? [] });
    },
  };

  const logger = { logStructured: () => undefined } as unknown as JsonLogger;

  return {
    service: new RetrievalService(
      repository,
      access,
      keywordRecall,
      semanticRecall,
      // No reranker: this file is about which text becomes the question, and the
      // reranker reorders an answer that the question-selection guard has
      // already emptied or not. Its wiring is proved at the interface level,
      // where a real recall actually produces candidates to reorder.
      undefined,
      seams.withoutProvider === true ? undefined : generation,
      [],
      logger,
    ),
    recorded,
  };
}

describe('RetrievalService question selection', () => {
  it('asks the model nothing, and offers nothing, when the newest message has no words', async () => {
    const { service, recorded } = serviceOver([message('inbound', '[语音消息]')]);

    await service.suggest(TENANT, MEMBER, { conversationId: CONVERSATION_ID });

    // The provider is the assertion that matters: it is the call that costs
    // money and that a customer's voice note must not trigger.
    expect(recorded.asked).toEqual([]);

    // And the set says why it is empty, in the vocabulary a client renders.
    expect(recorded.writes).toHaveLength(1);
    expect(recorded.writes[0]?.candidates).toEqual([]);
    expect(recorded.writes[0]?.fallbackReasons).toContain('empty_query');
    expect(recorded.writes[0]?.provider).toBe('none');
  });

  it('does not reach back past the placeholder to the message before it', async () => {
    // The tempting reading is "answer the last thing that has words in it". It
    // is wrong here: the customer has since sent a voice note, and an agent
    // handed the earlier answer has no way to see that it was not heard.
    const { service, recorded } = serviceOver([
      message('inbound', '什么时候发货'),
      message('inbound', '[语音消息]'),
    ]);

    await service.suggest(TENANT, MEMBER, { conversationId: CONVERSATION_ID });

    expect(recorded.asked).toEqual([]);
    expect(recorded.writes[0]?.fallbackReasons).toContain('empty_query');
  });

  it('answers the newest customer text', async () => {
    const { service, recorded } = serviceOver([
      message('outbound', '亲，在的～'),
      message('inbound', '什么时候发货'),
    ]);

    await service.suggest(TENANT, MEMBER, { conversationId: CONVERSATION_ID });

    expect(recorded.asked).toHaveLength(1);
    expect(recorded.asked[0]?.query).toBe('什么时候发货');
  });

  it('answers a question an agent typed, whatever the newest message is', async () => {
    // The re-ask path. An agent who read the voice note and typed the question
    // has supplied the words the conversation was missing, so the placeholder
    // guard must not stand in the way of the question they asked.
    const { service, recorded } = serviceOver([message('inbound', '[语音消息]')]);

    await service.suggest(TENANT, MEMBER, {
      conversationId: CONVERSATION_ID,
      query: '语音里说的尺码有货吗',
    });

    expect(recorded.asked).toHaveLength(1);
    expect(recorded.asked[0]?.query).toBe('语音里说的尺码有货吗');
  });
});

describe('RetrievalService intent and retrieval-first', () => {
  /** A store phrase, so a recall leg has something to hand back. */
  const SHORTCUT = {
    id: 'shortcut-unit-1',
    tenantId: TENANT,
    scopeType: 'store',
    storeId: STORE,
    code: 'SC-UNIT-1',
    title: '发货时间',
    content: '我们会在 48 小时内发出哦～',
    intentCode: null,
    sortOrder: 1,
    enabled: true,
    updatedAt: '2026-01-01T00:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
  };

  /** One keyword slice pointing at {@link SHORTCUT}. */
  const SHORTCUT_HIT = {
    chunk: {
      id: 'chunk-unit-1',
      tenantId: TENANT,
      storeId: STORE,
      sourceKind: 'shortcut',
      sourceId: SHORTCUT.id,
      content: SHORTCUT.content,
      enabled: true,
      contentHash: 'hash-unit-1',
      indexStatus: 'indexed',
      indexAttempts: 0,
    },
    mode: 'keyword',
    score: 4.2,
    matched: [],
  };

  it('does not search for chitchat, and says so on the set', async () => {
    const { service, recorded } = serviceOver([message('inbound', '你好')]);

    await service.suggest(TENANT, MEMBER, { conversationId: CONVERSATION_ID });

    // The claim is about cost: neither recall leg ran and no model was asked. A
    // greeting must not buy an embedding call, a BM25 query and a completion.
    expect(recorded.recalls).toEqual({ keyword: 0, semantic: 0 });
    expect(recorded.asked).toEqual([]);

    expect(recorded.writes).toHaveLength(1);
    expect(recorded.writes[0]?.provider).toBe('none');
    expect(recorded.writes[0]?.intent).toBe('chitchat');
    expect(recorded.writes[0]?.origin).toBe('none');
    expect(recorded.writes[0]?.candidates).toEqual([]);
    expect(recorded.writes[0]?.fallbackReasons).toEqual(['chitchat_no_retrieval']);
  });

  it('still searches for a question, so the gate is a gate and not a blanket', async () => {
    const { service, recorded } = serviceOver([message('inbound', '什么时候发货')]);

    await service.suggest(TENANT, MEMBER, { conversationId: CONVERSATION_ID });

    expect(recorded.writes[0]?.intent).toBe('question');
    expect(recorded.recalls.keyword + recorded.recalls.semantic).toBeGreaterThan(0);
  });

  it('answers with the store’s own phrase and never asks the model', async () => {
    // The retrieval-first rule, and the mistake it exists to prevent: a configured
    // provider that is not called because the store already wrote the answer.
    const { service, recorded } = serviceOver([message('inbound', '什么时候发货')], {
      keywordHits: [SHORTCUT_HIT],
      shortcut: SHORTCUT,
    });

    await service.suggest(TENANT, MEMBER, { conversationId: CONVERSATION_ID });

    expect(recorded.asked).toEqual([]);

    const write = recorded.writes[0];
    expect(write?.provider).toBe('none');
    expect(write?.origin).toBe('script');
    expect(write?.intent).toBe('question');
    // Every claim on the candidate is the stored row's, never a model's — which is
    // what lets "select and send" cite a source.
    expect(write?.candidates).toHaveLength(1);
    expect(write?.candidates[0]?.kind).toBe('shortcut');
    expect(write?.candidates[0]?.sourceId).toBe(SHORTCUT.id);
    expect(write?.candidates[0]?.title).toBe(SHORTCUT.title);
    expect(write?.candidates[0]?.content).toBe(SHORTCUT.content);
    // And the evidence travels with it, for 检索依据.
    expect(write?.candidates[0]?.recall?.rank).toBe(1);
    expect(write?.candidates[0]?.recall?.modes).toEqual(['keyword']);
  });

  it('labels a provider-less set by what the engine found', async () => {
    // No key configured: the engine's own candidates are the answer, and the set
    // says they came from the catalogue rather than from a model.
    const { service, recorded } = serviceOver([message('inbound', '什么时候发货')], {
      withoutProvider: true,
    });

    await service.suggest(TENANT, MEMBER, { conversationId: CONVERSATION_ID });

    expect(recorded.asked).toEqual([]);
    expect(recorded.writes[0]?.provider).toBe('none');
    expect(recorded.writes[0]?.origin).toBe('catalogue');
    expect(recorded.writes[0]?.fallbackReasons).toContain('no_generation_provider');
  });

  it('feeds the model the 商品库, and keeps the row’s title over the model’s text', async () => {
    const { service, recorded } = serviceOver([message('inbound', '什么时候发货')], {
      providerCandidates: [{ sourceId: PRODUCT.id, content: '亲，我们 48 小时内发货哦～' }],
    });

    await service.suggest(TENANT, MEMBER, { conversationId: CONVERSATION_ID });

    // The material is the catalogue. No shortcut or FAQ can appear here: a
    // recalled one would have been answered by the retrieval-first rule above.
    expect(recorded.asked).toHaveLength(1);
    expect(recorded.asked[0]?.knowledge.map((entry) => entry.id)).toEqual([PRODUCT.id]);

    const write = recorded.writes[0];
    expect(write?.provider).toBe('deepseek');
    expect(write?.origin).toBe('generated');
    expect(write?.candidates[0]?.content).toBe('亲，我们 48 小时内发货哦～');
    expect(write?.candidates[0]?.title).toBe(PRODUCT.title);
    expect(write?.candidates[0]?.sourceId).toBe(PRODUCT.id);
  });
});
