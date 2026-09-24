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

/** What one call to the service touched, from the three seams that can see it. */
type Recorded = {
  /** Every request the generation provider was asked — the model's side. */
  readonly asked: GenerationRequest[];
  /** Every set the service tried to persist — the storage side. */
  readonly writes: CreateSuggestionSetRecord[];
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
function serviceOver(messages: ReadonlyArray<Record<string, unknown>>): {
  readonly service: RetrievalService;
  readonly recorded: Recorded;
} {
  const recorded: Recorded = { asked: [], writes: [] };

  const repository = {
    getConversation: () => Promise.resolve(CONVERSATION),
    listMessages: () => Promise.resolve(messages),
    listProducts: () => Promise.resolve([PRODUCT]),
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
    recall: () => Promise.resolve([]),
  } as unknown as KnowledgeKeywordRecall;

  const semanticRecall = {
    recall: () => Promise.resolve({ hits: [], unavailable: null }),
  } as unknown as KnowledgeSemanticRecall;

  const generation: GenerationProvider = {
    model: 'fake-model',
    generate: (request: GenerationRequest) => {
      recorded.asked.push(request);
      return Promise.resolve({ ok: true as const, candidates: [] });
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
      generation,
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
